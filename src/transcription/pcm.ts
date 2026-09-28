// Float samples → 16-bit little-endian PCM, the encoding both cloud engines
// upload. OpenAI's endpoint wants it inside a WAV container; Scribe takes it
// bare. Kept in one place so the two cannot drift on clamping or rounding.

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
