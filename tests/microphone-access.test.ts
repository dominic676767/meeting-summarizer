import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMicrophoneAccess } from "../src/background/microphone-access";

const browser = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getURL: vi.fn(),
  query: vi.fn(),
  updateTab: vi.fn(),
  createTab: vi.fn(),
  updateWindow: vi.fn(),
}));

vi.mock("../src/platform", () => ({
  ext: {
    runtime: { sendMessage: browser.sendMessage, getURL: browser.getURL },
    tabs: { query: browser.query, update: browser.updateTab, create: browser.createTab },
    windows: { update: browser.updateWindow },
  },
}));

const optionsUrl = "chrome-extension://test-extension/options.html";

beforeEach(() => {
  for (const mock of Object.values(browser)) mock.mockReset();
  browser.getURL.mockReturnValue(optionsUrl);
  browser.query.mockResolvedValue([]);
  browser.updateTab.mockResolvedValue({});
  browser.createTab.mockResolvedValue({});
  browser.updateWindow.mockResolvedValue({});
});

describe("visible microphone access before tab capture", () => {
  it.each(["granted", "unknown"] as const)(
    "continues with %s access without opening Settings",
    async (permission) => {
      browser.sendMessage.mockResolvedValue({ permission });

      await expect(prepareMicrophoneAccess()).resolves.toBe(permission);

      expect(browser.sendMessage).toHaveBeenCalledWith({ type: "offscreen-mic-permission" });
      expect(browser.query).not.toHaveBeenCalled();
      expect(browser.createTab).not.toHaveBeenCalled();
      expect(browser.updateTab).not.toHaveBeenCalled();
    },
  );

  it("opens the microphone section when Chrome must ask for access", async () => {
    browser.sendMessage.mockResolvedValue({ permission: "prompt" });

    await expect(prepareMicrophoneAccess()).resolves.toBe("prompt");

    expect(browser.query).toHaveBeenCalledWith({ url: `${optionsUrl}*` });
    expect(browser.createTab).toHaveBeenCalledWith({ url: `${optionsUrl}#microphone` });
    expect(browser.updateTab).not.toHaveBeenCalled();
  });

  it("reuses and focuses Settings when access has been denied", async () => {
    browser.sendMessage.mockResolvedValue({ permission: "denied" });
    browser.query.mockResolvedValue([{ id: 41, windowId: 7 }]);

    await expect(prepareMicrophoneAccess()).resolves.toBe("denied");

    expect(browser.updateTab).toHaveBeenCalledWith(41, {
      url: `${optionsUrl}#microphone`,
      active: true,
    });
    expect(browser.updateWindow).toHaveBeenCalledWith(7, { focused: true });
    expect(browser.createTab).not.toHaveBeenCalled();
  });

  it("opens Settings if a returned tab has no usable ID", async () => {
    browser.sendMessage.mockResolvedValue({ permission: "prompt" });
    browser.query.mockResolvedValue([{ windowId: 7 }]);

    await prepareMicrophoneAccess();

    expect(browser.createTab).toHaveBeenCalledWith({ url: `${optionsUrl}#microphone` });
    expect(browser.updateTab).not.toHaveBeenCalled();
  });
});
