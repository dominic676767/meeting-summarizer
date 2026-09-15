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
const recordingSection = document.getElementById("held-recordings")!;
const recordingList = document.getElementById("held-recording-list")!;
const hintEl = document.getElementById("hint")!;
const settingsBtn = document.getElementById("open-settings") as HTMLButtonElement;

/**
 * The Degraded Capture line, in the two forms it honestly takes. The first is
 * every other cause — no audio recorded, transcription failed, the wait skipped
 * — and matches the markup's default. The second is a recording that was
 * transcribed and carried no speech: still not an error, but a fact the user
 * would otherwise have to guess at.
 */
const DEGRADED_NO_AUDIO_WORDS = "Captions only — the summary was not built from recorded audio.";
const DEGRADED_NO_SPEECH = "Captions only — the recording carried no speech.";

function send<T>(msg: PopupMessage): Promise<T> {
  return ext.runtime.sendMessage(msg) as Promise<T>;
}

/** A retry is in flight; suppress list rebuilds so focus and button state survive. */
let retryPending = false;
/** Signatures of the rendered lists, so we only rebuild on real change. */
let heldSignature = "";
let recordingSignature = "";

/**
 * One row of a held list. The button label is the row's whole distinction once it
 * is read aloud, so it names the work the retry does — re-running a summary and
 * transcribing audio are different actions and must not both read "Retry".
 */
function heldRow(opts: {
  label: string;
  reason: string;
  retryLabel: string;
  pendingLabel: string;
  retry: () => Promise<{ ok: boolean; error?: string }>;
}): HTMLLIElement {
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = opts.label;
  const reason = document.createElement("div");
  reason.className = "reason";
  reason.textContent = opts.reason;
  label.append(reason);
  const btn = document.createElement("button");
  btn.textContent = opts.retryLabel;
  btn.addEventListener("click", async () => {
    retryPending = true;
    btn.disabled = true;
    btn.textContent = opts.pendingLabel;
    try {
      const res = await opts.retry();
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = opts.retryLabel;
      }
    } finally {
      retryPending = false;
    }
    // Force a rebuild of both lists: a recovered recording leaves this list and
    // its Transcript may land in the other.
    heldSignature = "";
    recordingSignature = "";
    await refreshHeld();
  });
  li.append(label, btn);
  return li;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function refreshHeld(): Promise<void> {
  const { held, recordings } = await send<HeldListReply>({ type: "list-held" });
  heldSection.hidden = held.length === 0;
  recordingSection.hidden = recordings.length === 0;
  // Rebuilding a list every poll destroys keyboard focus and clobbers an
  // in-flight Retry button, so only re-render when the contents actually change
  // and never while a retry is pending.
  if (retryPending) return;

  const signature = held.map((h) => `${h.id}:${h.reason}`).join("|");
  if (signature !== heldSignature) {
    heldSignature = signature;
    heldList.replaceChildren(
      ...held.map((h) =>
        heldRow({
          label: `${day(h.transcript.endedAt ?? h.failedAt)} ${h.transcript.title} (${h.transcript.segments.length} segments)`,
          reason: h.reason,
          retryLabel: "Retry",
          pendingLabel: "Retrying…",
          retry: () => send<{ ok: boolean; error?: string }>({ type: "retry-held", id: h.id }),
        }),
      ),
    );
  }

  const recordingSig = recordings.map((r) => `${r.recordingId}:${r.reason}`).join("|");
  if (recordingSig !== recordingSignature) {
    recordingSignature = recordingSig;
    recordingList.replaceChildren(
      ...recordings.map((r) =>
        heldRow({
          label: `${day(r.transcript.endedAt ?? r.failedAt)} ${r.transcript.title}`,
          reason: r.reason,
          // Retrying is worth offering precisely because the engine can be
          // changed first: Settings, then this button.
          retryLabel: "Retry transcription",
          pendingLabel: "Transcribing…",
          retry: () =>
            send<{ ok: boolean; error?: string }>({
              type: "retry-held-recording",
              recordingId: r.recordingId,
            }),
        }),
      ),
    );
  }
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
  // Cleared every render: a stale tooltip would keep explaining a problem that
  // is no longer happening.
  statusEl.title = "";
  degradedEl.hidden = !(status.state === "done" && status.degraded);
  // Both lines are Muted supporting text, never Alert Red: a caption-only
  // summary is a normal outcome, not a fault. Where the recording was silent the
  // user is told *why* it is caption-only, so an audio recording that yielded
  // nothing does not read as the tool having ignored it.
  if (!degradedEl.hidden) {
    degradedEl.textContent = status.noSpeech ? DEGRADED_NO_SPEECH : DEGRADED_NO_AUDIO_WORDS;
  }
  if (status.state !== "transcribing") {
    detailEl.hidden = true;
    barEl.hidden = true;
  }

  if (status.state === "transcribing") {
    renderTranscribing(status.transcription);
  } else if (status.state === "recording") {
    if (status.captureWarning) {
      // Name the problem and say what survives it, rather than appending a raw
      // internal reason to user-facing copy. Recording genuinely continues
      // after a failed chunk write, so this must not claim it stopped.
      statusEl.className = "warning";
      statusEl.textContent =
        "Recording — some audio could not be saved. Captions are still being captured, so a summary will still land.";
      statusEl.title = status.captureWarning;
    } else if (status.segmentCount === 0) {
      // Captions are no longer the transcript, so their absence no longer costs
      // the meeting — it costs the names on the action items. Still a warning
      // because it is still actionable, and only while there is time to act.
      statusEl.className = "warning";
      statusEl.textContent = "Recording — no captions, so speakers won't be named. Turn captions on.";
    } else {
      // Text-or-Dot: recording is a red dot beside Ink text, never red type —
      // red type means a warning to act on. The dot is decorative to assistive
      // tech because the adjacent words already say "Recording".
      statusEl.className = "recording";
      statusEl.replaceChildren(
        Object.assign(document.createElement("span"), {
          className: "rec-dot",
          ariaHidden: "true",
        }),
        document.createTextNode(`Recording — ${elapsed(status.recordingStartedAt ?? Date.now())}`),
      );
    }
  } else if (status.state === "detected") {
    statusEl.className = "warning";
    // A capture that failed to start leaves this state with a reason attached.
    // Saying only "not recording" would strand the user with no way to know why.
    statusEl.textContent = status.captureWarning
      ? "Meeting detected — recording could not start."
      : "Meeting detected — not recording.";
    if (status.captureWarning) statusEl.title = status.captureWarning;
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
