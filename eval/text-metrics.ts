// How far an engine's words are from the reference's: word error rate, or
// character error rate for a Meeting Language written without word spaces.
//
// Both sides go through the same normalisation first, so the rate measures what
// was heard rather than how it was typeset. Everything here is spelled out in
// docs/evaluations/README.md; a change to either must change the other, or the
// published numbers stop meaning what the method says they mean.
import type { MeetingLanguage } from "../src/domain/types";

export type ErrorMetric = "wer" | "cer";

/**
 * Meeting Languages whose text puts no spaces between words. Splitting them on
 * whitespace would turn a whole sentence into one "word", so one wrong character
 * would cost as much as the sentence; they are measured in characters instead.
 * Korean is not here: it writes spaces between words.
 */
export const CHARACTER_ERROR_LANGUAGES: ReadonlySet<MeetingLanguage> = new Set(["zh", "ja", "th"]);

export function metricFor(language: MeetingLanguage): ErrorMetric {
  return CHARACTER_ERROR_LANGUAGES.has(language) ? "cer" : "wer";
}

/**
 * The normalisation both sides get, in order:
 *
 *  1. Unicode NFKC, so full-width and compatibility forms read as their plain
 *     letters and digits.
 *  2. Lowercase.
 *  3. Apostrophes (' and ’) deleted, so "don't" and "dont" are one word.
 *  4. Every other punctuation or symbol character (Unicode P and S) becomes a
 *     space, so "follow-up" is two words on both sides.
 *  5. Runs of whitespace collapse to one space; the ends are trimmed.
 *
 * Nothing else: "10" and "ten" differ, and so do two spellings of one word.
 */
export function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Normalised text → the units the metric counts: words, or characters without whitespace. */
export function tokensFor(text: string, metric: ErrorMetric): string[] {
  const normalised = normalise(text);
  if (metric === "cer") return Array.from(normalised.replace(/\s/gu, ""));
  return normalised === "" ? [] : normalised.split(" ");
}

export interface ErrorCounts {
  metric: ErrorMetric;
  substitutions: number;
  deletions: number;
  insertions: number;
  /** Words or characters in the normalised reference: the rate's denominator. */
  referenceLength: number;
  /** (substitutions + deletions + insertions) / referenceLength. Can exceed 1.
   * Null for a reference with nothing left after normalisation. */
  rate: number | null;
}

/**
 * The fewest substitutions, deletions and insertions that turn `reference` into
 * `hypothesis`, each costing one.
 *
 * Two rolling rows rather than the whole table: an hour of Chinese is tens of
 * thousands of characters a side, and the full table would not fit in memory.
 * Each cell carries its own counts alongside its cost, so no backtrace is
 * needed. Where two paths cost the same, the tie goes to substitution, then
 * deletion, then insertion, so the split between the three is deterministic.
 */
export function editCounts(
  reference: readonly string[],
  hypothesis: readonly string[],
): { substitutions: number; deletions: number; insertions: number } {
  const width = hypothesis.length + 1;
  const newRow = () => ({
    cost: new Int32Array(width),
    s: new Int32Array(width),
    d: new Int32Array(width),
    i: new Int32Array(width),
  });
  let prev = newRow();
  let row = newRow();
  // Row 0: an empty reference, so every hypothesis token is an insertion.
  for (let j = 0; j < width; j++) {
    prev.cost[j] = j;
    prev.i[j] = j;
  }
  for (let r = 1; r <= reference.length; r++) {
    // Column 0: an empty hypothesis, so every reference token is a deletion.
    row.cost[0] = r;
    row.s[0] = 0;
    row.d[0] = r;
    row.i[0] = 0;
    for (let j = 1; j < width; j++) {
      const same = reference[r - 1] === hypothesis[j - 1];
      const diagonal = prev.cost[j - 1]! + (same ? 0 : 1);
      const up = prev.cost[j]! + 1; // delete reference[r - 1]
      const left = row.cost[j - 1]! + 1; // insert hypothesis[j - 1]
      if (diagonal <= up && diagonal <= left) {
        row.cost[j] = diagonal;
        row.s[j] = prev.s[j - 1]! + (same ? 0 : 1);
        row.d[j] = prev.d[j - 1]!;
        row.i[j] = prev.i[j - 1]!;
      } else if (up <= left) {
        row.cost[j] = up;
        row.s[j] = prev.s[j]!;
        row.d[j] = prev.d[j]! + 1;
        row.i[j] = prev.i[j]!;
      } else {
        row.cost[j] = left;
        row.s[j] = row.s[j - 1]!;
        row.d[j] = row.d[j - 1]!;
        row.i[j] = row.i[j - 1]! + 1;
      }
    }
    [prev, row] = [row, prev];
  }
  const last = hypothesis.length;
  return { substitutions: prev.s[last]!, deletions: prev.d[last]!, insertions: prev.i[last]! };
}

/** The error rate of `hypothesis` against `reference`, both whole-clip text. */
export function errorRate(reference: string, hypothesis: string, metric: ErrorMetric): ErrorCounts {
  const ref = tokensFor(reference, metric);
  const counts = editCounts(ref, tokensFor(hypothesis, metric));
  const errors = counts.substitutions + counts.deletions + counts.insertions;
  return {
    metric,
    ...counts,
    referenceLength: ref.length,
    rate: ref.length === 0 ? null : errors / ref.length,
  };
}
