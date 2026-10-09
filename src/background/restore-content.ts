import { ext } from "../platform";
import { isMeetingUrl } from "./meeting-url";

/**
 * An extension reload does not run manifest content scripts in existing tabs.
 * Restore the supported clients without refreshing an active meeting.
 */
export async function restoreMeetingContentScripts(): Promise<void> {
  const entries = (ext.runtime.getManifest().content_scripts ?? []).filter((entry) =>
    entry.js?.some((file) => file === "teams-content.js" || file === "zoom-content.js"),
  );
  const matches = [...new Set(entries.flatMap((entry) => entry.matches ?? []))];
  if (!matches.length) return;

  const tabs = await ext.tabs.query({ url: matches });
  await Promise.allSettled(tabs.map(async (tab) => {
    if (tab.id === undefined || !isMeetingUrl(tab.url)) return;
    const hostname = new URL(tab.url!).hostname;
    const client = hostname === "zoom.us" || hostname.endsWith(".zoom.us")
      ? "zoom-content.js"
      : "teams-content.js";
    const entry = entries.find((candidate) => candidate.js?.includes(client));
    if (!entry?.js?.length) return;
    try {
      await ext.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: entry.js,
      });
    } catch {
      // A closed tab or unavailable frame must not stop recovery in other tabs.
      console.warn("meeting-summarizer: could not restore content scripts in tab", tab.id);
    }
  }));
}
