import { SignatureV4 } from "@smithy/signature-v4";
import { isAwsRegion, type AwsCredentials } from "../transcription/aws-credentials";
import { WebCryptoSha256 } from "../transcription/sagemaker";
import { expectOk, expectSummary, ProviderError, type FetchFn, type ProviderClient } from "./provider";

// Bedrock via API keys (bearer tokens) only. Long-lived AWS keys stay
// unsupported everywhere (ADR-0009). Temporary AWS credentials are used only on
// the Settings page, to make a short-term key (below); the client never signs.
// Uses the Converse API for a model-agnostic request shape.
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
        stopReason?: string;
      };
      // No inferenceConfig: Converse defaults maxTokens to the model's own maximum.
      const text = data.output.message.content.map((c) => c.text ?? "").join("");
      return expectSummary("bedrock", text, data.stopReason === "max_tokens");
    },
  };
}

/** AWS's maximum lifetime for a short-term Bedrock API key. */
export const SHORT_TERM_KEY_MS = 12 * 60 * 60 * 1000;

/**
 * A short-term Bedrock API key, made as AWS's `aws-bedrock-token-generator`
 * makes it: a SigV4-presigned `CallWithBearerToken` URL, base64-encoded behind
 * the `bedrock-api-key-` prefix. Made offline; the key works until 12 hours
 * pass or the credentials expire, whichever is first.
 */
export async function createShortTermBedrockKey(opts: {
  credentials: AwsCredentials;
  region: string;
  now?: number;
}): Promise<{ apiKey: string; expiresAt: number }> {
  const now = opts.now ?? Date.now();
  // The global host, as AWS's generator signs it; the region is in the scope only.
  const hostname = "bedrock.amazonaws.com";
  const signer = new SignatureV4({
    service: "bedrock",
    region: opts.region,
    credentials: {
      accessKeyId: opts.credentials.accessKeyId,
      secretAccessKey: opts.credentials.secretAccessKey,
      sessionToken: opts.credentials.sessionToken,
    },
    sha256: WebCryptoSha256,
    applyChecksum: false,
  });
  const presigned = await signer.presign(
    {
      method: "POST", // AWS's generators sign POST; GET fails as an invalid key
      protocol: "https:",
      hostname,
      path: "/",
      query: { Action: "CallWithBearerToken" },
      headers: { host: hostname },
    },
    { expiresIn: SHORT_TERM_KEY_MS / 1000, signingDate: new Date(now) },
  );
  const query = Object.entries(presigned.query ?? {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const apiKey = `bedrock-api-key-${btoa(`${hostname}/?${query}&Version=1`)}`;
  const expiresAt = Math.min(now + SHORT_TERM_KEY_MS, opts.credentials.expiresAt ?? Infinity);
  return { apiKey, expiresAt };
}
