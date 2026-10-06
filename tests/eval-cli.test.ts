// The evaluation harness's command line, its bill, and its report. No engine
// runs here: real runs are the CLI's, on the user's own clips.
import { describe, expect, it } from "vitest";
import { billingPlan, formatBilling } from "../eval/billing";
import { parseCliArgs, UsageError } from "../eval/cli";
import { engineInfo, redactKeys } from "../eval/engines";
import { formatDuration, renderMarkdown, type EngineResult, type RunResult } from "../eval/report";
import { SCRIBE_MAX_INPUT_MS } from "../src/transcription/elevenlabs";
import { OPENAI_TRANSCRIPTION_MAX_INPUT_MS } from "../src/transcription/openai";

const parse = (...argv: string[]) => parseCliArgs(argv, "/work", "/repo");

describe("parseCliArgs", () => {
  it("defaults to every engine, base Whisper, and results inside the repository", () => {
    expect(parse("--manifest", "clips/clips.json")).toEqual({
      source: { kind: "manifest", path: "/work/clips/clips.json" },
      engines: ["local-whisper", "openai", "elevenlabs"],
      whisperModel: "base",
      outDir: "/repo/.eval/results",
      yes: false,
    });
  });

  it("chooses clips and engines, in the harness's own engine order", () => {
    const options = parse("--manifest", "c.json", "--clips", "a, b", "--engines", "elevenlabs,local-whisper");
    expect(options?.source).toEqual({ kind: "manifest", path: "/work/c.json", names: ["a", "b"] });
    expect(options?.engines).toEqual(["local-whisper", "elevenlabs"]);
  });

  it("takes one clip given by its three parts", () => {
    expect(parse("--audio", "a.wav", "--reference", "a.json", "--language", "zh")?.source).toEqual({
      kind: "single",
      audio: "/work/a.wav",
      reference: "/work/a.json",
      language: "zh",
    });
  });

  it("returns null for --help", () => {
    expect(parse("--help")).toBeNull();
  });

  it.each([
    [["--manifest", "c.json", "--engines", "whisper"], "unknown engine whisper"],
    [["--manifest", "c.json", "--whisper-model", "large"], "--whisper-model must be one of"],
    [["--audio", "a.wav", "--reference", "a.json", "--language", "english"], "not a Meeting Language code"],
    [["--audio", "a.wav"], "give --manifest, or all of"],
    [["--manifest", "c.json", "--audio", "a.wav"], "are exclusive"],
    [["--audio", "a.wav", "--reference", "a.json", "--language", "en", "--clips", "a"], "--clips chooses from a --manifest"],
    [["--manifest", "c.json", "--api-key", "sk-x"], "Unknown option"],
  ])("refuses %j", (argv, message) => {
    expect(() => parse(...argv)).toThrow(UsageError);
    expect(() => parse(...argv)).toThrow(message);
  });
});

describe("billingPlan", () => {
  const engines = (["local-whisper", "openai", "elevenlabs"] as const).map((id) => engineInfo(id, "base"));

  it("bills only the engines that upload, for every clip's audio, rounded up", () => {
    const plan = billingPlan([61, 30], engines);
    expect(plan.map((l) => [l.engine.id, l.audioMin, l.requests])).toEqual([
      ["openai", 1.6, 2],
      ["elevenlabs", 1.6, 2],
    ]);
  });

  it("counts uploads by each engine's own window", () => {
    const hourAndAHalf = (SCRIBE_MAX_INPUT_MS * 1.5) / 1000;
    const plan = billingPlan([hourAndAHalf], engines);
    expect(plan.find((l) => l.engine.id === "openai")?.requests).toBe(
      Math.ceil((hourAndAHalf * 1000) / OPENAI_TRANSCRIPTION_MAX_INPUT_MS),
    );
    expect(plan.find((l) => l.engine.id === "elevenlabs")?.requests).toBe(2);
  });

  it("states Scribe's share of the free plan", () => {
    expect(formatBilling(billingPlan([27 * 60], engines))).toContain(
      "ElevenLabs scribe_v2: 27.0 min of audio in 1 upload (10.0% of a 4.5 h free plan)",
    );
  });

  it("has nothing to bill when only local Whisper runs", () => {
    expect(billingPlan([600], [engines[0]!])).toEqual([]);
  });
});

describe("redactKeys", () => {
  it("removes every key from a message an endpoint may have quoted it in", () => {
    expect(redactKeys("HTTP 401 bad key sk-abc123 (sk-abc123)", ["sk-abc123", ""])).toBe(
      "HTTP 401 bad key [redacted] ([redacted])",
    );
  });
});

describe("renderMarkdown", () => {
  const result = (id: "local-whisper" | "elevenlabs", over: Partial<EngineResult>): EngineResult => ({
    engine: engineInfo(id, "base"),
    outcome: { kind: "ok" },
    loadSec: null,
    transcribeSec: 12.34,
    errors: { metric: "wer", substitutions: 1, deletions: 0, insertions: 0, referenceLength: 8, rate: 0.125 },
    speakers: null,
    utterances: [],
    ...over,
  });
  const run = (engines: EngineResult[]): RunResult => ({
    startedAt: "2026-01-01T00:00:00.000Z",
    host: { node: "v22", platform: "darwin-arm64" },
    speakerMapping: "many-to-one",
    clips: [{ clip: "standup", language: "en", metric: "wer", audioSec: 125, referenceSpeakers: 3, engines }],
  });

  it("reports a non-diarizing engine's speakers as n/a, not zero", () => {
    const row = renderMarkdown(run([result("local-whisper", { loadSec: 4 })])).split("\n")[2];
    expect(row).toBe(
      "| standup | en | 2:05 | local Whisper (onnx-community/whisper-base) | WER | 12.5% | " +
        "n/a: no diarization | n/a / 3 | 4.0 s | 12.3 s |",
    );
  });

  it("reports a diarizing engine's accuracy and label count against the reference", () => {
    const speakers = {
      labels: 4,
      accuracy: { mapping: [], correctSec: 90, referenceSpeechSec: 100, accuracy: 0.9 },
    };
    expect(renderMarkdown(run([result("elevenlabs", { speakers })]))).toContain("| 90.0% | 4 / 3 | — |");
  });

  it("says a run failed or was silent instead of printing a rate, and why beneath", () => {
    const text = renderMarkdown(
      run([
        result("elevenlabs", { outcome: { kind: "failed", message: "HTTP 401" }, errors: null }),
        result("local-whisper", { outcome: { kind: "silent", reason: "no speech" }, errors: null }),
      ]),
    );
    expect(text).toContain("| WER | failed | — | — / 3 |");
    expect(text).toContain("| WER | silent recording | n/a: no diarization |");
    expect(text).toContain("standup, ElevenLabs: HTTP 401");
    expect(text).toContain("standup, local Whisper: no speech");
  });

  it("lists how local Whisper differs from the extension's only when it ran", () => {
    expect(renderMarkdown(run([]))).not.toContain("differs");
    expect(renderMarkdown({ ...run([]), localWhisperDifferences: ["Node backend"] })).toContain("- Node backend");
  });
});

describe("formatDuration", () => {
  it("is minutes and seconds", () => {
    expect([formatDuration(0), formatDuration(59.6), formatDuration(3_725)]).toEqual(["0:00", "1:00", "62:05"]);
  });
});
