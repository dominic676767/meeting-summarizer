// Transcription Provider selection: the user's chosen engine, behind the one
// interface the rest of the extension knows about.
//
// Adding an engine is this switch plus a module — no pipeline change (ADR-0004).
// Selection is read at transcribe time rather than remembered, which is what lets
// a Held Recording be recovered by switching engine and retrying.
import type { TranscriptionSettings } from "../domain/types";
import { createElevenLabsTranscriptionEngine } from "./elevenlabs";
import { createLocalWhisperEngine, decodeToMono } from "./local-whisper";
import { createOpenAiTranscriptionEngine, type FetchFn } from "./openai";
import {
  createTranscriptionProvider,
  TranscriptionError,
  type DecodeAudio,
  type TranscriptionEngine,
  type TranscriptionProvider,
} from "./provider";

export interface TranscriptionDeps {
  /** URL of the WASM worker script. Only the local engine has one. */
  workerUrl: string;
  fetchFn?: FetchFn;
  decode?: DecodeAudio;
}

// The chosen language goes to whichever engine is selected: it describes the
// Meeting, so switching engine — including to recover a Held Recording — must not
// silently change which language the words are decoded as.
function engineFor(s: TranscriptionSettings, deps: TranscriptionDeps): TranscriptionEngine {
  switch (s.provider) {
    case "local-whisper":
      return createLocalWhisperEngine({
        model: s.localWhisper.model,
        language: s.language,
        workerUrl: deps.workerUrl,
      });
    case "openai":
      if (!s.openai.apiKey) {
        // A TranscriptionError, so the Audio Recording is held rather than lost:
        // the user can add the key and retry the Meeting.
        throw new TranscriptionError(
          "openai transcription: no API key configured — open Settings",
        );
      }
      return createOpenAiTranscriptionEngine({
        ...s.openai,
        language: s.language,
        fetchFn: deps.fetchFn,
      });
    case "elevenlabs":
      if (!s.elevenlabs.apiKey) {
        throw new TranscriptionError(
          "elevenlabs transcription: no API key configured — open Settings",
        );
      }
      return createElevenLabsTranscriptionEngine({
        ...s.elevenlabs,
        language: s.language,
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
  }
}

/**
 * The Transcription Provider for the user's current selection, ready to
 * transcribe an Audio Recording. `close` releases whatever the engine holds (the
 * local engine's worker); it is safe to call on any engine.
 */
export function createTranscriptionProviderFor(
  s: TranscriptionSettings,
  deps: TranscriptionDeps,
): TranscriptionProvider & { close(): void } {
  const engine = engineFor(s, deps);
  const provider = createTranscriptionProvider({
    name: engine.name,
    engine,
    decode: deps.decode ?? decodeToMono,
  });
  return {
    name: provider.name,
    transcribe: (recording, hooks) => provider.transcribe(recording, hooks),
    close: () => void engine.close?.(),
  };
}
