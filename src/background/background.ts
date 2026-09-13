// Background event page: owns Transcript accumulation, triggers, artifact
// writes, and badges.
import { TranscriptAccumulator } from "../adapters/accumulator";
import type { Message, StatusReply } from "../messages";
import { artifactFilename } from "../pipeline/filename";
import { summarizeTranscript } from "../pipeline/pipeline";
import { createProviderClient } from "../providers/factory";
import { loadSettings } from "../settings";
import { writeArtifact } from "./artifact-writer";
import { getHeld, holdTranscript, listHeld, releaseHeld, updateHeldReason } from "./held";
import {
  dropSession,
  ensureSession,
  getSession,
  persistSessions,
  sessionToTranscript,
} from "./sessions";

async function updateBadge(tabId: number): Promise<void> {
  const s = await getSession(tabId);
  let text = "";
  let color = "#0e8a16";
  if (s?.inMeeting) {
    if (s.accumulator.size === 0) {
      text = "!";
      color = "#d73a4a"; // in a meeting, no captions arriving
    } else {
      text = s.accumulator.size > 999 ? "999" : String(s.accumulator.size);
    }
  }
  await browser.action.setBadgeBackgroundColor({ color, tabId });
  await browser.action.setBadgeText({ text, tabId });
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
  if (!s || s.state !== "capturing" || s.accumulator.size === 0) return;
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

async function retryHeld(id: string): Promise<void> {
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
}

async function statusFor(tabId: number): Promise<StatusReply> {
  const s = await getSession(tabId);
  return {
    inMeeting: s?.inMeeting ?? false,
    segmentCount: s?.accumulator.size ?? 0,
    title: s?.title ?? null,
    capturing: (s?.inMeeting ?? false) && (s?.accumulator.size ?? 0) > 0,
    state: s?.state ?? "idle",
  };
}

browser.runtime.onMessage.addListener((raw: unknown, sender) => {
  const msg = raw as Message;
  if (sender.tab?.id !== undefined) {
    return handleContentMessage(msg, sender.tab.id);
  }
  // Popup messages
  if (msg.type === "get-status") {
    return (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      return statusFor(tab?.id ?? -1);
    })();
  }
  if (msg.type === "summarize-now") {
    return (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
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

browser.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const s = await getSession(tabId);
    if (s && s.state === "capturing" && s.accumulator.size > 0) {
      await finishMeeting(tabId, "tab-closed");
    }
    await dropSession(tabId);
  })();
});
