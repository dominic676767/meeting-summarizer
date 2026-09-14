// Message protocol between content scripts, background, offscreen, and popup.
import type { CaptionSnapshot } from "./adapters/adapter";
import type { HeldTranscript } from "./domain/types";

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
  | { type: "list-held" }
  | { type: "retry-held"; id: string };

export type OffscreenMessage =
  | { type: "offscreen-start"; streamId: string }
  | { type: "offscreen-stop" }
  | { type: "offscreen-status" };

export type Message = ContentMessage | PopupMessage | OffscreenMessage;

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
   * caption words alone. True for every run until the Transcription Provider
   * lands, and the Summary Artifact must say so rather than imply audio.
   */
  degraded: boolean;
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

export interface HeldListReply {
  held: HeldTranscript[];
}
