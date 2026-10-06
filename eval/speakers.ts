// Speaker accuracy, for an engine that diarizes.
//
// An engine's labels are anonymous ("Speaker 1"), so before they can be right or
// wrong each must be matched to a reference speaker. The mapping is
// many-to-one: every label goes to the reference speaker it overlaps most, and
// two labels may go to the same person. That is not leniency for its own sake.
// Across more than one engine call the provider wrapper names every label by its
// part ("Speaker 1 (part 2)"), so one voice carrying two labels is the product's
// intended behaviour (ADR-0008), and a one-to-one mapping would score it as an
// error. What many-to-one cannot see — one label spread over everybody — is why
// the report also counts labels against reference speakers.
//
// All durations are exact interval arithmetic in seconds; there is no frame grid.
import type { Utterance } from "../src/domain/types";
import type { ReferenceSegment } from "./clips";

type Interval = readonly [start: number, end: number];

/** Intervals → sorted, disjoint intervals covering the same time. */
export function union(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Seconds covered by both of two sorted, disjoint interval lists. */
export function overlapSec(a: readonly Interval[], b: readonly Interval[]): number {
  let total = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [aStart, aEnd] = a[i]!;
    const [bStart, bEnd] = b[j]!;
    total += Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
    if (aEnd < bEnd) i++;
    else j++;
  }
  return total;
}

const lengthSec = (intervals: readonly Interval[]) =>
  intervals.reduce((sum, [s, e]) => sum + (e - s), 0);

/** Each reference speaker's speech, in the order they first speak. */
function referenceSpeech(reference: readonly ReferenceSegment[]): Map<string, Interval[]> {
  const bySpeaker = new Map<string, Interval[]>();
  for (const seg of [...reference].sort((a, b) => a.start - b.start)) {
    const list = bySpeaker.get(seg.speaker) ?? [];
    list.push([seg.start, seg.end]);
    bySpeaker.set(seg.speaker, list);
  }
  return new Map([...bySpeaker].map(([speaker, list]) => [speaker, union(list)]));
}

/** Each engine label's speech, in seconds. Unlabelled Utterances are left out. */
function labelSpeech(utterances: readonly Utterance[]): Map<string, Interval[]> {
  const byLabel = new Map<string, Interval[]>();
  for (const u of utterances) {
    if (!u.diarizationLabel) continue;
    const list = byLabel.get(u.diarizationLabel) ?? [];
    list.push([u.startMs / 1000, u.endMs / 1000]);
    byLabel.set(u.diarizationLabel, list);
  }
  return new Map([...byLabel].map(([label, list]) => [label, union(list)]));
}

export function referenceSpeakerCount(reference: readonly ReferenceSegment[]): number {
  return new Set(reference.map((s) => s.speaker)).size;
}

export function engineLabelCount(utterances: readonly Utterance[]): number {
  return new Set(utterances.flatMap((u) => (u.diarizationLabel ? [u.diarizationLabel] : []))).size;
}

export interface LabelMapping {
  label: string;
  /** The reference speaker this label overlaps most, or null if it overlaps none. */
  speaker: string | null;
  /** How long the label and that speaker overlap. */
  overlapSec: number;
}

export interface SpeakerAccuracy {
  mapping: LabelMapping[];
  /** Reference speech whose speaker is covered by a label mapped to them. */
  correctSec: number;
  /** Every reference speaker's speech, summed; crosstalk counts once per speaker. */
  referenceSpeechSec: number;
  /** correctSec / referenceSpeechSec. */
  accuracy: number;
}

/**
 * The mapping, then the share of reference speech attributed to the right
 * speaker.
 *
 * A stretch of one reference speaker's speech counts as correct wherever some
 * Utterance whose label maps to that speaker covers it. Reference speech no
 * labelled Utterance covers is not correct: a word nobody was credited with is
 * a word the reader cannot attribute. Engine speech outside reference speech is
 * not penalised, so this is not a diarization error rate: it asks only whether
 * what was said is credited to whoever said it.
 *
 * A tie in overlap goes to the reference speaker who speaks first.
 */
export function speakerAccuracy(
  reference: readonly ReferenceSegment[],
  utterances: readonly Utterance[],
): SpeakerAccuracy {
  const speakers = referenceSpeech(reference);
  const labels = labelSpeech(utterances);

  const mapping: LabelMapping[] = [];
  const creditedTo = new Map<string, Interval[]>();
  for (const [label, speech] of labels) {
    let best: { speaker: string | null; overlapSec: number } = { speaker: null, overlapSec: 0 };
    for (const [speaker, theirs] of speakers) {
      const overlap = overlapSec(speech, theirs);
      if (overlap > best.overlapSec) best = { speaker, overlapSec: overlap };
    }
    mapping.push({ label, ...best });
    if (best.speaker !== null) {
      creditedTo.set(best.speaker, [...(creditedTo.get(best.speaker) ?? []), ...speech]);
    }
  }

  let correctSec = 0;
  let referenceSpeechSec = 0;
  for (const [speaker, theirs] of speakers) {
    referenceSpeechSec += lengthSec(theirs);
    correctSec += overlapSec(theirs, union(creditedTo.get(speaker) ?? []));
  }
  return {
    mapping,
    correctSec,
    referenceSpeechSec,
    accuracy: referenceSpeechSec === 0 ? 0 : correctSec / referenceSpeechSec,
  };
}
