import { describe, expect, it } from "vitest";
import { isMeetingUrl } from "../src/background/meeting-url";

// Decides whether a tab navigation means "left the meeting". A false negative
// keeps recording whatever the user browses next; a false positive ends a
// meeting that is still running.
describe("isMeetingUrl", () => {
  it("recognises every meeting host the manifest injects into", () => {
    for (const url of [
      "https://teams.microsoft.com/v2/",
      "https://teams.live.com/meet/123",
      "https://teams.cloud.microsoft/v2/?x=1",
      "https://gov.teams.microsoft.com/v2/",
    ]) {
      expect(isMeetingUrl(url), url).toBe(true);
    }
  });

  it("treats anywhere else as off the meeting client", () => {
    for (const url of [
      "https://mail.google.com/",
      "https://example.com/teams.microsoft.com",
      "chrome://extensions",
      "about:blank",
    ]) {
      expect(isMeetingUrl(url), url).toBe(false);
    }
  });

  it("does not match a lookalike host that merely ends in the name", () => {
    // The suffix check must not accept an attacker-ish or coincidental host.
    expect(isMeetingUrl("https://notteams.live.com/")).toBe(false);
  });

  it("treats a missing or unparseable url as not a meeting", () => {
    expect(isMeetingUrl(undefined)).toBe(false);
    expect(isMeetingUrl("not a url")).toBe(false);
  });
});
