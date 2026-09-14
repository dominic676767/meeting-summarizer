// The capture-state derivation is the contract the popup and in-page prompt
// render from (see the capture-prompt surface state table). It is pure, so the
// distinctions the ticket turns on — detected vs recording, and Degraded
// Capture — are testable without a browser or real audio.
import { describe, expect, it } from "vitest";
import { deriveCaptureState, isDegraded } from "../src/background/capture-state";

describe("capture state", () => {
  it("no session is idle", () => {
    expect(
      deriveCaptureState({ sessionState: undefined, inMeeting: false, recording: false, recorded: false }),
    ).toBe("idle");
  });

  it("a detected Meeting with no capture running reads as detected, not recording", () => {
    expect(
      deriveCaptureState({ sessionState: "capturing", inMeeting: true, recording: false, recorded: false }),
    ).toBe("detected");
  });

  it("live audio capture reads as recording", () => {
    expect(
      deriveCaptureState({ sessionState: "capturing", inMeeting: true, recording: true, recorded: true }),
    ).toBe("recording");
  });

  it("stopping capture mid-meeting returns to detected without ending the Meeting", () => {
    // recorded stays true (an Audio Recording exists) but recording is now false.
    expect(
      deriveCaptureState({ sessionState: "capturing", inMeeting: true, recording: false, recorded: true }),
    ).toBe("detected");
  });

  it("captions accumulating outside a meeting is idle, not detected", () => {
    expect(
      deriveCaptureState({ sessionState: "capturing", inMeeting: false, recording: false, recorded: false }),
    ).toBe("idle");
  });

  it("lifecycle states pass through unchanged", () => {
    for (const s of ["summarizing", "done", "failed"] as const) {
      expect(
        deriveCaptureState({ sessionState: s, inMeeting: false, recording: false, recorded: false }),
      ).toBe(s);
    }
  });
});

describe("Degraded Capture", () => {
  it("a Meeting with no Audio Recording is degraded", () => {
    expect(isDegraded({ recorded: false })).toBe(true);
  });

  it("a Meeting that recorded audio is not degraded, even after the recorder stops", () => {
    expect(isDegraded({ recorded: true })).toBe(false);
  });
});
