// Speaker accuracy: the many-to-one mapping from engine labels to reference
// speakers, and the share of reference speech credited to the right one. The
// worked examples are the ones docs/evaluations/README.md quotes.
import { describe, expect, it } from "vitest";
import type { Utterance } from "../src/domain/types";
import type { ReferenceSegment } from "../eval/clips";
import {
  engineLabelCount,
  overlapSec,
  referenceSpeakerCount,
  speakerAccuracy,
  union,
} from "../eval/speakers";

const ref = (speaker: string, start: number, end: number): ReferenceSegment => ({
  speaker,
  start,
  end,
  text: "…",
});
/** Seconds in, as the reference writes them; the Utterance itself is in ms. */
const said = (label: string | undefined, start: number, end: number): Utterance => ({
  text: "…",
  startMs: start * 1000,
  endMs: end * 1000,
  ...(label ? { diarizationLabel: label } : {}),
});

describe("interval arithmetic", () => {
  it("merges overlapping and touching intervals, dropping empty ones", () => {
    expect(union([[5, 6], [0, 2], [1, 3], [3, 4], [7, 7]])).toEqual([[0, 4], [5, 6]]);
  });

  it("measures the time two interval lists share", () => {
    expect(overlapSec([[0, 4], [6, 10]], [[3, 7]])).toBe(2);
  });
});

describe("speakerAccuracy — worked examples", () => {
  it("credits each label's speech to the speaker it overlaps most", () => {
    // Aisha 0–4 s, Bo 4–8 s. Speaker 1 runs a second into Bo's turn.
    // Speaker 1 overlaps Aisha 4 s and Bo 1 s → Aisha; Speaker 2 → Bo.
    // Correct: Aisha's 4 s, and 3 of Bo's 4 s. 7 / 8 = 0.875.
    const result = speakerAccuracy(
      [ref("Aisha", 0, 4), ref("Bo", 4, 8)],
      [said("Speaker 1", 0, 5), said("Speaker 2", 5, 8)],
    );
    expect(result.mapping).toEqual([
      { label: "Speaker 1", speaker: "Aisha", overlapSec: 4 },
      { label: "Speaker 2", speaker: "Bo", overlapSec: 3 },
    ]);
    expect(result).toMatchObject({ correctSec: 7, referenceSpeechSec: 8, accuracy: 0.875 });
  });

  it("maps two labels to one person without penalty: many-to-one", () => {
    // What the wrapper does across engine calls: one voice, one label per part.
    const result = speakerAccuracy(
      [ref("Aisha", 0, 8)],
      [said("Speaker 1 (part 1)", 0, 4), said("Speaker 1 (part 2)", 4, 8)],
    );
    expect(result.mapping.map((m) => m.speaker)).toEqual(["Aisha", "Aisha"]);
    expect(result.accuracy).toBe(1);
  });

  it("scores one label for everybody as the dominant speaker's share, which the counts expose", () => {
    const reference = [ref("Aisha", 0, 6), ref("Bo", 6, 8)];
    const utterances = [said("Speaker 1", 0, 8)];
    expect(speakerAccuracy(reference, utterances).accuracy).toBe(0.75);
    expect(engineLabelCount(utterances)).toBe(1);
    expect(referenceSpeakerCount(reference)).toBe(2);
  });

  it("counts reference speech no labelled Utterance covers as not correct", () => {
    const result = speakerAccuracy(
      [ref("Aisha", 0, 4), ref("Bo", 4, 8)],
      [said("Speaker 1", 0, 4), said(undefined, 4, 8)],
    );
    expect(result.accuracy).toBe(0.5);
  });

  it("does not penalise engine speech outside reference speech", () => {
    expect(speakerAccuracy([ref("Aisha", 2, 4)], [said("Speaker 1", 0, 10)]).accuracy).toBe(1);
  });

  it("counts crosstalk once per speaker, so one label cannot be right for both", () => {
    // Aisha 0–4 s, Bo talks over her 2–4 s: 6 s of reference speech.
    // Speaker 1 covers 0–4 s and maps to Aisha, so Bo's 2 s are not credited.
    const result = speakerAccuracy(
      [ref("Aisha", 0, 4), ref("Bo", 2, 4)],
      [said("Speaker 1", 0, 4)],
    );
    expect(result).toMatchObject({ correctSec: 4, referenceSpeechSec: 6 });
  });
});

describe("speakerAccuracy — the mapping's edges", () => {
  it("breaks a tie in favour of the reference speaker who speaks first", () => {
    const result = speakerAccuracy(
      [ref("Bo", 2, 4), ref("Aisha", 0, 2)],
      [said("Speaker 1", 1, 3)],
    );
    expect(result.mapping[0]?.speaker).toBe("Aisha");
  });

  it("leaves a label that overlaps nobody unmapped, crediting nothing", () => {
    const result = speakerAccuracy([ref("Aisha", 0, 2)], [said("Speaker 1", 5, 6)]);
    expect(result.mapping).toEqual([{ label: "Speaker 1", speaker: null, overlapSec: 0 }]);
    expect(result.accuracy).toBe(0);
  });

  it("does not double-count Utterances that overlap each other", () => {
    const result = speakerAccuracy(
      [ref("Aisha", 0, 4)],
      [said("Speaker 1", 0, 3), said("Speaker 1", 1, 4)],
    );
    expect(result).toMatchObject({ correctSec: 4, accuracy: 1 });
  });

  it("counts only labelled Utterances as engine speaker labels", () => {
    expect(engineLabelCount([said(undefined, 0, 1), said("Speaker 2", 1, 2), said("Speaker 2", 2, 3)])).toBe(1);
  });
});
