import type { PromptTemplates, SummaryShape, Transcript } from "../domain/types";
import type { ProviderClient } from "../providers/provider";
import { renderArtifact } from "./artifact";
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
  const prompt = renderTemplate(settings.templates, settings.shape, serialized);
  let summary: string;
  try {
    summary = await client.complete(prompt);
  } catch (cause) {
    throw new PipelineError(
      `Provider ${client.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  return { html: renderArtifact(summary, transcript) };
}
