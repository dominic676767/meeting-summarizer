// The setup doctor: the Node floor, the macOS-only scope, and the Ollama origin
// rule — this extension allowed, every other extension refused. No real Ollama
// runs here: each probe answers from a table keyed by the Origin it sent.
import { describe, expect, it } from "vitest";
import {
  checkNode,
  checkOllama,
  checkPlatform,
  extensionIdFromKey,
} from "../scripts/doctor.mjs";

const OURS = "hbobmcebmpakimlijcjiaklipegdelap";

function ollama(statusFor: (origin: string) => number) {
  return async (_url: string, init?: RequestInit) => {
    const origin = (init?.headers as Record<string, string>).Origin ?? "";
    return { status: statusFor(origin) };
  };
}

const levels = (results: { level: string }[]) => results.map((r) => r.level);

describe("doctor", () => {
  it("fails a Node older than 22 and passes 22", () => {
    expect(checkNode("20.11.0").level).toBe("fail");
    expect(checkNode("22.0.0").level).toBe("pass");
  });

  it("only warns off macOS, because the guide covers macOS only", () => {
    expect(levels(checkPlatform("linux", false))).toEqual(["warn"]);
    expect(levels(checkPlatform("darwin", true))).toEqual(["pass"]);
  });

  it("derives the same extension ID as the manifest-key test", async () => {
    const { readFileSync } = await import("node:fs");
    const { key } = JSON.parse(readFileSync("src/manifest.json", "utf8")) as { key: string };
    expect(extensionIdFromKey(key)).toBe(OURS);
  });

  it("passes when Ollama allows this extension and refuses others", async () => {
    const fetch = ollama((o) => (o === `chrome-extension://${OURS}` ? 200 : 403));
    expect(levels(await checkOllama(OURS, fetch))).toEqual(["pass", "pass", "pass"]);
  });

  it("fails with the launchctl fix when OLLAMA_ORIGINS is gone, as after a reboot", async () => {
    const results = await checkOllama(OURS, ollama(() => 403));
    expect(levels(results)).toEqual(["pass", "fail"]);
    expect(results[1]?.fix).toContain(`launchctl setenv OLLAMA_ORIGINS "chrome-extension://${OURS}"`);
  });

  it("warns when Ollama allows every extension", async () => {
    expect(levels(await checkOllama(OURS, ollama(() => 200)))).toEqual(["pass", "pass", "warn"]);
  });

  it("fails when Ollama is not running", async () => {
    const down = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(levels(await checkOllama(OURS, down))).toEqual(["fail"]);
  });
});
