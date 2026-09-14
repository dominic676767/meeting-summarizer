// Whether a tab is still on a meeting client. Pure, and deliberately not in
// background.ts: that module registers listeners and touches `ext` at import, so
// nothing there can be tested. This decides whether a navigation means the
// Meeting ended, which is load-bearing enough to want tests.

/**
 * The hosts a Meeting can run on — the manifest's content-script matches. Kept
 * here as the background's own check because it cannot ask a content script that
 * a navigation has already torn down.
 */
export const MEETING_HOSTS = [
  "teams.microsoft.com",
  "teams.live.com",
  "teams.cloud.microsoft",
] as const;

export function isMeetingUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  // Exact host, or a subdomain of one — matched on a dot boundary so a lookalike
  // like `notteams.live.com` cannot pass as `teams.live.com`.
  return MEETING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
