// Whether the local microphone is part of an Audio Recording, and how the
// surfaces say so.
//
// Recording the user's own microphone is a bigger step than recording tab audio,
// and this tool is meant for members of the public, so the escalation is gated on
// a disclosure the user has actually seen (ADR-0007). Pure, because the rules are
// where the honesty lives: which Capture Starts request the microphone, what the
// recording indicator may claim, and whether the Summary Artifact is allowed to
// imply the local user was captured.
import type { MicCaptureSettings } from "../domain/types";

/**
 * The microphone's part in this Meeting, as the popup and the in-page prompt
 * render it.
 *
 * - `off` — switched off in settings. A deliberate choice, not a fault.
 * - `unconfirmed` — on in settings but the disclosure has never been confirmed,
 *   so nothing has been recorded from it yet. Actionable: the user's own voice is
 *   missing until they say yes once.
 * - `armed` — will be recorded at the next Capture Start.
 * - `recording` — live in the mix right now.
 * - `unavailable` — requested and refused: permission denied, or no input device.
 *   Tab-only capture continues, which is the point — a missing microphone costs
 *   half the words, never the meeting.
 */
export type MicCaptureState = "off" | "unconfirmed" | "armed" | "recording" | "unavailable";

/**
 * Whether this Capture Start should ask for the microphone at all.
 *
 * On by default (a meeting summarizer that cannot hear its own user is broken),
 * but never before the disclosure has been confirmed: a permission escalation the
 * user was not told about is one they did not agree to, and Chromium cannot show
 * its own prompt from an offscreen document, so this is the only disclosure there
 * is.
 */
export function shouldCaptureMic(s: MicCaptureSettings): boolean {
  return s.enabled && s.confirmedAt !== null;
}

export interface MicCaptureView {
  settings: MicCaptureSettings;
  /** Audio is being recorded right now. */
  recording: boolean;
  /** The microphone is live in the mix right now, as the recorder reports it. */
  micRecording: boolean;
}

/**
 * What the surfaces may say about the microphone.
 *
 * A live microphone outranks the settings toggle: flipping the switch off during
 * a Meeting does not retroactively un-record what the recorder still has open, so
 * reporting "off" there would be the indicator lying about live capture.
 */
export function micCaptureState(v: MicCaptureView): MicCaptureState {
  if (v.recording && v.micRecording) return "recording";
  if (!v.settings.enabled) return "off";
  if (v.settings.confirmedAt === null) return "unconfirmed";
  return v.recording ? "unavailable" : "armed";
}

/**
 * Whether the Meeting's Audio Recording contains the local user's own voice,
 * folded across its Capture Starts.
 *
 * AND rather than OR, and that is the whole point: a Meeting recorded in three
 * spans of which one had no microphone does not contain the local user's whole
 * side of it, so the artifact must not claim the local user was captured. Null is
 * "no span yet", not "no microphone".
 */
export function foldLocalMicrophone(previous: boolean | null, micRecording: boolean): boolean {
  return (previous ?? true) && micRecording;
}
