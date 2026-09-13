import { expectOk, type FetchFn, type ProviderClient } from "./provider";

export function createAnthropicClient(opts: {
  apiKey: string;
  model: string;
  fetchFn?: FetchFn;
}): ProviderClient {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    name: "anthropic",
    contextBudget: 400_000,
    async complete(prompt: string): Promise<string> {
      const res = await fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          // Anthropic requires opting in to browser-originated calls.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      await expectOk("anthropic", res);
      const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
      return data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    },
  };
}
