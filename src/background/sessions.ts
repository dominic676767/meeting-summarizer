// Per-tab Meeting session state, mirrored to storage.session so a service
// worker suspension can't lose a Transcript mid-meeting.
import { TranscriptAccumulator } from "../adapters/accumulator";
import type { TranscriptionProgress } from "../messages";
import type { CaptureSpan, Transcript } from "../domain/types";
import type { CaptureWarning } from "../messages";
import { ext } from "../platform";

export type SessionState = "capturing" | "transcribing" | "summarizing" | "done" | "failed";

export interface MeetingSession {
  platform: string;
  title: string | null;
  startedAt: number;
  inMeeting: boolean;
  state: SessionState;
  accumulator: TranscriptAccumulator;
  /** Audio is being recorded right now (offscreen recorder is live). */
  recording: boolean;
  /** Epoch ms the current recording began; null when not recording. */
  recordingStartedAt: number | null;
  /** Recording key for this Meeting; stable across stop/start, and the prefix
   * every one of its Capture Spans is named from. */
  recordingId: string | null;
  /**
   * Every Capture Span recorded for this Meeting, in Capture Start order —
   * the Meeting's Audio Recording. One entry per Capture Start, each with its own
   * file and its own distance from the Meeting start, because Utterance offsets
   * are absolute relative to the *Meeting* and recording begins whenever the user
   * clicked. Empty means no audio, which is a Degraded Capture.
   */
  spans: CaptureSpan[];
  /** Non-fatal capture problem (quota, recorder fault) to surface to the user. */
  captureWarning: CaptureWarning | null;
  /** The local microphone is live in the mix right now. */
  micRecording: boolean;
  /**
   * Whether every Capture Span of this Meeting included the local microphone, so
   * the Audio Recording holds the user's own side of the call as well as the
   * remote participants'. Null until the first Capture Start.
   *
   * Folded with AND across spans: a Meeting where one stretch was recorded without
   * the microphone does not contain the whole of the local user, and the Summary
   * Artifact must not imply otherwise.
   */
  localMicrophone: boolean | null;
  /** Why the microphone could not be used, for the tooltip. Null when it is fine
   * or was never asked for. */
  micError: string | null;
  /** The in-page prompt hides itself for the rest of this Meeting once dismissed. */
  promptDismissed: boolean;
  /**
   * Whether transcribed audio words actually reached the Transcript. Null until
   * transcription has run; false when it failed or the user skipped the wait, in
   * which case the Meeting is a Degraded Capture even though audio exists.
   */
  audioWords: boolean | null;
  /**
   * The Audio Recording was transcribed and its output refused for carrying no
   * speech. Recorded separately from `audioWords` because a Degraded Capture has
   * several causes and only this one has an explanation the user can act on
   * ("nothing was heard"), while a failure keeps the audio for retry and this
   * does not — retrying silence reproduces silence.
   */
  noSpeech: boolean;
  /**
   * The live transcription measure. Deliberately not persisted: it arrives from
   * the offscreen document once a second, and writing storage that often to
   * survive a suspension would cost more than re-learning it on the next tick.
   */
  transcription: TranscriptionProgress | null;
}

const sessions = new Map<number, MeetingSession>();
let rehydration: Promise<void> | undefined;

interface PersistedSession {
  platform: string;
  title: string | null;
  startedAt: number;
  inMeeting: boolean;
  state: SessionState;
  recording: boolean;
  recordingStartedAt: number | null;
  recordingId: string | null;
  /** Always written; absent only on a record from before Capture Spans. */
  spans?: CaptureSpan[];
  captureWarning: CaptureWarning | null;
  promptDismissed: boolean;
  audioWords: boolean | null;
  /** Absent on a record from before silent recordings were refused. */
  noSpeech?: boolean;
  /** Absent on a record from before the microphone was mixed in, which is a
   * recording of the remote participants alone — so absent reads as false. */
  micRecording?: boolean;
  localMicrophone?: boolean | null;
  micError?: string | null;
  entries: ReturnType<TranscriptAccumulator["toJSON"]>;
  /** Written by versions before Capture Spans; read only by `spansOf`. */
  recorded?: boolean;
  recordingFrom?: number | null;
}

/**
 * A persisted session's Capture Spans, tolerating one written before spans
 * existed: that shape recorded a single Audio Recording keyed by `recordingId`
 * and one Capture Start (`recordingFrom`), which is exactly one span. Reading it
 * as such is what stops an extension update mid-Meeting from orphaning audio the
 * user is still recording.
 */
function spansOf(p: PersistedSession): CaptureSpan[] {
  if (p.spans) return p.spans;
  if (!p.recorded || !p.recordingId) return [];
  const startOffsetMs = Math.max(0, (p.recordingFrom ?? p.startedAt) - p.startedAt);
  return [{ spanId: p.recordingId, startOffsetMs }];
}

/** Whether an Audio Recording exists for this Meeting: at least one Capture Span
 * was recorded. Drives the Degraded Capture flag independently of whether the
 * recorder is live now. */
export function hasRecording(s: MeetingSession): boolean {
  return s.spans.length > 0;
}

// Concurrent startup messages share one rehydration promise, so a second
// caller can never race past an in-flight storage read and overwrite the
// rehydrated Transcript.
function rehydrate(): Promise<void> {
  rehydration ??= doRehydrate();
  return rehydration;
}

async function doRehydrate(): Promise<void> {
  try {
    const stored = (await ext.storage.session.get("sessions")) as {
      sessions?: Record<string, PersistedSession>;
    };
    for (const [tabId, p] of Object.entries(stored.sessions ?? {})) {
      sessions.set(Number(tabId), {
        platform: p.platform,
        title: p.title,
        startedAt: p.startedAt,
        inMeeting: p.inMeeting,
        state: p.state,
        recording: p.recording ?? false,
        recordingStartedAt: p.recordingStartedAt ?? null,
        recordingId: p.recordingId ?? null,
        spans: spansOf(p),
        captureWarning: p.captureWarning ?? null,
        micRecording: p.micRecording ?? false,
        // A span recorded before the microphone existed had none in it, so the
        // absent field reads as false rather than as "unknown, assume captured".
        localMicrophone: p.spans?.length ? (p.localMicrophone ?? false) : (p.localMicrophone ?? null),
        micError: p.micError ?? null,
        promptDismissed: p.promptDismissed ?? false,
        audioWords: p.audioWords ?? null,
        noSpeech: p.noSpeech ?? false,
        transcription: null,
        accumulator: TranscriptAccumulator.fromJSON(p.entries),
      });
    }
  } catch {
    // storage.session unavailable — in-memory only.
  }
}

export async function persistSessions(): Promise<void> {
  try {
    const obj: Record<string, PersistedSession> = {};
    for (const [tabId, s] of sessions) {
      obj[tabId] = {
        platform: s.platform,
        title: s.title,
        startedAt: s.startedAt,
        inMeeting: s.inMeeting,
        state: s.state,
        recording: s.recording,
        recordingStartedAt: s.recordingStartedAt,
        recordingId: s.recordingId,
        spans: s.spans,
        captureWarning: s.captureWarning,
        micRecording: s.micRecording,
        localMicrophone: s.localMicrophone,
        micError: s.micError,
        promptDismissed: s.promptDismissed,
        audioWords: s.audioWords,
        noSpeech: s.noSpeech,
        entries: s.accumulator.toJSON(),
      };
    }
    await ext.storage.session.set({ sessions: obj });
  } catch {
    // storage.session unavailable — in-memory only.
  }
}

export async function getSession(tabId: number): Promise<MeetingSession | undefined> {
  await rehydrate();
  return sessions.get(tabId);
}

export async function ensureSession(tabId: number, platform: string): Promise<MeetingSession> {
  await rehydrate();
  let s = sessions.get(tabId);
  // A done session ended normally; a failed one is already safe in the Held
  // Transcript store — either way, new captions mean a new Meeting.
  if (!s || s.state === "done" || s.state === "failed") {
    s = {
      platform,
      title: null,
      startedAt: Date.now(),
      inMeeting: false,
      state: "capturing",
      recording: false,
      recordingStartedAt: null,
      recordingId: null,
      spans: [],
      captureWarning: null,
      micRecording: false,
      localMicrophone: null,
      micError: null,
      promptDismissed: false,
      audioWords: null,
      noSpeech: false,
      transcription: null,
      accumulator: new TranscriptAccumulator(),
    };
    sessions.set(tabId, s);
  }
  return s;
}

/**
 * Every rehydrated session, for reconciling against tab reality. A service
 * worker can be torn down mid-recording and woken with sessions that still claim
 * to be recording, so something has to check rather than trust them.
 */
export async function allSessions(): Promise<Array<[number, MeetingSession]>> {
  await rehydrate();
  return [...sessions.entries()];
}

export async function dropSession(tabId: number): Promise<void> {
  await rehydrate();
  sessions.delete(tabId);
  await persistSessions();
}

/**
 * The caption-only Transcript: the Meeting's Caption Segments as words, which is
 * what the pipeline gets when no Audio Recording exists. It says so on itself —
 * fusion overwrites the provenance if audio words arrive.
 */
export function sessionToTranscript(s: MeetingSession): Transcript {
  return {
    platform: s.platform,
    title: s.title ?? s.platform,
    startedAt: s.startedAt,
    endedAt: Date.now(),
    provenance: "captions-only",
    // Carried on the caption Transcript so it survives fusion, which keeps the
    // base Transcript's metadata: whether the local user is in the audio is a fact
    // about the recording, not about the words that came out of it.
    localMicrophone: s.localMicrophone === true,
    segments: s.accumulator.toSegments(),
  };
}
