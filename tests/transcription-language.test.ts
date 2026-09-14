// The meeting language, at the seam it has to reach: the engine.
//
// A dropped or wrong language hint is the one transcription defect that produces
// no error at all — Whisper decodes German audio as English-sounding words, and
// the summary then answers, faithfully, in the language of words that were never
// spoken. So what is pinned here is that the user's choice arrives at whichever
// engine is selected, in the form that engine takes it: a worker request for the
// local default, an HTTP parameter for the cloud engine.
import { describe, expect, it } from "vitest";
import type { MeetingLanguage, TranscriptionSettings } from "../src/domain/types";
import { createTranscriptionProviderFor } from "../src/transcription/factory";
import type { DecodeAudio } from "../src/transcription/provider";
import {
  whisperRunOptions,
  type WhisperRequest,
  type WhisperResponse,
} from "../src/transcription/whisper-protocol";

// ext.storage is faked (src/platform.ts resolves the namespace off globalThis)
// and the settings module imported after it exists — this file reads both the
// shipped default and what an existing user's stored settings load as.
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
const { DEFAULT_SETTINGS, loadSettings } = await import("../src/settings");

const SAMPLE_RATE = 16_000;

function fakeDecode(seconds: number): DecodeAudio {
  return () =>
    Promise.resolve({
      samples: new Float32Array(Math.round(seconds * SAMPLE_RATE)),
      sampleRate: SAMPLE_RATE,
    });
}

const recording = () => ({ spans: [{ data: new Blob(), startOffsetMs: 0 }] });

/**
 * Stand-in for the WASM worker: records every request the local engine posts and
 * answers it, so the engine can be driven far enough to declare a language. What
 * the worker then asks the model for is covered through `whisperRunOptions`,
 * which is why the real worker is not needed here.
 */
class FakeWorker {
  static requests: WhisperRequest[] = [];
  private listeners: ((event: { data: WhisperResponse }) => void)[] = [];
  addEventListener(type: string, fn: (event: { data: WhisperResponse }) => void): void {
    if (type === "message") this.listeners.push(fn);
  }
  postMessage(request: WhisperRequest): void {
    FakeWorker.requests.push(request);
    const reply: WhisperResponse =
      request.type === "load"
        ? { type: "loaded" }
        : { type: "spans", id: request.id, spans: [{ text: "words", startSec: 0, endSec: 1 }] };
    queueMicrotask(() => {
      for (const listener of this.listeners) listener({ data: reply });
    });
  }
  terminate(): void {}
}
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

function settingsFor(overrides: Partial<TranscriptionSettings>): TranscriptionSettings {
  return { ...DEFAULT_SETTINGS.transcription, ...overrides };
}

const deps = (fetchFn?: typeof fetch) => ({
  workerUrl: "whisper-worker.js",
  fetchFn,
  decode: fakeDecode(5),
});

function fakeFetch(body: unknown) {
  const calls: Array<{ init: RequestInit }> = [];
  const fn = (async (_url: unknown, init: RequestInit) => {
    calls.push({ init });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** One local-Whisper run, and every request it posted to its worker. */
async function localRun(language?: MeetingLanguage) {
  FakeWorker.requests = [];
  const settings = language ? settingsFor({ language }) : DEFAULT_SETTINGS.transcription;
  const utterances = await createTranscriptionProviderFor(settings, deps()).transcribe(recording());
  return { utterances, requests: [...FakeWorker.requests] };
}

const languagesAsked = (requests: WhisperRequest[]) =>
  requests.flatMap((r) => (r.type === "transcribe" ? [r.language] : []));

describe("meeting language", () => {
  it("reaches the local default engine as the language of every transcription", async () => {
    const { requests } = await localRun("de");
    expect(languagesAsked(requests)).toEqual(["de"]);
  });

  it("defaults to English, the language the engines assumed before it was asked", async () => {
    expect(DEFAULT_SETTINGS.transcription.language).toBe("en");
    expect(languagesAsked((await localRun()).requests)).toEqual(["en"]);
  });

  it("changes the hint and nothing else about the run", async () => {
    // The criterion a user cares about: picking German transcribes the next
    // Meeting as German without altering how the recording is loaded, chunked, or
    // turned into Utterances.
    const english = await localRun("en");
    const german = await localRun("de");
    expect(german.utterances).toEqual(english.utterances);
    expect(german.requests.map((r) => r.type)).toEqual(english.requests.map((r) => r.type));
    expect(languagesAsked(german.requests)).toEqual(["de"]);
  });

  it("reaches the cloud engine as the endpoint's language parameter", async () => {
    const { fn, calls } = fakeFetch({ segments: [{ start: 0, end: 1, text: "Guten Morgen" }] });
    const settings = settingsFor({
      provider: "openai",
      language: "de",
      openai: { apiKey: "sk-t", model: "whisper-1" },
    });
    await createTranscriptionProviderFor(settings, deps(fn)).transcribe(recording());
    const form = calls[0]!.init.body as FormData;
    expect(form.get("language")).toBe("de");
  });

  it("asks the model for that language without giving up the timings fusion needs", () => {
    const options = whisperRunOptions("uk");
    expect(options.language).toBe("uk");
    expect(options.return_timestamps).toBe(true);
    expect(options.chunk_length_s).toBe(30);
  });

  it("reads as English for settings saved before the language could be chosen", async () => {
    stored.settings = {
      provider: "anthropic",
      transcription: { provider: "local-whisper", localWhisper: { model: "small" } },
    };
    const s = await loadSettings();
    expect(s.transcription.language).toBe("en");
    // The rest of that user's transcription settings survive untouched.
    expect(s.transcription.localWhisper.model).toBe("small");
  });
});
