// Transcription Provider selection: the user's chosen engine, behind the one
// interface the rest of the extension knows about.
//
// Adding an engine is this switch plus a module — no pipeline change (ADR-0004).
// Selection is read at transcribe time rather than remembered, which is what lets
// a Held Recording be recovered by switching engine and retrying.
import type { TranscriptionSettings } from "../domain/types";
import { credentialsExpired, type AwsCredentials } from "./aws-credentials";
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
import { createSageMakerTranscriptionEngine, type InvokeFn } from "./sagemaker";

export interface TranscriptionDeps {
  /** URL of the WASM worker script. Only the local engine has one. */
  workerUrl: string;
  fetchFn?: FetchFn;
  decode?: DecodeAudio;
  /**
   * The SageMaker engine's temporary credentials, from session storage. Passed
   * in rather than kept in TranscriptionSettings, so they can never be saved to
   * disk along with the settings (ADR-0009).
   */
  awsCredentials?: AwsCredentials | null;
  /** Injected by tests in place of the SageMaker engine's signed fetch. */
  invoke?: InvokeFn;
  /** The time now, for the credentials' expiry. Injected by tests. */
  now?: number;
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
    case "sagemaker": {
      // Each of these is a TranscriptionError for the same reason as a missing
      // key above: the Audio Recording is held, and the user can fix the setup
      // and retry the Meeting.
      if (!s.sagemaker.endpointName || !s.sagemaker.region) {
        throw new TranscriptionError(
          "sagemaker transcription: no endpoint configured — open Settings",
        );
      }
      const credentials = deps.awsCredentials;
      if (!credentials) {
        throw new TranscriptionError(
          "sagemaker transcription: no AWS credentials — paste temporary credentials in Settings",
        );
      }
      // Refused before any upload: a call that is sure to fail gains nothing.
      if (credentialsExpired(credentials, deps.now ?? Date.now())) {
        throw new TranscriptionError(
          "sagemaker transcription: the AWS credentials have expired — paste fresh ones in Settings, then retry",
        );
      }
      return createSageMakerTranscriptionEngine({
        ...s.sagemaker,
        credentials,
        language: s.language,
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
        ...(deps.invoke ? { invoke: deps.invoke } : {}),
      });
    }
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
