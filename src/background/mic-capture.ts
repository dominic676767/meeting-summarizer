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
 * Off until the user has BOTH enabled it and answered the disclosure, and both
 * halves fail closed on their own (ADR-0007). Chromium cannot show its own prompt
 * from an offscreen document, and `audioCapture` grants the microphone without
 * one, so this extension's disclosure is not an extra courtesy — it is the only
 * disclosure that exists.
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

export interface RecordingBadgeView {
  /** Audio is being recorded right now. */
  recording: boolean;
  /** The microphone is live in the mix right now, as the recorder reports it. */
  micRecording: boolean;
}

export interface RecordingBadgeLabel {
  /** The badge's three letters. */
  text: string;
  /** The same claim in words, for the badge's tooltip. */
  title: string;
}

/**
 * What the always-visible toolbar badge claims about live capture, or null when
 * nothing is being recorded and the microphone therefore has nothing to claim.
 *
 * The badge has to carry this claim because the other two surfaces can be absent
 * exactly when it matters: the in-page card is dismissible for the rest of the
 * Meeting, and the popup has to be opened, which makes it something the user goes
 * looking for rather than an indicator. ADR-0007 then loads the badge with more
 * than convenience — an offscreen document raises no Chromium prompt and
 * `audioCapture` grants the microphone without one, so after a single consent this
 * extension's own surfaces are all that can say whose voice is being recorded in
 * *this* Meeting. Three letters spent equally on both facts said nothing about the
 * one that matters.
 *
 * Deliberately blind to `micCapture.enabled`, unlike `micCaptureState`: the badge
 * reports what the recorder has open, never what the settings page asked for. So
 * everything short of the recorder saying yes — a revoked microphone, a refused
 * one, a session rehydrated from before the microphone existed — reads as tab-only.
 * Under-reporting costs the user a glance at the popup; over-reporting tells
 * somebody their microphone is live when it is not, which is the failure that makes
 * an indicator worth less than no indicator.
 *
 * The colour is not decided here, and that is the point: both states are live
 * capture, both take Alert Red, and only the text changes. A difference carried by
 * colour alone is not a difference every user can see.
 */
export function recordingBadge(v: RecordingBadgeView): RecordingBadgeLabel | null {
  if (v.recording && v.micRecording) {
    return {
      text: "MIC",
      title: "Recording, microphone on — your own voice is in the recording.",
    };
  }
  if (v.recording) {
    return {
      text: "REC",
      title: "Recording, microphone off — only the other participants are being recorded.",
    };
  }
  // Null rather than a blank label: what an idle badge shows is the caption count's
  // business, and a caller that forgets this case should fail loudly instead of
  // silently wiping a badge that had something to say. It also means a `micRecording`
  // left behind by a finished recording can never be read as live capture here.
  return null;
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
