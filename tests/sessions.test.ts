import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  sessionGet: vi.fn<(key: string) => Promise<Record<string, unknown>>>(),
  sessionSet: vi.fn<(values: Record<string, unknown>) => Promise<void>>(),
  localGet: vi.fn<(key: string) => Promise<Record<string, unknown>>>(),
  localSet: vi.fn<(values: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock("../src/platform", () => ({
  ext: {
    storage: {
      session: { get: storage.sessionGet, set: storage.sessionSet },
      local: { get: storage.localGet, set: storage.localSet },
    },
  },
}));

let sessionStore: Record<string, unknown>;
let localStore: Record<string, unknown>;
const checkpointKey = "meetingSessionsCheckpoint";

function read(store: Record<string, unknown>, key: string): Record<string, unknown> {
  return key in store ? { [key]: structuredClone(store[key]) } : {};
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(storage)) mock.mockReset();
  sessionStore = {};
  localStore = {};
  storage.sessionGet.mockImplementation(async (key) => read(sessionStore, key));
  storage.localGet.mockImplementation(async (key) => read(localStore, key));
  storage.sessionSet.mockImplementation(async (values) => {
    Object.assign(sessionStore, structuredClone(values));
  });
  storage.localSet.mockImplementation(async (values) => {
    Object.assign(localStore, structuredClone(values));
  });
});

async function seedSession() {
  const api = await import("../src/background/sessions");
  const session = await api.ensureSession(42, "Zoom");
  session.startedAt = 1_000;
  session.title = "Zoom recovery test";
  session.inMeeting = true;
  session.recordingId = "recording";
  session.spans = [{ spanId: "recording.1500", startOffsetMs: 1_500 }];
  session.captureWarning = { message: "First warning", detail: "First detail" };
  session.accumulator.upsert(
    { key: "caption-1", speaker: "Participant A", text: "First caption." },
    2_000,
  );
  return { api, session };
}

describe("meeting session checkpoints", () => {
  it("stores captions and audio span links in both stores", async () => {
    const { api } = await seedSession();
    await api.persistSessions();

    expect(sessionStore.sessions).toMatchObject({
      "42": {
        platform: "Zoom",
        title: "Zoom recovery test",
        startedAt: 1_000,
        spans: [{ spanId: "recording.1500", startOffsetMs: 1_500 }],
        entries: [["caption-1", { text: "First caption.", speaker: "Participant A" }]],
      },
    });
    expect(localStore[checkpointKey]).toEqual({
      version: 1,
      sessions: sessionStore.sessions,
    });
  });

  it("recovers the local checkpoint when an extension reload clears session storage", async () => {
    const { api } = await seedSession();
    await api.persistSessions();
    delete sessionStore.sessions;
    vi.resetModules();

    const recovered = await import("../src/background/sessions");
    const session = await recovered.getSession(42);
    expect(session?.spans).toEqual([{ spanId: "recording.1500", startOffsetMs: 1_500 }]);
    expect(session?.accumulator.toSegments()).toEqual([
      { speaker: "Participant A", text: "First caption.", capturedAt: 2_000 },
    ]);
    expect(recovered.isRecoveredSession(42)).toBe(true);
  });

  it("recovers the checkpoint when session storage cannot be read", async () => {
    const { api } = await seedSession();
    await api.persistSessions();
    vi.resetModules();
    storage.sessionGet.mockRejectedValue(new Error("Session storage unavailable"));

    const recovered = await import("../src/background/sessions");
    expect((await recovered.getSession(42))?.recordingId).toBe("recording");
    expect(recovered.isRecoveredSession(42)).toBe(true);
  });

  it.each([{}, { "42": { title: "Newer session" } }])(
    "uses session storage as authoritative, including an empty session map",
    async (replacement) => {
      const { api } = await seedSession();
      await api.persistSessions();
      const saved = sessionStore.sessions as Record<string, Record<string, unknown>>;
      sessionStore.sessions = "42" in replacement
        ? { "42": { ...saved["42"], ...replacement["42"] } }
        : {};
      vi.resetModules();
      storage.localGet.mockClear();

      const recovered = await import("../src/background/sessions");
      const session = await recovered.getSession(42);
      expect(session?.title).toBe("42" in replacement ? "Newer session" : undefined);
      expect(storage.localGet).not.toHaveBeenCalled();
      expect(recovered.isRecoveredSession(42)).toBe(false);
    },
  );

  it("snapshots mutable captions and spans and serializes storage writes", async () => {
    const { api, session } = await seedSession();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    storage.sessionSet.mockImplementationOnce(async (values) => {
      Object.assign(sessionStore, structuredClone(values));
      await blocked;
    });
    const first = api.persistSessions();
    await vi.waitFor(() => expect(storage.sessionSet).toHaveBeenCalledTimes(1));

    session.spans[0]!.startOffsetMs = 3_000;
    session.captureWarning!.message = "New warning";
    session.accumulator.upsert(
      { key: "caption-1", speaker: "Participant B", text: "Revised caption." },
      3_000,
    );
    const second = api.persistSessions();
    await Promise.resolve();
    expect(storage.sessionSet).toHaveBeenCalledTimes(1);
    expect(storage.sessionSet.mock.calls[0]?.[0]).toMatchObject({
      sessions: {
        "42": {
          spans: [{ startOffsetMs: 1_500 }],
          captureWarning: { message: "First warning" },
          entries: [["caption-1", { text: "First caption.", speaker: "Participant A" }]],
        },
      },
    });

    release();
    await Promise.all([first, second]);
    expect(sessionStore.sessions).toMatchObject({
      "42": {
        spans: [{ startOffsetMs: 3_000 }],
        captureWarning: { message: "New warning" },
        entries: [["caption-1", { text: "Revised caption.", speaker: "Participant B" }]],
      },
    });
    expect(localStore[checkpointKey]).toEqual({ version: 1, sessions: sessionStore.sessions });
  });

  it.each(["session", "local"] as const)(
    "continues saving when the %s store rejects one write",
    async (failedStore) => {
      const { api, session } = await seedSession();
      const failed = failedStore === "session" ? storage.sessionSet : storage.localSet;
      failed.mockRejectedValueOnce(new Error("Temporary storage failure"));
      await api.persistSessions();
      const healthy = failedStore === "session" ? localStore[checkpointKey] : sessionStore.sessions;
      expect(healthy).toBeDefined();

      session.title = "Next write succeeds";
      await api.persistSessions();
      expect(sessionStore.sessions).toMatchObject({ "42": { title: "Next write succeeds" } });
      expect(localStore[checkpointKey]).toEqual({ version: 1, sessions: sessionStore.sessions });
    },
  );

  it("clears the checkpoint and recovery marker when a session is dropped", async () => {
    const { api } = await seedSession();
    await api.persistSessions();
    delete sessionStore.sessions;
    vi.resetModules();
    const recovered = await import("../src/background/sessions");
    await recovered.getSession(42);
    expect(recovered.isRecoveredSession(42)).toBe(true);

    await recovered.dropSession(42);
    expect(recovered.isRecoveredSession(42)).toBe(false);
    expect(localStore[checkpointKey]).toEqual({ version: 1, sessions: {} });
    delete sessionStore.sessions;
    vi.resetModules();
    expect(await (await import("../src/background/sessions")).getSession(42)).toBeUndefined();
  });

  it("shares concurrent recovery reads", async () => {
    const { api } = await seedSession();
    await api.persistSessions();
    delete sessionStore.sessions;
    vi.resetModules();
    storage.sessionGet.mockClear();
    storage.localGet.mockClear();

    const recovered = await import("../src/background/sessions");
    const [first, second] = await Promise.all([
      recovered.getSession(42),
      recovered.ensureSession(42, "Zoom"),
    ]);
    expect(first).toBe(second);
    expect(first?.startedAt).toBe(1_000);
    expect(storage.sessionGet).toHaveBeenCalledTimes(1);
    expect(storage.localGet).toHaveBeenCalledTimes(1);
  });

  it("does not restore an unknown checkpoint version", async () => {
    const { api } = await seedSession();
    await api.persistSessions();
    delete sessionStore.sessions;
    const checkpoint = localStore[checkpointKey] as { version: number };
    checkpoint.version = 2;
    vi.resetModules();

    expect(await (await import("../src/background/sessions")).getSession(42)).toBeUndefined();
  });

  it("stores capture failures without classifying the recording as silence", async () => {
    const { api, session } = await seedSession();
    session.captureFailure = "The audio stream stopped advancing.";
    session.noSpeech = false;
    session.localMicrophone = false;
    await api.persistSessions();

    expect(sessionStore.sessions).toMatchObject({
      "42": {
        captureFailure: session.captureFailure,
        noSpeech: false,
        localMicrophone: false,
      },
    });
    expect(localStore[checkpointKey]).toEqual({ version: 1, sessions: sessionStore.sessions });
    const transcript = api.sessionToTranscript(session);
    expect(transcript.captureError).toBe(session.captureFailure);
    expect(transcript.localMicrophone).toBe(false);
    expect(transcript.noSpeech).not.toBe(true);
  });

  it("recovers a capture failure from the local checkpoint", async () => {
    const { api, session } = await seedSession();
    session.captureFailure = "The recorder stopped producing audio data.";
    session.noSpeech = false;
    await api.persistSessions();
    delete sessionStore.sessions;
    vi.resetModules();

    const recovered = await import("../src/background/sessions");
    const restored = await recovered.getSession(42);
    expect(restored?.captureFailure).toBe(session.captureFailure);
    expect(restored?.noSpeech).toBe(false);
    expect(recovered.sessionToTranscript(restored!).captureError).toBe(session.captureFailure);
  });

  it("restores older sessions without inventing a capture failure", async () => {
    const { api } = await seedSession();
    await api.persistSessions();
    const saved = sessionStore.sessions as Record<string, { captureFailure?: string | null }>;
    delete saved["42"]!.captureFailure;
    vi.resetModules();

    const recovered = await import("../src/background/sessions");
    const restored = await recovered.getSession(42);
    expect(restored?.captureFailure).toBeNull();
    expect(recovered.sessionToTranscript(restored!).captureError).toBeUndefined();
  });
});
