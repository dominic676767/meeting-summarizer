// The evaluation harness's WAV reader: the one format it accepts, and a refusal
// naming the conversion for every other.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { durationSec, FFMPEG_CONVERSION, parseWav, WavError } from "../eval/wav";

/** A WAV built by hand, so each test states the one field it gets wrong. */
function wav(opts: {
  samples?: number[];
  sampleRate?: number;
  channels?: number;
  bits?: number;
  audioFormat?: number;
  extraChunk?: boolean;
  dataSize?: number;
}): Uint8Array {
  const samples = opts.samples ?? [0, 16_384, -32_768, 32_767];
  const extra = opts.extraChunk ? 8 + 3 + 1 : 0; // a 3-byte LIST chunk, padded
  const buffer = new ArrayBuffer(12 + 24 + extra + 8 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, opts.audioFormat ?? 1, true);
  view.setUint16(22, opts.channels ?? 1, true);
  view.setUint32(24, opts.sampleRate ?? 16_000, true);
  view.setUint16(34, opts.bits ?? 16, true);
  let offset = 36;
  if (opts.extraChunk) {
    ascii(offset, "LIST");
    view.setUint32(offset + 4, 3, true);
    offset += 12;
  }
  ascii(offset, "data");
  view.setUint32(offset + 4, opts.dataSize ?? samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(offset + 8 + i * 2, s, true));
  return new Uint8Array(buffer);
}

describe("parseWav", () => {
  it("reads 16-bit mono 16 kHz PCM as samples in [-1, 1)", () => {
    const audio = parseWav(wav({}));
    expect(audio.sampleRate).toBe(16_000);
    expect(Array.from(audio.samples)).toEqual([0, 0.5, -1, 32_767 / 32_768]);
  });

  it("skips chunks it does not read, including their padding byte", () => {
    expect(Array.from(parseWav(wav({ extraChunk: true })).samples)).toHaveLength(4);
  });

  it("reads a data chunk whose declared size overruns the file up to the bytes present", () => {
    expect(parseWav(wav({ dataSize: 0xffff_ffff })).samples).toHaveLength(4);
  });

  it("reads the committed fixture, which was written by a different tool", async () => {
    const audio = parseWav(new Uint8Array(await readFile("tests/fixtures/known-phrase.wav")));
    expect(durationSec(audio)).toBeGreaterThan(1);
    expect(durationSec(audio)).toBeLessThan(5);
  });

  it.each([
    ["a stereo file", { channels: 2 }, "2 channels, not mono"],
    ["another sample rate", { sampleRate: 44_100 }, "44100 Hz, not 16000 Hz"],
    ["24-bit samples", { bits: 24 }, "24-bit samples, not 16-bit"],
    ["float samples", { audioFormat: 3 }, "audio format 3 is not PCM"],
  ])("refuses %s, naming the conversion rather than resampling", (_, opts, message) => {
    expect(() => parseWav(wav(opts))).toThrow(WavError);
    expect(() => parseWav(wav(opts))).toThrow(message);
    expect(() => parseWav(wav(opts))).toThrow(FFMPEG_CONVERSION);
  });

  it("refuses bytes that are not a WAV at all", () => {
    expect(() => parseWav(new TextEncoder().encode("ID3 not a wav file"))).toThrow("not a WAV file");
  });

  it("refuses a WAV with no data chunk", () => {
    const bytes = wav({});
    bytes.set(new TextEncoder().encode("junk"), 36);
    expect(() => parseWav(bytes)).toThrow("no data chunk");
  });
});
