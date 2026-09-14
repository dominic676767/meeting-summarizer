// Held Recording store (ext.storage.local): an Audio Recording whose
// transcription failed is retained for retry — never dropped, because a Meeting
// whose audio is gone cannot be recovered by anything. An entry is released only
// once its Transcript exists, from which point the Held Transcript store owns
// the retry chain.
import { ext } from "../platform";
import type { CaptureSpan, HeldRecording, Transcript } from "../domain/types";

type HeldMap = Record<string, HeldRecording>;

/**
 * An entry as storage may hold it. Before Capture Spans, a held Meeting was one
 * Audio Recording keyed by `recordingId` with one Capture Start offset — which is
 * one span, so it is read as one rather than stranded unretriable.
 */
type StoredRecording = Omit<HeldRecording, "spans"> & {
  spans?: CaptureSpan[];
  startOffsetMs?: number;
};

function normalize(entry: StoredRecording): HeldRecording {
  const { startOffsetMs, ...rest } = entry;
  return {
    ...rest,
    spans: entry.spans ?? [{ spanId: entry.recordingId, startOffsetMs: startOffsetMs ?? 0 }],
  };
}

// Same discipline as the Held Transcript store: every mutation is a
// read-modify-write over the whole map, so they are serialized — a hold racing a
// release must not overwrite it and silently strand or discard audio.
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

async function readAll(): Promise<HeldMap> {
  const stored = (await ext.storage.local.get("heldRecordings")) as {
    heldRecordings?: Record<string, StoredRecording>;
  };
  const held: HeldMap = {};
  for (const [id, entry] of Object.entries(stored.heldRecordings ?? {})) {
    held[id] = normalize(entry);
  }
  return held;
}

export interface RecordingToHold {
  recordingId: string;
  /** The Meeting's caption-only Transcript, carrying the Speaker Track. */
  transcript: Transcript;
  /** Every Capture Span of the Meeting, in Capture Start order. A hold covers all
   * of the Meeting's audio or the retry recovers only part of it. */
  spans: CaptureSpan[];
}

/** Hold an Audio Recording for retry. Keyed by the Meeting's recording id, so a
 * second failure for the same Meeting updates the entry rather than holding it
 * twice — however many spans that Meeting has. */
export function holdRecording(
  recording: RecordingToHold,
  reason: string,
): Promise<HeldRecording> {
  return withLock(async () => {
    const held = await readAll();
    const entry: HeldRecording = {
      recordingId: recording.recordingId,
      transcript: recording.transcript,
      spans: recording.spans,
      reason,
      failedAt: Date.now(),
    };
    held[entry.recordingId] = entry;
    await ext.storage.local.set({ heldRecordings: held });
    return entry;
  });
}

export async function listHeldRecordings(): Promise<HeldRecording[]> {
  const held = await readAll();
  return Object.values(held).sort((a, b) => b.failedAt - a.failedAt);
}

export async function getHeldRecording(recordingId: string): Promise<HeldRecording | undefined> {
  return (await readAll())[recordingId];
}

/** Delete a Held Recording — call ONLY once its Transcript is durably held. */
export function releaseHeldRecording(recordingId: string): Promise<void> {
  return withLock(async () => {
    const held = await readAll();
    delete held[recordingId];
    await ext.storage.local.set({ heldRecordings: held });
  });
}

/** Update the failure reason after an unsuccessful retry (the audio stays held). */
export function updateHeldRecordingReason(recordingId: string, reason: string): Promise<void> {
  return withLock(async () => {
    const held = await readAll();
    const entry = held[recordingId];
    if (!entry) return;
    entry.reason = reason;
    entry.failedAt = Date.now();
    await ext.storage.local.set({ heldRecordings: held });
  });
}
