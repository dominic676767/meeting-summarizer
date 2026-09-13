// Domain vocabulary — see CONTEXT.md. Use these terms exactly.

/** One unit of live-caption text scraped from the meeting client's DOM. */
export interface CaptionSegment {
  speaker: string;
  text: string;
  /** epoch ms at capture time */
  capturedAt: number;
}

/** The ordered accumulation of Caption Segments for one Meeting. */
export interface Transcript {
  platform: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  segments: CaptionSegment[];
}

export type SummaryShape = "structured" | "narrative";

/** User-editable text sent to the Provider. One template per summary shape. */
export interface PromptTemplates {
  structured: string;
  narrative: string;
}

export type ProviderId = "anthropic" | "openai" | "ollama" | "bedrock";

/** Settings persisted in browser.storage.local. */
export interface Settings {
  provider: ProviderId;
  shape: SummaryShape;
  templates: PromptTemplates;
  anthropic: { apiKey: string; model: string };
  openai: { apiKey: string; model: string };
  ollama: { baseUrl: string; model: string };
  bedrock: { apiKey: string; region: string; model: string };
}

/** A Transcript whose summarization failed, retained for retry. */
export interface HeldTranscript {
  id: string;
  transcript: Transcript;
  reason: string;
  failedAt: number;
}
