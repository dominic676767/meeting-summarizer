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
  details { margin-top: 2rem; border-top: 1px solid #ddd; padding-top: 1rem; }
  summary { cursor: pointer; font-weight: 600; }
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
 * Renders the Summary Artifact: self-contained HTML with the Summary followed
 * by the full Transcript in a collapsible section. Inline CSS, no external assets.
 */
export function renderArtifact(summaryMarkdown: string, transcript: Transcript): string {
  const date = new Date(transcript.endedAt ?? transcript.startedAt);
  // An unstated provenance is indistinguishable from the best case, so a
  // Transcript that carries no claim is read as the weakest one.
  const provenance = PROVENANCE[transcript.provenance ?? "captions-only"];
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
<p class="meta">${date.toISOString().slice(0, 10)} · ${escapeHtml(transcript.platform)} · ${transcript.segments.length} segments · ${provenance.clause}</p>
${transcript.provenance === "audio-unattributed" ? noteUnverifiedOwners(summary) : summary}
<details>
<summary>${provenance.sectionLabel}</summary>
${segments}
</details>
</body>
</html>
`;
}
