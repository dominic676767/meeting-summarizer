// The evaluation harness's command line: `npm run eval -- --help`.
//
// Order matters more than anything else here. Every input is read and checked,
// every key is found, and the cloud bill is printed, all before a single engine
// runs. A run that fails halfway has already sent audio to be billed for.
//
// stdout carries the Markdown table and nothing else, so it can be redirected
// to a file; the bill, progress and errors go to stderr.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { MeetingLanguage, WhisperModelSize } from "../src/domain/types";
import { TranscriptionSilent, type TranscriptionEngine } from "../src/transcription/provider";
import { billingPlan, formatBilling } from "./billing";
import {
  InvalidInput,
  isMeetingLanguage,
  selectClips,
  validateManifest,
  validateReference,
  type Clip,
  type ReferenceSegment,
} from "./clips";
import {
  createCloudEngine,
  createNodeWhisper,
  ENGINE_IDS,
  engineInfo,
  KEY_ENV,
  LOCAL_WHISPER_DIFFERENCES,
  providerFor,
  redactKeys,
  type EngineId,
  type EngineInfo,
} from "./engines";
import { renderMarkdown, type ClipResult, type EngineResult, type RunResult } from "./report";
import { engineLabelCount, referenceSpeakerCount, speakerAccuracy } from "./speakers";
import { errorRate, metricFor } from "./text-metrics";
import { durationSec, parseWav } from "./wav";

export const USAGE = `Compare the Transcription Providers on your own clips.

  npm run eval -- --manifest <clips.json> [--clips <name,…>] [options]
  npm run eval -- --audio <clip.wav> --reference <clip.reference.json> --language <code> [options]

Options:
  --engines <ids>        comma-separated: ${ENGINE_IDS.join(",")} (default: all three)
  --whisper-model <size> local Whisper size: tiny, base or small (default: base)
  --out <dir>            where the JSON results go (default: .eval/results)
  --yes                  proceed with the cloud engines once their bill is printed
  --help                 this text

Keys come only from OPENAI_API_KEY and ELEVENLABS_API_KEY.
Method, data rules and file formats: docs/evaluations/README.md`;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type ClipSource =
  | { kind: "manifest"; path: string; names?: string[] }
  | { kind: "single"; audio: string; reference: string; language: MeetingLanguage };

export interface CliOptions {
  source: ClipSource;
  engines: EngineId[];
  whisperModel: WhisperModelSize;
  outDir: string;
  yes: boolean;
}

const WHISPER_SIZES: readonly WhisperModelSize[] = ["tiny", "base", "small"];

const list = (value: string) => value.split(",").map((v) => v.trim()).filter(Boolean);

/**
 * argv → options, paths resolved against `cwd` (where the user typed the
 * command) and the default results directory against `root` (the repository).
 * Null means --help.
 */
export function parseCliArgs(argv: string[], cwd: string, root: string): CliOptions | null {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        manifest: { type: "string" },
        clips: { type: "string" },
        audio: { type: "string" },
        reference: { type: "string" },
        language: { type: "string" },
        engines: { type: "string" },
        "whisper-model": { type: "string" },
        out: { type: "string" },
        yes: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (values.help) return null;

  let source: ClipSource;
  const single = values.audio !== undefined || values.reference !== undefined || values.language !== undefined;
  if (values.manifest !== undefined) {
    if (single) throw new UsageError("--manifest and --audio/--reference/--language are exclusive");
    source = {
      kind: "manifest",
      path: resolve(cwd, values.manifest),
      ...(values.clips !== undefined ? { names: list(values.clips) } : {}),
    };
  } else {
    if (values.clips !== undefined) throw new UsageError("--clips chooses from a --manifest");
    if (!values.audio || !values.reference || !values.language) {
      throw new UsageError("give --manifest, or all of --audio, --reference and --language");
    }
    if (!isMeetingLanguage(values.language)) {
      throw new UsageError(`--language ${values.language} is not a Meeting Language code`);
    }
    source = {
      kind: "single",
      audio: resolve(cwd, values.audio),
      reference: resolve(cwd, values.reference),
      language: values.language,
    };
  }

  const engines = values.engines === undefined ? [...ENGINE_IDS] : list(values.engines);
  const unknown = engines.filter((e) => !(ENGINE_IDS as readonly string[]).includes(e));
  if (unknown.length) {
    throw new UsageError(`unknown engine ${unknown.join(", ")}; choose from ${ENGINE_IDS.join(", ")}`);
  }
  if (engines.length === 0) throw new UsageError("--engines names no engine");

  const whisperModel = values["whisper-model"] ?? "base";
  if (!(WHISPER_SIZES as readonly string[]).includes(whisperModel)) {
    throw new UsageError(`--whisper-model must be one of ${WHISPER_SIZES.join(", ")}`);
  }

  return {
    source,
    // In the order the harness defines, and each once, whatever order was typed.
    engines: ENGINE_IDS.filter((e) => engines.includes(e)),
    whisperModel: whisperModel as WhisperModelSize,
    outDir: values.out === undefined ? join(root, ".eval", "results") : resolve(cwd, values.out),
    yes: values.yes,
  };
}

interface PreparedClip {
  clip: Clip;
  bytes: Uint8Array<ArrayBuffer>;
  audioSec: number;
  reference: ReferenceSegment[];
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new InvalidInput(path, [err instanceof Error ? err.message : String(err)]);
  }
}

async function clipsFrom(source: ClipSource): Promise<Clip[]> {
  if (source.kind === "single") {
    return [
      {
        name: basename(source.audio).replace(/\.wav$/i, ""),
        audioPath: source.audio,
        referencePath: source.reference,
        language: source.language,
      },
    ];
  }
  return selectClips(validateManifest(await readJson(source.path), dirname(source.path)), source.names);
}

/** Every clip read and checked; every problem reported, not the first. */
async function prepare(clips: Clip[]): Promise<PreparedClip[]> {
  const prepared: PreparedClip[] = [];
  const problems: string[] = [];
  for (const clip of clips) {
    try {
      const bytes = new Uint8Array(await readFile(clip.audioPath));
      const audioSec = durationSec(parseWav(bytes));
      const reference = validateReference(await readJson(clip.referencePath), audioSec);
      prepared.push({ clip, bytes, audioSec, reference });
    } catch (err) {
      problems.push(`${clip.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (problems.length) throw new InvalidInput("clips", problems);
  return prepared;
}

const since = (start: number) => (performance.now() - start) / 1000;

async function runOne(
  prepared: PreparedClip,
  info: EngineInfo,
  engine: TranscriptionEngine,
  loadSec: number | null,
  keys: string[],
): Promise<EngineResult> {
  const metric = metricFor(prepared.clip.language);
  const started = performance.now();
  try {
    const utterances = await providerFor(engine).transcribe({
      spans: [{ data: new Blob([prepared.bytes], { type: "audio/wav" }), startOffsetMs: 0 }],
    });
    const transcribeSec = since(started);
    const reference = prepared.reference.map((s) => s.text).join(" ");
    const hypothesis = utterances.map((u) => u.text).join(" ");
    return {
      engine: info,
      outcome: { kind: "ok" },
      loadSec,
      transcribeSec,
      errors: errorRate(reference, hypothesis, metric),
      speakers: info.diarizes
        ? { labels: engineLabelCount(utterances), accuracy: speakerAccuracy(prepared.reference, utterances) }
        : null,
      utterances,
    };
  } catch (err) {
    const transcribeSec = since(started);
    const outcome: EngineResult["outcome"] =
      err instanceof TranscriptionSilent
        ? { kind: "silent", reason: err.reason }
        : { kind: "failed", message: redactKeys(err instanceof Error ? err.message : String(err), keys) };
    return { engine: info, outcome, loadSec, transcribeSec, errors: null, speakers: null, utterances: [] };
  }
}

/** Runs the harness; the exit code is returned rather than the process ended. */
export async function main(argv: string[], dirs: { cwd: string; root: string }): Promise<number> {
  const log = (text: string) => process.stderr.write(`${text}\n`);

  let options: CliOptions | null;
  try {
    options = parseCliArgs(argv, dirs.cwd, dirs.root);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    log(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (!options) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let clips: PreparedClip[];
  try {
    clips = await prepare(await clipsFrom(options.source));
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const engines = options.engines.map((id) => engineInfo(id, options.whisperModel));
  const keys = new Map<EngineId, string>();
  const missing: string[] = [];
  for (const e of engines) {
    const variable = KEY_ENV[e.id];
    if (!variable) continue;
    const key = process.env[variable];
    if (key) keys.set(e.id, key);
    else missing.push(`${e.name} needs ${variable} set in the environment`);
  }
  if (missing.length) {
    log(missing.join("\n"));
    return 1;
  }

  const bill = billingPlan(clips.map((c) => c.audioSec), engines);
  if (bill.length) {
    log(formatBilling(bill));
    if (!options.yes) {
      log("\nNothing has been run. Pass --yes to proceed.");
      return 1;
    }
  }

  const secrets = [...keys.values()];
  const startedAt = new Date().toISOString();
  const whisper = options.engines.includes("local-whisper")
    ? createNodeWhisper(options.whisperModel, join(dirs.root, ".eval", "models"))
    : null;
  // Loaded once for the run, and timed apart from transcription: the first run
  // downloads the model, which says nothing about how fast it transcribes.
  let whisperLoad: { sec: number; error?: string } | null = null;
  if (whisper) {
    log(`Loading ${engineInfo("local-whisper", options.whisperModel).model}…`);
    const started = performance.now();
    try {
      await whisper.load();
      whisperLoad = { sec: since(started) };
    } catch (err) {
      whisperLoad = { sec: since(started), error: err instanceof Error ? err.message : String(err) };
    }
  }

  const results: ClipResult[] = [];
  for (const prepared of clips) {
    const { clip } = prepared;
    const engineResults: EngineResult[] = [];
    for (const info of engines) {
      log(`${clip.name}: ${info.name} (${info.model})…`);
      if (info.id === "local-whisper" && whisperLoad?.error !== undefined) {
        engineResults.push({
          engine: info,
          outcome: { kind: "failed", message: `model load failed: ${whisperLoad.error}` },
          loadSec: whisperLoad.sec,
          transcribeSec: 0,
          errors: null,
          speakers: null,
          utterances: [],
        });
        continue;
      }
      const engine =
        info.id === "local-whisper"
          ? whisper!.engineFor(clip.language)
          : createCloudEngine(info.id, keys.get(info.id)!, clip.language);
      const loadSec = info.id === "local-whisper" ? (whisperLoad?.sec ?? null) : null;
      engineResults.push(await runOne(prepared, info, engine, loadSec, secrets));
    }
    results.push({
      clip: clip.name,
      language: clip.language,
      metric: metricFor(clip.language),
      audioSec: prepared.audioSec,
      referenceSpeakers: referenceSpeakerCount(prepared.reference),
      engines: engineResults,
    });
  }

  const run: RunResult = {
    startedAt,
    host: { node: process.version, platform: `${process.platform}-${process.arch}` },
    ...(whisper ? { localWhisperDifferences: LOCAL_WHISPER_DIFFERENCES } : {}),
    speakerMapping: "many-to-one",
    clips: results,
  };
  await mkdir(options.outDir, { recursive: true });
  const outFile = join(options.outDir, `${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(outFile, `${JSON.stringify(run, null, 2)}\n`);

  process.stdout.write(`${renderMarkdown(run)}\n`);
  log(`\nResults: ${outFile}`);
  return 0;
}
