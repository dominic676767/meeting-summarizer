// Whether a tab is still on a meeting client. Pure, and deliberately not in
// background.ts: that module registers listeners and touches `ext` at import, so
// nothing there can be tested. This decides whether a navigation means the
// Meeting ended, which is load-bearing enough to want tests.
import manifest from "../manifest.json";

/**
 * Derive Teams hosts from the manifest so injection and navigation checks share
 * one list. Preserve the existing background behavior of accepting subdomains
 * of every Teams host; the manifest currently wildcards only teams.microsoft.com.
 */
export const MEETING_HOSTS = [...new Set(
  manifest.content_scripts
    .filter((script) => script.js.includes("teams-content.js"))
    .flatMap((script) => script.matches)
    .map((match) => new URL(match).hostname.replace(/^\*\./, "")),
)];

// The Zoom adapter is scoped to the web client, using the captured DOM evidence.
// ZoomGov is deliberately excluded pending the real-client evidence in U3.
const ZOOM_HOST = "zoom.us";
const ZOOM_MEETING_PATH = /^\/wc\/(?:\d{9,11}\/(?:join|start)|(?:join|start)\/\d{9,11}|start\/(?:videomeeting|webmeeting)|my\/[^/]+)(?:\/|$)/;

export function isMeetingUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Exact host, or a subdomain of one — matched on a dot boundary so a lookalike
  // like `notteams.live.com` cannot pass as `teams.live.com`.
  const host = parsed.hostname;
  if (MEETING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  // /wc/leave, /wc/home, /j/... and the rest of the Zoom website are outside
  // the call surface. A matching route is necessary, not proof of a live call:
  // the adapter still decides whether the DOM shows an active Meeting.
  return parsed.protocol === "https:"
    && (host === ZOOM_HOST || host.endsWith(`.${ZOOM_HOST}`))
    && ZOOM_MEETING_PATH.test(parsed.pathname);
}
