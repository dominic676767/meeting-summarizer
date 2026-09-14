// The Transcription Provider abstraction: Audio Recording → Utterances.
//
// Not to be confused with Provider (Transcript → Summary). The two sets do not
// overlap — Claude and Bedrock-as-configured have no speech-to-text API at all
// (ADR-0004) — so they are separate interfaces with separate settings.
//
// Everything here is pure logic over injected parts: the engine that runs the
// model and the decoder that turns encoded audio into samples are both
// dependencies, so the provider's own behaviour (Utterance normalization,
// chunking, offset correction, progress, cancellation) is testable with no
// browser, no WASM, and no real audio.
import type { Utterance } from "../domain/types";

/** One Capture Span's audio, as the recorder wrote it. */
export interface RecordedSpan {
  /** The encoded audio for this span. */
  data: Blob;
  /**
   * ms from the Meeting start to this span's Capture Start. Utterance offsets are
   * absolute relative to the *Meeting* start, and recording begins whenever the
   * user clicked — which is usually after the Meeting began, and again after
   * every stretch they kept off the record.
   */
  startOffsetMs: number;
}

/**
 * An Audio Recording handed to a Transcription Provider: one Meeting's Capture
 * Spans, in Capture Start order.
 *
 * A list rather than one blob because stopping and resuming capture produces one
 * WebM container per span (ADR-0005). The gap between two spans is audio the user
 * chose not to record; nothing is invented to fill it.
 */
export interface AudioRecording {
  spans: RecordedSpan[];
}

export interface TranscriptionHooks {
  /**
   * The one-time model fetch. `totalBytes` is null while the engine has not
   * said how large the download is; never invent a figure it did not report.
   */
  onModelProgress?(loadedBytes: number, totalBytes: number | null): void;
  /** ms of audio transcribed so far, out of the recording's total. */
  onAudioProgress?(processedMs: number, totalMs: number): void;
  /** The user chose captions over waiting: stop at the next chunk boundary. */
  signal?: AbortSignal;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(recording: AudioRecording, hooks?: TranscriptionHooks): Promise<Utterance[]>;
}

/** Any transcription failure surfaces as this — the Held Recording path. */
export class TranscriptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TranscriptionError";
  }
}

/** The user skipped the wait. Distinct from failure: nothing went wrong, the
 * Meeting simply falls back to caption words (a Degraded Capture). */
export class TranscriptionCancelled extends TranscriptionError {
  constructor() {
    super("transcription cancelled");
    this.name = "TranscriptionCancelled";
  }
}

/** Mono samples at the rate the engine requires. */
export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

/** Encoded audio → mono samples resampled to `sampleRate`. */
export type DecodeAudio = (data: Blob, sampleRate: number) => Promise<DecodedAudio>;

/**
 * One timestamped span as an engine reports it: seconds from the start of the
 * samples the engine was given, which is why the provider — not the engine —
 * owns making the times absolute.
 */
export interface EngineSpan {
  text: string;
  startSec: number;
  endSec: number;
  /** Only engines that diarize set this. Base Whisper does not. */
  speaker?: string;
}

export interface TranscriptionEngine {
  readonly name: string;
  /** Sample rate the model expects (16 kHz for Whisper). */
  readonly sampleRate: number;
  /** Longest single input the engine accepts, ms. Longer recordings are chunked. */
  readonly maxInputMs: number;
  /** Fetch and initialise the model. Cached by the engine; called once per run. */
  load(onProgress?: (loadedBytes: number, totalBytes: number | null) => void): Promise<void>;
  transcribe(samples: Float32Array): Promise<EngineSpan[]>;
  /** Release engine resources (a worker, a session). Optional. */
  close?(): Promise<void> | void;
}

export interface TranscriptionProviderDeps {
  name: string;
  engine: TranscriptionEngine;
  decode: DecodeAudio;
}

function abortIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TranscriptionCancelled();
}

async function attempt<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof TranscriptionError) throw cause;
    throw new TranscriptionError(
      `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Builds a Transcription Provider from an engine and a decoder.
 *
 * Every Capture Span is transcribed in order and their Utterances concatenated.
 * A span longer than the engine's input limit is transcribed in windows of that
 * length, and each engine span is shifted by its window's position *plus its own
 * span's Capture Start*, so Utterance timings stay absolute relative to the
 * Meeting across both chunk and span boundaries. Fusion matches on those
 * timings, so an uncorrected offset would silently misattribute every word after
 * the first boundary.
 */
export function createTranscriptionProvider(
  deps: TranscriptionProviderDeps,
): TranscriptionProvider {
  const { engine, decode } = deps;
  return {
    name: deps.name,
    async transcribe(recording, hooks): Promise<Utterance[]> {
      abortIfCancelled(hooks?.signal);
      await attempt("model load failed", () => engine.load(hooks?.onModelProgress));

      // Every span is decoded before any is transcribed, so the progress total is
      // the Meeting's whole recorded audio instead of whichever span is in hand —
      // a total that grew span by span would read as the wait getting longer. This
      // costs no more memory than the single-file case did: the spans are the same
      // audio, minus what the user kept off the record.
      const decoded: { samples: Float32Array; sampleRate: number; startOffsetMs: number }[] = [];
      for (const span of recording.spans) {
        abortIfCancelled(hooks?.signal);
        const audio = await attempt("audio decode failed", () =>
          decode(span.data, engine.sampleRate),
        );
        decoded.push({ ...audio, startOffsetMs: span.startOffsetMs });
      }
      const totalMs = decoded.reduce((ms, d) => ms + msFor(d.samples.length, d.sampleRate), 0);

      const utterances: Utterance[] = [];
      let doneMs = 0;
      for (const { samples, sampleRate, startOffsetMs } of decoded) {
        const windowSamples = Math.max(1, Math.round((engine.maxInputMs / 1000) * sampleRate));
        for (let offset = 0; offset < samples.length; offset += windowSamples) {
          abortIfCancelled(hooks?.signal);
          const end = Math.min(offset + windowSamples, samples.length);
          // Absolute zero for this window: where the Meeting began, not where the
          // window did and not where this span's Capture Start was.
          const baseMs = startOffsetMs + msFor(offset, sampleRate);
          const spans = await attempt("engine failed", () =>
            engine.transcribe(samples.subarray(offset, end)),
          );
          for (const span of spans) {
            const utterance = toUtterance(span, baseMs);
            if (utterance) utterances.push(utterance);
          }
          // Progress counts audio transcribed, not Meeting time elapsed: the gap
          // between two spans was never recorded and is not work to be done.
          hooks?.onAudioProgress?.(doneMs + msFor(end, sampleRate), totalMs);
        }
        doneMs += msFor(samples.length, sampleRate);
      }
      return utterances;
    },
  };
}

function msFor(sampleCount: number, sampleRate: number): number {
  return Math.round((sampleCount / sampleRate) * 1000);
}

/** Engine span → Utterance, or null for a span with no words in it. */
function toUtterance(span: EngineSpan, baseMs: number): Utterance | null {
  const text = span.text.trim();
  if (text === "") return null;
  const startMs = Math.round(baseMs + span.startSec * 1000);
  const endMs = Math.round(baseMs + span.endSec * 1000);
  return {
    text,
    startMs,
    endMs: Math.max(startMs, endMs),
    ...(span.speaker ? { diarizationLabel: span.speaker } : {}),
  };
}
