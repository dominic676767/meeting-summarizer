import type { CaptionSnapshot, PlatformAdapter } from "./adapter";

// Selectors for the Teams web client (v2). Undocumented and expected to
// change — tests/fixtures/README.md explains how to re-capture fixtures
// when Teams redesigns (the maintenance cost ADR-0002 accepts).
const SELECTORS = {
  captionItem: '[data-tid="closed-caption-v2-window-message"], .fui-ChatMessageCompact',
  captionAuthor: '[data-tid="author"]',
  captionText: '[data-tid="closed-caption-text"]',
  captionsRenderer: '[data-tid="closed-captions-renderer"]',
  // Broad hangup match also covers the mini call monitor shown while
  // navigating elsewhere in Teams during a live call.
  hangupButton: '#hangup-button, [data-tid="hangup-main-btn"], [data-tid*="hangup"], [id*="hangup"]',
  postCall:
    '[data-tid="rejoin-button"], [data-tid="call-rating-flex-container"], [data-tid="call-end-screen"]',
  callTitle: '[data-tid="call-title"], [data-tid="call-header-title"]',
};

/** Strips Teams chrome from document.title, e.g. "(2) Standup | Microsoft Teams". */
export function cleanDocumentTitle(raw: string): string | null {
  const cleaned = raw
    .replace(/^\(\d+\)\s*/, "")
    .replace(/\s*[|·-]?\s*Microsoft Teams.*$/i, "")
    .trim();
  return cleaned || null;
}

export function createTeamsAdapter(): PlatformAdapter {
  // Stable identity for caption elements across in-place text mutations.
  // Keys are prefixed with a per-instance id so captions from different
  // frames (all_frames) or a reloaded page never collide in the accumulator.
  const instanceId = Math.random().toString(36).slice(2, 8);
  const keys = new WeakMap<Element, string>();
  let nextKey = 0;

  return {
    platform: "teams",

    readCaptions(root: ParentNode): CaptionSnapshot[] {
      const items = root.querySelectorAll(SELECTORS.captionItem);
      const out: CaptionSnapshot[] = [];
      for (const item of items) {
        let key = keys.get(item);
        if (!key) {
          key = `${instanceId}-c${nextKey++}`;
          keys.set(item, key);
        }
        const speaker =
          item.querySelector(SELECTORS.captionAuthor)?.textContent?.trim() ?? "Unknown";
        const text = item.querySelector(SELECTORS.captionText)?.textContent?.trim() ?? "";
        out.push({ key, speaker, text });
      }
      return out;
    },

    isInMeeting(root: ParentNode): boolean {
      return root.querySelector(SELECTORS.hangupButton) !== null;
    },

    isMeetingEnded(root: ParentNode): boolean {
      return (
        root.querySelector(SELECTORS.hangupButton) === null &&
        root.querySelector(SELECTORS.postCall) !== null
      );
    },

    meetingTitle(doc: Document): string | null {
      const el = doc.querySelector(SELECTORS.callTitle);
      const fromDom = el?.textContent?.trim();
      if (fromDom) return fromDom;
      return cleanDocumentTitle(doc.title);
    },
  };
}
