import type { Transcript, TranscriptProvenance, TranscriptSegment } from "../domain/types";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Minimal Markdown → HTML for LLM summary output (headings, lists, bold). */
export function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = escapeHtml(raw).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(Math.max(heading[1]!.length, 2), 5); // h2..h5; h1 is the title
      out.push(`<h${level}>${heading[2]}</h${level}>`);
    } else if (bullet) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${bullet[1]}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${line}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

const STYLE = `
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.15rem; margin-top: 1.5rem; }
  .meta { color: #666; font-size: 0.85rem; }
  .capture-warning { color: #9b2c1d; overflow-wrap: anywhere; }
  details { margin-top: 2rem; border-top: 1px solid #ddd; padding-top: 1rem; }
  summary { cursor: pointer; font-weight: 600; }
  /* Titles and transcript lines can carry an unbroken URL; prose still wraps
     normally, but a long token breaks rather than widening the document. */
  h1, .seg, .meta { overflow-wrap: anywhere; }
  .seg { margin: 0.35rem 0; }
  .speaker { font-weight: 600; }
  .at { color: #666; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  .unverified { color: #666; font-weight: 400; font-size: 0.85rem; }
`;

/**
 * What the reader is told the document is made of. A reader who cannot tell
 * these apart will over-trust two of them, so the clause is never omitted and
 * the collapsible section is labelled for what it actually contains: calling
 * scraped captions a "transcript" is the same overclaim in miniature.
 */
const PROVENANCE: Record<TranscriptProvenance, { clause: string; sectionLabel: string }> = {
  fused: {
    clause: "from recorded audio, speakers from captions",
    sectionLabel: "Full transcript",
  },
  "audio-unattributed": {
    clause: "from recorded audio · speakers not identified",
    sectionLabel: "Full transcript",
  },
  "captions-only": {
    clause: "from live captions only — no audio was recorded",
    sectionLabel: "Full captions",
  },
};

/**
 * Where an audio-derived artifact does not contain the local user's own voice.
 *
 * "from recorded audio" reads as "the meeting was recorded", and until ADR-0007 it
 * silently meant "the other participants were recorded": the meeting tab carries
 * only what comes out of it, so a user recording tab audio alone is absent from
 * their own summary. A reader wondering why one voice never appears deserves the
 * reason rather than a document that omits it.
 *
 * Set in the third person, not the second: the artifact gets forwarded, and its
 * later readers are not the person whose microphone it is.
 */
const NO_LOCAL_MIC_CLAUSE = "local microphone not recorded";

/**
 * Replaces the captions-only clause where a recording existed and simply had
 * nothing in it.
 *
 * "no audio was recorded" is false for a silent Meeting — audio was recorded,
 * the engine ran, and it heard nothing — and it sends the reader looking for a
 * broken transcription engine that worked perfectly. The distinction matters
 * because the two have opposite remedies: one is "start capture next time", the
 * other is "check your microphone and the meeting's output device".
 */
const NO_SPEECH_CLAUSE = "from live captions only — the recording contained no speech";
const CAPTURE_FAILED_CLAUSE = "from live captions only — audio capture failed";

/**
 * The Meta line is not enough where owners are anonymous: action items are what
 * get acted on, so the caveat is repeated where a wrong owner does its damage.
 */
function noteUnverifiedOwners(html: string): string {
  return html.replace(
    /<(h[2-5])>([^<]*action items[^<]*)<\/\1>/gi,
    '<$1>$2 <span class="unverified">(speaker labels are unverified)</span></$1>',
  );
}

/**
 * A segment's offset from the Meeting start as mm:ss (h:mm:ss past the hour) —
 * the reader's way of locating a claim in the meeting. Audio-derived segments
 * carry their own absolute range; caption-derived ones only know when the line
 * appeared.
 */
function segmentTime(segment: TranscriptSegment, meetingStartedAt: number): string {
  return formatOffset(segment.startMs ?? segment.capturedAt - meetingStartedAt);
}

function formatOffset(ms: number): string {
  // Floored, as a clock reads: 5.5s into the meeting is 00:05, not 00:06.
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours === 0) return `${String(minutes).padStart(2, "0")}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

/**
 * The Meta line: what this document is, in the order a reader needs it — when,
 * where, how long, how much, and what it was made of. Duration is included
 * because a 12-minute standup and a two-hour review deserve different scrutiny,
 * and a duration far shorter than the meeting is the visible trace of a capture
 * that started late.
 *
 * The engine is named only when the reader opted in: it aids reproducibility but
 * discloses their tooling to everyone the file reaches.
 */
function metaLine(
  transcript: Transcript,
  provenance: TranscriptProvenance,
  provenanceClause: string,
  nameEngine: boolean,
): string {
  const parts = [
    new Date(transcript.endedAt ?? transcript.startedAt).toISOString().slice(0, 10),
    escapeHtml(transcript.platform),
  ];
  // Absent endedAt means we never saw the Meeting close, so no duration is
  // claimed rather than one invented from the render time.
  if (transcript.endedAt !== undefined) {
    parts.push(formatOffset(transcript.endedAt - transcript.startedAt));
  }
  // No segment count: a Caption Segment is this project's vocabulary, not the
  // reader's, and the artifact is the one thing forwarded to people who never
  // used the extension. Duration answers what the count stood in for, in a unit
  // everyone reads, and the transcript itself is one click away.
  if (transcript.captureError) {
    parts.push(provenance === "captions-only"
      ? CAPTURE_FAILED_CLAUSE
      : `${provenanceClause} · audio capture failed`);
  } else {
    parts.push(transcript.noSpeech === true ? NO_SPEECH_CLAUSE : provenanceClause);
  }
  // Only where audio was actually recorded: on a caption-only artifact the
  // microphone is beside the point, and naming it would read as a second fault
  // where there is one plain fact already stated.
  if (provenance !== "captions-only" && transcript.localMicrophone !== true) {
    parts.push(NO_LOCAL_MIC_CLAUSE);
  }
  if (nameEngine && transcript.engine) {
    parts.push(`${escapeHtml(transcript.engine.id)} ${escapeHtml(transcript.engine.model)}`);
  }
  return parts.join(" · ");
}

/**
 * Renders the Summary Artifact: self-contained HTML with the Summary followed
 * by the full Transcript in a collapsible section. Inline CSS, no external assets.
 */
export function renderArtifact(
  summaryMarkdown: string,
  transcript: Transcript,
  opts: { nameEngine?: boolean } = {},
): string {
  const date = new Date(transcript.endedAt ?? transcript.startedAt);
  // An unstated provenance is indistinguishable from the best case, so a
  // Transcript that carries no claim is read as the weakest one.
  const provenanceKey = transcript.provenance ?? "captions-only";
  const provenance = PROVENANCE[provenanceKey];
  const summary = markdownToHtml(summaryMarkdown);
  const segments = transcript.segments
    .map(
      (s) =>
        `<p class="seg"><span class="at">${segmentTime(s, transcript.startedAt)}</span> <span class="speaker">${escapeHtml(s.speaker)}:</span> ${escapeHtml(s.text)}</p>`,
    )
    .join("\n");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(transcript.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(transcript.title)}</h1>
<p class="meta">${metaLine(transcript, provenanceKey, provenance.clause, opts.nameEngine === true)}</p>
${transcript.captureError ? `<p class="capture-warning">Audio capture failed: ${escapeHtml(transcript.captureError)} The transcript can be incomplete.</p>` : ""}
${transcript.provenance === "audio-unattributed" ? noteUnverifiedOwners(summary) : summary}
<details>
<summary>${provenance.sectionLabel}</summary>
${segments}
</details>
</body>
</html>
`;
}
