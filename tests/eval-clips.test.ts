// The evaluation harness's inputs: a reference transcript typed by hand, and the
// manifest that pairs it with its audio and Meeting Language. Every problem is
// reported before anything runs, because a cloud engine bills for the audio
// whether or not the run then falls over.
import { describe, expect, it } from "vitest";
import {
  InvalidInput,
  selectClips,
  validateManifest,
  validateReference,
  type Clip,
} from "../eval/clips";

const problemsOf = (run: () => unknown): string[] => {
  try {
    run();
  } catch (err) {
    if (err instanceof InvalidInput) return err.problems;
    throw err;
  }
  throw new Error("expected InvalidInput");
};

describe("validateReference", () => {
  it("returns the segments sorted by start, overlaps kept", () => {
    const segments = validateReference(
      [
        { speaker: "Bo", start: 2, end: 4, text: "yes" },
        { speaker: " Aisha ", start: 0, end: 2.5, text: "ship it?", note: "crosstalk" },
      ],
      10,
    );
    expect(segments).toEqual([
      { speaker: "Aisha", start: 0, end: 2.5, text: "ship it?" },
      { speaker: "Bo", start: 2, end: 4, text: "yes" },
    ]);
  });

  it("reports every problem in the file at once, each with its segment", () => {
    const problems = problemsOf(() =>
      validateReference(
        [
          { speaker: "", start: 0, end: 1, text: "hi" },
          { speaker: "Bo", start: 3, end: 2, text: "hi" },
          { speaker: "Bo", start: "0:05", end: 6, text: " " },
          "not a segment",
        ],
        10,
      ),
    );
    expect(problems).toEqual([
      "segment 0: speaker must be a non-empty string",
      "segment 1: end (2) must be after start (3)",
      "segment 2: text must be a non-empty string",
      "segment 2: start must be a number of seconds, 0 or more",
      "segment 3: must be an object with speaker, start, end and text",
    ]);
  });

  it("tolerates a rough final time, but not a reference written against a longer clip", () => {
    expect(() => validateReference([{ speaker: "A", start: 0, end: 10.6, text: "x" }], 10)).not.toThrow();
    expect(problemsOf(() => validateReference([{ speaker: "A", start: 0, end: 12, text: "x" }], 10)))
      .toEqual(["segment 0: ends at 12s, past the audio's 10.0s"]);
  });

  it("refuses anything but a non-empty array", () => {
    expect(problemsOf(() => validateReference({ segments: [] }, 10))).toEqual([
      "must be a JSON array of segments",
    ]);
    expect(problemsOf(() => validateReference([], 10))).toEqual(["has no segments"]);
  });
});

describe("validateManifest", () => {
  it("resolves each clip's paths against the manifest's directory", () => {
    expect(
      validateManifest(
        [{ name: "standup", audio: "standup.wav", reference: "standup.reference.json", language: "de" }],
        "/clips",
      ),
    ).toEqual([
      {
        name: "standup",
        audioPath: "/clips/standup.wav",
        referencePath: "/clips/standup.reference.json",
        language: "de",
      },
    ]);
  });

  it("refuses a language the extension does not offer, and a name used twice", () => {
    const clip = { audio: "a.wav", reference: "a.json" };
    expect(
      problemsOf(() =>
        validateManifest(
          [
            { ...clip, name: "a", language: "en" },
            { ...clip, name: "a", language: "en" },
            { ...clip, name: "b", language: "english" },
          ],
          "/",
        ),
      ),
    ).toEqual([
      'clip 1: name "a" is used twice',
      'clip 2: language "english" is not a Meeting Language code',
    ]);
  });
});

describe("selectClips", () => {
  const clips = ["a", "b", "c"].map(
    (name): Clip => ({ name, audioPath: "", referencePath: "", language: "en" }),
  );

  it("keeps manifest order, and every clip when none are named", () => {
    expect(selectClips(clips, ["c", "a"]).map((c) => c.name)).toEqual(["a", "c"]);
    expect(selectClips(clips, undefined)).toBe(clips);
  });

  it("refuses a name the manifest does not have rather than silently skipping it", () => {
    expect(problemsOf(() => selectClips(clips, ["a", "d"]))).toEqual([
      'no clip named "d" in the manifest',
    ]);
  });
});
