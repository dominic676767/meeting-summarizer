import { describe, expect, it } from "vitest";
import { createAnthropicClient } from "../src/providers/anthropic";

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

describe("anthropic provider", () => {
  it("calls the Messages API with key, version, and browser-access headers", async () => {
    const { fn, calls } = fakeFetch(200, {
      content: [{ type: "text", text: "summary text" }],
    });
    const client = createAnthropicClient({ apiKey: "sk-test", model: "claude-sonnet-5", fetchFn: fn });
    const out = await client.complete("hello");
    expect(out).toBe("summary text");
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBeTruthy();
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.messages[0].content).toBe("hello");
  });

  it("throws ProviderError on non-2xx", async () => {
    const { fn } = fakeFetch(401, { error: "bad key" });
    const client = createAnthropicClient({ apiKey: "bad", model: "m", fetchFn: fn });
    await expect(client.complete("x")).rejects.toThrow(/HTTP 401/);
  });
});
