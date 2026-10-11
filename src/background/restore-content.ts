import { ext } from "../platform";

/**
 * Whether a URL is one Chrome would load this content-script entry into. Covers
 * the manifest's own pattern forms: an exact or `*.`-wildcard host and a path
 * ending in `*`.
 */
function matchesPattern(url: string, pattern: string): boolean {
  const [, scheme, host, path] = /^([^:]+):\/\/([^/]+)(\/.*)$/.exec(pattern) ?? [];
  if (!scheme || !host || !path) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== `${scheme}:`) return false;
  const hostname = parsed.hostname;
  const hostMatches = host.startsWith("*.")
    ? hostname === host.slice(2) || hostname.endsWith(host.slice(1))
    : hostname === host;
  if (!hostMatches) return false;
  const escaped = path.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`).test(parsed.pathname + parsed.search);
}

/**
 * An extension reload does not run manifest content scripts in existing tabs.
 * Restore them wherever the manifest would have loaded them, without refreshing
 * an active meeting.
 *
 * That includes Zoom web-client pages that are not a Meeting yet, such as
 * /wc/home: a Meeting started there keeps the same top document, so the
 * capture prompt the manifest loaded at page load is the only one it gets.
 */
export async function restoreMeetingContentScripts(): Promise<void> {
  const entries = (ext.runtime.getManifest().content_scripts ?? []).filter((entry) =>
    entry.js?.some((file) => file === "teams-content.js" || file === "zoom-content.js"),
  );
  const matches = [...new Set(entries.flatMap((entry) => entry.matches ?? []))];
  if (!matches.length) return;

  const tabs = await ext.tabs.query({ url: matches });
  await Promise.allSettled(tabs.map(async (tab) => {
    if (tab.id === undefined || !tab.url) return;
    const url = tab.url;
    const entry = entries.find((candidate) => candidate.matches?.some((pattern) => matchesPattern(url, pattern)));
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
