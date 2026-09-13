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
    // MV2: content scripts inject without user-granted host permissions
    // (MV3 gates them behind a manual opt-in — the bug this fixed).
    expect(manifest.manifest_version).toBe(2);
  });
});
