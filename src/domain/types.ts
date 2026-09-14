// Domain vocabulary — see CONTEXT.md. Use these terms exactly.

/** One unit of live-caption text scraped from the meeting client's DOM. */
export interface CaptionSegment {
  speaker: string;
  text: string;
  /** epoch ms at capture time */
  capturedAt: number;
}

/**
 * How a Transcript segment's speaker name was arrived at. Absent on a segment
 * means the name came with the caption line itself, which is the caption-only
 * (Degraded Capture) case.
 */
export type SpeakerAttribution = "speaker-track" | "diarization" | "unknown";

/**
 * One entry of the Transcript the summarization pipeline consumes. A
 * caption-only Transcript's segments are Caption Segments verbatim; a Fused
 * Transcript's additionally carry the Utterance's absolute time range and how
 * its speaker was arrived at, so a reader can locate and weigh any claim.
 */
export interface TranscriptSegment {
  speaker: string;
  text: string;
  /** epoch ms: caption capture time, or the Meeting start plus `startMs` */
  capturedAt: number;
  /** ms from the Meeting start. Absent where the words came from captions,
   * which carry a capture instant but no span of their own. */
  startMs?: number;
  endMs?: number;
  attribution?: SpeakerAttribution;
}

/**
 * What a Transcript was made of, in the three genuinely different levels of
 * reliability v2 produces:
 *
 * - `fused` — audio words, names from the Speaker Track. The intended path.
 * - `audio-unattributed` — audio words, but no Speaker Track name reached any
 *   Utterance (captions were off, or none overlapped), so owners are anonymous.
 * - `captions-only` — no Audio Recording at all, so the words are the platform's
 *   caption text with its misreadings and its dropped lines: a Degraded Capture.
 */
export type TranscriptProvenance = "fused" | "audio-unattributed" | "captions-only";

/** The ordered, speaker-attributed record of one Meeting. */
export interface Transcript {
  platform: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  /**
   * Recorded when the Transcript is built — by fusion, or by the caption
   * fallback — never re-derived at render time, because only the builder knows
   * whether any name actually landed. Absent on a Transcript held from before
   * provenance existed, which reads as `captions-only`: the absence of a claim
   * must never be read as a claim of recorded audio.
   */
  provenance?: TranscriptProvenance;
  segments: TranscriptSegment[];
}

/**
 * One transcribed span of speech: the Transcription Provider's output unit.
 * Offsets are absolute ms from the Meeting start, so neither a chunk boundary
 * nor a Capture Start later than the Meeting start shifts them — fusion
 * attributes Utterances by overlapping these against the Speaker Track.
 */
export interface Utterance {
  text: string;
  startMs: number;
  endMs: number;
  /**
   * The engine's own anonymous label ("Speaker 1") where it diarizes. Base
   * Whisper does not, so it is absent for the local engine; real names come
   * from fusion with the Speaker Track, never from guessing here.
   */
  diarizationLabel?: string;
}

export type SummaryShape = "structured" | "narrative";

/** User-editable text sent to the Provider. One template per summary shape. */
export interface PromptTemplates {
  structured: string;
  narrative: string;
}

export type ProviderId = "anthropic" | "openai" | "ollama" | "bedrock";

/**
 * The engine that turns an Audio Recording into Utterances. Deliberately a
 * separate axis from ProviderId: most LLM backends have no speech-to-text API,
 * so the ids that appear in both lists are a coincidence of vendor, not a shared
 * setting — `openai` here is a transcription endpoint with its own key.
 */
export type TranscriptionProviderId = "local-whisper" | "openai";

/** Whisper model size — the accuracy-against-time trade the user picks. */
export type WhisperModelSize = "tiny" | "base" | "small";

/**
 * Transcription Provider selection and per-engine settings. A separate axis from
 * the Provider settings: a Claude or Bedrock key can summarize a Meeting but
 * cannot transcribe one, so no key is ever shared between the two.
 */
export interface TranscriptionSettings {
  provider: TranscriptionProviderId;
  localWhisper: { model: WhisperModelSize };
  /** The cloud engine's own credentials. Not the `openai` Provider key: that one
   * is spent on summarization, and a user may opt into one without the other. */
  openai: { apiKey: string; model: string };
}

/** Settings persisted in browser.storage.local. */
export interface Settings {
  provider: ProviderId;
  shape: SummaryShape;
  templates: PromptTemplates;
  anthropic: { apiKey: string; model: string };
  openai: { apiKey: string; model: string };
  ollama: { baseUrl: string; model: string };
  bedrock: { apiKey: string; region: string; model: string };
  transcription: TranscriptionSettings;
}

/** A Transcript whose summarization failed, retained for retry. */
export interface HeldTranscript {
  id: string;
  transcript: Transcript;
  reason: string;
  failedAt: number;
  /**
   * The Audio Recording this Meeting's words came from, still on disk. Carried
   * so the audio outlives the *first* artifact attempt: it is deleted only once
   * a Summary Artifact for this Transcript is confirmed written. Absent where
   * the Meeting has no Audio Recording at all.
   */
  recordingId?: string;
}

/**
 * An Audio Recording whose transcription failed, retained for retry — the
 * meeting is unrecoverable once its audio is dropped. Released only once its
 * Transcript exists, at which point the Held Transcript above owns the rest of
 * the retry chain.
 */
export interface HeldRecording {
  /** Storage key of the audio, and the entry's identity: one Meeting's
   * recording can only ever be held once. */
  recordingId: string;
  /**
   * The Meeting's caption-only Transcript — its metadata and the Speaker Track a
   * retry has to fuse the new Utterances with. Kept beside the audio because the
   * session that carried it does not survive a browser restart.
   */
  transcript: Transcript;
  /** ms from the Meeting start to Capture Start, so a retry's Utterance offsets
   * stay absolute relative to the Meeting. */
  startOffsetMs: number;
  reason: string;
  failedAt: number;
}
