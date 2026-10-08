// The toolbar badge, which is the only surface of this extension a user cannot
// choose not to look at. Everything it says is one pure function of the session,
// so the whole table is checkable here rather than only in a browser: what the
// letters say, and what the tooltip says they mean.
//
// Whether Chromium renders three letters legibly, and whether it shows the tooltip
// at all, is the part only a real browser can answer.
import { describe, expect, it } from "vitest";
import { badgeFor, type BadgeView } from "../src/background/badge";

const ALERT_RED = "#d73a4a";
const SIGNAL_GREEN = "#0e8a16";

function view(over: Partial<BadgeView> = {}): BadgeView {
  return {
    recording: false,
    micRecording: false,
    warning: null,
    inMeeting: false,
    segmentCount: 0,
    ...over,
  };
}

describe("the badge while audio is being recorded", () => {
  it("names the microphone when its input is connected", () => {
    expect(badgeFor(view({ recording: true, micRecording: true, inMeeting: true }))).toEqual({
      text: "MIC",
      color: ALERT_RED,
      title: "Recording — microphone input connected.",
    });
  });

  it("says only REC when the Meeting is recorded without the microphone", () => {
    expect(badgeFor(view({ recording: true, micRecording: false, inMeeting: true }))).toEqual({
      text: "REC",
      color: ALERT_RED,
      title: "Recording — meeting tab audio only.",
    });
  });

  it("keeps the same red for both and changes only the words", () => {
    // Both are live capture, so the colour cannot be what tells them apart — a
    // distinction carried by colour alone is one a colour-blind user never sees.
    const withMic = badgeFor(view({ recording: true, micRecording: true, inMeeting: true }));
    const tabOnly = badgeFor(view({ recording: true, micRecording: false, inMeeting: true }));
    expect(withMic.color).toBe(tabOnly.color);
    expect(withMic.text).not.toBe(tabOnly.text);
    expect(withMic.title).not.toBe(tabOnly.title);
  });

  it("outranks the caption count, however many captions have arrived", () => {
    // Captions being counted is reassurance; audio being recorded is the fact the
    // user has no other way to discover, so it takes the badge.
    expect(badgeFor(view({ recording: true, inMeeting: true, segmentCount: 42 })).text).toBe("REC");
  });
});

describe("the badge while a recording has a fault", () => {
  const SILENT = "No sound has reached the recording yet.";
  const MIC_LOST = "Your microphone stopped being recorded.";

  it("marks a warning with the microphone input connected as MIC!", () => {
    expect(
      badgeFor(view({ recording: true, micRecording: true, inMeeting: true, warning: SILENT })),
    ).toEqual({
      text: "MIC!",
      color: ALERT_RED,
      title: `${SILENT} Recording — microphone input connected.`,
    });
  });

  it("marks a fault without the microphone as REC!", () => {
    expect(
      badgeFor(view({ recording: true, micRecording: false, inMeeting: true, warning: MIC_LOST })),
    ).toEqual({
      text: "REC!",
      color: ALERT_RED,
      title: `${MIC_LOST} Recording — meeting tab audio only.`,
    });
  });

  it("leads the tooltip with the fault, then says whether the microphone is connected", () => {
    const withMic = badgeFor(view({ recording: true, micRecording: true, warning: SILENT }));
    const tabOnly = badgeFor(view({ recording: true, micRecording: false, warning: SILENT }));
    expect(withMic.title.startsWith(SILENT)).toBe(true);
    expect(tabOnly.title.startsWith(SILENT)).toBe(true);
    expect(withMic.title).toContain("microphone input connected");
    expect(tabOnly.title).toContain("meeting tab audio only");
  });

  it("stays Alert Red and differs from healthy recording in the text alone", () => {
    for (const micRecording of [true, false]) {
      const healthy = badgeFor(view({ recording: true, micRecording }));
      const faulty = badgeFor(view({ recording: true, micRecording, warning: SILENT }));
      expect(faulty.color).toBe(healthy.color);
      expect(faulty.text).toBe(`${healthy.text}!`);
    }
  });

  it("fits the four characters a badge has room for", () => {
    for (const micRecording of [true, false]) {
      const faulty = badgeFor(view({ recording: true, micRecording, warning: SILENT }));
      expect(faulty.text.length).toBeLessThanOrEqual(4);
    }
  });

  it("changes nothing once the recording has stopped", () => {
    // A warning outlives the recording it was about, so an idle badge ignores it
    // rather than go on reporting a fault in audio that is no longer being taken.
    const idle = [view(), view({ inMeeting: true }), view({ inMeeting: true, segmentCount: 7 })];
    for (const v of idle) {
      expect(badgeFor({ ...v, warning: SILENT })).toEqual(badgeFor(v));
    }
  });
});

describe("the badge while a Meeting is running but nothing is being recorded", () => {
  it("counts the caption lines on Signal Green", () => {
    expect(badgeFor(view({ inMeeting: true, segmentCount: 42 }))).toEqual({
      text: "42",
      color: SIGNAL_GREEN,
      title: "Meeting detected — not recording. 42 caption lines captured so far.",
    });
  });

  it("says a count is not a recording", () => {
    // A number on a green badge reads as "working", and a user hovering to find out what it means must not be left to assume the
    // meeting is being recorded.
    expect(badgeFor(view({ inMeeting: true, segmentCount: 42 })).title).toContain(
      "not recording",
    );
  });

  it("warns when no captions are arriving, and says what to do", () => {
    // Nothing at all is being captured from a live Meeting, and unlike a missing
    // microphone this one the user can fix from inside the meeting client.
    expect(badgeFor(view({ inMeeting: true, segmentCount: 0 }))).toEqual({
      text: "!",
      color: ALERT_RED,
      title: "Meeting detected — not recording, and no captions are arriving. Turn captions on.",
    });
  });

  it("caps the letters at three digits but keeps the tooltip exact", () => {
    // A badge has room for three characters; a tooltip has room for the truth.
    const badge = badgeFor(view({ inMeeting: true, segmentCount: 1234 }));
    expect(badge.text).toBe("999");
    expect(badge.title).toContain("1234 caption lines");
  });

  it("counts one caption line as one", () => {
    expect(badgeFor(view({ inMeeting: true, segmentCount: 1 })).title).toContain(
      "1 caption line captured",
    );
  });
});

describe("the badge with no Meeting in the tab", () => {
  it("shows nothing, and says nothing is happening", () => {
    expect(badgeFor(view())).toEqual({
      text: "",
      color: SIGNAL_GREEN,
      title: "Meeting Summarizer — no meeting detected.",
    });
  });
});

describe("every state the badge can be in describes itself", () => {
  const states: Array<[string, BadgeView]> = [
    ["recording with the microphone", view({ recording: true, micRecording: true, inMeeting: true })],
    ["recording without the microphone", view({ recording: true, inMeeting: true })],
    [
      "a faulty recording with the microphone",
      view({ recording: true, micRecording: true, inMeeting: true, warning: "No sound." }),
    ],
    [
      "a faulty recording without the microphone",
      view({ recording: true, inMeeting: true, warning: "No sound." }),
    ],
    ["in a Meeting with captions", view({ inMeeting: true, segmentCount: 7 })],
    ["in a Meeting with no captions", view({ inMeeting: true })],
    ["no Meeting", view()],
  ];

  it.each(states)("%s has a tooltip of its own", (_name, v) => {
    // `chrome.action.setTitle` is per-tab and sticky, so a state with no tooltip of
    // its own does not fall back to a neutral one — it keeps whatever the previous
    // state set, which is how a stopped recording ends up still claiming a live
    // microphone. Every row here must therefore carry its own sentence.
    expect(badgeFor(v).title.length).toBeGreaterThan(0);
  });

  it.each(states.filter(([, v]) => !(v.recording && v.micRecording)))(
    "%s never claims the microphone is connected",
    (_name, v) => {
      expect(badgeFor(v).title).not.toContain("microphone input connected");
    },
  );

  it.each(states.filter(([, v]) => !v.recording))("%s never claims to be recording", (_name, v) => {
    // The live states open with "Recording — …". No idle state may borrow that
    // opening, whatever else its sentence goes on to say.
    expect(badgeFor(v).title).not.toMatch(/^Recording/);
  });
});
