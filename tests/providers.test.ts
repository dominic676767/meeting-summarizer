import { describe, expect, it } from "vitest";
import type { Settings } from "../src/domain/types";
import { createBedrockClient } from "../src/providers/bedrock";
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
