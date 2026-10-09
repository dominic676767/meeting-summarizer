import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createTab, getURL } = vi.hoisted(() => ({
  createTab: vi.fn(),
  getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
}));

vi.mock("../src/platform", () => ({
  ext: {
    tabs: { create: createTab },
    runtime: { getURL },
  },
}));

import {
  allowMicrophoneAccess,
  microphoneAccessFailure,
} from "../src/options/microphone-access";

const getUserMedia = vi.fn();

beforeEach(() => {
  createTab.mockReset().mockResolvedValue({});
  getUserMedia.mockReset();
  const page = {};
  vi.stubGlobal("window", { self: page, top: page });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
});

afterEach(() => vi.unstubAllGlobals());

describe("Settings microphone access", () => {
  it("opens a separate Settings tab from an embedded view without requesting the microphone", async () => {
    vi.stubGlobal("window", { self: {}, top: {} });

    await expect(allowMicrophoneAccess()).resolves.toContain("separate tab");

    expect(createTab).toHaveBeenCalledWith({
      url: "chrome-extension://test/options.html#microphone",
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("requests access in a top-level Settings tab and immediately closes the permission stream", async () => {
    const stop = vi.fn();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });

    await expect(allowMicrophoneAccess()).resolves.toContain("access is allowed");

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledOnce();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("does not report success after Chrome rejects access", async () => {
    const error = new DOMException("Permission denied", "NotAllowedError");
    getUserMedia.mockRejectedValue(error);

    await expect(allowMicrophoneAccess()).rejects.toBe(error);
    expect(createTab).not.toHaveBeenCalled();
  });

  it.each([
    new DOMException("Not supported", "NotSupportedError"),
    new Error("Not supported"),
  ])("opens a separate Settings tab after an unsupported request in a guest view", async (error) => {
    getUserMedia.mockRejectedValue(error);

    await expect(allowMicrophoneAccess()).resolves.toBe(
      "Settings is open in a separate tab. Select Allow microphone access there.",
    );

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(createTab).toHaveBeenCalledWith({
      url: "chrome-extension://test/options.html#microphone",
    });
  });

  it("does not report that Settings opened if Chrome rejects the new tab", async () => {
    vi.stubGlobal("window", { self: {}, top: {} });
    const error = new Error("Could not open tab");
    createTab.mockRejectedValue(error);

    await expect(allowMicrophoneAccess()).rejects.toBe(error);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it.each([
    new DOMException("Not supported", "NotSupportedError"),
    new Error("Not supported"),
  ])("directs an unsupported view to a separate tab", (error) => {
    const message = microphoneAccessFailure(error);
    expect(message).toContain("separate tab");
    expect(message).not.toContain("blocked");
    expect(message).not.toContain("system settings");
  });

  it("directs a permission refusal to Chrome and system access settings", () => {
    const message = microphoneAccessFailure(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    expect(message).toContain("blocked");
    expect(message).toContain("Chrome");
    expect(message).toContain("system settings");
  });

  it("reports a missing device without telling the user to change access settings", () => {
    const message = microphoneAccessFailure(
      new DOMException("Requested device not found", "NotFoundError"),
    );
    expect(message).toContain("Connect a microphone");
    expect(message).not.toContain("blocked");
  });

  it("reports a device open failure without presenting it as a permission refusal", () => {
    const message = microphoneAccessFailure(
      new DOMException("Could not start audio source", "NotReadableError"),
    );
    expect(message).toContain("input device");
    expect(message).not.toContain("blocked");
  });
});
