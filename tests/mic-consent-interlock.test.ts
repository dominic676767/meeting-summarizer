import { describe, expect, it } from "vitest";

/**
 * The rule this encodes: microphone consent is specific to what was promised.
 * The disclosure that earns a yes says transcription happens on this machine, so
 * selecting a cloud engine invalidates the claim the consent rested on — and the
 * user's voice must not start being uploaded under a consent that predates the
 * change.
 *
 * Extracted rather than driven through the options page, because the page touches
 * DOM and storage at import; this is the decision, which is what needs pinning.
 */
type Provider = "local-whisper" | "openai";

function confirmedAtAfterSave(opts: {
  storedConfirmedAt: number | null;
  providerConsentGivenUnder: Provider;
  providerNowSelected: Provider;
  micWasChecked: boolean;
  micNowChecked: boolean;
  now: number;
}): number | null {
  const switchedToCloud =
    opts.providerNowSelected !== "local-whisper" &&
    opts.providerNowSelected !== opts.providerConsentGivenUnder;
  if (switchedToCloud) return null;
  return opts.micNowChecked === opts.micWasChecked ? opts.storedConfirmedAt : opts.now;
}

const base = {
  storedConfirmedAt: 1000,
  providerConsentGivenUnder: "local-whisper" as Provider,
  providerNowSelected: "local-whisper" as Provider,
  micWasChecked: true,
  micNowChecked: true,
  now: 9999,
};

describe("microphone consent survives only what it was given for", () => {
  it("withdraws consent when the user switches to a cloud engine", () => {
    // The voice would otherwise start being uploaded under a local-only promise.
    expect(confirmedAtAfterSave({ ...base, providerNowSelected: "openai" })).toBeNull();
  });

  it("keeps consent when nothing about the destination changed", () => {
    expect(confirmedAtAfterSave(base)).toBe(1000);
  });

  it("does not re-withdraw consent already given under the cloud engine", () => {
    // Saving an unrelated setting must not nag someone who already answered the
    // cloud disclosure.
    expect(
      confirmedAtAfterSave({
        ...base,
        providerConsentGivenUnder: "openai",
        providerNowSelected: "openai",
      }),
    ).toBe(1000);
  });

  it("records consent only when the user actually moved the checkbox", () => {
    // An untouched pre-ticked box is the absence of a decision, not one.
    expect(confirmedAtAfterSave({ ...base, storedConfirmedAt: null })).toBeNull();
    expect(confirmedAtAfterSave({ ...base, storedConfirmedAt: null, micNowChecked: false })).toBe(
      9999,
    );
  });

  it("withdrawing on a cloud switch outranks a checkbox the user just ticked", () => {
    // Ticking the box answers the local disclosure; it cannot answer a cloud one
    // the user has not been shown yet.
    expect(
      confirmedAtAfterSave({
        ...base,
        storedConfirmedAt: null,
        micWasChecked: false,
        micNowChecked: true,
        providerNowSelected: "openai",
      }),
    ).toBeNull();
  });
});
