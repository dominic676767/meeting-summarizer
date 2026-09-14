// A Meeting the user recorded in several stretches: capture on, off for something
// sensitive, on again. Nothing but the deliberate gaps may be missing from the
// Transcript (ADR-0005).
//
// Two seams are exercised here. Span identity — which file each Capture Start
// writes — because the defect this ticket fixes was two Capture Starts naming one
// file, the second truncating the first from byte zero. And the end-to-end path a
// stop/start/stop/start Meeting takes: spans → Utterances → Fused Transcript, with
// the speaker attribution that only holds if every span's timings are absolute.
import { describe, expect, it } from "vitest";
import { beginSpan, orderedSpans, spanIdsOf } from "../src/background/capture-spans";
import type { CaptionSegment, CaptureSpan, Transcript } from "../src/domain/types";
import { fuseTranscript, UNKNOWN_SPEAKER } from "../src/transcription/fusion";
import {
  createTranscriptionProvider,
  type DecodeAudio,
  type EngineSpan,
  type TranscriptionEngine,
} from "../src/transcription/provider";
import { seg, transcript } from "./helpers";

const SAMPLE_RATE = 16_000;
const START = Date.UTC(2026, 8, 13, 10, 0, 0);
const RECORDING_ID = "7-1757757600000";

function meeting(...segments: CaptionSegment[]): Transcript {
  return transcript({ startedAt: START, endedAt: START + 30 * 60_000, segments });
}

/** Decodes the nth span to the nth duration, so spans differ in length as real
 * ones do. */
function decodeSpans(...seconds: number[]): DecodeAudio {
  let call = 0;
  return () =>
    Promise.resolve({
      samples: new Float32Array(Math.round((seconds[call++] ?? 0) * SAMPLE_RATE)),
      sampleRate: SAMPLE_RATE,
    });
}

/** Engine that replies with the spans queued for its nth call, timed — as every
 * engine times them — from the start of the audio it was given. */
function engineOf(perCall: EngineSpan[][]): TranscriptionEngine {
  let call = 0;
  return {
    name: "fake",
    sampleRate: SAMPLE_RATE,
    maxInputMs: 600_000,
    load: () => Promise.resolve(),
    transcribe: () => Promise.resolve(perCall[call++] ?? []),
  };
}

describe("Capture Span identity", () => {
  it("gives every Capture Start in one Meeting its own file", async () => {
    // The defect: one key per Meeting, so the second Capture Start opened the
    // first span's file and rewrote it from byte zero. Distinct keys are what make
    // that impossible, so this is the assertion that matters.
    const first = beginSpan(RECORDING_ID, START, START);
    const second = beginSpan(RECORDING_ID, START, START + 5 * 60_000);
    const third = beginSpan(RECORDING_ID, START, START + 15 * 60_000);
    expect(new Set([first.spanId, second.spanId, third.spanId]).size).toBe(3);
  });

  it("keys each span by its distance from the Meeting start, so spans stay findable", () => {
    const span = beginSpan(RECORDING_ID, START, START + 90_000);
    expect(span).toEqual({ spanId: `${RECORDING_ID}.90000`, startOffsetMs: 90_000 });
  });

  it("treats a Capture Start that appears to precede the Meeting as the Meeting start", () => {
    // A clock adjustment must not push a span's words to before the Meeting began.
    expect(beginSpan(RECORDING_ID, START, START - 30_000).startOffsetMs).toBe(0);
  });

  it("orders a Meeting's spans by Capture Start, whatever order they were recorded in", () => {
    const spans: CaptureSpan[] = [
      { spanId: "b", startOffsetMs: 600_000 },
      { spanId: "a", startOffsetMs: 0 },
      { spanId: "c", startOffsetMs: 900_000 },
    ];
    expect(orderedSpans(spans).map((s) => s.spanId)).toEqual(["a", "b", "c"]);
  });

  it("names every span of the Meeting for cleanup, not just the last one", () => {
    // What a confirmed artifact write deletes. A Meeting that recorded three spans
    // must leave no orphan behind.
    const spans = [START, START + 5 * 60_000, START + 15 * 60_000].map((at) =>
      beginSpan(RECORDING_ID, START, at),
    );
    expect(spanIdsOf(spans)).toEqual([
      `${RECORDING_ID}.0`,
      `${RECORDING_ID}.300000`,
      `${RECORDING_ID}.900000`,
    ]);
  });
});

describe("a stop/start/stop/start Meeting", () => {
  /**
   * Capture ran 0–2 min and 10–12 min; the eight minutes between were kept off
   * the record on purpose. Captions ran throughout, so the Speaker Track covers
   * the whole Meeting.
   */
  const speakerTrack = meeting(
    seg("Alice", "we should ship the beta next friday", START + 30_000),
    seg("Bob", "agreed i will own the release checklist", START + 70_000),
    seg("Alice", "off the record for a moment", START + 150_000),
    seg("Carol", "back on: the security review is the blocker", START + 610_000),
    seg("Bob", "i will chase the reviewers tomorrow", START + 660_000),
  );

  const spans = [START, START + 600_000].map((at) => beginSpan(RECORDING_ID, START, at));

  function transcribeSpans() {
    const provider = createTranscriptionProvider({
      name: "fake",
      engine: engineOf([
        [
          { text: "We should ship the beta next Friday.", startSec: 30, endSec: 40 },
          { text: "Agreed. I will own the release checklist.", startSec: 70, endSec: 80 },
        ],
        // The second span's engine timings restart at zero, as every engine's do.
        [
          { text: "Back on: the security review is the blocker.", startSec: 10, endSec: 20 },
          { text: "I will chase the reviewers tomorrow.", startSec: 60, endSec: 70 },
        ],
      ]),
      decode: decodeSpans(120, 120),
    });
    return provider.transcribe({
      spans: spans.map((s) => ({ data: new Blob(), startOffsetMs: s.startOffsetMs })),
    });
  }

  it("loses nothing but the deliberate gap: every span reaches the Transcript", async () => {
    const fused = fuseTranscript(speakerTrack, await transcribeSpans());
    expect(fused.segments.map((s) => s.text)).toEqual([
      "We should ship the beta next Friday.",
      "Agreed. I will own the release checklist.",
      "Back on: the security review is the blocker.",
      "I will chase the reviewers tomorrow.",
    ]);
  });

  it("attributes each span's words to whoever was speaking then", async () => {
    const fused = fuseTranscript(speakerTrack, await transcribeSpans());
    expect(fused.provenance).toBe("fused");
    expect(fused.segments.map((s) => s.speaker)).toEqual(["Alice", "Bob", "Carol", "Bob"]);
    // The second span's words would have collapsed onto the first span's turns —
    // and been credited to Alice and Bob — had its offset been dropped.
    expect(fused.segments.map((s) => s.startMs)).toEqual([30_000, 70_000, 610_000, 660_000]);
  });

  it("invents nothing to fill the gap the user chose", async () => {
    const fused = fuseTranscript(speakerTrack, await transcribeSpans());
    const inGap = fused.segments.filter((s) => (s.startMs ?? 0) > 80_000 && (s.startMs ?? 0) < 610_000);
    expect(inGap).toEqual([]);
    // Nor is the gap reported as speech nobody can be found for: no placeholder
    // segment, no Unknown speaker standing in for silence.
    expect(fused.segments.map((s) => s.speaker)).not.toContain(UNKNOWN_SPEAKER);
  });
});
