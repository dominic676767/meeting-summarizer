// Background event page: owns Transcript accumulation, triggers, artifact
// writes, and badges.
import { ext } from "../platform";
import { TranscriptAccumulator } from "../adapters/accumulator";
import type {
  CaptureStateReply,
  Message,
  OffscreenMessage,
  OffscreenStatusReply,
  StatusReply,
} from "../messages";
import { artifactFilename } from "../pipeline/filename";
import { summarizeTranscript } from "../pipeline/pipeline";
import { createProviderClient } from "../providers/factory";
import { loadSettings } from "../settings";
import { writeArtifact } from "./artifact-writer";
import { deriveCaptureState, isDegraded } from "./capture-state";
import { getHeld, holdTranscript, listHeld, releaseHeld, updateHeldReason } from "./held";
import {
  dropSession,
  ensureSession,
  getSession,
  persistSessions,
  sessionToTranscript,
} from "./sessions";

// MV3 exposes `action`; the MV2 `browserAction` shim is gone with Firefox (ADR-0003).
const action = ext.action;

// --- Audio capture (offscreen document) --------------------------------------
//
// tabCapture requires an explicit extension invocation and hands back a
// single-use stream id that expires within seconds, so the id is obtained here
// on the user's gesture and redeemed immediately in the offscreen document
// (ADR-0004). The service worker owns session state; the offscreen document
// owns the stream, the recorder, and the AudioContext loopback.

/** Only one offscreen document may exist; create it lazily with USER_MEDIA
 * (not AUDIO_PLAYBACK, which self-closes after 30s and would kill a long call). */
async function ensureOffscreenDocument(): Promise<void> {
  if (await ext.offscreen.hasDocument()) return;
  await ext.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record meeting tab audio to transcribe what was actually said.",
  });
}

async function sendToOffscreen(msg: OffscreenMessage): Promise<OffscreenStatusReply> {
  return (await ext.runtime.sendMessage(msg)) as OffscreenStatusReply;
}

/** Promisified stream-id request; must run on the user's invocation for the
 * given tab or Chromium refuses the capture. */
function getMediaStreamId(targetTabId: number): Promise<string> {
  return ext.tabCapture.getMediaStreamId({ targetTabId });
}

async function startCapture(tabId: number): Promise<void> {
  const s = await getSession(tabId);
  if (!s || s.recording) return; // idempotent: one recording per tab
  const streamId = await getMediaStreamId(tabId);
  await ensureOffscreenDocument();
  const recordingId = s.recordingId ?? `${tabId}-${s.startedAt}`;
  const reply = await sendToOffscreen({ type: "offscreen-start", streamId, recordingId });
  if (!reply.recording) {
    // getUserMedia/redeem failed — surface it rather than pretend we started.
    s.captureWarning = reply.error ?? "capture failed to start";
  } else {
    s.recording = true;
    s.recordingStartedAt = reply.startedAt ?? Date.now();
    s.recorded = true;
    s.recordingId = recordingId;
    s.captureWarning = reply.error;
  }
  await persistSessions();
  await updateBadge(tabId);
}

async function stopRecording(tabId: number): Promise<void> {
  const s = await getSession(tabId);
  if (!s) return;
  try {
    await sendToOffscreen({ type: "offscreen-stop" });
    await ext.offscreen.closeDocument().catch(() => undefined);
  } catch {
    // Offscreen already gone (service-worker restart) — the recorder is stopped
    // regardless; the Audio Recording written so far is preserved.
  }
  s.recording = false;
  s.recordingStartedAt = null;
  await persistSessions();
  await updateBadge(tabId);
}

/** The bound Capture Start shortcut, as the user's platform renders it. */
async function startShortcut(): Promise<string | null> {
  try {
    const commands = await ext.commands.getAll();
    const cmd = commands.find((c) => c.name === "start-capture");
    return cmd?.shortcut && cmd.shortcut !== "" ? cmd.shortcut : null;
  } catch {
    return null;
  }
}

async function updateBadge(tabId: number): Promise<void> {
  const s = await getSession(tabId);
  let text = "";
  let color = "#0e8a16";
  if (s?.recording) {
    // Always-visible recording indicator, Alert Red — the user approved red
    // carrying both warning and "live" meanings. Distinct from the caption
    // count, so live audio capture is never mistaken for caption scraping.
    text = "REC";
    color = "#d73a4a";
  } else if (s?.inMeeting) {
    if (s.accumulator.size === 0) {
      text = "!";
      color = "#d73a4a"; // in a meeting, no captions arriving
    } else {
      text = s.accumulator.size > 999 ? "999" : String(s.accumulator.size);
    }
  }
  try {
    await action.setBadgeBackgroundColor({ color, tabId });
    await action.setBadgeText({ text, tabId });
  } catch {
    // Tab already gone (e.g. summarizing on tab close) — cosmetic only,
    // never allowed to abort a summarization.
  }
}

async function handleContentMessage(msg: Message, tabId: number): Promise<void> {
  if (msg.type === "captions-update") {
    const s = await ensureSession(tabId, msg.platform);
    if (msg.title) s.title = msg.title;
    s.accumulator.upsertAll(msg.updates, Date.now());
    await persistSessions();
    await updateBadge(tabId);
  } else if (msg.type === "meeting-status") {
    const s = await ensureSession(tabId, msg.platform);
    if (msg.title) s.title = msg.title;
    s.inMeeting = msg.inMeeting;
    await persistSessions();
    await updateBadge(tabId);
  } else if (msg.type === "meeting-ended") {
    await finishMeeting(tabId, "auto");
  }
}

/**
 * Converging trigger for auto-detect, tab close, and Summarize-now.
 * Idempotent: a Transcript is summarized at most once (double-fire guard —
 * the state test-and-set below is the guard).
 */
export async function finishMeeting(tabId: number, trigger: "auto" | "manual" | "tab-closed") {
  const s = await getSession(tabId);
  if (!s) return;
  // Meeting End stops the recorder before the summarization sequence runs, and
  // regardless of whether a caption summary follows, so the Audio Recording is
  // always closed cleanly.
  if (s.recording) await stopRecording(tabId);
  if (s.state !== "capturing" || s.accumulator.size === 0) return;
  s.state = "summarizing";
  await persistSessions();
  await updateBadge(tabId);

  const transcript = sessionToTranscript(s);
  try {
    await summarizeAndWrite(transcript);
    // Nothing is retained after the artifact is written (spec: single artifact).
    s.state = "done";
    s.accumulator = new TranscriptAccumulator();
    await persistSessions();
  } catch (err) {
    console.error(`meeting-summarizer: summarization failed (${trigger})`, err);
    // A Transcript is unrecoverable once dropped — hold it for retry.
    await holdTranscript(transcript, err instanceof Error ? err.message : String(err));
    s.state = "failed";
    await persistSessions();
  }
  await updateBadge(tabId);
}

/** Shared by first-run and Held-Transcript retry: pipeline → confirmed write. */
async function summarizeAndWrite(transcript: Parameters<typeof summarizeTranscript>[0]) {
  const settings = await loadSettings();
  const client = createProviderClient(settings);
  const { html } = await summarizeTranscript(transcript, settings, client);
  await writeArtifact(html, artifactFilename(transcript));
}

// Guard against concurrent retries of the same Held Transcript (double-click,
// popup re-open) producing duplicate artifacts.
const retriesInFlight = new Set<string>();

async function retryHeld(id: string): Promise<void> {
  if (retriesInFlight.has(id)) return;
  retriesInFlight.add(id);
  try {
    const entry = await getHeld(id);
    if (!entry) return;
    try {
      await summarizeAndWrite(entry.transcript);
      // Release ONLY after the downloads API confirmed the write.
      await releaseHeld(id);
    } catch (err) {
      await updateHeldReason(id, err instanceof Error ? err.message : String(err));
      throw err;
    }
  } finally {
    retriesInFlight.delete(id);
  }
}

async function statusFor(tabId: number): Promise<StatusReply> {
  const s = await getSession(tabId);
  let captureWarning = s?.captureWarning ?? null;
  // Poll the offscreen recorder while live so a quota failure that develops
  // mid-recording surfaces as a warning rather than a silent stop.
  if (s?.recording) {
    try {
      const os = await sendToOffscreen({ type: "offscreen-status" });
      if (os.error) captureWarning = os.error;
    } catch {
      // Offscreen not reachable — leave the last known warning in place.
    }
  }
  return {
    inMeeting: s?.inMeeting ?? false,
    segmentCount: s?.accumulator.size ?? 0,
    title: s?.title ?? null,
    capturing: (s?.inMeeting ?? false) && (s?.accumulator.size ?? 0) > 0,
    state: deriveCaptureState({
      sessionState: s?.state,
      inMeeting: s?.inMeeting ?? false,
      recording: s?.recording ?? false,
      recorded: s?.recorded ?? false,
    }),
    recording: s?.recording ?? false,
    recordingStartedAt: s?.recordingStartedAt ?? null,
    degraded: isDegraded({ recorded: s?.recorded ?? false }),
    captureWarning,
  };
}

function captureStateFor(tabId: number): Promise<CaptureStateReply> {
  return (async () => {
    const s = await getSession(tabId);
    return {
      state: deriveCaptureState({
        sessionState: s?.state,
        inMeeting: s?.inMeeting ?? false,
        recording: s?.recording ?? false,
        recorded: s?.recorded ?? false,
      }),
      title: s?.title ?? null,
      recording: s?.recording ?? false,
      recordingStartedAt: s?.recordingStartedAt ?? null,
      dismissed: s?.promptDismissed ?? false,
      shortcut: await startShortcut(),
    };
  })();
}

async function dismissPrompt(tabId: number): Promise<void> {
  const s = await getSession(tabId);
  if (!s) return;
  s.promptDismissed = true;
  await persistSessions();
}

ext.runtime.onMessage.addListener((raw: unknown, sender) => {
  const msg = raw as Message;
  const senderTabId = sender.tab?.id;
  if (senderTabId !== undefined) {
    // The in-page prompt asks per-tab; these need a reply.
    if (msg.type === "get-capture-state") return captureStateFor(senderTabId);
    if (msg.type === "dismiss-prompt") {
      return (async () => {
        await dismissPrompt(senderTabId);
        return { ok: true };
      })();
    }
    return handleContentMessage(msg, senderTabId);
  }
  // Popup messages
  if (msg.type === "get-status") {
    return (async () => {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      return statusFor(tab?.id ?? -1);
    })();
  }
  if (msg.type === "start-capture") {
    return (async () => {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) await startCapture(tab.id);
      return statusFor(tab?.id ?? -1);
    })();
  }
  if (msg.type === "stop-capture") {
    return (async () => {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) await stopRecording(tab.id);
      return statusFor(tab?.id ?? -1);
    })();
  }
  if (msg.type === "summarize-now") {
    return (async () => {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) await finishMeeting(tab.id, "manual");
      return statusFor(tab?.id ?? -1);
    })();
  }
  if (msg.type === "list-held") {
    return (async () => ({ held: await listHeld() }))();
  }
  if (msg.type === "retry-held") {
    return (async () => {
      try {
        await retryHeld(msg.id);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })();
  }
  return undefined;
});

// A keyboard command is a real extension invocation, so — unlike a click on an
// in-page button — it can grant tabCapture (ADR-0004). This is why the in-page
// prompt only summons the gesture instead of offering a Start button.
ext.commands.onCommand.addListener((command, tab) => {
  if (command !== "start-capture") return;
  void (async () => {
    const id = tab?.id ?? (await ext.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (id !== undefined) await startCapture(id);
  })();
});

ext.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const s = await getSession(tabId);
    if (s?.recording) await stopRecording(tabId);
    if (s && s.state === "capturing" && s.accumulator.size > 0) {
      await finishMeeting(tabId, "tab-closed");
    }
    await dropSession(tabId);
  })();
});
