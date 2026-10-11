// The Transcription Providers, run through the extension's own code path.
//
// Every engine is the one the extension ships, wrapped by the same
// createTranscriptionProvider, so chunking, offsets, part-labelling and the
// Silent Recording check are the product's and the numbers describe what a user
// gets. Only three things are the harness's own: the decoder, which reads a WAV
// where the extension has an AudioContext; local Whisper's host, which is
// transformers.js in Node where the extension has a worker running WASM; and
// local Ollama's caller, which is Node's fetch where the extension has the
// offscreen document's. What the last two change is written down in
// LOCAL_WHISPER_DIFFERENCES and OLLAMA_DIFFERENCES, and travels with every
// result.
import type { MeetingLanguage, TranscriptionProviderId, WhisperModelSize } from "../src/domain/types";
import { DEFAULT_SETTINGS } from "../src/settings";
import {
  createElevenLabsTranscriptionEngine,
  SCRIBE_MAX_INPUT_MS,
} from "../src/transcription/elevenlabs";
import { TRANSCRIPTION_ENGINE_NAMES, uploadsAudio } from "../src/transcription/engines";
import { WHISPER_MAX_INPUT_MS } from "../src/transcription/local-whisper";
import {
  chatRequest,
  createOllamaTranscriptionEngine,
  isLoopbackUrl,
  OLLAMA_TRANSCRIPTION_MAX_INPUT_MS,
  OLLAMA_TRANSCRIPTION_WINDOWING,
} from "../src/transcription/ollama";
import {
  createOpenAiTranscriptionEngine,
  OPENAI_TRANSCRIPTION_MAX_INPUT_MS,
  type FetchFn,
} from "../src/transcription/openai";
import {
  createTranscriptionProvider,
  type DecodeAudio,
  type EngineSpan,
  type TranscriptionEngine,
  type TranscriptionProvider,
} from "../src/transcription/provider";
import {
  createSageMakerTranscriptionEngine,
  SAGEMAKER_MAX_INPUT_MS,
  SAGEMAKER_WINDOWING,
} from "../src/transcription/sagemaker";
import {
  spansFromWhisperOutput,
  WHISPER_MODEL_REPOS,
  WHISPER_SAMPLE_RATE,
  whisperRunOptions,
  type WhisperOutput,
} from "../src/transcription/whisper-protocol";
import { parseWav } from "./wav";

export type EngineId = TranscriptionProviderId;

export const ENGINE_IDS: readonly EngineId[] = ["local-whisper", "openai", "elevenlabs", "sagemaker", "ollama"];

/**
 * The engines a run compares when it names none. SageMaker and Ollama are left
 * out, and a run asks for them by name. SageMaker needs an endpoint the user
 * deployed. Ollama needs the Ollama app running on this computer and a 2.5-GB
 * model pulled into it, which most machines that run the harness do not have:
 * in the default set it would add a failed row to every run that did not ask
 * for it.
 */
export const DEFAULT_ENGINE_IDS: readonly EngineId[] = ["local-whisper", "openai", "elevenlabs"];

/**
 * How local Whisper here differs from local Whisper in the extension. Every
 * difference is in the host, not the model: same repository, same q8 weights,
 * same session options, same run options, same span mapping. So its words are
 * comparable to the extension's; its speed is not.
 */
export const LOCAL_WHISPER_DIFFERENCES: readonly string[] = [
  "Runs on onnxruntime-node (native CPU, multi-threaded) rather than the extension's " +
    "onnxruntime-web (WASM, single-threaded); the two are also different ONNX Runtime " +
    "versions, so wall-clock time is not the extension's.",
  "Runs in the Node process rather than a dedicated worker in the offscreen document.",
  "The model is cached on disk in .eval/models rather than in the browser cache, so " +
    "the first run's load time includes the download.",
  "Audio is read from a 16 kHz mono WAV rather than decoded from the recorder's WebM " +
    "by an AudioContext, so compression loss in the extension's recording is not measured.",
];

/** Which keys each cloud engine reads, and from where: the environment only. */
export const KEY_ENV: Partial<Record<EngineId, string>> = {
  openai: "OPENAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
};

/**
 * What the SageMaker engine reads, also from the environment only: the AWS CLI's
 * own variable names, so `aws configure export-credentials --format env` sets
 * the credentials, plus where the endpoint is.
 */
export const SAGEMAKER_ENV = {
  accessKeyId: "AWS_ACCESS_KEY_ID",
  secretAccessKey: "AWS_SECRET_ACCESS_KEY",
  sessionToken: "AWS_SESSION_TOKEN",
  region: "AWS_REGION",
  endpointName: "SAGEMAKER_ENDPOINT",
} as const;

export type SageMakerConfig = Record<keyof typeof SAGEMAKER_ENV, string>;

/** The SageMaker settings from `env`, or the variables that are not set. */
export function sageMakerFromEnv(
  env: Record<string, string | undefined>,
): { ok: true; config: SageMakerConfig } | { ok: false; missing: string[] } {
  const entries = Object.entries(SAGEMAKER_ENV) as [keyof SageMakerConfig, string][];
  const missing = entries.filter(([, variable]) => !env[variable]).map(([, variable]) => variable);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: Object.fromEntries(
      entries.map(([field, variable]) => [field, env[variable] ?? ""]),
    ) as SageMakerConfig,
  };
}

/**
 * What the Ollama engine reads, also from the environment only. Not Ollama's own
 * OLLAMA_HOST: that is the address the Ollama server binds to (often 0.0.0.0, or
 * a bare host:port), not a URL to send to.
 */
export const OLLAMA_ENV = {
  baseUrl: "OLLAMA_BASE_URL",
  model: "OLLAMA_TRANSCRIPTION_MODEL",
} as const;

export type OllamaConfig = Record<keyof typeof OLLAMA_ENV, string>;

/**
 * The Ollama settings from `env`, each defaulting to the extension's own
 * default, or why they cannot be used. The base URL must be this computer, as
 * the extension's factory demands: the engine counts as one that does not
 * upload, so it is not billed and needs no --yes, and a remote host would make
 * that untrue.
 */
export function ollamaFromEnv(
  env: Record<string, string | undefined>,
): { ok: true; config: OllamaConfig } | { ok: false; problem: string } {
  const defaults = DEFAULT_SETTINGS.transcription.ollama;
  const config: OllamaConfig = {
    baseUrl: env[OLLAMA_ENV.baseUrl]?.trim() || defaults.baseUrl,
    model: env[OLLAMA_ENV.model]?.trim() || defaults.model,
  };
  if (!isLoopbackUrl(config.baseUrl)) {
    return {
      ok: false,
      problem: `${OLLAMA_ENV.baseUrl} ${config.baseUrl} is not this computer — use http://localhost:11434, or leave it unset`,
    };
  }
  return { ok: true, config };
}

/**
 * How local Ollama here differs from local Ollama in the extension. The server,
 * the model, the requests and the windows are the extension's; the caller and
 * the clock are not. So its words are comparable to the extension's, and so is
 * its speed once the model is in memory.
 */
export const OLLAMA_DIFFERENCES: readonly string[] = [
  "Calls come from Node's fetch rather than the extension's offscreen document. Node " +
    "sends no Origin header, so Ollama's OLLAMA_ORIGINS check is not exercised: a run " +
    "here that succeeds does not show that Ollama allows the extension.",
  "The harness has Ollama load the model, with the engine's own context size, before " +
    "the clock starts, and reports that as Load. The extension's first window of a " +
    "meeting pays that load when the model is not already in memory.",
  "The base URL and model come from OLLAMA_BASE_URL and OLLAMA_TRANSCRIPTION_MODEL, " +
    "or the extension's defaults, rather than from Settings.",
];

export interface EngineInfo {
  id: EngineId;
  /** What the product calls it, from the one Record every surface reads. */
  name: string;
  model: string;
  uploads: boolean;
  diarizes: boolean;
  maxInputMs: number;
  /**
   * The window the engine is usually sent, where that is shorter than its input
   * limit: SageMaker's windows are cut at pauses, about 10 s apart.
   */
  windowMs?: number;
}

export function engineInfo(
  id: EngineId,
  whisperModel: WhisperModelSize,
  ollamaModel: string = DEFAULT_SETTINGS.transcription.ollama.model,
): EngineInfo {
  const t = DEFAULT_SETTINGS.transcription;
  const shared = { id, name: TRANSCRIPTION_ENGINE_NAMES[id], uploads: uploadsAudio(id) };
  switch (id) {
    case "local-whisper":
      return {
        ...shared,
        model: WHISPER_MODEL_REPOS[whisperModel],
        diarizes: false,
        maxInputMs: WHISPER_MAX_INPUT_MS,
      };
    case "openai":
      return {
        ...shared,
        model: t.openai.model,
        diarizes: false,
        maxInputMs: OPENAI_TRANSCRIPTION_MAX_INPUT_MS,
      };
    case "elevenlabs":
      return {
        ...shared,
        model: t.elevenlabs.model,
        diarizes: true,
        maxInputMs: SCRIBE_MAX_INPUT_MS,
      };
    case "sagemaker":
      return {
        ...shared,
        model: "Qwen3-ASR",
        diarizes: false,
        maxInputMs: SAGEMAKER_MAX_INPUT_MS,
        windowMs: SAGEMAKER_WINDOWING.targetMs,
      };
    case "ollama":
      return {
        ...shared,
        model: ollamaModel,
        diarizes: false,
        maxInputMs: OLLAMA_TRANSCRIPTION_MAX_INPUT_MS,
        windowMs: OLLAMA_TRANSCRIPTION_WINDOWING.targetMs,
      };
  }
}

/** The extension's SageMaker engine, pointed at the endpoint the environment names. */
export function createSageMakerEngine(
  config: SageMakerConfig,
  language: MeetingLanguage,
): TranscriptionEngine {
  return createSageMakerTranscriptionEngine({
    region: config.region,
    endpointName: config.endpointName,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
    },
    language,
  });
}

/**
 * The extension's Ollama engine, pointed at the server the environment names,
 * and a load that is the harness's own. The load is the engine's own check
 * first (Ollama is running, the model is pulled, takes audio and runs on this
 * computer), so its failures read as the extension's do. Then Ollama is asked to
 * put the model in memory with the context size the engine's calls ask for: with
 * any other size, Ollama would load it again on the first call. The load
 * returns Ollama's version, which changes what a run measures.
 */
export function createNodeOllama(config: OllamaConfig, fetchFn: FetchFn = fetch) {
  const base = config.baseUrl.trim().replace(/\/+$/, "");
  const engineFor = (language: MeetingLanguage): TranscriptionEngine =>
    createOllamaTranscriptionEngine({ ...config, language, fetchFn });
  return {
    engineFor,
    async load(): Promise<{ version: string }> {
      await engineFor("en").load();
      const { num_ctx } = chatRequest({ model: config.model, samples: new Float32Array(0), language: "en" }).options;
      const res = await fetchFn(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: config.model, options: { num_ctx } }),
      });
      if (!res.ok) {
        throw new Error(`Ollama could not load ${config.model} (${res.status}): ${(await res.text()).slice(0, 300)}`);
      }
      const version = await fetchFn(`${base}/api/version`)
        .then((r) => r.json() as Promise<{ version?: unknown }>)
        .then((v) => (typeof v.version === "string" ? v.version : "unknown"))
        .catch(() => "unknown");
      return { version };
    },
  };
}

type Asr = (samples: Float32Array, options: Record<string, unknown>) => Promise<WhisperOutput>;

/**
 * Local Whisper with the worker's model and settings, in Node. One model load
 * serves every clip: the language is a decode-time choice, passed per call just
 * as the worker receives it per request. `cacheDir` is .eval/models, git-ignored.
 */
export function createNodeWhisper(size: WhisperModelSize, cacheDir: string) {
  let asr: Promise<Asr> | undefined;
  const load = () => {
    asr ??= (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = cacheDir;
      // The worker's options exactly; see whisper-worker.ts for why the graph
      // optimizer is off. `device` is left to the Node default, the CPU backend:
      // the worker's "wasm" is a browser backend.
      return (await pipeline("automatic-speech-recognition", WHISPER_MODEL_REPOS[size], {
        dtype: "q8",
        session_options: { graphOptimizationLevel: "disabled" },
      })) as unknown as Asr;
    })();
    return asr.then(() => undefined);
  };
  return {
    load,
    engineFor(language: MeetingLanguage): TranscriptionEngine {
      return {
        name: "local-whisper",
        sampleRate: WHISPER_SAMPLE_RATE,
        maxInputMs: WHISPER_MAX_INPUT_MS,
        load,
        async transcribe(samples): Promise<EngineSpan[]> {
          const run = await asr;
          if (!run) throw new Error("model not loaded");
          const out = await run(new Float32Array(samples), whisperRunOptions(language));
          return spansFromWhisperOutput(out, samples.length / WHISPER_SAMPLE_RATE);
        },
      };
    },
  };
}

export function createCloudEngine(
  id: "openai" | "elevenlabs",
  apiKey: string,
  language: MeetingLanguage,
): TranscriptionEngine {
  const t = DEFAULT_SETTINGS.transcription;
  return id === "openai"
    ? createOpenAiTranscriptionEngine({ apiKey, model: t.openai.model, language })
    : createElevenLabsTranscriptionEngine({ apiKey, model: t.elevenlabs.model, language });
}

/**
 * The clip's WAV as the decoder the provider wrapper calls. The Blob handed to
 * the wrapper is the file itself, so the wrapper reads the clip the way it reads
 * a Capture Span. No engine is ever resampled for: a rate other than the
 * engine's is refused.
 */
export const decodeWav: DecodeAudio = async (data, sampleRate) => {
  const audio = parseWav(new Uint8Array(await data.arrayBuffer()));
  if (audio.sampleRate !== sampleRate) {
    throw new Error(`clip is ${audio.sampleRate} Hz but the engine needs ${sampleRate} Hz`);
  }
  return audio;
};

export function providerFor(engine: TranscriptionEngine): TranscriptionProvider {
  return createTranscriptionProvider({ name: engine.name, engine, decode: decodeWav });
}

/**
 * `message` with every key replaced. The engines put the response body in their
 * errors, and an endpoint that rejects a key may quote part of it back.
 */
export function redactKeys(message: string, keys: readonly string[]): string {
  return keys.filter((k) => k.length > 0).reduce((m, k) => m.split(k).join("[redacted]"), message);
}
