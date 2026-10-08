// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "../src/adapters/adapter";
import type { ContentMessage } from "../src/messages";
import { startContentScript } from "../src/content/runner";

const runtime = vi.hoisted(() => ({
  id: "test-extension" as string | undefined,
  invalidated: false,
  sendMessage: vi.fn<(msg: ContentMessage) => Promise<unknown>>(),
}));

vi.mock("../src/platform", () => ({
  ext: {
    runtime: {
      get id() {
        if (runtime.invalidated) throw new Error("Extension context invalidated");
        return runtime.id;
      },
      sendMessage: runtime.sendMessage,
    },
  },
}));

// A deliberately non-Teams DOM contract exercises the shared runner's boundary.
function fakeAdapter(leaveGraceMs?: number): PlatformAdapter {
  return {
    platform: "test-client",
    leaveGraceMs,
    readCaptions: vi.fn((root: ParentNode) =>
      [...root.querySelectorAll("[data-caption]")].map((element) => ({
        key: element.getAttribute("data-caption")!,
        speaker: element.querySelector("b")!.textContent!,
        text: element.querySelector("span")!.textContent!,
      }))),
    isInMeeting: vi.fn((root: ParentNode) => !!root.querySelector("[data-in-meeting]")),
    isMeetingEnded: vi.fn((root: ParentNode) => !!root.querySelector("[data-ended]")),
    meetingTitle: vi.fn((doc: Document) => doc.title || null),
  };
}

let stop: (() => void) | undefined;

function start(adapter = fakeAdapter()): PlatformAdapter {
  stop = startContentScript(adapter);
  return adapter;
}

function messages<T extends ContentMessage["type"]>(type: T): Extract<ContentMessage, { type: T }>[] {
  return runtime.sendMessage.mock.calls
    .map(([msg]) => msg)
    .filter((msg): msg is Extract<ContentMessage, { type: T }> => msg.type === type);
}

async function domTick(): Promise<void> {
  // MutationObserver delivers in a microtask; its callback queues the debounce.
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(400);
}

function mutateUnrelatedDOM(): void {
  document.body.append(document.createElement("aside"));
}

beforeEach(() => {
  vi.useFakeTimers();
  runtime.id = "test-extension";
  runtime.invalidated = false;
  runtime.sendMessage.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  document.title = "Example meeting";
  document.body.innerHTML = `
    <button data-in-meeting>Leave</button>
    <p data-caption="c1"><b>Participant A</b><span>Hello</span></p>
    <p data-caption="c2"><b>Participant B</b><span>Welcome</span></p>
  `;
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shared content-script runner", () => {
  it("sends the initial snapshots and status with adapter metadata", async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(messages("captions-update")).toEqual([{
      type: "captions-update",
      platform: "test-client",
      title: "Example meeting",
      updates: [
        { key: "c1", speaker: "Participant A", text: "Hello" },
        { key: "c2", speaker: "Participant B", text: "Welcome" },
      ],
    }]);
    expect(messages("meeting-status")).toEqual([{
      type: "meeting-status", platform: "test-client", title: "Example meeting", inMeeting: true,
    }]);
    expect(messages("meeting-ended")).toEqual([]);
  });

  it("coalesces DOM changes and sends only new or changed caption signatures", async () => {
    start();
    mutateUnrelatedDOM();
    await domTick();
    expect(messages("captions-update")).toHaveLength(1);
    expect(messages("meeting-status")).toHaveLength(1);

    document.querySelector('[data-caption="c1"] span')!.firstChild!.nodeValue = "Hello again";
    document.querySelector('[data-caption="c1"] b')!.textContent = "Participant C";
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(399);
    expect(messages("captions-update")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages("captions-update").at(-1)!.updates).toEqual([
      { key: "c1", speaker: "Participant C", text: "Hello again" },
    ]);

    document.body.insertAdjacentHTML("beforeend",
      '<p data-caption="c3"><b>Participant D</b><span>Next topic</span></p>');
    await domTick();
    expect(messages("captions-update").at(-1)!.updates).toEqual([
      { key: "c3", speaker: "Participant D", text: "Next topic" },
    ]);
    expect(messages("captions-update")).toHaveLength(3);
  });

  it.each([
    { selector: "span", value: "Hello again", speaker: "Participant A", text: "Hello again" },
    { selector: "b", value: "Participant C", speaker: "Participant C", text: "Hello" },
  ])("detects an in-place $selector change without replacing a DOM node", async ({ selector, value, speaker, text }) => {
    start();
    document.querySelector(`[data-caption="c1"] ${selector}`)!.firstChild!.nodeValue = value;
    await domTick();
    expect(messages("captions-update")).toHaveLength(2);
    expect(messages("captions-update").at(-1)!.updates).toEqual([
      { key: "c1", speaker, text },
    ]);
  });

  it.each(["reject", "throw"])("resends failed captions on the next DOM tick (%s)", async (failure) => {
    runtime.sendMessage.mockImplementationOnce(() => {
      if (failure === "throw") throw new Error("Worker unavailable");
      return Promise.reject(new Error("Worker unavailable"));
    });
    start();
    await vi.advanceTimersByTimeAsync(0);
    mutateUnrelatedDOM();
    await domTick();
    expect(messages("captions-update")).toHaveLength(2);
    expect(messages("captions-update")[1]).toEqual(messages("captions-update")[0]);

    mutateUnrelatedDOM();
    await domTick();
    expect(messages("captions-update")).toHaveLength(2);
  });

  it.each(["reject", "throw"])("retries failed captions without another DOM change (%s)", async (failure) => {
    runtime.sendMessage.mockImplementationOnce(() => {
      if (failure === "throw") throw new Error("Worker unavailable");
      return Promise.reject(new Error("Worker unavailable"));
    });
    start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(messages("captions-update")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages("captions-update")).toHaveLength(2);
    expect(messages("captions-update")[1]).toEqual(messages("captions-update")[0]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(messages("captions-update")).toHaveLength(2);
    expect(messages("meeting-status").map((msg) => msg.inMeeting)).toEqual([true]);
  });

  it("retries a failed meeting status without another DOM change", async () => {
    document.body.innerHTML = '<button data-in-meeting>Leave</button>';
    let attempts = 0;
    runtime.sendMessage.mockImplementation((msg) => {
      if (msg.type === "meeting-status" && ++attempts === 1) {
        return Promise.reject(new Error("Worker unavailable"));
      }
      return Promise.resolve();
    });
    start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(messages("meeting-status").map((msg) => msg.inMeeting)).toEqual([true, true]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(messages("meeting-status")).toHaveLength(2);
  });

  it("retains failed captions after the meeting removes their DOM elements", async () => {
    runtime.sendMessage.mockRejectedValueOnce(new Error("Worker unavailable"));
    start();
    await vi.advanceTimersByTimeAsync(0);
    const initial = messages("captions-update")[0];
    document.querySelectorAll("[data-caption]").forEach((element) => element.remove());
    document.body.insertAdjacentHTML("beforeend",
      '<p data-caption="c3"><b>Participant C</b><span>Next topic</span></p>');
    await domTick();
    expect(messages("captions-update")[1]).toEqual(initial);
    expect(messages("captions-update").at(-1)!.updates).toEqual([
      { key: "c3", speaker: "Participant C", text: "Next topic" },
    ]);
  });

  it("sends the latest queued caption text after an earlier delivery completes", async () => {
    let resolveSend!: () => void;
    runtime.sendMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    start();
    document.querySelector('[data-caption="c1"] span')!.textContent = "Hello again";
    await domTick();
    document.querySelector('[data-caption="c1"] span')!.textContent = "Hello again everyone";
    document.body.insertAdjacentHTML("beforeend",
      '<p data-caption="c3"><b>Participant C</b><span>Next topic</span></p>');
    await domTick();
    expect(messages("captions-update")).toHaveLength(1);
    expect(messages("meeting-status")).toHaveLength(0);
    resolveSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(messages("captions-update")).toHaveLength(2);
    expect(messages("captions-update").at(-1)!.updates).toEqual([
      { key: "c1", speaker: "Participant A", text: "Hello again everyone" },
      { key: "c3", speaker: "Participant C", text: "Next topic" },
    ]);
    expect(runtime.sendMessage.mock.calls.map(([msg]) => msg.type)).toEqual([
      "captions-update", "meeting-status", "captions-update",
    ]);
  });

  it("delivers the last captions before reporting the meeting end", async () => {
    let rejectSend!: (reason: Error) => void;
    runtime.sendMessage.mockImplementationOnce(() => new Promise((_, reject) => { rejectSend = reject; }));
    start();
    document.body.insertAdjacentHTML("beforeend", "<div data-ended>Host ended meeting</div>");
    await domTick();
    expect(messages("meeting-ended")).toHaveLength(0);
    rejectSend(new Error("Worker unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runtime.sendMessage.mock.calls.map(([msg]) => msg.type)).toEqual([
      "captions-update", "captions-update", "meeting-status", "meeting-ended",
    ]);
    expect(messages("captions-update")[1]).toEqual(messages("captions-update")[0]);
  });

  it("ignores an empty prejoin page until a call actually appears", async () => {
    document.body.innerHTML = "";
    start();
    mutateUnrelatedDOM();
    await domTick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    document.body.innerHTML = '<button data-in-meeting>Leave</button>';
    await domTick();
    expect(messages("meeting-status").map((msg) => msg.inMeeting)).toEqual([true]);
  });

  it("ends after ten seconds of missing controls, even if unrelated DOM keeps changing", async () => {
    start();
    document.querySelector("[data-in-meeting]")!.remove();
    await domTick();
    expect(messages("meeting-status").map((msg) => msg.inMeeting)).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(9_000);
    mutateUnrelatedDOM();
    await domTick();
    await vi.advanceTimersByTimeAsync(599);
    expect(messages("meeting-ended")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages("meeting-ended")).toEqual([{
      type: "meeting-ended", platform: "test-client", title: "Example meeting",
    }]);
  });

  it("cancels the leave grace when controls return, and starts a fresh grace on the next leave", async () => {
    start();
    document.querySelector("[data-in-meeting]")!.remove();
    await domTick();
    await vi.advanceTimersByTimeAsync(5_000);
    document.body.insertAdjacentHTML("beforeend", '<button data-in-meeting>Leave</button>');
    await domTick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages("meeting-ended")).toHaveLength(0);
    expect(messages("meeting-status").map((msg) => msg.inMeeting)).toEqual([true, false, true]);

    document.querySelector("[data-in-meeting]")!.remove();
    await domTick();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(messages("meeting-ended")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages("meeting-ended")).toHaveLength(1);
  });

  it("honors the adapter's longer leave grace", async () => {
    start(fakeAdapter(30_000));
    document.querySelector("[data-in-meeting]")!.remove();
    await domTick();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(messages("meeting-ended")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages("meeting-ended")).toHaveLength(1);
  });

  it("sends a recognized end immediately, once, even with controls still present", async () => {
    start();
    document.body.insertAdjacentHTML("beforeend", "<div data-ended>Host ended meeting</div>");
    await domTick();
    expect(messages("meeting-ended")).toHaveLength(1);
    mutateUnrelatedDOM();
    await domTick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(messages("meeting-ended")).toHaveLength(1);
  });

  it.each(["reject", "throw"])("retries Meeting End until delivery succeeds (%s)", async (failure) => {
    let attempts = 0;
    runtime.sendMessage.mockImplementation((msg) => {
      if (msg.type === "meeting-ended" && ++attempts < 3) {
        if (failure === "throw") throw new Error("Worker asleep");
        return Promise.reject(new Error("Worker asleep"));
      }
      return Promise.resolve();
    });
    document.body.innerHTML = "<div data-ended>Meeting ended</div>";
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(messages("meeting-ended")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(messages("meeting-ended")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages("meeting-ended")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(messages("meeting-ended")).toHaveLength(3);
    mutateUnrelatedDOM();
    await domTick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages("meeting-ended")).toHaveLength(3);
  });

  it.each(["missing-id", "invalidated"])("disconnects an orphan's observer and cancels its leave timer (%s)", async (orphan) => {
    const adapter = start();
    document.querySelector("[data-in-meeting]")!.remove();
    await domTick();
    if (orphan === "missing-id") runtime.id = undefined;
    else runtime.invalidated = true;
    mutateUnrelatedDOM();
    await domTick();
    expect(vi.getTimerCount()).toBe(0);
    vi.mocked(adapter.readCaptions).mockClear();
    runtime.sendMessage.mockClear();
    mutateUnrelatedDOM();
    await domTick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(adapter.readCaptions).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("stops an orphaned end retry even without another DOM mutation", async () => {
    document.body.innerHTML = "<div data-ended>Meeting ended</div>";
    runtime.sendMessage.mockRejectedValue(new Error("Worker asleep"));
    const adapter = start();
    await vi.advanceTimersByTimeAsync(0);
    runtime.invalidated = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(messages("meeting-ended")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.mocked(adapter.readCaptions).mockClear();
    mutateUnrelatedDOM();
    await domTick();
    expect(adapter.readCaptions).not.toHaveBeenCalled();
  });

  it.each(["captions-update", "meeting-status"] as const)("stops an orphaned %s retry without another DOM change", async (type) => {
    document.body.innerHTML = type === "captions-update"
      ? '<p data-caption="c1"><b>Participant A</b><span>Hello</span></p>'
      : '<button data-in-meeting>Leave</button>';
    runtime.sendMessage.mockRejectedValue(new Error("Worker unavailable"));
    const adapter = start();
    await vi.advanceTimersByTimeAsync(0);
    runtime.invalidated = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(messages(type)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.mocked(adapter.readCaptions).mockClear();
    mutateUnrelatedDOM();
    await domTick();
    expect(adapter.readCaptions).not.toHaveBeenCalled();
  });

  it("stops an orphan before reading the DOM or sending any messages", async () => {
    runtime.id = undefined;
    const adapter = start();
    mutateUnrelatedDOM();
    await domTick();
    expect(adapter.readCaptions).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start another retry if a pending send fails after cleanup", async () => {
    document.body.innerHTML = "<div data-ended>Meeting ended</div>";
    let rejectSend!: (reason: Error) => void;
    runtime.sendMessage.mockImplementation(() => new Promise((_, reject) => { rejectSend = reject; }));
    start();
    stop!();
    rejectSend(new Error("Worker asleep"));
    await vi.advanceTimersByTimeAsync(0);
    mutateUnrelatedDOM();
    await domTick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(messages("meeting-ended")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
