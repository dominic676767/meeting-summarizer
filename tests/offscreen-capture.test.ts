import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OffscreenMessage, OffscreenStatusReply } from "../src/messages";

type OffscreenListener = (message: unknown) => unknown;

const capture = vi.hoisted(() => ({
  onMessage: vi.fn<(listener: OffscreenListener) => void>(),
  sendMessage: vi.fn(),
  openStore: vi.fn(),
  append: vi.fn(),
  closeStore: vi.fn(),
  getUserMedia: vi.fn(),
  resume: vi.fn(),
  closeContext: vi.fn(),
  startRecorder: vi.fn(),
  stopRecorder: vi.fn(),
  stopTabTrack: vi.fn(),
  stopMicTrack: vi.fn(),
  events: [] as string[],
  contextState: "suspended",
  resumeState: "running",
  analyserLevel: 0.1,
  clockStalled: false,
  encoderStalled: false,
  noFinalChunk: false,
  stopNeverCompletes: false,
  recorder: undefined as TestRecorder | undefined,
  micTrack: undefined as TestTrack | undefined,
}));

vi.mock("../src/platform", () => ({
  ext: {
    runtime: {
      onMessage: { addListener: capture.onMessage },
      sendMessage: capture.sendMessage,
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  },
}));

vi.mock("../src/offscreen/audio-store", () => ({
  openAudioStore: capture.openStore,
  readSpan: vi.fn(),
  deleteSpan: vi.fn(),
}));

vi.mock("../src/transcription/factory", () => ({
  createTranscriptionProviderFor: vi.fn(),
}));

class TestRecorder {
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor() {
    capture.events.push("recorder-created");
    capture.recorder = this;
  }

  start(interval: number): void {
    capture.events.push("recorder-started");
    this.state = "recording";
    capture.startRecorder(interval);
    this.interval = setInterval(() => {
      if (!capture.encoderStalled) {
        this.ondataavailable?.({ data: new Blob(["audio chunk"]) });
      }
    }, interval);
  }

  stop(): void {
    capture.stopRecorder();
    this.state = "inactive";
    clearInterval(this.interval);
    // MediaRecorder emits its final chunk before the stop event.
    if (!capture.noFinalChunk) {
      this.ondataavailable?.({ data: new Blob(["final audio"]) });
    }
    if (!capture.stopNeverCompletes) this.onstop?.();
  }
}

interface TestTrack {
  readyState: string;
  stop: () => void;
  addEventListener: (event: string, listener: () => void) => void;
  end: () => void;
}

function testStream(stop: () => void): MediaStream {
  const endedListeners: (() => void)[] = [];
  const track: TestTrack = {
    readyState: "live",
    stop: () => {
      stop();
      track.readyState = "ended";
    },
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === "ended") endedListeners.push(listener);
    }),
    end: () => {
      track.readyState = "ended";
      for (const listener of endedListeners) listener();
    },
  };
  if (stop === capture.stopMicTrack) capture.micTrack = track;
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

class TestAudioContext {
  destination = { connect: vi.fn() };
  private createdAt = Date.now();
  get currentTime(): number {
    return capture.clockStalled ? 0.005333 : (Date.now() - this.createdAt) / 1000;
  }
  get state(): string {
    return capture.contextState;
  }

  async resume(): Promise<void> {
    capture.events.push("context-resumed");
    await capture.resume();
    capture.contextState = capture.resumeState;
  }

  close(): Promise<void> {
    return capture.closeContext();
  }

  createMediaStreamDestination() {
    return { connect: vi.fn(), stream: testStream(vi.fn()) };
  }

  createGain() {
    return { connect: vi.fn() };
  }

  createMediaStreamSource() {
    return { connect: vi.fn() };
  }

  createAnalyser() {
    return {
      fftSize: 32768,
      connect: vi.fn(),
      getFloatTimeDomainData: (samples: Float32Array) =>
        samples.fill(capture.analyserLevel),
    };
  }
}

async function send(message: OffscreenMessage): Promise<OffscreenStatusReply> {
  const listener = capture.onMessage.mock.calls[0]?.[0];
  if (!listener) throw new Error("Offscreen listener was not registered.");
  return (await listener(message)) as OffscreenStatusReply;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  for (const value of Object.values(capture)) {
    if (vi.isMockFunction(value)) value.mockReset();
  }
  capture.events.length = 0;
  capture.recorder = undefined;
  capture.micTrack = undefined;
  capture.contextState = "suspended";
  capture.resumeState = "running";
  capture.analyserLevel = 0.1;
  capture.clockStalled = false;
  capture.encoderStalled = false;
  capture.noFinalChunk = false;
  capture.stopNeverCompletes = false;
  capture.getUserMedia
    .mockResolvedValueOnce(testStream(capture.stopTabTrack))
    .mockResolvedValueOnce(testStream(capture.stopMicTrack));
  capture.resume.mockResolvedValue(undefined);
  capture.closeContext.mockResolvedValue(undefined);
  capture.append.mockImplementation(async () => {
    capture.events.push("chunk-written");
  });
  capture.closeStore.mockImplementation(async () => {
    capture.events.push("store-closed");
  });
  capture.openStore.mockImplementation(async () => {
    capture.events.push("store-opened");
    return { append: capture.append, close: capture.closeStore };
  });
  capture.sendMessage.mockResolvedValue({ ok: true });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture.getUserMedia } });
  vi.stubGlobal("AudioContext", TestAudioContext);
  vi.stubGlobal("MediaRecorder", TestRecorder);
  await import("../src/offscreen/offscreen");
});

afterEach(async () => {
  capture.stopNeverCompletes = false;
  await send({ type: "offscreen-stop" });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("offscreen audio capture", () => {
  it("reports the recording owner before and after stopping", async () => {
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });

    expect(await send({ type: "offscreen-status" })).toMatchObject({
      recording: true,
      tabId: 42,
      spanId: "zoom-span",
      transcribingTabId: null,
    });
    expect(await send({ type: "offscreen-stop", tabId: 42, spanId: "zoom-span" }))
      .toMatchObject({ recording: false, tabId: 42, spanId: "zoom-span" });
  });

  it.each([
    { tabId: 99, spanId: "zoom-span" },
    { tabId: 42, spanId: "old-span" },
  ])("ignores stop for another recorder owner $tabId / $spanId", async (owner) => {
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });

    const status = await send({ type: "offscreen-stop", ...owner });

    expect(status).toMatchObject({ recording: true, tabId: 42, spanId: "zoom-span" });
    expect(capture.stopRecorder).not.toHaveBeenCalled();
    expect(capture.stopTabTrack).not.toHaveBeenCalled();
    expect(capture.closeStore).not.toHaveBeenCalled();
  });

  it("refuses a second meeting without replacing the active recorder", async () => {
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });
    const firstRecorder = capture.recorder;

    const status = await send({
      type: "offscreen-start",
      streamId: "other-stream",
      spanId: "other-span",
      tabId: 99,
      mic: false,
    });

    expect(status).toMatchObject({
      recording: true,
      tabId: 42,
      spanId: "zoom-span",
      error: expect.stringContaining("Another meeting tab is recording"),
    });
    expect(capture.recorder).toBe(firstRecorder);
    expect(capture.startRecorder).toHaveBeenCalledOnce();
    expect(capture.stopRecorder).not.toHaveBeenCalled();
    expect(capture.openStore).toHaveBeenCalledOnce();
  });

  it("does not create another recorder for the same start request", async () => {
    const start: OffscreenMessage = {
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    };
    await send(start);

    expect(await send(start)).toMatchObject({ recording: true, tabId: 42, spanId: "zoom-span" });
    expect(capture.startRecorder).toHaveBeenCalledOnce();
    expect(capture.openStore).toHaveBeenCalledOnce();
  });

  it("waits for a pending start before stopping and flushing the final chunk", async () => {
    let releaseResume!: () => void;
    capture.resume.mockImplementation(() => new Promise<void>((resolve) => {
      releaseResume = resolve;
    }));
    const start = send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });
    const stop = send({ type: "offscreen-stop", tabId: 42, spanId: "zoom-span" });
    try {
      await vi.waitFor(() => expect(capture.resume).toHaveBeenCalledOnce());
      expect(capture.stopRecorder).not.toHaveBeenCalled();
    } finally {
      releaseResume();
    }

    expect(await start).toMatchObject({ recording: true, tabId: 42, spanId: "zoom-span" });
    expect(await stop).toMatchObject({ recording: false, tabId: 42, spanId: "zoom-span" });
    expect(capture.events.slice(-2)).toEqual(["chunk-written", "store-closed"]);
    expect(capture.stopRecorder).toHaveBeenCalledOnce();
  });

  it("resumes Web Audio before it opens the store and starts recording", async () => {
    const status = await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });

    expect(status).toEqual(expect.objectContaining({
      recording: true,
      micRecording: true,
      error: null,
    }));
    expect(capture.events).toEqual([
      "context-resumed",
      "store-opened",
      "recorder-created",
      "recorder-started",
    ]);
    expect(capture.startRecorder).toHaveBeenCalledWith(5000);
  });

  it("releases both streams if the audio context cannot resume", async () => {
    capture.resume.mockRejectedValue(new Error("Audio resume failed"));

    const status = await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });

    expect(status.recording).toBe(false);
    expect(status.error).toBe("Audio resume failed");
    expect(capture.openStore).not.toHaveBeenCalled();
    expect(capture.startRecorder).not.toHaveBeenCalled();
    expect(capture.stopTabTrack).toHaveBeenCalledOnce();
    expect(capture.stopMicTrack).toHaveBeenCalledOnce();
    expect(capture.closeContext).toHaveBeenCalledOnce();
  });

  it("refuses to record when resume leaves the context suspended", async () => {
    capture.resumeState = "suspended";

    const status = await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: false,
    });

    expect(status.recording).toBe(false);
    expect(status.error).toMatch(/audio context is not running/i);
    expect(capture.openStore).not.toHaveBeenCalled();
    expect(capture.stopTabTrack).toHaveBeenCalledOnce();
    expect(capture.closeContext).toHaveBeenCalledOnce();
  });

  it("writes the final audio chunk before closing the store", async () => {
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });

    const status = await send({ type: "offscreen-stop" });

    expect(status.recording).toBe(false);
    expect(status.encodedBytes).toBe(new Blob(["final audio"]).size);
    expect(capture.events.slice(-2)).toEqual(["chunk-written", "store-closed"]);
    expect(capture.append).toHaveBeenCalledOnce();
    expect(capture.closeStore).toHaveBeenCalledOnce();
    expect(capture.stopTabTrack).toHaveBeenCalledOnce();
    expect(capture.stopMicTrack).toHaveBeenCalledOnce();
  });

  it("keeps tab audio recording when microphone access fails", async () => {
    capture.getUserMedia.mockReset();
    capture.getUserMedia
      .mockResolvedValueOnce(testStream(capture.stopTabTrack))
      .mockRejectedValueOnce(new Error("Microphone denied"));

    const status = await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });

    expect(status).toEqual(expect.objectContaining({
      recording: true,
      micRecording: false,
      micError: "Microphone denied",
      error: null,
    }));
    expect(capture.startRecorder).toHaveBeenCalledOnce();
  });

  it("reports the first captured sound once", async () => {
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(capture.sendMessage).toHaveBeenCalledWith({
      type: "capture-signal",
      tabId: 42,
      spanId: "zoom-span",
    });
    await vi.advanceTimersByTimeAsync(1000);
    const soundEvents = capture.sendMessage.mock.calls.filter(
      ([message]) => message.type === "capture-signal",
    );
    expect(soundEvents).toHaveLength(1);
  });

  it("reports sound after an initial sustained silence warning", async () => {
    capture.analyserLevel = 0;
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(capture.sendMessage).toHaveBeenCalledWith({
      type: "capture-silent",
      tabId: 42,
      spanId: "zoom-span",
      detail: "no signal for 45s",
    });
    capture.analyserLevel = 0.1;
    await vi.advanceTimersByTimeAsync(500);

    expect(capture.sendMessage).toHaveBeenCalledWith({
      type: "capture-signal",
      tabId: 42,
      spanId: "zoom-span",
    });
    expect(await send({ type: "offscreen-status" })).toEqual(
      expect.objectContaining({ anySignal: true }),
    );
  });

  it("does not warn about initial silence during a later meeting pause", async () => {
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });
    await vi.advanceTimersByTimeAsync(500);
    capture.analyserLevel = 0;
    await vi.advanceTimersByTimeAsync(45_000);

    const silenceEvents = capture.sendMessage.mock.calls.filter(
      ([message]) => message.type === "capture-silent",
    );
    expect(silenceEvents).toHaveLength(0);
  });

  it("reports a stalled audio clock without treating stale samples as speech or silence", async () => {
    capture.clockStalled = true;
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(capture.sendMessage).toHaveBeenCalledWith({
      type: "capture-failed",
      tabId: 42,
      spanId: "zoom-span",
      detail: expect.stringContaining("audio stream stopped advancing"),
    });
    expect(capture.sendMessage.mock.calls.filter(
      ([message]) => message.type === "capture-signal" || message.type === "capture-silent",
    )).toHaveLength(0);
    expect(await send({ type: "offscreen-status" })).toMatchObject({
      anySignal: false,
      captureFailure: expect.stringContaining("audio stream stopped advancing"),
    });
  });

  it("reports a stalled encoder even when the microphone track and audio clock remain live", async () => {
    capture.encoderStalled = true;
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(capture.micTrack?.readyState).toBe("live");
    expect(await send({ type: "offscreen-status" })).toMatchObject({
      anySignal: true,
      encodedBytes: 0,
      captureFailure: "The recorder stopped producing audio data.",
    });
    expect(capture.sendMessage).toHaveBeenCalledWith({
      type: "capture-failed",
      tabId: 42,
      spanId: "zoom-span",
      detail: "The recorder stopped producing audio data.",
    });
  });

  it("reports a failed audio write and keeps that failure after stopping", async () => {
    capture.append.mockRejectedValue(new Error("Audio store is full"));
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(await send({ type: "offscreen-stop" })).toMatchObject({
      recording: false,
      captureFailure: expect.stringContaining("Audio store is full"),
    });
    expect(capture.sendMessage).toHaveBeenCalledWith({
      type: "capture-failed",
      tabId: 42,
      spanId: "zoom-span",
      detail: expect.stringContaining("Audio store is full"),
    });
  });

  it("bounds recorder shutdown when Chrome never emits the stop event", async () => {
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });
    capture.stopNeverCompletes = true;
    const stopped = send({ type: "offscreen-stop" });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await stopped).toMatchObject({
      recording: false,
      captureFailure: "The recorder did not finish saving the audio.",
    });
    expect(capture.closeStore).toHaveBeenCalledOnce();
    expect(capture.stopMicTrack).toHaveBeenCalledOnce();
  });

  it("reports an empty recording as a capture failure", async () => {
    capture.noFinalChunk = true;
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });

    expect(await send({ type: "offscreen-stop" })).toMatchObject({
      recording: false,
      encodedBytes: 0,
      captureFailure: expect.stringMatching(/no audio data|empty/i),
    });
  });

  it("reports microphone loss even when the tab recorder stays active", async () => {
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });
    capture.micTrack?.end();

    expect(await send({ type: "offscreen-status" })).toMatchObject({
      recording: true,
      micRecording: false,
    });
    expect(capture.sendMessage).toHaveBeenCalledWith({
      type: "mic-track-ended",
      tabId: 42,
      spanId: "zoom-span",
    });
  });

  it("ignores late callbacks from a previous recorder", async () => {
    await send({
      type: "offscreen-start",
      streamId: "zoom-stream",
      spanId: "zoom-span",
      tabId: 42,
      mic: true,
    });
    const oldData = capture.recorder?.ondataavailable;
    const oldError = capture.recorder?.onerror;
    const oldTrack = capture.micTrack;
    await send({ type: "offscreen-stop" });
    capture.getUserMedia.mockResolvedValueOnce(testStream(capture.stopTabTrack));
    await send({
      type: "offscreen-start",
      streamId: "new-stream",
      spanId: "new-span",
      tabId: 42,
      mic: false,
    });
    capture.sendMessage.mockClear();
    oldData?.({ data: new Blob(["late audio"]) });
    oldError?.();
    oldTrack?.end();

    expect(await send({ type: "offscreen-status" })).toMatchObject({
      spanId: "new-span",
      encodedBytes: 0,
      captureFailure: null,
    });
    expect(capture.sendMessage).not.toHaveBeenCalled();
  });
});
