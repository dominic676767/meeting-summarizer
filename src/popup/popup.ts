// Popup: live capture status, Summarize now, Held Transcript retry.
import { ext } from "../platform";
import type {
  HeldListReply,
  PopupMessage,
  StatusReply,
  TranscriptionProgress,
} from "../messages";
import type { Settings } from "../domain/types";
import type { MicCaptureState } from "../background/mic-capture";
import { loadAwsCredentials, loadSettings } from "../settings";
import { credentialsWarning, type AwsCredentials } from "../transcription/aws-credentials";
import {
  TRANSCRIPTION_ENGINE_NAMES,
  uploadDestination,
  uploadsAudio,
} from "../transcription/engines";

const regionEl = document.getElementById("status-region")!;
const statusEl = document.getElementById("status")!;
const detailEl = document.getElementById("detail")!;
const barEl = document.getElementById("model-progress") as HTMLProgressElement;
const titleEl = document.getElementById("title")!;
const degradedEl = document.getElementById("degraded")!;
const micEl = document.getElementById("mic")!;
const micDisclosureEl = document.getElementById("mic-disclosure")!;
const micWhyEl = document.getElementById("mic-why")!;
const micOnBtn = document.getElementById("mic-on") as HTMLButtonElement;
const micOffBtn = document.getElementById("mic-off") as HTMLButtonElement;
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

/**
 * The microphone line, per state.
 *
 * All Muted supporting text, none of it Alert Red. A microphone switched off is a
 * deliberate choice and gets no notice at all; one that could not be used is a
 * fact about this recording rather than something the user can fix mid-meeting,
 * and the meeting is still being captured either way. The raw Chromium reason
 * never reaches the visible line — it goes in the tooltip.
 *
 * `unconfirmed` is absent because the disclosure below carries it, and `recording`
 * is the one state the *status* line has to state, because "recording the meeting"
 * and "recording the meeting and you" are different facts.
 */
const MIC_LINE: Partial<Record<MicCaptureState, string>> = {
  armed: "Microphone enabled. Chrome access is required before recording.",
  recording: "Microphone on — your side of the meeting is being recorded too.",
  unavailable: "Your microphone could not be used — recording the meeting audio only.",
};

/**
 * Why including the microphone is reasonable, in the same breath as the ask.
 *
 * Two variants, because the sentence that earns a yes is only true of the local
 * engine: "everything is transcribed on this machine" is what makes handing over a
 * microphone acceptable for a member of the public, and it is false the moment a
 * cloud Transcription Provider is selected — which is exactly when recording your
 * own voice matters most. The destination is named rather than called "the cloud",
 * and no retention promise is made, because this product does not control what a
 * third party does with the audio.
 */
function micWhy(s: Settings): string {
  if (s.transcription.provider === "local-whisper") {
    return "Your voice is not recorded yet. Including it means the summary covers your side of the meeting too — everything is transcribed on this machine.";
  }
  return `Your voice is not recorded yet. Including it means the summary covers your side of the meeting too — and because you have chosen ${TRANSCRIPTION_ENGINE_NAMES[s.transcription.provider]} to transcribe, the recording, including your voice, is uploaded to ${uploadDestination(s.transcription.provider)} to be transcribed.`;
}


// Bind controls to the tab in the window that opened this popup. A service-worker
// active-tab query can resolve to a different Zoom window.
const popupTabId = ext.tabs
  .query({ active: true, currentWindow: true })
  .then(([tab]) => tab?.id ?? null)
  .catch(() => null);

async function send<T>(msg: PopupMessage): Promise<T> {
  switch (msg.type) {
    case "get-status":
    case "start-capture":
    case "stop-capture":
    case "summarize-now":
    case "skip-transcription":
    case "set-mic-capture": {
      const tabId = await popupTabId;
      if (tabId === null) throw new Error("Open the extension from the meeting tab.");
      return ext.runtime.sendMessage({ ...msg, tabId }) as Promise<T>;
    }
    default:
      return ext.runtime.sendMessage(msg) as Promise<T>;
  }
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
      // A rejected message — closed channel, service worker restarting — used
      // to escape here and strand the button disabled on "Retrying…" forever,
      // skipping the refresh below. The one control that recovers the meeting
      // has to survive its own transport failing.
      const res = await opts.retry().catch((err: unknown) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = opts.retryLabel;
        if (res.error) reason.textContent = res.error;
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
  const s = await loadSettings();
  hintEl.hidden = isConfigured(s);
  uploadingTo = uploadsAudio(s.transcription.provider)
    ? TRANSCRIPTION_ENGINE_NAMES[s.transcription.provider]
    : null;
  sageMaker =
    s.transcription.provider === "sagemaker" ? { credentials: await loadAwsCredentials() } : null;
}

/**
 * The cloud engine a transcription is sent to, or null for the local one. Read
 * with the rest of the settings; the run itself reads the same settings when it
 * starts, so this names where the audio actually went.
 */
let uploadingTo: string | null = null;

/**
 * The SageMaker engine's credentials when it is the one selected, read when the
 * popup opens. Their expiry is checked on every render, so a popup left open
 * still warns once they run out.
 */
let sageMaker: { credentials: AwsCredentials | null } | null = null;

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
  barEl.hidden = true;
  const measured = p !== null && p.processedMs !== null && p.totalMs !== null && p.totalMs > 0;
  // A cloud engine reports nothing until a whole upload comes back — an hour of
  // audio can be one. Saying where the audio went is true the whole time; a
  // percentage would be invented.
  statusEl.textContent =
    uploadingTo && !measured ? `Uploading to ${uploadingTo} to transcribe…` : "Transcribing audio…";
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
  // The disclosure is asked while there is still something to change: before
  // capture starts, and during it, because a Meeting recorded without the user's
  // voice can still have its next Capture Span include it.
  const inMeeting = status.state === "detected" || status.state === "recording";
  micDisclosureEl.hidden = !(inMeeting && status.mic === "unconfirmed");
  // Only before capture starts: these sentences are in the future tense, and once
  // recording the status line states the microphone in the present tense instead.
  const micLine = status.state === "detected" ? MIC_LINE[status.mic] : undefined;
  micEl.hidden = micLine === undefined;
  if (micLine !== undefined) micEl.textContent = micLine;

  if (status.state === "transcribing") {
    renderTranscribing(status.transcription);
  } else if (status.state === "recording") {
    if (status.captureWarning) {
      // The producer's own copy, rendered visibly. Hardcoding a sentence here
      // meant one problem's warning was displayed for another's — a silent
      // microphone reported as "some audio could not be saved". The raw reason
      // goes to the tooltip; the sentence the user must act on does not.
      statusEl.className = "warning";
      statusEl.textContent = status.captureWarning.message;
      if (status.captureWarning.detail) statusEl.title = status.captureWarning.detail;
    } else if (status.mic === "unavailable") {
      // Above the no-captions warning on purpose: missing captions cost the names
      // on the action items, a missing microphone costs half the words.
      statusEl.className = "warning";
      statusEl.textContent =
        "Recording the other participants only — your microphone could not be used, so your own words will be missing.";
      if (status.micDetail) statusEl.title = status.micDetail;
    } else if (status.mic === "unconfirmed") {
      statusEl.className = "warning";
      statusEl.textContent =
        "Recording the other participants only — your own words will be missing until you answer below.";
    } else if (sageMaker && credentialsWarning(sageMaker.credentials, Date.now()) !== null) {
      // Below the microphone on purpose: a voice that was not recorded is lost,
      // while audio held for want of credentials can still be retried. Above the
      // captions, because without credentials there are no audio words at all.
      statusEl.className = "warning";
      statusEl.textContent = credentialsWarning(sageMaker.credentials, Date.now()) ?? "";
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
      //
      // The microphone is named in the words, not in a second colour or a glyph:
      // "recording" and "recording you as well" are different facts, and the user
      // must be able to read which one is true at a glance and hear it read out.
      statusEl.className = "recording";
      statusEl.replaceChildren(
        Object.assign(document.createElement("span"), {
          className: "rec-dot",
          ariaHidden: "true",
        }),
        document.createTextNode(
          `Recording, microphone ${status.mic === "recording" ? "on" : "off"} — ${elapsed(status.recordingStartedAt ?? Date.now())}`,
        ),
      );
    }
  } else if (status.state === "detected") {
    statusEl.className = "warning";
    // A capture that failed to start leaves this state with a reason attached.
    // Saying only "not recording" would strand the user with no way to know why.
    statusEl.textContent = status.captureWarning
      ? status.captureWarning.message
      : "Meeting detected — not recording.";
    if (status.captureWarning?.detail) statusEl.title = status.captureWarning.detail;
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
  // Deliberately no aria-busy here. It was set for the whole transcribe and
  // summarize wait, which tells assistive tech "these updates are not ready to
  // announce" — suppressing the very phase changes this region exists to
  // report. The long wait is conveyed by naming the phase, not by a busy flag.
}

async function refresh(): Promise<void> {
  render(await send<StatusReply>({ type: "get-status" }));
  await refreshHeld();
}

/**
 * Runs a capture action with the button disabled until it answers.
 *
 * Without this, a slow reply left the control enabled and the status unchanged,
 * so a second click dispatched a second `start-capture` — and the user had no
 * signal that the first one was doing anything. A transport failure is shown
 * rather than swallowed, and the poll below re-renders the true state either
 * way, so this never leaves a button stuck on a state the background disagrees
 * with.
 */
function onAction(btn: HTMLButtonElement, msg: PopupMessage, pendingLabel: string): void {
  const label = btn.textContent ?? "";
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = pendingLabel;
    try {
      render(await send<StatusReply>(msg));
    } catch (err) {
      statusEl.className = "warning";
      statusEl.textContent = `That didn't go through: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

onAction(startBtn, { type: "start-capture" }, "Starting…");
onAction(stopBtn, { type: "stop-capture" }, "Stopping…");
onAction(summarizeBtn, { type: "summarize-now" }, "Summarizing…");
onAction(skipBtn, { type: "skip-transcription" }, "Skipping…");

// Either answer settles the disclosure, so the notice stops asking. Declining is
// a real answer and is offered as plainly as accepting: a choice presented with
// only one button is not a choice.
onAction(micOnBtn, { type: "set-mic-capture", enabled: true }, "Saving…");
onAction(micOffBtn, { type: "set-mic-capture", enabled: false }, "Saving…");

settingsBtn.addEventListener("click", () => void ext.runtime.openOptionsPage());

void refreshHint();
void refresh();
setInterval(() => void refresh(), 1000);
