// Content script for the Teams web client: observes the caption DOM via the
// Teams Platform Adapter and streams Caption Snapshots + meeting status to
// the background. Runs only on Teams domains (manifest match patterns).
import { createTeamsAdapter } from "../adapters/teams";
import type { ContentMessage } from "../messages";

console.log(`meeting-summarizer: content script loaded in ${window.location.host} (frame: ${window !== window.top})`);

const adapter = createTeamsAdapter();
const DEBOUNCE_MS = 400;

let timer: ReturnType<typeof setTimeout> | undefined;
let lastSent = new Map<string, string>(); // key → speaker\ntext, to send only changes
let wasInMeeting = false;
let endedSent = false;

function send(msg: ContentMessage): void {
  void browser.runtime.sendMessage(msg).catch(() => {
    // Background asleep mid-navigation; next tick retries naturally.
  });
}

function tick(): void {
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
    send({ type: "captions-update", platform: adapter.platform, title, updates });
  }

  if (inMeeting !== wasInMeeting) {
    wasInMeeting = inMeeting;
    if (inMeeting) endedSent = false;
    send({ type: "meeting-status", platform: adapter.platform, title, inMeeting });
  }

  if (!endedSent && adapter.isMeetingEnded(document)) {
    endedSent = true;
    send({ type: "meeting-ended", platform: adapter.platform, title });
  }
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
