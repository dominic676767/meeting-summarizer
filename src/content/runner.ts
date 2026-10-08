// The shared content-script loop. DOM knowledge belongs to the Platform Adapter.
import type { PlatformAdapter } from "../adapters/adapter";
import type { ContentMessage } from "../messages";
import { ext } from "../platform";

const DEBOUNCE_MS = 400;
const DEFAULT_LEAVE_GRACE_MS = 10_000;
const DELIVERY_RETRY_MS = 2_000;

type DeliveryMessage = Extract<ContentMessage, {
  type: "captions-update" | "meeting-status" | "meeting-ended";
}>;

/** Observe this frame and stream Caption Snapshots + meeting status.
 * Returns a cleanup function; each invocation owns its observer and timers. */
export function startContentScript(adapter: PlatformAdapter): () => void {
  console.log(`meeting-summarizer: content script loaded in ${window.location.host} (frame: ${window !== window.top})`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const lastQueued = new Map<string, string>(); // key → speaker\ntext
  const outbox: DeliveryMessage[] = [];
  let sending = false;
  let wasInMeeting = false;
  let endedQueued = false;
  let stopped = false;

  function orphaned(): boolean {
    try {
      // An invalidated extension context can throw when reading runtime.id.
      return !ext.runtime?.id;
    } catch {
      return true;
    }
  }

  function shutDown(): void {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(leaveTimer);
    clearTimeout(retryTimer);
    observer.disconnect();
    outbox.length = 0;
    lastQueued.clear();
  }

  function send(msg: DeliveryMessage): Promise<void> {
    // sendMessage can throw synchronously after extension reload. Convert that
    // to a rejection so callers handle it alongside asynchronous failures.
    let call: Promise<unknown>;
    try {
      call = ext.runtime.sendMessage(msg);
    } catch {
      return Promise.reject(new Error("sendMessage failed"));
    }
    return call.then(
      () => undefined,
      () => { throw new Error("sendMessage failed"); },
    );
  }

  function flushOutbox(): void {
    if (stopped) return;
    if (orphaned()) return shutDown();
    const message = outbox[0];
    if (sending || !message) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    sending = true;
    // Keep the message until the background worker acknowledges it. Captions
    // can disappear from the DOM while a failed delivery waits for its retry.
    void send(message).then(
      () => {
        sending = false;
        if (stopped) return;
        outbox.shift();
        flushOutbox();
      },
      () => {
        sending = false;
        if (stopped) return;
        if (orphaned()) return shutDown();
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          flushOutbox();
        }, DELIVERY_RETRY_MS);
      },
    );
  }

  function enqueue(msg: DeliveryMessage): void {
    const tail = outbox.at(-1);
    const tailIsWaiting = !sending || outbox.length > 1;
    if (msg.type === "captions-update" && tail?.type === "captions-update" && tailIsWaiting) {
      // Only waiting batches can change. Preserve every utterance key, replacing
      // an older partial caption with its latest text.
      const updates = new Map(tail.updates.map((update) => [update.key, update]));
      for (const update of msg.updates) updates.set(update.key, update);
      outbox[outbox.length - 1] = { ...msg, updates: [...updates.values()] };
    } else {
      outbox.push(msg);
    }
    flushOutbox();
  }

  function sendEnded(title: string | null): void {
    if (stopped) return;
    if (orphaned()) return shutDown();
    if (endedQueued) return;
    endedQueued = true;
    // The queue delivers the final caption batch before Meeting End.
    enqueue({ type: "meeting-ended", platform: adapter.platform, title });
  }

  function tick(): void {
    if (stopped) return;
    if (orphaned()) return shutDown();
    const title = adapter.meetingTitle(document);
    const inMeeting = adapter.isInMeeting(document);
    const snapshots = adapter.readCaptions(document);
    const updates = snapshots.filter((s) => {
      const sig = `${s.speaker}\n${s.text}`;
      if (lastQueued.get(s.key) === sig) return false;
      lastQueued.set(s.key, sig);
      return true;
    });
    if (updates.length > 0) {
      enqueue({ type: "captions-update", platform: adapter.platform, title, updates });
    }

    if (inMeeting !== wasInMeeting) {
      wasInMeeting = inMeeting;
      if (inMeeting) {
        endedQueued = false;
        clearTimeout(leaveTimer);
      } else {
        // Controls can disappear during a re-render. Only an absence lasting
        // the adapter's grace period counts as Meeting End.
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => {
          if (stopped) return;
          if (orphaned()) return shutDown();
          if (!adapter.isInMeeting(document)) sendEnded(adapter.meetingTitle(document));
        }, adapter.leaveGraceMs ?? DEFAULT_LEAVE_GRACE_MS);
      }
      enqueue({ type: "meeting-status", platform: adapter.platform, title, inMeeting });
    }

    // Recognized ended states bypass the grace period, even if controls remain.
    if (adapter.isMeetingEnded(document)) sendEnded(title);
    // A DOM change can also wake a failed delivery before its retry timer.
    flushOutbox();
  }

  const observer = new MutationObserver(() => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      tick();
    }, DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden", "aria-hidden"],
  });
  tick();
  return shutDown;
}
