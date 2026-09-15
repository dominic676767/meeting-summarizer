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
  /**
   * Whether the Audio Recording this Transcript's words came from included the
   * local microphone, i.e. the user's own voice as well as the remote
   * participants'.
   *
   * Absent reads as false, deliberately: tab audio alone is only half the meeting
   * (ADR-0007), and a Transcript held from before the microphone was ever mixed in
   * genuinely has only the other side of the call in it. The absence of a claim
   * must never be read as a claim that the local user was captured.
   */
  localMicrophone?: boolean;
  /**
   * Which engine produced the words, recorded when the Transcript is built.
   * Whether it reaches the Summary Artifact is the reader's choice, not ours:
   * naming it aids reproducibility but discloses the author's tooling to
   * everyone the file is forwarded to, so it is omitted unless opted in.
   */
  engine?: { id: string; model: string };
  /**
   * The Audio Recording was transcribed successfully and contained no speech.
   *
   * Only ever true when the engine RAN AND RETURNED NOTHING. Never set when
   * transcription failed, was skipped, or never happened — those are different
   * facts, and collapsing them would tell a reader "there was nothing to hear"
   * about a meeting whose engine actually broke.
   *
   * Absent reads as no claim, not as "there was speech": on a caption-only
   * artifact from before this existed, we do not know which case it was.
   *
   * A boolean, deliberately: the reason the detector fired ("rms below threshold")
   * belongs in the log, not in a document that gets forwarded.
   */
  noSpeech?: boolean;
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

/**
 * One stretch of audio recorded between a Capture Start and the next stop: its
 * own file, plus where in the Meeting it began.
 *
 * A Meeting can have several, because the user may take a sensitive stretch off
 * the record and resume afterwards. Each is a separate file (ADR-0005), and its
 * `startOffsetMs` is what keeps its Utterance timings absolute relative to the
 * Meeting start once the spans are transcribed and concatenated.
 */
export interface CaptureSpan {
  /** Storage key of this span's audio. Unique within the Meeting. */
  spanId: string;
  /** ms from the Meeting start to this span's Capture Start. */
  startOffsetMs: number;
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
 * The language a Meeting is spoken in, as the ISO-639-1 code both engines take
 * as their language hint.
 *
 * Declared by the user because nothing here detects it: transformers.js does no
 * auto-detection and silently defaults Whisper to English, so an undeclared
 * German meeting comes back *mistranscribed* rather than transcribed — and the
 * default Prompt Templates then faithfully summarize the wrong words.
 *
 * A closed list rather than free text: an unrecognised code is rejected inside
 * the engine mid-run, which would cost a Meeting its Held Recording retry for a
 * typo. These are the languages the settings page offers, not everything Whisper
 * knows.
 */
export type MeetingLanguage =
  | "ar"
  | "cs"
  | "da"
  | "de"
  | "el"
  | "en"
  | "es"
  | "fi"
  | "fr"
  | "he"
  | "hi"
  | "hu"
  | "id"
  | "it"
  | "ja"
  | "ko"
  | "ms"
  | "nl"
  | "no"
  | "pl"
  | "pt"
  | "ro"
  | "ru"
  | "sv"
  | "th"
  | "tr"
  | "uk"
  | "vi"
  | "zh";

/**
 * Transcription Provider selection and per-engine settings. A separate axis from
 * the Provider settings: a Claude or Bedrock key can summarize a Meeting but
 * cannot transcribe one, so no key is ever shared between the two.
 */
export interface TranscriptionSettings {
  provider: TranscriptionProviderId;
  /**
   * The language the user says their meetings are held in, passed to whichever
   * engine is selected as its language hint. One setting rather than one per
   * engine: it describes the Meeting, not the engine.
   */
  language: MeetingLanguage;
  localWhisper: { model: WhisperModelSize };
  /** The cloud engine's own credentials. Not the `openai` Provider key: that one
   * is spent on summarization, and a user may opt into one without the other. */
  openai: { apiKey: string; model: string };
}

/**
 * Whether the local microphone joins the Audio Recording.
 *
 * The meeting tab carries only the remote participants, so without the microphone
 * the user's own contributions are absent from every summary (ADR-0007). Off by
 * default all the same: recording somebody's microphone is a privacy escalation,
 * so it is disclosed and confirmed once before it ever runs — an offscreen
 * document cannot show Chromium's own permission prompt, which makes this
 * extension's disclosure the only one there is.
 */
export interface MicCaptureSettings {
  enabled: boolean;
  /**
   * Epoch ms the user confirmed the disclosure, either way — accepting or
   * declining both count, so the notice stops asking. Null means never asked, and
   * until it is answered capture stays tab-only.
   */
  confirmedAt: number | null;
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
  /** Whether the local microphone joins the Audio Recording. */
  micCapture: MicCaptureSettings;
  /**
   * Name the transcription engine and model in the Summary Artifact. Off by
   * default: it helps a reader judge the words, but an artifact gets forwarded,
   * and the author never chose to tell its recipients what they run.
   */
  nameEngineInArtifact: boolean;
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
  /** Every Capture Span still on disk for this Meeting, so the artifact write
   * that releases the audio releases all of it. Absent on an entry held before
   * spans existed, which is one span keyed by `recordingId`. */
  spans?: CaptureSpan[];
}

/**
 * An Audio Recording whose transcription failed, retained for retry — the
 * meeting is unrecoverable once its audio is dropped. Released only once its
 * Transcript exists, at which point the Held Transcript above owns the rest of
 * the retry chain.
 */
export interface HeldRecording {
  /** The Meeting's recording key, and the entry's identity: one Meeting's
   * recording can only ever be held once, however many spans it has. */
  recordingId: string;
  /**
   * The Meeting's caption-only Transcript — its metadata and the Speaker Track a
   * retry has to fuse the new Utterances with. Kept beside the audio because the
   * session that carried it does not survive a browser restart.
   */
  transcript: Transcript;
  /**
   * Every Capture Span of the Meeting, in Capture Start order. A Held Recording
   * covers the whole Meeting, not the last stretch of it: a retry that
   * transcribed only one span of three would drop the rest silently, which is the
   * defect this shape exists to make impossible.
   */
  spans: CaptureSpan[];
  reason: string;
  failedAt: number;
}
