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
import type { CaptureSpan, HeldRecording, Settings, Utterance } from "../domain/types";
import { artifactFilename } from "../pipeline/filename";
import { summarizeTranscript } from "../pipeline/pipeline";
import { createProviderClient } from "../providers/factory";
import { loadAwsCredentials, loadSettings, saveSettings } from "../settings";
import type { AwsCredentials } from "../transcription/aws-credentials";
import { fuseTranscript } from "../transcription/fusion";
import { writeArtifact } from "./artifact-writer";
import { deriveCaptureState, isDegraded } from "./capture-state";
import {
  clearSilenceWarning,
  foldAnySignal,
  MIC_REVOKED_WARNING,
  NOTHING_CAPTURED_WARNING,
  refuseAudioAsSilent,
  silenceWarning,
} from "./capture-signal";
import { foldLocalMicrophone, micCaptureState, shouldCaptureMic } from "./mic-capture";
import { prepareMicrophoneAccess } from "./microphone-access";
import { badgeFor } from "./badge";
import { beginSpan, orderedSpans, spanIdsOf } from "./capture-spans";
import { isMeetingUrl } from "./meeting-url";
import { TRANSCRIPTION_ENGINE_NAMES } from "../transcription/engines";
import { restoreMeetingContentScripts } from "./restore-content";
import { getHeld, holdTranscript, listHeld, releaseHeld, updateHeldReason } from "./held";
import {
  getHeldRecording,
  holdRecording,
  listHeldRecordings,
  releaseHeldRecording,
  updateHeldRecordingReason,
} from "./held-recordings";
import {
  allSessions,
  dropSession,
  ensureSession,
  getSession,
  hasRecording,
  isRecoveredSession,
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
let offscreenOperations: Promise<void> = Promise.resolve();

function queueOffscreen<T>(operation: () => Promise<T>): Promise<T> {
  const next = offscreenOperations.then(operation, operation);
  offscreenOperations = next.then(() => undefined, () => undefined);
  return next;
}

async function ensureOffscreenDocument(): Promise<void> {
  await queueOffscreen(async () => {
    if (await ext.offscreen.hasDocument()) return;
    await ext.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA", "WORKERS"],
      justification:
        "Record the meeting's audio and the user's microphone, and transcribe what was actually said.",
    });
  });
}

async function sendToOffscreen(msg: OffscreenMessage): Promise<OffscreenStatusReply> {
  return (await ext.runtime.sendMessage(msg)) as OffscreenStatusReply;
}

/** The offscreen document serves all meeting tabs. Close it only when no
 * capture is starting and no recording or transcription is in progress. */
async function closeOffscreenUnlessRecording(): Promise<void> {
  await queueOffscreen(async () => {
    if (capturesStarting.size > 0) return;
    try {
      const status = await sendToOffscreen({ type: "offscreen-status" });
      if (status.recording || status.transcribingTabId !== null) return;
    } catch {
      // The document can be absent or unreachable.
    }
    if (capturesStarting.size > 0) return;
    try {
      if (await ext.offscreen.hasDocument()) await ext.offscreen.closeDocument();
    } catch {
      // The document has already closed.
    }
  });
}

/** Promisified stream-id request; must run on the user's invocation for the
 * given tab or Chromium refuses the capture. */
function getMediaStreamId(targetTabId: number): Promise<string> {
  return ext.tabCapture.getMediaStreamId({ targetTabId });
}

// A Capture Start takes several awaits to reach `recording = true`, and the
// keyboard shortcut can fire again inside that window. Without this the second
// invocation would record a Capture Span the offscreen recorder ignored (start is
// idempotent there), leaving a span in the session with no audio behind it.
const capturesStarting = new Map<number, Promise<void>>();
const capturesStopping = new Map<number, Promise<void>>();

function ownsCapture(status: OffscreenStatusReply, tabId: number, s: MeetingSession): boolean {
  const span = s.spans.at(-1);
  return span !== undefined && status.tabId === tabId && status.spanId === span.spanId;
}

function ownsCaptureEvent(spanId: string | undefined, s: MeetingSession): boolean {
  return spanId === undefined || s.spans.at(-1)?.spanId === spanId;
}

function recordCaptureFailure(s: MeetingSession, detail: string): void {
  s.captureFailure ??= detail;
  s.noSpeech = false;
  s.localMicrophone = false;
  s.captureWarning = {
    message: "Audio capture failed. Saved audio is kept for recovery.",
    detail: s.captureFailure,
  };
}

/**
 * Begins a Capture Span. Every Capture Start writes its own audio file, so
 * resuming capture after a stretch the user kept off the record cannot touch what
 * an earlier span recorded (ADR-0005).
 */
async function startCapture(tabId: number): Promise<void> {
  const pending = capturesStarting.get(tabId);
  if (pending) return pending;
  const operation = (async () => {
    await capturesStopping.get(tabId);
    const s = await getSession(tabId);
    if (!s || s.recording) return;
    await beginCaptureSpan(tabId, s);
  })();
  capturesStarting.set(tabId, operation);
  try {
    await operation;
  } finally {
    if (capturesStarting.get(tabId) === operation) capturesStarting.delete(tabId);
  }
}

async function beginCaptureSpan(tabId: number, s: MeetingSession): Promise<void> {
  // Read now rather than remembered: the user may have answered the microphone
  // disclosure since the last Capture Start, and this is the moment that decides
  // whether their own voice is in this span.
  const settings = await loadSettings();
  const mic = shouldCaptureMic(settings.micCapture);
  await ensureOffscreenDocument();
  if (mic) {
    const permission = await prepareMicrophoneAccess();
    if (permission === "prompt" || permission === "denied") {
      s.captureWarning = {
        message:
          "Microphone access is required. Allow access in Settings, then return to the meeting and start recording.",
        detail:
          permission === "denied"
            ? "Chrome has blocked microphone access for this extension."
            : "Chrome must request microphone access from a visible extension page.",
      };
      s.micError = s.captureWarning.detail ?? null;
      await persistSessions();
      await updateBadge(tabId);
      return;
    }
  }
  const streamId = await getMediaStreamId(tabId);
  const recordingId = s.recordingId ?? `${tabId}-${s.startedAt}`;
  const span = beginSpan(recordingId, s.startedAt, Date.now());
  const reply = await sendToOffscreen({
    type: "offscreen-start",
    streamId,
    spanId: span.spanId,
    tabId,
    mic,
  });
  if (!reply.recording || reply.tabId !== tabId || reply.spanId !== span.spanId) {
    const anotherTabIsRecording = reply.recording
      && reply.tabId !== null
      && reply.tabId !== tabId;
    s.captureWarning = {
      message: anotherTabIsRecording
        ? "Another meeting tab is recording. Return to that tab, or stop its recording before you start this one."
        : "Recording could not start. Try the toolbar icon or the shortcut again.",
      detail: reply.error ?? "the recorder did not start for this meeting tab",
    };
  } else {
    s.recording = true;
    s.recordingStartedAt = reply.startedAt ?? Date.now();
    s.recordingId = recordingId;
    // The span joins the Meeting's Audio Recording; the earlier ones stay exactly
    // as they were recorded.
    s.spans = orderedSpans([
      ...s.spans,
      {
        ...span,
        startOffsetMs: Math.max(0, s.recordingStartedAt - s.startedAt),
      },
    ]);
    // A recorder that started but reported a fault: the audio is being written,
    // some of it may be missing, and the captions carry the meeting regardless.
    s.captureWarning = reply.error
      ? {
          message:
            "Recording — some audio could not be saved. Captions are still being captured, so a summary will still land.",
          detail: reply.error,
        }
      : null;
    s.micRecording = reply.micRecording;
    // AND across the Meeting's spans: a Meeting recorded partly without the
    // microphone does not hold the whole of the local user, and the artifact says
    // so rather than rounding up.
    s.localMicrophone = foldLocalMicrophone(s.localMicrophone, reply.micRecording);
    s.micError = reply.micError;
    if (reply.captureFailure) recordCaptureFailure(s, reply.captureFailure);
    else if (s.captureFailure) recordCaptureFailure(s, s.captureFailure);
  }
  await persistSessions();
  await updateBadge(tabId);
}

/** `keepOffscreen` when transcription follows immediately: the same document
 * owns the Whisper worker, and tearing it down only to recreate it would throw
 * away the audio decode context for nothing. */
async function stopRecording(tabId: number, keepOffscreen = false): Promise<void> {
  await capturesStarting.get(tabId);
  const pending = capturesStopping.get(tabId);
  if (pending) return pending;
  const operation = stopCaptureSpan(tabId, keepOffscreen);
  capturesStopping.set(tabId, operation);
  try {
    await operation;
  } finally {
    if (capturesStopping.get(tabId) === operation) capturesStopping.delete(tabId);
  }
}

async function stopCaptureSpan(tabId: number, keepOffscreen: boolean): Promise<void> {
  const s = await getSession(tabId);
  if (!s?.recording) return;
  try {
    const span = s.spans.at(-1);
    const reply = await sendToOffscreen(span
      ? { type: "offscreen-stop", tabId, spanId: span.spanId }
      : { type: "offscreen-status" });
    // This span's measure of whether any sound reached the mix, OR'd into the
    // Meeting's. The stop reply is the only place it is complete, and it is a
    // different fact from the sustained-silence warning: a Meeting whose first span
    // was silent and whose second carried the whole conversation still has audio.
    if (ownsCapture(reply, tabId, s)) {
      s.hadAnySignal = foldAnySignal(s.hadAnySignal, reply.anySignal);
      if (reply.captureFailure || reply.error) {
        recordCaptureFailure(s, reply.captureFailure ?? reply.error!);
      } else if (reply.anySignal && !s.captureFailure) {
        s.captureWarning = clearSilenceWarning(s.captureWarning);
      }
    } else {
      recordCaptureFailure(s, "The recorder could not verify this recording.");
    }
  } catch {
    recordCaptureFailure(s, "The recorder stopped before its audio could be verified.");
  }
  s.recording = false;
  s.recordingStartedAt = null;
  // The microphone track is released with the recorder, so nothing may go on
  // claiming it is live.
  s.micRecording = false;
  await persistSessions();
  await updateBadge(tabId);
  if (!keepOffscreen) await closeOffscreenUnlessRecording();
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
  // Text, colour and tooltip in one pure decision (`badge.ts`), and the microphone
  // half of it read from what the recorder has open rather than from the setting, so
  // the badge cannot claim a microphone that is not live (ADR-0007). Nothing about
  // what the badge says is decided here: this function is the part that cannot be
  // tested, so it is kept to the three API calls.
  const badge = badgeFor({
    recording: s?.recording === true,
    micRecording: s?.micRecording === true,
    warning: s?.captureWarning?.message ?? null,
    inMeeting: s?.inMeeting === true,
    segmentCount: s?.accumulator.size ?? 0,
  });
  try {
    await action.setBadgeBackgroundColor({ color: badge.color, tabId });
    await action.setBadgeText({ text: badge.text, tabId });
    await action.setTitle({ title: badge.title, tabId });
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
export async function finishMeeting(tabId: number, trigger: "auto" | "manual" | "tab-closed" | "capture-lost" | "navigated") {
  await capturesStarting.get(tabId);
  const s = await getSession(tabId);
  if (!s) return;
  const meetingEnded = trigger === "auto" || trigger === "tab-closed" || trigger === "navigated";
  if (meetingEnded) s.inMeeting = false;
  // Meeting End stops the recorder before the transcribe → summarize sequence
  // runs, and regardless of whether audio was captured, so the Audio Recording
  // is always closed cleanly.
  if (s.recording) await stopRecording(tabId, hasRecording(s));
  // Audio alone can carry the Meeting: captions that were never turned on cost
  // speaker names, not the meeting.
  if (s.state !== "capturing" || (s.accumulator.size === 0 && !hasRecording(s))) {
    // End and navigation can arrive after processing has started or completed.
    // Update the meeting status even when there is no more data to process.
    if (meetingEnded) {
      await persistSessions();
      await updateBadge(tabId);
    }
    return;
  }

  const captionTranscript = sessionToTranscript(s);
  let transcript = captionTranscript;

  if (hasRecording(s) && s.recordingId && s.captureFailure) {
    s.audioWords = false;
    s.noSpeech = false;
    await holdRecording(
      { recordingId: s.recordingId, transcript: captionTranscript, spans: s.spans },
      s.captureFailure,
    );
  } else if (hasRecording(s) && s.recordingId && refuseAudioAsSilent(s.hadAnySignal)) {
    // No sound reached the mix for any span of this Meeting, so there is nothing in
    // the audio for a Transcription Provider to hear — and asking one anyway is
    // exactly how two Summary Artifacts came to hold Whisper's "you" under an LLM
    // apologising that there was nothing to summarize. The captions carry the
    // Meeting instead, and the artifact says why.
    //
    // Not held for retry: a retry can only find the same silence.
    s.audioWords = false;
    s.noSpeech = true;
    transcript = { ...captionTranscript, noSpeech: true };
    console.info("meeting-summarizer: recording carried no signal; falling back to captions");
  } else if (hasRecording(s) && s.recordingId) {
    s.state = "transcribing";
    s.transcription = null;
    await persistSessions();
    await updateBadge(tabId);
    const outcome = await transcribeRecording(tabId, s);
    s.transcription = null;
    // Words from the recording replace the caption words wholesale — that is
    // the point of v2 — while the captions live on as the Speaker Track fusion
    // takes the names from. Which is exactly why the words have to be speech
    // before they count: output the Transcription Provider refused as silence
    // arrives here as no words at all, so a hallucinated token can never
    // displace a real caption Transcript or claim to be recorded audio.
    s.audioWords = outcome.utterances.length > 0;
    // Recorded so the popup can say the recording carried no speech, rather than
    // leaving the user with an unexplained caption-only summary.
    s.noSpeech = outcome.noSpeech !== null;
    if (s.noSpeech) {
      console.info(`meeting-summarizer: transcription rejected — ${outcome.noSpeech}`);
    }
    if (s.audioWords) {
      transcript = { ...fuseTranscript(captionTranscript, outcome.utterances), engine: outcome.engine };
    } else if (s.noSpeech) {
      // Carried onto the Transcript so the artifact can say the recording was
      // silent, rather than "no audio was recorded" — which is false, and would
      // leave a reader concluding the engine broke when it worked perfectly and
      // there was nothing to hear.
      transcript = { ...captionTranscript, noSpeech: true };
    } else if (!outcome.cancelled) {
      // A transcription outage must cost a retry, not the meeting: hold the
      // Audio Recording so the user can retry it — after switching Transcription
      // Provider if that is what it takes. The caption-only summary below still
      // lands, so the outage costs accuracy now rather than everything.
      //
      // A recording refused for carrying no speech is deliberately not held: an
      // outage and a silent recording are different states, and a retry of
      // silence only reproduces the silence it already found.
      await holdRecording(
        { recordingId: s.recordingId, transcript: captionTranscript, spans: s.spans },
        outcome.error ?? "transcription produced no words",
      );
    }
  }

  if (transcript.segments.length === 0) {
    // Do not send an empty transcript to the summary provider. Capture or
    // transcription failures have already held the recording for retry.
    // Keep the session available for a later capture and show any silence warning.
    if (s.noSpeech) s.captureWarning = NOTHING_CAPTURED_WARNING;
    s.state = "capturing";
    await persistSessions();
    await updateBadge(tabId);
    await closeOffscreenUnlessRecording();
    return;
  }

  s.state = "summarizing";
  await persistSessions();
  await updateBadge(tabId);

  try {
    await summarizeAndWrite(transcript);
    // Remove completed audio after writing the artifact. discardRecording keeps
    // recordings held for retry, including audio from a failed capture.
    s.state = "done";
    s.accumulator = new TranscriptAccumulator();
    await persistSessions();
    // Check every span so completed audio files do not remain as orphans.
    if (s.recordingId) await discardRecording(s.recordingId, s.spans);
  } catch (err) {
    console.error(`meeting-summarizer: summarization failed (${trigger})`, err);
    // A Transcript is unrecoverable once dropped — hold it for retry, together
    // with the recording it came from so the audio survives until an artifact
    // for it is actually written.
    await holdTranscript(
      transcript,
      reasonOf(err),
      s.recordingId ? { recordingId: s.recordingId, spans: s.spans } : undefined,
    );
    s.state = "failed";
    await persistSessions();
  }
  await closeOffscreenUnlessRecording();
  await updateBadge(tabId);
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
/** The engine that ran, as the artifact names it when the user opts in. */
function engineOf(t: Settings["transcription"]): { id: string; model: string } {
  const id = TRANSCRIPTION_ENGINE_NAMES[t.provider];
  switch (t.provider) {
    case "openai":
      return { id, model: t.openai.model };
    case "elevenlabs":
      return { id, model: t.elevenlabs.model };
    case "local-whisper":
      return { id, model: t.localWhisper.model };
    case "sagemaker":
      // The endpoint is the most the extension knows about the model behind it.
      return { id, model: t.sagemaker.endpointName };
  }
}

/**
 * The credentials the selected engine needs, and no others: only SageMaker takes
 * AWS credentials, so for every other engine none are sent to the offscreen
 * document at all.
 */
async function credentialsFor(t: Settings["transcription"]): Promise<AwsCredentials | null> {
  return t.provider === "sagemaker" ? loadAwsCredentials() : null;
}

async function transcribeRecording(
  tabId: number,
  s: MeetingSession,
): Promise<OffscreenTranscribeReply> {
  if (!s.recordingId) {
    return { utterances: [], cancelled: false, noSpeech: null, error: "no recording" };
  }
  try {
    const settings = await loadSettings();
    await ensureOffscreenDocument();
    const reply = (await ext.runtime.sendMessage({
      type: "offscreen-transcribe",
      // Every span of the Meeting, in Capture Start order: the words of a stretch
      // the user recorded before pausing are as much a part of this Meeting as the
      // last one, and each span carries the offset that keeps its timings absolute.
      spans: orderedSpans(s.spans),
      transcription: settings.transcription,
      awsCredentials: await credentialsFor(settings.transcription),
      tabId,
    } satisfies OffscreenMessage)) as OffscreenTranscribeReply;
    if (reply.error) console.error(`meeting-summarizer: transcription failed: ${reply.error}`);
    return { ...reply, engine: engineOf(settings.transcription) };
  } catch (err) {
    console.error("meeting-summarizer: transcription failed", err);
    return { utterances: [], cancelled: false, noSpeech: null, error: reasonOf(err) };
  }
}

/**
 * Delete an Audio Recording — every Capture Span of it — once its Summary Artifact
 * is written, so recordings never accumulate on the user's disk. A Meeting that
 * recorded three spans must leave no orphan behind.
 *
 * A recording still held for a transcription retry is exempt: that retry is the
 * only thing that can still turn this Meeting into an accurate Transcript, and it
 * needs the audio to do it.
 */
async function discardRecording(recordingId: string, spans: CaptureSpan[]): Promise<void> {
  const spanIds = spanIdsOf(spans);
  if (spanIds.length === 0) return;
  if (await getHeldRecording(recordingId)) return;
  try {
    await ensureOffscreenDocument();
    await ext.runtime.sendMessage({
      type: "offscreen-discard-spans",
      spanIds,
    } satisfies OffscreenMessage);
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
      if (entry.recordingId) await discardRecording(entry.recordingId, entry.spans ?? []);
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
    let noSpeech: string | null;
    try {
      ({ utterances, noSpeech } = await transcribeHeldRecording(entry));
      if (entry.transcript.captureError && noSpeech) {
        throw new Error(
          "The saved recording is incomplete. A result with no speech cannot verify the failed audio capture.",
        );
      }
    } catch (err) {
      await updateHeldRecordingReason(recordingId, reasonOf(err));
      throw err;
    }
    // No speech in the audio means the retry ends the chain rather than repeating
    // it: fusion leaves the caption Transcript intact, and it goes on to a
    // caption-only Summary Artifact instead of back into the Held Recording list
    // where the user would keep retrying the same silence.
    const transcript = fuseTranscript(entry.transcript, utterances);
    const held = await holdTranscript(transcript, noSpeech ?? "transcribed, summary pending", {
      recordingId,
      spans: entry.spans,
    });
    await releaseHeldRecording(recordingId);
    // From here the Held Transcript machinery owns the rest of the chain,
    // including deleting the audio once the artifact write is confirmed.
    await retryHeld(held.id);
  } finally {
    recordingRetriesInFlight.delete(recordingId);
  }
}

/**
 * Transcription under whatever settings are current, with every non-result turned
 * into a throw: the caller's job is to keep the audio held.
 *
 * Silence is the one exception, and it is not a non-result: the run finished and
 * found nothing to hear. It comes back as no Utterances and a reason, because
 * throwing would hold the audio for a retry that can only find the same silence.
 */
async function transcribeHeldRecording(
  entry: HeldRecording,
): Promise<{ utterances: Utterance[]; noSpeech: string | null }> {
  const settings = await loadSettings();
  await ensureOffscreenDocument();
  try {
    const reply = (await ext.runtime.sendMessage({
      type: "offscreen-transcribe",
      // All of the Meeting's spans: a retry that recovered only the last stretch
      // would lose the rest, which is the failure this whole shape exists to stop.
      spans: orderedSpans(entry.spans),
      transcription: settings.transcription,
      // Read now, like the settings: a retry is how fresh credentials rescue a
      // Recording that was held because the old ones expired.
      awsCredentials: await credentialsFor(settings.transcription),
      // No live session owns a retried Meeting, so progress has no session to
      // land on; the popup reports the retry on the row the user clicked.
      tabId: -1,
    } satisfies OffscreenMessage)) as OffscreenTranscribeReply;
    if (reply.error) throw new Error(reply.error);
    if (reply.cancelled) throw new Error("transcription cancelled");
    if (reply.noSpeech) return { utterances: [], noSpeech: reply.noSpeech };
    if (reply.utterances.length === 0) throw new Error("transcription produced no words");
    return { utterances: reply.utterances, noSpeech: null };
  } finally {
    await closeOffscreenUnlessRecording();
  }
}

function interruptCapture(s: MeetingSession, detail: string): void {
  recordCaptureFailure(s, detail);
  s.recording = false;
  s.recordingStartedAt = null;
  s.micRecording = false;
  s.micError = null;
  s.captureWarning = {
    message: "Recording stopped unexpectedly — restart it to keep recording.",
    detail,
  };
}

async function statusFor(tabId: number): Promise<StatusReply> {
  const s = await getSession(tabId);
  const settings = await loadSettings();
  // Poll the offscreen recorder while live so a quota failure that develops
  // mid-recording surfaces as a warning rather than a silent stop. The microphone
  // is read from the same reply for the same reason: the indicator must report the
  // recorder's state, not the request we made of it.
  if (s?.recording) {
    try {
      const os = await sendToOffscreen({ type: "offscreen-status" });
      let changed = false;
      if (ownsCapture(os, tabId, s) && (os.captureFailure || os.error)) {
        recordCaptureFailure(s, os.captureFailure ?? os.error!);
        await stopRecording(tabId);
        changed = true;
      } else if (!os.recording || !ownsCapture(os, tabId, s)) {
        interruptCapture(s, "the recorder is not recording this meeting");
        changed = true;
      } else {
        if (os.anySignal && !s.captureFailure) {
          if (s.hadAnySignal !== true) {
            s.hadAnySignal = true;
            changed = true;
          }
          const warning = clearSilenceWarning(s.captureWarning);
          if (warning !== s.captureWarning) {
            s.captureWarning = warning;
            changed = true;
          }
        }
        if (s.micRecording !== os.micRecording) {
          // Written back to the session, not merely answered with: the badge is drawn
          // from the session, so a stale `true` left here would survive this poll and
          // keep three letters claiming a microphone the recorder has already lost.
          s.micRecording = os.micRecording;
          // A span that stopped holding the local user cannot be talked back into
          // holding them, so the Summary Artifact's claim drops the same way it does
          // when the revocation did arrive.
          if (!os.micRecording) s.localMicrophone = false;
          changed = true;
        }
        if (s.micError !== os.micError) {
          s.micError = os.micError;
          changed = true;
        }
      }
      // Recorder events update the badge while the popup is closed. Status also
      // repairs the session if an event was missed.
      if (changed) {
        await persistSessions();
        await updateBadge(tabId);
      }
    } catch {
      interruptCapture(s, "the recorder could not be reached");
      await persistSessions();
      await updateBadge(tabId);
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
      recorded: s ? hasRecording(s) : false,
    }),
    recording: s?.recording ?? false,
    recordingStartedAt: s?.recordingStartedAt ?? null,
    degraded: isDegraded({
      recorded: s ? hasRecording(s) : false,
      audioWords: s?.audioWords ?? null,
    }),
    noSpeech: s?.noSpeech ?? false,
    captureWarning: s?.captureWarning ?? null,
    mic: micCaptureState({
      settings: settings.micCapture,
      recording: s?.recording ?? false,
      micRecording: s?.micRecording ?? false,
    }),
    micDetail: s?.micError ?? null,
    transcription: s?.transcription ?? null,
  };
}

async function captureStateFor(tabId: number): Promise<CaptureStateReply> {
  const status = await statusFor(tabId);
  const s = await getSession(tabId);
  return {
    state: status.state,
    title: status.title,
    recording: status.recording,
    recordingStartedAt: status.recordingStartedAt,
    dismissed: s?.promptDismissed ?? false,
    shortcut: await startShortcut(),
    mic: status.mic,
  };
}

async function resolvePopupTabId(tabId?: number): Promise<number> {
  if (tabId !== undefined) {
    return Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : -1;
  }
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? -1;
}

/**
 * Records the user's answer to the microphone disclosure. Either answer counts as
 * an answer, so the notice stops asking: a user who chose the other participants
 * only has decided, and must not be nagged into an escalation they declined.
 *
 * Takes effect at the next Capture Start, never mid-span: switching it off cannot
 * reach into a recorder that already has the microphone open, and pretending
 * otherwise is exactly the sort of claim the indicator must not make.
 */
async function setMicCapture(enabled: boolean): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({ ...settings, micCapture: { enabled, confirmedAt: Date.now() } });
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
    // Extension pages can also have a tab id. Only meeting-content messages
    // belong to this handler; returning its promise for an offscreen request
    // would claim the response before the recorder can answer.
    if (
      msg.type === "captions-update" ||
      msg.type === "meeting-status" ||
      msg.type === "meeting-ended"
    ) {
      return handleContentMessage(msg, senderTabId);
    }
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
  if (msg.type === "capture-failed") {
    return (async () => {
      const s = await getSession(msg.tabId);
      if (!s?.recording || !ownsCaptureEvent(msg.spanId, s)) return { ok: true };
      recordCaptureFailure(s, msg.detail);
      await persistSessions();
      await stopRecording(msg.tabId);
      return { ok: true };
    })();
  }
  if (msg.type === "mic-track-ended") {
    return (async () => {
      const s = await getSession(msg.tabId);
      if (!s?.recording || !ownsCaptureEvent(msg.spanId, s)) return { ok: false };
      // The recording continues on the remote participants alone. Two things have
      // to change or the artifact lies: this Meeting no longer holds the whole of
      // the local user, and the user deserves to know while they can still act.
      s.micRecording = false;
      s.localMicrophone = false;
      s.micError = MIC_REVOKED_WARNING.detail ?? null;
      // Assigned outright, unlike the silence warning below: a microphone that has
      // just died is newer and more actionable than a silent window that has
      // already passed, and it names the cause where silence only names the symptom.
      if (!s.captureFailure) s.captureWarning = MIC_REVOKED_WARNING;
      await persistSessions();
      await updateBadge(msg.tabId);
      return { ok: true };
    })();
  }
  // Clear an initial silence warning as soon as the mixed stream carries sound.
  if (msg.type === "capture-signal") {
    return (async () => {
      const s = await getSession(msg.tabId);
      if (!s?.recording || !ownsCaptureEvent(msg.spanId, s)) return { ok: true };
      s.hadAnySignal = true;
      if (!s.captureFailure) s.captureWarning = clearSilenceWarning(s.captureWarning);
      await persistSessions();
      await updateBadge(msg.tabId);
      return { ok: true };
    })();
  }
  // Warn while there is still time to restore sound during the meeting.
  if (msg.type === "capture-silent") {
    return (async () => {
      const s = await getSession(msg.tabId);
      if (!s?.recording || !ownsCaptureEvent(msg.spanId, s) ||
        s.captureFailure || s.hadAnySignal === true) return { ok: true };
      // Asks rather than assigns, so a microphone revocation survives it — losing
      // the microphone is a *cause* of silence, and the vaguer message would land a
      // moment later and bury the specific one.
      s.captureWarning = silenceWarning(s.captureWarning, msg.detail);
      console.warn(`meeting-summarizer: recording is silent — ${msg.detail}`);
      await persistSessions();
      // Redrawn here and not left to the next caption update: a Meeting gone silent
      // may well be one whose captions have stopped too, and a warning that only
      // reaches the popup is one the user has to go looking for.
      await updateBadge(msg.tabId);
      return { ok: true };
    })();
  }
  if (msg.type === "capture-track-ended") {
    return (async () => {
      const s = await getSession(msg.tabId);
      if (!s?.recording || !ownsCaptureEvent(msg.spanId, s)) return { ok: true };
      console.warn("meeting-summarizer: capture track ended on its own; finishing the meeting");
      await finishMeeting(msg.tabId, "capture-lost");
      return { ok: true };
    })();
  }
  // Popup messages
  if (msg.type === "get-status") {
    return (async () => {
      return statusFor(await resolvePopupTabId(msg.tabId));
    })();
  }
  if (msg.type === "start-capture") {
    return (async () => {
      const tabId = await resolvePopupTabId(msg.tabId);
      if (tabId >= 0) await startCapture(tabId);
      return statusFor(tabId);
    })();
  }
  if (msg.type === "stop-capture") {
    return (async () => {
      const tabId = await resolvePopupTabId(msg.tabId);
      if (tabId >= 0) await stopRecording(tabId);
      return statusFor(tabId);
    })();
  }
  if (msg.type === "summarize-now") {
    return (async () => {
      const tabId = await resolvePopupTabId(msg.tabId);
      if (tabId >= 0) await finishMeeting(tabId, "manual");
      return statusFor(tabId);
    })();
  }
  if (msg.type === "skip-transcription") {
    return (async () => {
      const tabId = await resolvePopupTabId(msg.tabId);
      try {
        if (tabId >= 0) {
          await ext.runtime.sendMessage({ type: "offscreen-cancel-transcribe", tabId });
        }
      } catch {
        // Offscreen already gone — the wait is over either way.
      }
      return statusFor(tabId);
    })();
  }
  if (msg.type === "set-mic-capture") {
    return (async () => {
      await setMicCapture(msg.enabled);
      return statusFor(await resolvePopupTabId(msg.tabId));
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

/**
 * A tab that navigates away from the meeting client is not in a Meeting any more,
 * and nothing else notices: the content script is destroyed by the unload so no
 * `meeting-ended` arrives, and `onRemoved` never fires because the tab still
 * exists. Left alone, either the capture keeps running on whatever the user
 * browses next — a privacy failure, in a product whose whole premise is that the
 * audio is yours — or it dies quietly and the popup reports a recording that
 * stopped. Both are unacceptable, so navigation ends the Meeting.
 *
 * Inspect every URL update, including same-document history changes (Zoom can
 * route to /wc/home without unloading). Do not gate this on status === "loading".
 * If a client ends without a URL event, the content runner's adapter-based DOM
 * end detection remains the fallback.
 */
ext.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined || isMeetingUrl(changeInfo.url)) return;
  void (async () => {
    await capturesStarting.get(tabId);
    const s = await getSession(tabId);
    if (!s) return;
    if (s.state === "capturing" &&
      (s.recording || hasRecording(s) || s.accumulator.size > 0)) {
      console.warn("meeting-summarizer: tab navigated away from the meeting; finishing");
    }
    await finishMeeting(tabId, "navigated");
  })();
});

ext.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await capturesStarting.get(tabId);
    const s = await getSession(tabId);
    if (s && s.state === "capturing" && (s.accumulator.size > 0 || hasRecording(s))) {
      await finishMeeting(tabId, "tab-closed");
    } else if (s?.recording) {
      await stopRecording(tabId);
    }
    await dropSession(tabId);
  })();
});

/**
 * Reconcile claimed recording state against tab reality.
 *
 * A service worker can be torn down mid-recording — or the whole extension
 * reloaded — and woken with sessions that still say `recording: true`. The
 * offscreen document did not survive, so nothing is being recorded, but the spans
 * already on disk are real. Left alone the popup reports a live recording that
 * ended, and audio nobody will ever transcribe sits in storage: the same silent
 * unrecoverable loss ADR-0005 fixed, reached from the other side.
 *
 * Checkpoint recovery never sends saved meeting data from a startup event:
 * sessions whose tabs are gone are held for a manual retry. A session still in a
 * meeting has interrupted processing and recording claims corrected.
 */
async function reconcileSessions(): Promise<void> {
  const recorder = await (async (): Promise<OffscreenStatusReply | null> => {
    try {
      return await sendToOffscreen({ type: "offscreen-status" });
    } catch {
      return null;
    }
  })();

  for (const [tabId, s] of await allSessions()) {
    let corrected = false;
    const transcriptionAlive = recorder?.transcribingTabId === tabId;
    if ((s.state === "transcribing" && !transcriptionAlive) || s.state === "summarizing") {
      s.state = "capturing";
      s.transcription = null;
      s.captureWarning = {
        message: "Processing stopped unexpectedly. Retry the saved meeting.",
        detail: "processing was interrupted by a browser restart or extension reload",
      };
      corrected = true;
    }
    if (s.recording && recorder && ownsCapture(recorder, tabId, s) &&
      (recorder.captureFailure || recorder.error)) {
      recordCaptureFailure(s, recorder.captureFailure ?? recorder.error!);
      await stopRecording(tabId);
      corrected = true;
    } else if (s.recording && (!recorder?.recording || !ownsCapture(recorder, tabId, s))) {
      interruptCapture(s, "the recorder did not own this meeting when the service worker woke");
      corrected = true;
    }
    if (corrected) {
      await persistSessions();
      await updateBadge(tabId);
    }
    const tab = await ext.tabs.get(tabId).catch(() => undefined);
    if (!tab || !isMeetingUrl(tab.url)) {
      if (isRecoveredSession(tabId) && s.state === "capturing" &&
        (s.recording || hasRecording(s) || s.accumulator.size > 0)) {
        const transcript = sessionToTranscript(s);
        const reason = "Meeting recovered after a restart or reload. Review and retry it manually.";
        if (hasRecording(s)) {
          await holdRecording(
            {
              recordingId: s.recordingId ?? s.spans[0]!.spanId,
              transcript,
              spans: s.spans,
            },
            reason,
          );
        } else {
          await holdTranscript(transcript, reason);
        }
        // Remove the checkpoint only after the Held entry is durably stored.
        await dropSession(tabId);
        continue;
      }
      await finishMeeting(tabId, tab ? "navigated" : "tab-closed");
      if (!tab) await dropSession(tabId);
      continue;
    }
  }
}

async function restoreMeetings(): Promise<void> {
  await reconcileSessions();
  await restoreMeetingContentScripts();
}

ext.runtime.onStartup.addListener(() => void restoreMeetings().catch(console.warn));
ext.runtime.onInstalled.addListener(() => void restoreMeetings().catch(console.warn));
