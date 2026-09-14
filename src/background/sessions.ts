// Per-tab Meeting session state, mirrored to storage.session so a service
// worker suspension can't lose a Transcript mid-meeting.
import { TranscriptAccumulator } from "../adapters/accumulator";
import type { Transcript } from "../domain/types";
import { ext } from "../platform";

export type SessionState = "capturing" | "summarizing" | "done" | "failed";

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
  /** An Audio Recording exists (or existed) for this Meeting — drives the
   * Degraded Capture flag independently of whether recording is live now. */
  recorded: boolean;
  /** Storage key for this Meeting's Audio Recording; stable across stop/start. */
  recordingId: string | null;
  /** Non-fatal capture problem (quota, recorder fault) to surface to the user. */
  captureWarning: string | null;
  /** The in-page prompt hides itself for the rest of this Meeting once dismissed. */
  promptDismissed: boolean;
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
  recorded: boolean;
  recordingId: string | null;
  captureWarning: string | null;
  promptDismissed: boolean;
  entries: ReturnType<TranscriptAccumulator["toJSON"]>;
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
        recorded: p.recorded ?? false,
        recordingId: p.recordingId ?? null,
        captureWarning: p.captureWarning ?? null,
        promptDismissed: p.promptDismissed ?? false,
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
        recorded: s.recorded,
        recordingId: s.recordingId,
        captureWarning: s.captureWarning,
        promptDismissed: s.promptDismissed,
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
      recorded: false,
      recordingId: null,
      captureWarning: null,
      promptDismissed: false,
      accumulator: new TranscriptAccumulator(),
    };
    sessions.set(tabId, s);
  }
  return s;
}

export async function dropSession(tabId: number): Promise<void> {
  await rehydrate();
  sessions.delete(tabId);
  await persistSessions();
}

export function sessionToTranscript(s: MeetingSession): Transcript {
  return {
    platform: s.platform,
    title: s.title ?? s.platform,
    startedAt: s.startedAt,
    endedAt: Date.now(),
    segments: s.accumulator.toSegments(),
  };
}
