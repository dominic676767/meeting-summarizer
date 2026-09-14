// Capture Span identity and ordering: which file each Capture Start writes, and
// which files a Meeting's audio consists of.
//
// Pure arithmetic on ids and offsets, deliberately separate from the session
// store, because the property that matters is a naming property: two Capture
// Starts in one Meeting must never name the same file. That is exactly what went
// wrong before (ADR-0005) — one id per Meeting meant the second Capture Start
// truncated the first span's audio and rewrote it from byte zero, silently.
import type { CaptureSpan } from "../domain/types";

/**
 * The span a Capture Start begins, keyed by the Meeting's recording id and this
 * span's distance from the Meeting start.
 *
 * The offset is in the key on purpose: it makes the id unique per Capture Start
 * (the same millisecond cannot be started twice) and sorts the Meeting's files in
 * the order they were recorded, so a stray span is findable rather than
 * anonymous. It is never negative — a Capture Start cannot precede the Meeting we
 * noticed it in, and a clock that says otherwise must not push words backwards.
 */
export function beginSpan(
  recordingId: string,
  meetingStartedAt: number,
  startedAt: number,
): CaptureSpan {
  const startOffsetMs = Math.max(0, startedAt - meetingStartedAt);
  return { spanId: `${recordingId}.${startOffsetMs}`, startOffsetMs };
}

/**
 * The Meeting's spans in Capture Start order — the order transcription must
 * process them in, since their Utterances are concatenated as they come.
 */
export function orderedSpans(spans: CaptureSpan[]): CaptureSpan[] {
  return [...spans].sort((a, b) => a.startOffsetMs - b.startOffsetMs);
}

/** Every audio file this Meeting owns: what a Held Recording covers, and what
 * cleanup deletes once the Summary Artifact is written. */
export function spanIdsOf(spans: CaptureSpan[]): string[] {
  return orderedSpans(spans).map((s) => s.spanId);
}
