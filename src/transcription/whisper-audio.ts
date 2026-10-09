import type { MeetingLanguage } from "../domain/types";
import type { EngineSpan } from "./provider";
import {
  spansFromWhisperOutput,
  WHISPER_SAMPLE_RATE,
  whisperRunOptions,
  type WhisperOutput,
} from "./whisper-protocol";

const FRAME_SAMPLES = WHISPER_SAMPLE_RATE / 50; // 20 ms
// Skip only audio close to digital silence. A 17-minute Zoom test recording
// contained noise at about 0.000005 RMS; passing it to Whisper produced words.
// This floor is deliberately low so quiet speech still reaches the model.
const SILENCE_RMS = 0.00003;
const PADDING_SAMPLES = WHISPER_SAMPLE_RATE / 2;

export interface AudioRange {
  startSample: number;
  endSample: number;
}

export type WhisperInference = (
  samples: Float32Array,
  options: Record<string, unknown>,
) => Promise<WhisperOutput>;

/** Keep audio above the silence floor with half a second of context on either
 * side. Merge overlapping context so words are never inferred twice here. */
export function nonSilentAudioRanges(samples: Float32Array): AudioRange[] {
  const ranges: AudioRange[] = [];
  for (let start = 0; start < samples.length; start += FRAME_SAMPLES) {
    const end = Math.min(samples.length, start + FRAME_SAMPLES);
    let energy = 0;
    for (let index = start; index < end; index++) {
      const sample = samples[index] ?? 0;
      energy += sample * sample;
    }
    if (energy <= SILENCE_RMS * SILENCE_RMS * (end - start)) continue;

    const range = {
      startSample: Math.max(0, start - PADDING_SAMPLES),
      endSample: Math.min(samples.length, end + PADDING_SAMPLES),
    };
    const previous = ranges[ranges.length - 1];
    if (previous && range.startSample <= previous.endSample) {
      previous.endSample = range.endSample;
    } else {
      ranges.push(range);
    }
  }
  return ranges;
}

/** Measure the same retained ranges that Whisper will infer, including context. */
export function whisperInferenceDurationMs(samples: Float32Array): number {
  const sampleCount = nonSilentAudioRanges(samples).reduce(
    (total, range) => total + range.endSample - range.startSample,
    0,
  );
  return Math.round((sampleCount / WHISPER_SAMPLE_RATE) * 1000);
}

/** Infer each retained range separately and restore its position in the input
 * audio. Silence is not concatenated away from the meeting timeline. */
export async function transcribeWhisperAudio(
  samples: Float32Array,
  language: MeetingLanguage,
  run: WhisperInference,
): Promise<EngineSpan[]> {
  const result: EngineSpan[] = [];
  for (const range of nonSilentAudioRanges(samples)) {
    const audio = samples.subarray(range.startSample, range.endSample);
    const durationSec = audio.length / WHISPER_SAMPLE_RATE;
    const offsetSec = range.startSample / WHISPER_SAMPLE_RATE;
    const output = await run(audio, whisperRunOptions(language));
    for (const span of spansFromWhisperOutput(output, durationSec)) {
      const startSec = Math.min(durationSec, Math.max(0, span.startSec));
      const endSec = Math.min(durationSec, Math.max(startSec, span.endSec));
      result.push({ ...span, startSec: offsetSec + startSec, endSec: offsetSec + endSec });
    }
  }
  return result;
}
