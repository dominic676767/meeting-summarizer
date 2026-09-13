import type { CaptionSegment } from "../domain/types";

/**
 * Splits a Transcript's segments into chunks whose serialized form each fits
 * within `chunkBudget` characters. A single over-budget segment is hard-split
 * so no content is ever dropped.
 */
export function chunkSegments(segments: CaptionSegment[], chunkBudget: number): CaptionSegment[][] {
  const chunks: CaptionSegment[][] = [];
  let current: CaptionSegment[] = [];
  let currentLen = 0;

  const push = (seg: CaptionSegment) => {
    const len = seg.speaker.length + seg.text.length + 3; // "speaker: text\n"
    if (currentLen + len > chunkBudget && current.length > 0) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(seg);
    currentLen += len;
  };

  for (const seg of segments) {
    const maxText = Math.max(chunkBudget - seg.speaker.length - 3, 1);
    if (seg.text.length > maxText) {
      for (let i = 0; i < seg.text.length; i += maxText) {
        push({ ...seg, text: seg.text.slice(i, i + maxText) });
      }
    } else {
      push(seg);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export const CHUNK_PROMPT_PREFIX = `You are summarizing one portion of a longer meeting transcript. Write a detailed summary of this portion, preserving every decision, every action item (with owner and due date if mentioned), and every open question. Respond in the same language as the transcript.

Transcript portion:

`;

export const REDUCE_NOTE = `The following are in-order summaries of consecutive portions of one meeting. Treat them together as the meeting transcript.

`;
