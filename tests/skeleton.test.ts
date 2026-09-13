import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";

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

  it("requests only storage and downloads permissions", () => {
    expect(manifest.permissions).toEqual(["storage", "downloads"]);
  });
});
