import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";

describe("walking skeleton", () => {
  it("content scripts are scoped to Teams web-client domains only", () => {
    const matches = manifest.content_scripts.flatMap((cs) => cs.matches);
    expect(matches).toEqual([
      "https://teams.microsoft.com/*",
      "https://teams.live.com/*",
    ]);
  });

  it("requests only storage and downloads permissions", () => {
    expect(manifest.permissions).toEqual(["storage", "downloads"]);
  });
});
