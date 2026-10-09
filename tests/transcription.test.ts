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
  TranscriptionSilent,
  TranscriptionError,
  type DecodeAudio,
  type EngineSpan,
  type TranscriptionEngine,
} from "../src/transcription/provider";

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

/** A one-span Audio Recording — the ordinary case, capture started once. */
const recording = (startOffsetMs = 0) => ({ spans: [{ data: new Blob(), startOffsetMs }] });

/**
 * A Meeting recorded in several Capture Spans: one blob per span, each starting
 * at its own distance from the Meeting start.
 */
const spanned = (...startOffsetsMs: number[]) => ({
  spans: startOffsetsMs.map((startOffsetMs) => ({ data: new Blob(), startOffsetMs })),
});

/** Decoder for a spanned recording: the nth call decodes the nth span, so spans
 * can have different lengths. */
function fakeDecodeSpans(...seconds: number[]): DecodeAudio {
  let call = 0;
  return () =>
    Promise.resolve({ samples: audioOf(seconds[call++] ?? 0), sampleRate: SAMPLE_RATE });
}

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

  it("hands the cancel to the engine, and an engine that honours it has been cancelled", async () => {
    // A cloud engine's one call can be a long upload: the cancel has to reach
    // it mid-call, and what its fetch then throws is the user's skip, not a
    // failure to hold the Recording for.
    const abort = new AbortController();
    let received: AbortSignal | undefined;
    const engine: TranscriptionEngine = {
      ...fakeEngine(),
      transcribe(_samples, signal) {
        received = signal;
        const call = new Promise<EngineSpan[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        });
        // The user skips while this call is still in flight.
        abort.abort();
        return call;
      },
    };
    const promise = provider(engine, 30).transcribe(recording(), { signal: abort.signal });
    await expect(promise).rejects.toThrow(TranscriptionCancelled);
    expect(received).toBe(abort.signal);
  });
});

// --- Silence, which an engine answers with words anyway -----------------------
//
// Fed a silent recording Whisper returns its canonical artifact, the single word
// "you". Downstream nothing can tell that from speech: it is stamped as recorded
// audio and replaces the caption words wholesale, which is how two Summary
// Artifacts came to be one hallucinated token apologising for having nothing to
// summarize. So the provider refuses it here, before it can count as audio words.

describe("Transcription Provider: refusing output that carries no speech", () => {
  const artifact = (text: string, seconds: number) =>
    fakeEngine({ maxInputMs: 3_600_000, spansFor: () => [{ text, startSec: 0, endSec: seconds }] });

  it("refuses the single word Whisper answers silence with", async () => {
    // The real case: a 27-second recording whose whole transcript was "you".
    const err = await provider(artifact("you", 27), 27)
      .transcribe(recording())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptionSilent);
  });

  it("refuses the artifact's other stock forms", async () => {
    for (const text of ["Thank you.", "Thanks for watching!", "[BLANK_AUDIO]", "   "]) {
      await expect(provider(artifact(text, 41), 41).transcribe(recording())).rejects.toThrow(
        TranscriptionSilent,
      );
    }
  });

  it("refuses an artifact looped for the length of the recording", async () => {
    // Engines answer long silences with repetition as readily as with one token,
    // and thirty copies of a word is still one word's worth of information.
    const looped = "you ".repeat(30).trim();
    await expect(provider(artifact(looped, 600), 600).transcribe(recording())).rejects.toThrow(
      TranscriptionSilent,
    );
  });

  it("refuses a few words against a recording far too long to have held only those", async () => {
    // Not a known artifact — the guard cannot be a list of strings alone, or the
    // next hallucination walks straight through it.
    await expect(provider(artifact("Okay.", 2_400), 2_400).transcribe(recording())).rejects.toThrow(
      TranscriptionSilent,
    );
  });

  it("says the recording carried no speech instead of reporting a failure", async () => {
    const err = (await provider(artifact("you", 27), 27)
      .transcribe(recording())
      .catch((e: unknown) => e)) as TranscriptionSilent;
    // The three outcomes must stay apart: silence is not the user skipping the
    // wait, and it is not an outage whose audio is worth holding for a retry.
    expect(err.reason).toMatch(/no speech/);
    expect(err).not.toBeInstanceOf(TranscriptionCancelled);
  });

  it("does not mistake an engine outage for silence", async () => {
    const err = await provider(fakeEngine({ failWith: new Error("out of memory") }), 27)
      .transcribe(recording())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err).not.toBeInstanceOf(TranscriptionSilent);
  });

  it("keeps a genuinely short exchange's words", async () => {
    // Twenty seconds of real speech is a handful of words, and those words are
    // the accurate ones this product exists to capture.
    const engine = artifact("Yes — let's ship the beta on Friday.", 6);
    const utterances = await provider(engine, 20).transcribe(recording());
    expect(utterances.map((u) => u.text)).toEqual(["Yes — let's ship the beta on Friday."]);
  });

  it("keeps one real exchange inside a long, mostly quiet recording", async () => {
    // A lull is not a hallucination. Forty minutes with one exchange in it still
    // has words that were said, and they must reach the Transcript.
    const engine = artifact(
      "The security review is the blocker; I will chase the reviewers tomorrow.",
      2_400,
    );
    const utterances = await provider(engine, 2_400).transcribe(recording());
    expect(utterances).toHaveLength(1);
  });
});

// --- A Meeting recorded in several Capture Spans -----------------------------
//
// The user stopped capture for a sensitive stretch and started it again. Each
// Capture Start wrote its own file (ADR-0005), so what the provider is handed is
// a list of spans, and every span's words have to land where they were actually
// spoken in the Meeting — fusion attributes on nothing but those timings.

describe("Transcription Provider across Capture Spans", () => {
  it("transcribes every span in order and concatenates their Utterances", async () => {
    const engine = fakeEngine({
      maxInputMs: 600_000,
      spansFor: (call) => [{ text: `span ${call}`, startSec: 0, endSec: 5 }],
    });
    const p = createTranscriptionProvider({
      name: "fake",
      engine,
      decode: fakeDecodeSpans(30, 30, 30),
    });
    const utterances = await p.transcribe(spanned(0, 120_000, 300_000));
    expect(utterances.map((u) => u.text)).toEqual(["span 1", "span 2", "span 3"]);
  });

  it("shifts each span's words by its own Capture Start, so a gap is not closed up", async () => {
    // Two spans, five minutes apart: the second span's engine timings restart at
    // zero, so an offset taken from the recording rather than from the span would
    // drag its words back into the first span's turns and misattribute all of them.
    const engine = fakeEngine({
      maxInputMs: 600_000,
      spansFor: (call) => [{ text: `span ${call}`, startSec: 2, endSec: 4 }],
    });
    const p = createTranscriptionProvider({ name: "fake", engine, decode: fakeDecodeSpans(60, 60) });
    const utterances = await p.transcribe(spanned(0, 300_000));
    expect(utterances).toEqual([
      { text: "span 1", startMs: 2_000, endMs: 4_000 },
      { text: "span 2", startMs: 302_000, endMs: 304_000 },
    ]);
  });

  it("chunks each span against the engine's input limit on that span's own clock", async () => {
    const engine = fakeEngine({
      maxInputMs: 60_000,
      spansFor: (call) => [{ text: `chunk ${call}`, startSec: 1, endSec: 2 }],
    });
    const p = createTranscriptionProvider({ name: "fake", engine, decode: fakeDecodeSpans(90, 30) });
    const utterances = await p.transcribe(spanned(0, 600_000));
    expect(engine.windowsSec).toEqual([60, 30, 30]);
    expect(utterances).toEqual([
      { text: "chunk 1", startMs: 1_000, endMs: 2_000 },
      { text: "chunk 2", startMs: 61_000, endMs: 62_000 },
      { text: "chunk 3", startMs: 601_000, endMs: 602_000 },
    ]);
  });

  it("measures progress against the audio recorded, not the Meeting's length", async () => {
    // The gap is time the user chose not to record. Counting it as work still to
    // do would stall the wait at a percentage that can never be reached.
    const audioProgress: [number, number][] = [];
    const engine = fakeEngine({ maxInputMs: 60_000 });
    const p = createTranscriptionProvider({ name: "fake", engine, decode: fakeDecodeSpans(60, 30) });
    await p.transcribe(spanned(0, 600_000), {
      onAudioProgress: (processedMs, totalMs) => audioProgress.push([processedMs, totalMs]),
    });
    expect(audioProgress).toEqual([
      [60_000, 90_000],
      [90_000, 90_000],
    ]);
  });
});

// --- Diarization labels, which hold only within one engine call ---------------

describe("Transcription Provider diarization labels", () => {
  const diarized = (): EngineSpan[] => [{ text: "hello", startSec: 0, endSec: 1, speaker: "Speaker 1" }];

  it("passes a label through when the recording took one engine call", async () => {
    const utterances = await provider(fakeEngine({ spansFor: diarized }), 30).transcribe(recording());
    expect(utterances.map((u) => u.diarizationLabel)).toEqual(["Speaker 1"]);
  });

  it("names the part a label came from once a recording takes several calls", async () => {
    // Two windows: the engine's "Speaker 1" in each need not be the same person.
    const engine = fakeEngine({ maxInputMs: 60_000, spansFor: diarized });
    const utterances = await provider(engine, 90).transcribe(recording());
    expect(utterances.map((u) => u.diarizationLabel)).toEqual([
      "Speaker 1 (part 1)",
      "Speaker 1 (part 2)",
    ]);
  });

  it("numbers parts across Capture Spans, not within each", async () => {
    const utterances = await provider(fakeEngine({ spansFor: diarized }), 30).transcribe({
      spans: [
        { data: new Blob(), startOffsetMs: 0 },
        { data: new Blob(), startOffsetMs: 120_000 },
      ],
    });
    expect(utterances.map((u) => u.diarizationLabel)).toEqual([
      "Speaker 1 (part 1)",
      "Speaker 1 (part 2)",
    ]);
  });

  it("leaves an engine that does not diarize without labels", async () => {
    const utterances = await provider(fakeEngine({ maxInputMs: 60_000 }), 90).transcribe(
      recording(),
    );
    expect(utterances.every((u) => u.diarizationLabel === undefined)).toBe(true);
  });
});

describe("Transcription Provider: windows cut at pauses", () => {
  /** 25 s of loud audio with two half-second pauses, at 7 s and at 17 s. */
  function withPauses(): Float32Array {
    const samples = new Float32Array(25 * SAMPLE_RATE).fill(0.5);
    samples.fill(0, 7 * SAMPLE_RATE, 7.5 * SAMPLE_RATE);
    samples.fill(0, 17 * SAMPLE_RATE, 17.5 * SAMPLE_RATE);
    return samples;
  }

  function pausedProvider(engine: TranscriptionEngine) {
    const samples = withPauses();
    return createTranscriptionProvider({
      name: "fake",
      engine,
      decode: () => Promise.resolve({ samples, sampleRate: SAMPLE_RATE }),
    });
  }

  it("hands an engine that asks for it windows that end in the pauses", async () => {
    const engine = { ...fakeEngine(), windowing: { targetMs: 10_000, maxMs: 30_000 } };
    await pausedProvider(engine).transcribe(recording());
    const [first = 0, second = 0] = engine.windowsSec;
    expect(first).toBeGreaterThanOrEqual(7);
    expect(first).toBeLessThanOrEqual(7.5);
    expect(first + second).toBeGreaterThanOrEqual(17);
    expect(first + second).toBeLessThanOrEqual(17.5);
  });

  it("times each window's words from where that window started in the Meeting", async () => {
    const engine = { ...fakeEngine(), windowing: { targetMs: 10_000, maxMs: 30_000 } };
    const utterances = await pausedProvider(engine).transcribe(recording(1_000));
    let startedSec = 0;
    const expected = engine.windowsSec.map((length) => {
      const startMs = 1_000 + Math.round(startedSec * 1000);
      startedSec += length;
      return startMs;
    });
    expect(utterances.map((u) => u.startMs)).toEqual(expected);
  });

  it("skips a window cut at pauses that holds no signal, and still counts its audio", async () => {
    // 10 s of sound, 20 s of digital silence, 10 s of sound.
    const samples = new Float32Array(40 * SAMPLE_RATE).fill(0.5);
    samples.fill(0, 10 * SAMPLE_RATE, 30 * SAMPLE_RATE);
    const engine = { ...fakeEngine(), windowing: { targetMs: 10_000, maxMs: 30_000 } };
    const progress: number[] = [];
    const utterances = await createTranscriptionProvider({
      name: "fake",
      engine,
      decode: () => Promise.resolve({ samples, sampleRate: SAMPLE_RATE }),
    }).transcribe(recording(), { onAudioProgress: (done) => progress.push(done) });
    // Every window inside the silence was skipped; the two with sound were sent.
    expect(engine.windowsSec.length).toBeLessThan(4);
    expect(utterances.every((u) => u.startMs < 10_000 || u.startMs >= 25_000)).toBe(true);
    expect(progress.at(-1)).toBe(40_000);
  });

  it("sends a silent window anyway for an engine that does not cut at pauses", async () => {
    // fakeDecode's audio is all zeros: an engine with long windows still gets it.
    const engine = fakeEngine({ maxInputMs: 60_000 });
    await provider(engine, 90).transcribe(recording());
    expect(engine.windowsSec).toEqual([60, 30]);
  });

  it("never hands the engine more than its input limit, whatever the windowing allows", async () => {
    const engine = {
      ...fakeEngine({ maxInputMs: 12_000 }),
      windowing: { targetMs: 10_000, maxMs: 30_000 },
    };
    await pausedProvider(engine).transcribe(recording());
    expect(Math.max(...engine.windowsSec)).toBeLessThanOrEqual(12);
  });
});

describe("Transcription Provider: several windows in flight", () => {
  /** An engine whose calls finish in reverse order, recording how many overlap. */
  function slowEngine(concurrency: number, failOn?: number) {
    let inFlight = 0;
    let call = 0;
    const engine = {
      ...fakeEngine({ maxInputMs: 10_000 }),
      concurrency,
      peak: 0,
      signals: [] as (AbortSignal | undefined)[],
      async transcribe(samples: Float32Array, signal?: AbortSignal): Promise<EngineSpan[]> {
        const n = ++call;
        engine.signals.push(signal);
        inFlight++;
        engine.peak = Math.max(engine.peak, inFlight);
        // Earlier calls wait longer, so they finish after later ones.
        await new Promise((resolve) => setTimeout(resolve, 40 - n * 4));
        inFlight--;
        if (n === failOn) throw new Error(`window ${n} failed`);
        if (signal?.aborted) throw new Error("aborted");
        return [{ text: `window ${n}`, startSec: 0, endSec: samples.length / SAMPLE_RATE }];
      },
    };
    return engine;
  }

  it("keeps no more than the engine's limit in flight", async () => {
    const engine = slowEngine(3);
    await provider(engine, 80).transcribe(recording());
    expect(engine.peak).toBe(3);
  });

  it("returns the words in Meeting order, whatever order the calls finished in", async () => {
    const utterances = await provider(slowEngine(4), 80).transcribe(recording());
    expect(utterances.map((u) => u.text)).toEqual(
      Array.from({ length: 8 }, (_, i) => `window ${i + 1}`),
    );
    expect(utterances.map((u) => u.startMs)).toEqual(Array.from({ length: 8 }, (_, i) => i * 10_000));
  });

  it("stops the other calls and holds the Recording when one fails", async () => {
    const engine = slowEngine(4, 2);
    await expect(provider(engine, 80).transcribe(recording())).rejects.toThrow("window 2 failed");
    // Calls in flight were told to stop, and no new call started after the failure.
    expect(engine.signals.every((s) => s?.aborted)).toBe(true);
    expect(engine.signals.length).toBeLessThan(8);
  });

  it("stops at once when the user skips the wait", async () => {
    const abort = new AbortController();
    const engine = slowEngine(4);
    const run = provider(engine, 80).transcribe(recording(), { signal: abort.signal });
    abort.abort();
    await expect(run).rejects.toBeInstanceOf(TranscriptionCancelled);
  });
});

describe("Transcription Provider: retained inference duration", () => {
  it("keeps short speech across concurrent windows without losing timings, labels, or progress", async () => {
    const abort = new AbortController();
    const progress = vi.fn();
    let calls = 0;
    let inFlight = 0;
    let peak = 0;
    const signals: Array<AbortSignal | undefined> = [];
    const engine: TranscriptionEngine = {
      ...fakeEngine({ maxInputMs: 120_000 }),
      concurrency: 2,
      inferenceDurationMs: () => 1_000,
      async transcribe(_samples, signal) {
        const call = ++calls;
        signals.push(signal);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20 - call * 4));
        inFlight--;
        return [{ text: "Approved.", startSec: 0, endSec: 1, speaker: "Speaker 1" }];
      },
    };

    const utterances = await provider(engine, 250).transcribe(recording(5_000), {
      signal: abort.signal,
      onAudioProgress: progress,
    });

    expect(peak).toBe(2);
    expect(utterances).toEqual([
      { text: "Approved.", startMs: 5_000, endMs: 6_000, diarizationLabel: "Speaker 1 (part 1)" },
      { text: "Approved.", startMs: 125_000, endMs: 126_000, diarizationLabel: "Speaker 1 (part 2)" },
      { text: "Approved.", startMs: 245_000, endMs: 246_000, diarizationLabel: "Speaker 1 (part 3)" },
    ]);
    expect(progress).toHaveBeenLastCalledWith(250_000, 250_000);
    expect(signals.every((signal) => signal !== undefined && !signal.aborted)).toBe(true);
    abort.abort();
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });

  it("keeps the decoded-duration check for engines without an override when silent windows are skipped", async () => {
    const samples = audioOf(250);
    samples.fill(0.5, 0, SAMPLE_RATE);
    const engine: TranscriptionEngine = {
      ...fakeEngine({
        maxInputMs: 30_000,
        spansFor: () => [{ text: "Approved.", startSec: 0, endSec: 1 }],
      }),
      windowing: { targetMs: 10_000, maxMs: 30_000 },
      concurrency: 2,
    };
    const p = createTranscriptionProvider({
      name: "fake",
      engine,
      decode: async () => ({ samples, sampleRate: SAMPLE_RATE }),
    });

    await expect(p.transcribe(recording())).rejects.toBeInstanceOf(TranscriptionSilent);
  });
});
