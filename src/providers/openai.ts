import { expectOk, type FetchFn, type ProviderClient } from "./provider";

export function createOpenAiClient(opts: {
  apiKey: string;
  model: string;
  fetchFn?: FetchFn;
}): ProviderClient {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    name: "openai",
    contextBudget: 300_000,
    async complete(prompt: string): Promise<string> {
      const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      await expectOk("openai", res);
      const data = (await res.json()) as {
        choices: Array<{ message: { content: string | null } }>;
      };
      return data.choices[0]?.message.content ?? "";
    },
  };
}
