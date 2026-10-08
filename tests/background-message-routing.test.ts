import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, OffscreenMessage, OffscreenStatusReply } from "../src/messages";
import type { SessionState } from "../src/background/sessions";
import {
  MIC_REVOKED_WARNING,
  NO_SOUND_MESSAGE,
  silenceWarning,
} from "../src/background/capture-signal";

type RuntimeListener = (
  message: unknown,
  sender: { tab?: { id: number } },
) => unknown;

const pipeline = vi.hoisted(() => ({
  summarize: vi.fn(),
  write: vi.fn(),
  client: vi.fn(),
}));

const browser = vi.hoisted(() => ({
  onMessage: vi.fn<(listener: RuntimeListener) => void>(),
  onStartup: vi.fn(),
  onInstalled: vi.fn(),
  onCommand: vi.fn(),
  onUpdated: vi.fn(),
  onRemoved: vi.fn(),
  sessionGet: vi.fn(),
  sessionSet: vi.fn(),
  localGet: vi.fn(),
  localSet: vi.fn(),
  query: vi.fn(),
  sendMessage: vi.fn(),
  hasDocument: vi.fn(),
  createDocument: vi.fn(),
  closeDocument: vi.fn(),
  getMediaStreamId: vi.fn(),
  setBadgeText: vi.fn(),
  setBadgeBackgroundColor: vi.fn(),
  setTitle: vi.fn(),
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
    commands: {
      onCommand: { addListener: browser.onCommand },
      getAll: async () => [],
    },
    tabs: {
      onUpdated: { addListener: browser.onUpdated },
      onRemoved: { addListener: browser.onRemoved },
      query: browser.query,
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
    offscreen: {
      hasDocument: browser.hasDocument,
      createDocument: browser.createDocument,
      closeDocument: browser.closeDocument,
    },
    tabCapture: { getMediaStreamId: browser.getMediaStreamId },
  },
}));

vi.mock("../src/providers/factory", () => ({
  createProviderClient: pipeline.client,
}));
vi.mock("../src/pipeline/pipeline", () => ({
  summarizeTranscript: pipeline.summarize,
}));
vi.mock("../src/background/artifact-writer", () => ({
  writeArtifact: pipeline.write,
}));

async function loadListener(): Promise<RuntimeListener> {
  await import("../src/background/background");
  const listener = browser.onMessage.mock.calls[0]?.[0];
  if (!listener) throw new Error("Background listener was not registered.");
  return listener;
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
    captureFailure: null,
    micRecording: false,
    micError: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(browser)) mock.mockReset();
  browser.sessionGet.mockResolvedValue({});
  browser.sessionSet.mockResolvedValue(undefined);
  browser.localGet.mockResolvedValue({});
  browser.localSet.mockResolvedValue(undefined);
  browser.query.mockResolvedValue([{ id: 42 }]);
  browser.sendMessage.mockResolvedValue(recorderStatus());
  browser.hasDocument.mockResolvedValue(true);
  browser.createDocument.mockResolvedValue(undefined);
  browser.closeDocument.mockResolvedValue(undefined);
  browser.getMediaStreamId.mockResolvedValue("zoom-stream");
  browser.setBadgeText.mockResolvedValue(undefined);
  browser.setBadgeBackgroundColor.mockResolvedValue(undefined);
  browser.setTitle.mockResolvedValue(undefined);
  pipeline.summarize.mockReset();
  pipeline.write.mockReset();
  pipeline.client.mockReset();
  pipeline.summarize.mockResolvedValue({ html: "<p>Saved captions.</p>" });
  pipeline.write.mockResolvedValue(undefined);
  pipeline.client.mockReturnValue({});
});

function useLocalStore() {
  const store: Record<string, unknown> = {};
  browser.localGet.mockImplementation(async (key: string) =>
    key in store ? { [key]: structuredClone(store[key]) } : {},
  );
  browser.localSet.mockImplementation(async (values: Record<string, unknown>) => {
    Object.assign(store, structuredClone(values));
  });
  return store;
}

describe("meeting status after Zoom completion", () => {
  async function seedMeeting(state: SessionState = "capturing", captions = true) {
    const listener = await loadListener();
    const { ensureSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "Zoom");
    session.startedAt = 2_000;
    session.inMeeting = true;
    session.state = state;
    if (captions) {
      session.accumulator.upsert(
        { key: "caption-1", speaker: "Participant A", text: "Send the report on Monday." },
        3_000,
      );
    }
    return { listener, session };
  }

  it("clears meeting status when Zoom End produces a report", async () => {
    const store = useLocalStore();
    const { listener, session } = await seedMeeting();

    await listener({ type: "meeting-ended", platform: "Zoom", title: null }, { tab: { id: 42 } });

    expect(session).toMatchObject({ state: "done", inMeeting: false });
    expect(pipeline.write).toHaveBeenCalledTimes(1);
    expect(store.meetingSessionsCheckpoint).toMatchObject({
      sessions: { "42": { state: "done", inMeeting: false } },
    });
    expect(browser.setBadgeText).toHaveBeenLastCalledWith({ tabId: 42, text: "" });
    expect(browser.setTitle).toHaveBeenLastCalledWith({
      tabId: 42, title: "Meeting Summarizer — no meeting detected.",
    });
  });

  it("finishes captured captions when Zoom navigates home", async () => {
    const { session } = await seedMeeting();
    const onUpdated = browser.onUpdated.mock.calls[0]![0];

    onUpdated(42, { url: "https://app.zoom.us/wc/home" });

    await vi.waitFor(() => expect(session).toMatchObject({ state: "done", inMeeting: false }));
    expect(pipeline.write).toHaveBeenCalledTimes(1);
  });

  it.each(["done", "failed", "transcribing", "summarizing", "capturing"] as const)(
    "clears %s status on navigation without starting another report",
    async (state) => {
      const store = useLocalStore();
      const { session } = await seedMeeting(state, false);
      const onUpdated = browser.onUpdated.mock.calls[0]![0];

      onUpdated(42, { url: "https://app.zoom.us/wc/home" });

      await vi.waitFor(() => expect(store.meetingSessionsCheckpoint).toMatchObject({
        sessions: { "42": { inMeeting: false } },
      }));
      expect(session).toMatchObject({ state, inMeeting: false });
      expect(pipeline.summarize).not.toHaveBeenCalled();
      expect(pipeline.write).not.toHaveBeenCalled();
    },
  );

  it("keeps meeting status when a manual summary runs inside the meeting", async () => {
    const { listener, session } = await seedMeeting();

    await listener({ type: "summarize-now", tabId: 42 }, {});

    expect(session).toMatchObject({ state: "done", inMeeting: true });
    expect(pipeline.write).toHaveBeenCalledTimes(1);
  });

  it("clears status during processing without duplicating the report", async () => {
    const { listener, session } = await seedMeeting();
    let completeSummary!: (value: { html: string }) => void;
    pipeline.summarize.mockReturnValue(new Promise((resolve) => { completeSummary = resolve; }));
    const manual = listener({ type: "summarize-now", tabId: 42 }, {});
    await vi.waitFor(() => expect(pipeline.summarize).toHaveBeenCalledTimes(1));

    await listener({ type: "meeting-ended", platform: "Zoom", title: null }, { tab: { id: 42 } });
    browser.onUpdated.mock.calls[0]![0](42, { url: "https://app.zoom.us/wc/home" });
    await vi.waitFor(() => expect(session.inMeeting).toBe(false));
    completeSummary({ html: "<p>Saved report.</p>" });
    await manual;

    expect(session).toMatchObject({ state: "done", inMeeting: false });
    expect(pipeline.summarize).toHaveBeenCalledTimes(1);
    expect(pipeline.write).toHaveBeenCalledTimes(1);
  });

  it("keeps meeting status when the URL still belongs to a Zoom meeting", async () => {
    const { session } = await seedMeeting("done", false);

    browser.onUpdated.mock.calls[0]![0](42, { url: "https://app.zoom.us/wc/123456789/join" });

    expect(session.inMeeting).toBe(true);
    expect(pipeline.write).not.toHaveBeenCalled();
  });
});

describe("background runtime message routing", () => {
  const offscreenRequests: OffscreenMessage[] = [
    { type: "offscreen-status" },
    { type: "offscreen-start", streamId: "stream", spanId: "span", tabId: 42, mic: true },
    { type: "offscreen-stop" },
    { type: "offscreen-mic-permission" },
    { type: "offscreen-cancel-transcribe" },
    { type: "offscreen-discard-spans", spanIds: ["span"] },
    {
      type: "offscreen-transcribe",
      spans: [],
      transcription: {
        provider: "local-whisper",
        language: "en",
        localWhisper: { model: "base" },
        openai: { apiKey: "", model: "whisper-1" },
      },
      tabId: 42,
    },
  ];

  it.each(offscreenRequests)(
    "leaves $type for the offscreen listener when the sender has a tab",
    async (message) => {
      const listener = await loadListener();

      // A Promise that resolves to undefined still claims a Chrome message
      // response. The worker must return literal undefined here.
      expect(listener(message, { tab: { id: 42 } })).toBeUndefined();
      expect(browser.sessionGet).not.toHaveBeenCalled();
    },
  );

  it("does not claim an unknown tab message", async () => {
    const listener = await loadListener();
    expect(listener({ type: "unknown" }, { tab: { id: 42 } })).toBeUndefined();
  });

  it("still receives meeting status and caption messages from a meeting tab", async () => {
    const listener = await loadListener();
    const { getSession } = await import("../src/background/sessions");
    const status: Message = {
      type: "meeting-status",
      platform: "zoom",
      title: "Live Zoom test",
      inMeeting: true,
    };
    const captions: Message = {
      type: "captions-update",
      platform: "zoom",
      title: "Updated Zoom title",
      updates: [],
    };

    await listener(status, { tab: { id: 42 } });
    expect((await getSession(42))?.inMeeting).toBe(true);
    await listener(captions, { tab: { id: 42 } });

    expect((await getSession(42))?.title).toBe("Updated Zoom title");
    expect(browser.sessionSet).toHaveBeenCalled();
  });

  it("still returns popup status when the popup is open in a tab", async () => {
    const listener = await loadListener();
    await listener(
      { type: "meeting-status", platform: "zoom", title: "Live Zoom test", inMeeting: true },
      { tab: { id: 42 } },
    );
    const result = await listener({ type: "get-status" }, { tab: { id: 99 } });

    expect(result).toEqual(expect.objectContaining({ title: "Live Zoom test", inMeeting: true }));
    expect(browser.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it("keeps popup commands on their original meeting when another tab is active", async () => {
    const listener = await loadListener();
    await listener(
      { type: "meeting-status", platform: "zoom", title: "Original meeting", inMeeting: true },
      { tab: { id: 42 } },
    );
    browser.query.mockResolvedValue([{ id: 99 }]);

    const result = await listener({ type: "get-status", tabId: 42 }, { tab: { id: 99 } });

    expect(result).toEqual(expect.objectContaining({ title: "Original meeting", inMeeting: true }));
    expect(browser.query).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5])("does not use the active tab for an invalid popup tab id %s", async (tabId) => {
    const listener = await loadListener();

    const result = await listener({ type: "get-status", tabId }, { tab: { id: 99 } });

    expect(result).toEqual(expect.objectContaining({ state: "idle" }));
    expect(browser.query).not.toHaveBeenCalled();
    expect(browser.sendMessage).not.toHaveBeenCalled();
  });

  it("does not adopt another meeting's live recorder status", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    session.recording = true;
    session.recordingId = "recording";
    session.spans = [{ spanId: "recording.1000", startOffsetMs: 1000 }];
    session.hadAnySignal = false;
    browser.sendMessage.mockResolvedValue(recorderStatus({
      recording: true,
      tabId: 99,
      spanId: "other-recording",
      anySignal: true,
      micRecording: true,
    }));

    await listener({ type: "get-status", tabId: 42 }, { tab: { id: 99 } });

    expect(await getSession(42)).toMatchObject({
      recording: false,
      micRecording: false,
      hadAnySignal: false,
      spans: [{ spanId: "recording.1000", startOffsetMs: 1000 }],
      captureWarning: { message: expect.stringContaining("Recording stopped unexpectedly") },
    });
  });

  it.each(["Another meeting tab is recording.", null])(
    "shows the recorder conflict without changing the active meeting (error: %s)",
    async (error) => {
      const listener = await loadListener();
      const { ensureSession, getSession } = await import("../src/background/sessions");
      await ensureSession(42, "zoom");
      const activeSession = await ensureSession(99, "zoom");
      activeSession.recording = true;
      activeSession.micRecording = true;
      activeSession.recordingId = "other-recording";
      activeSession.spans = [{ spanId: "other-recording.0", startOffsetMs: 0 }];
      browser.sendMessage.mockResolvedValue(recorderStatus({
        recording: true,
        tabId: 99,
        spanId: "other-recording.0",
        anySignal: true,
        micRecording: true,
        error,
      }));

      await listener({ type: "start-capture", tabId: 42 }, { tab: { id: 99 } });

      expect(browser.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 42 });
      expect(await getSession(42)).toMatchObject({
        recording: false,
        micRecording: false,
        hadAnySignal: null,
        spans: [],
        captureWarning: { message: expect.stringContaining("Another meeting tab is recording") },
      });
      expect(await getSession(99)).toMatchObject({
        recording: true,
        micRecording: true,
        recordingId: "other-recording",
        spans: [{ spanId: "other-recording.0", startOffsetMs: 0 }],
      });
      expect(browser.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "offscreen-stop" }),
      );
      expect(browser.query).not.toHaveBeenCalled();
    },
  );

  it("keeps the retry message for a failed stream start", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    await ensureSession(42, "zoom");
    browser.sendMessage.mockResolvedValue(recorderStatus({
      error: "Could not start the tab audio stream.",
    }));

    await listener({ type: "start-capture", tabId: 42 }, {});

    expect(await getSession(42)).toMatchObject({
      recording: false,
      spans: [],
      captureWarning: {
        message: "Recording could not start. Try the toolbar icon or the shortcut again.",
        detail: "Could not start the tab audio stream.",
      },
    });
  });

  it("scopes stop to its meeting and span and keeps another recorder open", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    session.recording = true;
    session.recordingId = "recording";
    session.spans = [{ spanId: "recording.1000", startOffsetMs: 1000 }];
    browser.sendMessage.mockImplementation(async (message: OffscreenMessage) =>
      message.type === "offscreen-stop"
        ? recorderStatus({ tabId: 42, spanId: "recording.1000", anySignal: true })
        : recorderStatus({ recording: true, tabId: 99, spanId: "other-recording" }),
    );

    await listener({ type: "stop-capture", tabId: 42 }, { tab: { id: 99 } });

    expect(browser.sendMessage).toHaveBeenCalledWith({
      type: "offscreen-stop",
      tabId: 42,
      spanId: "recording.1000",
    });
    expect(browser.closeDocument).not.toHaveBeenCalled();
    expect(await getSession(42)).toMatchObject({ recording: false, hadAnySignal: true });
    expect(browser.query).not.toHaveBeenCalled();
  });

  it("coalesces two starts while stream access is pending", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    await ensureSession(42, "zoom");
    let releaseStream!: (streamId: string) => void;
    browser.getMediaStreamId.mockImplementation(() => new Promise<string>((resolve) => {
      releaseStream = resolve;
    }));
    let currentRecorderStatus = recorderStatus();
    browser.sendMessage.mockImplementation(async (message: OffscreenMessage) => {
      if (message.type === "offscreen-start") {
        currentRecorderStatus = recorderStatus({
          recording: true,
          tabId: message.tabId,
          spanId: message.spanId,
          startedAt: 1000,
        });
      }
      return currentRecorderStatus;
    });

    const first = listener({ type: "start-capture", tabId: 42 }, {});
    const second = listener({ type: "start-capture", tabId: 42 }, {});
    await vi.waitFor(() => expect(browser.getMediaStreamId).toHaveBeenCalledOnce());
    releaseStream("zoom-stream");
    await Promise.all([first, second]);

    const starts = browser.sendMessage.mock.calls.filter(
      ([message]) => message.type === "offscreen-start",
    );
    expect(starts).toHaveLength(1);
    expect((await getSession(42))?.spans).toHaveLength(1);
    expect((await getSession(42))?.recording).toBe(true);
  });

  it("still routes offscreen progress events with a tab sender", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    await ensureSession(42, "zoom");
    const progress = {
      phase: "transcribing" as const,
      loadedBytes: null,
      totalBytes: null,
      processedMs: 1000,
      totalMs: 2000,
      startedAt: 1234,
    };

    expect(
      await listener(
        { type: "transcription-progress", tabId: 42, progress },
        { tab: { id: 99 } },
      ),
    ).toEqual({ ok: true });
    expect((await getSession(42))?.transcription).toEqual(progress);
  });

  it("clears the initial silence warning when recording receives sound", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    session.recording = true;
    session.captureWarning = silenceWarning(null, "no signal for 45s");
    expect(session.captureWarning.message).toBe(NO_SOUND_MESSAGE);
    browser.sessionSet.mockClear();

    expect(
      await listener(
        { type: "capture-signal", tabId: 42 },
        { tab: { id: 99 } },
      ),
    ).toEqual({ ok: true });
    expect((await getSession(42))?.hadAnySignal).toBe(true);
    expect((await getSession(42))?.captureWarning).toBeNull();
    expect(browser.sessionSet).toHaveBeenCalled();
  });

  it("preserves a failed microphone warning when tab sound arrives", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    session.recording = true;
    session.captureWarning = MIC_REVOKED_WARNING;

    await listener(
      { type: "capture-signal", tabId: 42 },
      { tab: { id: 99 } },
    );

    expect((await getSession(42))?.hadAnySignal).toBe(true);
    expect((await getSession(42))?.captureWarning).toEqual(MIC_REVOKED_WARNING);
  });

  it("shows microphone loss on the badge without opening the popup or stopping tab capture", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    session.recording = true;
    session.micRecording = true;
    session.localMicrophone = true;
    session.spans = [{ spanId: "recording.1000", startOffsetMs: 1000 }];
    browser.sessionSet.mockClear();
    browser.sendMessage.mockClear();

    expect(await listener(
      { type: "mic-track-ended", tabId: 42, spanId: "recording.1000" },
      {},
    )).toEqual({ ok: true });

    expect(await getSession(42)).toMatchObject({
      recording: true,
      micRecording: false,
      localMicrophone: false,
      micError: MIC_REVOKED_WARNING.detail,
      captureWarning: MIC_REVOKED_WARNING,
    });
    expect(browser.setBadgeText).toHaveBeenCalledWith({ text: "REC!", tabId: 42 });
    expect(browser.setTitle).toHaveBeenCalledWith({
      title: expect.stringContaining(MIC_REVOKED_WARNING.message),
      tabId: 42,
    });
    expect(browser.sessionSet).toHaveBeenCalled();
    expect(browser.sendMessage).not.toHaveBeenCalled();
  });

  it("accepts a retried microphone-loss event once capture startup is recorded", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    const event = { type: "mic-track-ended", tabId: 42, spanId: "recording.1000" };
    browser.sessionSet.mockClear();

    expect(await listener(event, {})).toEqual({ ok: false });
    expect(browser.sessionSet).not.toHaveBeenCalled();

    session.recording = true;
    session.micRecording = true;
    session.localMicrophone = true;
    session.spans = [{ spanId: "recording.1000", startOffsetMs: 1000 }];

    expect(await listener(event, {})).toEqual({ ok: true });
    expect((await getSession(42))?.captureWarning).toEqual(MIC_REVOKED_WARNING);
    expect(browser.setBadgeText).toHaveBeenCalledWith({ text: "REC!", tabId: 42 });
  });

  it("ignores a sound event after recording has stopped", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    session.recording = false;
    session.hadAnySignal = false;
    session.captureWarning = silenceWarning(null, "no signal for 45s");
    browser.sessionSet.mockClear();

    await listener(
      { type: "capture-signal", tabId: 42 },
      { tab: { id: 99 } },
    );

    expect((await getSession(42))?.hadAnySignal).toBe(false);
    expect((await getSession(42))?.captureWarning?.message).toBe(NO_SOUND_MESSAGE);
    expect(browser.sessionSet).not.toHaveBeenCalled();
  });

  it("does not show the initial silence warning after sound was captured", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    session.recording = true;
    session.hadAnySignal = true;
    session.captureWarning = null;
    browser.sessionSet.mockClear();

    await listener(
      { type: "capture-silent", tabId: 42, detail: "no signal for 45s" },
      { tab: { id: 99 } },
    );

    expect((await getSession(42))?.captureWarning).toBeNull();
    expect(browser.sessionSet).not.toHaveBeenCalled();
  });

  it.each([
    { type: "capture-failed", detail: "Old fault." },
    { type: "capture-signal" },
    { type: "mic-track-ended" },
  ])("ignores $type from an older capture span", async (event) => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    session.recording = true;
    session.recordingId = "recording";
    session.spans = [{ spanId: "recording.new", startOffsetMs: 1000 }];
    session.localMicrophone = true;
    session.hadAnySignal = false;
    browser.sessionSet.mockClear();
    browser.sendMessage.mockClear();

    expect(await listener(
      { ...event, tabId: 42, spanId: "recording.old" },
      { tab: { id: 99 } },
    )).toEqual({ ok: event.type !== "mic-track-ended" });

    const updated = await getSession(42);
    expect(updated?.captureFailure).toBeNull();
    expect(updated?.hadAnySignal).toBe(false);
    expect(updated?.localMicrophone).toBe(true);
    expect(updated?.recording).toBe(true);
    expect(browser.sessionSet).not.toHaveBeenCalled();
    expect(browser.sendMessage).not.toHaveBeenCalled();
  });

  it("stops a failed capture and preserves its failure even if the analyser reported sound", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    session.recording = true;
    session.recordingId = "recording";
    session.spans = [{ spanId: "recording.1000", startOffsetMs: 1000 }];
    session.micRecording = true;
    session.localMicrophone = true;
    session.noSpeech = true;
    browser.sendMessage.mockResolvedValue(
      recorderStatus({
        tabId: 42,
        spanId: "recording.1000",
        anySignal: true,
        captureFailure: "The audio clock stopped.",
      }),
    );

    await listener(
      {
        type: "capture-failed",
        tabId: 42,
        spanId: "recording.1000",
        detail: "The audio clock stopped.",
      },
      {},
    );

    const updated = await getSession(42);
    expect(updated?.captureFailure).toBe("The audio clock stopped.");
    expect(updated?.captureWarning?.message).toContain("Saved audio is kept for recovery.");
    expect(updated?.noSpeech).toBe(false);
    expect(updated?.localMicrophone).toBe(false);
    expect(updated?.micRecording).toBe(false);
    expect(updated?.recording).toBe(false);
    expect(browser.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "offscreen-stop" }),
    );
    expect(browser.sessionSet).toHaveBeenCalled();
  });

  it("stops a capture when the popup status reports an encoder failure", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    session.recording = true;
    session.recordingId = "recording";
    session.spans = [{ spanId: "recording.1000", startOffsetMs: 1000 }];
    session.localMicrophone = true;
    browser.sendMessage.mockResolvedValue(
      recorderStatus({
        recording: true,
        tabId: 42,
        spanId: "recording.1000",
        anySignal: true,
        micRecording: true,
        captureFailure: "The recorder stopped producing audio data.",
      }),
    );

    await listener({ type: "get-status", tabId: 42 }, {});

    const updated = await getSession(42);
    expect(updated?.captureFailure).toBe("The recorder stopped producing audio data.");
    expect(updated?.captureWarning?.message).toContain("Saved audio is kept for recovery.");
    expect(updated?.noSpeech).toBe(false);
    expect(updated?.localMicrophone).toBe(false);
    expect(updated?.recording).toBe(false);
    expect(browser.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "offscreen-stop" }),
    );
  });

  it("does not classify an unverifiable stop as silence", async () => {
    const listener = await loadListener();
    const { ensureSession, getSession } = await import("../src/background/sessions");
    const session = await ensureSession(42, "zoom");
    session.recording = true;
    session.recordingId = "recording";
    session.spans = [{ spanId: "recording.1000", startOffsetMs: 1000 }];
    session.localMicrophone = true;
    browser.sendMessage.mockRejectedValue(new Error("Recorder unavailable."));

    await listener({ type: "stop-capture", tabId: 42 }, {});

    const updated = await getSession(42);
    expect(updated?.captureFailure).toBe(
      "The recorder stopped before its audio could be verified.",
    );
    expect(updated?.hadAnySignal).toBeNull();
    expect(updated?.noSpeech).toBe(false);
    expect(updated?.localMicrophone).toBe(false);
    expect(updated?.recording).toBe(false);
  });

  it("summarizes saved captions with a capture warning and keeps failed audio for recovery", async () => {
    useLocalStore();
    const listener = await loadListener();
    const { ensureSession } = await import("../src/background/sessions");
    const { getHeldRecording } = await import("../src/background/held-recordings");
    const session = await ensureSession(42, "zoom");
    session.recordingId = "recording";
    session.spans = [{ spanId: "recording.1000", startOffsetMs: 1000 }];
    session.captureFailure = "The audio clock stopped.";
    session.hadAnySignal = false;
    session.localMicrophone = true;
    session.accumulator.upsert(
      {
        key: "caption1",
        speaker: "Participant A",
        text: "My marker is silver lantern six.",
      },
      Date.now(),
    );

    await listener({ type: "summarize-now", tabId: 42 }, {});

    expect(pipeline.summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        captureError: "The audio clock stopped.",
        noSpeech: false,
        localMicrophone: false,
        segments: expect.arrayContaining([
          expect.objectContaining({ text: "My marker is silver lantern six." }),
        ]),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(pipeline.write).toHaveBeenCalled();
    const held = await getHeldRecording("recording");
    expect(held?.reason).toBe("The audio clock stopped.");
    expect(held?.spans).toEqual([{ spanId: "recording.1000", startOffsetMs: 1000 }]);
    expect(held?.transcript.captureError).toBe("The audio clock stopped.");
    expect(browser.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "offscreen-transcribe" }),
    );
    expect(browser.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "offscreen-discard-spans" }),
    );
  });

  it("keeps failed audio when a retry returns no speech", async () => {
    useLocalStore();
    const listener = await loadListener();
    const { ensureSession, sessionToTranscript } = await import("../src/background/sessions");
    const { holdRecording, getHeldRecording } = await import("../src/background/held-recordings");
    const session = await ensureSession(42, "zoom");
    session.captureFailure = "The audio clock stopped.";
    await holdRecording(
      {
        recordingId: "recording",
        transcript: sessionToTranscript(session),
        spans: [{ spanId: "recording.1000", startOffsetMs: 1000 }],
      },
      "The audio clock stopped.",
    );
    browser.sendMessage.mockResolvedValue({
      utterances: [],
      cancelled: false,
      noSpeech: "No speech detected.",
      error: null,
    });

    const result = await listener(
      { type: "retry-held-recording", recordingId: "recording" },
      {},
    );

    expect(result).toEqual({
      ok: false,
      error: "The saved recording is incomplete. A result with no speech cannot verify the failed audio capture.",
    });
    expect((await getHeldRecording("recording"))?.reason).toContain("incomplete");
    expect(pipeline.summarize).not.toHaveBeenCalled();
    expect(pipeline.write).not.toHaveBeenCalled();
    expect(browser.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "offscreen-discard-spans" }),
    );
  });
});
