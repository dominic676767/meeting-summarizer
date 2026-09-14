// Maps the background's per-tab session onto the CaptureState vocabulary the
// popup and in-page prompt render (see the capture-prompt surface brief). Pure
// so the state table can be tested without a browser: SessionState tracks the
// Meeting lifecycle, CaptureState is what the surfaces show, and the two
// deliberately differ — "capturing" splits into "detected" (a Meeting is
// visible but audio is not being recorded) and "recording", the distinction
// Chromium's invocation requirement forces.
import type { CaptureState } from "../messages";
import type { SessionState } from "./sessions";

export interface CaptureView {
  sessionState: SessionState | undefined;
  inMeeting: boolean;
  recording: boolean;
  /** An Audio Recording exists (or existed) for this Meeting. */
  recorded: boolean;
}

export function deriveCaptureState(v: CaptureView): CaptureState {
  switch (v.sessionState) {
    case "transcribing":
      return "transcribing";
    case "summarizing":
      return "summarizing";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "capturing":
      if (v.recording) return "recording";
      return v.inMeeting ? "detected" : "idle";
    default:
      return "idle";
  }
}

export interface DegradedView {
  /** An Audio Recording exists (or existed) for this Meeting. */
  recorded: boolean;
  /**
   * Whether transcribed audio words actually reached the Transcript. Undefined
   * until transcription has run.
   */
  audioWords?: boolean | null;
}

/**
 * A Meeting is a Degraded Capture when its Transcript comes from caption words
 * alone. That is the case when no Audio Recording was made — and equally when
 * one was made but its words never arrived, because transcription failed or the
 * user chose captions over the wait. Recording being live right now is
 * irrelevant: audio already captured survives the recorder stopping.
 */
export function isDegraded(v: DegradedView): boolean {
  if (!v.recorded) return true;
  return v.audioWords === false;
}
