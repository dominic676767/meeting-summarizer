import { describe, expect, it, vi } from "vitest";
import { createTranscriptionProvider } from "../src/transcription/provider";
import {
  nonSilentAudioRanges,
  transcribeWhisperAudio,
  whisperInferenceDurationMs,
  type WhisperInference,
} from "../src/transcription/whisper-audio";
import { WHISPER_SAMPLE_RATE } from "../src/transcription/whisper-protocol";

function audio(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * WHISPER_SAMPLE_RATE));
}

function sound(samples: Float32Array, start: number, end: number, amplitude = 0.02): void {
  samples.fill(
    amplitude,
    Math.round(start * WHISPER_SAMPLE_RATE),
    Math.round(end * WHISPER_SAMPLE_RATE),
  );
}

describe("Whisper quiet-audio handling", () => {
  it("skips inference for digital silence and the measured Zoom background noise", async () => {
    const run = vi.fn<WhisperInference>();
    expect(await transcribeWhisperAudio(new Float32Array(), "en", run)).toEqual([]);
    expect(await transcribeWhisperAudio(audio(120), "en", run)).toEqual([]);
    const noise = audio(120);
    noise.fill(0.0000055);
    expect(await transcribeWhisperAudio(noise, "en", run)).toEqual([]);
    expect(whisperInferenceDurationMs(noise)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("retains very quiet audio above the floor without changing the model language", async () => {
    const samples = audio(2);
    sound(samples, 0.8, 1.2, 0.00004);
    const run = vi.fn<WhisperInference>().mockResolvedValue({ text: "A quiet reply." });

    expect(await transcribeWhisperAudio(samples, "ms", run)).toEqual([
      { text: "A quiet reply.", startSec: 0.3, endSec: 1.7 },
    ]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).toMatchObject({ language: "ms", return_timestamps: true });
    expect(run.mock.calls[0]?.[0].length).toBe(1.4 * WHISPER_SAMPLE_RATE);
  });

  it("merges overlapping context while keeping separate exchanges apart", () => {
    const samples = audio(10);
    sound(samples, 1, 1.6);
    sound(samples, 2.4, 2.8);
    sound(samples, 7, 7.4);

    expect(nonSilentAudioRanges(samples)).toEqual([
      { startSample: 0.5 * WHISPER_SAMPLE_RATE, endSample: 3.3 * WHISPER_SAMPLE_RATE },
      { startSample: 6.5 * WHISPER_SAMPLE_RATE, endSample: 7.9 * WHISPER_SAMPLE_RATE },
    ]);
    expect(whisperInferenceDurationMs(samples)).toBe(4_200);
  });

  it("keeps context within the recording and measures a partial final frame", () => {
    const samples = audio(1.01);
    sound(samples, 0, 0.02);
    sound(samples, 1, 1.01, 0.00004);

    expect(nonSilentAudioRanges(samples)).toEqual([
      { startSample: 0, endSample: samples.length },
    ]);
    expect(whisperInferenceDurationMs(samples)).toBe(1_010);
  });

  it("restores clip times and keeps words that were actually repeated", async () => {
    const samples = audio(10);
    sound(samples, 1, 1.6);
    sound(samples, 7, 7.4);
    const run = vi.fn<WhisperInference>().mockResolvedValue({
      chunks: [{ text: "Please repeat that.", timestamp: [0.5, 0.8] }],
    });

    expect(await transcribeWhisperAudio(samples, "en", run)).toEqual([
      { text: "Please repeat that.", startSec: 1, endSec: 1.3 },
      { text: "Please repeat that.", startSec: 7, endSec: 7.3 },
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("uses the clip duration for a missing end and bounds model timestamps to the clip", async () => {
    const samples = audio(5);
    sound(samples, 2, 2.4);
    const run = vi.fn<WhisperInference>().mockResolvedValue({
      chunks: [
        { text: "One.", timestamp: [-0.2, null] },
        { text: "Two.", timestamp: [1, 30] },
      ],
    });

    expect(await transcribeWhisperAudio(samples, "en", run)).toEqual([
      { text: "One.", startSec: 1.5, endSec: 2.9 },
      { text: "Two.", startSec: 2.5, endSec: 2.9 },
    ]);
  });

  it("keeps absolute meeting times across provider windows and capture pauses", async () => {
    const samples = audio(20);
    sound(samples, 18, 18.4);
    const run = vi.fn<WhisperInference>().mockResolvedValue({
      chunks: [{ text: "We should ship the beta next Friday.", timestamp: [0.5, 0.9] }],
    });
    const provider = createTranscriptionProvider({
      name: "local-whisper",
      engine: {
        name: "local-whisper",
        sampleRate: WHISPER_SAMPLE_RATE,
        maxInputMs: 8_000,
        load: async () => undefined,
        inferenceDurationMs: whisperInferenceDurationMs,
        transcribe: (window) => transcribeWhisperAudio(window, "en", run),
      },
      decode: async () => ({ samples, sampleRate: WHISPER_SAMPLE_RATE }),
    });

    const utterances = await provider.transcribe({
      spans: [{ data: new Blob(), startOffsetMs: 318_888 }],
    });
    expect(utterances).toEqual([
      {
        text: "We should ship the beta next Friday.",
        startMs: 336_888,
        endMs: 337_288,
      },
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("accepts a short Zoom sentence in a long quiet recording and preserves full progress", async () => {
    const samples = audio(1_024.14);
    samples.fill(0.0000055);
    sound(samples, 766.54, 768.82);
    const run = vi.fn<WhisperInference>().mockResolvedValue({
      chunks: [{ text: "We should ship the beta next Friday.", timestamp: [0.5, 2.4] }],
    });
    const progress = vi.fn();
    const provider = createTranscriptionProvider({
      name: "local-whisper",
      engine: {
        name: "local-whisper",
        sampleRate: WHISPER_SAMPLE_RATE,
        maxInputMs: 120_000,
        load: async () => undefined,
        inferenceDurationMs: whisperInferenceDurationMs,
        transcribe: (window) => transcribeWhisperAudio(window, "en", run),
      },
      decode: async () => ({ samples, sampleRate: WHISPER_SAMPLE_RATE }),
    });

    expect(await provider.transcribe(
      { spans: [{ data: new Blob(), startOffsetMs: 318_888 }] },
      { onAudioProgress: progress },
    )).toEqual([
      {
        text: "We should ship the beta next Friday.",
        startMs: 1_085_428,
        endMs: 1_087_328,
      },
    ]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].length).toBe(3.28 * WHISPER_SAMPLE_RATE);
    expect(progress).toHaveBeenLastCalledWith(1_024_140, 1_024_140);
  });
});
