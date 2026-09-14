// The one cloud Transcription Provider: OpenAI's transcription endpoint, for the
// user who wants speed and maximum accuracy on a meeting that is not sensitive.
//
// Strictly opt-in. Choosing it uploads the meeting's audio, which is exactly
// what the local default exists to avoid, so nothing here is reachable without
// the user picking this engine and entering its own key.
//
// It is an engine behind the existing Transcription Provider interface, not a
// second pipeline: the same wrapper decodes, chunks, and makes offsets absolute,
// so this module only turns one window of samples into timed spans.
import { TranscriptionError, type EngineSpan, type TranscriptionEngine } from "./provider";

export type FetchFn = typeof fetch;

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

/** 16 kHz is what Whisper listens at, so a higher rate would upload bytes the
 * model discards. */
export const OPENAI_TRANSCRIPTION_SAMPLE_RATE = 16_000;

/**
 * The endpoint caps one upload at 25 MB. A window of 16-bit mono PCM at 16 kHz
 * costs 32 kB/s, so ten minutes is ~19 MB — inside the cap with room for the
 * container and the multipart framing. Longer recordings are chunked by the
 * provider wrapper, and this limit is deliberately far larger than local
 * Whisper's: an engine's input limit is its own.
 */
export const OPENAI_TRANSCRIPTION_MAX_INPUT_MS = 600_000;

/** The `verbose_json` response. Only `segments` carries the timings fusion needs. */
interface VerboseTranscription {
  text?: string;
  segments?: { start: number; end: number; text: string }[];
}

/**
 * 16-bit PCM WAV around raw samples.
 *
 * The endpoint takes a file, and the provider wrapper hands out decoded samples,
 * so one of the two has to encode. WAV is the cheapest correct container and
 * keeps the extension dependency-free.
 */
function toWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(clamped * 32_767), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Response → spans, times still relative to the window that was uploaded.
 *
 * A response with text but no segments still yields its words: dropping accurate
 * speech for want of a timestamp is the one outcome worse than coarse timings,
 * so the whole window becomes one span and fusion attributes it as best it can.
 */
export function spansFromTranscription(
  body: VerboseTranscription,
  durationSec: number,
): EngineSpan[] {
  if (body.segments?.length) {
    return body.segments.map((s) => ({ text: s.text, startSec: s.start, endSec: s.end }));
  }
  return body.text?.trim() ? [{ text: body.text, startSec: 0, endSec: durationSec }] : [];
}

export function createOpenAiTranscriptionEngine(opts: {
  apiKey: string;
  model: string;
  fetchFn?: FetchFn;
}): TranscriptionEngine {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    name: "openai",
    sampleRate: OPENAI_TRANSCRIPTION_SAMPLE_RATE,
    maxInputMs: OPENAI_TRANSCRIPTION_MAX_INPUT_MS,
    // Nothing to fetch or initialise: the model runs on OpenAI's machines, which
    // is the whole trade the user made by choosing this engine.
    load() {
      return Promise.resolve();
    },
    async transcribe(samples) {
      const durationSec = samples.length / OPENAI_TRANSCRIPTION_SAMPLE_RATE;
      const form = new FormData();
      form.append("file", toWav(samples, OPENAI_TRANSCRIPTION_SAMPLE_RATE), "meeting.wav");
      form.append("model", opts.model);
      // Segment timestamps are not a nicety here: fusion attributes speakers by
      // overlapping Utterance time ranges against the Speaker Track.
      form.append("response_format", "verbose_json");
      const res = await fetchFn(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}` },
        body: form,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new TranscriptionError(
          `openai transcription: HTTP ${res.status} ${detail.slice(0, 300)}`,
        );
      }
      return spansFromTranscription((await res.json()) as VerboseTranscription, durationSec);
    },
  };
}
