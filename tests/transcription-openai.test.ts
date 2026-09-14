// The Transcription Provider seam again, for the cloud engine and for selection.
//
// Two things are worth pinning here and nothing else is: that the engine turns a
// window of samples into correctly timed Utterances (fusion attributes speakers
// by those timings), and that selection keeps the local default in place so a
// public user with no key and no willingness to upload audio keeps working.
//
// The HTTP call is faked. Real cloud inference is not unit-tested, for the same
// reason real model inference is not.
import { describe, expect, it } from "vitest";
import type { TranscriptionSettings } from "../src/domain/types";
import { DEFAULT_SETTINGS } from "../src/settings";
import { createTranscriptionProviderFor } from "../src/transcription/factory";
import { WHISPER_MAX_INPUT_MS } from "../src/transcription/local-whisper";
import {
  createOpenAiTranscriptionEngine,
  OPENAI_TRANSCRIPTION_MAX_INPUT_MS,
} from "../src/transcription/openai";
import {
  createTranscriptionProvider,
  TranscriptionError,
  type DecodeAudio,
} from "../src/transcription/provider";

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

const recording = (startOffsetMs = 0) => ({ data: new Blob(), startOffsetMs });

function openAiProvider(opts: {
  fetchFn: typeof fetch;
  seconds: number;
  model?: string;
  apiKey?: string;
}) {
  const engine = createOpenAiTranscriptionEngine({
    apiKey: opts.apiKey ?? "sk-t",
    model: opts.model ?? "whisper-1",
    fetchFn: opts.fetchFn,
  });
  return createTranscriptionProvider({
    name: engine.name,
    engine,
    decode: fakeDecode(opts.seconds),
  });
}

/** Settings with cloud transcription opted into, everything else default. */
function cloudSettings(overrides: Partial<TranscriptionSettings["openai"]> = {}) {
  return {
    ...DEFAULT_SETTINGS.transcription,
    provider: "openai" as const,
    openai: { apiKey: "sk-t", model: "whisper-1", ...overrides },
  };
}

describe("OpenAI Transcription Provider", () => {
  it("uploads the audio as a file and asks for segment timestamps", async () => {
    const { fn, calls } = fakeFetch({ segments: [{ start: 0, end: 1, text: "hi" }] });
    await openAiProvider({ fetchFn: fn, seconds: 5 }).transcribe(recording());
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-t");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("verbose_json");
    const file = form.get("file") as File;
    // 5s of 16 kHz mono 16-bit PCM plus the 44-byte WAV header.
    expect(file.size).toBe(44 + 5 * SAMPLE_RATE * 2);
  });

  it("normalizes segments into Utterances timed from the Meeting start", async () => {
    const { fn } = fakeFetch({
      segments: [
        { start: 1.5, end: 4.25, text: " We should ship the beta. " },
        { start: 4.25, end: 5, text: "Agreed." },
      ],
    });
    // Recording began 90s into the Meeting.
    const utterances = await openAiProvider({ fetchFn: fn, seconds: 10 }).transcribe(
      recording(90_000),
    );
    expect(utterances).toEqual([
      { text: "We should ship the beta.", startMs: 91_500, endMs: 94_250 },
      { text: "Agreed.", startMs: 94_250, endMs: 95_000 },
    ]);
  });

  it("keeps the words when the response carries no segment timings", async () => {
    const { fn } = fakeFetch({ text: "no timings here" });
    const utterances = await openAiProvider({ fetchFn: fn, seconds: 8 }).transcribe(recording());
    expect(utterances).toEqual([{ text: "no timings here", startMs: 0, endMs: 8000 }]);
  });

  it("declares its own input limit, well past local Whisper's", async () => {
    expect(OPENAI_TRANSCRIPTION_MAX_INPUT_MS).toBeGreaterThan(WHISPER_MAX_INPUT_MS);
    const { fn, calls } = fakeFetch({ segments: [] });
    // 25 minutes: chunked at this engine's boundary, not the local engine's.
    await openAiProvider({ fetchFn: fn, seconds: 1500 }).transcribe(recording());
    expect(calls.length).toBe(3);
  });

  it("surfaces an HTTP failure as TranscriptionError (the Held Recording path)", async () => {
    const { fn } = fakeFetch({ error: { message: "invalid api key" } }, 401);
    const promise = openAiProvider({ fetchFn: fn, seconds: 5 }).transcribe(recording());
    await expect(promise).rejects.toThrow(TranscriptionError);
    await expect(promise).rejects.toThrow(/HTTP 401/);
  });
});

describe("Transcription Provider selection", () => {
  const deps = (fetchFn?: typeof fetch) => ({
    workerUrl: "whisper-worker.js",
    fetchFn,
    decode: fakeDecode(5),
  });

  it("defaults to local Whisper, so no key and no upload is required", () => {
    const { fn, calls } = fakeFetch({});
    const provider = createTranscriptionProviderFor(DEFAULT_SETTINGS.transcription, deps(fn));
    expect(provider.name).toBe("local-whisper");
    expect(calls).toHaveLength(0);
  });

  it("uses the cloud engine once the user opts in", async () => {
    const { fn, calls } = fakeFetch({ segments: [{ start: 0, end: 1, text: "cloud words" }] });
    const provider = createTranscriptionProviderFor(cloudSettings(), deps(fn));
    expect(provider.name).toBe("openai");
    expect(await provider.transcribe(recording())).toEqual([
      { text: "cloud words", startMs: 0, endMs: 1000 },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("refuses a cloud engine with no key before any audio leaves the machine", () => {
    const { fn, calls } = fakeFetch({});
    expect(() => createTranscriptionProviderFor(cloudSettings({ apiKey: "" }), deps(fn))).toThrow(
      TranscriptionError,
    );
    expect(calls).toHaveLength(0);
  });

  it("transcribes the same recording once the settings that failed are fixed", async () => {
    const { fn } = fakeFetch({ segments: [{ start: 0, end: 2, text: "recovered" }] });
    let settings = cloudSettings({ apiKey: "" });
    expect(() => createTranscriptionProviderFor(settings, deps(fn))).toThrow(TranscriptionError);
    // The user pastes the key and retries the Held Recording.
    settings = cloudSettings({ apiKey: "sk-t" });
    const utterances = await createTranscriptionProviderFor(settings, deps(fn)).transcribe(
      recording(),
    );
    expect(utterances).toEqual([{ text: "recovered", startMs: 0, endMs: 2000 }]);
  });
});
