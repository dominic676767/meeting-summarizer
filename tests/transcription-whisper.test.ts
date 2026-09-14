// Opt-in: the real Whisper model against a real recording.
//
//   WHISPER_INTEGRATION=1 npm test
//
// Skipped by default because it downloads the model (~40 MB for tiny) and takes
// far longer than a unit test. It is the only check that the words coming out of
// the engine are words at all — every other transcription test uses a fake
// engine, which cannot catch a wrong model id, a broken span mapping, or a
// sample rate the feature extractor rejects.
//
// The worker and its message plumbing stay outside this seam: they are browser
// glue, the same acknowledged gap as the recorder and the offscreen document.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createTranscriptionProvider,
  type EngineSpan,
  type TranscriptionEngine,
} from "../src/transcription/provider";
import {
  spansFromWhisperOutput,
  WHISPER_MODEL_REPOS,
  WHISPER_SAMPLE_RATE,
  type WhisperOutput,
} from "../src/transcription/whisper-protocol";
import { WHISPER_MAX_INPUT_MS } from "../src/transcription/local-whisper";

const FIXTURE = new URL("./fixtures/known-phrase.wav", import.meta.url);
const KNOWN_PHRASE = "ship the beta";

/** Minimal 16-bit PCM WAV reader: the fixture is committed in exactly this
 * form, so a full decoder would be more machinery than the test needs. */
function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sampleRate = 0;
  let offset = 12; // past "RIFF….WAVE"
  let data: DataView | undefined;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") sampleRate = view.getUint32(offset + 12, true);
    if (id === "data") data = new DataView(view.buffer, view.byteOffset + offset + 8, size);
    offset += 8 + size + (size % 2);
  }
  if (!data) throw new Error("fixture has no data chunk");
  const samples = new Float32Array(data.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.getInt16(i * 2, true) / 32_768;
  return { samples, sampleRate };
}

/** The same engine contract the offscreen document implements, backed by
 * transformers.js running in Node rather than in a worker. */
async function nodeWhisperEngine(): Promise<TranscriptionEngine> {
  const { pipeline } = await import("@huggingface/transformers");
  let asr:
    | ((samples: Float32Array, options: Record<string, unknown>) => Promise<WhisperOutput>)
    | undefined;
  return {
    name: "local-whisper",
    sampleRate: WHISPER_SAMPLE_RATE,
    maxInputMs: WHISPER_MAX_INPUT_MS,
    async load() {
      asr = (await pipeline("automatic-speech-recognition", WHISPER_MODEL_REPOS.tiny, {
        dtype: "q8",
      })) as unknown as typeof asr;
    },
    async transcribe(samples): Promise<EngineSpan[]> {
      if (!asr) throw new Error("model not loaded");
      const out = await asr(new Float32Array(samples), {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      });
      return spansFromWhisperOutput(out, samples.length / WHISPER_SAMPLE_RATE);
    },
  };
}

describe.skipIf(!process.env.WHISPER_INTEGRATION)("local Whisper, real model", () => {
  it("transcribes a short recording into Utterances containing the spoken phrase", async () => {
    const engine = await nodeWhisperEngine();
    const provider = createTranscriptionProvider({
      name: "local-whisper",
      engine,
      decode: async () => decodeWav(new Uint8Array(await readFile(FIXTURE))),
    });

    const utterances = await provider.transcribe({ data: new Blob(), startOffsetMs: 0 });

    expect(utterances.length).toBeGreaterThan(0);
    expect(utterances.map((u) => u.text).join(" ").toLowerCase()).toContain(KNOWN_PHRASE);
    // Timings are absolute ms from the Meeting start and ordered.
    expect(utterances[0]?.startMs).toBeGreaterThanOrEqual(0);
    for (const u of utterances) expect(u.endMs).toBeGreaterThanOrEqual(u.startMs);
    // Base Whisper performs no diarization, so no speaker is named.
    for (const u of utterances) expect(u.diarizationLabel).toBeUndefined();
  }, 600_000);
});
