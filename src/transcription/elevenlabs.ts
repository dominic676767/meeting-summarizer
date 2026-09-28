// The second cloud Transcription Provider: ElevenLabs Scribe, chosen for the one
// thing no other engine here does — it diarizes. Every word comes back with an
// anonymous speaker label, which fills the Utterance's diarization label that
// fusion already falls back to when no Speaker Track name overlaps (ADR-0004).
//
// Strictly opt-in, like OpenAI: choosing it uploads the meeting's audio.
//
// This module starts with the pure half: Scribe's word list → timed spans. The
// request itself is a thin wrapper around it, so everything that decides what
// the transcript says is testable without a network.
import type { EngineSpan } from "./provider";

/** One entry in Scribe's `words` list. Spacing is its own entry, not part of a word. */
export interface ScribeWord {
  text: string;
  type: "word" | "spacing" | "audio_event";
  /** Seconds from the start of the uploaded audio. The API allows null. */
  start?: number | null;
  end?: number | null;
  /** Present when diarization ran. Scoped to one request: see `spansFromScribe`. */
  speaker_id?: string | null;
}

/** The part of Scribe's single-channel response this engine reads. */
export interface ScribeTranscription {
  text?: string;
  words?: ScribeWord[];
}

/**
 * A silence this long ends a span even when the speaker has not changed. Fusion
 * attributes a span to whoever overlaps it most, so a span that runs through a
 * pause the diarizer did not split on can swallow a caption speaker change.
 */
export const SCRIBE_PAUSE_SPLIT_SEC = 1;

/**
 * Longest span, for the same reason: when the diarizer merges two voices under
 * one label, this bounds how much of the other person's speech one Speaker
 * Track name can claim. Close to the length of a Whisper segment, so fused
 * transcripts read alike whichever engine produced them.
 */
export const SCRIBE_MAX_SPAN_SEC = 30;

/**
 * Scribe's words → spans, times still relative to the audio that was uploaded.
 *
 * Consecutive words from one speaker become one span, split at a speaker
 * change, at a pause of `SCRIBE_PAUSE_SPLIT_SEC` or more, or before a span would
 * pass `SCRIBE_MAX_SPAN_SEC`. Spacing entries are kept inside a span, so text
 * reads as Scribe wrote it — including languages it writes without spaces.
 *
 * Speaker labels are renumbered "Speaker 1", "Speaker 2"… in order of first
 * appearance. Scribe's own ids mean nothing outside the request that produced
 * them, so no attempt is made to keep them: making labels distinct across
 * requests is the caller's job, because only the caller knows there was more
 * than one.
 *
 * Audio events ("(laughter)") are dropped: they are not speech, and a summary
 * that quotes them as words is wrong. A word Scribe could not time keeps its
 * text and takes the latest timing seen, because dropping accurate speech for
 * want of a timestamp is worse than a coarse one. A response with text but no
 * word list becomes one span over the whole window, as OpenAI's does.
 */
export function spansFromScribe(body: ScribeTranscription, durationSec: number): EngineSpan[] {
  if (!body.words?.length) {
    return body.text?.trim() ? [{ text: body.text, startSec: 0, endSec: durationSec }] : [];
  }

  const labels = new Map<string, string>();
  const labelFor = (id: string | null | undefined): string | undefined => {
    if (!id) return undefined;
    let label = labels.get(id);
    if (!label) {
      label = `Speaker ${labels.size + 1}`;
      labels.set(id, label);
    }
    return label;
  };

  const spans: EngineSpan[] = [];
  let current: { parts: string[]; startSec: number; endSec: number; speaker?: string } | null =
    null;
  // The latest time any word has reached: where an untimed word is placed.
  let latestSec = 0;

  const flush = () => {
    if (!current) return;
    const text = current.parts.join("").trim();
    if (text !== "") {
      spans.push({
        text,
        startSec: current.startSec,
        endSec: current.endSec,
        ...(current.speaker ? { speaker: current.speaker } : {}),
      });
    }
    current = null;
  };

  for (const word of body.words) {
    if (word.type === "audio_event") continue;
    if (word.type === "spacing") {
      // Leading spacing belongs to no span; trailing spacing is trimmed at flush.
      current?.parts.push(word.text);
      continue;
    }
    const speaker = labelFor(word.speaker_id);
    const startSec = word.start ?? latestSec;
    const endSec = Math.max(startSec, word.end ?? startSec);
    if (
      current &&
      (speaker !== current.speaker ||
        startSec - current.endSec >= SCRIBE_PAUSE_SPLIT_SEC ||
        endSec - current.startSec > SCRIBE_MAX_SPAN_SEC)
    ) {
      flush();
    }
    current ??= { parts: [], startSec, endSec, speaker };
    current.parts.push(word.text);
    current.endSec = Math.max(current.endSec, endSec);
    latestSec = Math.max(latestSec, endSec);
  }
  flush();
  return spans;
}
