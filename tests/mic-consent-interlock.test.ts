// Microphone consent survives only what it was given for. The rule and its
// reasoning live on micConsentAfterSave, which the options page calls; this
// pins that function, not a copy of it (#33).
import { describe, expect, it } from "vitest";
import type { TranscriptionProviderId } from "../src/domain/types";
import { micConsentAfterSave as confirmedAtAfterSave } from "../src/background/mic-capture";

type Provider = TranscriptionProviderId;

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

  it("withdraws consent given under one cloud engine when the user picks another", () => {
    // A yes to "uploaded to OpenAI" is not a yes to "uploaded to ElevenLabs"
    // (ADR-0008 amends ADR-0007 here).
    expect(
      confirmedAtAfterSave({
        ...base,
        providerConsentGivenUnder: "openai",
        providerNowSelected: "elevenlabs",
      }),
    ).toBeNull();
  });

  it("withdraws consent when the user picks SageMaker, which is a destination of its own", () => {
    // The user's own AWS account is still not the vendor the consent named.
    expect(
      confirmedAtAfterSave({
        ...base,
        providerConsentGivenUnder: "elevenlabs",
        providerNowSelected: "sagemaker",
      }),
    ).toBeNull();
  });

  it("keeps consent when the user moves back to the local engine", () => {
    // Nothing leaves the machine any more, so no promise the consent rested on
    // has been broken.
    expect(
      confirmedAtAfterSave({
        ...base,
        providerConsentGivenUnder: "openai",
        providerNowSelected: "local-whisper",
      }),
    ).toBe(1000);
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
