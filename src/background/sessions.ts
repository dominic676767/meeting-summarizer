// Per-tab Meeting session state, mirrored to storage.session so an event-page
// suspension can't lose a Transcript mid-meeting.
import { TranscriptAccumulator } from "../adapters/accumulator";
import type { Transcript } from "../domain/types";

export type SessionState = "capturing" | "summarizing" | "done" | "failed";

export interface MeetingSession {
  platform: string;
  title: string | null;
  startedAt: number;
  inMeeting: boolean;
  state: SessionState;
  accumulator: TranscriptAccumulator;
}

const sessions = new Map<number, MeetingSession>();
let rehydrated = false;

interface PersistedSession {
  platform: string;
  title: string | null;
  startedAt: number;
  inMeeting: boolean;
  state: SessionState;
  entries: ReturnType<TranscriptAccumulator["toJSON"]>;
}

async function rehydrate(): Promise<void> {
  if (rehydrated) return;
  rehydrated = true;
  try {
    const stored = (await browser.storage.session.get("sessions")) as {
      sessions?: Record<string, PersistedSession>;
    };
    for (const [tabId, p] of Object.entries(stored.sessions ?? {})) {
      sessions.set(Number(tabId), {
        platform: p.platform,
        title: p.title,
        startedAt: p.startedAt,
        inMeeting: p.inMeeting,
        state: p.state,
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
        entries: s.accumulator.toJSON(),
      };
    }
    await browser.storage.session.set({ sessions: obj });
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
  if (!s || s.state === "done") {
    s = {
      platform,
      title: null,
      startedAt: Date.now(),
      inMeeting: false,
      state: "capturing",
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
