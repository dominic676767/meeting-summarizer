// The toolbar badge, whole: its text, its colour, and the words behind it.
//
// The badge is the only surface of this extension a user cannot avoid seeing, and
// the only one that is there when they were not looking for it — the in-page card
// is dismissible for the rest of the Meeting and the popup has to be opened. That
// makes it the surface with the least room to be wrong, which is why the decision
// is a pure function rather than a run of assignments inside the browser glue that
// nothing can test.
//
// Composed rather than merged: `mic-capture.ts` owns what may be claimed about the
// microphone, this module owns what the badge does with that claim alongside the
// caption count. Text and title are decided together in one place because they
// have to agree — a tooltip describing one state while the letters describe
// another is a smaller version of the same defect as letters that describe no
// state at all.
import { recordingBadge, type RecordingBadgeView } from "./mic-capture";

export interface BadgeView extends RecordingBadgeView {
  /**
   * The message of the session's active capture warning — silence, a storage
   * fault, a revoked microphone — or null when capture is healthy. Only read while
   * recording: a warning is not cleared when a recording stops, so once idle it is
   * a report about audio that is no longer being taken, and the popup is where
   * that belongs.
   */
  warning: string | null;
  /** A Meeting is visible in this tab. */
  inMeeting: boolean;
  /** Caption Segments accumulated for this Meeting so far. */
  segmentCount: number;
}

export interface Badge {
  /** Badge text. Empty leaves the icon bare, which is the absence of a state. */
  text: string;
  /** Badge background. */
  color: string;
  /**
   * The badge's tooltip, for every state rather than only the interesting ones.
   * `chrome.action.setTitle` is per-tab and sticky: whatever was set last stays
   * until something overwrites it, so a state with nothing to say still has to say
   * it or it inherits the previous state's sentence.
   */
  title: string;
}

/**
 * Alert Red. Every live-capture state, faulty or not, and the captions-off warning,
 * which is the double duty DESIGN.md's Text-or-Dot Rule governs and the user
 * approved for this badge specifically: a toolbar badge has no room for a dot
 * beside text, so the words in the tooltip carry the distinction the form cannot.
 */
const ALERT_RED = "#d73a4a";
/** Signal Green: captions are arriving and the tool is doing its job. */
const SIGNAL_GREEN = "#0e8a16";

/** Three digits is what fits; the exact count goes to the tooltip, which has room. */
const BADGE_COUNT_CAP = 999;

/**
 * What the toolbar badge shows for one tab.
 *
 * The order of the branches is the order of what matters: live capture outranks
 * the caption count, because audio being recorded is the fact a user most needs to
 * know and the one they are least able to discover any other way. Captions being
 * counted is reassurance; a microphone being live is consent.
 *
 * Letters for capture and digits for captions, so the two are never read as each
 * other — a count is the tool working, not a recording.
 *
 * A fault while recording appends `!` to the live letters rather than replacing
 * them: `MIC!` and `REC!`. The `!` is the mark the captions-off warning already
 * uses for "something here needs you", and keeping the letters in front of it
 * means a fault never costs the user the one fact the badge exists to carry —
 * whether their own voice is being recorded. Four characters is what a Chromium
 * badge fits before it starts clipping, so this is the whole of the room.
 */
export function badgeFor(v: BadgeView): Badge {
  // Whether the microphone is named is `recordingBadge`'s decision, and the colour
  // is not: both live states are live capture, so they share Alert Red and differ in
  // text alone. A difference carried by colour would be no difference to a user who
  // cannot see it.
  const live = recordingBadge(v);
  if (live && v.warning !== null) {
    // The fault first, in its own words, because it is the part the user can act
    // on; the microphone sentence after it, because a fault is exactly when a user
    // most needs to know whether their voice is still in the recording. Still
    // Alert Red: under the Text-or-Dot Rule it is the text that changes.
    return { text: `${live.text}!`, color: ALERT_RED, title: `${v.warning} ${live.title}` };
  }
  if (live) return { text: live.text, color: ALERT_RED, title: live.title };
  if (!v.inMeeting) {
    return { text: "", color: SIGNAL_GREEN, title: "Meeting Summarizer — no meeting detected." };
  }
  if (v.segmentCount === 0) {
    // A Meeting is running and nothing at all is being captured from it — no audio,
    // and not even the captions that would name the speakers. Alert Red as type
    // rather than as a dot, because it is a warning with something the user can do
    // about it, which is the half of the Text-or-Dot Rule this state falls under.
    return {
      text: "!",
      color: ALERT_RED,
      title: "Meeting detected — not recording, and no captions are arriving. Turn captions on.",
    };
  }
  return {
    text: String(Math.min(v.segmentCount, BADGE_COUNT_CAP)),
    color: SIGNAL_GREEN,
    // Says what the number is and what it is not. A count on a green badge reads as
    // "working", and it is — but the thing it counts is caption lines, not recorded
    // audio, and a user who reads it as a recording indicator has been told the
    // opposite of the truth by a badge that never said a word.
    title: `Meeting detected — not recording. ${captionLines(v.segmentCount)} captured so far.`,
  };
}

function captionLines(n: number): string {
  return n === 1 ? "1 caption line" : `${n} caption lines`;
}
