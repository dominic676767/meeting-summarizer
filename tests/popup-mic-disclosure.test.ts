// @vitest-environment jsdom
// The popup's microphone disclosure must carry its explanation (ADR-0007).
//
// The defect: popup.ts defined the two sentences but never wrote either one, so
// the popup asked "Include your microphone?" with an empty paragraph under it.
// With a cloud engine selected, a yes in the popup then sent the user's voice to
// a company the popup never named.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../src/domain/types";
import type { StatusReply } from "../src/messages";
import { DEFAULT_SETTINGS } from "../src/settings";

const browser = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
  loadSettings: vi.fn(),
}));

vi.mock("../src/platform", () => ({
  ext: {
    tabs: { query: browser.query },
    runtime: { sendMessage: browser.sendMessage, openOptionsPage: vi.fn() },
  },
}));

vi.mock("../src/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/settings")>()),
  loadSettings: browser.loadSettings,
  loadAwsCredentials: async () => null,
}));

const POPUP_BODY = new DOMParser().parseFromString(
  readFileSync("src/popup/popup.html", "utf8"),
  "text/html",
).body.innerHTML;

/** A Meeting detected, with the disclosure not yet answered. */
const STATUS: StatusReply = {
  inMeeting: true,
  segmentCount: 0,
  title: "Weekly sync",
  capturing: false,
  state: "detected",
  recording: false,
  recordingStartedAt: null,
  degraded: true,
  noSpeech: false,
  captureWarning: null,
  mic: "unconfirmed",
  micDetail: null,
  transcription: null,
};

function settingsWith(provider: Settings["transcription"]["provider"]): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.transcription.provider = provider;
  return s;
}

const intervals: ReturnType<typeof setInterval>[] = [];

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = POPUP_BODY;
  browser.query.mockReset().mockResolvedValue([{ id: 42 }]);
  browser.sendMessage.mockReset().mockImplementation(async (msg: { type: string }) =>
    msg.type === "list-held" ? { held: [], recordings: [] } : STATUS,
  );
  browser.loadSettings.mockReset();
  const realSetInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
    const id = realSetInterval(fn, ms);
    intervals.push(id);
    return id;
  }) as typeof setInterval);
});

afterEach(() => {
  for (const id of intervals.splice(0)) clearInterval(id);
  vi.restoreAllMocks();
});

async function openPopup(): Promise<{ disclosure: HTMLElement; why: HTMLElement }> {
  await import("../src/popup/popup");
  return {
    disclosure: document.getElementById("mic-disclosure")!,
    why: document.getElementById("mic-why")!,
  };
}

describe("the popup's microphone disclosure", () => {
  it.each(["local-whisper", "ollama"] as const)(
    "says that %s transcribes on this machine",
    async (provider) => {
      browser.loadSettings.mockResolvedValue(settingsWith(provider));
      const { disclosure, why } = await openPopup();

      await vi.waitFor(() => expect(disclosure.hidden).toBe(false), { timeout: 3000 });
      expect(why.textContent).toContain("everything is transcribed on this machine");
    },
  );

  it.each([
    ["openai", "OpenAI"],
    ["elevenlabs", "ElevenLabs"],
    ["sagemaker", "Amazon SageMaker"],
  ] as const)("names where %s uploads the recording", async (provider, name) => {
    browser.loadSettings.mockResolvedValue(settingsWith(provider));
    const { disclosure, why } = await openPopup();

    await vi.waitFor(() => expect(disclosure.hidden).toBe(false), { timeout: 3000 });
    expect(why.textContent).toContain(`you have chosen ${name} to transcribe`);
    expect(why.textContent).toContain("is uploaded to");
    expect(why.textContent).not.toContain("on this machine");
  });

  it("does not offer the choice before it can say where the audio goes", async () => {
    // Settings never load, so the explanation is unknown.
    browser.loadSettings.mockReturnValue(new Promise(() => {}));
    const { disclosure, why } = await openPopup();

    await vi.waitFor(() =>
      expect(browser.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "get-status" })),
    );
    // Let the status reply render.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(why.textContent).toBe("");
    expect(disclosure.hidden).toBe(true);
  });
});
