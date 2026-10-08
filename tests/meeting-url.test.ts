import { describe, expect, it } from "vitest";
import { isMeetingUrl } from "../src/background/meeting-url";
import manifest from "../src/manifest.json";

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

  it("accepts every Teams manifest match, including its wildcard", () => {
    const scripts = manifest.content_scripts.filter((s) => s.js.includes("teams-content.js"));
    expect(scripts.length).toBeGreaterThan(0);
    for (const match of scripts.flatMap((s) => s.matches)) {
      const url = match.replace("*.", "tenant.").replace("/*", "/v2/");
      expect(isMeetingUrl(url), match).toBe(true);
    }
  });

  it("preserves the existing Teams subdomain and path behavior", () => {
    for (const host of ["tenant.teams.live.com", "tenant.teams.cloud.microsoft"]) {
      expect(isMeetingUrl(`https://${host}/`)).toBe(true);
      expect(isMeetingUrl(`https://${host}/anything?x=1#call`)).toBe(true);
    }
  });

  describe.each(["zoom.us", "app.zoom.us", "us02web.zoom.us", "example.zoom.us"])("%s", (host) => {
    it.each([
      "/wc/123456789/join",
      "/wc/1234567890/start",
      "/wc/12345678901/join?pwd=example#call",
      "/wc/12345678901/start/",
      "/wc/join/123456789",
      "/wc/start/12345678901",
      "/wc/start/videomeeting",
      "/wc/start/webmeeting?from=browser",
      "/wc/my/example-alias",
      "/wc/my/example-alias/join",
    ])("recognises the web-client route %s", (path) => {
      expect(isMeetingUrl(`https://${host}${path}`)).toBe(true);
    });

    it.each([
      "/wc/leave?from=meeting&meetingId=12345678901",
      "/wc/home",
      "/wc/home?redirect=/wc/12345678901/join",
      "/wc",
      "/wc/",
      "/j/12345678901",
      "/postattendee",
      "/",
      "/wc/12345678/join",
      "/wc/123456789012/join",
      "/wc/12345678901",
      "/wc/12345678901/joined",
      "/wc/join/12345678",
      "/wc/start/123456789012",
      "/wc/join/12345678901extra",
      "/wc/start/webmeeting-extra",
      "/wc/my/",
    ])("rejects the non-meeting route %s", (path) => {
      expect(isMeetingUrl(`https://${host}${path}`)).toBe(false);
    });
  });

  it.each([
    "https://notzoom.us/wc/12345678901/join",
    "https://zoom.us.example.com/wc/12345678901/join",
    "https://app.zoom.us.example.com/wc/12345678901/join",
    "https://zoom.us@evil.example/wc/12345678901/join",
    "https://zoomgov.com/wc/12345678901/join",
    "https://example.zoomgov.com/wc/12345678901/join",
    "ftp://zoom.us/wc/12345678901/join",
    "http://zoom.us/wc/12345678901/join",
  ])("rejects unsupported Zoom hosts or schemes: %s", (url) => {
    expect(isMeetingUrl(url)).toBe(false);
  });
});
