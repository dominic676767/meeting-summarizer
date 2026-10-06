// Float samples → 16-bit little-endian PCM, the encoding every cloud engine
// uploads. OpenAI's endpoint and the SageMaker engine want it inside a WAV
// container; Scribe takes it bare. Kept in one place so the engines cannot drift
// on clamping, rounding or the WAV header.

/** Writes `samples` as 16-bit little-endian PCM into `view` from `offset`. */
export function writePcm16(view: DataView, offset: number, samples: Float32Array): void {
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset + i * 2, Math.round(clamped * 32_767), true);
  }
}

/** `samples` as a bare PCM buffer, no container. */
export function pcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  writePcm16(new DataView(buffer), 0, samples);
  return buffer;
}

/**
 * `samples` as a 16-bit mono PCM WAV file.
 *
 * An endpoint that takes a file needs a container, and the provider wrapper hands
 * out decoded samples, so the engine has to encode. WAV is the cheapest correct
 * container, and it needs no dependency.
 */
export function wav16(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
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
  writePcm16(view, 44, samples);
  return new Uint8Array(buffer);
}
