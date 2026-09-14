// Incremental sink for an Audio Recording. MediaRecorder emits encoded chunks
// every few seconds; they are written straight to browser-managed storage so an
// hour-long call is never held whole in memory (ADR-0004). OPFS is preferred
// because it appends by byte offset without re-reading the file; IndexedDB is
// the fallback where OPFS is unavailable. Keyed by recording id so the next
// slice (Held Recording, transcription) can find the audio again.
//
// A quota failure is thrown from append() so the caller can surface it as a
// capture warning rather than let the recording stop silently.

export interface AudioStore {
  append(chunk: Blob): Promise<void>;
  close(): Promise<void>;
}

async function openOpfsStore(recordingId: string): Promise<AudioStore> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(`${recordingId}.webm`, { create: true });
  // One writable held open for the whole recording; each chunk is written at
  // the running byte offset so nothing already flushed is re-buffered.
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

function openIdbStore(recordingId: string): Promise<AudioStore> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("meeting-audio", 1);
    open.onupgradeneeded = () => {
      // Composite key [recordingId, seq] keeps one recording's chunks ordered
      // and separable from another's.
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
            tx.objectStore("chunks").put({ recordingId, seq: seq++, blob: chunk });
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

export async function openAudioStore(recordingId: string): Promise<AudioStore> {
  if (typeof navigator.storage?.getDirectory === "function") {
    try {
      return await openOpfsStore(recordingId);
    } catch {
      // OPFS present but unusable (e.g. private-mode restrictions) — fall through.
    }
  }
  return openIdbStore(recordingId);
}

async function readOpfs(recordingId: string): Promise<Blob | null> {
  if (typeof navigator.storage?.getDirectory !== "function") return null;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(`${recordingId}.webm`);
    return await handle.getFile();
  } catch {
    return null; // not written here — the IndexedDB fallback owns it
  }
}

function idbChunks(recordingId: string, mode: "readonly" | "readwrite"): Promise<Blob[]> {
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
      // Composite-key range over one recording only; another Meeting's chunks
      // must never bleed into this one's audio.
      const range = IDBKeyRange.bound(
        [recordingId, -1],
        [recordingId, Number.MAX_SAFE_INTEGER],
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
 * The whole Audio Recording for one Meeting, reassembled for transcription.
 * Held in memory only for as long as the Transcription Provider needs it — the
 * recording itself was never accumulated in memory while it was being made.
 */
export async function readRecording(recordingId: string): Promise<Blob> {
  const file = await readOpfs(recordingId);
  if (file) return file;
  return new Blob(await idbChunks(recordingId, "readonly"), { type: "audio/webm" });
}

/** Discard an Audio Recording. Called once its Summary Artifact is written, so
 * recordings never accumulate on the user's disk. */
export async function deleteRecording(recordingId: string): Promise<void> {
  if (typeof navigator.storage?.getDirectory === "function") {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(`${recordingId}.webm`);
    } catch {
      // Not in OPFS (or already gone) — the IndexedDB sweep below covers it.
    }
  }
  await idbChunks(recordingId, "readwrite").catch(() => []);
}
