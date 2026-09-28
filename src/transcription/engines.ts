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
};

/** Whether choosing this engine sends the meeting's audio off the machine. */
export function uploadsAudio(provider: TranscriptionProviderId): boolean {
  return provider !== "local-whisper";
}
