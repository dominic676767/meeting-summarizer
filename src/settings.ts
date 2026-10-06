// Settings persistence in extension local storage (ADR-0001: no native host,
// keys live here). The one exception is the SageMaker engine's AWS credentials,
// which are kept in session storage instead (see the end of this file).
import type { Settings } from "./domain/types";
import { ext } from "./platform";
import { DEFAULT_TEMPLATES } from "./pipeline/templates";
import type { AwsCredentials } from "./transcription/aws-credentials";

export const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  shape: "structured",
  templates: { ...DEFAULT_TEMPLATES },
  anthropic: { apiKey: "", model: "claude-sonnet-5" },
  openai: { apiKey: "", model: "gpt-4o" },
  ollama: { baseUrl: "http://localhost:11434", model: "llama3.1" },
  bedrock: { apiKey: "", region: "us-east-1", model: "anthropic.claude-sonnet-4-20250514-v1:0" },
  // Local WASM Whisper is the working default: no API key, and the audio never
  // leaves the machine (ADR-0004). Cloud transcription is strictly opt-in.
  nameEngineInArtifact: false,
  // The meeting tab carries only the other participants, so without the
  // microphone the user's own words are missing from every summary (ADR-0007).
  //
  // Off by default all the same. Recording somebody's microphone is the one
  // escalation in this extension that cannot be taken back, so the SAFE state
  // must not depend on a second mechanism holding: `enabled: true` gated by a
  // confirmation would start recording a microphone the moment anything reached
  // around that gate. Off, and the disclosure turns it on — the failure mode is
  // silence rather than surveillance.
  micCapture: { enabled: false, confirmedAt: null },
  transcription: {
    provider: "local-whisper",
    // No engine detects the language, so a default has to name one. English is
    // what both engines already assumed, which keeps an upgrading user's
    // transcripts exactly as they were; a user who meets in another language has
    // to say so, and the settings page says as much.
    language: "en",
    localWhisper: { model: "base" },
    // whisper-1 by default because it is the transcription model that returns
    // per-segment timestamps, and fusion attributes speakers by time overlap.
    openai: { apiKey: "", model: "whisper-1" },
    // Scribe's current model. It returns word timings and speaker ids, which is
    // everything fusion needs.
    elevenlabs: { apiKey: "", model: "scribe_v2" },
    // No endpoint until the user names one: the engine is theirs to deploy.
    sagemaker: { region: "us-east-1", endpointName: "" },
  },
};

export async function loadSettings(): Promise<Settings> {
  const stored = (await ext.storage.local.get("settings")) as { settings?: Partial<Settings> };
  const s = stored.settings ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    templates: { ...DEFAULT_SETTINGS.templates, ...s.templates },
    anthropic: { ...DEFAULT_SETTINGS.anthropic, ...s.anthropic },
    openai: { ...DEFAULT_SETTINGS.openai, ...s.openai },
    ollama: { ...DEFAULT_SETTINGS.ollama, ...s.ollama },
    bedrock: { ...DEFAULT_SETTINGS.bedrock, ...s.bedrock },
    // A user upgrading into microphone capture inherits `enabled: false` and a
    // null `confirmedAt`, so their next meeting is unchanged until they answer the
    // disclosure with a yes, the one act that sets both. An upgrade must never
    // start recording a microphone on its own, and neither gate is asked to hold
    // that alone.
    micCapture: { ...DEFAULT_SETTINGS.micCapture, ...s.micCapture },
    // Additive for a v1 user: existing keys, templates and shape are untouched
    // and transcription arrives with its working default.
    transcription: {
      ...DEFAULT_SETTINGS.transcription,
      ...s.transcription,
      localWhisper: {
        ...DEFAULT_SETTINGS.transcription.localWhisper,
        ...s.transcription?.localWhisper,
      },
      openai: {
        ...DEFAULT_SETTINGS.transcription.openai,
        ...s.transcription?.openai,
      },
      elevenlabs: {
        ...DEFAULT_SETTINGS.transcription.elevenlabs,
        ...s.transcription?.elevenlabs,
      },
      sagemaker: {
        ...DEFAULT_SETTINGS.transcription.sagemaker,
        ...s.transcription?.sagemaker,
      },
    },
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ext.storage.local.set({ settings });
}

const AWS_CREDENTIALS_KEY = "sagemakerCredentials";

/**
 * The SageMaker engine's temporary AWS credentials, or null when none are
 * pasted.
 *
 * Kept in `storage.session`, not with the settings: it is held in memory only,
 * never written to disk, and cleared when the browser closes (ADR-0009). That
 * costs nothing, because temporary credentials have usually expired by the next
 * browser start anyway, and a Held Recording waits for fresh ones.
 */
export async function loadAwsCredentials(): Promise<AwsCredentials | null> {
  const stored = (await ext.storage.session.get(AWS_CREDENTIALS_KEY)) as {
    [AWS_CREDENTIALS_KEY]?: AwsCredentials;
  };
  return stored[AWS_CREDENTIALS_KEY] ?? null;
}

export async function saveAwsCredentials(credentials: AwsCredentials): Promise<void> {
  await ext.storage.session.set({ [AWS_CREDENTIALS_KEY]: credentials });
}

export async function clearAwsCredentials(): Promise<void> {
  await ext.storage.session.remove(AWS_CREDENTIALS_KEY);
}
