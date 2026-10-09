import { ext } from "../platform";

const POSITION_KEY = "capturePromptPosition";
const MARGIN = 16;
const DRAG_THRESHOLD = 4;
const MOVE_STEP = 10;

/** Fractions of the available travel, so a saved position fits another window. */
interface Position {
  x: number;
  y: number;
}

function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const { x, y } = value as Partial<Position>;
  return [x, y].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1);
}

/**
 * Move only the in-page card. Pointer capture keeps a drag working when it
 * crosses the meeting iframe; no recording command is sent by this control.
 */
export function positionPrompt(
  host: HTMLElement,
  card: HTMLElement,
  row: HTMLElement,
  handle: HTMLButtonElement,
  controls: HTMLElement,
): { refresh(): void; stop(): void } {
  const lifetime = new window.AbortController();
  const options = { signal: lifetime.signal };
  let position: Position | null = null;
  let touched = false;
  let suppressClick = false;
  let drag: {
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
    origin: Position | null;
    moved: boolean;
  } | null = null;

  function travel(): { x: number; y: number } {
    const rect = host.getBoundingClientRect();
    return {
      x: Math.max(0, window.innerWidth - rect.width - MARGIN * 2),
      y: Math.max(0, window.innerHeight - rect.height - MARGIN * 2),
    };
  }

  function paint(): void {
    if (card.hidden) return;
    if (position === null) {
      host.style.left = `${MARGIN}px`;
      host.style.top = "auto";
      host.style.bottom = `${MARGIN}px`;
      return;
    }
    const room = travel();
    host.style.left = `${Math.round(MARGIN + position.x * room.x)}px`;
    host.style.top = `${Math.round(MARGIN + position.y * room.y)}px`;
    host.style.bottom = "auto";
  }

  function moveTo(left: number, top: number): void {
    const room = travel();
    position = {
      x: room.x === 0 ? 0 : Math.max(0, Math.min(1, (left - MARGIN) / room.x)),
      y: room.y === 0 ? 0 : Math.max(0, Math.min(1, (top - MARGIN) / room.y)),
    };
    paint();
  }

  function save(): void {
    if (position === null) return;
    // A storage failure must not make the current card immovable.
    try {
      void Promise.resolve(ext.storage.local.set({ [POSITION_KEY]: { ...position } })).catch(() => {});
    } catch {
      // The extension may have been reloaded while the meeting tab stayed open.
    }
  }

  function showControls(show: boolean): void {
    controls.hidden = !show;
    handle.setAttribute("aria-expanded", String(show));
    paint();
  }

  function endDrag(cancel = false): void {
    if (!drag) return;
    const finished = drag;
    drag = null;
    row.classList.remove("dragging");
    if (cancel) {
      position = finished.origin;
      paint();
    } else if (finished.moved) {
      suppressClick = true;
      save();
    }
    if (row.hasPointerCapture(finished.pointerId)) row.releasePointerCapture(finished.pointerId);
  }

  row.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary || drag || card.hidden) return;
    touched = true;
    suppressClick = false;
    const rect = host.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      origin: position,
      moved: false,
    };
    row.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });
    event.preventDefault();
    event.stopPropagation();
  }, options);

  row.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    row.classList.add("dragging");
    moveTo(drag.left + dx, drag.top + dy);
    event.preventDefault();
    event.stopPropagation();
  }, options);

  row.addEventListener("pointerup", (event) => {
    if (event.pointerId === drag?.pointerId) endDrag();
  }, options);
  row.addEventListener("pointercancel", (event) => {
    if (event.pointerId === drag?.pointerId) endDrag(true);
  }, options);
  row.addEventListener("lostpointercapture", () => endDrag(), options);

  // Pointer capture retargets the click to the row, even when the pointer
  // started on the handle. Keyboard activation still bubbles here normally.
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      return;
    }
    showControls(controls.hidden);
  }, options);

  function nudge(dx: number, dy: number): void {
    touched = true;
    const rect = host.getBoundingClientRect();
    moveTo(rect.left + dx, rect.top + dy);
    save();
  }

  const directions: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  handle.addEventListener("keydown", (event) => {
    const direction = directions[event.key];
    if (!direction || event.altKey || event.ctrlKey || event.metaKey || drag) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? MOVE_STEP * 4 : MOVE_STEP;
    nudge(direction[0] * step, direction[1] * step);
  }, options);

  controls.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-direction]");
    const direction = directions[button?.dataset.direction ?? ""];
    if (!direction) return;
    event.stopPropagation();
    nudge(direction[0] * MOVE_STEP, direction[1] * MOVE_STEP);
  }, options);

  host.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    endDrag(true);
    showControls(false);
    handle.focus({ preventScroll: true });
  }, options);
  document.addEventListener("pointerdown", (event) => {
    if (!event.composedPath().includes(host)) showControls(false);
  }, options);
  window.addEventListener("resize", () => {
    endDrag();
    paint();
  }, options);

  function refresh(): void {
    if (card.hidden) {
      endDrag();
      showControls(false);
    } else if (!drag) {
      paint();
    }
  }

  const observer = new ResizeObserver(refresh);
  observer.observe(card);
  void (async () => {
    try {
      const stored = (await ext.storage.local.get(POSITION_KEY))[POSITION_KEY] as unknown;
      // A delayed read must never overwrite a move the user already made.
      if (!lifetime.signal.aborted && !touched && isPosition(stored)) {
        position = stored;
        paint();
      }
    } catch {
      // Keep the default corner when storage is unavailable.
    }
  })();

  return {
    refresh,
    stop() {
      lifetime.abort();
      observer.disconnect();
      endDrag(true);
    },
  };
}
