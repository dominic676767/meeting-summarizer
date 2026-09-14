// Content script for the Teams web client: observes the caption DOM via the
// Teams Platform Adapter and streams Caption Snapshots + meeting status to
// the background. Runs only on Teams domains (manifest match patterns).
import { ext } from "../platform";
import { createTeamsAdapter } from "../adapters/teams";
import type { ContentMessage } from "../messages";

console.log(`meeting-summarizer: content script loaded in ${window.location.host} (frame: ${window !== window.top})`);

const adapter = createTeamsAdapter();
const DEBOUNCE_MS = 400;

let timer: ReturnType<typeof setTimeout> | undefined;
let lastSent = new Map<string, string>(); // key → speaker\ntext, to send only changes
let wasInMeeting = false;
let endedSent = false;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;

/** Grace period after call controls disappear before declaring Meeting End —
 * covers post-call screens we don't recognize without misfiring on
 * transient DOM re-renders. */
const LEAVE_GRACE_MS = 10_000;

/**
 * True once this script has been orphaned — the extension was reloaded or
 * updated, leaving a script from the previous generation running in a page it
 * can no longer talk to. `runtime.id` is what disappears.
 */
function orphaned(): boolean {
  return !ext.runtime?.id;
}

/**
 * Stop working. An orphaned script cannot deliver anything, so retrying is not
 * resilience — it is an endless stream of "Extension context invalidated" for a
 * meeting the new generation is already watching.
 */
function shutDown(): void {
  clearTimeout(timer);
  clearTimeout(leaveTimer);
  observer.disconnect();
}

function sendEnded(title: string | null): void {
  if (endedSent || orphaned()) return;
  endedSent = true; // optimistic, rolled back below on failure
  send({ type: "meeting-ended", platform: adapter.platform, title }).catch(() => {
    if (orphaned()) return shutDown();
    // Transient failure (background waking up): retry until delivered —
    // a lost end signal means a lost summary.
    endedSent = false;
    setTimeout(() => sendEnded(title), 2_000);
  });
}

function send(msg: ContentMessage): Promise<void> {
  return ext.runtime.sendMessage(msg).then(
    () => undefined,
    () => {
      throw new Error("sendMessage failed");
    },
  );
}

function tick(): void {
  if (orphaned()) return shutDown();
  const title = adapter.meetingTitle(document);
  const inMeeting = adapter.isInMeeting(document);

  const snapshots = adapter.readCaptions(document);
  const updates = snapshots.filter((s) => {
    const sig = `${s.speaker}\n${s.text}`;
    if (lastSent.get(s.key) === sig) return false;
    lastSent.set(s.key, sig);
    return true;
  });
  if (updates.length > 0) {
    send({ type: "captions-update", platform: adapter.platform, title, updates }).catch(() => {
      // Delivery failed: forget these signatures so the next tick resends
      // them instead of silently dropping Caption Segments.
      for (const u of updates) lastSent.delete(u.key);
    });
  }

  if (inMeeting !== wasInMeeting) {
    wasInMeeting = inMeeting;
    if (inMeeting) {
      endedSent = false;
      clearTimeout(leaveTimer);
    } else {
      // Call controls vanished: fire Meeting End after a grace period unless
      // they come back (works regardless of what post-call screen Teams shows).
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        if (!adapter.isInMeeting(document)) sendEnded(adapter.meetingTitle(document));
      }, LEAVE_GRACE_MS);
    }
    // Status is re-sent on every transition, so a lost one costs nothing and
    // needs no retry — but it still needs catching, or it surfaces as an
    // uncaught rejection in the page's console.
    send({ type: "meeting-status", platform: adapter.platform, title, inMeeting }).catch(() => {
      if (orphaned()) shutDown();
    });
  }

  // Recognized post-call screens end the meeting immediately, no grace needed.
  if (adapter.isMeetingEnded(document)) sendEnded(title);
}

const observer = new MutationObserver(() => {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    tick();
  }, DEBOUNCE_MS);
});

observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true,
});

tick();
