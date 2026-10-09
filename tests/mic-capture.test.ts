// Recording the local microphone alongside the tab (ADR-0007).
//
// Three seams are testable without a browser, and between them they cover every
// rule that made this ticket exist:
//
//   - the mix graph, against a fake graph that records where each source went:
//     the tab must reach the speakers, the microphone must never reach them, and
//     both must reach the recording;
//   - the microphone's state machine, which decides whether a Capture Start asks
//     for the microphone at all, what the recording indicator may claim, and what
//     the always-visible badge says in the three letters everyone sees;
//   - the Summary Artifact, which must not imply the local user was captured when
//     they were not.
//
// Whether two people's voices genuinely land in one file can only be established
// in a real two-party meeting.
import { describe, expect, it } from "vitest";
import { mixCapture, type MixGraph } from "../src/offscreen/audio-mix";
import {
  foldLocalMicrophone,
  micCaptureState,
  recordingBadge,
  shouldCaptureMic,
} from "../src/background/mic-capture";
import { renderArtifact } from "../src/pipeline/artifact";
import { transcript } from "./helpers";
import { DEFAULT_SETTINGS } from "../src/settings";

// The streams are opaque to the mix, so the fake uses their names as the nodes
// and every connection reads as plain English.
const TAB = "tab" as unknown as MediaStream;
const MIC = "mic" as unknown as MediaStream;

/**
 * A mix graph whose nodes are names: `wires` holds one "source → destination"
 * string per connection the mix made, which is the whole observable behaviour of
 * a graph nothing has yet recorded through.
 */
function fakeGraph(): MixGraph<string> & { wires: string[] } {
  const wires: string[] = [];
  return {
    wires,
    source: (stream) => String(stream),
    connect: (from, to) => wires.push(`${from} → ${to}`),
    speakers: "speakers",
    recorded: "recording",
    recordedStream: "mixed" as unknown as MediaStream,
  };
}

describe("mixing the microphone into the Audio Recording", () => {
  it("records the tab and the microphone into one recording", () => {
    // The whole point of the ticket: one file holding both sides of the meeting,
    // because the tab carries only the remote participants.
    const graph = fakeGraph();
    mixCapture(graph, { tab: TAB, mic: MIC });
    expect(graph.wires).toContain("tab → recording");
    expect(graph.wires).toContain("mic → recording");
  });

  it("keeps the meeting audible by sending the tab to the speakers", () => {
    // tabCapture stops the tab's own playback, so without this the user hears
    // silence for the whole call (ADR-0004).
    const graph = fakeGraph();
    mixCapture(graph, { tab: TAB, mic: MIC });
    expect(graph.wires).toContain("tab → speakers");
  });

  it("never plays the microphone back to the speakers", () => {
    // Looping the microphone to the destination echoes the user to themselves
    // through their own headphones. That is a defect, not a feature, and it is
    // invisible in the recording — this assertion is the only thing that catches
    // it outside a real call.
    const graph = fakeGraph();
    mixCapture(graph, { tab: TAB, mic: MIC });
    expect(graph.wires).not.toContain("mic → speakers");
  });

  it("degrades to tab-only capture when there is no microphone", () => {
    // A denied or absent microphone must cost the local user's words, never the
    // meeting: the tab is still recorded and still audible.
    const graph = fakeGraph();
    mixCapture(graph, { tab: TAB });
    expect(graph.wires).toEqual(["tab → speakers", "tab → recording"]);
  });

  it("records the mixed stream, not the tab stream", () => {
    // Recording the tab stream directly is the original defect: it is exactly the
    // half of the meeting that excludes the person holding the microphone.
    const graph = fakeGraph();
    expect(mixCapture(graph, { tab: TAB, mic: MIC })).toBe(graph.recordedStream);
  });
});

describe("whether a Capture Start asks for the microphone", () => {
  it("does not ask before the disclosure has been answered", () => {
    // The extension disclosure and Chrome's microphone permission are separate.
    // Capture needs the disclosure first; Settings requests Chrome access.
    expect(shouldCaptureMic({ enabled: true, confirmedAt: null })).toBe(false);
  });

  it("asks once the disclosure has been answered with yes", () => {
    expect(shouldCaptureMic({ enabled: true, confirmedAt: 1 })).toBe(true);
  });

  it("never asks when the setting is off, however the disclosure was answered", () => {
    expect(shouldCaptureMic({ enabled: false, confirmedAt: null })).toBe(false);
    expect(shouldCaptureMic({ enabled: false, confirmedAt: 1 })).toBe(false);
  });
});

describe("what the recording indicator may say about the microphone", () => {
  const on = { enabled: true, confirmedAt: 1 };
  const off = { enabled: false, confirmedAt: 1 };
  const unanswered = { enabled: true, confirmedAt: null };

  it("reports a live microphone as recording", () => {
    expect(micCaptureState({ settings: on, recording: true, micRecording: true })).toBe("recording");
  });

  it("still reports a live microphone as recording after the setting is switched off", () => {
    // Flipping the switch mid-meeting does not reach into a recorder that already
    // has the microphone open. An indicator that claimed otherwise would be lying
    // about live capture, which is the one thing it may never do.
    expect(micCaptureState({ settings: off, recording: true, micRecording: true })).toBe(
      "recording",
    );
  });

  it("distinguishes a switched-off microphone from one that was refused", () => {
    // Two different facts and only one is actionable: the user chose the first,
    // and needs to be told about the second.
    expect(micCaptureState({ settings: off, recording: true, micRecording: false })).toBe("off");
    expect(micCaptureState({ settings: on, recording: true, micRecording: false })).toBe(
      "unavailable",
    );
  });

  it("reports an unanswered disclosure as unanswered, not as unavailable", () => {
    // Nothing was refused: nothing was asked. Reporting a permission failure here
    // would send the user hunting through Chromium's settings for a switch that is
    // in this extension's popup.
    expect(micCaptureState({ settings: unanswered, recording: true, micRecording: false })).toBe(
      "unconfirmed",
    );
  });

  it("reports what will happen before capture starts", () => {
    expect(micCaptureState({ settings: on, recording: false, micRecording: false })).toBe("armed");
    expect(micCaptureState({ settings: off, recording: false, micRecording: false })).toBe("off");
    expect(micCaptureState({ settings: unanswered, recording: false, micRecording: false })).toBe(
      "unconfirmed",
    );
  });
});

describe("what the always-visible badge says about the microphone", () => {
  // The letters and sentences of the two live states are checked where the badge
  // is decided, in `badge.test.ts`. What is left here is the half only this seam
  // owns: when there is no microphone claim to make at all.
  it("says nothing at all when nothing is being recorded", () => {
    // What an idle badge shows is the caption count's business, not the
    // microphone's — see `badgeFor`, which owns that half.
    expect(recordingBadge({ recording: false, micRecording: false })).toBeNull();
  });

  it("claims nothing from a microphone flag left behind by a finished recording", () => {
    // `micRecording` outliving `recording` should not happen — stopping releases the
    // track — but a session is rehydrated from storage, so the pair is resolved in
    // favour of the quieter claim rather than trusted.
    expect(recordingBadge({ recording: false, micRecording: true })).toBeNull();
  });
});

describe("whether the Meeting's recording holds the local user", () => {
  it("holds them when the first Capture Start had the microphone", () => {
    expect(foldLocalMicrophone(null, true)).toBe(true);
  });

  it("does not hold them when the first Capture Start had no microphone", () => {
    expect(foldLocalMicrophone(null, false)).toBe(false);
  });

  it("stops holding them as soon as one Capture Span is recorded without the microphone", () => {
    // A Meeting recorded in three stretches of which one had no microphone does
    // not contain the whole of the local user's side of it, so the artifact must
    // not round up to "captured".
    expect(foldLocalMicrophone(true, false)).toBe(false);
  });

  it("does not start holding them again on a later span", () => {
    expect(foldLocalMicrophone(false, true)).toBe(false);
  });
});

describe("the Summary Artifact and the local microphone", () => {
  const NO_MIC = "local microphone not recorded";

  it("says so when audio was recorded without the local microphone", () => {
    // The defect this clause exists for: an artifact stamped "from recorded audio"
    // over a recording that contained only the other participants, leaving a
    // reader to wonder why one voice never appears.
    const html = renderArtifact(
      "## TL;DR\nStub.",
      transcript({ provenance: "fused", localMicrophone: false }),
    );
    expect(html).toContain(NO_MIC);
  });

  it("stays quiet when the local microphone was recorded", () => {
    const html = renderArtifact(
      "## TL;DR\nStub.",
      transcript({ provenance: "fused", localMicrophone: true }),
    );
    expect(html).not.toContain(NO_MIC);
  });

  it("treats an absent claim as not recorded", () => {
    // A Transcript held from before the microphone was ever mixed in has only the
    // remote participants in it. The absence of a claim must never be read as a
    // claim that the local user was captured.
    const html = renderArtifact(
      "## TL;DR\nStub.",
      transcript({ provenance: "audio-unattributed" }),
    );
    expect(html).toContain(NO_MIC);
  });

  it("does not mention the microphone on a caption-only artifact", () => {
    // No audio was recorded at all, and the Meta line already says so. A second
    // clause about the microphone would read as a second fault where there is one
    // plain fact.
    const html = renderArtifact("## TL;DR\nStub.", transcript({ provenance: "captions-only" }));
    expect(html).not.toContain(NO_MIC);
  });

  it("does not mention the microphone on a Transcript carrying no provenance", () => {
    // Absent provenance renders as caption-only, so the microphone is beside the
    // point there too.
    const html = renderArtifact("## TL;DR\nStub.", transcript({ provenance: undefined }));
    expect(html).not.toContain(NO_MIC);
  });
});

describe("the microphone default fails safe", () => {
  it("a fresh install does not capture the microphone", () => {
    // The safe state must not depend on the confirmation gate holding: if
    // anything ever reaches around that gate, `enabled: false` still means
    // silence rather than an unconsented recording (ADR-0007).
    expect(DEFAULT_SETTINGS.micCapture.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.micCapture.confirmedAt).toBeNull();
    expect(shouldCaptureMic(DEFAULT_SETTINGS.micCapture)).toBe(false);
  });

  it("an unanswered disclosure never captures, whatever `enabled` says", () => {
    // Belt to the default's braces: both mechanisms must fail closed alone.
    expect(shouldCaptureMic({ enabled: true, confirmedAt: null })).toBe(false);
  });

  it("captures only once the user has both enabled it and answered", () => {
    expect(shouldCaptureMic({ enabled: true, confirmedAt: 1_760_000_000_000 })).toBe(true);
  });
});

describe("a revoked microphone stops the Meeting claiming to hold the local user", () => {
  it("one span recorded without the microphone makes the whole Meeting false", () => {
    // Chrome's site controls can pull the microphone mid-meeting. The remote
    // participants are still captured, so the recording survives — but the
    // Audio Recording no longer holds the whole of the local user, and folding
    // with AND is what stops the artifact implying otherwise.
    expect(foldLocalMicrophone(true, false)).toBe(false);
    // And it cannot come back to true on a later span.
    expect(foldLocalMicrophone(foldLocalMicrophone(true, false), true)).toBe(false);
  });
});

describe("a silent recording is not a missing recording", () => {
  it("says the recording contained no speech rather than that none was made", () => {
    // Two different facts: audio WAS recorded here, and the engine ran and heard
    // nothing. Reporting it as "no audio was recorded" would send the reader
    // looking for a broken engine.
    const html = renderArtifact("## TL;DR\nNothing was discussed.", {
      ...transcript(),
      provenance: "captions-only",
      noSpeech: true,
    });
    expect(html).not.toContain("no audio was recorded");
    expect(html).toContain("no speech");
  });
});

describe("a failed capture is not a silent recording", () => {
  it("reports the failure even if an older result claimed there was no speech", () => {
    const html = renderArtifact(
      "## TL;DR\nThe report is due on Monday.",
      transcript({
        provenance: "captions-only",
        noSpeech: true,
        captureError: "The audio stream stopped advancing.",
      }),
    );
    expect(html).toContain("from live captions only — audio capture failed");
    expect(html).toContain("Audio capture failed:");
    expect(html).toContain("The transcript can be incomplete.");
    expect(html).not.toContain("no speech");
  });

  it("escapes the capture failure in the saved HTML", () => {
    const html = renderArtifact(
      "## TL;DR\nAvailable captions.",
      transcript({ captureError: "<script>alert('capture')</script>" }),
    );
    expect(html).toContain("&lt;script&gt;alert('capture')&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('capture')</script>");
  });

  it("keeps the available captions in the transcript when audio capture fails", () => {
    const marker = "My marker is silver lantern six. I will send the report on Monday.";
    const html = renderArtifact(
      "## TL;DR\nThe report is due on Monday.",
      transcript({
        provenance: "captions-only",
        captureError: "The recorder stopped producing audio data.",
        segments: [{ capturedAt: 1_000, speaker: "Dominic Hong", text: marker }],
      }),
    );
    expect(html).toContain(marker);
    expect(html).toContain("Dominic Hong");
    expect(html).toContain("audio capture failed");
  });
});
