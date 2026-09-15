// Fusion: Utterances + Speaker Track → the Transcript the pipeline consumes.
//
// The primary v2 test seam (ADR-0004). Accurate words come from the Audio
// Recording, real names from the scraped Caption Segments, and the two are
// joined by nothing but arithmetic on time ranges — no browser API, no audio,
// no model — so attribution correctness is testable directly.
//
// Two rules govern everything here: a name is never invented, and content is
// never invented, merged away, or reordered. An Utterance no name can be
// attached to becomes an Unknown speaker segment, because accurate words are
// worth more than a missing owner.
import type {
  SpeakerAttribution,
  Transcript,
  TranscriptProvenance,
  TranscriptSegment,
  Utterance,
} from "../domain/types";
import { carriesNoSpeech } from "./silence";

/** Marker for speech no name can be attached to. Never a guess. */
export const UNKNOWN_SPEAKER = "Unknown speaker";

/**
 * How long the last Caption Segment is assumed to hold the floor. Kept short
 * deliberately: when captions stop (turned off, panel broke) we genuinely do
 * not know who spoke afterwards, and Unknown speaker is honest where extending
 * the last name over the rest of the Meeting would be a fabrication.
 */
const TRAILING_HOLD_MS = 15_000;

/** One turn in the Speaker Track: who held the floor, over which ms range from
 * the Meeting start. */
export interface SpeakerTrackEntry {
  speaker: string;
  startMs: number;
  endMs: number;
}

/**
 * Derives the Speaker Track from a Meeting's Caption Segments — who spoke when,
 * the one thing captions are still kept for.
 *
 * A caption line's `capturedAt` is when it *first appeared*, and live ASR emits
 * a line as its speaker begins, so a line's turn runs forward from its own
 * timestamp to the next line's. Lines scraped in the same tick share a
 * timestamp, so the turn extends to the next *later* one; the immediate
 * neighbour would give a zero-length window that overlaps nothing.
 */
export function speakerTrackFrom(transcript: Transcript): SpeakerTrackEntry[] {
  const starts = transcript.segments.map((s) => Math.max(0, s.capturedAt - transcript.startedAt));
  return transcript.segments.map((segment, i) => {
    const startMs = starts[i]!;
    let endMs = startMs + TRAILING_HOLD_MS;
    for (let j = i + 1; j < starts.length; j++) {
      if (starts[j]! > startMs) {
        endMs = starts[j]!;
        break;
      }
    }
    return { speaker: segment.speaker, startMs, endMs };
  });
}

/**
 * Fuses transcribed Utterances with a Speaker Track into a Fused Transcript,
 * keeping the Meeting's own metadata. One Utterance is one segment, in the order
 * the Transcription Provider produced it; only the speaker name is decided here.
 *
 * The Speaker Track defaults to the one carried by `base`'s caption segments,
 * which is what the Meeting End sequence wants; tests supply it explicitly.
 */
export function fuseTranscript(
  base: Transcript,
  utterances: Utterance[],
  track: SpeakerTrackEntry[] = speakerTrackFrom(base),
): Transcript {
  // Fusion replaces the caption words wholesale, so output with no speech in it
  // must never reach this: one hallucinated "you" would stand where a whole
  // conversation had been. Nothing to fuse leaves the caption Transcript exactly
  // as it arrived — every segment, and a provenance that never claims audio.
  if (carriesNoSpeech(utterances)) {
    return { ...base, provenance: base.provenance ?? "captions-only" };
  }
  const segments = utterances.map((u) => toSegment(u, base.startedAt, attribute(u, track)));
  return { ...base, provenance: provenanceOf(segments), segments };
}

/**
 * Records on the Transcript how much to trust it. Fusion is the only place that
 * knows whether a Speaker Track name actually reached an Utterance — a track
 * that overlapped nothing is worth exactly as much as no track at all — so the
 * answer is stored here rather than guessed from the segments later.
 */
function provenanceOf(segments: TranscriptSegment[]): TranscriptProvenance {
  // Reached only with real audio words in hand: output carrying no speech left
  // above with the caption Transcript's own provenance untouched.
  return segments.some((s) => s.attribution === "speaker-track") ? "fused" : "audio-unattributed";
}

function toSegment(u: Utterance, meetingStartedAt: number, named: string | null): TranscriptSegment {
  const speaker = named ?? u.diarizationLabel ?? UNKNOWN_SPEAKER;
  const attribution: SpeakerAttribution = named
    ? "speaker-track"
    : u.diarizationLabel
      ? "diarization"
      : "unknown";
  return {
    speaker,
    text: u.text,
    capturedAt: meetingStartedAt + u.startMs,
    startMs: u.startMs,
    endMs: u.endMs,
    attribution,
  };
}

interface Candidate {
  overlapMs: number;
  firstStartMs: number;
  order: number;
}

/**
 * The speaker whose Speaker Track turns overlap this Utterance most, or null
 * where none does. Overlap is summed per speaker so a run of caption lines from
 * one person is not beaten by a single longer turn from another.
 */
function attribute(u: Utterance, track: SpeakerTrackEntry[]): string | null {
  const bySpeaker = new Map<string, Candidate>();
  track.forEach((entry, order) => {
    const overlapMs = overlap(u, entry);
    if (overlapMs <= 0) return;
    const held = bySpeaker.get(entry.speaker);
    if (held) held.overlapMs += overlapMs;
    else bySpeaker.set(entry.speaker, { overlapMs, firstStartMs: entry.startMs, order });
  });

  let best: { speaker: string; candidate: Candidate } | null = null;
  for (const [speaker, candidate] of bySpeaker) {
    if (!best || beats(candidate, best.candidate)) best = { speaker, candidate };
  }
  return best?.speaker ?? null;
}

/** Contested spans resolve deterministically: most overlap wins, an exact tie
 * goes to whoever held the floor first, and identical turns to Speaker Track
 * order — never to whichever candidate happened to be seen first. */
function beats(a: Candidate, b: Candidate): boolean {
  if (a.overlapMs !== b.overlapMs) return a.overlapMs > b.overlapMs;
  if (a.firstStartMs !== b.firstStartMs) return a.firstStartMs < b.firstStartMs;
  return a.order < b.order;
}

function overlap(u: Utterance, entry: SpeakerTrackEntry): number {
  // An engine can report a span of zero length. That is an instant rather than
  // a range, and an instant inside a turn still belongs to its speaker.
  if (u.startMs === u.endMs) {
    return u.startMs >= entry.startMs && u.startMs <= entry.endMs ? 1 : 0;
  }
  return Math.min(u.endMs, entry.endMs) - Math.max(u.startMs, entry.startMs);
}
