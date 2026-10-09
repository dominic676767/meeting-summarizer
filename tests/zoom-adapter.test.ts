// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { TranscriptAccumulator } from "../src/adapters/accumulator";
import { createZoomAdapter } from "../src/adapters/zoom";

function loadFixture(name: string): void {
  document.body.innerHTML = readFileSync(`tests/fixtures/${name}`, "utf8");
}

function captionRow(): Element {
  return document.querySelector(".live-transcription-subtitle__item")!;
}

beforeEach(() => {
  document.title = "Zoom";
});

describe("Zoom web-client adapter", () => {
  it("reads real caption markup without guessing speakers from video tiles", () => {
    loadFixture("zoom-in-meeting.html");
    const snapshots = createZoomAdapter().readCaptions(document);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      speaker: "Unknown",
      text: "One, two, three, hello, hello, testing, one, two, three Hello, testing 1, 2, 3.",
    });
  });

  it("updates growing text on the same row without duplicating it", () => {
    loadFixture("zoom-in-meeting.html");
    const adapter = createZoomAdapter();
    const acc = new TranscriptAccumulator();
    const first = adapter.readCaptions(document)[0]!;
    acc.upsertAll([first], 1000);
    captionRow().textContent = `${first.text} The release is on Tuesday.`;
    acc.upsertAll(adapter.readCaptions(document), 2000);
    expect(acc.size).toBe(1);
    expect(acc.toSegments()[0]!.text).toBe(`${first.text} The release is on Tuesday.`);
  });

  it("preserves earlier words when Zoom slides the caption window", () => {
    loadFixture("zoom-in-meeting.html");
    captionRow().textContent = "The team will review the browser capture before release";
    const adapter = createZoomAdapter();
    const acc = new TranscriptAccumulator();
    acc.upsertAll(adapter.readCaptions(document), 1000);
    captionRow().textContent = "browser capture before release and publish the results";
    acc.upsertAll(adapter.readCaptions(document), 2000);
    expect(acc.size).toBe(1);
    expect(acc.toSegments()[0]!.text)
      .toBe("The team will review the browser capture before release and publish the results");
  });

  it("retains the old utterance when Zoom reuses a row for new text", () => {
    loadFixture("zoom-in-meeting.html");
    captionRow().textContent = "The release is on Tuesday.";
    const adapter = createZoomAdapter();
    const acc = new TranscriptAccumulator();
    acc.upsertAll(adapter.readCaptions(document), 1000);
    captionRow().textContent = "I will check Firefox tomorrow.";
    acc.upsertAll(adapter.readCaptions(document), 2000);
    expect(acc.toSegments().map((segment) => segment.text)).toEqual([
      "The release is on Tuesday.", "I will check Firefox tomorrow.",
    ]);
  });

  it("captures captions after Zoom replaces its caption panel", () => {
    loadFixture("zoom-in-meeting.html");
    const adapter = createZoomAdapter();
    const acc = new TranscriptAccumulator();
    acc.upsertAll(adapter.readCaptions(document), 1000);
    const original = acc.toSegments()[0]!.text;
    loadFixture("zoom-main-caption-restored.html");
    acc.upsertAll(adapter.readCaptions(document), 2000);
    expect(acc.size).toBe(2);
    expect(acc.toSegments()[0]!.text).toBe(original);
    expect(acc.toSegments()[1]!.text).toContain("Our next step is to review the");
  });

  it("reads both caption rows when Zoom repeats an HTML id", () => {
    loadFixture("zoom-gallery-six.html");
    const snapshots = createZoomAdapter().readCaptions(document);
    expect(snapshots).toHaveLength(2);
    expect(new Set(snapshots.map((snapshot) => snapshot.key)).size).toBe(2);
    expect(snapshots.every((snapshot) => snapshot.speaker === "Unknown")).toBe(true);
  });

  it("ignores hidden captions from inactive video tiles", () => {
    loadFixture("zoom-caption-speaker-a-hidden.html");
    expect(createZoomAdapter().readCaptions(document)).toEqual([]);
  });

  it.each(["hidden", "aria-hidden", "display"])("ignores a caption under a %s container", (kind) => {
    loadFixture("zoom-in-meeting.html");
    const container = captionRow().parentElement!;
    if (kind === "display") container.style.display = "none";
    else container.setAttribute(kind, kind === "hidden" ? "" : "true");
    expect(createZoomAdapter().readCaptions(document)).toEqual([]);
  });

  it("recognizes the footer Leave control as an active meeting", () => {
    loadFixture("zoom-in-meeting.html");
    const adapter = createZoomAdapter();
    expect(adapter.isInMeeting(document)).toBe(true);
    expect(adapter.isMeetingEnded(document)).toBe(false);
  });

  it("captures visible captions while a dialog marks the meeting root aria-hidden", () => {
    loadFixture("zoom-in-meeting.html");
    const meetingRoot = document.createElement("div");
    meetingRoot.id = "root";
    meetingRoot.setAttribute("aria-hidden", "true");
    meetingRoot.append(...document.body.childNodes);
    document.body.append(meetingRoot);
    document.body.classList.add("ReactModal__Body--open");
    const adapter = createZoomAdapter();
    expect(adapter.isInMeeting(document)).toBe(true);
    expect(adapter.isMeetingEnded(document)).toBe(false);
    expect(adapter.readCaptions(document)).toEqual([
      expect.objectContaining({
        speaker: "Unknown",
        text: captionRow().textContent?.trim(),
      }),
    ]);
    captionRow().parentElement!.setAttribute("aria-hidden", "true");
    expect(adapter.readCaptions(document)).toEqual([]);
  });

  it.each(["hidden", "display", "visibility"])(
    "ignores captions when the meeting root is hidden by %s", (kind) => {
      loadFixture("zoom-in-meeting.html");
      const meetingRoot = document.createElement("div");
      meetingRoot.id = "root";
      meetingRoot.setAttribute("aria-hidden", "true");
      meetingRoot.append(...document.body.childNodes);
      document.body.append(meetingRoot);
      if (kind === "hidden") meetingRoot.hidden = true;
      else if (kind === "display") meetingRoot.style.display = "none";
      else meetingRoot.style.visibility = "hidden";
      expect(createZoomAdapter().readCaptions(document)).toEqual([]);
    },
  );

  it.each(["hidden", "display", "visibility"])(
    "does not recognize a footer hidden by %s as an active meeting", (kind) => {
      loadFixture("zoom-in-meeting.html");
      const footer = document.querySelector<HTMLElement>("#wc-footer")!;
      if (kind === "hidden") footer.hidden = true;
      else if (kind === "display") footer.style.display = "none";
      else footer.style.visibility = "hidden";
      expect(createZoomAdapter().isInMeeting(document)).toBe(false);
    },
  );

  it("recognizes host termination even when the footer still exists", () => {
    loadFixture("zoom-host-ended.html");
    const adapter = createZoomAdapter();
    expect(adapter.isMeetingEnded(document)).toBe(true);
    expect(adapter.isInMeeting(document)).toBe(false);
  });

  it.each(["zoom-breakout-joining.html", "zoom-breakout-returning.html"])(
    "keeps the meeting active through %s", (name) => {
      loadFixture(name);
      const adapter = createZoomAdapter();
      expect(adapter.isInMeeting(document)).toBe(true);
      expect(adapter.isMeetingEnded(document)).toBe(false);
      expect(adapter.leaveGraceMs).toBe(30_000);
    },
  );

  it("does not treat a breakout closing notice as meeting termination", () => {
    loadFixture("zoom-breakout-closing.html");
    expect(createZoomAdapter().isMeetingEnded(document)).toBe(false);
  });

  it("does not mistake a join-timeout Leave button for an active meeting", () => {
    loadFixture("zoom-join-timeout.html");
    expect(createZoomAdapter().isInMeeting(document)).toBe(false);
  });

  it("returns a useful title or null for a generic Zoom title", () => {
    const adapter = createZoomAdapter();
    document.title = "Release review - Zoom";
    expect(adapter.meetingTitle(document)).toBe("Release review");
    document.title = "Zoom Meeting";
    expect(adapter.meetingTitle(document)).toBeNull();
  });
});
