import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OffscreenStatusReply } from "../src/messages";
import type { SessionState } from "../src/background/sessions";

const browser = vi.hoisted(() => ({
  onMessage: vi.fn(),
  onStartup: vi.fn<(listener: () => void) => void>(),
  onInstalled: vi.fn<(listener: () => void) => void>(),
  onCommand: vi.fn(),
  onUpdated: vi.fn(),
  onRemoved: vi.fn(),
  sessionGet: vi.fn<(key: string) => Promise<Record<string, unknown>>>(),
  sessionSet: vi.fn<(values: Record<string, unknown>) => Promise<void>>(),
  localGet: vi.fn<(key: string) => Promise<Record<string, unknown>>>(),
  localSet: vi.fn<(values: Record<string, unknown>) => Promise<void>>(),
  getTab: vi.fn(),
  sendMessage: vi.fn(),
  setBadgeText: vi.fn(),
  setBadgeBackgroundColor: vi.fn(),
  setTitle: vi.fn(),
  restoreContent: vi.fn(),
  createProvider: vi.fn(),
  summarize: vi.fn(),
}));

vi.mock("../src/platform", () => ({
  ext: {
    runtime: {
      onMessage: { addListener: browser.onMessage },
      onStartup: { addListener: browser.onStartup },
      onInstalled: { addListener: browser.onInstalled },
      sendMessage: browser.sendMessage,
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    commands: { onCommand: { addListener: browser.onCommand }, getAll: async () => [] },
    tabs: {
      onUpdated: { addListener: browser.onUpdated },
      onRemoved: { addListener: browser.onRemoved },
      get: browser.getTab,
    },
    storage: {
      session: { get: browser.sessionGet, set: browser.sessionSet },
      local: { get: browser.localGet, set: browser.localSet },
    },
    action: {
      setBadgeText: browser.setBadgeText,
      setBadgeBackgroundColor: browser.setBadgeBackgroundColor,
      setTitle: browser.setTitle,
    },
  },
}));
vi.mock("../src/background/restore-content", () => ({
  restoreMeetingContentScripts: browser.restoreContent,
}));
vi.mock("../src/providers/factory", () => ({ createProviderClient: browser.createProvider }));
vi.mock("../src/pipeline/pipeline", () => ({ summarizeTranscript: browser.summarize }));

let sessionStore: Record<string, unknown>;
let localStore: Record<string, unknown>;
const checkpointKey = "meetingSessionsCheckpoint";

function read(store: Record<string, unknown>, key: string): Record<string, unknown> {
  return key in store ? { [key]: structuredClone(store[key]) } : {};
}

function recorderStatus(overrides: Partial<OffscreenStatusReply> = {}): OffscreenStatusReply {
  return {
    recording: false,
    tabId: null,
    spanId: null,
    transcribingTabId: null,
    startedAt: null,
    encodedBytes: 0,
    anySignal: false,
    error: null,
    micRecording: false,
    micError: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(browser)) mock.mockReset();
  sessionStore = {};
  localStore = {};
  browser.sessionGet.mockImplementation(async (key) => read(sessionStore, key));
  browser.localGet.mockImplementation(async (key) => read(localStore, key));
  browser.sessionSet.mockImplementation(async (values) => {
    Object.assign(sessionStore, structuredClone(values));
  });
  browser.localSet.mockImplementation(async (values) => {
    Object.assign(localStore, structuredClone(values));
  });
  browser.getTab.mockResolvedValue({ id: 42, url: "https://app.zoom.us/wc/123456789/join" });
  browser.sendMessage.mockResolvedValue(recorderStatus());
  browser.setBadgeText.mockResolvedValue(undefined);
  browser.setBadgeBackgroundColor.mockResolvedValue(undefined);
  browser.setTitle.mockResolvedValue(undefined);
  browser.restoreContent.mockResolvedValue(undefined);
});

async function seedCheckpoint(options: {
  recording?: boolean;
  audio?: boolean;
  captions?: boolean;
  state?: SessionState;
} = {}) {
  const api = await import("../src/background/sessions");
  const session = await api.ensureSession(42, "Zoom");
  session.startedAt = 1_000;
  session.inMeeting = true;
  session.title = "Recovered Zoom meeting";
  session.recording = options.recording ?? false;
  session.recordingStartedAt = session.recording ? 2_000 : null;
  session.micRecording = session.recording;
  session.micError = session.recording ? "Old microphone error" : null;
  session.state = options.state ?? "capturing";
  session.recordingId = options.audio === false ? null : "recording";
  session.spans = options.audio === false
    ? []
    : [{ spanId: "recording.1000", startOffsetMs: 1_000 }];
  if (options.captions !== false) {
    session.accumulator.upsert(
      { key: "caption-1", speaker: "Participant A", text: "We will ship next Friday." },
      2_000,
    );
  }
  await api.persistSessions();
  delete sessionStore.sessions;
  vi.resetModules();
}

async function startRecovery(event: "installed" | "startup" = "installed") {
  await import("../src/background/background");
  const listener = (event === "installed" ? browser.onInstalled : browser.onStartup)
    .mock.calls[0]?.[0];
  if (!listener) throw new Error("Recovery listener was not registered.");
  listener();
  await vi.waitFor(() => expect(browser.restoreContent).toHaveBeenCalledTimes(1));
  return import("../src/background/sessions");
}

function expectNoProcessing() {
  expect(browser.createProvider).not.toHaveBeenCalled();
  expect(browser.summarize).not.toHaveBeenCalled();
  expect(browser.sendMessage.mock.calls.map(([message]) => message)).toEqual([
    { type: "offscreen-status" },
  ]);
}

describe("meeting recovery after an extension reload", () => {
  it.each(["done", "failed"] as const)(
    "clears stale %s meeting status on the Zoom home page",
    async (state) => {
      await seedCheckpoint({ state, captions: false });
      browser.getTab.mockResolvedValue({ id: 42, url: "https://app.zoom.us/wc/home" });

      const api = await startRecovery();

      expect(await api.getSession(42)).toMatchObject({ state, inMeeting: false });
      expect(localStore[checkpointKey]).toMatchObject({
        sessions: { "42": { state, inMeeting: false } },
      });
      expect(localStore.heldRecordings).toBeUndefined();
      expect(browser.setBadgeText).toHaveBeenLastCalledWith({ tabId: 42, text: "" });
      expectNoProcessing();
    },
  );

  it("clears an empty session on the Zoom home page", async () => {
    await seedCheckpoint({ audio: false, captions: false });
    browser.getTab.mockResolvedValue({ id: 42, url: "https://app.zoom.us/wc/home" });

    const api = await startRecovery();

    expect(await api.getSession(42)).toMatchObject({ state: "capturing", inMeeting: false });
    expect(localStore.heldTranscripts).toBeUndefined();
    expectNoProcessing();
  });

  it("drops a completed session for a closed tab without holding discarded audio again", async () => {
    await seedCheckpoint({ state: "done", captions: false });
    browser.getTab.mockRejectedValue(new Error("No tab"));

    const api = await startRecovery();

    expect(await api.getSession(42)).toBeUndefined();
    expect(localStore.heldRecordings).toBeUndefined();
    expectNoProcessing();
  });

  it("retains meeting status for a completed manual report in a live Zoom tab", async () => {
    await seedCheckpoint({ state: "done", captions: false });

    const api = await startRecovery();

    expect(await api.getSession(42)).toMatchObject({ state: "done", inMeeting: true });
    expectNoProcessing();
  });

  it.each(["installed", "startup"] as const)(
    "retains saved audio and captions for a live Zoom meeting on %s",
    async (event) => {
      await seedCheckpoint({ recording: true });
      const api = await startRecovery(event);
      const session = await api.getSession(42);

      expect(session).toMatchObject({
        recording: false,
        recordingStartedAt: null,
        micRecording: false,
        micError: null,
        recordingId: "recording",
        spans: [{ spanId: "recording.1000", startOffsetMs: 1_000 }],
        captureWarning: { message: expect.stringContaining("Recording stopped unexpectedly") },
      });
      expect(session?.accumulator.size).toBe(1);
      expect(localStore[checkpointKey]).toMatchObject({ sessions: { "42": { recording: false } } });
      expect(localStore.heldRecordings).toBeUndefined();
      expectNoProcessing();
    },
  );

  it.each(["transcribing", "summarizing"] as const)(
    "makes interrupted %s available for a manual retry",
    async (state) => {
      await seedCheckpoint({ state });
      const api = await startRecovery();
      expect(await api.getSession(42)).toMatchObject({
        state: "capturing",
        transcription: null,
        captureWarning: { message: "Processing stopped unexpectedly. Retry the saved meeting." },
      });
      expectNoProcessing();
    },
  );

  it.each(["missing", "other page"] as const)(
    "holds recovered audio before clearing its checkpoint when the tab is %s",
    async (tabState) => {
      await seedCheckpoint();
      if (tabState === "missing") browser.getTab.mockRejectedValue(new Error("No tab"));
      else browser.getTab.mockResolvedValue({ id: 42, url: "https://example.com/" });
      browser.localSet.mockClear();

      const api = await startRecovery();
      expect(await api.getSession(42)).toBeUndefined();
      expect(localStore.heldRecordings).toMatchObject({
        recording: {
          recordingId: "recording",
          spans: [{ spanId: "recording.1000", startOffsetMs: 1_000 }],
          reason: expect.stringContaining("Review and retry it manually"),
          transcript: {
            platform: "Zoom",
            segments: [{ text: "We will ship next Friday." }],
          },
        },
      });
      const writes = browser.localSet.mock.calls.map(([values]) => values);
      expect(writes[0]).toHaveProperty("heldRecordings");
      expect(writes[1]).toEqual({ [checkpointKey]: { version: 1, sessions: {} } });
      expectNoProcessing();
    },
  );

  it("holds a recovered captions-only meeting when its tab is gone", async () => {
    await seedCheckpoint({ audio: false });
    browser.getTab.mockRejectedValue(new Error("No tab"));
    const api = await startRecovery();

    expect(await api.getSession(42)).toBeUndefined();
    expect(Object.values(localStore.held as Record<string, unknown>)).toMatchObject([
      {
        reason: expect.stringContaining("Review and retry it manually"),
        transcript: { platform: "Zoom", segments: [{ text: "We will ship next Friday." }] },
      },
    ]);
    expectNoProcessing();
  });

  it("keeps the checkpoint if storing the Held recording fails", async () => {
    await seedCheckpoint();
    browser.getTab.mockRejectedValue(new Error("No tab"));
    const failure = new Error("Held storage failed");
    browser.localSet.mockRejectedValueOnce(failure);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await import("../src/background/background");
      browser.onInstalled.mock.calls[0]?.[0]();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(failure));

      const api = await import("../src/background/sessions");
      expect((await api.getSession(42))?.spans).toHaveLength(1);
      expect(localStore[checkpointKey]).toMatchObject({ sessions: { "42": { spans: expect.any(Array) } } });
      expect(browser.restoreContent).not.toHaveBeenCalled();
      expectNoProcessing();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not clear a recording claim while the offscreen recorder is still alive", async () => {
    await seedCheckpoint({ recording: true });
    browser.sendMessage.mockResolvedValue(recorderStatus({
      recording: true,
      tabId: 42,
      spanId: "recording.1000",
      startedAt: 2000,
      micRecording: true,
    }));
    const api = await startRecovery();
    expect(await api.getSession(42)).toMatchObject({ recording: true, micRecording: true });
    expectNoProcessing();
  });

  it.each([
    { tabId: 99, spanId: "recording.1000" },
    { tabId: 42, spanId: "other-span" },
  ])("interrupts a recording claim when the recorder owner is $tabId / $spanId", async (owner) => {
    await seedCheckpoint({ recording: true });
    browser.sendMessage.mockResolvedValue(recorderStatus({ recording: true, ...owner }));

    const api = await startRecovery();

    expect(await api.getSession(42)).toMatchObject({
      recording: false,
      micRecording: false,
      spans: [{ spanId: "recording.1000", startOffsetMs: 1000 }],
      captureWarning: { message: expect.stringContaining("Recording stopped unexpectedly") },
    });
    expectNoProcessing();
  });

  it("retains processing when the live transcriber belongs to the recovered meeting", async () => {
    await seedCheckpoint({ state: "transcribing" });
    browser.sendMessage.mockResolvedValue(recorderStatus({ transcribingTabId: 42 }));

    const api = await startRecovery();

    expect((await api.getSession(42))?.state).toBe("transcribing");
    expectNoProcessing();
  });

  it("makes processing available for retry when another meeting owns the transcriber", async () => {
    await seedCheckpoint({ state: "transcribing" });
    browser.sendMessage.mockResolvedValue(recorderStatus({ transcribingTabId: 99 }));

    const api = await startRecovery();

    expect(await api.getSession(42)).toMatchObject({
      state: "capturing",
      captureWarning: { message: "Processing stopped unexpectedly. Retry the saved meeting." },
    });
    expectNoProcessing();
  });
});
