// Utterances → the Transcript the summarization pipeline consumes. Pure.
import type { Transcript, Utterance } from "../domain/types";

/**
 * Marker for speech no name can be attached to. Base Whisper performs no
 * diarization, so every Utterance from the local engine carries this until
 * fusion with the Speaker Track supplies real names. Accurate words are never
 * dropped for lack of a name, and no name is ever invented.
 */
export const UNKNOWN_SPEAKER = "Unknown speaker";

/**
 * Replaces a Transcript's caption words with transcribed audio words, keeping
 * the Meeting's own metadata. Order is preserved and nothing is merged: one
 * Utterance is one segment, timed absolutely from the Meeting start.
 */
export function transcriptFromUtterances(base: Transcript, utterances: Utterance[]): Transcript {
  return {
    ...base,
    segments: utterances.map((u) => ({
      speaker: u.diarizationLabel ?? UNKNOWN_SPEAKER,
      text: u.text,
      capturedAt: base.startedAt + u.startMs,
    })),
  };
}
