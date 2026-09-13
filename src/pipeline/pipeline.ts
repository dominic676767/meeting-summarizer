import type { PromptTemplates, SummaryShape, Transcript } from "../domain/types";
import type { ProviderClient } from "../providers/provider";
import { renderArtifact } from "./artifact";
import { CHUNK_PROMPT_PREFIX, chunkSegments, REDUCE_NOTE } from "./chunking";
import { serializeTranscript } from "./serialize";
import { renderTemplate } from "./templates";

export interface PipelineSettings {
  shape: SummaryShape;
  templates: PromptTemplates;
}

/** Any pipeline failure surfaces as PipelineError → the Held Transcript path. */
export class PipelineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PipelineError";
  }
}

/**
 * The summarization pipeline (primary test seam): completed Transcript +
 * settings + injected Provider client → Summary Artifact HTML. Pure logic —
 * no browser APIs.
 */
export async function summarizeTranscript(
  transcript: Transcript,
  settings: PipelineSettings,
  client: ProviderClient,
): Promise<{ html: string }> {
  if (transcript.segments.length === 0) {
    throw new PipelineError("Transcript has no caption segments");
  }
  const serialized = serializeTranscript(transcript);
  const singleShot = renderTemplate(settings.templates, settings.shape, serialized);

  const summary =
    singleShot.length <= client.contextBudget
      ? await complete(client, singleShot)
      : await mapReduce(transcript, settings, client);

  return { html: renderArtifact(summary, transcript) };
}

async function complete(client: ProviderClient, prompt: string): Promise<string> {
  try {
    return await client.complete(prompt);
  } catch (cause) {
    throw new PipelineError(
      `Provider ${client.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Map-reduce for over-budget Transcripts: chunk → per-chunk summaries →
 * final summary through the user's selected template. No truncation, no
 * lost content; a failing chunk call propagates as PipelineError
 * (the Held Transcript path).
 */
async function mapReduce(
  transcript: Transcript,
  settings: PipelineSettings,
  client: ProviderClient,
): Promise<string> {
  const chunkBudget = Math.max(client.contextBudget - CHUNK_PROMPT_PREFIX.length, 1);
  const chunks = chunkSegments(transcript.segments, chunkBudget);
  const chunkSummaries: string[] = [];
  for (const chunk of chunks) {
    const serialized = serializeTranscript({ ...transcript, segments: chunk });
    chunkSummaries.push(await complete(client, CHUNK_PROMPT_PREFIX + serialized));
  }
  const reduced = REDUCE_NOTE + chunkSummaries.map((s, i) => `Portion ${i + 1}:\n${s}`).join("\n\n");
  return complete(client, renderTemplate(settings.templates, settings.shape, reduced));
}
