// Incremental sink for one Capture Span. MediaRecorder emits encoded chunks
// every few seconds; they are written straight to browser-managed storage so an
// hour-long call is never held whole in memory (ADR-0004). OPFS is preferred
// because it appends by byte offset without re-reading the file; IndexedDB is
// the fallback where OPFS is unavailable. Keyed by span id so the next slice
// (Held Recording, transcription) can find every span of a Meeting again.
//
// One store per Capture Span, never one per Meeting: each Capture Start begins a
// fresh MediaRecorder session and therefore a fresh WebM container, so a second
// span cannot be written into the first span's file (ADR-0005).
//
// A quota failure is thrown from append() so the caller can surface it as a
// capture warning rather than let the recording stop silently.

export interface AudioStore {
  append(chunk: Blob): Promise<void>;
  close(): Promise<void>;
}

async function openOpfsStore(spanId: string): Promise<AudioStore> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(`${spanId}.webm`, { create: true });
  // One writable held open for the whole span; each chunk is written at the
  // running byte offset so nothing already flushed is re-buffered. Starting at
  // byte zero is correct precisely because a span id is written exactly once —
  // the earlier defect was reusing one id across Capture Starts, which truncated
  // the first span's file (ADR-0005).
  const writable = await handle.createWritable();
  let position = 0;
  return {
    async append(chunk: Blob): Promise<void> {
      await writable.write({ type: "write", position, data: chunk });
      position += chunk.size;
    },
    async close(): Promise<void> {
      await writable.close();
    },
  };
}

function openIdbStore(spanId: string): Promise<AudioStore> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("meeting-audio", 1);
    open.onupgradeneeded = () => {
      // Composite key [recordingId, seq] keeps one span's chunks ordered and
      // separable from another's. The key's name predates Capture Spans and is
      // deliberately left alone: renaming it would need a schema migration, and
      // a migration that recreated the store would drop the chunks of a Held
      // Recording waiting to be retried.
      open.result.createObjectStore("chunks", { keyPath: ["recordingId", "seq"] });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      let seq = 0;
      resolve({
        append(chunk: Blob): Promise<void> {
          return new Promise((res, rej) => {
            const tx = db.transaction("chunks", "readwrite");
            tx.objectStore("chunks").put({ recordingId: spanId, seq: seq++, blob: chunk });
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
          });
        },
        close(): Promise<void> {
          db.close();
          return Promise.resolve();
        },
      });
    };
  });
}

export async function openAudioStore(spanId: string): Promise<AudioStore> {
  if (typeof navigator.storage?.getDirectory === "function") {
    try {
      return await openOpfsStore(spanId);
    } catch {
      // OPFS present but unusable (e.g. private-mode restrictions) — fall through.
    }
  }
  return openIdbStore(spanId);
}

async function readOpfs(spanId: string): Promise<Blob | null> {
  if (typeof navigator.storage?.getDirectory !== "function") return null;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(`${spanId}.webm`);
    return await handle.getFile();
  } catch {
    return null; // not written here — the IndexedDB fallback owns it
  }
}

function idbChunks(spanId: string, mode: "readonly" | "readwrite"): Promise<Blob[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("meeting-audio", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("chunks", { keyPath: ["recordingId", "seq"] });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("chunks", mode);
      const store = tx.objectStore("chunks");
      // Composite-key range over one span only; another span's chunks — or
      // another Meeting's — must never bleed into this one's audio.
      const range = IDBKeyRange.bound(
        [spanId, -1],
        [spanId, Number.MAX_SAFE_INTEGER],
      );
      const req = store.getAll(range);
      if (mode === "readwrite") store.delete(range);
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => {
        db.close();
        const rows = (req.result ?? []) as { seq: number; blob: Blob }[];
        resolve(rows.sort((a, b) => a.seq - b.seq).map((r) => r.blob));
      };
    };
  });
}

/**
 * One Capture Span, reassembled for transcription. Held in memory only for as
 * long as the Transcription Provider needs it — the span itself was never
 * accumulated in memory while it was being recorded.
 */
export async function readSpan(spanId: string): Promise<Blob> {
  const file = await readOpfs(spanId);
  if (file) return file;
  return new Blob(await idbChunks(spanId, "readonly"), { type: "audio/webm" });
}

/** Discard one Capture Span. Every span of a Meeting is deleted once its Summary
 * Artifact is written, so recordings never accumulate on the user's disk. */
export async function deleteSpan(spanId: string): Promise<void> {
  if (typeof navigator.storage?.getDirectory === "function") {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(`${spanId}.webm`);
    } catch {
      // Not in OPFS (or already gone) — the IndexedDB sweep below covers it.
    }
  }
  await idbChunks(spanId, "readwrite").catch(() => []);
}
