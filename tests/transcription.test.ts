// The Transcription Provider seam: Audio Recording → Utterances, driven with a
// fake engine. Real model inference is not unit-tested (see
// transcription-whisper.test.ts for the opt-in run against a real recording) —
// what lives here is the provider's own behaviour, which is where the
// correctness fusion depends on actually is: Utterance shape, chunk activation,
// and offsets that stay absolute relative to the Meeting start.
import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptionProvider,
  TranscriptionCancelled,
  TranscriptionError,
  type DecodeAudio,
  type EngineSpan,
  type TranscriptionEngine,
} from "../src/transcription/provider";
import { transcriptFromUtterances, UNKNOWN_SPEAKER } from "../src/transcription/transcript";
import { transcript } from "./helpers";

const SAMPLE_RATE = 16_000;

/** Silence of a known length — the samples' only job here is to have a duration. */
function audioOf(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SAMPLE_RATE));
}

function fakeDecode(seconds: number): DecodeAudio {
  return () => Promise.resolve({ samples: audioOf(seconds), sampleRate: SAMPLE_RATE });
}

/**
 * Fake engine: records the length of every window it is handed and replies with
 * spans timed from the start of *that* window, as a real engine does.
 */
function fakeEngine(opts?: {
  maxInputMs?: number;
  spansFor?: (call: number, durationSec: number) => EngineSpan[];
  failWith?: Error;
  onLoad?: (progress?: (loaded: number, total: number | null) => void) => void;
}): TranscriptionEngine & { windowsSec: number[]; loads: number } {
  const windowsSec: number[] = [];
  return {
    name: "fake",
    sampleRate: SAMPLE_RATE,
    maxInputMs: opts?.maxInputMs ?? 60_000,
    windowsSec,
    loads: 0,
    load(progress) {
      this.loads++;
      opts?.onLoad?.(progress);
      return Promise.resolve();
    },
    transcribe(samples) {
      const durationSec = samples.length / SAMPLE_RATE;
      windowsSec.push(durationSec);
      if (opts?.failWith) return Promise.reject(opts.failWith);
      const spans = opts?.spansFor
        ? opts.spansFor(windowsSec.length, durationSec)
        : [{ text: `window ${windowsSec.length}`, startSec: 0, endSec: durationSec }];
      return Promise.resolve(spans);
    },
  };
}

function provider(engine: TranscriptionEngine, seconds: number) {
  return createTranscriptionProvider({ name: "fake", engine, decode: fakeDecode(seconds) });
}

const recording = (startOffsetMs = 0) => ({ data: new Blob(), startOffsetMs });

describe("Transcription Provider", () => {
  it("normalizes engine spans into Utterances with ms offsets", async () => {
    const engine = fakeEngine({
      spansFor: () => [
        { text: " We should ship the beta. ", startSec: 1.5, endSec: 4.25 },
        { text: "Agreed.", startSec: 4.25, endSec: 5 },
      ],
    });
    const utterances = await provider(engine, 10).transcribe(recording());
    expect(utterances).toEqual([
      { text: "We should ship the beta.", startMs: 1500, endMs: 4250 },
      { text: "Agreed.", startMs: 4250, endMs: 5000 },
    ]);
  });

  it("omits the diarization label the local engine cannot supply", async () => {
    const engine = fakeEngine({ spansFor: () => [{ text: "hello", startSec: 0, endSec: 1 }] });
    const [utterance] = await provider(engine, 5).transcribe(recording());
    expect(utterance).not.toHaveProperty("diarizationLabel");
  });

  it("carries a diarization label through when an engine does supply one", async () => {
    const engine = fakeEngine({
      spansFor: () => [{ text: "hello", startSec: 0, endSec: 1, speaker: "SPEAKER_01" }],
    });
    const [utterance] = await provider(engine, 5).transcribe(recording());
    expect(utterance?.diarizationLabel).toBe("SPEAKER_01");
  });

  it("drops spans with no words rather than emitting empty Utterances", async () => {
    const engine = fakeEngine({
      spansFor: () => [
        { text: "   ", startSec: 0, endSec: 1 },
        { text: "real words", startSec: 1, endSec: 2 },
      ],
    });
    const utterances = await provider(engine, 5).transcribe(recording());
    expect(utterances.map((u) => u.text)).toEqual(["real words"]);
  });

  it("chunks a recording past the engine's input limit", async () => {
    const engine = fakeEngine({ maxInputMs: 60_000 });
    await provider(engine, 150).transcribe(recording());
    expect(engine.windowsSec).toEqual([60, 60, 30]);
  });

  it("corrects chunk offsets so Utterance timings stay absolute across boundaries", async () => {
    // Every window's spans are timed from that window's own start, so an
    // uncorrected offset would restart the clock at each boundary and
    // misattribute every word after the first one during fusion.
    const engine = fakeEngine({
      maxInputMs: 60_000,
      spansFor: (call) => [{ text: `chunk ${call}`, startSec: 2, endSec: 3 }],
    });
    const utterances = await provider(engine, 150).transcribe(recording());
    expect(utterances).toEqual([
      { text: "chunk 1", startMs: 2000, endMs: 3000 },
      { text: "chunk 2", startMs: 62_000, endMs: 63_000 },
      { text: "chunk 3", startMs: 122_000, endMs: 123_000 },
    ]);
  });

  it("keeps timings relative to the Meeting start, not to Capture Start", async () => {
    const engine = fakeEngine({
      maxInputMs: 60_000,
      spansFor: () => [{ text: "late start", startSec: 1, endSec: 2 }],
    });
    // Recording began 90s into the Meeting.
    const utterances = await provider(engine, 30).transcribe(recording(90_000));
    expect(utterances).toEqual([{ text: "late start", startMs: 91_000, endMs: 92_000 }]);
  });

  it("loads the model once per run and reports its download progress", async () => {
    const modelProgress: [number, number | null][] = [];
    const engine = fakeEngine({
      maxInputMs: 60_000,
      onLoad: (progress) => {
        progress?.(1_000_000, 40_000_000);
        progress?.(40_000_000, 40_000_000);
      },
    });
    await provider(engine, 150).transcribe(recording(), {
      onModelProgress: (loaded, total) => modelProgress.push([loaded, total]),
    });
    expect(engine.loads).toBe(1);
    expect(modelProgress).toEqual([
      [1_000_000, 40_000_000],
      [40_000_000, 40_000_000],
    ]);
  });

  it("reports audio processed against audio total as chunks complete", async () => {
    const audioProgress: [number, number][] = [];
    const engine = fakeEngine({ maxInputMs: 60_000 });
    await provider(engine, 150).transcribe(recording(), {
      onAudioProgress: (processedMs, totalMs) => audioProgress.push([processedMs, totalMs]),
    });
    expect(audioProgress).toEqual([
      [60_000, 150_000],
      [120_000, 150_000],
      [150_000, 150_000],
    ]);
  });

  it("surfaces an engine failure as TranscriptionError (the Held Recording path)", async () => {
    const engine = fakeEngine({ failWith: new Error("out of memory") });
    await expect(provider(engine, 10).transcribe(recording())).rejects.toThrow(TranscriptionError);
    await expect(provider(engine, 10).transcribe(recording())).rejects.toThrow(/out of memory/);
  });

  it("surfaces a decode failure as TranscriptionError", async () => {
    const decode: DecodeAudio = () => Promise.reject(new Error("not audio"));
    const p = createTranscriptionProvider({ name: "fake", engine: fakeEngine(), decode });
    await expect(p.transcribe(recording())).rejects.toThrow(/audio decode failed: not audio/);
  });

  it("stops at the next chunk boundary when the user skips the wait", async () => {
    const abort = new AbortController();
    const engine = fakeEngine({ maxInputMs: 60_000 });
    const transcribeSpy = vi.spyOn(engine, "transcribe");
    const promise = provider(engine, 300).transcribe(recording(), {
      signal: abort.signal,
      onAudioProgress: () => abort.abort(),
    });
    await expect(promise).rejects.toThrow(TranscriptionCancelled);
    expect(transcribeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Utterances as a Transcript", () => {
  it("replaces caption words with audio words, keeping the Meeting's metadata", async () => {
    const engine = fakeEngine({
      spansFor: () => [
        { text: "We should ship the beta next Friday.", startSec: 0, endSec: 3 },
        { text: "I will own the release checklist.", startSec: 3, endSec: 6 },
      ],
    });
    const base = transcript();
    const utterances = await provider(engine, 10).transcribe(recording());
    const fromAudio = transcriptFromUtterances(base, utterances);

    expect(fromAudio.title).toBe(base.title);
    expect(fromAudio.startedAt).toBe(base.startedAt);
    expect(fromAudio.segments.map((s) => s.text)).toEqual([
      "We should ship the beta next Friday.",
      "I will own the release checklist.",
    ]);
    // Base Whisper does not diarize, so no speaker is named and none is invented.
    expect(fromAudio.segments.map((s) => s.speaker)).toEqual([
      UNKNOWN_SPEAKER,
      UNKNOWN_SPEAKER,
    ]);
    expect(fromAudio.segments.map((s) => s.capturedAt)).toEqual([
      base.startedAt,
      base.startedAt + 3000,
    ]);
  });

  it("keeps an engine's own diarization label as the speaker", () => {
    const base = transcript();
    const fromAudio = transcriptFromUtterances(base, [
      { text: "hello", startMs: 0, endMs: 1000, diarizationLabel: "Speaker 1" },
    ]);
    expect(fromAudio.segments[0]?.speaker).toBe("Speaker 1");
  });
});
