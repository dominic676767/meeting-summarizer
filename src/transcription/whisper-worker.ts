// Local WASM Whisper, in a dedicated worker.
//
// Why a worker: transcribing an hour of audio occupies a thread for minutes.
// Off the document's thread, the popup keeps rendering progress and the browser
// UI never freezes — the whole point of reporting progress at all.
//
// The ONNX runtime's WASM binary ships inside the extension rather than being
// fetched from a CDN: remote code is both a store-policy violation and a second
// download every user would pay for. Only the model itself comes from the
// network, once, into the browser cache.
import { env, pipeline } from "@huggingface/transformers";
import type { MeetingLanguage, WhisperModelSize } from "../domain/types";
import {
  spansFromWhisperOutput,
  WHISPER_MODEL_REPOS,
  WHISPER_SAMPLE_RATE,
  whisperRunOptions,
  type WhisperOutput,
  type WhisperRequest,
  type WhisperResponse,
} from "./whisper-protocol";
import type { EngineSpan } from "./provider";

/** Extension-relative URL, resolved without the chrome namespace: workers get
 * the extension origin from their own location, which keeps this file free of
 * any dependency on extension APIs. */
function assetUrl(path: string): string {
  return new URL(path, self.location.href).href;
}

env.allowLocalModels = false;
// The browser cache is what makes the download one-time: the model files are
// keyed by URL, so the second meeting finds them already there.
env.useBrowserCache = true;
// Not the WASM cache, though: it exists to avoid re-fetching the runtime from a
// CDN, and ours ships inside the extension. Left on, it serves the runtime's
// loader from a blob: URL, which MV3's page CSP will not execute.
env.useWasmCache = false;

const wasmBackend = env.backends.onnx.wasm as {
  wasmPaths?: { wasm: string; mjs: string };
  numThreads?: number;
  proxy?: boolean;
};
// Served from the extension instead of transformers.js's CDN default, and the
// plain pair rather than the asyncify one: asyncify instruments the whole module
// so it can suspend WASM execution, which is needed only for the proxy worker
// and for the WebGPU/JSEP backends. This runs single-threaded CPU WASM with
// proxy off (both set below), so nothing here suspends — and asyncify costs
// 23.6 MB against 12.9 MB for the same inference (ADR-0006).
wasmBackend.wasmPaths = {
  wasm: assetUrl("ort/ort-wasm-simd-threaded.wasm"),
  mjs: assetUrl("ort/ort-wasm-simd-threaded.mjs"),
};
// Extension pages are not cross-origin isolated, so SharedArrayBuffer — and
// with it ONNX's threaded mode — is unavailable. Ask for one thread rather
// than let the runtime fail on a missing SharedArrayBuffer.
wasmBackend.numThreads = 1;
// No proxy worker: this *is* the worker.
wasmBackend.proxy = false;

function post(message: WhisperResponse): void {
  self.postMessage(message);
}

/** Bytes reported per file, summed — the engine's own numbers, never a guess. */
const downloaded = new Map<string, { loaded: number; total: number | null }>();

function reportModelProgress(file: string, loaded: number, total: number | null): void {
  downloaded.set(file, { loaded, total });
  let loadedBytes = 0;
  let totalBytes: number | null = 0;
  for (const entry of downloaded.values()) {
    loadedBytes += entry.loaded;
    if (entry.total === null) totalBytes = null;
    else if (totalBytes !== null) totalBytes += entry.total;
  }
  post({ type: "model-progress", loadedBytes, totalBytes });
}

type Asr = (samples: Float32Array, options: Record<string, unknown>) => Promise<WhisperOutput>;

let asr: Promise<Asr> | undefined;

/**
 * Quantized first, unquantized as the fallback. `q8` is a quarter the download
 * and the reason a local engine is usable at all, but its quantized decoder is
 * rejected outright by some ONNX Runtime versions — observed as "Can't create a
 * session … TransposeDQWeightsForMatMulNBits Missing required scale". That is a
 * hard failure at load, not degraded output, so there is no risk in trying the
 * small one first: either it creates a session or it does not.
 *
 * `fp32` is several times the download and slower, so it is never chosen when
 * `q8` works, and the user is told which one ran rather than left wondering why
 * the first meeting downloaded far more than the settings page said.
 */
const DTYPES = ["q8", "fp32"] as const;

function loadWith(size: WhisperModelSize, dtype: (typeof DTYPES)[number]): Promise<Asr> {
  return pipeline("automatic-speech-recognition", WHISPER_MODEL_REPOS[size], {
    dtype,
    device: "wasm",
    progress_callback: (p: unknown) => {
      const e = p as { status?: string; file?: string; loaded?: number; total?: number };
      if (e.status !== "progress" || typeof e.file !== "string") return;
      reportModelProgress(e.file, e.loaded ?? 0, typeof e.total === "number" ? e.total : null);
    },
  }) as unknown as Promise<Asr>;
}

function load(size: WhisperModelSize): Promise<Asr> {
  // Not `??=` alone: a rejected promise cached here would fail every retry for
  // the life of the worker, so a failed load is forgotten rather than memoized.
  asr ??= (async () => {
    let lastError: unknown;
    for (const dtype of DTYPES) {
      try {
        const loaded = await loadWith(size, dtype);
        if (dtype !== DTYPES[0]) {
          console.warn(`meeting-summarizer: ${DTYPES[0]} model unusable, fell back to ${dtype}`);
        }
        return loaded;
      } catch (err) {
        lastError = err;
        console.warn(`meeting-summarizer: ${dtype} whisper model failed to load`, err);
      }
    }
    throw lastError;
  })().catch((err) => {
    asr = undefined;
    throw err;
  });
  return asr;
}

async function transcribe(samples: Float32Array, language: MeetingLanguage): Promise<EngineSpan[]> {
  const run = await asr;
  if (!run) throw new Error("model not loaded");
  const out = await run(samples, whisperRunOptions(language));
  return spansFromWhisperOutput(out, samples.length / WHISPER_SAMPLE_RATE);
}

self.addEventListener("message", (event: MessageEvent<WhisperRequest>) => {
  const msg = event.data;
  void (async () => {
    try {
      if (msg.type === "load") {
        await load(msg.model);
        post({ type: "loaded" });
      } else {
        post({ type: "spans", id: msg.id, spans: await transcribe(msg.samples, msg.language) });
      }
    } catch (err) {
      post({
        type: "failed",
        id: msg.type === "transcribe" ? msg.id : null,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});
