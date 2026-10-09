// Message protocol between content scripts, background, offscreen, and popup.
import type { CaptionSnapshot } from "./adapters/adapter";
import type { MicCaptureState } from "./background/mic-capture";
import type { MicrophonePermissionState } from "./offscreen/microphone-permission";
import type {
  CaptureSpan,
  HeldRecording,
  HeldTranscript,
  TranscriptionSettings,
  Utterance,
} from "./domain/types";
import type { AwsCredentials } from "./transcription/aws-credentials";

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
  | { type: "get-status"; tabId?: number }
  | { type: "start-capture"; tabId?: number }
  | { type: "stop-capture"; tabId?: number }
  | { type: "summarize-now"; tabId?: number }
  | { type: "skip-transcription"; tabId?: number }
  | { type: "list-held" }
  | { type: "retry-held"; id: string }
  | { type: "retry-held-recording"; recordingId: string }
  /**
   * The user's answer to the microphone disclosure, from the popup. Either answer
   * confirms it, so the notice stops asking; `enabled: false` leaves today's
   * tab-only capture in place.
   */
  | { type: "set-mic-capture"; enabled: boolean; tabId?: number };

export type OffscreenMessage =
  /** One Capture Span per start: the span id is the audio file it writes, and a
   * later Capture Start in the same Meeting names a different one (ADR-0005). */
  | {
      type: "offscreen-start";
      streamId: string;
      spanId: string;
      tabId: number;
      /**
       * Ask for the local microphone and mix it in, so one file holds both sides
       * of the meeting (ADR-0007). Decided by the service worker from settings and
       * the disclosure, never by the recorder: the offscreen document does the
       * capture, it does not get to decide whether the user agreed to it. A
       * refused microphone degrades to tab-only capture rather than failing.
       */
      mic: boolean;
    }
  | { type: "offscreen-stop"; tabId?: number; spanId?: string }
  | { type: "offscreen-status" }
  | { type: "offscreen-mic-permission" }
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
      /**
       * The SageMaker engine's temporary credentials, read by the service worker
       * from session storage: the offscreen document can reach no storage of its
       * own. Null for every other engine, so a credential is only ever sent to
       * the document when the engine that needs it is the one selected.
       */
      awsCredentials: AwsCredentials | null;
      /** Echoed back on progress so the service worker can find the session
       * again after a suspension. */
      tabId: number;
    }
  | { type: "offscreen-cancel-transcribe"; tabId?: number }
  /** Discards all of a Meeting's audio: a Meeting that recorded three spans must
   * leave no orphan once its Summary Artifact is written. */
  | { type: "offscreen-discard-spans"; spanIds: string[] };

/** Pushed from the offscreen document to the service worker during the wait. */
export type OffscreenEventMessage =
  | { type: "transcription-progress"; tabId: number; progress: TranscriptionProgress }
  /**
   * The capture track ended without us stopping it — the tab navigated away or
   * crashed. Reported so no session goes on claiming `recording: true` for a
   * recording that is not happening.
   */
  | { type: "capture-track-ended"; tabId: number; spanId?: string }
  /**
   * The MICROPHONE track ended on its own, mid-recording — Chrome's site
   * controls revoked it, or the device was unplugged. Distinct from
   * `capture-track-ended` because the recording is still viable: the remote
   * participants are still being captured. What is no longer true is that the
   * Audio Recording contains the local user, and a span that goes on claiming
   * otherwise is the same overclaim as calling captions a transcript.
   */
  | { type: "mic-track-ended"; tabId: number; spanId?: string }
  /** The mixed recording stream received sound for the first time in this span. */
  | { type: "capture-signal"; tabId: number; spanId?: string }
  /**
   * The mixed stream has received no sound since recording started, for a
   * sustained window. The user may still be able to fix the audio input.
   *
   * Pushed rather than waited to be polled, because the whole value of this warning
   * is that it arrives while the meeting is still happening and the popup may never
   * be opened. `detail` is the internal measure ("no signal for 45s") for the
   * tooltip; the user-facing sentence is the background's, not the recorder's.
   *
   * Drives the WARNING only. Whether the recording is transcribed at all is a
   * different measurement with a different rule — see `OffscreenStatusReply.
   * anySignal`.
   */
  | { type: "capture-silent"; tabId: number; spanId?: string; detail: string }
  /** The audio clock or encoder stopped. This is not evidence of silence. */
  | { type: "capture-failed"; tabId: number; spanId: string; detail: string };

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

/**
 * A capture problem the user should know about while they can still act on it.
 *
 * `message` is user-facing copy the producer writes and the popup renders
 * VISIBLY. `detail` is the raw internal reason and goes to a tooltip. Split
 * because the visible sentence used to be hardcoded per state while the
 * producer's string reached only a `title` — so a producer describing one
 * problem got another problem's copy displayed, and a warning worth acting on
 * mid-meeting was reachable only by hovering a popup that closes on blur.
 */
export interface CaptureWarning {
  message: string;
  detail?: string;
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
   * This Meeting's Audio Recording carried no speech, so its words were refused
   * rather than lost: a Degraded Capture with a reason. False where audio words
   * arrived, where transcription failed, and where no audio was recorded — those
   * are different states and the user must be able to tell them apart.
   */
  noSpeech: boolean;
  /**
   * A non-fatal capture problem the user must know about (storage quota, a
   * recorder fault) surfaced instead of a silent stop. Null when capture is
   * healthy.
   */
  captureWarning: CaptureWarning | null;
  /**
   * The microphone's part in this Meeting. Its own axis rather than a boolean,
   * because "not recording your voice" has four different causes and only two of
   * them are things the user should be asked to act on.
   */
  mic: MicCaptureState;
  /** Why the microphone could not be used, for the tooltip. Never the visible
   * line — the raw reason is Chromium's, not the user's. */
  micDetail: string | null;
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
  /**
   * The microphone's part in this Meeting. The prompt is the surface the user
   * reads immediately before invoking capture, so this is where the disclosure has
   * to land: told before it starts, not discovered afterwards.
   */
  mic: MicCaptureState;
}

export interface OffscreenMicPermissionReply {
  permission: MicrophonePermissionState;
}

export interface OffscreenStatusReply {
  recording: boolean;
  /** The meeting and span that own the current or most recently stopped capture. */
  tabId: number | null;
  spanId: string | null;
  /** A transcription keeps the offscreen document alive after capture stops. */
  transcribingTabId: number | null;
  startedAt: number | null;
  encodedBytes: number;
  /**
   * Meaningful signal reached the mixed stream at some point during this Capture
   * Span. Measured on the audio rather than inferred from `encodedBytes`, which
   * only ever proved the encoder ran — and it ran perfectly for both of the empty
   * artifacts that made this necessary.
   *
   * Deliberately NOT "a sustained silence occurred": that is the warning's
   * measurement, and using it here would throw a meeting that started late to
   * captions and claim it held no speech. This one is about the whole span.
   */
  anySignal: boolean;
  error: string | null;
  /** The local microphone is live in the mix. Reported from the recorder rather
   * than assumed from the request, because the request can be refused. */
  micRecording: boolean;
  /**
   * Why the microphone could not be used, or null. Kept apart from `error`: a
   * failed chunk write means audio is being lost, while this means half the
   * meeting is, and the two have different copy and different urgency.
   */
  micError: string | null;
  /** Latched capture failure. Retained after stop so failed audio can be held. */
  captureFailure?: string | null;
}

export interface OffscreenTranscribeReply {
  utterances: Utterance[];
  /** Which engine actually produced these words, for the artifact's optional
   * engine clause. Recorded from the run, not re-read from settings later. */
  engine?: { id: string; model: string };
  /** The user chose captions over waiting — not a failure. */
  cancelled: boolean;
  /**
   * Why the output was refused as carrying no speech, or null where it was
   * accepted. A third outcome beside success and failure, and it must stay
   * distinguishable from both: the recording was silent, so there is nothing to
   * report as an error and nothing a retry could recover.
   */
  noSpeech: string | null;
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
