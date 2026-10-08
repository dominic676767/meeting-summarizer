import type { CaptionSnapshot, PlatformAdapter } from "./adapter";

const CAPTION = "#live-transcription-subtitle .live-transcription-subtitle__item";
const LEAVE = "#wc-footer .footer__leave-btn-container button";
const BREAKOUT_TRANSITION = ".loading-layer--bo-room";

interface CaptionState {
  key: string;
  visibleText: string;
  text: string;
}

function rendered(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute("hidden")) return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") {
      return false;
    }
  }
  return true;
}

function visible(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    // Zoom's modal manager marks #root aria-hidden even while the meeting
    // and its captions remain on screen. Local caption flags still apply.
    if (current.id !== "root" && current.getAttribute("aria-hidden") === "true") return false;
  }
  return rendered(element);
}

function words(text: string): string[] {
  return text.split(/\s+/);
}

function comparable(word: string): string {
  return word.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Zoom can slide its caption window while keeping the same span. Retain the
 * words that have scrolled away, but require a useful overlap before joining. */
function slidingOverlap(previous: string, next: string): number {
  const before = words(previous);
  const after = words(next);
  for (let count = Math.min(before.length, after.length); count >= 3; count--) {
    if (before.slice(-count).every((word, index) => comparable(word) === comparable(after[index]!))) {
      return count;
    }
  }
  return 0;
}

export function createZoomAdapter(): PlatformAdapter {
  const instanceId = Math.random().toString(36).slice(2, 8);
  const captions = new WeakMap<Element, CaptionState>();
  let nextKey = 0;

  function newCaption(text: string): CaptionState {
    return { key: `${instanceId}-z${nextKey++}`, visibleText: text, text };
  }

  function ended(root: ParentNode): boolean {
    return [...root.querySelectorAll(".zm-modal-body-title")].some((element) =>
      rendered(element) && /^This meeting has been ended by (?:the )?host\.?$/i.test(element.textContent?.trim() ?? ""),
    );
  }

  return {
    platform: "Zoom",
    // Joining or returning from a breakout room can briefly remove controls.
    leaveGraceMs: 30_000,

    readCaptions(root): CaptionSnapshot[] {
      const snapshots: CaptionSnapshot[] = [];
      for (const element of root.querySelectorAll(CAPTION)) {
        if (!visible(element)) continue;
        const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (!text) continue;
        let state = captions.get(element);
        if (!state) {
          state = newCaption(text);
        } else if (text !== state.visibleText) {
          if (text.startsWith(state.visibleText)) {
            state.text += text.slice(state.visibleText.length);
          } else {
            const overlap = slidingOverlap(state.visibleText, text);
            if (overlap) {
              const tail = words(text).slice(overlap).join(" ");
              if (tail) state.text += ` ${tail}`;
            } else {
              // A new utterance in a reused row must not overwrite the old one
              // in TranscriptAccumulator.
              state = newCaption(text);
            }
          }
          state.visibleText = text;
        }
        captions.set(element, state);
        // The observed caption DOM exposes an initial, not a speaker identity.
        // Active video tiles can be stale; do not invent speaker attribution.
        snapshots.push({ key: state.key, speaker: "Unknown", text: state.text });
      }
      return snapshots;
    },

    isInMeeting(root): boolean {
      if (ended(root)) return false;
      // Zoom hides the meeting from assistive technology while a dialog is
      // open. Its rendered controls still mean that the meeting is active.
      return [...root.querySelectorAll(`${LEAVE}, ${BREAKOUT_TRANSITION}`)].some(rendered);
    },

    isMeetingEnded: ended,

    meetingTitle(doc): string | null {
      const title = doc.title.replace(/\s*[-|]\s*Zoom(?: Meeting)?\s*$/i, "").trim();
      return title && !/^Zoom(?: Meeting)?$/i.test(title) ? title : null;
    },
  };
}
