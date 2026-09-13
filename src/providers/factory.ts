import type { Settings } from "../domain/types";
import { createAnthropicClient } from "./anthropic";
import type { FetchFn, ProviderClient } from "./provider";
import { ProviderError } from "./provider";

/** Builds the ProviderClient for the user's selected Provider. */
export function createProviderClient(settings: Settings, fetchFn?: FetchFn): ProviderClient {
  switch (settings.provider) {
    case "anthropic": {
      if (!settings.anthropic.apiKey)
        throw new ProviderError("anthropic", "no API key configured — open Settings");
      return createAnthropicClient({ ...settings.anthropic, fetchFn });
    }
    default:
      throw new ProviderError(settings.provider, "provider not yet supported");
  }
}
