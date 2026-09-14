// Message protocol between content scripts, background, offscreen, and popup.
import type { CaptionSnapshot } from "./adapters/adapter";
import type {
  CaptureSpan,
  HeldRecording,
  HeldTranscript,
  TranscriptionSettings,
  Utterance,
} from "./domain/types";

/**
 * The state vocabulary the popup and the in-page capture prompt share.
 * `detected` is the prompt's moment: a Meeting is visible but no audio is
 * being recorded, and on Chromium only an extension invocation can change that
 * (see the capture-prompt surface brief).
 */
export type CaptureState =
  | "idle"
  | "detected"
  | "recording"
  | "transcribing"
  | "summarizing"
  | "done"
  | "failed";

export type ContentMessage =
  | { type: "captions-update"; platform: string; title: string | null; updates: CaptionSnapshot[] }
  | { type: "meeting-status"; platform: string; title: string | null; inMeeting: boolean }
  | { type: "meeting-ended"; platform: string; title: string | null }
  | { type: "get-capture-state" }
  | { type: "dismiss-prompt" };

export type PopupMessage =
  | { type: "get-status" }
  | { type: "start-capture" }
  | { type: "stop-capture" }
  | { type: "summarize-now" }
  | { type: "skip-transcription" }
  | { type: "list-held" }
  | { type: "retry-held"; id: string }
  | { type: "retry-held-recording"; recordingId: string };

export type OffscreenMessage =
  /** One Capture Span per start: the span id is the audio file it writes, and a
   * later Capture Start in the same Meeting names a different one (ADR-0005). */
  | { type: "offscreen-start"; streamId: string; spanId: string }
  | { type: "offscreen-stop" }
  | { type: "offscreen-status" }
  | {
      type: "offscreen-transcribe";
      /**
       * Every Capture Span of the Meeting, in Capture Start order. Each carries
       * its own offset from the Meeting start, which is what keeps Utterance
       * timings absolute relative to the Meeting rather than to the span.
       */
      spans: CaptureSpan[];
      /** The whole Transcription Provider selection, resolved by the service
       * worker at transcribe time: the offscreen document runs the engine the
       * user has chosen now, never one remembered from a previous attempt. */
      transcription: TranscriptionSettings;
      /** Echoed back on progress so the service worker can find the session
       * again after a suspension. */
      tabId: number;
    }
  | { type: "offscreen-cancel-transcribe" }
  /** Discards all of a Meeting's audio: a Meeting that recorded three spans must
   * leave no orphan once its Summary Artifact is written. */
  | { type: "offscreen-discard-spans"; spanIds: string[] };

/** Pushed from the offscreen document to the service worker during the wait. */
export type OffscreenEventMessage = {
  type: "transcription-progress";
  tabId: number;
  progress: TranscriptionProgress;
};

export type Message =
  | ContentMessage
  | PopupMessage
  | OffscreenMessage
  | OffscreenEventMessage;

/**
 * The three long phases between Meeting End and a finished summary have
 * completely different time profiles and must stay distinguishable: the model
 * download is one-time and huge, transcription is per-meeting and long,
 * summarization is one provider call (and has its own state already).
 */
export type TranscriptionPhase = "model-download" | "transcribing";

/**
 * The measure behind the phase the popup names. Every number here is one the
 * engine actually reported; null means "not reported" and must be rendered as
 * elapsed time or nothing — never as a fabricated percentage.
 */
export interface TranscriptionProgress {
  phase: TranscriptionPhase;
  loadedBytes: number | null;
  totalBytes: number | null;
  processedMs: number | null;
  totalMs: number | null;
  /** Epoch ms this wait began, for the elapsed-time fallback. */
  startedAt: number;
}

export interface StatusReply {
  inMeeting: boolean;
  segmentCount: number;
  title: string | null;
  /** capturing = in a meeting AND segments have been arriving */
  capturing: boolean;
  state: CaptureState;
  /** Audio is being recorded right now. */
  recording: boolean;
  /** Epoch ms the recording began, for elapsed time; null when not recording. */
  recordingStartedAt: number | null;
  /**
   * This Meeting has no Audio Recording, so its Transcript will come from
   * caption words alone. True until the user starts capture; the Summary
   * Artifact must say so rather than imply audio.
   */
  degraded: boolean;
  /**
   * A non-fatal capture problem the user must know about (storage quota, a
   * recorder fault) surfaced instead of a silent stop. Null when capture is
   * healthy.
   */
  captureWarning: string | null;
  /** The live measure for the transcribing state; null outside it. */
  transcription: TranscriptionProgress | null;
}

/** What the in-page prompt needs, and nothing more. */
export interface CaptureStateReply {
  state: CaptureState;
  title: string | null;
  recording: boolean;
  recordingStartedAt: number | null;
  /** The prompt hides itself for the rest of this Meeting once dismissed. */
  dismissed: boolean;
  /** Keyboard shortcut that starts capture, as the user's platform renders it. */
  shortcut: string | null;
}

export interface OffscreenStatusReply {
  recording: boolean;
  startedAt: number | null;
  encodedBytes: number;
  error: string | null;
}

export interface OffscreenTranscribeReply {
  utterances: Utterance[];
  /** Which engine actually produced these words, for the artifact's optional
   * engine clause. Recorded from the run, not re-read from settings later. */
  engine?: { id: string; model: string };
  /** The user chose captions over waiting — not a failure. */
  cancelled: boolean;
  error: string | null;
}

export interface HeldListReply {
  held: HeldTranscript[];
  /**
   * Held Recordings, listed separately: their retry runs transcription and can
   * be recovered by switching Transcription Provider, which is a different
   * action from re-running a summary, so the popup must not merge the two.
   */
  recordings: HeldRecording[];
}
