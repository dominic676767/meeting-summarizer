// Background event page: owns Transcript accumulation, triggers, artifact
// writes, and badges.
import { ext } from "../platform";
import { TranscriptAccumulator } from "../adapters/accumulator";
import type {
  CaptureStateReply,
  Message,
  OffscreenMessage,
  OffscreenStatusReply,
  OffscreenTranscribeReply,
  StatusReply,
} from "../messages";
import type { HeldRecording, Utterance } from "../domain/types";
import { artifactFilename } from "../pipeline/filename";
import { summarizeTranscript } from "../pipeline/pipeline";
import { createProviderClient } from "../providers/factory";
import { loadSettings } from "../settings";
import { fuseTranscript } from "../transcription/fusion";
import { writeArtifact } from "./artifact-writer";
import { deriveCaptureState, isDegraded } from "./capture-state";
import { getHeld, holdTranscript, listHeld, releaseHeld, updateHeldReason } from "./held";
import {
  getHeldRecording,
  holdRecording,
  listHeldRecordings,
  releaseHeldRecording,
  updateHeldRecordingReason,
} from "./held-recordings";
import {
  dropSession,
  ensureSession,
  getSession,
  persistSessions,
  sessionToTranscript,
  type MeetingSession,
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
 * (not AUDIO_PLAYBACK, which self-closes after 30s and would kill a long call)
 * plus WORKERS, because the same document later runs the local Whisper worker. */
async function ensureOffscreenDocument(): Promise<void> {
  if (await ext.offscreen.hasDocument()) return;
  await ext.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "WORKERS"],
    justification: "Record meeting tab audio and transcribe what was actually said.",
  });
}

async function closeOffscreenDocument(): Promise<void> {
  try {
    if (await ext.offscreen.hasDocument()) await ext.offscreen.closeDocument();
  } catch {
    // Already gone; nothing to release.
  }
}

async function sendToOffscreen(msg: OffscreenMessage): Promise<OffscreenStatusReply> {
  return (await ext.runtime.sendMessage(msg)) as OffscreenStatusReply;
}

/** One offscreen document serves every tab, so a retry that finishes while
 * another Meeting is recording must leave it standing or it destroys that
 * Meeting's Audio Recording. */
async function closeOffscreenUnlessRecording(): Promise<void> {
  try {
    if ((await sendToOffscreen({ type: "offscreen-status" })).recording) return;
  } catch {
    // Unreachable — closing is what we wanted anyway.
  }
  await closeOffscreenDocument();
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
    s.recordingFrom = s.recordingStartedAt;
    s.captureWarning = reply.error;
  }
  await persistSessions();
  await updateBadge(tabId);
}

/** `keepOffscreen` when transcription follows immediately: the same document
 * owns the Whisper worker, and tearing it down only to recreate it would throw
 * away the audio decode context for nothing. */
async function stopRecording(tabId: number, keepOffscreen = false): Promise<void> {
  const s = await getSession(tabId);
  if (!s) return;
  try {
    await sendToOffscreen({ type: "offscreen-stop" });
    if (!keepOffscreen) await closeOffscreenDocument();
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
  // Meeting End stops the recorder before the transcribe → summarize sequence
  // runs, and regardless of whether audio was captured, so the Audio Recording
  // is always closed cleanly.
  if (s.recording) await stopRecording(tabId, s.recorded);
  if (s.state !== "capturing") return;
  // Audio alone can carry the Meeting: captions that were never turned on cost
  // speaker names, not the meeting.
  if (s.accumulator.size === 0 && !s.recorded) return;

  const captionTranscript = sessionToTranscript(s);
  let transcript = captionTranscript;

  if (s.recorded && s.recordingId) {
    s.state = "transcribing";
    s.transcription = null;
    await persistSessions();
    await updateBadge(tabId);
    const outcome = await transcribeRecording(tabId, s);
    s.transcription = null;
    // Words from the recording replace the caption words wholesale — that is
    // the point of v2 — while the captions live on as the Speaker Track fusion
    // takes the names from.
    s.audioWords = outcome.utterances.length > 0;
    if (s.audioWords) {
      transcript = fuseTranscript(captionTranscript, outcome.utterances);
    } else if (!outcome.cancelled) {
      // A transcription outage must cost a retry, not the meeting: hold the
      // Audio Recording so the user can retry it — after switching Transcription
      // Provider if that is what it takes. The caption-only summary below still
      // lands, so the outage costs accuracy now rather than everything.
      await holdRecording(
        {
          recordingId: s.recordingId,
          transcript: captionTranscript,
          startOffsetMs: captureStartOffset(s),
        },
        outcome.error ?? "transcription produced no words",
      );
    }
  }

  if (transcript.segments.length === 0) {
    // Nothing was said, or nothing reached us. Not a failure and nothing to
    // hold — leave the session as it was so a later trigger can still act.
    s.state = "capturing";
    await persistSessions();
    await updateBadge(tabId);
    return;
  }

  s.state = "summarizing";
  await persistSessions();
  await updateBadge(tabId);

  try {
    await summarizeAndWrite(transcript);
    // Nothing is retained after the artifact is written (spec: single artifact),
    // and that includes the audio — recordings must not accumulate on disk.
    s.state = "done";
    s.accumulator = new TranscriptAccumulator();
    await persistSessions();
    if (s.recordingId) await discardRecording(s.recordingId);
  } catch (err) {
    console.error(`meeting-summarizer: summarization failed (${trigger})`, err);
    // A Transcript is unrecoverable once dropped — hold it for retry, together
    // with the recording it came from so the audio survives until an artifact
    // for it is actually written.
    await holdTranscript(transcript, reasonOf(err), s.recordingId ?? undefined);
    s.state = "failed";
    await persistSessions();
  }
  await closeOffscreenDocument();
  await updateBadge(tabId);
}

/** ms from the Meeting start to Capture Start — the distance that keeps Utterance
 * offsets absolute relative to the Meeting rather than to the recording. */
function captureStartOffset(s: MeetingSession): number {
  return Math.max(0, (s.recordingFrom ?? s.startedAt) - s.startedAt);
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Hands the Audio Recording to the Transcription Provider and waits. No
 * Utterances means the Meeting falls back to caption words rather than being
 * lost, which is the one outcome this product may not produce — but the caller
 * still needs to tell a failure (hold the audio for retry) from the user
 * choosing captions over the wait (nothing went wrong, nothing to retry).
 */
async function transcribeRecording(
  tabId: number,
  s: MeetingSession,
): Promise<OffscreenTranscribeReply> {
  if (!s.recordingId) return { utterances: [], cancelled: false, error: "no recording" };
  try {
    const settings = await loadSettings();
    await ensureOffscreenDocument();
    const reply = (await ext.runtime.sendMessage({
      type: "offscreen-transcribe",
      recordingId: s.recordingId,
      model: settings.transcription.localWhisper.model,
      startOffsetMs: captureStartOffset(s),
      tabId,
    } satisfies OffscreenMessage)) as OffscreenTranscribeReply;
    if (reply.error) console.error(`meeting-summarizer: transcription failed: ${reply.error}`);
    return reply;
  } catch (err) {
    console.error("meeting-summarizer: transcription failed", err);
    return { utterances: [], cancelled: false, error: reasonOf(err) };
  }
}

/**
 * Delete an Audio Recording, once its Summary Artifact is written, so recordings
 * never accumulate on the user's disk. A recording still held for a transcription
 * retry is exempt: that retry is the only thing that can still turn this Meeting
 * into an accurate Transcript, and it needs the audio to do it.
 */
async function discardRecording(recordingId: string): Promise<void> {
  if (await getHeldRecording(recordingId)) return;
  try {
    await ensureOffscreenDocument();
    await ext.runtime.sendMessage({ type: "offscreen-discard-recording", recordingId });
  } catch {
    // The audio stays where it is; nothing depends on the deletion succeeding.
  }
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
      // Same confirmation releases the audio: the Meeting's single artifact
      // exists, so nothing is left for the recording to serve.
      if (entry.recordingId) await discardRecording(entry.recordingId);
    } catch (err) {
      await updateHeldReason(id, reasonOf(err));
      throw err;
    }
  } finally {
    retriesInFlight.delete(id);
  }
}

// Guard against concurrent retries of the same Held Recording (double-click,
// popup re-open) producing duplicate artifacts, exactly as the Held Transcript
// retry does.
const recordingRetriesInFlight = new Set<string>();

/**
 * Retries transcription of a Held Recording and hands the result on.
 *
 * Settings are read now rather than remembered from the failed run, which is
 * what lets a user switch Transcription Provider and recover a Meeting the first
 * choice could not handle. The Transcript is held *before* the recording is
 * released, so no failure window exists in which the audio is gone and nothing
 * durable has taken its place.
 */
async function retryHeldRecording(recordingId: string): Promise<void> {
  if (recordingRetriesInFlight.has(recordingId)) return;
  recordingRetriesInFlight.add(recordingId);
  try {
    const entry = await getHeldRecording(recordingId);
    if (!entry) return;
    let utterances: Utterance[];
    try {
      utterances = await transcribeHeldRecording(entry);
    } catch (err) {
      await updateHeldRecordingReason(recordingId, reasonOf(err));
      throw err;
    }
    const transcript = fuseTranscript(entry.transcript, utterances);
    const held = await holdTranscript(transcript, "transcribed, summary pending", recordingId);
    await releaseHeldRecording(recordingId);
    // From here the Held Transcript machinery owns the rest of the chain,
    // including deleting the audio once the artifact write is confirmed.
    await retryHeld(held.id);
  } finally {
    recordingRetriesInFlight.delete(recordingId);
  }
}

/** Transcription under whatever settings are current, with every non-result
 * turned into a throw: the caller's job is to keep the audio held. */
async function transcribeHeldRecording(entry: HeldRecording): Promise<Utterance[]> {
  const settings = await loadSettings();
  await ensureOffscreenDocument();
  try {
    const reply = (await ext.runtime.sendMessage({
      type: "offscreen-transcribe",
      recordingId: entry.recordingId,
      model: settings.transcription.localWhisper.model,
      startOffsetMs: entry.startOffsetMs,
      // No live session owns a retried Meeting, so progress has no session to
      // land on; the popup reports the retry on the row the user clicked.
      tabId: -1,
    } satisfies OffscreenMessage)) as OffscreenTranscribeReply;
    if (reply.error) throw new Error(reply.error);
    if (reply.cancelled) throw new Error("transcription cancelled");
    if (reply.utterances.length === 0) throw new Error("transcription produced no words");
    return reply.utterances;
  } finally {
    await closeOffscreenUnlessRecording();
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
    degraded: isDegraded({ recorded: s?.recorded ?? false, audioWords: s?.audioWords ?? null }),
    captureWarning,
    transcription: s?.transcription ?? null,
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
  // The offscreen document pushes progress while it transcribes; it carries the
  // tab id because a service-worker restart forgets which Meeting is waiting.
  if (msg.type === "transcription-progress") {
    return (async () => {
      const s = await getSession(msg.tabId);
      if (s) s.transcription = msg.progress;
      return { ok: true };
    })();
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
  if (msg.type === "skip-transcription") {
    return (async () => {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      try {
        await ext.runtime.sendMessage({ type: "offscreen-cancel-transcribe" });
      } catch {
        // Offscreen already gone — the wait is over either way.
      }
      return statusFor(tab?.id ?? -1);
    })();
  }
  if (msg.type === "list-held") {
    return (async () => ({ held: await listHeld(), recordings: await listHeldRecordings() }))();
  }
  if (msg.type === "retry-held") {
    return (async () => {
      try {
        await retryHeld(msg.id);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: reasonOf(err) };
      }
    })();
  }
  if (msg.type === "retry-held-recording") {
    return (async () => {
      try {
        await retryHeldRecording(msg.recordingId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: reasonOf(err) };
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
    if (s && s.state === "capturing" && (s.accumulator.size > 0 || s.recorded)) {
      await finishMeeting(tabId, "tab-closed");
    } else if (s?.recording) {
      await stopRecording(tabId);
    }
    await dropSession(tabId);
  })();
});
