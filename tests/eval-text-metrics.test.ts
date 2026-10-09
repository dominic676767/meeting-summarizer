// Word and character error rate, with the worked examples
// docs/evaluations/README.md quotes: each one small enough to check by hand.
import { describe, expect, it } from "vitest";
import { editCounts, errorRate, metricFor, normalise, tokensFor } from "../eval/text-metrics";

describe("normalise", () => {
  it.each([
    ["case, and punctuation at the ends", "Ship the BETA today.", "ship the beta today"],
    ["apostrophes deleted rather than splitting a word", "Don't — we’re late!", "dont were late"],
    ["other punctuation and symbols become word breaks", "follow-up: 10% (maybe)", "follow up 10 maybe"],
    ["whitespace collapsed and trimmed", "  a \n\t b  ", "a b"],
    ["full-width forms folded by NFKC", "ＡＢＣ　１２３", "abc 123"],
    ["full-width Chinese punctuation", "我们，下周发布。", "我们 下周发布"],
  ])("%s", (_, input, expected) => {
    expect(normalise(input)).toBe(expected);
  });

  it("leaves numbers and spellings alone, so they still count as errors", () => {
    expect(normalise("ten")).not.toBe(normalise("10"));
  });
});

describe("metricFor", () => {
  it("uses characters for languages written without word spaces, words for the rest", () => {
    expect(["zh", "ja", "th"].map((l) => metricFor(l as "zh"))).toEqual(["cer", "cer", "cer"]);
    expect(["en", "de", "ko"].map((l) => metricFor(l as "en"))).toEqual(["wer", "wer", "wer"]);
  });
});

describe("tokensFor", () => {
  it("counts characters without whitespace for CER, and nothing for empty text", () => {
    expect(tokensFor("我们 下周。", "cer")).toEqual(["我", "们", "下", "周"]);
    expect(tokensFor(" ... ", "wer")).toEqual([]);
  });
});

describe("errorRate — worked examples", () => {
  it("one substitution and one deletion in four words is a WER of 0.5", () => {
    // reference: ship the beta today   hypothesis: ship a beta
    //            =    S   =    D
    expect(errorRate("Ship the beta today.", "ship a beta", "wer")).toEqual({
      metric: "wer",
      substitutions: 1,
      deletions: 1,
      insertions: 0,
      referenceLength: 4,
      rate: 0.5,
    });
  });

  it("insertions can take the rate past 1", () => {
    // reference: yes   hypothesis: yes yes yes — two words the reference never had
    expect(errorRate("Yes.", "yes, yes, yes", "wer")).toMatchObject({ insertions: 2, rate: 2 });
  });

  it("an engine that heard nothing has deleted every word: a rate of exactly 1", () => {
    expect(errorRate("we should ship", "", "wer")).toMatchObject({ deletions: 3, rate: 1 });
  });

  it("differences only in case and punctuation cost nothing", () => {
    expect(errorRate("OK — let's ship.", "ok lets ship", "wer").rate).toBe(0);
  });

  it("one wrong character in six Chinese characters is a CER of 1/6", () => {
    // 我们下周发布 against 我们下周发部: 布 heard as 部
    expect(errorRate("我们下周发布。", "我们下周发部", "cer")).toMatchObject({
      substitutions: 1,
      referenceLength: 6,
      rate: 1 / 6,
    });
  });

  it("measured in words, the same Chinese sentence would be one word wholly wrong", () => {
    expect(errorRate("我们下周发布。", "我们下周发部", "wer").rate).toBe(1);
  });

  it("has no rate for a reference with nothing left after normalisation", () => {
    expect(errorRate("…", "hello", "wer")).toMatchObject({ referenceLength: 0, insertions: 1, rate: null });
  });
});

describe("editCounts", () => {
  it("is the minimum edit distance, split deterministically", () => {
    // kitten → sitting: the textbook distance of 3 (two substitutions, one insertion).
    expect(editCounts([..."kitten"], [..."sitting"])).toEqual({
      substitutions: 2,
      deletions: 0,
      insertions: 1,
    });
  });

  it("finds a deletion in the middle rather than a run of substitutions", () => {
    expect(editCounts(["a", "b", "c", "d"], ["a", "c", "d"])).toEqual({
      substitutions: 0,
      deletions: 1,
      insertions: 0,
    });
  });

  it("handles an hour-long reference without building the whole table", () => {
    const words = Array.from({ length: 9_000 }, (_, i) => `w${i % 50}`);
    const counts = editCounts(words, words.slice(1));
    expect(counts.substitutions + counts.deletions + counts.insertions).toBe(1);
  });
});
