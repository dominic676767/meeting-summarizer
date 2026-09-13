import type { CaptionSnapshot } from "./adapter";
import type { CaptionSegment } from "../domain/types";

interface Entry {
  order: number;
  speaker: string;
  text: string;
  capturedAt: number;
}

/**
 * Accumulates Caption Segments for one Meeting. Upserts are keyed by the
 * adapter's stable caption key, so in-place caption mutations (live ASR
 * refining its text) update the existing entry instead of duplicating it.
 */
export class TranscriptAccumulator {
  private entries = new Map<string, Entry>();
  private counter = 0;

  upsert(snapshot: CaptionSnapshot, capturedAt: number): void {
    if (!snapshot.text.trim()) return;
    const existing = this.entries.get(snapshot.key);
    if (existing) {
      existing.speaker = snapshot.speaker;
      existing.text = snapshot.text;
    } else {
      this.entries.set(snapshot.key, {
        order: this.counter++,
        speaker: snapshot.speaker,
        text: snapshot.text,
        capturedAt,
      });
    }
  }

  upsertAll(snapshots: CaptionSnapshot[], capturedAt: number): void {
    for (const s of snapshots) this.upsert(s, capturedAt);
  }

  get size(): number {
    return this.entries.size;
  }

  toSegments(): CaptionSegment[] {
    return [...this.entries.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ speaker, text, capturedAt }) => ({ speaker, text, capturedAt }));
  }

  /** Serializable snapshot for storage.session mirroring. */
  toJSON(): Array<[string, Entry]> {
    return [...this.entries.entries()];
  }

  static fromJSON(data: Array<[string, Entry]>): TranscriptAccumulator {
    const acc = new TranscriptAccumulator();
    acc.entries = new Map(data);
    acc.counter = data.reduce((max, [, e]) => Math.max(max, e.order + 1), 0);
    return acc;
  }
}
