// The in-page Capture Start surface: a summons, never a control. Chromium's
// tabCapture only starts after the *extension* is invoked (a toolbar click or a
// keyboard command); a click on an injected page button cannot grant it. So
// this card never offers a Start button that would lie about what it can do —
// it shows the keyboard shortcut and points at the toolbar mark, and only the
// real gesture starts recording (see the capture-prompt surface brief).
//
// It renders for `detected` (the summons) and collapses to a red-dot line
// during `recording`; it is absent otherwise. Mounted in a shadow root so the
// meeting page cannot restyle it and it cannot restyle the page.
import { ext } from "../platform";
import type { CaptureStateReply, ContentMessage } from "../messages";
import { positionPrompt } from "./prompt-position";

const mounted = globalThis as typeof globalThis & {
  meetingSummarizerPrompt?: () => void;
};

// One card per tab, in the top frame only — the content script also runs in
// meeting iframes, and a card per frame would stack duplicates.
if (window === window.top) {
  mountPrompt();
}

export function mountPrompt(): () => void {
  mounted.meetingSummarizerPrompt?.();
  document.getElementById("meeting-summarizer-capture-prompt")?.remove();
  const host = document.createElement("div");
  host.id = "meeting-summarizer-capture-prompt";
  host.style.cssText = "position:fixed;bottom:16px;left:16px;width:max-content;max-width:calc(100vw - 32px);z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      /* '.card.collapsed { display: flex }' outranks the UA sheet's
         [hidden] { display: none }, so setting card.hidden left the badge on
         screen — it went on reporting "Recording — 1:03" after capture had
         stopped. A popup that lies about live capture is worse than no
         indicator, so hidden wins here regardless of what follows. */
      [hidden] { display: none !important; }
      .card {
        font: 13px system-ui, sans-serif; color: #24292e; background: #fff;
        border: 1px solid #eee; border-radius: 4px; padding: 12px; width: 260px;
        max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto;
      }
      .card.collapsed { width: max-content; }
      .row {
        display: flex; align-items: center; gap: 8px;
        cursor: grab; touch-action: none; user-select: none;
      }
      .row.dragging, .row.dragging .move { cursor: grabbing; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #0e8a16; flex: none; }
      .dot.live { background: #d73a4a; }
      .label { font-weight: 600; min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
      .title { color: #555; font-size: 12px; margin: 6px 0 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hint { color: #555; font-size: 12px; margin-bottom: 10px; }
      /* The microphone disclosure, in the same Muted supporting voice as the
         title: this card is the surface the user reads immediately before
         pressing the shortcut, so it is where being told beforehand happens. */
      .mic { color: #555; font-size: 12px; margin-bottom: 10px; }
      kbd {
        font: 11px system-ui, sans-serif; background: #fff; border: 1px solid #eee;
        border-radius: 4px; padding: 1px 5px;
      }
      button {
        font: 12px system-ui, sans-serif; color: #555; background: none;
        border: 1px solid #eee; border-radius: 4px; padding: 3px 8px; cursor: pointer;
      }
      button:focus-visible { outline: 2px solid #0e8a16; outline-offset: 1px; }
      .move { flex: none; width: 28px; height: 28px; padding: 4px; cursor: grab; }
      .move:hover, .move[aria-expanded="true"], .move-controls button:hover { background: #f6f8fa; }
      .move svg { display: block; width: 18px; height: 18px; }
      .move-controls { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 8px; }
      .move-controls button { min-height: 28px; }
      .move-up { grid-column: 2; }
      .move-left { grid-column: 1; }
    </style>
    <div class="card" role="status" aria-live="polite" hidden>
      <div class="row">
        <button type="button" class="move" aria-label="Move recording status"
          aria-expanded="false" aria-controls="move-controls"
          title="Drag to move. Click for move buttons, or use arrow keys when focused.">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="5" r="1.5"/><circle cx="16" cy="5" r="1.5"/>
            <circle cx="8" cy="12" r="1.5"/><circle cx="16" cy="12" r="1.5"/>
            <circle cx="8" cy="19" r="1.5"/><circle cx="16" cy="19" r="1.5"/>
          </svg>
        </button>
        <span class="dot" aria-hidden="true"></span><span class="label"></span>
      </div>
      <div id="move-controls" class="move-controls" role="group" aria-label="Move recording status" hidden>
        <button type="button" class="move-up" data-direction="ArrowUp" aria-label="Move up">Up</button>
        <button type="button" class="move-left" data-direction="ArrowLeft" aria-label="Move left">Left</button>
        <button type="button" data-direction="ArrowDown" aria-label="Move down">Down</button>
        <button type="button" data-direction="ArrowRight" aria-label="Move right">Right</button>
      </div>
      <div class="title"></div>
      <div class="mic"></div>
      <div class="hint"></div>
      <button type="button" class="dismiss">Not now</button>
    </div>`;
  document.documentElement.append(host);

  const card = root.querySelector(".card") as HTMLElement;
  const dot = root.querySelector(".dot") as HTMLElement;
  const label = root.querySelector(".label") as HTMLElement;
  const title = root.querySelector(".title") as HTMLElement;
  const mic = root.querySelector(".mic") as HTMLElement;
  const hint = root.querySelector(".hint") as HTMLElement;
  const dismiss = root.querySelector(".dismiss") as HTMLButtonElement;
  const positioning = positionPrompt(
    host,
    card,
    root.querySelector(".row") as HTMLElement,
    root.querySelector(".move") as HTMLButtonElement,
    root.querySelector(".move-controls") as HTMLElement,
  );
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function stop(): void {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    positioning.stop();
    host.remove();
    if (mounted.meetingSummarizerPrompt === stop) delete mounted.meetingSummarizerPrompt;
  }
  mounted.meetingSummarizerPrompt = stop;

  function orphaned(): boolean {
    try {
      return !ext.runtime.id;
    } catch {
      return true;
    }
  }

  /**
   * What the microphone will do once capture starts, stated before it does.
   *
   * Every state gets a sentence, including the ones that mean "not yet": a card
   * that goes quiet about the microphone in the one case where the user has to act
   * is the case that matters.
   */
  function micLine(state: CaptureStateReply["mic"]): string {
    switch (state) {
      case "armed":
      return "Microphone enabled. Chrome access is required before recording.";
      case "off":
        return "Your microphone will not be recorded.";
      case "unconfirmed":
        return "Your microphone is not being recorded, so your own words will be missing — turn it on from the extension popup.";
      case "unavailable":
        return "Your microphone could not be used, so your own words will be missing.";
      case "recording":
        return "Microphone on.";
    }
  }

  dismiss.addEventListener("click", () => {
    card.hidden = true;
    positioning.refresh();
    try {
      void Promise.resolve(ext.runtime.sendMessage({
        type: "dismiss-prompt",
      } satisfies ContentMessage)).catch(() => {
        if (orphaned()) stop();
      });
    } catch {
      if (orphaned()) stop();
    }
  });

  function shortcutHint(shortcut: string | null): string {
    if (!shortcut) {
      return "Click the Meeting Summarizer toolbar icon to start recording.";
    }
    const keys = shortcut.split("+").map((k) => `<kbd>${k.trim()}</kbd>`).join("+");
    return `Press ${keys}, or click the toolbar icon, to start recording.`;
  }

  function elapsed(since: number): string {
    const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
    const pad = (n: number) => String(n).padStart(2, "0");
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function apply(reply: CaptureStateReply): void {
    if (reply.state === "recording") {
      card.hidden = false;
      card.classList.add("collapsed");
      dot.classList.add("live");
      // The collapsed line names the microphone rather than leaving the user to
      // guess: it is the difference between recording the meeting and recording
      // the meeting and themselves.
      label.textContent = `Recording, microphone ${reply.mic === "recording" ? "on" : "off"} — ${elapsed(reply.recordingStartedAt ?? Date.now())}`;
      title.hidden = true;
      mic.hidden = true;
      hint.hidden = true;
      dismiss.hidden = true;
    } else if (reply.state === "detected" && !reply.dismissed) {
      card.hidden = false;
      card.classList.remove("collapsed");
      dot.classList.remove("live");
      label.textContent = "Not recording";
      title.hidden = false;
      title.textContent = reply.title ?? "";
      mic.hidden = false;
      mic.textContent = micLine(reply.mic);
      hint.hidden = false;
      hint.innerHTML = shortcutHint(reply.shortcut);
      dismiss.hidden = false;
    } else {
      card.hidden = true;
    }
    positioning.refresh();
  }

  async function poll(): Promise<void> {
    if (stopped) return;
    if (orphaned()) {
      stop();
      return;
    }
    try {
      const reply = (await ext.runtime.sendMessage({
        type: "get-capture-state",
      } satisfies ContentMessage)) as CaptureStateReply;
      if (!stopped && reply) apply(reply);
    } catch {
      if (orphaned()) stop();
      // A worker can also be waking up. Retry while this context is valid.
    }
  }

  void poll();
  if (!stopped) timer = setInterval(() => void poll(), 1000);
  return stop;
}
