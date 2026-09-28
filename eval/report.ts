// What a run produced: one row per clip and engine, as a Markdown table for the
// terminal and as JSON for the results directory.
//
// The table carries method and numbers only. Engine output — the Utterances —
// goes to the JSON alone, which lives in a git-ignored directory, because a
// transcript of a clip is the clip's content.
import type { MeetingLanguage, Utterance } from "../src/domain/types";
import type { EngineInfo } from "./engines";
import type { SpeakerAccuracy } from "./speakers";
import type { ErrorCounts, ErrorMetric } from "./text-metrics";

export type Outcome =
  | { kind: "ok" }
  /** The provider refused the output as a Silent Recording: nothing failed. */
  | { kind: "silent"; reason: string }
  | { kind: "failed"; message: string };

export interface EngineResult {
  engine: EngineInfo;
  outcome: Outcome;
  /** Model load, seconds. Null for an engine with nothing to load. */
  loadSec: number | null;
  /** From the recording handed to the provider to its Utterances, seconds. */
  transcribeSec: number;
  errors: ErrorCounts | null;
  /** Null for an engine that does not diarize: "n/a", never zero. */
  speakers: { labels: number; accuracy: SpeakerAccuracy } | null;
  utterances: Utterance[];
}

export interface ClipResult {
  clip: string;
  language: MeetingLanguage;
  metric: ErrorMetric;
  audioSec: number;
  referenceSpeakers: number;
  engines: EngineResult[];
}

export interface RunResult {
  startedAt: string;
  host: { node: string; platform: string };
  /** Present when local Whisper ran: how it differs from the extension's. */
  localWhisperDifferences?: readonly string[];
  speakerMapping: "many-to-one";
  clips: ClipResult[];
}

const percent = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatDuration(sec: number): string {
  const whole = Math.round(sec);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const seconds = (sec: number | null) => (sec === null ? "—" : `${sec.toFixed(1)} s`);

function errorCell(r: EngineResult): string {
  if (r.outcome.kind === "failed") return "failed";
  if (r.outcome.kind === "silent") return "silent recording";
  if (!r.errors || r.errors.rate === null) return "n/a";
  return percent(r.errors.rate);
}

function speakerCells(r: EngineResult, referenceSpeakers: number): [string, string] {
  if (!r.engine.diarizes) return ["n/a: no diarization", `n/a / ${referenceSpeakers}`];
  if (r.outcome.kind !== "ok" || !r.speakers) return ["—", `— / ${referenceSpeakers}`];
  return [percent(r.speakers.accuracy.accuracy), `${r.speakers.labels} / ${referenceSpeakers}`];
}

export function renderMarkdown(run: RunResult): string {
  const header = [
    "Clip",
    "Language",
    "Audio",
    "Engine",
    "Metric",
    "Error rate",
    "Speaker accuracy",
    "Speaker labels / reference",
    "Load",
    "Transcribe",
  ];
  const rows = run.clips.flatMap((clip) =>
    clip.engines.map((r) => [
      clip.clip,
      clip.language,
      formatDuration(clip.audioSec),
      `${r.engine.name} (${r.engine.model})`,
      clip.metric.toUpperCase(),
      errorCell(r),
      ...speakerCells(r, clip.referenceSpeakers),
      seconds(r.loadSec),
      seconds(r.transcribeSec),
    ]),
  );
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  const table = [line(header), line(header.map(() => "---")), ...rows.map(line)];

  const notes = ["", "Speaker labels are mapped to reference speakers many-to-one."];
  for (const clip of run.clips) {
    for (const r of clip.engines) {
      if (r.outcome.kind === "failed") notes.push(`${clip.clip}, ${r.engine.name}: ${r.outcome.message}`);
      if (r.outcome.kind === "silent") notes.push(`${clip.clip}, ${r.engine.name}: ${r.outcome.reason}`);
    }
  }
  if (run.localWhisperDifferences) {
    notes.push("", "Local Whisper here differs from the extension's:");
    for (const d of run.localWhisperDifferences) notes.push(`- ${d}`);
  }
  return [...table, ...notes].join("\n");
}
