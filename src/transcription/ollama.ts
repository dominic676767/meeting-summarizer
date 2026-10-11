// The second local Transcription Provider: Qwen3-ASR on this computer, served by
// the user's own Ollama (ADR-0011).
//
// Local like Whisper: the audio goes to Ollama on this machine and no further.
// That holds only while the base URL is this machine and the model runs here, so
// the factory refuses any other host, and `load` refuses a model that Ollama
// would run on its cloud.
//
// The model is the one the SageMaker engine runs, in a GGUF build, so the same
// shape follows. Qwen3-ASR returns text and no timestamps: this engine asks the
// wrapper for short windows cut at pauses, each window becomes one Utterance,
// and fusion takes its speaker from the captions.
//
// Ollama has no transcription route. The audio goes to `/api/chat` as a WAV in a
// message's `images`, where Ollama tells audio from pictures by the file's magic
// bytes, and the reply is the chat message the model writes.
//
// Two halves, as in the cloud engines. The request and the reading of the reply
// are pure and tested without a network (`chatRequest`, `textFromChat`,
// `modelProblem`, `httpFailure`). The engine around them only sends one window
// and hands back what came back.
import type { MeetingLanguage } from "../domain/types";
import type { FetchFn } from "./openai";
import type { PauseWindowing } from "./pauses";
import { wav16 } from "./pcm";
import { TranscriptionError, type EngineSpan, type TranscriptionEngine } from "./provider";

/** Qwen3-ASR listens at 16 kHz, like every engine here. */
export const OLLAMA_TRANSCRIPTION_SAMPLE_RATE = 16_000;

/**
 * Qwen3-ASR's clip length. Ollama does not split a long clip: past about a
 * minute it drops the end without a word (a 66-s clip lost about 11 s). 30 s is
 * well inside that, and is the clip length the SageMaker engine keeps to.
 */
export const OLLAMA_TRANSCRIPTION_MAX_INPUT_MS = 30_000;

/**
 * About 10 s per window, so that most windows hold one speaker: fusion gives a
 * text-only window one name.
 */
export const OLLAMA_TRANSCRIPTION_WINDOWING: PauseWindowing = {
  targetMs: 10_000,
  maxMs: OLLAMA_TRANSCRIPTION_MAX_INPUT_MS,
};

/** The GGUF build of Qwen3-ASR 1.7B that `ollama pull` fetches from Hugging Face. */
export const DEFAULT_OLLAMA_TRANSCRIPTION_MODEL = "hf.co/ggml-org/Qwen3-ASR-1.7B-GGUF:Q8_0";

/**
 * How long one call may take before it is given up on. The first call of a run
 * also loads the model (about 4 s on an M4 Pro), and a call can wait in Ollama's
 * queue behind the other one in flight. Giving up throws a TranscriptionError,
 * which holds the Recording for a retry.
 */
export const OLLAMA_TRANSCRIPTION_TIMEOUT_MS = 120_000;

/**
 * The reply's length cap, per second of audio and in all: the SageMaker
 * engine's numbers, for the same model. Speech runs at about 4–6 tokens a
 * second, so the cap never cuts real words. It exists for noise, which
 * Qwen3-ASR answers with invented sentences that could otherwise run on.
 */
export const MAX_TOKENS_PER_SECOND = 16;
export const MAX_TOKENS_BASE = 32;

/**
 * Windows in flight at once. Ollama runs one request at a time per model unless
 * OLLAMA_NUM_PARALLEL says otherwise, and queues the rest. Two keeps the model
 * busy: the next window's upload and decoding overlap the call in progress, and
 * a server with parallel slots runs both. More would only lengthen the queue that
 * each call's timeout has to cover, on a machine the user is also meeting on.
 */
export const OLLAMA_TRANSCRIPTION_CONCURRENCY = 2;

/** The context each call asks for: a 30-s window and its reply fit many times over. */
const NUM_CTX = 8_192;

/**
 * Each Meeting Language as Qwen3-ASR names it, or null for the three it does not
 * list. A Record over the type, so a new Meeting Language is a compile error
 * here until somebody checks Qwen's list.
 */
const QWEN3_ASR_LANGUAGE_NAMES: Record<MeetingLanguage, string | null> = {
  ar: "Arabic",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  fi: "Finnish",
  fr: "French",
  he: null,
  hi: "Hindi",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  ms: "Malay",
  nl: "Dutch",
  no: null,
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sv: "Swedish",
  th: "Thai",
  tr: "Turkish",
  uk: null,
  vi: "Vietnamese",
  zh: "Chinese",
};

/** The Meeting Languages that Qwen3-ASR does not list. It detects the language for these. */
export const UNLISTED_LANGUAGES: readonly MeetingLanguage[] = (
  Object.keys(QWEN3_ASR_LANGUAGE_NAMES) as MeetingLanguage[]
).filter((code) => QWEN3_ASR_LANGUAGE_NAMES[code] === null);

/** The tag between Qwen3-ASR's language line and the words. */
const ASR_TEXT = "<asr_text>";

/** Which part of the setup a failure points at. The Test button reports this. */
export type OllamaFailureKind = "connection" | "origin" | "model" | "format" | "other";

/** A TranscriptionError that also says which part of the setup failed. */
export class OllamaFailure extends TranscriptionError {
  readonly kind: OllamaFailureKind;
  constructor(kind: OllamaFailureKind, message: string, options?: { cause?: unknown }) {
    super(`ollama transcription: ${message}`, options);
    this.name = "OllamaFailure";
    this.kind = kind;
  }
}

/** Where the calls go, for the words of a failure. */
export interface OllamaWhere {
  baseUrl: string;
  model: string;
  /** This extension's origin, which OLLAMA_ORIGINS must allow. */
  origin: string;
}

/** One `/api/chat` call's body. */
export interface ChatRequest {
  model: string;
  stream: false;
  messages: (
    | { role: "user"; content: ""; images: [string] }
    | { role: "assistant"; content: string }
  )[];
  options: { temperature: 0; num_ctx: number; num_predict: number };
}

/**
 * One window as the `/api/chat` call that transcribes it.
 *
 * The prompt is empty: the audio is the whole question. For a Meeting Language
 * that Qwen3-ASR lists, the reply is begun for the model with its own language
 * line (`language English<asr_text>`), and Ollama continues a last assistant
 * message rather than starting a new one. That fixes the language the model
 * would otherwise guess in each window. It does not translate: speech in another
 * language still comes back in that language (ADR-0011). For the three it does
 * not list, the model guesses.
 */
export function chatRequest(opts: {
  model: string;
  samples: Float32Array;
  language: MeetingLanguage;
}): ChatRequest {
  const seconds = opts.samples.length / OLLAMA_TRANSCRIPTION_SAMPLE_RATE;
  const name = QWEN3_ASR_LANGUAGE_NAMES[opts.language];
  return {
    model: opts.model,
    stream: false,
    messages: [
      {
        role: "user",
        content: "",
        images: [base64(wav16(opts.samples, OLLAMA_TRANSCRIPTION_SAMPLE_RATE))],
      },
      ...(name === null ? [] : [{ role: "assistant" as const, content: `language ${name}${ASR_TEXT}` }]),
    ],
    options: {
      temperature: 0,
      num_ctx: NUM_CTX,
      num_predict: Math.ceil(seconds * MAX_TOKENS_PER_SECOND) + MAX_TOKENS_BASE,
    },
  };
}

/**
 * The reply → the window's text.
 *
 * Qwen3-ASR writes `language <name><asr_text><words>`. A reply that was begun
 * for it holds the words only. A language line with no tag after it, such as
 * `language None`, has no words in it. A reply with no message at all did not
 * come from a chat model, which is a setup problem, not silence.
 */
export function textFromChat(body: unknown): string {
  const content = (body as { message?: { content?: unknown } } | null)?.message?.content;
  if (typeof content !== "string") {
    throw new OllamaFailure(
      "format",
      `the reply has no message: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  const tag = content.indexOf(ASR_TEXT);
  if (tag >= 0) return content.slice(tag + ASR_TEXT.length).trim();
  return /^\s*language\s+\S+\s*$/.test(content) ? "" : content.trim();
}

/**
 * What `/api/show` says about the model → why it cannot transcribe here, or null
 * when it can. It must take audio, and it must run on this machine: a model that
 * Ollama serves from its cloud would upload the meeting under a consent that
 * says the audio stays here.
 */
export function modelProblem(show: unknown, model: string): string | null {
  const info = (typeof show === "object" && show !== null ? show : {}) as Record<string, unknown>;
  if (info["remote_host"] !== undefined || info["remote_model"] !== undefined) {
    return `model ${model} runs on Ollama's cloud, not on this computer — choose a local model such as ${DEFAULT_OLLAMA_TRANSCRIPTION_MODEL}`;
  }
  const capabilities = Array.isArray(info["capabilities"]) ? info["capabilities"] : [];
  if (!capabilities.includes("audio")) {
    return `model ${model} cannot take audio — choose a speech-to-text model such as ${DEFAULT_OLLAMA_TRANSCRIPTION_MODEL}`;
  }
  return null;
}

/**
 * A failed reply → what it means for the user, with the part of the setup to
 * check. Ollama's error is the body's `error`, or else the body as it came.
 */
export function httpFailure(status: number, body: string, where: OllamaWhere): OllamaFailure {
  let message = body;
  try {
    const parsed: unknown = JSON.parse(body);
    const error = (parsed as { error?: unknown } | null)?.error;
    if (typeof error === "string") message = error;
  } catch {
    // Not JSON: a bare 403 from Ollama's origin check has an empty body.
  }
  message = message.slice(0, 300);
  if (status === 403) {
    return new OllamaFailure(
      "origin",
      `Ollama refused this extension (403): OLLAMA_ORIGINS does not allow ${where.origin}. Run launchctl setenv OLLAMA_ORIGINS "${where.origin}", then quit and reopen Ollama`,
    );
  }
  if (status === 404) {
    return new OllamaFailure(
      "model",
      `model ${where.model} is not in Ollama at ${where.baseUrl} — run ollama pull ${where.model}`,
    );
  }
  return new OllamaFailure("other", `Ollama answered ${status}: ${message || "no message"}`);
}

/**
 * Whether a base URL is this computer. Only these hosts keep the promise that
 * the audio stays on the machine, and only these are in the manifest's host
 * permissions.
 */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

const TEST_LEADS: Record<OllamaFailureKind, string> = {
  connection: "Ollama",
  origin: "Allowed origins",
  model: "Model",
  format: "Reply format",
  other: "Failed",
};

/**
 * The Settings page's Test button report, from one call's outcome: which part of
 * the setup failed, in words the user can act on.
 */
export function ollamaTestReport(
  outcome: { ok: true; text: string } | { ok: false; error: unknown },
): string {
  // The words are not quoted: Qwen3-ASR answers the test's silence with words it
  // invents, and quoting them would read as a fault in a healthy setup.
  if (outcome.ok) return "Ollama answered, with a model that takes audio.";
  const { error } = outcome;
  if (!(error instanceof OllamaFailure)) {
    return `Failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return `${TEST_LEADS[error.kind]}: ${error.message.replace(/^ollama transcription: /, "")}.`;
}

/** The extension's own origin where there is one; tests and Node have none. */
function ownOrigin(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return origin?.startsWith("chrome-extension://") ? origin : "this extension's origin";
}

export function createOllamaTranscriptionEngine(opts: {
  baseUrl: string;
  model: string;
  /** The Meeting Language, begun for the model when Qwen3-ASR lists it. */
  language: MeetingLanguage;
  fetchFn?: FetchFn;
  /** Injected by tests; defaults to OLLAMA_TRANSCRIPTION_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injected by tests; defaults to the extension's own origin. */
  origin?: string;
}): TranscriptionEngine {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.trim().replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? OLLAMA_TRANSCRIPTION_TIMEOUT_MS;
  const where: OllamaWhere = { baseUrl: base, model: opts.model, origin: opts.origin ?? ownOrigin() };

  /** One POST to Ollama, its reply as JSON. Every failure is an OllamaFailure,
   * except a user's cancel, which is rethrown as it came. */
  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    let text: string;
    try {
      res = await fetchFn(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort,
      });
      text = await res.text();
    } catch (cause) {
      // The wrapper, which knows the signal was the user's, turns this into
      // TranscriptionCancelled.
      if (signal?.aborted) throw cause;
      if (timeout.aborted) {
        throw new OllamaFailure("other", `no response after ${Math.round(timeoutMs / 1000)} s`, {
          cause,
        });
      }
      // fetch rejects only when no reply came at all: nothing is listening.
      throw new OllamaFailure(
        "connection",
        `Ollama is not running at ${base} — open the Ollama app, then retry`,
        { cause },
      );
    }
    if (!res.ok) throw httpFailure(res.status, text, where);
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new OllamaFailure("format", `the reply is not JSON: ${text.slice(0, 200)}`, { cause });
    }
  }

  return {
    name: "ollama",
    sampleRate: OLLAMA_TRANSCRIPTION_SAMPLE_RATE,
    maxInputMs: OLLAMA_TRANSCRIPTION_MAX_INPUT_MS,
    windowing: OLLAMA_TRANSCRIPTION_WINDOWING,
    concurrency: OLLAMA_TRANSCRIPTION_CONCURRENCY,
    // Nothing to download: the user pulled the model. Asking Ollama about it
    // first finds a stopped Ollama, a refused origin, a missing model or one that
    // cannot take audio before any audio is decoded, and in words that say so.
    async load() {
      const problem = modelProblem(await post("/api/show", { model: opts.model }), opts.model);
      if (problem) throw new OllamaFailure("model", problem);
    },
    async transcribe(samples, signal): Promise<EngineSpan[]> {
      const durationSec = samples.length / OLLAMA_TRANSCRIPTION_SAMPLE_RATE;
      const reply = await post(
        "/api/chat",
        chatRequest({ model: opts.model, samples, language: opts.language }),
        signal,
      );
      const text = textFromChat(reply);
      // A window of silence has no words. Whether a whole recording was silence
      // is the wrapper's call, made once against its whole duration.
      return text === "" ? [] : [{ text, startSec: 0, endSec: durationSec }];
    },
  };
}

/** Bytes as base64, in slices: one call over a 1-MB WAV would overflow the stack. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
