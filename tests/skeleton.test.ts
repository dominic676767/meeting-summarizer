import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.json";

describe("walking skeleton", () => {
  it("content scripts are scoped to Teams web-client domains only", () => {
    const matches = manifest.content_scripts.flatMap((cs) => cs.matches);
    expect(matches).toEqual([
      "https://teams.microsoft.com/*",
      "https://teams.live.com/*",
      "https://teams.cloud.microsoft/*",
      "https://*.teams.microsoft.com/*",
    ]);
    // The Teams meeting UI can live inside an iframe.
    expect(manifest.content_scripts.every((cs) => cs.all_frames)).toBe(true);
  });

  it("requests storage, downloads, and the audio-capture permissions", () => {
    const apiPermissions = manifest.permissions.filter((p) => !p.includes("://"));
    // tabCapture + offscreen are what audio recording needs (ADR-0004): the
    // stream id comes from tabCapture, the recorder lives in an offscreen doc.
    expect(apiPermissions).toEqual(["storage", "downloads", "tabCapture", "offscreen"]);
  });

  it("registers a keyboard command so a real extension invocation can start capture", () => {
    // A click on an injected in-page button cannot grant tabCapture; a bound
    // command can, which is why the in-page prompt only summons the gesture.
    expect(manifest.commands["start-capture"]).toBeTruthy();
  });

  it("allows WASM compilation, without which local Whisper cannot run", () => {
    // MV3's default page CSP forbids compiling WebAssembly; the local
    // Transcription Provider is WASM, so this single token is what makes the
    // default (no-API-key) configuration work at all.
    expect(manifest.content_security_policy.extension_pages).toContain("'wasm-unsafe-eval'");
  });

  it("reaches the model host so the one-time Whisper download can happen", () => {
    expect(manifest.host_permissions).toContain("https://huggingface.co/*");
  });

  it("targets Chromium Manifest V3 with a service worker", () => {
    // ADR-0003: Firefox retired because it cannot capture tab audio at all.
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBeTruthy();
  });
});
