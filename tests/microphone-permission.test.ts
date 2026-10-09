import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  microphonePermission,
  requestMicrophonePermission,
} from "../src/offscreen/microphone-permission";

const query = vi.fn();
const getUserMedia = vi.fn();

beforeEach(() => {
  query.mockReset();
  getUserMedia.mockReset();
  vi.stubGlobal("navigator", {
    permissions: { query },
    mediaDevices: { getUserMedia },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("microphone access before recording", () => {
  it.each(["granted", "prompt", "denied"] as const)(
    "reads %s access without opening a microphone",
    async (state) => {
      query.mockResolvedValue({ state });
      await expect(microphonePermission()).resolves.toBe(state);
      expect(query).toHaveBeenCalledWith({ name: "microphone" });
      expect(getUserMedia).not.toHaveBeenCalled();
    },
  );

  it("reports unknown when the browser cannot query microphone access", async () => {
    query.mockRejectedValue(new TypeError("Unsupported permission"));
    await expect(microphonePermission()).resolves.toBe("unknown");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("reports unknown when the Permissions API is absent", async () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    await expect(microphonePermission()).resolves.toBe("unknown");
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

describe("the visible microphone access step", () => {
  it("releases every track after Chrome grants access", async () => {
    const microphone = { stop: vi.fn() };
    const secondTrack = { stop: vi.fn() };
    getUserMedia.mockResolvedValue({ getTracks: () => [microphone, secondTrack] });

    await requestMicrophonePermission();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(microphone.stop).toHaveBeenCalledTimes(1);
    expect(secondTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("returns Chrome's refusal so Settings can show it", async () => {
    const error = new DOMException("Permission denied", "NotAllowedError");
    getUserMedia.mockRejectedValue(error);

    await expect(requestMicrophonePermission()).rejects.toBe(error);
  });
});
