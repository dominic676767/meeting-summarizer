// Message protocol between the local Whisper engine (offscreen document) and
// the worker that owns the WASM runtime. Kept in its own module so the worker
// bundle — which pulls in the whole ONNX runtime — is never imported by any
// other entry point.
import type { MeetingLanguage, WhisperModelSize } from "../domain/types";
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
  | { type: "transcribe"; id: number; samples: Float32Array; language: MeetingLanguage };

/**
 * What one transcription call asks the model for. Kept out of the worker for the
 * same reason the span mapping below is: so it can be exercised without a
 * browser. The language especially — dropping it costs nothing visible at run
 * time, because a Meeting decoded as the wrong language comes back as fluent
 * words instead of as an error.
 */
export function whisperRunOptions(language: MeetingLanguage): Record<string, unknown> {
  return {
    // Whisper attends to 30s windows, so long-form runs as strided sub-windows
    // inside one call; the stride is what stops words being cut at a boundary.
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    // Always told, never inferred: transformers.js performs no detection and
    // falls back to English on its own.
    language,
  };
}

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
