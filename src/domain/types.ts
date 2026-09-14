// Domain vocabulary — see CONTEXT.md. Use these terms exactly.

/** One unit of live-caption text scraped from the meeting client's DOM. */
export interface CaptionSegment {
  speaker: string;
  text: string;
  /** epoch ms at capture time */
  capturedAt: number;
}

/** The ordered accumulation of Caption Segments for one Meeting. */
export interface Transcript {
  platform: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  segments: CaptionSegment[];
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

/** The engine that turns an Audio Recording into Utterances. Deliberately a
 * separate axis from ProviderId: most LLM backends have no speech-to-text API. */
export type TranscriptionProviderId = "local-whisper";

/** Whisper model size — the accuracy-against-time trade the user picks. */
export type WhisperModelSize = "tiny" | "base" | "small";

/** Settings persisted in browser.storage.local. */
export interface Settings {
  provider: ProviderId;
  shape: SummaryShape;
  templates: PromptTemplates;
  anthropic: { apiKey: string; model: string };
  openai: { apiKey: string; model: string };
  ollama: { baseUrl: string; model: string };
  bedrock: { apiKey: string; region: string; model: string };
  /** Transcription Provider selection and its settings, separate from the
   * Provider above so a Claude key is never mistaken for transcription. */
  transcription: {
    provider: TranscriptionProviderId;
    localWhisper: { model: WhisperModelSize };
  };
}

/** A Transcript whose summarization failed, retained for retry. */
export interface HeldTranscript {
  id: string;
  transcript: Transcript;
  reason: string;
  failedAt: number;
}
