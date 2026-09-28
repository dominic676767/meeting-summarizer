// ElevenLabs Scribe: the word list → spans conversion.
//
// This is where the engine decides what the transcript says and who said it,
// so it is pinned directly, with no request and no provider wrapper. Times here
// are relative to the uploaded audio; making them absolute is the wrapper's job
// and is covered in transcription.test.ts.
import { describe, expect, it } from "vitest";
import {
  SCRIBE_MAX_SPAN_SEC,
  SCRIBE_PAUSE_SPLIT_SEC,
  spansFromScribe,
  type ScribeWord,
} from "../src/transcription/elevenlabs";

const word = (text: string, start: number, end: number, speaker_id?: string): ScribeWord => ({
  text,
  type: "word",
  start,
  end,
  ...(speaker_id ? { speaker_id } : {}),
});
const space = (at: number): ScribeWord => ({ text: " ", type: "spacing", start: at, end: at });

describe("spansFromScribe", () => {
  it("joins one speaker's consecutive words into a span, spacing as written", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("Ship", 0, 0.3, "speaker_0"),
          space(0.3),
          word("it", 0.35, 0.5, "speaker_0"),
          space(0.5),
          word("Friday.", 0.55, 1, "speaker_0"),
        ],
      },
      5,
    );
    expect(spans).toEqual([{ text: "Ship it Friday.", startSec: 0, endSec: 1, speaker: "Speaker 1" }]);
  });

  it("splits at a speaker change and numbers speakers by first appearance", () => {
    const spans = spansFromScribe(
      {
        words: [
          // Scribe's ids carry no order worth keeping: the first voice heard is Speaker 1.
          word("Ready?", 0, 0.5, "speaker_3"),
          space(0.5),
          word("Yes.", 0.6, 0.9, "speaker_0"),
          space(0.9),
          word("Go.", 1, 1.2, "speaker_3"),
        ],
      },
      5,
    );
    expect(spans).toEqual([
      { text: "Ready?", startSec: 0, endSec: 0.5, speaker: "Speaker 1" },
      { text: "Yes.", startSec: 0.6, endSec: 0.9, speaker: "Speaker 2" },
      { text: "Go.", startSec: 1, endSec: 1.2, speaker: "Speaker 1" },
    ]);
  });

  it("splits one speaker's words at a long enough pause", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("First.", 0, 1, "speaker_0"),
          space(1),
          word("Second.", 1 + SCRIBE_PAUSE_SPLIT_SEC, 3, "speaker_0"),
        ],
      },
      5,
    );
    expect(spans.map((s) => s.text)).toEqual(["First.", "Second."]);
  });

  it("does not split at a pause shorter than the threshold", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("One", 0, 1, "speaker_0"),
          space(1),
          word("breath.", 1 + SCRIBE_PAUSE_SPLIT_SEC - 0.1, 3, "speaker_0"),
        ],
      },
      5,
    );
    expect(spans.map((s) => s.text)).toEqual(["One breath."]);
  });

  it("ends a span before it would pass the length cap", () => {
    // One word a second, no pauses, one speaker: only the cap can split this.
    const words: ScribeWord[] = [];
    for (let i = 0; i < SCRIBE_MAX_SPAN_SEC + 10; i++) {
      words.push(word(`w${i}`, i, i + 1, "speaker_0"), space(i + 1));
    }
    const spans = spansFromScribe({ words }, SCRIBE_MAX_SPAN_SEC + 10);
    expect(spans.length).toBe(2);
    expect(spans[0]!.endSec - spans[0]!.startSec).toBeLessThanOrEqual(SCRIBE_MAX_SPAN_SEC);
    expect(spans[1]!.startSec).toBe(spans[0]!.endSec);
  });

  it("drops audio events, which are not speech", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("Funny.", 0, 0.5, "speaker_0"),
          { text: "(laughter)", type: "audio_event", start: 0.5, end: 1.5 },
          word("Anyway.", 1.6, 2, "speaker_0"),
        ],
      },
      5,
    );
    expect(spans.map((s) => s.text).join(" ")).not.toContain("laughter");
  });

  it("keeps an untimed word, placed at the latest timing seen", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("Timed", 0, 0.5, "speaker_0"),
          space(0.5),
          { text: "untimed", type: "word", start: null, end: null, speaker_id: "speaker_0" },
        ],
      },
      5,
    );
    expect(spans).toEqual([{ text: "Timed untimed", startSec: 0, endSec: 0.5, speaker: "Speaker 1" }]);
  });

  it("omits the speaker where Scribe gave none", () => {
    const spans = spansFromScribe({ words: [word("Hello.", 0, 1)] }, 5);
    expect(spans).toEqual([{ text: "Hello.", startSec: 0, endSec: 1 }]);
    expect(spans[0]).not.toHaveProperty("speaker");
  });

  it("joins words Scribe writes without spacing", () => {
    const spans = spansFromScribe(
      {
        words: [
          word("我们", 0, 0.4, "speaker_0"),
          word("周五", 0.4, 0.8, "speaker_0"),
          word("发布。", 0.8, 1.2, "speaker_0"),
        ],
      },
      5,
    );
    expect(spans).toEqual([{ text: "我们周五发布。", startSec: 0, endSec: 1.2, speaker: "Speaker 1" }]);
  });

  it("keeps the words when the response carries text but no word list", () => {
    expect(spansFromScribe({ text: "no word list" }, 8)).toEqual([
      { text: "no word list", startSec: 0, endSec: 8 },
    ]);
  });

  it("returns nothing for a word list with no speech in it", () => {
    // `text` would read "(laughter)": falling back to it would pass a sound off as words.
    const spans = spansFromScribe(
      {
        text: "(laughter)",
        words: [{ text: "(laughter)", type: "audio_event", start: 0, end: 1 }],
      },
      5,
    );
    expect(spans).toEqual([]);
  });
});
