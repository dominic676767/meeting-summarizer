// Popup: live capture status, Summarize now, Held Transcript retry.
import type { HeldListReply, PopupMessage, StatusReply } from "../messages";

const statusEl = document.getElementById("status")!;
const titleEl = document.getElementById("title")!;
const summarizeBtn = document.getElementById("summarize") as HTMLButtonElement;
const heldSection = document.getElementById("held")!;
const heldList = document.getElementById("held-list")!;

function send<T>(msg: PopupMessage): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>;
}

async function refreshHeld(): Promise<void> {
  const { held } = await send<HeldListReply>({ type: "list-held" });
  heldSection.hidden = held.length === 0;
  heldList.replaceChildren(
    ...held.map((h) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      const date = new Date(h.transcript.endedAt ?? h.failedAt).toISOString().slice(0, 10);
      label.textContent = `${date} ${h.transcript.title} (${h.transcript.segments.length} segments)`;
      const reason = document.createElement("div");
      reason.className = "reason";
      reason.textContent = h.reason;
      label.append(reason);
      const btn = document.createElement("button");
      btn.textContent = "Retry";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Retrying…";
        const res = await send<{ ok: boolean; error?: string }>({ type: "retry-held", id: h.id });
        if (!res.ok) {
          btn.disabled = false;
          btn.textContent = "Retry";
        }
        await refreshHeld();
      });
      li.append(label, btn);
      return li;
    }),
  );
}

function render(status: StatusReply): void {
  titleEl.textContent = status.title ?? "";
  summarizeBtn.hidden = !(status.inMeeting && status.segmentCount > 0);
  if (status.state === "summarizing") {
    statusEl.className = "capturing";
    statusEl.textContent = "Summarizing…";
  } else if (status.state === "done") {
    statusEl.className = "capturing";
    statusEl.textContent = "Summary saved to Downloads/meeting-summaries.";
  } else if (status.state === "failed") {
    statusEl.className = "warning";
    statusEl.textContent = "Summarization failed — transcript held for retry below.";
  } else if (status.capturing) {
    statusEl.className = "capturing";
    statusEl.textContent = `● capturing — ${status.segmentCount} segments`;
  } else if (status.inMeeting) {
    statusEl.className = "warning";
    statusEl.textContent = "⚠ In a meeting but no captions arriving — turn captions on.";
  } else {
    statusEl.className = "idle";
    statusEl.textContent = "Not in a meeting.";
  }
}

async function refresh(): Promise<void> {
  render(await send<StatusReply>({ type: "get-status" }));
  await refreshHeld();
}

summarizeBtn.addEventListener("click", async () => {
  render(await send<StatusReply>({ type: "summarize-now" }));
});

void refresh();
setInterval(() => void refresh(), 1000);
