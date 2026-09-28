// ElevenLabs Scribe, in two parts.
//
// The word list → spans conversion is where the engine decides what the
// transcript says and who said it, so it is pinned directly, with no request
// and no provider wrapper; times there are relative to the uploaded audio.
// The engine is then driven through the wrapper with the HTTP call faked, for
// what only it owns: the request, its input limit, its timeout, and the cancel.
import { describe, expect, it, vi } from "vitest";
import {
  createElevenLabsTranscriptionEngine,
  SCRIBE_MAX_INPUT_MS,
  SCRIBE_MAX_SPAN_SEC,
  SCRIBE_PAUSE_SPLIT_SEC,
  SCRIBE_TIMEOUT_GRACE_MS,
  spansFromScribe,
  type ScribeWord,
} from "../src/transcription/elevenlabs";
import { OPENAI_TRANSCRIPTION_MAX_INPUT_MS } from "../src/transcription/openai";
import {
  createTranscriptionProvider,
  TranscriptionCancelled,
  TranscriptionError,
  type DecodeAudio,
} from "../src/transcription/provider";

const word = (text: string, start: number, end: number, speaker_id?: string): ScribeWord => ({
  text,
  type: "word",
  start,
  end,
  ...(speaker_id ? { speaker_id } : {}),
});
const space = (at: number): ScribeWord => ({ text: " ", type: "spacing", start: at, end: at });

describe("spansFromScribe", () => {
  it("joins one speaker's consecutive words into a span, spacing as written", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("Ship", 0, 0.3, "speaker_0"),
          space(0.3),
          word("it", 0.35, 0.5, "speaker_0"),
          space(0.5),
          word("Friday.", 0.55, 1, "speaker_0"),
        ],
      },
      5,
    );
    expect(spans).toEqual([{ text: "Ship it Friday.", startSec: 0, endSec: 1, speaker: "Speaker 1" }]);
  });

  it("splits at a speaker change and numbers speakers by first appearance", () => {
    const spans = spansFromScribe(
      {
        words: [
          // Scribe's ids carry no order worth keeping: the first voice heard is Speaker 1.
          word("Ready?", 0, 0.5, "speaker_3"),
          space(0.5),
          word("Yes.", 0.6, 0.9, "speaker_0"),
          space(0.9),
          word("Go.", 1, 1.2, "speaker_3"),
        ],
      },
      5,
    );
    expect(spans).toEqual([
      { text: "Ready?", startSec: 0, endSec: 0.5, speaker: "Speaker 1" },
      { text: "Yes.", startSec: 0.6, endSec: 0.9, speaker: "Speaker 2" },
      { text: "Go.", startSec: 1, endSec: 1.2, speaker: "Speaker 1" },
    ]);
  });

  it("splits one speaker's words at a long enough pause", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("First.", 0, 1, "speaker_0"),
          space(1),
          word("Second.", 1 + SCRIBE_PAUSE_SPLIT_SEC, 3, "speaker_0"),
        ],
      },
      5,
    );
    expect(spans.map((s) => s.text)).toEqual(["First.", "Second."]);
  });

  it("does not split at a pause shorter than the threshold", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("One", 0, 1, "speaker_0"),
          space(1),
          word("breath.", 1 + SCRIBE_PAUSE_SPLIT_SEC - 0.1, 3, "speaker_0"),
        ],
      },
      5,
    );
    expect(spans.map((s) => s.text)).toEqual(["One breath."]);
  });

  it("ends a span before it would pass the length cap", () => {
    // One word a second, no pauses, one speaker: only the cap can split this.
    const words: ScribeWord[] = [];
    for (let i = 0; i < SCRIBE_MAX_SPAN_SEC + 10; i++) {
      words.push(word(`w${i}`, i, i + 1, "speaker_0"), space(i + 1));
    }
    const spans = spansFromScribe({ words }, SCRIBE_MAX_SPAN_SEC + 10);
    expect(spans.length).toBe(2);
    expect(spans[0]!.endSec - spans[0]!.startSec).toBeLessThanOrEqual(SCRIBE_MAX_SPAN_SEC);
    expect(spans[1]!.startSec).toBe(spans[0]!.endSec);
  });

  it("drops audio events, which are not speech", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("Funny.", 0, 0.5, "speaker_0"),
          { text: "(laughter)", type: "audio_event", start: 0.5, end: 1.5 },
          word("Anyway.", 1.6, 2, "speaker_0"),
        ],
      },
      5,
    );
    expect(spans.map((s) => s.text).join(" ")).not.toContain("laughter");
  });

  it("keeps an untimed word, placed at the latest timing seen", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("Timed", 0, 0.5, "speaker_0"),
          space(0.5),
          { text: "untimed", type: "word", start: null, end: null, speaker_id: "speaker_0" },
        ],
      },
      5,
    );
    expect(spans).toEqual([{ text: "Timed untimed", startSec: 0, endSec: 0.5, speaker: "Speaker 1" }]);
  });

  it("omits the speaker where Scribe gave none", () => {
    const spans = spansFromScribe({ words: [word("Hello.", 0, 1)] }, 5);
    expect(spans).toEqual([{ text: "Hello.", startSec: 0, endSec: 1 }]);
    expect(spans[0]).not.toHaveProperty("speaker");
  });

  it("joins words Scribe writes without spacing", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("我们", 0, 0.4, "speaker_0"),
          word("周五", 0.4, 0.8, "speaker_0"),
          word("发布。", 0.8, 1.2, "speaker_0"),
        ],
      },
      5,
    );
    expect(spans).toEqual([{ text: "我们周五发布。", startSec: 0, endSec: 1.2, speaker: "Speaker 1" }]);
  });

  it("keeps the words when the response carries text but no word list", () => {
    expect(spansFromScribe({ text: "no word list" }, 8)).toEqual([
      { text: "no word list", startSec: 0, endSec: 8 },
    ]);
  });

  it("returns nothing for a word list with no speech in it", () => {
    // `text` would read "(laughter)": falling back to it would pass a sound off as words.
    const spans = spansFromScribe(
      {
        text: "(laughter)",
        words: [{ text: "(laughter)", type: "audio_event", start: 0, end: 1 }],
      },
      5,
    );
    expect(spans).toEqual([]);
  });
});

// --- The engine, through the provider wrapper ----------------------------------

const SAMPLE_RATE = 16_000;

function fakeDecode(seconds: number): DecodeAudio {
  return () =>
    Promise.resolve({
      samples: new Float32Array(Math.round(seconds * SAMPLE_RATE)),
      sampleRate: SAMPLE_RATE,
    });
}

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** A fetch that never answers, only rejecting when its signal fires. */
function hangingFetch() {
  const calls: Array<{ init: RequestInit }> = [];
  const fn = ((_url: unknown, init: RequestInit) => {
    calls.push({ init });
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const recording = (startOffsetMs = 0) => ({ spans: [{ data: new Blob(), startOffsetMs }] });

function scribeProvider(opts: {
  fetchFn: typeof fetch;
  seconds: number;
  timeoutMsFor?: (audioMs: number) => number;
}) {
  const engine = createElevenLabsTranscriptionEngine({
    apiKey: "xi-t",
    model: "scribe_v2",
    language: "ms",
    fetchFn: opts.fetchFn,
    ...(opts.timeoutMsFor ? { timeoutMsFor: opts.timeoutMsFor } : {}),
  });
  return createTranscriptionProvider({
    name: engine.name,
    engine,
    decode: fakeDecode(opts.seconds),
  });
}

const oneWord = { words: [word("Hai.", 0, 0.5, "speaker_0")] };

describe("ElevenLabs Scribe Transcription Provider", () => {
  it("uploads bare PCM with the key, the language, and diarization on", async () => {
    const { fn, calls } = fakeFetch(oneWord);
    await scribeProvider({ fetchFn: fn, seconds: 5 }).transcribe(recording());
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect((calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("xi-t");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("file_format")).toBe("pcm_s16le_16");
    expect(form.get("language_code")).toBe("ms");
    expect(form.get("diarize")).toBe("true");
    expect(form.get("timestamps_granularity")).toBe("word");
    expect(form.get("tag_audio_events")).toBe("false");
    // 5s of 16 kHz mono 16-bit PCM, and no container header around it.
    expect((form.get("file") as File).size).toBe(5 * SAMPLE_RATE * 2);
  });

  it("turns the response into diarized Utterances timed from the Meeting start", async () => {
    const { fn } = fakeFetch({
      words: [
        word("Boleh", 1.5, 1.9, "speaker_0"),
        { text: " ", type: "spacing", start: 1.9, end: 2 },
        word("mula?", 2, 2.4, "speaker_0"),
        word("Boleh.", 3, 3.5, "speaker_1"),
      ],
    });
    // Recording began 90s into the Meeting.
    const utterances = await scribeProvider({ fetchFn: fn, seconds: 10 }).transcribe(
      recording(90_000),
    );
    expect(utterances).toEqual([
      { text: "Boleh mula?", startMs: 91_500, endMs: 92_400, diarizationLabel: "Speaker 1" },
      { text: "Boleh.", startMs: 93_000, endMs: 93_500, diarizationLabel: "Speaker 2" },
    ]);
  });

  it("uploads an hour at a time, so most Capture Spans keep one set of labels", async () => {
    expect(SCRIBE_MAX_INPUT_MS).toBe(3_600_000);
    expect(SCRIBE_MAX_INPUT_MS).toBeGreaterThan(OPENAI_TRANSCRIPTION_MAX_INPUT_MS);
    // Enough distinct words that an hour of audio is not refused as silence.
    const { fn, calls } = fakeFetch({
      words: [word("Kita perlu semak laporan kewangan suku ketiga minggu depan.", 0, 4, "speaker_0")],
    });
    // 61 minutes: two uploads, and each upload's labels say which part they are.
    const utterances = await scribeProvider({ fetchFn: fn, seconds: 61 * 60 }).transcribe(
      recording(),
    );
    expect(calls.length).toBe(2);
    expect(utterances.map((u) => u.diarizationLabel)).toEqual([
      "Speaker 1 (part 1)",
      "Speaker 1 (part 2)",
    ]);
  });

  it("surfaces an HTTP failure as TranscriptionError (the Held Recording path)", async () => {
    const { fn } = fakeFetch({ detail: { message: "invalid api key" } }, 401);
    const promise = scribeProvider({ fetchFn: fn, seconds: 5 }).transcribe(recording());
    await expect(promise).rejects.toThrow(TranscriptionError);
    await expect(promise).rejects.toThrow(/HTTP 401/);
  });

  it("gives up on a stalled upload as a TranscriptionError, not a cancel", async () => {
    const { fn } = hangingFetch();
    const promise = scribeProvider({ fetchFn: fn, seconds: 5, timeoutMsFor: () => 20 }).transcribe(
      recording(),
    );
    await expect(promise).rejects.toThrow(/no response after/);
    await expect(promise).rejects.not.toThrow(TranscriptionCancelled);
  });

  it("allows a window the grace period plus its own length by default", async () => {
    // Not waited out: what is pinned is the deadline the request is given.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      const engine = createElevenLabsTranscriptionEngine({
        apiKey: "xi-t",
        model: "scribe_v2",
        language: "en",
        fetchFn: fakeFetch(oneWord).fn,
      });
      await engine.transcribe(new Float32Array(5 * SAMPLE_RATE));
      expect(timeoutSpy).toHaveBeenCalledWith(SCRIBE_TIMEOUT_GRACE_MS + 5000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("stops an upload in flight when the user skips the wait", async () => {
    const { fn, calls } = hangingFetch();
    const abort = new AbortController();
    const promise = scribeProvider({ fetchFn: fn, seconds: 5 }).transcribe(recording(), {
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    abort.abort();
    await expect(promise).rejects.toThrow(TranscriptionCancelled);
  });
});
