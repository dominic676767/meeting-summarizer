// Held Transcript store (browser.storage.local): a Transcript whose
// summarization failed is retained for retry — never dropped. An entry is
// released only after the Summary Artifact write is confirmed.
import type { HeldTranscript, Transcript } from "../domain/types";

type HeldMap = Record<string, HeldTranscript>;

// All mutations are read-modify-write over the whole map — serialize them so
// concurrent operations (hold while a retry releases) can never overwrite
// each other and silently discard an entry.
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

async function readAll(): Promise<HeldMap> {
  const stored = (await browser.storage.local.get("held")) as { held?: HeldMap };
  return stored.held ?? {};
}

export function holdTranscript(transcript: Transcript, reason: string): Promise<HeldTranscript> {
  return withLock(async () => {
    const held = await readAll();
    const entry: HeldTranscript = {
      id: `${transcript.endedAt ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      transcript,
      reason,
      failedAt: Date.now(),
    };
    held[entry.id] = entry;
    await browser.storage.local.set({ held });
    return entry;
  });
}

export async function listHeld(): Promise<HeldTranscript[]> {
  const held = await readAll();
  return Object.values(held).sort((a, b) => b.failedAt - a.failedAt);
}

export async function getHeld(id: string): Promise<HeldTranscript | undefined> {
  return (await readAll())[id];
}

/** Delete a Held Transcript — call ONLY after the artifact write is confirmed. */
export function releaseHeld(id: string): Promise<void> {
  return withLock(async () => {
    const held = await readAll();
    delete held[id];
    await browser.storage.local.set({ held });
  });
}

/** Update the failure reason after an unsuccessful retry (entry stays held). */
export function updateHeldReason(id: string, reason: string): Promise<void> {
  return withLock(async () => {
    const held = await readAll();
    const entry = held[id];
    if (!entry) return;
    entry.reason = reason;
    entry.failedAt = Date.now();
    await browser.storage.local.set({ held });
  });
}
