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

// One card per tab, in the top frame only — the content script also runs in
// meeting iframes, and a card per frame would stack duplicates.
if (window === window.top) {
  mountPrompt();
}

function mountPrompt(): void {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;bottom:16px;left:16px;z-index:2147483647;";
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
      }
      .card.collapsed { width: auto; display: flex; align-items: center; gap: 8px; }
      .row { display: flex; align-items: center; gap: 8px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #0e8a16; flex: none; }
      .dot.live { background: #d73a4a; }
      .label { font-weight: 600; }
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
    </style>
    <div class="card" role="status" aria-live="polite" hidden>
      <div class="row"><span class="dot" aria-hidden="true"></span><span class="label"></span></div>
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
        return "Your microphone will be recorded too.";
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
    void ext.runtime.sendMessage({ type: "dismiss-prompt" } satisfies ContentMessage);
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
  }

  async function poll(): Promise<void> {
    try {
      const reply = (await ext.runtime.sendMessage({
        type: "get-capture-state",
      } satisfies ContentMessage)) as CaptureStateReply;
      if (reply) apply(reply);
    } catch {
      // Background waking up — keep the last render and try next tick.
    }
  }

  void poll();
  setInterval(() => void poll(), 1000);
}
