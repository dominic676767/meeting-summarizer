// The evaluation harness reads clips as WAV and nothing else.
//
// In the extension, audio is decoded by the browser's AudioContext, which Node
// does not have. Rather than add a decoding dependency the harness takes the one
// format that needs no decoder: 16-bit PCM, already mono and already at the
// 16 kHz every engine here listens at. Anything else is refused with the command
// that converts it, so no resampler of ours ever stands between a clip and the
// numbers reported for it.

/** The rate every engine here decodes to, so the only rate a clip may have. */
export const EVAL_SAMPLE_RATE = 16_000;

/** The conversion the refusal names, and docs/evaluations/README.md documents. */
export const FFMPEG_CONVERSION = "ffmpeg -i <input> -ac 1 -ar 16000 -c:a pcm_s16le <clip>.wav";

export interface WavAudio {
  samples: Float32Array;
  sampleRate: number;
}

export class WavError extends Error {
  constructor(message: string) {
    super(`${message} — convert it with: ${FFMPEG_CONVERSION}`);
    this.name = "WavError";
  }
}

const PCM = 1;

/**
 * WAV bytes → samples in [-1, 1).
 *
 * Only 16-bit PCM, mono, 16 kHz. Chunks other than `fmt ` and `data` (ffmpeg
 * writes `LIST`) are skipped. A `data` size larger than the file — what a writer
 * streaming to a pipe leaves behind — is read up to the bytes actually present.
 */
export function parseWav(bytes: Uint8Array): WavAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
    throw new WavError("not a WAV file");
  }

  let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | undefined;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > view.byteLength) throw new WavError("truncated fmt chunk");
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) throw new WavError("data chunk before fmt chunk");
      if (format.audioFormat !== PCM) throw new WavError(`audio format ${format.audioFormat} is not PCM`);
      if (format.bits !== 16) throw new WavError(`${format.bits}-bit samples, not 16-bit`);
      if (format.channels !== 1) throw new WavError(`${format.channels} channels, not mono`);
      if (format.sampleRate !== EVAL_SAMPLE_RATE) {
        throw new WavError(`${format.sampleRate} Hz, not ${EVAL_SAMPLE_RATE} Hz`);
      }
      const available = Math.min(size, view.byteLength - body);
      const samples = new Float32Array(Math.floor(available / 2));
      for (let i = 0; i < samples.length; i++) {
        samples[i] = view.getInt16(body + i * 2, true) / 32_768;
      }
      return { samples, sampleRate: format.sampleRate };
    }
    // Chunks are padded to an even length.
    offset = body + size + (size % 2);
  }
  throw new WavError(format ? "no data chunk" : "no fmt chunk");
}

export function durationSec(audio: WavAudio): number {
  return audio.samples.length / audio.sampleRate;
}
