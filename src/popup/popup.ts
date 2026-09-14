// Popup: live capture status, Summarize now, Held Transcript retry.
import { ext } from "../platform";
import type {
  HeldListReply,
  PopupMessage,
  StatusReply,
  TranscriptionProgress,
} from "../messages";
import type { Settings } from "../domain/types";
import { loadSettings } from "../settings";

const regionEl = document.getElementById("status-region")!;
const statusEl = document.getElementById("status")!;
const detailEl = document.getElementById("detail")!;
const barEl = document.getElementById("model-progress") as HTMLProgressElement;
const titleEl = document.getElementById("title")!;
const degradedEl = document.getElementById("degraded")!;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const summarizeBtn = document.getElementById("summarize") as HTMLButtonElement;
const skipBtn = document.getElementById("skip-transcription") as HTMLButtonElement;
const heldSection = document.getElementById("held")!;
const heldList = document.getElementById("held-list")!;
const hintEl = document.getElementById("hint")!;
const settingsBtn = document.getElementById("open-settings") as HTMLButtonElement;

function send<T>(msg: PopupMessage): Promise<T> {
  return ext.runtime.sendMessage(msg) as Promise<T>;
}

/** A retry is in flight; suppress list rebuilds so focus and button state survive. */
let retryPending = false;
/** Signature of the currently rendered held list, so we only rebuild on real change. */
let heldSignature = "";

async function refreshHeld(): Promise<void> {
  const { held } = await send<HeldListReply>({ type: "list-held" });
  heldSection.hidden = held.length === 0;
  // Rebuilding the list every poll destroys keyboard focus and clobbers an
  // in-flight Retry button, so only re-render when the contents actually change
  // and never while a retry is pending.
  const signature = held.map((h) => `${h.id}:${h.reason}`).join("|");
  if (retryPending || signature === heldSignature) return;
  heldSignature = signature;
  heldList.replaceChildren(
    ...held.map((h) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      const date = new Date(h.transcript.endedAt ?? h.failedAt).toISOString().slice(0, 10);
      label.textContent = `${date} ${h.transcript.title} (${h.transcript.segments.length} segments)`;
      const reason = document.createElement("div");
      reason.className = "reason";
      reason.textContent = h.reason;
      label.append(reason);
      const btn = document.createElement("button");
      btn.textContent = "Retry";
      btn.addEventListener("click", async () => {
        retryPending = true;
        btn.disabled = true;
        btn.textContent = "Retrying…";
        try {
          const res = await send<{ ok: boolean; error?: string }>({ type: "retry-held", id: h.id });
          if (!res.ok) {
            btn.disabled = false;
            btn.textContent = "Retry";
          }
        } finally {
          retryPending = false;
        }
        heldSignature = ""; // force a rebuild to reflect the retry outcome
        await refreshHeld();
      });
      li.append(label, btn);
      return li;
    }),
  );
}

function isConfigured(s: Settings): boolean {
  switch (s.provider) {
    case "anthropic":
      return s.anthropic.apiKey.trim() !== "";
    case "openai":
      return s.openai.apiKey.trim() !== "";
    case "bedrock":
      return s.bedrock.apiKey.trim() !== "";
    case "ollama":
      return s.ollama.baseUrl.trim() !== ""; // local Ollama needs a URL, not a key
    default:
      return false;
  }
}

async function refreshHint(): Promise<void> {
  hintEl.hidden = isConfigured(await loadSettings());
}

/** A duration as mm:ss, or h:mm:ss past an hour. */
function clock(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Captured duration, for the recording line. */
function elapsed(since: number): string {
  return clock(Date.now() - since);
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(0);
}

/**
 * The three waits between Meeting End and a finished summary have completely
 * different time profiles, so the phase is named and its own measure shown:
 * merging them into one "Working…" is what makes a slow local model read as a
 * hang. No percentage is ever shown that the engine did not report.
 */
function renderTranscribing(p: TranscriptionProgress | null): void {
  statusEl.className = "capturing";
  if (p?.phase === "model-download") {
    statusEl.textContent = "Downloading the transcription model…";
    // "one-time setup" is load-bearing: without it the user prices every future
    // meeting at this wait and turns the feature off.
    detailEl.textContent =
      p.totalBytes === null
        ? `${megabytes(p.loadedBytes ?? 0)} MB downloaded · one-time setup`
        : `${megabytes(p.loadedBytes ?? 0)} MB of ${megabytes(p.totalBytes)} MB · one-time setup`;
    detailEl.hidden = false;
    // A determinate bar only where the bytes are real.
    barEl.hidden = p.totalBytes === null || p.totalBytes === 0;
    if (!barEl.hidden) barEl.value = ((p.loadedBytes ?? 0) / (p.totalBytes ?? 1)) * 100;
    return;
  }
  statusEl.textContent = "Transcribing audio…";
  barEl.hidden = true;
  if (p && p.processedMs !== null && p.totalMs !== null && p.totalMs > 0) {
    detailEl.textContent = `${clock(p.processedMs)} of ${clock(p.totalMs)} processed`;
    detailEl.hidden = false;
  } else if (p) {
    // The engine reported no measure — elapsed time is honest where a
    // percentage would be invented.
    detailEl.textContent = `${elapsed(p.startedAt)} elapsed · long meetings take a while`;
    detailEl.hidden = false;
  } else {
    detailEl.hidden = true;
  }
}

function render(status: StatusReply): void {
  titleEl.textContent = status.title ?? "";
  // Affordances follow the capture-prompt surface state table: Start only while
  // a Meeting is detected, Stop + Summarize now only while recording.
  startBtn.hidden = status.state !== "detected";
  stopBtn.hidden = status.state !== "recording";
  summarizeBtn.hidden = status.state !== "recording";
  // Skipping degrades rather than loses: the caption-only summary still lands.
  // Never labelled "Cancel", which would imply losing the meeting.
  skipBtn.hidden = status.state !== "transcribing";
  degradedEl.hidden = !(status.state === "done" && status.degraded);
  if (status.state !== "transcribing") {
    detailEl.hidden = true;
    barEl.hidden = true;
  }

  if (status.state === "transcribing") {
    renderTranscribing(status.transcription);
  } else if (status.state === "recording") {
    if (status.captureWarning) {
      statusEl.className = "warning";
      statusEl.textContent = `Recording — storage problem, audio may be incomplete: ${status.captureWarning}`;
    } else if (status.segmentCount === 0) {
      // Captions are no longer the transcript, so their absence no longer costs
      // the meeting — it costs the names on the action items. Still a warning
      // because it is still actionable, and only while there is time to act.
      statusEl.className = "warning";
      statusEl.textContent = "Recording — no captions, so speakers won't be named. Turn captions on.";
    } else {
      statusEl.className = "recording";
      statusEl.textContent = `Recording — ${elapsed(status.recordingStartedAt ?? Date.now())}`;
    }
  } else if (status.state === "detected") {
    statusEl.className = "warning";
    statusEl.textContent = "Meeting detected — not recording.";
  } else if (status.state === "summarizing") {
    statusEl.className = "capturing";
    statusEl.textContent = "Summarizing…";
  } else if (status.state === "done") {
    statusEl.className = "capturing";
    statusEl.textContent = "Summary saved to Downloads/meeting-summaries.";
  } else if (status.state === "failed") {
    statusEl.className = "warning";
    statusEl.textContent = "Summarization failed — transcript held for retry below.";
  } else {
    statusEl.className = "idle";
    statusEl.textContent = "Not in a meeting.";
  }
  // Announce the state to assistive tech: warnings interrupt, everything else is polite.
  regionEl.setAttribute("aria-live", statusEl.className === "warning" ? "assertive" : "polite");
  const waiting = status.state === "transcribing" || status.state === "summarizing";
  regionEl.setAttribute("aria-busy", waiting ? "true" : "false");
}

async function refresh(): Promise<void> {
  render(await send<StatusReply>({ type: "get-status" }));
  await refreshHeld();
}

startBtn.addEventListener("click", async () => {
  render(await send<StatusReply>({ type: "start-capture" }));
});

stopBtn.addEventListener("click", async () => {
  render(await send<StatusReply>({ type: "stop-capture" }));
});

summarizeBtn.addEventListener("click", async () => {
  render(await send<StatusReply>({ type: "summarize-now" }));
});

skipBtn.addEventListener("click", async () => {
  render(await send<StatusReply>({ type: "skip-transcription" }));
});

settingsBtn.addEventListener("click", () => void ext.runtime.openOptionsPage());

void refreshHint();
void refresh();
setInterval(() => void refresh(), 1000);
