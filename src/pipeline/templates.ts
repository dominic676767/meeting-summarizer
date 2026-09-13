import type { PromptTemplates, SummaryShape } from "../domain/types";

/** Placeholder replaced with the serialized Transcript. */
export const TRANSCRIPT_PLACEHOLDER = "{{transcript}}";

// Defaults instruct the model to respond in the Transcript's language.
// Users who want forced-English edit one line (see ADR context in spec).
export const DEFAULT_TEMPLATES: PromptTemplates = {
  structured: `You are a meeting summarizer. Read the meeting transcript below and produce a summary.

Write the summary in the same language as the transcript is spoken in. If the transcript's language is ambiguous or mixed, write the summary in English.

Format the summary in Markdown with exactly these sections:

## TL;DR
A few sentences capturing the essence of the meeting.

## Decisions
Bullet list of decisions that were made. If none, write "None."

## Action items
Bullet list of action items. For each, name the owner and the due date if one was mentioned. If none, write "None."

## Open questions
Bullet list of questions raised but not resolved. If none, write "None."

Transcript:

${TRANSCRIPT_PLACEHOLDER}`,
  narrative: `You are a meeting summarizer. Read the meeting transcript below and write a narrative recap of the meeting — a few flowing paragraphs covering what was discussed, what was decided, and what happens next. No headings or bullet lists.

Write the recap in the same language as the transcript is spoken in. If the transcript's language is ambiguous or mixed, write the recap in English.

Transcript:

${TRANSCRIPT_PLACEHOLDER}`,
};

export function renderTemplate(
  templates: PromptTemplates,
  shape: SummaryShape,
  serializedTranscript: string,
): string {
  const template = templates[shape];
  if (template.includes(TRANSCRIPT_PLACEHOLDER)) {
    return template.replaceAll(TRANSCRIPT_PLACEHOLDER, serializedTranscript);
  }
  // A user template without the placeholder still gets the transcript.
  return `${template}\n\nTranscript:\n\n${serializedTranscript}`;
}
