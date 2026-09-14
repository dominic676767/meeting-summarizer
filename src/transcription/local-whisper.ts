// The default Transcription Provider: local WASM Whisper. Nothing leaves the
// machine and no API key is needed (ADR-0004), which is what makes the public
// default configuration work.
//
// This module is the document-side half of the engine — it decodes the Audio
// Recording and talks to the worker that owns the WASM runtime. It runs in the
// offscreen document, the only extension context with both an AudioContext for
// decoding and the ability to spawn a worker.
import type { WhisperModelSize } from "../domain/types";
import {
  createTranscriptionProvider,
  TranscriptionError,
  type DecodedAudio,
  type EngineSpan,
  type TranscriptionEngine,
  type TranscriptionProvider,
} from "./provider";
import {
  WHISPER_SAMPLE_RATE,
  type WhisperRequest,
  type WhisperResponse,
} from "./whisper-protocol";

/** Whisper's own attention window is 30s; the engine handles longer input as
 * strided sub-windows internally. We still cap one call at two minutes of audio
 * so memory stays bounded and a skipped wait ends promptly. */
export const WHISPER_MAX_INPUT_MS = 120_000;

/**
 * Encoded audio → mono samples at `sampleRate`. `decodeAudioData` resamples to
 * its context's rate, so Whisper gets 16 kHz without a hand-written resampler.
 */
export async function decodeToMono(data: Blob, sampleRate: number): Promise<DecodedAudio> {
  const bytes = await data.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const buffer = await ctx.decodeAudioData(bytes);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const first = channels[0];
  if (!first) return { samples: new Float32Array(0), sampleRate };
  if (channels.length === 1) return { samples: first, sampleRate };
  const samples = new Float32Array(first.length);
  for (let i = 0; i < samples.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    samples[i] = sum / channels.length;
  }
  return { samples, sampleRate };
}

export function createLocalWhisperEngine(opts: {
  model: WhisperModelSize;
  workerUrl: string;
}): TranscriptionEngine {
  let worker: Worker | undefined;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve(spans: EngineSpan[]): void; reject(err: unknown): void }
  >();
  let loading: { resolve(): void; reject(err: unknown): void } | undefined;
  let onModelProgress: ((loaded: number, total: number | null) => void) | undefined;

  function failAll(err: unknown): void {
    loading?.reject(err);
    loading = undefined;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function handle(msg: WhisperResponse): void {
    if (msg.type === "model-progress") {
      onModelProgress?.(msg.loadedBytes, msg.totalBytes);
    } else if (msg.type === "loaded") {
      loading?.resolve();
      loading = undefined;
    } else if (msg.type === "spans") {
      pending.get(msg.id)?.resolve(msg.spans);
      pending.delete(msg.id);
    } else {
      const err = new TranscriptionError(`local Whisper: ${msg.message}`);
      if (msg.id === null) {
        loading?.reject(err);
        loading = undefined;
      } else {
        pending.get(msg.id)?.reject(err);
        pending.delete(msg.id);
      }
    }
  }

  function send(msg: WhisperRequest): void {
    worker?.postMessage(msg);
  }

  return {
    name: "local-whisper",
    sampleRate: WHISPER_SAMPLE_RATE,
    maxInputMs: WHISPER_MAX_INPUT_MS,
    load(progress) {
      onModelProgress = progress;
      return new Promise<void>((resolve, reject) => {
        loading = { resolve, reject };
        // Module worker: the ONNX runtime loads its WASM glue by dynamic import.
        worker = new Worker(opts.workerUrl, { type: "module" });
        worker.addEventListener("message", (e: MessageEvent<WhisperResponse>) => handle(e.data));
        worker.addEventListener("error", (e) =>
          failAll(new TranscriptionError(`local Whisper worker failed: ${e.message}`)),
        );
        send({ type: "load", model: opts.model });
      });
    },
    transcribe(samples) {
      const id = nextId++;
      return new Promise<EngineSpan[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // Copied because the buffer is a view onto the whole recording; the
        // worker must not receive (or detach) the rest of the audio.
        send({ type: "transcribe", id, samples: new Float32Array(samples) });
      });
    },
    close() {
      worker?.terminate();
      worker = undefined;
      // A terminated worker never replies, so nothing may be left waiting.
      failAll(new TranscriptionError("local Whisper stopped"));
    },
  };
}

/** The default Transcription Provider, ready to transcribe an Audio Recording. */
export function createLocalWhisperProvider(opts: {
  model: WhisperModelSize;
  workerUrl: string;
}): TranscriptionProvider & { close(): void } {
  const engine = createLocalWhisperEngine(opts);
  const provider = createTranscriptionProvider({
    name: "local-whisper",
    engine,
    decode: decodeToMono,
  });
  return {
    name: provider.name,
    transcribe: (recording, hooks) => provider.transcribe(recording, hooks),
    close: () => void engine.close?.(),
  };
}
