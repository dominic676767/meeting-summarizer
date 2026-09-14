// The Held Recording lifecycle: a transcription outage costs a retry, not the
// meeting.
//
// Two behaviours are worth asserting. First, at the Transcription Provider seam:
// an Audio Recording whose engine failed converges to the accurate, speaker-named
// Transcript once the user switches Transcription Provider and retries — the same
// audio, a different engine. Second, in the store the popup lists: what a failed
// retry leaves behind, which must always be the audio.
import { beforeEach, describe, expect, it } from "vitest";
import type { CaptionSegment, Transcript } from "../src/domain/types";
import { fuseTranscript } from "../src/transcription/fusion";
import {
  createTranscriptionProvider,
  TranscriptionError,
  type DecodeAudio,
  type EngineSpan,
  type TranscriptionEngine,
} from "../src/transcription/provider";
import { seg, transcript } from "./helpers";

const SAMPLE_RATE = 16_000;
const START = Date.UTC(2026, 8, 13, 10, 0, 0);

/** A Meeting whose captions are its Speaker Track: who spoke when, nothing more. */
function meeting(...segments: CaptionSegment[]): Transcript {
  return transcript({ startedAt: START, endedAt: START + 10 * 60_000, segments });
}

/** Silence of a known length — its only job is to have a duration. */
const decode: DecodeAudio = () =>
  Promise.resolve({ samples: new Float32Array(60 * SAMPLE_RATE), sampleRate: SAMPLE_RATE });

function engineOf(opts: { failWith?: Error; spans?: EngineSpan[] }): TranscriptionEngine {
  return {
    name: "fake",
    sampleRate: SAMPLE_RATE,
    maxInputMs: 600_000,
    load: () => Promise.resolve(),
    transcribe: () =>
      opts.failWith ? Promise.reject(opts.failWith) : Promise.resolve(opts.spans ?? []),
  };
}

const provider = (engine: TranscriptionEngine, name = "fake") =>
  createTranscriptionProvider({ name, engine, decode });

/** Capture Start was the Meeting start in these cases: the retry has to preserve
 * the offset it was held with, whatever it is. */
const recording = () => ({ data: new Blob(), startOffsetMs: 0 });

describe("Held Recording retry", () => {
  it("the same audio retried on another Transcription Provider yields the Fused Transcript", async () => {
    const speakerTrack = meeting(
      seg("Alice", "we should ship the beta next friday", START + 1_000),
      seg("Bob", "agreed i will own the release checklist", START + 12_000),
    );

    // First run: the engine dies, so nothing can be fused and the audio is held.
    const broken = provider(engineOf({ failWith: new Error("out of memory") }), "local-whisper");
    const failure = await broken.transcribe(recording()).catch((e) => e);
    expect(failure).toBeInstanceOf(TranscriptionError);
    expect(String(failure.message)).toContain("out of memory");

    // Retry after switching Transcription Provider — same Audio Recording.
    const recovered = provider(
      engineOf({
        spans: [
          { text: "We should ship the beta next Friday.", startSec: 1, endSec: 6 },
          { text: "Agreed. I will own the release checklist.", startSec: 12, endSec: 18 },
        ],
      }),
      "cloud",
    );
    const utterances = await recovered.transcribe(recording());
    const fused = fuseTranscript(speakerTrack, utterances);

    expect(fused.provenance).toBe("fused");
    expect(fused.segments.map((s) => s.speaker)).toEqual(["Alice", "Bob"]);
    // The words are the engine's, with its capitalisation and punctuation — not
    // the caption text they replaced.
    expect(fused.segments[0]?.text).toBe("We should ship the beta next Friday.");
  });

  it("keeps a late Capture Start's offsets absolute, so the retry still names the speakers", async () => {
    // Recording began 90s into the Meeting; the held entry carries that distance
    // so a retry attributes the words to the turns they actually fell in.
    const speakerTrack = meeting(seg("Bob", "agreed", START + 95_000));
    const engine = engineOf({ spans: [{ text: "Agreed.", startSec: 5, endSec: 8 }] });
    const utterances = await provider(engine).transcribe({ data: new Blob(), startOffsetMs: 90_000 });

    expect(utterances).toEqual([{ text: "Agreed.", startMs: 95_000, endMs: 98_000 }]);
    expect(fuseTranscript(speakerTrack, utterances).segments[0]?.speaker).toBe("Bob");
  });

  it("a retry that fails again surfaces the new reason, and the audio is still all there", async () => {
    const audio = new Blob(["encoded audio"]);
    const engine = engineOf({ failWith: new Error("model download failed") });
    const err = await provider(engine)
      .transcribe({ data: audio, startOffsetMs: 0 })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TranscriptionError);
    expect(String(err.message)).toContain("model download failed");
    expect(audio.size).toBeGreaterThan(0);
  });
});

// --- The store the popup lists -----------------------------------------------
//
// ext.storage is faked (src/platform.ts resolves the namespace off globalThis so
// this is possible); the store is imported after it exists.

const stored: Record<string, unknown> = {};
(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local: {
      get: (key: string) => Promise.resolve(key in stored ? { [key]: stored[key] } : {}),
      set: (patch: Record<string, unknown>) => {
        Object.assign(stored, patch);
        return Promise.resolve();
      },
    },
  },
};

const store = await import("../src/background/held-recordings");

const toHold = (recordingId: string) => ({
  recordingId,
  transcript: meeting(seg("Alice", "hello", START + 1_000)),
  startOffsetMs: 0,
});

describe("Held Recording store", () => {
  beforeEach(() => {
    delete stored.heldRecordings;
  });

  it("holds an Audio Recording with the reason transcription failed", async () => {
    await store.holdRecording(toHold("tab-1"), "out of memory");
    const [entry] = await store.listHeldRecordings();
    expect(entry?.recordingId).toBe("tab-1");
    expect(entry?.reason).toBe("out of memory");
    // The Speaker Track travels with the audio: a retry has to fuse against it
    // long after the Meeting's session is gone.
    expect(entry?.transcript.segments.map((s) => s.speaker)).toEqual(["Alice"]);
  });

  it("a failed retry keeps the recording held and updates the reason", async () => {
    await store.holdRecording(toHold("tab-1"), "out of memory");
    await store.updateHeldRecordingReason("tab-1", "model download failed");
    const held = await store.listHeldRecordings();
    expect(held).toHaveLength(1);
    expect(held[0]?.reason).toBe("model download failed");
  });

  it("holds one Meeting's audio once, however often its transcription fails", async () => {
    await store.holdRecording(toHold("tab-1"), "first failure");
    await store.holdRecording(toHold("tab-1"), "second failure");
    const held = await store.listHeldRecordings();
    expect(held).toHaveLength(1);
    expect(held[0]?.reason).toBe("second failure");
  });

  it("a released recording is no longer held, so its audio can be discarded", async () => {
    await store.holdRecording(toHold("tab-1"), "out of memory");
    await store.releaseHeldRecording("tab-1");
    expect(await store.getHeldRecording("tab-1")).toBeUndefined();
    expect(await store.listHeldRecordings()).toEqual([]);
  });

  it("concurrent holds and releases cannot drop another Meeting's audio", async () => {
    await store.holdRecording(toHold("tab-1"), "out of memory");
    await Promise.all([
      store.holdRecording(toHold("tab-2"), "out of memory"),
      store.holdRecording(toHold("tab-3"), "out of memory"),
      store.releaseHeldRecording("tab-1"),
    ]);
    expect((await store.listHeldRecordings()).map((r) => r.recordingId).sort()).toEqual([
      "tab-2",
      "tab-3",
    ]);
  });
});
