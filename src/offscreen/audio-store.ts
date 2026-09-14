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
