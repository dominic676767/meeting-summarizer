// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureStateReply } from "../src/messages";

const { runtime, storage } = vi.hoisted(() => ({
  runtime: { id: "test-extension" as string | undefined, sendMessage: vi.fn() },
  storage: { get: vi.fn(), set: vi.fn() },
}));
vi.mock("../src/platform", () => ({ ext: { runtime, storage: { local: storage } } }));

const now = new Date("2026-10-09T12:00:00Z");
let reply: CaptureStateReply;
let stop: () => void;
let mount: () => () => void;
let host: HTMLElement;
let root: ShadowRoot;
let row: HTMLElement;
let handle: HTMLButtonElement;
let observedResize: ResizeObserverCallback;
let disconnect: ReturnType<typeof vi.fn>;
let width: number;
let height: number;
let captured: Set<number>;

function position(): { left: number; top: number } {
  return {
    left: Number.parseFloat(host.style.left) || 0,
    top: host.style.top === "auto" || host.style.top === ""
      ? window.innerHeight - height - 16
      : Number.parseFloat(host.style.top),
  };
}

function wireGeometry(): void {
  host = document.getElementById("meeting-summarizer-capture-prompt")!;
  root = host.shadowRoot!;
  row = root.querySelector(".row")!;
  handle = root.querySelector(".move")!;
  vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => {
    const { left, top } = position();
    return new DOMRect(left, top, width, height);
  });
  captured = new Set();
  row.setPointerCapture = vi.fn((id) => { captured.add(id); });
  row.hasPointerCapture = vi.fn((id) => captured.has(id));
  row.releasePointerCapture = vi.fn((id) => { captured.delete(id); });
}

/** jsdom has no PointerEvent, so supply its pointer-specific fields explicitly. */
function pointer(type: string, x: number, y: number, overrides: Record<string, unknown> = {}): void {
  const event = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    isPrimary: { value: true },
    ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value }])),
  });
  row.dispatchEvent(event);
}

function drag(dx: number, dy: number): void {
  const { left, top } = position();
  pointer("pointerdown", left + 20, top + 20);
  pointer("pointermove", left + 20 + dx, top + 20 + dy);
  pointer("pointerup", left + 20 + dx, top + 20 + dy);
}

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 700);
  disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { observedResize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  width = 320;
  height = 54;
  reply = {
    state: "recording", title: "Test meeting", recording: true,
    recordingStartedAt: now.getTime() - 34_000, dismissed: false,
    shortcut: "Command+Shift+U", mic: "recording",
  };
  runtime.id = "test-extension";
  runtime.sendMessage.mockReset().mockImplementation(async () => reply);
  storage.get.mockReset().mockResolvedValue({});
  storage.set.mockReset().mockResolvedValue(undefined);
  ({ mountPrompt: mount } = await import("../src/content/capture-prompt"));
  stop = mount();
  wireGeometry();
  await tick();
  storage.set.mockClear();
});

afterEach(() => {
  stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("movable in-page recording status", () => {
  it("drags without jumping, saves on release, and keeps the position as the timer updates", async () => {
    pointer("pointerdown", 36, 650);
    expect(position()).toEqual({ left: 16, top: 630 });
    pointer("pointermove", 336, 350);
    expect(position()).toEqual({ left: 316, top: 330 });
    expect(storage.set).not.toHaveBeenCalled();
    pointer("pointerup", 336, 350);
    expect(storage.set).toHaveBeenCalledOnce();
    expect(captured.size).toBe(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(root.querySelector(".label")!.textContent).toContain("0:36");
    expect(position()).toEqual({ left: 316, top: 330 });
    expect(runtime.sendMessage.mock.calls.every(([message]) => message.type === "get-capture-state")).toBe(true);
  });

  it("keeps the whole card inside every edge", () => {
    drag(5000, -5000);
    expect(position()).toEqual({ left: 664, top: 16 });
    drag(-5000, 5000);
    expect(position()).toEqual({ left: 16, top: 630 });
  });

  it("keeps a chosen corner visible after window and card size changes", () => {
    drag(5000, 0);
    vi.stubGlobal("innerWidth", 500);
    vi.stubGlobal("innerHeight", 400);
    window.dispatchEvent(new Event("resize"));
    expect(position()).toEqual({ left: 164, top: 330 });

    height = 210;
    observedResize([], {} as ResizeObserver);
    expect(position()).toEqual({ left: 164, top: 174 });
  });

  it("does not turn a small click movement into a drag", () => {
    pointer("pointerdown", 36, 650);
    pointer("pointermove", 38, 651);
    pointer("pointerup", 38, 651);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(position()).toEqual({ left: 16, top: 630 });
    expect(storage.set).not.toHaveBeenCalled();
    expect(handle.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not open movement controls after a drag", () => {
    drag(150, -100);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(handle.getAttribute("aria-expanded")).toBe("false");
    expect((root.querySelector(".move-controls") as HTMLElement).hidden).toBe(true);
  });

  it("moves with focused arrow keys and click controls", () => {
    handle.focus();
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true, cancelable: true }));
    expect(position()).toEqual({ left: 26, top: 590 });

    handle.click();
    (root.querySelector('[data-direction="ArrowUp"]') as HTMLButtonElement).click();
    expect(position()).toEqual({ left: 26, top: 580 });
    expect(handle.getAttribute("aria-expanded")).toBe("true");
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(handle.getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["pointercancel", "Escape"])("restores the start position when a drag is cancelled with %s", (action) => {
    pointer("pointerdown", 36, 650);
    pointer("pointermove", 400, 250);
    if (action === "Escape") {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    } else {
      pointer(action, 400, 250);
    }
    expect(position()).toEqual({ left: 16, top: 630 });
    expect(captured.size).toBe(0);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("ignores other pointers and non-primary mouse buttons", () => {
    pointer("pointerdown", 36, 650, { button: 2 });
    pointer("pointermove", 400, 200);
    expect(position()).toEqual({ left: 16, top: 630 });
    pointer("pointerdown", 36, 650);
    pointer("pointermove", 400, 200, { pointerId: 2 });
    pointer("pointerup", 400, 200, { pointerId: 2 });
    expect(position()).toEqual({ left: 16, top: 630 });
    expect(captured.has(1)).toBe(true);
    pointer("pointercancel", 36, 650);
  });

  it("restores the saved position on a new mount", async () => {
    drag(300, -300);
    const saved = storage.set.mock.calls[0]![0];
    storage.get.mockResolvedValue(saved);
    stop();
    stop = mount();
    wireGeometry();
    await tick();
    expect(position()).toEqual({ left: 316, top: 330 });
  });

  it("does not let a late storage read overwrite a new drag", async () => {
    let resolve!: (value: object) => void;
    storage.get.mockReturnValue(new Promise((done) => { resolve = done; }));
    stop();
    stop = mount();
    wireGeometry();
    await tick();
    drag(200, -200);
    resolve({ capturePromptPosition: { x: 1, y: 0 } });
    await tick();
    expect(position()).toEqual({ left: 216, top: 430 });
  });

  it("keeps dragging usable when saving the position fails", async () => {
    storage.set.mockRejectedValue(new Error("Storage unavailable"));
    drag(200, -200);
    await tick();
    expect(position()).toEqual({ left: 216, top: 430 });
  });

  it("hides the complete card after recording, and preserves dismissal", async () => {
    handle.click();
    reply = { ...reply, state: "transcribing", recording: false };
    await vi.advanceTimersByTimeAsync(1000);
    expect((root.querySelector(".card") as HTMLElement).hidden).toBe(true);
    expect((root.querySelector(".move-controls") as HTMLElement).hidden).toBe(true);
    reply = { ...reply, state: "detected" };
    await vi.advanceTimersByTimeAsync(1000);
    const card = root.querySelector(".card") as HTMLElement;
    expect(card.hidden).toBe(false);
    (root.querySelector(".dismiss") as HTMLButtonElement).click();
    expect(card.hidden).toBe(true);
    expect(runtime.sendMessage).toHaveBeenLastCalledWith({ type: "dismiss-prompt" });
  });

  it("cleans up capture, polling, and observers when replaced or invalidated", async () => {
    pointer("pointerdown", 36, 650);
    pointer("pointermove", 236, 450);
    runtime.id = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.getElementById(host.id)).toBeNull();
    expect(captured.size).toBe(0);
    expect(disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const savedCalls = storage.set.mock.calls.length;
    pointer("pointerup", 236, 450);
    expect(storage.set).toHaveBeenCalledTimes(savedCalls);
  });
});
