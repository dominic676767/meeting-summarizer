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
  foldAnySignal,
  MIC_REVOKED_WARNING,
  NOTHING_CAPTURED_WARNING,
  refuseAudioAsSilent,
  silenceWarning,
} from "./capture-signal";
import { foldLocalMicrophone, micCaptureState, shouldCaptureMic } from "./mic-capture";
import { badgeFor } from "./badge";
import { beginSpan, orderedSpans, spanIdsOf } from "./capture-spans";
import { isMeetingUrl } from "./meeting-url";
import { TRANSCRIPTION_ENGINE_NAMES } from "../transcription/engines";
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
    justification:
      "Record the meeting's audio and the user's microphone, and transcribe what was actually said.",
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

// A Capture Start takes several awaits to reach `recording = true`, and the
// keyboard shortcut can fire again inside that window. Without this the second
// invocation would record a Capture Span the offscreen recorder ignored (start is
// idempotent there), leaving a span in the session with no audio behind it.
const capturesStarting = new Set<number>();

/**
 * Begins a Capture Span. Every Capture Start writes its own audio file, so
 * resuming capture after a stretch the user kept off the record cannot touch what
 * an earlier span recorded (ADR-0005).
 */
async function startCapture(tabId: number): Promise<void> {
  const s = await getSession(tabId);
  if (!s || s.recording || capturesStarting.has(tabId)) return; // idempotent: one recording per tab
  capturesStarting.add(tabId);
  try {
    await beginCaptureSpan(tabId, s);
  } finally {
    capturesStarting.delete(tabId);
  }
}

async function beginCaptureSpan(tabId: number, s: MeetingSession): Promise<void> {
  // Read now rather than remembered: the user may have answered the microphone
  // disclosure since the last Capture Start, and this is the moment that decides
  // whether their own voice is in this span.
  const settings = await loadSettings();
  const mic = shouldCaptureMic(settings.micCapture);
  const streamId = await getMediaStreamId(tabId);
  await ensureOffscreenDocument();
  const recordingId = s.recordingId ?? `${tabId}-${s.startedAt}`;
  const span = beginSpan(recordingId, s.startedAt, Date.now());
  const reply = await sendToOffscreen({
    type: "offscreen-start",
    streamId,
    spanId: span.spanId,
    tabId,
    mic,
  });
  if (!reply.recording) {
    // getUserMedia/redeem failed — surface it rather than pretend we started.
    s.captureWarning = {
      message: "Recording could not start. Try the toolbar icon or the shortcut again.",
      detail: reply.error ?? "capture failed to start",
    };
  } else {
    s.recording = true;
    s.recordingStartedAt = reply.startedAt ?? Date.now();
    s.recordingId = recordingId;
    // The span joins the Meeting's Audio Recording; the earlier ones stay exactly
    // as they were recorded.
    s.spans = orderedSpans([...s.spans, span]);
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
    const reply = await sendToOffscreen({ type: "offscreen-stop" });
    // This span's measure of whether any sound reached the mix, OR'd into the
    // Meeting's. The stop reply is the only place it is complete, and it is a
    // different fact from the sustained-silence warning: a Meeting whose first span
    // was silent and whose second carried the whole conversation still has audio.
    s.hadAnySignal = foldAnySignal(s.hadAnySignal, reply.anySignal);
    if (!keepOffscreen) await closeOffscreenDocument();
  } catch {
    // Offscreen already gone (service-worker restart) — the recorder is stopped
    // regardless; the Audio Recording written so far is preserved.
    //
    // And with it went any measure of this span, so it counts as having held sound.
    // Refusing to transcribe audio nobody managed to look at would throw away a
    // real meeting; transcribing a silent one costs a wait and is caught anyway by
    // the check that refuses degenerate output.
    s.hadAnySignal = true;
  }
  s.recording = false;
  s.recordingStartedAt = null;
  // The microphone track is released with the recorder, so nothing may go on
  // claiming it is live.
  s.micRecording = false;
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
  const s = await getSession(tabId);
  if (!s) return;
  // Meeting End stops the recorder before the transcribe → summarize sequence
  // runs, and regardless of whether audio was captured, so the Audio Recording
  // is always closed cleanly.
  if (s.recording) await stopRecording(tabId, hasRecording(s));
  if (s.state !== "capturing") return;
  // Audio alone can carry the Meeting: captions that were never turned on cost
  // speaker names, not the meeting.
  if (s.accumulator.size === 0 && !hasRecording(s)) return;

  const captionTranscript = sessionToTranscript(s);
  let transcript = captionTranscript;

  if (hasRecording(s) && s.recordingId && refuseAudioAsSilent(s.hadAnySignal)) {
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
    // Nothing was said, or nothing reached us. Not a failure and nothing to
    // hold — leave the session as it was so a later trigger can still act.
    //
    // No Provider is asked either way. An LLM handed an empty transcript answers
    // with an apology, and that apology was the summary body of both artifacts this
    // ticket exists to remove: the guard is that this returns before summarizing.
    //
    // Where the silence is why, say so. A recording that carried nothing and no
    // captions to fall back on is a Meeting that produced no file, and a user left
    // to work that out from the absence of one has been told nothing at all.
    if (s.noSpeech) s.captureWarning = NOTHING_CAPTURED_WARNING;
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
    // Every span of this Meeting, not just the last one: three spans recorded
    // means three files to delete, or the ones left behind are orphans.
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
  await closeOffscreenDocument();
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

async function statusFor(tabId: number): Promise<StatusReply> {
  const s = await getSession(tabId);
  const settings = await loadSettings();
  let captureWarning = s?.captureWarning ?? null;
  let micRecording = s?.micRecording ?? false;
  let micError = s?.micError ?? null;
  // Poll the offscreen recorder while live so a quota failure that develops
  // mid-recording surfaces as a warning rather than a silent stop. The microphone
  // is read from the same reply for the same reason: the indicator must report the
  // recorder's state, not the request we made of it.
  if (s?.recording) {
    try {
      const os = await sendToOffscreen({ type: "offscreen-status" });
      let changed = false;
      if (os.error) {
        captureWarning = {
          message:
            "Recording — some audio could not be saved. Captions are still being captured, so a summary will still land.",
          detail: os.error,
        };
        // Written back for the same reason as the microphone below: the badge is
        // drawn from the session, and a storage fault only this reply knew about
        // would otherwise reach the popup and never the badge.
        if (s.captureWarning?.detail !== os.error) {
          s.captureWarning = captureWarning;
          changed = true;
        }
      }
      micRecording = os.micRecording;
      micError = os.micError;
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
      // It corrects the badge; it does not notice in time. This function runs only
      // when the popup asks, so a storage fault, or a microphone lost without
      // `mic-track-ended` arriving, leaves the badge on its last claim until somebody
      // opens the popup — the surface the badge exists to spare them. Nothing else
      // polls the recorder, so closing that gap means giving it a trigger that does
      // not depend on the popup.
      if (changed) {
        await persistSessions();
        await updateBadge(tabId);
      }
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
      recorded: s ? hasRecording(s) : false,
    }),
    recording: s?.recording ?? false,
    recordingStartedAt: s?.recordingStartedAt ?? null,
    degraded: isDegraded({
      recorded: s ? hasRecording(s) : false,
      audioWords: s?.audioWords ?? null,
    }),
    noSpeech: s?.noSpeech ?? false,
    captureWarning,
    mic: micCaptureState({
      settings: settings.micCapture,
      recording: s?.recording ?? false,
      micRecording,
    }),
    micDetail: micError,
    transcription: s?.transcription ?? null,
  };
}

function captureStateFor(tabId: number): Promise<CaptureStateReply> {
  return (async () => {
    const s = await getSession(tabId);
    const settings = await loadSettings();
    return {
      state: deriveCaptureState({
        sessionState: s?.state,
        inMeeting: s?.inMeeting ?? false,
        recording: s?.recording ?? false,
        recorded: s ? hasRecording(s) : false,
      }),
      title: s?.title ?? null,
      recording: s?.recording ?? false,
      recordingStartedAt: s?.recordingStartedAt ?? null,
      dismissed: s?.promptDismissed ?? false,
      shortcut: await startShortcut(),
      mic: micCaptureState({
        settings: settings.micCapture,
        recording: s?.recording ?? false,
        micRecording: s?.micRecording ?? false,
      }),
    };
  })();
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
  // The capture track died on its own — navigation or a tab crash. Whatever was
  // recorded is real and must reach a summary or a Held Recording, so this is
  // treated as a Meeting End rather than just a flag to clear.
  if (msg.type === "mic-track-ended") {
    return (async () => {
      const s = await getSession(msg.tabId);
      if (!s?.recording) return { ok: true };
      // The recording continues on the remote participants alone. Two things have
      // to change or the artifact lies: this Meeting no longer holds the whole of
      // the local user, and the user deserves to know while they can still act.
      s.micRecording = false;
      s.localMicrophone = false;
      s.micError = MIC_REVOKED_WARNING.detail ?? null;
      // Assigned outright, unlike the silence warning below: a microphone that has
      // just died is newer and more actionable than a silent window that has
      // already passed, and it names the cause where silence only names the symptom.
      s.captureWarning = MIC_REVOKED_WARNING;
      await persistSessions();
      await updateBadge(msg.tabId);
      return { ok: true };
    })();
  }
  // The mixed stream has been silent long enough for something to be wrong with it.
  // Surfaced during the meeting, which is the whole point: the two artifacts this
  // guards against were discovered after the audio had already been discarded.
  if (msg.type === "capture-silent") {
    return (async () => {
      const s = await getSession(msg.tabId);
      if (!s?.recording) return { ok: true };
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
      if (!s?.recording) return { ok: true };
      console.warn("meeting-summarizer: capture track ended on its own; finishing the meeting");
      await finishMeeting(msg.tabId, "capture-lost");
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
  if (msg.type === "set-mic-capture") {
    return (async () => {
      await setMicCapture(msg.enabled);
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
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

/**
 * A tab that navigates away from the meeting client is not in a Meeting any more,
 * and nothing else notices: the content script is destroyed by the unload so no
 * `meeting-ended` arrives, and `onRemoved` never fires because the tab still
 * exists. Left alone, either the capture keeps running on whatever the user
 * browses next — a privacy failure, in a product whose whole premise is that the
 * audio is yours — or it dies quietly and the popup reports a recording that
 * stopped. Both are unacceptable, so navigation ends the Meeting.
 */
ext.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined || isMeetingUrl(changeInfo.url)) return;
  void (async () => {
    const s = await getSession(tabId);
    // Recording, or holding spans from an earlier one: either way there is audio
    // whose only route to a summary is this Meeting End.
    if (!s || (!s.recording && !hasRecording(s))) return;
    console.warn("meeting-summarizer: tab navigated away from the meeting; finishing");
    await finishMeeting(tabId, "navigated");
  })();
});

ext.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
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
 * So on every wake: a session whose tab is gone, or has navigated off the meeting
 * client, is finished — which routes its audio to a summary or, failing that, to a
 * Held Recording. A session whose tab is still in a meeting but whose recorder
 * died has its claim corrected rather than left to lie.
 */
async function reconcileSessions(): Promise<void> {
  const recorderAlive = await (async () => {
    try {
      return (await sendToOffscreen({ type: "offscreen-status" })).recording;
    } catch {
      return false; // no offscreen document survived
    }
  })();

  for (const [tabId, s] of await allSessions()) {
    if (!s.recording && !hasRecording(s)) continue;
    const tab = await ext.tabs.get(tabId).catch(() => undefined);
    if (!tab || !isMeetingUrl(tab.url)) {
      await finishMeeting(tabId, "capture-lost");
      if (!tab) await dropSession(tabId);
      continue;
    }
    if (s.recording && !recorderAlive) {
      // Still in the meeting, but the recorder is gone: stop claiming otherwise.
      // The spans stay put — a later Meeting End still transcribes them.
      s.recording = false;
      s.recordingStartedAt = null;
      s.captureWarning = {
        message: "Recording stopped unexpectedly — restart it to keep recording.",
        detail: "the recorder was gone when the service worker woke",
      };
      await persistSessions();
      await updateBadge(tabId);
    }
  }
}

ext.runtime.onStartup.addListener(() => void reconcileSessions());
ext.runtime.onInstalled.addListener(() => void reconcileSessions());
