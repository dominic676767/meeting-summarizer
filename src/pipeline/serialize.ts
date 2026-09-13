import type { Transcript } from "../domain/types";

/** Serializes a Transcript into the plain-text form embedded in prompts. */
export function serializeTranscript(t: Transcript): string {
  return t.segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");
}
