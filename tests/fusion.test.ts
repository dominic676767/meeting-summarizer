// Fusion, the primary v2 seam: Utterances + Speaker Track → Fused Transcript.
// Pure arithmetic on time ranges, so every case here runs with no browser, no
// audio, and no model — which is the point of keeping fusion pure (ADR-0004).
import { describe, expect, it } from "vitest";
import type { Utterance } from "../src/domain/types";
import {
  fuseTranscript,
  speakerTrackFrom,
  UNKNOWN_SPEAKER,
  type SpeakerTrackEntry,
} from "../src/transcription/fusion";
import { seg, transcript } from "./helpers";

const START = Date.UTC(2026, 8, 13, 10, 0, 0);

const meeting = (segments = [] as ReturnType<typeof seg>[]) =>
  transcript({ startedAt: START, endedAt: START + 30 * 60_000, segments });

function u(text: string, startMs: number, endMs: number, diarizationLabel?: string): Utterance {
  return { text, startMs, endMs, ...(diarizationLabel ? { diarizationLabel } : {}) };
}

/** Speaker Track as [speaker, startMs, endMs] triples. */
function track(...turns: [string, number, number][]): SpeakerTrackEntry[] {
  return turns.map(([speaker, startMs, endMs]) => ({ speaker, startMs, endMs }));
}

const speakers = (t: { segments: { speaker: string }[] }) => t.segments.map((s) => s.speaker);

describe("fusion: attributing Utterances to the Speaker Track", () => {
  it("names an Utterance whose range matches a turn exactly", () => {
    const fused = fuseTranscript(
      meeting(),
      [u("We should ship the beta next Friday.", 0, 5_000)],
      track(["Alice", 0, 5_000]),
    );
    expect(speakers(fused)).toEqual(["Alice"]);
    expect(fused.segments[0]?.attribution).toBe("speaker-track");
  });

  it("names an Utterance that only partly overlaps a turn", () => {
    const fused = fuseTranscript(
      meeting(),
      [u("Agreed.", 4_000, 9_000)],
      track(["Alice", 0, 5_000], ["Bob", 5_000, 20_000]),
    );
    // 1s inside Alice's turn against 4s inside Bob's.
    expect(speakers(fused)).toEqual(["Bob"]);
  });

  it("gives a contested span to the speaker with the most overlap", () => {
    const fused = fuseTranscript(
      meeting(),
      [u("crosstalk", 0, 10_000)],
      track(["Alice", 0, 3_000], ["Bob", 3_000, 10_000]),
    );
    expect(speakers(fused)).toEqual(["Bob"]);
  });

  it("sums a speaker's turns, so a run of short caption lines beats one long turn", () => {
    const fused = fuseTranscript(
      meeting(),
      [u("a long answer", 0, 2_000)],
      // Alice holds 1200ms across two lines; Bob holds 800ms in one.
      track(["Alice", 0, 600], ["Alice", 600, 1_200], ["Bob", 1_200, 2_000]),
    );
    expect(speakers(fused)).toEqual(["Alice"]);
  });

  it("resolves an exact tie the same way whatever order the turns arrive in", () => {
    // 600ms of Alice against 600ms of Bob: the earlier holder of the floor wins,
    // and must keep winning when the same turns are listed the other way round.
    const utterance = [u("simultaneous", 400, 1_100)];
    const forward = fuseTranscript(meeting(), utterance, track(["Alice", 0, 1_000], ["Bob", 500, 1_500]));
    const reversed = fuseTranscript(meeting(), utterance, track(["Bob", 500, 1_500], ["Alice", 0, 1_000]));
    expect(speakers(forward)).toEqual(["Alice"]);
    expect(speakers(reversed)).toEqual(["Alice"]);
  });

  it("marks an Utterance no turn overlaps as unknown and still keeps it", () => {
    const fused = fuseTranscript(
      meeting(),
      [u("said before the captions started", 0, 4_000), u("in the captions", 10_000, 12_000)],
      track(["Alice", 9_000, 15_000]),
    );
    expect(speakers(fused)).toEqual([UNKNOWN_SPEAKER, "Alice"]);
    expect(fused.segments[0]?.attribution).toBe("unknown");
    expect(fused.segments[0]?.text).toBe("said before the captions started");
  });

  it("falls back to the engine's own diarization label before Unknown speaker", () => {
    const fused = fuseTranscript(
      meeting(),
      [u("anonymous but labelled", 0, 4_000, "Speaker 1")],
      track(["Alice", 60_000, 70_000]),
    );
    expect(speakers(fused)).toEqual(["Speaker 1"]);
    expect(fused.segments[0]?.attribution).toBe("diarization");
  });

  it("prefers a real name over the engine's diarization label", () => {
    const fused = fuseTranscript(
      meeting(),
      [u("labelled and attributable", 0, 4_000, "Speaker 1")],
      track(["Alice", 0, 4_000]),
    );
    expect(speakers(fused)).toEqual(["Alice"]);
  });

  it("preserves Utterance order and content, inventing and merging nothing", () => {
    const utterances = [
      u("third thing", 8_000, 9_000),
      u("first thing", 1_000, 2_000),
      u("first thing", 2_000, 3_000),
    ];
    const fused = fuseTranscript(meeting(), utterances, track(["Alice", 0, 10_000]));
    expect(fused.segments.map((s) => s.text)).toEqual([
      "third thing",
      "first thing",
      "first thing",
    ]);
  });

  it("keeps the Meeting's own metadata", () => {
    const base = meeting([seg("Alice", "caption words", START)]);
    const fused = fuseTranscript(base, [u("audio words", 0, 1_000)], track(["Alice", 0, 1_000]));
    expect(fused.platform).toBe(base.platform);
    expect(fused.title).toBe(base.title);
    expect(fused.startedAt).toBe(base.startedAt);
    expect(fused.endedAt).toBe(base.endedAt);
    // Caption words are replaced wholesale — that is what recording is for.
    expect(fused.segments.map((s) => s.text)).toEqual(["audio words"]);
  });

  it("carries each segment's absolute time range for the reader to verify against", () => {
    const fused = fuseTranscript(
      meeting(),
      [u("timed", 63_500, 66_250)],
      track(["Bob", 60_000, 70_000]),
    );
    expect(fused.segments[0]).toEqual({
      speaker: "Bob",
      text: "timed",
      startMs: 63_500,
      endMs: 66_250,
      capturedAt: START + 63_500,
      attribution: "speaker-track",
    });
  });

  it("attributes an Utterance from a later chunk by its absolute timing", () => {
    // The same words, one chunk apart. An uncorrected chunk offset would rewind
    // 62s to 2s and hand every word after the first boundary to Alice.
    const turns = track(["Alice", 0, 60_000], ["Bob", 60_000, 120_000]);
    const early = fuseTranscript(meeting(), [u("who said this", 2_000, 3_000)], turns);
    const late = fuseTranscript(meeting(), [u("who said this", 62_000, 63_000)], turns);
    expect(speakers(early)).toEqual(["Alice"]);
    expect(speakers(late)).toEqual(["Bob"]);
  });

  it("attributes a zero-length Utterance sitting inside a turn", () => {
    const fused = fuseTranscript(meeting(), [u("hm", 3_000, 3_000)], track(["Alice", 0, 5_000]));
    expect(speakers(fused)).toEqual(["Alice"]);
  });

  it("keeps every audio word when there is no Speaker Track at all", () => {
    // Captions were never on: the Meeting costs speaker names, not its words.
    const fused = fuseTranscript(meeting(), [u("one", 0, 1_000), u("two", 1_000, 2_000)], []);
    expect(fused.segments.map((s) => s.text)).toEqual(["one", "two"]);
    expect(speakers(fused)).toEqual([UNKNOWN_SPEAKER, UNKNOWN_SPEAKER]);
  });

  it("keeps the caption words when no Utterances arrived", () => {
    // Nothing to fuse must not mean nothing left: fusion replaces the caption
    // words wholesale, so an empty replacement would erase the Meeting.
    const base = meeting([seg("Alice", "caption words", START)]);
    expect(fuseTranscript(base, []).segments).toEqual(base.segments);
  });
});

describe("fusion: recording provenance on the Transcript", () => {
  it("records a fused Transcript when the Speaker Track named an Utterance", () => {
    const fused = fuseTranscript(
      meeting([seg("Alice", "caption words", START)]),
      [u("audio words", 0, 2_000)],
      track(["Alice", 0, 2_000]),
    );
    expect(fused.provenance).toBe("fused");
  });

  it("still records a fused Transcript when only some Utterances found a name", () => {
    const fused = fuseTranscript(
      meeting(),
      [u("before the captions", 0, 2_000), u("in the captions", 10_000, 12_000)],
      track(["Alice", 9_000, 15_000]),
    );
    expect(speakers(fused)).toEqual([UNKNOWN_SPEAKER, "Alice"]);
    expect(fused.provenance).toBe("fused");
  });

  it("records audio without attribution when captions were off", () => {
    // The words are trustworthy and the owners are not, which is a different
    // claim from either of the other two levels.
    const fused = fuseTranscript(meeting(), [u("audio words", 0, 2_000)], []);
    expect(fused.provenance).toBe("audio-unattributed");
  });

  it("records audio without attribution when a Speaker Track overlapped nothing", () => {
    // A track that names no Utterance is worth exactly as much as no track, and
    // the Transcript must not claim otherwise.
    const fused = fuseTranscript(
      meeting(),
      [u("audio words", 0, 2_000, "Speaker 1")],
      track(["Alice", 60_000, 70_000]),
    );
    expect(speakers(fused)).toEqual(["Speaker 1"]);
    expect(fused.provenance).toBe("audio-unattributed");
  });

  it("leaves the caption-only provenance alone when no Utterances arrived", () => {
    // Transcription failed or the user skipped the wait: the Meeting falls back
    // to caption words, and fusion must not upgrade that claim.
    const base = { ...meeting([seg("Alice", "caption words", START)]), provenance: "captions-only" as const };
    expect(fuseTranscript(base, []).provenance).toBe("captions-only");
  });
});

// --- A hallucination must never outrank real captions ------------------------
//
// The real failure this guards: two Summary Artifacts were built from silent
// recordings whose whole Transcript was Whisper's canonical silence artifact, the
// single word "you". Fusion replaces the caption words wholesale, so had those
// meetings' captions carried the conversation, one invented word would have
// stood where the conversation had been — and the artifact would have claimed it
// came from recorded audio.

describe("fusion: transcription output that carries no speech", () => {
  /** The Meeting as it actually happened, in the caption words. */
  const conversation = () =>
    meeting([
      seg("Alice", "we should ship the beta next friday", START + 1_000),
      seg("Bob", "agreed i will own the release checklist", START + 12_000),
      seg("Alice", "open question do we support firefox esr", START + 25_000),
    ]);

  it("keeps every caption segment when the only Utterance is the silence artifact", () => {
    const base = conversation();
    const fused = fuseTranscript(base, [u("you", 0, 27_000)]);
    expect(fused.segments).toEqual(base.segments);
    expect(fused.segments.map((s) => s.text)).toEqual([
      "we should ship the beta next friday",
      "agreed i will own the release checklist",
      "open question do we support firefox esr",
    ]);
  });

  it("leaves the provenance caption-only rather than claiming recorded audio", () => {
    const fused = fuseTranscript(conversation(), [u("you", 0, 27_000)]);
    expect(fused.provenance).toBe("captions-only");
    expect(fused.provenance).not.toBe("fused");
    expect(fused.provenance).not.toBe("audio-unattributed");
  });

  it("keeps the captions when the engine looped its artifact instead of repeating it once", () => {
    const base = conversation();
    const fused = fuseTranscript(base, [
      u("Thank you.", 0, 9_000),
      u("Thank you. Thank you. Thanks for watching.", 9_000, 27_000),
      u("you you you you", 27_000, 41_000),
    ]);
    expect(fused.segments).toEqual(base.segments);
    expect(fused.provenance).toBe("captions-only");
  });

  it("still fuses a genuinely short exchange, artifact-shaped courtesies and all", () => {
    // A real 20-second exchange is a handful of words, and it must not be
    // mistaken for silence: these words are the accurate ones.
    const fused = fuseTranscript(
      meeting([seg("Alice", "thanks bob", START + 1_000)]),
      [u("Thanks, Bob — let's ship the beta on Friday.", 1_000, 8_000)],
      track(["Alice", 0, 10_000]),
    );
    expect(fused.segments.map((s) => s.text)).toEqual([
      "Thanks, Bob — let's ship the beta on Friday.",
    ]);
    expect(fused.provenance).toBe("fused");
  });
});

describe("fusion: the Speaker Track derived from Caption Segments", () => {
  it("runs each caption line's turn from its own capture up to the next line", () => {
    const derived = speakerTrackFrom(
      meeting([
        seg("Alice", "first", START + 2_000),
        seg("Bob", "second", START + 9_000),
        seg("Alice", "third", START + 12_000),
      ]),
    );
    expect(derived.slice(0, 2)).toEqual([
      { speaker: "Alice", startMs: 2_000, endMs: 9_000 },
      { speaker: "Bob", startMs: 9_000, endMs: 12_000 },
    ]);
  });

  it("gives lines scraped in the same tick a turn that reaches the next later line", () => {
    // A batch of captions shares one timestamp; a turn ending at its immediate
    // neighbour would be zero-length and could name nobody.
    const derived = speakerTrackFrom(
      meeting([
        seg("Alice", "fast", START + 4_000),
        seg("Bob", "talker", START + 4_000),
        seg("Carol", "later", START + 10_000),
      ]),
    );
    expect(derived.slice(0, 2)).toEqual([
      { speaker: "Alice", startMs: 4_000, endMs: 10_000 },
      { speaker: "Bob", startMs: 4_000, endMs: 10_000 },
    ]);
    // Contested identically, so the tie resolves to the first line, not to luck.
    const fused = fuseTranscript(meeting(), [u("fast talker", 5_000, 6_000)], derived);
    expect(speakers(fused)).toEqual(["Alice"]);
  });

  it("treats a caption captured before the Meeting start as being at its start", () => {
    const derived = speakerTrackFrom(meeting([seg("Alice", "early", START - 5_000)]));
    expect(derived[0]?.startMs).toBe(0);
  });

  it("does not stretch the last caption line over the rest of the Meeting", () => {
    // Captions stopped at 4s; who spoke at 20 minutes is genuinely unknown, and
    // Unknown speaker is honest where Alice's name would be invented.
    const base = meeting([seg("Alice", "last thing captioned", START + 4_000)]);
    const fused = fuseTranscript(base, [u("much later", 20 * 60_000, 20 * 60_000 + 2_000)]);
    expect(speakers(fused)).toEqual([UNKNOWN_SPEAKER]);
  });

  it("fuses against the Meeting's own captions by default", () => {
    const base = meeting([
      seg("Alice", "we shud chip the beater next friday", START + 1_000),
      seg("Bob", "agreed ill own the release check list", START + 6_000),
    ]);
    const fused = fuseTranscript(base, [
      u("We should ship the beta next Friday.", 1_500, 5_000),
      u("Agreed. I will own the release checklist.", 6_500, 9_000),
    ]);
    expect(speakers(fused)).toEqual(["Alice", "Bob"]);
    expect(fused.segments.map((s) => s.text)).toEqual([
      "We should ship the beta next Friday.",
      "Agreed. I will own the release checklist.",
    ]);
  });
});
