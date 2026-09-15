// A recording that carries no speech, and the two separate measurements that
// keeps honest (issue #23).
//
// The defect: two Summary Artifacts stamped "from recorded audio", each holding
// the single word "you" — Whisper's hallucination on silence — under a summary body
// of the LLM apologising there was nothing to summarize. The user learned only
// after the meeting had ended and the audio was gone.
//
// The defect this must not introduce while fixing it: keying the end-of-meeting
// decision off "a sustained silence occurred" would throw a meeting that started
// late to captions and tell its reader the recording held no speech. That is worse,
// because it discards good audio rather than misrepresenting empty audio. Hence two
// measurements with different rules, and the test at the top of this file.
//
// Everything here is a pure seam over sample data: no browser, no AudioContext, no
// real meeting.
import { describe, expect, it } from "vitest";
import {
  measureSignal,
  noSignalDetail,
  rmsOf,
  SUSTAINED_SILENCE_MS,
} from "../src/offscreen/signal";
import {
  foldAnySignal,
  MIC_REVOKED_WARNING,
  NO_SOUND_MESSAGE,
  NOTHING_CAPTURED_WARNING,
  refuseAudioAsSilent,
  silenceWarning,
} from "../src/background/capture-signal";
import { renderArtifact } from "../src/pipeline/artifact";
import { transcript } from "./helpers";

/** One read of the mixed stream, as the analyser hands it over. */
const WINDOW = 1024;
/** Real time between reads, matching the recorder's poll interval. */
const FRAME_MS = 500;

function frames(ms: number, amplitude: number): Float32Array[] {
  const count = Math.round(ms / FRAME_MS);
  return Array.from({ length: count }, () => {
    const samples = new Float32Array(WINDOW);
    // Alternating rather than constant, so the level is a level and not a DC offset.
    for (let i = 0; i < WINDOW; i++) samples[i] = i % 2 === 0 ? amplitude : -amplitude;
    return samples;
  });
}

/** A muted tab and a muted microphone: digital silence. */
const silence = (ms: number) => frames(ms, 0);
/** Conversational level. */
const speech = (ms: number) => frames(ms, 0.08);

describe("the two measurements a silent recording produces", () => {
  it("warns about a late-starting meeting AND still transcribes it from audio", () => {
    // THE case the whole two-measurement split exists for. Silent for its first
    // stretch — the user started recording before the meeting began — then entirely
    // normal. Both facts are true at once, and a single flag cannot hold them:
    // the warning was earned, and the audio is real.
    const measure = measureSignal([...silence(300_000), ...speech(600_000)], FRAME_MS);
    expect(measure.hadSilentWindow).toBe(true);
    expect(measure.hadAnySignal).toBe(true);
    // And so this recording is never refused: `hadAnySignal` is the only input.
    expect(refuseAudioAsSilent(measure.hadAnySignal)).toBe(false);
  });

  it("finds no signal in a recording that was silent throughout", () => {
    // The original bug's recording: 41 seconds of nothing, plus the two minutes of
    // it that a real meeting would have been.
    const measure = measureSignal(silence(600_000), FRAME_MS);
    expect(measure.hadSilentWindow).toBe(true);
    expect(measure.hadAnySignal).toBe(false);
    expect(refuseAudioAsSilent(measure.hadAnySignal)).toBe(true);
  });

  it("does not fire on ordinary conversational pauses", () => {
    // Turn-taking, thinking, someone finding the right slide. Seconds, not
    // three quarters of a minute — and a warning that fires here is a warning
    // nobody reads when it matters.
    const conversation = [];
    for (let turn = 0; turn < 20; turn++) {
      conversation.push(...speech(8_000), ...silence(4_000));
    }
    const measure = measureSignal(conversation, FRAME_MS);
    expect(measure.hadSilentWindow).toBe(false);
    expect(measure.hadAnySignal).toBe(true);
  });

  it("holds off until the silence is genuinely sustained", () => {
    const nearly = measureSignal(silence(SUSTAINED_SILENCE_MS - FRAME_MS), FRAME_MS);
    expect(nearly.hadSilentWindow).toBe(false);
    const sustained = measureSignal(silence(SUSTAINED_SILENCE_MS), FRAME_MS);
    expect(sustained.hadSilentWindow).toBe(true);
  });

  it("counts silence from the last sound, not from the start of the recording", () => {
    // Half a minute quiet, a word, then half a minute quiet again is not a minute of
    // silence: somebody was there. Resetting the run is what keeps the warning about
    // something being wrong rather than about a quiet meeting.
    const measure = measureSignal(
      [...silence(30_000), ...speech(2_000), ...silence(30_000)],
      FRAME_MS,
    );
    expect(measure.hadSilentWindow).toBe(false);
    expect(measure.hadAnySignal).toBe(true);
  });

  it("measures the audio, not the fact that bytes were written", () => {
    // Digital silence still encodes to bytes, and the encoder ran perfectly for both
    // of the empty artifacts. A level of exactly zero has to read as silence.
    expect(rmsOf(new Float32Array(WINDOW))).toBe(0);
    expect(measureSignal(silence(120_000), FRAME_MS).hadAnySignal).toBe(false);
  });

  it("hears a recording that holds only one short exchange", () => {
    // An hour of quiet around two seconds of speech is a real meeting with a real
    // decision in it. The bar for "there was sound" is deliberately near the floor,
    // because getting this wrong in the strict direction discards the recording.
    const measure = measureSignal(
      [...silence(1_800_000), ...speech(2_000), ...silence(1_800_000)],
      FRAME_MS,
    );
    expect(measure.hadAnySignal).toBe(true);
    expect(measure.hadSilentWindow).toBe(true);
  });
});

describe("the sustained-silence warning the user sees mid-meeting", () => {
  it("says what to check without accusing the user of being muted", () => {
    // A user who starts recording before the meeting begins must not be told they
    // are muted when nothing is wrong, or the warning is spent before a real one
    // arrives. Approved copy, asserted verbatim.
    const warning = silenceWarning(null, "no signal for 45s");
    expect(warning.message).toBe(
      "No sound has reached the recording yet. If the meeting has started, check that it's playing through this computer and that you're unmuted.",
    );
    expect(warning.message).toBe(NO_SOUND_MESSAGE);
  });

  it("keeps the internal measure out of the sentence and in the detail", () => {
    const warning = silenceWarning(null, "no signal for 45s");
    expect(warning.detail).toBe("no signal for 45s");
    expect(warning.message).not.toContain("no signal for");
    expect(warning.message).not.toContain("rms");
  });

  it("reports the measure in seconds", () => {
    expect(noSignalDetail({ hadSilentWindow: true, hadAnySignal: false, silentForMs: 45_000 })).toBe(
      "no signal for 45s",
    );
  });

  it("never buries a microphone revocation under the vaguer silence message", () => {
    // Losing the microphone is a CAUSE of silence, so the silence warning would
    // routinely land a moment after the specific one and replace it — leaving the
    // user checking their speakers over a permission they can actually restore.
    expect(silenceWarning(MIC_REVOKED_WARNING, "no signal for 45s")).toBe(MIC_REVOKED_WARNING);
  });

  it("does replace an older warning that is not the microphone", () => {
    const stale = { message: "Recording stopped unexpectedly — restart it to keep recording." };
    expect(silenceWarning(stale, "no signal for 60s").message).toBe(NO_SOUND_MESSAGE);
  });

  it("lets a microphone that has just died overwrite a silence warning", () => {
    // The reverse direction: the microphone is newer and more actionable, and it
    // names the cause where silence only names the symptom. Nothing asks — the
    // handler assigns — and this is the assertion that the asymmetry is deliberate.
    const silent = silenceWarning(null, "no signal for 45s");
    expect(silenceWarning(silent, "no signal for 90s").message).toBe(NO_SOUND_MESSAGE);
    expect(MIC_REVOKED_WARNING.message).not.toBe(silent.message);
  });
});

describe("what Meeting End does with the measure", () => {
  it("refuses the audio only when a span was actually measured silent", () => {
    expect(refuseAudioAsSilent(false)).toBe(true);
    expect(refuseAudioAsSilent(true)).toBe(false);
  });

  it("never refuses audio that was never measured", () => {
    // Null means the offscreen document died before it could be asked. Declining to
    // transcribe audio nobody looked at would discard a real meeting; transcribing a
    // silent one costs a wait and is caught by the degenerate-output check anyway.
    expect(refuseAudioAsSilent(null)).toBe(false);
  });

  it("keeps a Meeting whose first span was silent and second was not", () => {
    // OR across spans, the opposite of the microphone's AND: one span holding the
    // conversation is enough to make the Meeting's audio worth transcribing.
    expect(foldAnySignal(null, false)).toBe(false);
    expect(foldAnySignal(false, true)).toBe(true);
    // And signal that arrived cannot un-arrive on a later silent span.
    expect(foldAnySignal(true, false)).toBe(true);
  });

  it("reports that nothing was captured when there are no captions either", () => {
    // The alternative is a Meeting that produced no file and no reason, leaving the
    // user to infer it. Naming both halves is what stops them hunting for a summary
    // that was never going to exist.
    expect(NOTHING_CAPTURED_WARNING.message).toContain("Nothing was captured");
    expect(NOTHING_CAPTURED_WARNING.message).toContain("no captions");
  });
});

describe("the Summary Artifact of a silent recording", () => {
  it("says the recording contained no speech rather than that none was made", () => {
    // Audio WAS recorded, and it held nothing. Reporting it as "no audio was
    // recorded" would send the reader looking for a broken engine.
    const html = renderArtifact("## TL;DR\nNothing was discussed.", {
      ...transcript(),
      provenance: "captions-only",
      noSpeech: true,
    });
    expect(html).toContain("no speech");
    expect(html).not.toContain("no audio was recorded");
  });

  it("never carries the internal measure into a document that gets forwarded", () => {
    // `detail` is for a tooltip and the log. The artifact is a file the user sends to
    // other people, and "no signal for 45s" is our vocabulary, not theirs.
    const html = renderArtifact("## TL;DR\nNothing was discussed.", {
      ...transcript(),
      provenance: "captions-only",
      noSpeech: true,
    });
    expect(html).not.toContain("no signal for");
    expect(html).not.toContain(NO_SOUND_MESSAGE);
  });
});
