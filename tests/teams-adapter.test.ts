// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TranscriptAccumulator } from "../src/adapters/accumulator";
import { cleanDocumentTitle, createTeamsAdapter } from "../src/adapters/teams";

function loadFixture(name: string): void {
  document.body.innerHTML = readFileSync(`tests/fixtures/${name}`, "utf8");
}

describe("Teams Platform Adapter", () => {
  it("extracts Caption Snapshots with speaker and text", () => {
    loadFixture("teams-captions.html");
    const adapter = createTeamsAdapter();
    const captions = adapter.readCaptions(document);
    expect(captions).toHaveLength(2);
    expect(captions[0]).toMatchObject({
      speaker: "Alice Chen",
      text: "We should ship the beta next Friday.",
    });
    expect(captions[1]).toMatchObject({
      speaker: "Bob Park",
      text: "Agreed, I will own the release checklist.",
    });
  });

  it("keeps a stable key across in-place caption mutation — no duplicate segments", () => {
    loadFixture("teams-captions.html");
    const adapter = createTeamsAdapter();
    const acc = new TranscriptAccumulator();

    acc.upsertAll(adapter.readCaptions(document), 1000);
    expect(acc.size).toBe(2);

    // Teams refines the ASR text in place on the same element.
    const textEl = document.querySelectorAll('[data-tid="closed-caption-text"]')[1]!;
    textEl.textContent = "Agreed, I will own the release checklist and the demo.";
    acc.upsertAll(adapter.readCaptions(document), 2000);

    expect(acc.size).toBe(2);
    const segments = acc.toSegments();
    expect(segments[1]!.text).toBe("Agreed, I will own the release checklist and the demo.");
    expect(segments.map((s) => s.speaker)).toEqual(["Alice Chen", "Bob Park"]);
  });

  it("appends genuinely new captions in order", () => {
    loadFixture("teams-captions.html");
    const adapter = createTeamsAdapter();
    const acc = new TranscriptAccumulator();
    acc.upsertAll(adapter.readCaptions(document), 1000);

    const renderer = document.querySelector('[data-tid="closed-captions-renderer"]')!;
    renderer.insertAdjacentHTML(
      "beforeend",
      `<div class="fui-ChatMessageCompact">
         <span data-tid="author">Cara Diaz</span>
         <span data-tid="closed-caption-text">What about Firefox ESR support?</span>
       </div>`,
    );
    acc.upsertAll(adapter.readCaptions(document), 2000);

    expect(acc.size).toBe(3);
    expect(acc.toSegments()[2]).toMatchObject({
      speaker: "Cara Diaz",
      text: "What about Firefox ESR support?",
    });
  });

  it("extracts the meeting title from the call header", () => {
    loadFixture("teams-captions.html");
    expect(createTeamsAdapter().meetingTitle(document)).toBe("Q3 Planning");
  });

  it("falls back to a cleaned document.title, then null", () => {
    document.body.innerHTML = "<div></div>";
    document.title = "(2) Standup | Microsoft Teams";
    expect(createTeamsAdapter().meetingTitle(document)).toBe("Standup");
    expect(cleanDocumentTitle("Microsoft Teams")).toBeNull();
  });

  it("reports in-meeting while the hangup button is present", () => {
    loadFixture("teams-captions.html");
    const adapter = createTeamsAdapter();
    expect(adapter.isInMeeting(document)).toBe(true);
    expect(adapter.isMeetingEnded(document)).toBe(false);
  });

  it("detects Meeting End from the post-call screen", () => {
    loadFixture("teams-post-call.html");
    const adapter = createTeamsAdapter();
    expect(adapter.isInMeeting(document)).toBe(false);
    expect(adapter.isMeetingEnded(document)).toBe(true);
  });

  it("ignores empty caption text (never emits blank segments)", () => {
    loadFixture("teams-captions.html");
    const renderer = document.querySelector('[data-tid="closed-captions-renderer"]')!;
    renderer.insertAdjacentHTML(
      "beforeend",
      `<div class="fui-ChatMessageCompact">
         <span data-tid="author">Dan</span>
         <span data-tid="closed-caption-text">   </span>
       </div>`,
    );
    const acc = new TranscriptAccumulator();
    acc.upsertAll(createTeamsAdapter().readCaptions(document), 0);
    expect(acc.size).toBe(2);
  });
});

describe("caption keys across frames and reloads", () => {
  it("two adapter instances (frames / reloads) never produce colliding keys", () => {
    loadFixture("teams-captions.html");
    const a = createTeamsAdapter().readCaptions(document);
    const b = createTeamsAdapter().readCaptions(document); // fresh instance = reload/other frame
    const acc = new TranscriptAccumulator();
    acc.upsertAll(a, 1000);
    acc.upsertAll(b, 2000);
    // Same DOM read twice by independent instances must not overwrite entries.
    expect(acc.size).toBe(4);
    expect(new Set([...a, ...b].map((c) => c.key)).size).toBe(4);
  });
});
