// Background event page: owns Transcript accumulation, triggers, artifact writes.
// Walking skeleton — wiring lands with the capture and end-to-end tickets.

browser.runtime.onInstalled.addListener(() => {
  console.log("meeting-summarizer installed");
});
