// What each Transcription Provider is called wherever the user reads it: the
// consent disclosure, the popup while it runs, and the Summary Artifact.
//
// One Record over the id type, so adding an engine without naming it is a
// compile error rather than a new engine that every surface calls by an old
// one's name — a consent that names the wrong destination is worse than none.
import type { TranscriptionProviderId } from "../domain/types";

export const TRANSCRIPTION_ENGINE_NAMES: Record<TranscriptionProviderId, string> = {
  "local-whisper": "local Whisper",
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
  sagemaker: "Amazon SageMaker",
};

/**
 * Where an engine's upload goes, as a consent names it. Usually the company. For
 * SageMaker it is the user's own AWS account, and the extension cannot see which
 * one, so the disclosure says whose account it is rather than guess.
 */
const UPLOAD_DESTINATIONS: Record<TranscriptionProviderId, string> = {
  ...TRANSCRIPTION_ENGINE_NAMES,
  sagemaker: "Amazon SageMaker, in the AWS account your credentials belong to",
};

/** Whether choosing this engine sends the meeting's audio off the machine. */
export function uploadsAudio(provider: TranscriptionProviderId): boolean {
  return provider !== "local-whisper";
}

/** The destination a consent names for this engine's uploads. */
export function uploadDestination(provider: TranscriptionProviderId): string {
  return UPLOAD_DESTINATIONS[provider];
}
