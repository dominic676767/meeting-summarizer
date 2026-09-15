// Rejecting degenerate transcription output before it can count as audio words.
//
// Fed silence, Whisper does not return nothing: it returns its training data's
// filler. Two real Summary Artifacts were built from silent recordings whose
// whole Transcript was the single word "you", stamped "from recorded audio", with
// the LLM apologising that there was nothing to summarize. The caption words that
// would have carried those meetings were replaced wholesale by that one token,
// because a hallucination is indistinguishable from speech to a length check.
//
// So a hallucination must never outrank real captions. This module is the only
// judgement of whether transcription output carries speech at all, and it is
// pure — Utterances and a duration in, a reason or null out — so the rule is
// testable without a model, and the same rule can guard both the Transcription
// Provider (which knows the recording's duration) and fusion (which does not).
import type { Utterance } from "../domain/types";

/**
 * Why audio words were refused, in the words the surfaces can repeat. One reason
 * for every degenerate shape, because they are the same fact to the user: the
 * recording had nothing in it. Distinct from a transcription *failure*, which is
 * an outage worth retrying — retrying silence only reproduces silence.
 */
export const NO_SPEECH_REASON = "the recording carried no speech";

/**
 * What engines emit when handed silence. Whisper's canonical artifacts, matched
 * as whole fragments rather than substrings: "thank you" is an artifact on its
 * own and an ordinary courtesy inside a real sentence, and dropping every
 * sentence containing it would edit real meetings.
 */
const SILENCE_ARTIFACTS = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you very much",
  "thank you so much",
  "thank you for watching",
  "thanks for watching",
  "thanks for listening",
  "please subscribe",
  "please subscribe to my channel",
  "like and subscribe",
  "bye",
  "bye bye",
  "goodbye",
  "blank audio",
  "silence",
  "music",
  "applause",
  "inaudible",
  "the end",
]);

/** Credit lines the same engines hallucinate over silence, matched as openings
 * because their tails vary. */
const ARTIFACT_OPENINGS = ["subtitles by", "subtitling by", "transcription by", "amara org"];

/**
 * Below this, the recording's length says nothing about how much should have
 * been said: a genuine 20-second exchange really is a handful of words, and
 * rejecting it would throw away the accurate audio this product exists to
 * capture. Short recordings are judged on their content alone.
 */
const LENGTH_JUDGED_FROM_MS = 120_000;

/**
 * Distinct real words a minute of recording must yield to be believed. Speech
 * runs at a hundred-odd words a minute, so one is not a quality bar — it only
 * catches output that is negligible against the audio it claims to describe.
 */
const WORDS_PER_MINUTE = 1;

/**
 * Ceiling on that requirement. A long meeting can genuinely hold one short
 * exchange and an hour of quiet — a lull is not a hallucination, and the words
 * that were said must survive it.
 */
const MAX_REQUIRED_WORDS = 8;

/**
 * Whether these Utterances carry no speech at all: nothing but empty text and
 * known engine silence artifacts.
 *
 * The check fusion can make, because it needs no duration: output with no real
 * word in it cannot outrank caption words however long the recording was.
 */
export function carriesNoSpeech(utterances: Utterance[]): boolean {
  return meaningfulWords(utterances).size === 0;
}

/**
 * Why this transcription output must not count as audio words, or null to accept
 * it.
 *
 * Two ways to fail, and neither is a bare word count. Output with no real word
 * in it is rejected whatever the recording's length; output whose distinct real
 * words are negligible against a recording long enough for that to mean
 * something is rejected as well, which is what catches an artifact this module
 * has never seen — including the repetition loops engines fall into over long
 * silences.
 */
export function rejectAsSilent(utterances: Utterance[], recordedMs: number): string | null {
  const substance = meaningfulWords(utterances).size;
  if (substance === 0) return NO_SPEECH_REASON;
  if (recordedMs <= LENGTH_JUDGED_FROM_MS) return null;
  const required = Math.min(
    MAX_REQUIRED_WORDS,
    Math.ceil((recordedMs / 60_000) * WORDS_PER_MINUTE),
  );
  return substance < required ? NO_SPEECH_REASON : null;
}

/**
 * The distinct real words in this output: every word of every fragment that is
 * not a known silence artifact.
 *
 * Distinct rather than counted, because engines answer silence with repetition
 * as readily as with a single token — thirty copies of "you" is one word's worth
 * of information, and counting them would let a loop pass for a conversation.
 */
function meaningfulWords(utterances: Utterance[]): Set<string> {
  const found = new Set<string>();
  for (const utterance of utterances) {
    for (const fragment of fragmentsOf(utterance.text)) {
      if (isArtifact(fragment)) continue;
      for (const word of fragment) found.add(word);
    }
  }
  return found;
}

/**
 * The utterance's text as sentence-ish fragments of lowercase words. Split
 * because an engine loops its artifact into one utterance ("Thank you. Thank
 * you. Thanks for watching."), and a fragment at a time is what makes each
 * recognisable.
 */
function fragmentsOf(text: string): string[][] {
  return text
    .split(/[.!?;·\n]+/)
    .map(wordsOf)
    .filter((fragment) => fragment.length > 0);
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word !== "");
}

function isArtifact(fragment: string[]): boolean {
  const phrase = withoutRepetition(fragment).join(" ");
  return (
    SILENCE_ARTIFACTS.has(phrase) || ARTIFACT_OPENINGS.some((start) => phrase.startsWith(start))
  );
}

/**
 * A fragment that is one phrase repeated, reduced to that phrase — "you you you"
 * and "thank you thank you" are the artifact they repeat, not new words. A
 * fragment that is not a clean repetition is returned untouched: guessing at
 * partial repetition would start editing real speech.
 */
function withoutRepetition(fragment: string[]): string[] {
  for (let length = 1; length <= fragment.length / 2; length++) {
    if (fragment.length % length !== 0) continue;
    if (fragment.every((word, i) => word === fragment[i % length])) return fragment.slice(0, length);
  }
  return fragment;
}
