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
// The asyncify pair, which is what transformers.js itself selects on Chromium —
// served from the extension instead of its CDN default.
wasmBackend.wasmPaths = {
  wasm: assetUrl("ort/ort-wasm-simd-threaded.asyncify.wasm"),
  mjs: assetUrl("ort/ort-wasm-simd-threaded.asyncify.mjs"),
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

function load(size: WhisperModelSize): Promise<Asr> {
  asr ??= pipeline("automatic-speech-recognition", WHISPER_MODEL_REPOS[size], {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p: unknown) => {
      const e = p as { status?: string; file?: string; loaded?: number; total?: number };
      if (e.status !== "progress" || typeof e.file !== "string") return;
      reportModelProgress(e.file, e.loaded ?? 0, typeof e.total === "number" ? e.total : null);
    },
  }) as unknown as Promise<Asr>;
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
