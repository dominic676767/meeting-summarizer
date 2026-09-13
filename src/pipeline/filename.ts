import type { Transcript } from "../domain/types";

const MAX_TITLE_LENGTH = 80;

export function sanitizeTitle(title: string, fallback: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim()
    .replace(/\s/g, "-");
  return cleaned || fallback;
}

/**
 * Derives the Summary Artifact filename: YYYY-MM-DD-<meeting-title>.html.
 * `existing` handles same-day collisions with a numeric suffix; at runtime the
 * downloads API's uniquify conflict action is the belt-and-braces equivalent.
 */
export function artifactFilename(transcript: Transcript, existing?: ReadonlySet<string>): string {
  const date = new Date(transcript.endedAt ?? transcript.startedAt).toISOString().slice(0, 10);
  const title = sanitizeTitle(transcript.title, transcript.platform);
  const base = `${date}-${title}`;
  let candidate = `${base}.html`;
  let n = 2;
  while (existing?.has(candidate)) {
    candidate = `${base}-${n}.html`;
    n++;
  }
  return candidate;
}
