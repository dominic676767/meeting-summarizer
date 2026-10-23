import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAudioStore } from "../src/offscreen/audio-store";

// An OPFS writable keeps its writes in a swap file until close(), so a reload or
// crash mid-recording left the span empty. Each chunk must instead be committed
// in its own IndexedDB transaction before append() resolves.
class FakeTransaction {
  rows: unknown[] = [];
  error: DOMException | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  objectStore() {
    return { put: (row: unknown) => this.rows.push(row) };
  }
}

let transactions: FakeTransaction[];
const getDirectory = vi.fn();

beforeEach(() => {
  transactions = [];
  const db = {
    transaction: () => {
      const tx = new FakeTransaction();
      transactions.push(tx);
      return tx;
    },
    close: vi.fn(),
  };
  vi.stubGlobal("navigator", { storage: { getDirectory } });
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = { result: db, onsuccess: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  getDirectory.mockReset();
});

describe("openAudioStore", () => {
  it("commits every chunk in its own IndexedDB transaction and never writes to OPFS", async () => {
    const store = await openAudioStore("span-1");
    const first = new Blob(["a"]);
    const second = new Blob(["b"]);

    let committed = false;
    const append = store.append(first).then(() => (committed = true));
    await Promise.resolve();
    expect(committed).toBe(false); // not durable until the transaction completes
    transactions[0]!.oncomplete?.();
    await append;

    const next = store.append(second);
    transactions[1]!.oncomplete?.();
    await next;
    await store.close();

    expect(transactions.map((tx) => tx.rows)).toEqual([
      [{ recordingId: "span-1", seq: 0, blob: first }],
      [{ recordingId: "span-1", seq: 1, blob: second }],
    ]);
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it("rejects append when a quota failure aborts the transaction", async () => {
    const store = await openAudioStore("span-1");
    const append = store.append(new Blob(["a"]));
    const tx = transactions[0]!;
    tx.error = new DOMException("Quota exceeded", "QuotaExceededError");
    tx.onabort?.();
    await expect(append).rejects.toThrow("Quota exceeded");
  });
});
