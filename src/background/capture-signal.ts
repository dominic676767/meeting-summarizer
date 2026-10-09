// What the background does with the recorder's two silence measurements.
//
// The measuring lives in the offscreen document (`../offscreen/signal`), because
// that is where the mixed stream is. The rules for acting on it live here, and are
// pure for the same reason the microphone's rules are: this is where the honesty
// is, and every one of these decisions is a sentence the user reads or a recording
// that gets kept or thrown away.
import type { CaptureWarning } from "../messages";

/**
 * The user-facing sentence a sustained silent window raises.
 *
 * Reviewed and approved copy — do not reword. It is careful not to accuse: a user
 * who starts recording before the meeting begins must not be told they are muted
 * when nothing is wrong, or the warning is spent before a real one arrives.
 * "yet" and the conditional "if the meeting has started" are what buy that.
 */
export const NO_SOUND_MESSAGE =
  "No sound has reached the recording yet. If the meeting has started, check that it's playing through this computer and that you're unmuted.";

/**
 * The warning a microphone revoked mid-meeting raises, as a value rather than a
 * literal because the precedence rule below has to recognise it.
 */
export const MIC_REVOKED_WARNING: CaptureWarning = {
  message: "Your microphone stopped being recorded — your own words from here on will be missing.",
  detail: "the microphone stopped during the meeting",
};

/**
 * The warning to show now that a silent window has closed: the silence warning, or
 * the one already on the session if it outranks it.
 *
 * **Precedence.** A silence warning never overwrites a microphone revocation.
 * Losing the microphone is a *cause* of silence, so the vaguer message would
 * routinely land a moment after the specific, actionable one and bury it. The
 * reverse direction does overwrite — a microphone that has just died is newer and
 * more actionable than a silent window that already passed — which is why the
 * microphone handler assigns its warning outright and this one has to ask.
 */
export function silenceWarning(current: CaptureWarning | null, detail: string): CaptureWarning {
  if (current?.message === MIC_REVOKED_WARNING.message) return current;
  return { message: NO_SOUND_MESSAGE, detail };
}

export function clearSilenceWarning(current: CaptureWarning | null): CaptureWarning | null {
  return current?.message === NO_SOUND_MESSAGE ? null : current;
}

/**
 * Nothing at all reached us: no sound in the recording and no Caption Segments
 * either. Reported rather than left as a meeting that quietly produced no file,
 * and pointedly not sent to a Provider — an LLM asked to summarize nothing answers
 * with an apology, and that apology was the body of both artifacts this exists to
 * prevent.
 *
 * This one does overwrite whatever warning was showing, including a microphone
 * revocation. It is not a live problem competing with another live problem: it is
 * the Meeting's outcome, it is the last thing the user will be told about this
 * Meeting, and "your voice will be missing from here on" is no longer the fact
 * that matters when there is no "here on" and nothing was captured at all.
 */
export const NOTHING_CAPTURED_WARNING: CaptureWarning = {
  // "Nothing to summarize" rather than "no summary to write": at this moment the
  // user does not care what we can produce. And it ends on the forward action,
  // because nothing here is recoverable — the meeting is over and the content is
  // gone, so the only useful thing left to say is what makes the next one work. A
  // message that reports a total loss with no next step is where someone decides
  // the extension does not work and stops opening it.
  message:
    "Nothing was captured from this meeting — no sound reached the recording and no captions were picked up, so there was nothing to summarize. Before the next one, turn on live captions and check the meeting's audio is playing through this computer.",
  detail: "no audio signal and no caption segments",
};

/**
 * Whether the Meeting's Audio Recording holds signal anywhere, folded across its
 * Capture Spans.
 *
 * OR, and that is the whole point: a Meeting whose first span was silent and whose
 * second carried the entire conversation has audio worth transcribing. Null is "no
 * span measured yet", not "silent".
 */
export function foldAnySignal(previous: boolean | null, anySignal: boolean): boolean {
  return (previous ?? false) || anySignal;
}

/**
 * Whether to refuse this Meeting's audio as carrying no speech, without asking a
 * Transcription Provider at all.
 *
 * Only on a measured `false`. Null — no span was ever measured, because the
 * offscreen document died before it could be asked — reads as "there was sound":
 * declining to transcribe audio nobody looked at would discard a real meeting,
 * while transcribing a silent one costs a few minutes and is caught anyway by the
 * check that refuses degenerate output (`../transcription/silence`).
 */
export function refuseAudioAsSilent(hadAnySignal: boolean | null): boolean {
  return hadAnySignal === false;
}
