import { expectOk, type FetchFn, type ProviderClient } from "./provider";

// Local models run small context windows; budget kept conservative so the
// pipeline's map-reduce chunking kicks in early.
export function createOllamaClient(opts: {
  baseUrl: string;
  model: string;
  fetchFn?: FetchFn;
}): ProviderClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  return {
    name: "ollama",
    contextBudget: 24_000,
    async complete(prompt: string): Promise<string> {
      const res = await fetchFn(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
        }),
      });
      await expectOk("ollama", res);
      const data = (await res.json()) as { message: { content: string } };
      return data.message.content;
    },
  };
}
