import { isAwsRegion } from "../transcription/aws-credentials";
import { expectOk, ProviderError, type FetchFn, type ProviderClient } from "./provider";

// Bedrock via API keys (bearer tokens) only. Long-lived AWS keys stay
// unsupported everywhere (ADR-0009), and the SageMaker engine's temporary AWS
// credentials are not used here. Uses the Converse API for a model-agnostic
// request shape.
export function createBedrockClient(opts: {
  apiKey: string;
  region: string;
  model: string;
  fetchFn?: FetchFn;
}): ProviderClient {
  // The region is part of the host that gets the key and the transcript.
  if (!isAwsRegion(opts.region)) {
    throw new ProviderError(
      "bedrock",
      `"${opts.region}" is not an AWS region, for example us-east-1 — open Settings`,
    );
  }
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    name: "bedrock",
    contextBudget: 300_000,
    async complete(prompt: string): Promise<string> {
      const url = `https://bedrock-runtime.${opts.region}.amazonaws.com/model/${encodeURIComponent(
        opts.model,
      )}/converse`;
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: [{ text: prompt }] }],
        }),
      });
      await expectOk("bedrock", res);
      const data = (await res.json()) as {
        output: { message: { content: Array<{ text?: string }> } };
      };
      return data.output.message.content.map((c) => c.text ?? "").join("");
    },
  };
}
