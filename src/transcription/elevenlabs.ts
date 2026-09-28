// The second cloud Transcription Provider: ElevenLabs Scribe, chosen for the one
// thing no other engine here does — it diarizes. Every word comes back with an
// anonymous speaker label, which fills the Utterance's diarization label that
// fusion already falls back to when no Speaker Track name overlaps (ADR-0004).
//
// Strictly opt-in, like OpenAI: choosing it uploads the meeting's audio, and
// nothing here is reachable without the user picking this engine and entering
// its own key.
//
// Two halves. `spansFromScribe` is pure — Scribe's word list → timed spans — and
// decides everything about what the transcript says, so it is testable without
// a network. The engine around it only uploads a window and hands back the
// result; the provider wrapper still decodes, chunks and makes offsets absolute.
import type { MeetingLanguage } from "../domain/types";
import type { FetchFn } from "./openai";
import { pcm16 } from "./pcm";
import { TranscriptionError, type EngineSpan, type TranscriptionEngine } from "./provider";

const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";

/** Scribe's low-latency input is 16 kHz mono PCM, which is also what Whisper
 * listens at, so every engine here decodes to the same rate. */
export const SCRIBE_SAMPLE_RATE = 16_000;

/**
 * One upload per hour of audio. Scribe accepts files far larger than this, and
 * a longer window is worth having: its speaker labels hold only within one
 * request, so every extra window is another place two labels can split one
 * person. An hour covers most Capture Spans in one call, and bounds how long
 * one request can run.
 */
export const SCRIBE_MAX_INPUT_MS = 3_600_000;

/**
 * How long a window may take before it is given up on: this much, plus the
 * window's own duration. Nothing else in the extension times a request out, and
 * an hour's upload that silently stalls would otherwise spin forever. Giving up
 * throws a TranscriptionError, which holds the Recording for a retry.
 */
export const SCRIBE_TIMEOUT_GRACE_MS = 60_000;

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

export function createElevenLabsTranscriptionEngine(opts: {
  apiKey: string;
  model: string;
  /** The language the endpoint is told to expect, as its `language_code`. */
  language: MeetingLanguage;
  fetchFn?: FetchFn;
  /** Injected by tests; defaults to the grace period plus the audio's duration. */
  timeoutMsFor?: (audioMs: number) => number;
}): TranscriptionEngine {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMsFor = opts.timeoutMsFor ?? ((audioMs) => SCRIBE_TIMEOUT_GRACE_MS + audioMs);
  return {
    name: "elevenlabs",
    sampleRate: SCRIBE_SAMPLE_RATE,
    maxInputMs: SCRIBE_MAX_INPUT_MS,
    // Nothing to fetch or initialise: the model runs on ElevenLabs' machines.
    load() {
      return Promise.resolve();
    },
    async transcribe(samples, signal) {
      const durationSec = samples.length / SCRIBE_SAMPLE_RATE;
      const form = new FormData();
      form.append("model_id", opts.model);
      // Bare PCM rather than a WAV: Scribe reads the declared format directly.
      form.append(
        "file",
        new Blob([pcm16(samples)], { type: "application/octet-stream" }),
        "meeting.pcm",
      );
      form.append("file_format", "pcm_s16le_16");
      // The user's declaration, for the same reason OpenAI is sent it: one
      // answer for the whole Meeting rather than a guess per window.
      form.append("language_code", opts.language);
      // The reason to choose this engine at all.
      form.append("diarize", "true");
      // Word timings are what spans are cut from; fusion attributes by them.
      form.append("timestamps_granularity", "word");
      // Sounds are not speech. Also filtered in `spansFromScribe`, in case
      // Scribe tags them regardless.
      form.append("tag_audio_events", "false");

      // Whole milliseconds, rounded up. A window's duration is almost never a
      // whole number of ms (16 samples make one), and Node refuses a fractional
      // delay outright rather than rounding it; rounding up rather than down
      // means a slow upload is never cut off early.
      const timeoutMs = Math.ceil(timeoutMsFor(durationSec * 1000));
      const timeout = AbortSignal.timeout(timeoutMs);
      const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const res = await fetchFn(ENDPOINT, {
          method: "POST",
          headers: { "xi-api-key": opts.apiKey },
          body: form,
          signal: abort,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new TranscriptionError(
            `elevenlabs transcription: HTTP ${res.status} ${detail.slice(0, 300)}`,
          );
        }
        return spansFromScribe((await res.json()) as ScribeTranscription, durationSec);
      } catch (cause) {
        // A user's cancel is rethrown as it came: the wrapper, which knows the
        // signal was the user's, turns it into TranscriptionCancelled.
        if (timeout.aborted && !signal?.aborted) {
          throw new TranscriptionError(
            `elevenlabs transcription: no response after ${Math.round(timeoutMs / 1000)} s`,
            { cause },
          );
        }
        throw cause;
      }
    },
  };
}
