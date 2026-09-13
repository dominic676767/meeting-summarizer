// Popup: live capture status, Summarize now, Held Transcript retry.
import type { PopupMessage, StatusReply } from "../messages";

const statusEl = document.getElementById("status")!;
const titleEl = document.getElementById("title")!;
const summarizeBtn = document.getElementById("summarize") as HTMLButtonElement;

function send<T>(msg: PopupMessage): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>;
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
}

summarizeBtn.addEventListener("click", async () => {
  render(await send<StatusReply>({ type: "summarize-now" }));
});

void refresh();
setInterval(() => void refresh(), 1000);
