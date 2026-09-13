import type { Settings } from "../domain/types";
import { createAnthropicClient } from "./anthropic";
import { createBedrockClient } from "./bedrock";
import { createOllamaClient } from "./ollama";
import { createOpenAiClient } from "./openai";
import type { FetchFn, ProviderClient } from "./provider";
import { ProviderError } from "./provider";

function requireKey(provider: string, key: string): void {
  if (!key) throw new ProviderError(provider, "no API key configured — open Settings");
}

/** Builds the ProviderClient for the user's selected Provider. */
export function createProviderClient(settings: Settings, fetchFn?: FetchFn): ProviderClient {
  switch (settings.provider) {
    case "anthropic":
      requireKey("anthropic", settings.anthropic.apiKey);
      return createAnthropicClient({ ...settings.anthropic, fetchFn });
    case "openai":
      requireKey("openai", settings.openai.apiKey);
      return createOpenAiClient({ ...settings.openai, fetchFn });
    case "ollama":
      return createOllamaClient({ ...settings.ollama, fetchFn });
    case "bedrock":
      requireKey("bedrock", settings.bedrock.apiKey);
      return createBedrockClient({ ...settings.bedrock, fetchFn });
  }
}
