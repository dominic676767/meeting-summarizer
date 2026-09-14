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

  it("requests only storage, downloads, and provider-API host permissions", () => {
    const apiPermissions = manifest.permissions.filter((p) => !p.includes("://"));
    expect(apiPermissions).toEqual(["storage", "downloads"]);
  });

  it("targets Chromium Manifest V3 with a service worker", () => {
    // ADR-0003: Firefox retired because it cannot capture tab audio at all.
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBeTruthy();
  });
});
