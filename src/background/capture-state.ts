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

/**
 * A Meeting is a Degraded Capture when no Audio Recording was made for it, so
 * its Transcript can only come from caption words. Independent of whether
 * recording is live right now — once audio has been captured the Meeting is no
 * longer degraded even after the recorder stops.
 */
export function isDegraded(v: Pick<CaptureView, "recorded">): boolean {
  return !v.recorded;
}
