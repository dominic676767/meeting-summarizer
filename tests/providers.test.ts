import { describe, expect, it } from "vitest";
import type { Settings } from "../src/domain/types";
import {
  createBedrockClient,
  createShortTermBedrockKey,
  SHORT_TERM_KEY_MS,
} from "../src/providers/bedrock";
import { createProviderClient } from "../src/providers/factory";
import { createOllamaClient } from "../src/providers/ollama";
import { createOpenAiClient } from "../src/providers/openai";
import { DEFAULT_SETTINGS } from "../src/settings";

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

describe("openai provider", () => {
  it("calls chat completions with bearer auth", async () => {
    const { fn, calls } = fakeFetch({ choices: [{ message: { content: "sum" } }] });
    const c = createOpenAiClient({ apiKey: "sk-o", model: "gpt-4o", fetchFn: fn });
    expect(await c.complete("p")).toBe("sum");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-o");
  });
});

describe("ollama provider", () => {
  it("calls the local chat endpoint without auth, non-streaming", async () => {
    const { fn, calls } = fakeFetch({ message: { content: "local sum" } });
    const c = createOllamaClient({ baseUrl: "http://localhost:11434/", model: "llama3.1", fetchFn: fn });
    expect(await c.complete("p")).toBe("local sum");
    expect(calls[0]!.url).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.stream).toBe(false);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("declares a small context budget so chunking activates early", () => {
    const c = createOllamaClient({ baseUrl: "http://localhost:11434", model: "m" });
    expect(c.contextBudget).toBeLessThan(50_000);
  });
});

describe("bedrock provider", () => {
  it("calls the regional Converse API with a bearer API key (never SigV4)", async () => {
    const { fn, calls } = fakeFetch({
      output: { message: { content: [{ text: "bedrock sum" }] } },
    });
    const c = createBedrockClient({
      apiKey: "bedrock-key",
      region: "eu-west-1",
      model: "anthropic.claude-sonnet-4-20250514-v1:0",
      fetchFn: fn,
    });
    expect(await c.complete("p")).toBe("bedrock sum");
    expect(calls[0]!.url).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-sonnet-4-20250514-v1%3A0/converse",
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer bedrock-key");
    expect(headers["x-amz-date"]).toBeUndefined(); // no SigV4 signing
  });
});

describe("short-term bedrock key", () => {
  const credentials = { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "secret", sessionToken: "tok/en+=" };
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);

  it("is a presigned CallWithBearerToken URL in AWS's token format", async () => {
    const { apiKey, expiresAt } = await createShortTermBedrockKey({ credentials, region: "eu-west-1", now });
    expect(apiKey.startsWith("bedrock-api-key-")).toBe(true);
    const url = new URL(`https://${atob(apiKey.slice("bedrock-api-key-".length))}`);
    expect(url.host).toBe("bedrock.amazonaws.com");
    expect(url.pathname).toBe("/");
    const q = url.searchParams;
    expect(q.get("Action")).toBe("CallWithBearerToken");
    expect(q.get("Version")).toBe("1");
    expect(q.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(q.get("X-Amz-Credential")).toBe("ASIAEXAMPLE/20261107/eu-west-1/bedrock/aws4_request");
    expect(q.get("X-Amz-Date")).toBe("20261107T120000Z");
    expect(q.get("X-Amz-Expires")).toBe("43200");
    expect(q.get("X-Amz-Security-Token")).toBe("tok/en+=");
    expect(q.get("X-Amz-SignedHeaders")).toBe("host");
    // Pinned from code that Bedrock accepted live (POST, global host). A wrong
    // method or host still makes a well-formed key that Bedrock refuses.
    expect(q.get("X-Amz-Signature")).toBe(
      "1be55e426422f7d3a524cac3285df105b458f11d51b7a0f7581264d7c067717f",
    );
    expect(expiresAt).toBe(now + SHORT_TERM_KEY_MS);
  });

  it("expires with the credentials when they expire first", async () => {
    const expiresAt = now + 60 * 60 * 1000;
    const key = await createShortTermBedrockKey({ credentials: { ...credentials, expiresAt }, region: "us-east-1", now });
    expect(key.expiresAt).toBe(expiresAt);
  });
});

describe("provider factory", () => {
  const withProvider = (provider: Settings["provider"], extra: Partial<Settings> = {}): Settings => ({
    ...DEFAULT_SETTINGS,
    provider,
    anthropic: { apiKey: "k", model: "m" },
    openai: { apiKey: "k", model: "m" },
    bedrock: { apiKey: "k", region: "us-east-1", model: "m" },
    ...extra,
  });

  it("builds the client for each selectable Provider", () => {
    for (const p of ["anthropic", "openai", "ollama", "bedrock"] as const) {
      expect(createProviderClient(withProvider(p)).name).toBe(p);
    }
  });

  it("refuses a keyed provider with no key, pointing at Settings", () => {
    expect(() =>
      createProviderClient(withProvider("anthropic", { anthropic: { apiKey: "", model: "m" } })),
    ).toThrow(/no API key configured/);
  });

  it("every provider declares a context budget", () => {
    for (const p of ["anthropic", "openai", "ollama", "bedrock"] as const) {
      expect(createProviderClient(withProvider(p)).contextBudget).toBeGreaterThan(0);
    }
  });
});
