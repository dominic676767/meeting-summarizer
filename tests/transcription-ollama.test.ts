// The Ollama engine with the network replaced: the call it prepares, how the
// reply and each failure are read, the model check before any audio is sent,
// and the factory's checks. A real Ollama is the manual check's job.
import { describe, expect, it } from "vitest";
import type { MeetingLanguage, TranscriptionSettings } from "../src/domain/types";
import { DEFAULT_SETTINGS } from "../src/settings";
import {
  TRANSCRIPTION_ENGINE_NAMES,
  uploadDestination,
  uploadsAudio,
} from "../src/transcription/engines";
import { createTranscriptionProviderFor } from "../src/transcription/factory";
import {
  chatRequest,
  createOllamaTranscriptionEngine,
  DEFAULT_OLLAMA_TRANSCRIPTION_MODEL,
  httpFailure,
  isLoopbackUrl,
  modelProblem,
  OLLAMA_TRANSCRIPTION_CONCURRENCY,
  OLLAMA_TRANSCRIPTION_MAX_INPUT_MS,
  OLLAMA_TRANSCRIPTION_WINDOWING,
  OllamaFailure,
  ollamaTestReport,
  textFromChat,
  UNLISTED_LANGUAGES,
  type ChatRequest,
} from "../src/transcription/ollama";
import {
  createTranscriptionProvider,
  TranscriptionCancelled,
  TranscriptionError,
  TranscriptionSilent,
  type DecodeAudio,
} from "../src/transcription/provider";
import { UNLISTED_LANGUAGES as UNLISTED_BY_SAGEMAKER } from "../src/transcription/sagemaker";

const RATE = 16_000;
const BASE = "http://localhost:11434";
const MODEL = DEFAULT_OLLAMA_TRANSCRIPTION_MODEL;
const ORIGIN = "chrome-extension://hbobmcebmpakimlijcjiaklipegdelap";
const WHERE = { baseUrl: BASE, model: MODEL, origin: ORIGIN };
/** What `/api/show` says about a local Qwen3-ASR build. */
const SHOW = { capabilities: ["completion", "vision", "audio"], details: { family: "qwen3vl" } };

const silence = (seconds: number) => new Float32Array(Math.round(seconds * RATE));
/** Audio with signal in it: the wrapper skips windows of pure silence for this engine. */
const sound = (seconds: number) => new Float32Array(Math.round(seconds * RATE)).fill(0.5);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const chat = (content: string) => json({ model: MODEL, message: { role: "assistant", content }, done: true });

function request(language: MeetingLanguage = "en", seconds = 2): ChatRequest {
  return chatRequest({ model: MODEL, samples: silence(seconds), language });
}

/** The WAV a request carries, decoded from its base64. */
function wavOf(req: ChatRequest): Uint8Array {
  const user = req.messages[0];
  if (!user || !("images" in user)) throw new Error("no audio in the request");
  return Uint8Array.from(atob(user.images[0]), (c) => c.charCodeAt(0));
}

/**
 * A fetch that records each request and answers by path: `/api/show` with the
 * model's details, `/api/chat` with `answer`.
 */
function fakeOllama(answer: () => Response | Promise<Response>, show: () => Response = () => json(SHOW)) {
  const requests: { url: string; body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)), signal: init.signal });
    return url.endsWith("/api/show") ? show() : answer();
  }) as unknown as typeof fetch;
  return { fetchFn, requests, chats: () => requests.filter((r) => r.url.endsWith("/api/chat")) };
}

function engine(fetchFn: typeof fetch, over: { timeoutMs?: number; language?: MeetingLanguage } = {}) {
  return createOllamaTranscriptionEngine({
    baseUrl: `${BASE}/`,
    model: MODEL,
    language: over.language ?? "en",
    origin: ORIGIN,
    fetchFn,
    ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
  });
}

describe("chatRequest", () => {
  it("sends the window as a WAV in the user message's images, with an empty prompt", () => {
    const req = request("en", 2);
    expect(req.model).toBe(MODEL);
    expect(req.stream).toBe(false);
    expect(req.messages[0]).toMatchObject({ role: "user", content: "" });
    const wav = wavOf(req);
    // Ollama tells audio from pictures by these bytes.
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    const view = new DataView(wav.buffer);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint16(34, true)).toBe(16); // 16-bit
    expect(wav.length).toBe(44 + 2 * RATE * 2);
  });

  it("carries a 30-s window whole", () => {
    expect(wavOf(request("en", 30)).length).toBe(44 + 30 * RATE * 2);
  });

  it("asks for temperature 0 and an 8k context", () => {
    expect(request().options).toMatchObject({ temperature: 0, num_ctx: 8192 });
  });

  it("caps the reply at 16 tokens per second of audio, plus 32", () => {
    expect(request("en", 10).options.num_predict).toBe(192);
    expect(request("en", 2.5).options.num_predict).toBe(72);
  });

  it("begins the reply with the Meeting Language, in Qwen3-ASR's own words", () => {
    expect(request("en").messages[1]).toEqual({ role: "assistant", content: "language English<asr_text>" });
    expect(request("de").messages[1]).toEqual({ role: "assistant", content: "language German<asr_text>" });
    expect(request("zh").messages[1]).toEqual({ role: "assistant", content: "language Chinese<asr_text>" });
  });

  it("leaves the language to the model for the Meeting Languages Qwen3-ASR does not list", () => {
    expect(UNLISTED_LANGUAGES).toEqual(["he", "no", "uk"]);
    // The same model as the SageMaker engine, so the same list.
    expect([...UNLISTED_LANGUAGES].sort()).toEqual([...UNLISTED_BY_SAGEMAKER].sort());
    for (const code of UNLISTED_LANGUAGES) {
      expect(request(code).messages).toHaveLength(1);
    }
  });
});

describe("textFromChat", () => {
  it("drops Qwen3-ASR's language line", () => {
    expect(textFromChat({ message: { content: "language English<asr_text>And so, my fellow Americans." } })).toBe(
      "And so, my fellow Americans.",
    );
  });

  it("reads a reply that was begun for the model as words only", () => {
    expect(textFromChat({ message: { content: "  Guten Tag zusammen. " } })).toBe("Guten Tag zusammen.");
  });

  it("finds no words in a language line with nothing after it", () => {
    expect(textFromChat({ message: { content: "language None" } })).toBe("");
    expect(textFromChat({ message: { content: "language English<asr_text>" } })).toBe("");
    expect(textFromChat({ message: { content: "" } })).toBe("");
  });

  it("calls a reply without a message a format failure", () => {
    expect(() => textFromChat({ response: "hello" })).toThrow(OllamaFailure);
    expect(() => textFromChat(null)).toThrow(/the reply has no message/);
  });
});

describe("modelProblem", () => {
  it("accepts a local model that takes audio", () => {
    expect(modelProblem(SHOW, MODEL)).toBeNull();
  });

  it("refuses a model that cannot take audio, and names one that can", () => {
    expect(modelProblem({ capabilities: ["completion", "tools"] }, "llama3.1")).toBe(
      `model llama3.1 cannot take audio — choose a speech-to-text model such as ${MODEL}`,
    );
    expect(modelProblem({}, "llama3.1")).toMatch(/cannot take audio/);
  });

  it("refuses a model that Ollama runs on its cloud: the audio would leave the machine", () => {
    const cloud = { ...SHOW, remote_host: "https://ollama.com:443", remote_model: "asr" };
    expect(modelProblem(cloud, "asr:cloud")).toMatch(/^model asr:cloud runs on Ollama's cloud, not on this computer/);
  });
});

describe("httpFailure", () => {
  it("names OLLAMA_ORIGINS and this extension's origin for a 403", () => {
    const failure = httpFailure(403, "", WHERE);
    expect(failure.kind).toBe("origin");
    expect(failure.message).toContain("OLLAMA_ORIGINS");
    expect(failure.message).toContain(`launchctl setenv OLLAMA_ORIGINS "${ORIGIN}"`);
  });

  it("says to pull a model that Ollama does not have", () => {
    const failure = httpFailure(404, JSON.stringify({ error: `model '${MODEL}' not found` }), WHERE);
    expect(failure.kind).toBe("model");
    expect(failure.message).toContain(`ollama pull ${MODEL}`);
  });

  it("passes on Ollama's own error for anything else", () => {
    const failure = httpFailure(500, JSON.stringify({ error: "out of memory" }), WHERE);
    expect(failure.kind).toBe("other");
    expect(failure.message).toBe("ollama transcription: Ollama answered 500: out of memory");
  });

  it("is a TranscriptionError, so the Recording is held", () => {
    expect(httpFailure(403, "", WHERE)).toBeInstanceOf(TranscriptionError);
  });
});

describe("isLoopbackUrl", () => {
  it("accepts this computer only", () => {
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:11434/")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:11434")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.20:11434")).toBe(false);
    expect(isLoopbackUrl("https://ollama.example.com")).toBe(false);
    expect(isLoopbackUrl("http://localhost.example.com:11434")).toBe(false);
    expect(isLoopbackUrl("localhost:11434")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});

describe("the Ollama engine", () => {
  it("asks the wrapper for windows cut at pauses, none longer than 30 s", () => {
    const e = engine(fakeOllama(() => chat("")).fetchFn);
    expect(e.windowing).toEqual(OLLAMA_TRANSCRIPTION_WINDOWING);
    expect(e.maxInputMs).toBe(OLLAMA_TRANSCRIPTION_MAX_INPUT_MS);
    expect(OLLAMA_TRANSCRIPTION_MAX_INPUT_MS).toBe(30_000);
  });

  it("asks for two windows in flight at once", () => {
    expect(engine(fakeOllama(() => chat("")).fetchFn).concurrency).toBe(OLLAMA_TRANSCRIPTION_CONCURRENCY);
    expect(OLLAMA_TRANSCRIPTION_CONCURRENCY).toBe(2);
  });

  it("posts the window to /api/chat at the base URL", async () => {
    const ollama = fakeOllama(() => chat("hello there"));
    await engine(ollama.fetchFn, { language: "de" }).transcribe(silence(1));
    const [call] = ollama.chats();
    expect(call?.url).toBe(`${BASE}/api/chat`);
    expect(call?.body).toMatchObject({ model: MODEL, stream: false, options: { num_predict: 48 } });
    expect((call?.body as unknown as ChatRequest).messages[1]?.content).toBe("language German<asr_text>");
  });

  it("turns a window's reply into one span that covers the window", async () => {
    const e = engine(fakeOllama(() => chat("language English<asr_text>  hello there ")).fetchFn);
    expect(await e.transcribe(silence(4))).toEqual([{ text: "hello there", startSec: 0, endSec: 4 }]);
  });

  it("returns no span for a window with no words", async () => {
    expect(await engine(fakeOllama(() => chat(" ")).fetchFn).transcribe(silence(4))).toEqual([]);
  });

  it("checks the model on load, and sends no audio to do it", async () => {
    const ollama = fakeOllama(() => chat(""));
    await engine(ollama.fetchFn).load();
    expect(ollama.requests).toEqual([
      { url: `${BASE}/api/show`, body: { model: MODEL }, signal: expect.any(AbortSignal) },
    ]);
  });

  it("refuses to load a model that cannot take audio", async () => {
    const ollama = fakeOllama(() => chat(""), () => json({ capabilities: ["completion"] }));
    const load = engine(ollama.fetchFn).load();
    await expect(load).rejects.toBeInstanceOf(OllamaFailure);
    await expect(load).rejects.toMatchObject({ kind: "model" });
  });

  it("says to pull the model when Ollama does not have it", async () => {
    const ollama = fakeOllama(() => chat(""), () => json({ error: `model '${MODEL}' not found` }, 404));
    await expect(engine(ollama.fetchFn).load()).rejects.toThrow(`run ollama pull ${MODEL}`);
  });

  it("names OLLAMA_ORIGINS when Ollama refuses the extension", async () => {
    const ollama = fakeOllama(() => new Response("", { status: 403 }));
    const call = engine(ollama.fetchFn).transcribe(silence(1));
    await expect(call).rejects.toMatchObject({ kind: "origin" });
    await expect(call).rejects.toThrow(/OLLAMA_ORIGINS/);
  });

  it("says Ollama is not running when nothing answers at the base URL", async () => {
    const refused = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    const call = engine(refused).transcribe(silence(1));
    await expect(call).rejects.toMatchObject({ kind: "connection" });
    await expect(call).rejects.toThrow(`Ollama is not running at ${BASE}`);
  });

  it("calls a reply that is not JSON a format failure", async () => {
    const call = engine(fakeOllama(() => new Response("<html>")).fetchFn).transcribe(silence(1));
    await expect(call).rejects.toMatchObject({ kind: "format" });
  });

  it("gives up after its timeout, as a failure to hold", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as unknown as typeof fetch;
    const call = engine(hang, { timeoutMs: 20 }).transcribe(silence(1));
    await expect(call).rejects.toBeInstanceOf(OllamaFailure);
    await expect(call).rejects.toThrow(/no response after/);
  });

  it("hands the request a signal that the user's cancel aborts", async () => {
    let seen: AbortSignal | undefined;
    const hang = ((_url: string, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    }) as unknown as typeof fetch;
    const user = new AbortController();
    const call = engine(hang).transcribe(silence(1), user.signal);
    user.abort();
    await expect(call).rejects.toBeDefined();
    await expect(call).rejects.not.toBeInstanceOf(OllamaFailure);
    expect(seen?.aborted).toBe(true);
  });

  it("reaches the wrapper as a cancel, not a failure, when the user skips the wait", async () => {
    const user = new AbortController();
    const ollama = fakeOllama(
      () =>
        new Promise<Response>((_resolve, reject) => {
          const signal = ollama.chats().at(-1)?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason));
          queueMicrotask(() => user.abort());
        }),
    );
    const decode: DecodeAudio = () => Promise.resolve({ samples: sound(3), sampleRate: RATE });
    const provider = createTranscriptionProvider({ name: "ollama", engine: engine(ollama.fetchFn), decode });
    await expect(
      provider.transcribe({ spans: [{ data: new Blob(), startOffsetMs: 0 }] }, { signal: user.signal }),
    ).rejects.toBeInstanceOf(TranscriptionCancelled);
  });
});

describe("what the user is told", () => {
  it("names the engine, and says it does not upload", () => {
    expect(TRANSCRIPTION_ENGINE_NAMES.ollama).toBe("local Ollama");
    expect(uploadsAudio("ollama")).toBe(false);
    expect(uploadDestination("ollama")).toBe("local Ollama");
  });

  it("reports a test that got an answer without quoting it", () => {
    expect(ollamaTestReport({ ok: true, text: "嗯。" })).toBe("Ollama answered, with a model that takes audio.");
  });

  it("reports a failed test by the part of the setup to check", () => {
    expect(ollamaTestReport({ ok: false, error: httpFailure(403, "", WHERE) })).toMatch(
      /^Allowed origins: Ollama refused this extension \(403\)/,
    );
    expect(ollamaTestReport({ ok: false, error: httpFailure(404, "", WHERE) })).toMatch(/^Model: model .* run ollama pull/);
    expect(ollamaTestReport({ ok: false, error: new Error("boom") })).toBe("Failed: boom");
  });
});

describe("the factory's Ollama checks", () => {
  const settings = (over: Partial<TranscriptionSettings["ollama"]> = {}): TranscriptionSettings => ({
    ...DEFAULT_SETTINGS.transcription,
    provider: "ollama",
    language: "de",
    ollama: { ...DEFAULT_SETTINGS.transcription.ollama, ...over },
  });
  const recording = { spans: [{ data: new Blob(), startOffsetMs: 0 }] };

  it("defaults to this computer's Ollama and the Qwen3-ASR build", () => {
    expect(DEFAULT_SETTINGS.transcription.ollama).toEqual({ baseUrl: BASE, model: MODEL });
  });

  it("holds the Recording when no base URL or model is configured", () => {
    expect(() => createTranscriptionProviderFor(settings({ model: "" }), { workerUrl: "w.js" })).toThrow(
      /no base URL or model configured/,
    );
  });

  it("holds the Recording before any upload when the base URL is not this computer", () => {
    const ollama = fakeOllama(() => chat(""));
    expect(() =>
      createTranscriptionProviderFor(settings({ baseUrl: "http://192.168.1.20:11434" }), {
        workerUrl: "w.js",
        fetchFn: ollama.fetchFn,
      }),
    ).toThrow(/is not this computer/);
    expect(ollama.requests).toHaveLength(0);
  });

  it("sends no window of a silent recording, and calls it silence, not a failure", async () => {
    const ollama = fakeOllama(() => chat("他被任命为驻华大使。"));
    const provider = createTranscriptionProviderFor(settings(), {
      workerUrl: "w.js",
      fetchFn: ollama.fetchFn,
      decode: () => Promise.resolve({ samples: silence(40), sampleRate: RATE }),
    });
    await expect(provider.transcribe(recording)).rejects.toBeInstanceOf(TranscriptionSilent);
    expect(ollama.chats()).toHaveLength(0);
  });

  it("transcribes through Ollama, in the Meeting Language", async () => {
    const ollama = fakeOllama(() => chat("guten Tag zusammen"));
    const provider = createTranscriptionProviderFor(settings(), {
      workerUrl: "w.js",
      fetchFn: ollama.fetchFn,
      decode: () => Promise.resolve({ samples: sound(5), sampleRate: RATE }),
    });
    expect(provider.name).toBe("ollama");
    const utterances = await provider.transcribe(recording);
    expect(utterances.map((u) => u.text)).toEqual(["guten Tag zusammen"]);
    expect(ollama.chats()).toHaveLength(1);
    expect((ollama.chats()[0]?.body as unknown as ChatRequest).messages[1]?.content).toBe(
      "language German<asr_text>",
    );
  });
});
