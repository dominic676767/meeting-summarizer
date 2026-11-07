import { expectOk, expectSummary, type FetchFn, type ProviderClient } from "./provider";

export function createAnthropicClient(opts: {
  apiKey: string;
  model: string;
  fetchFn?: FetchFn;
}): ProviderClient {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    name: "anthropic",
    // Characters, not tokens. Claude 4.x before 4.6 has a 200K-token window, and
    // Chinese, Japanese or Korean text is about one token per character.
    contextBudget: /-4-(?![678])/.test(opts.model) ? 150_000 : 400_000,
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
          // 16000: below every served Claude model's output cap, and short enough for a non-streaming call.
          max_tokens: 16000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      await expectOk("anthropic", res);
      const data = (await res.json()) as {
        content: Array<{ type: string; text?: string }>;
        stop_reason?: string;
      };
      const text = data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return expectSummary("anthropic", text, data.stop_reason === "max_tokens");
    },
  };
}
