import { beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.json";
import { restoreMeetingContentScripts } from "../src/background/restore-content";

const browser = vi.hoisted(() => ({
  getManifest: vi.fn(),
  query: vi.fn(),
  executeScript: vi.fn(),
}));

vi.mock("../src/platform", () => ({
  ext: {
    runtime: { getManifest: browser.getManifest },
    tabs: { query: browser.query },
    scripting: { executeScript: browser.executeScript },
  },
}));

beforeEach(() => {
  browser.getManifest.mockReset().mockReturnValue(manifest);
  browser.query.mockReset().mockResolvedValue([]);
  browser.executeScript.mockReset().mockResolvedValue([]);
});

describe("content-script recovery after extension reload", () => {
  it("queries only the manifest's supported meeting hosts", async () => {
    await restoreMeetingContentScripts();
    expect(browser.query).toHaveBeenCalledWith({
      url: [...new Set(manifest.content_scripts.flatMap((entry) => entry.matches))],
    });
  });

  it("restores the correct client and capture prompt in every frame", async () => {
    browser.query.mockResolvedValue([
      { id: 11, url: "https://app.zoom.us/wc/92191608192/join" },
      { id: 12, url: "https://teams.microsoft.com/v2/" },
    ]);
    await restoreMeetingContentScripts();
    expect(browser.executeScript.mock.calls.map(([args]) => args)).toEqual([
      { target: { tabId: 11, allFrames: true }, files: ["zoom-content.js", "capture-prompt.js"] },
      { target: { tabId: 12, allFrames: true }, files: ["teams-content.js", "capture-prompt.js"] },
    ]);
  });

  it("does not inject into Zoom's leave, home or pre-join pages", async () => {
    browser.query.mockResolvedValue([
      { id: 11, url: "https://app.zoom.us/wc/home" },
      { id: 12, url: "https://app.zoom.us/wc/leave" },
      { id: 13, url: "https://app.zoom.us/j/92191608192" },
      { id: 14, url: "https://example.com/" },
      { url: "https://app.zoom.us/wc/92191608192/join" },
    ]);
    await restoreMeetingContentScripts();
    expect(browser.executeScript).not.toHaveBeenCalled();
  });

  it("continues recovery when one tab closes during injection", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    browser.query.mockResolvedValue([
      { id: 11, url: "https://app.zoom.us/wc/92191608192/join" },
      { id: 12, url: "https://teams.live.com/" },
    ]);
    browser.executeScript.mockRejectedValueOnce(new Error("No tab with id: 11"));
    await expect(restoreMeetingContentScripts()).resolves.toBeUndefined();
    expect(browser.executeScript).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });
});
