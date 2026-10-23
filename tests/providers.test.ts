import { describe, expect, it } from "vitest";
import type { Settings } from "../src/domain/types";
import { createBedrockClient } from "../src/providers/bedrock";
import { createProviderClient } from "../src/providers/factory";
import { createOllamaClient } from "../src/providers/ollama";
import { createOpenAiClient } from "../src/providers/openai";
import { ProviderError } from "../src/providers/provider";
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

  it("refuses a summary cut off at the length limit", async () => {
    const { fn } = fakeFetch({ choices: [{ message: { content: "half" }, finish_reason: "length" }] });
    const c = createOpenAiClient({ apiKey: "k", model: "m", fetchFn: fn });
    await expect(c.complete("p")).rejects.toThrow(/cut off/);
  });

  it("refuses an empty summary (content null, as on a refusal)", async () => {
    const { fn } = fakeFetch({ choices: [{ message: { content: null }, finish_reason: "stop" }] });
    const c = createOpenAiClient({ apiKey: "k", model: "m", fetchFn: fn });
    await expect(c.complete("p")).rejects.toThrow(/empty summary/);
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

  it("refuses a summary cut off at the length limit", async () => {
    const { fn } = fakeFetch({ message: { content: "half" }, done_reason: "length" });
    const c = createOllamaClient({ baseUrl: "http://localhost:11434", model: "m", fetchFn: fn });
    await expect(c.complete("p")).rejects.toThrow(/cut off/);
  });

  it("refuses an empty summary", async () => {
    const { fn } = fakeFetch({ message: { content: "" }, done_reason: "stop" });
    const c = createOllamaClient({ baseUrl: "http://localhost:11434", model: "m", fetchFn: fn });
    await expect(c.complete("p")).rejects.toThrow(/empty summary/);
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

  const bedrock = (fn: typeof fetch) =>
    createBedrockClient({ apiKey: "k", region: "us-east-1", model: "m", fetchFn: fn });

  it("refuses a summary cut off at max_tokens", async () => {
    const { fn } = fakeFetch({
      output: { message: { content: [{ text: "half" }] } },
      stopReason: "max_tokens",
    });
    await expect(bedrock(fn).complete("p")).rejects.toThrow(/cut off/);
  });

  it("refuses an empty summary", async () => {
    const { fn } = fakeFetch({ output: { message: { content: [] } }, stopReason: "end_turn" });
    await expect(bedrock(fn).complete("p")).rejects.toThrow(/empty summary/);
  });
  it.each(["us-east-1", "eu-central-2", "ap-southeast-4", "us-gov-west-1", "cn-north-1"])(
    "accepts the real region %s",
    (region) => {
      expect(createBedrockClient({ apiKey: "k", region, model: "m" }).name).toBe("bedrock");
    },
  );

  it.each(["attacker.example/?", "us-east-1.attacker.example", "us-east-1/", "US-EAST-1", ""])(
    "refuses %j as a region before any call, so the key and transcript go nowhere else",
    (region) => {
      const { fn, calls } = fakeFetch({});
      expect(() => createBedrockClient({ apiKey: "k", region, model: "m", fetchFn: fn })).toThrow(
        ProviderError,
      );
      expect(calls).toHaveLength(0);
    },
  );
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

  it("refuses a summary Ollama URL that is not this computer, on the held-transcript path", () => {
    for (const baseUrl of ["http://ollama.example:11434", "https://localhost:11434", ""]) {
      expect(() =>
        createProviderClient(withProvider("ollama", { ollama: { baseUrl, model: "m" } })),
      ).toThrow(ProviderError);
    }
    for (const baseUrl of ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"]) {
      expect(
        createProviderClient(withProvider("ollama", { ollama: { baseUrl, model: "m" } })).name,
      ).toBe("ollama");
    }
  });

  it("refuses a Bedrock region that is not an AWS region", () => {
    expect(() =>
      createProviderClient(
        withProvider("bedrock", { bedrock: { apiKey: "k", region: "attacker.example/?", model: "m" } }),
      ),
    ).toThrow(/not an AWS region/);
  });

  it("every provider declares a context budget", () => {
    for (const p of ["anthropic", "openai", "ollama", "bedrock"] as const) {
      expect(createProviderClient(withProvider(p)).contextBudget).toBeGreaterThan(0);
    }
  });
});
