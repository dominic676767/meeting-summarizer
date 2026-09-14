// Message protocol between the local Whisper engine (offscreen document) and
// the worker that owns the WASM runtime. Kept in its own module so the worker
// bundle — which pulls in the whole ONNX runtime — is never imported by any
// other entry point.
import type { WhisperModelSize } from "../domain/types";
import type { EngineSpan } from "./provider";

/** The rate Whisper's feature extractor expects. */
export const WHISPER_SAMPLE_RATE = 16_000;

/** Hub repositories for each user-selectable size, quantized for WASM. */
export const WHISPER_MODEL_REPOS: Record<WhisperModelSize, string> = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
};

export type WhisperRequest =
  | { type: "load"; model: WhisperModelSize }
  | { type: "transcribe"; id: number; samples: Float32Array };

/** The shape transformers.js returns for a timestamped transcription. */
export interface WhisperOutput {
  chunks?: { timestamp: [number, number | null]; text: string }[];
  text?: string;
}

/**
 * Whisper output → engine spans, times still relative to the samples given.
 * Kept out of the worker so the mapping can be exercised against a real model
 * without a browser.
 */
export function spansFromWhisperOutput(out: WhisperOutput, durationSec: number): EngineSpan[] {
  if (!out.chunks) {
    return out.text?.trim() ? [{ text: out.text, startSec: 0, endSec: durationSec }] : [];
  }
  return out.chunks.map((c) => ({
    text: c.text,
    startSec: c.timestamp[0] ?? 0,
    // The final chunk's end timestamp can be absent; the audio's own length is
    // the honest fallback.
    endSec: c.timestamp[1] ?? durationSec,
  }));
}

export type WhisperResponse =
  | { type: "model-progress"; loadedBytes: number; totalBytes: number | null }
  | { type: "loaded" }
  | { type: "spans"; id: number; spans: EngineSpan[] }
  | { type: "failed"; id: number | null; message: string };
