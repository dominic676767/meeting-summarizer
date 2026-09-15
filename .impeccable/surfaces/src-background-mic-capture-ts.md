---
version: 1
slug: "src-background-mic-capture-ts"
primary_target: "src/background/mic-capture.ts"
related_targets: ["src/content/capture-prompt.ts","src/popup/popup.html"]
---

Scope: the microphone disclosure — the one surface where the user learns their own voice will be recorded, and says yes or no. Visitor mode: Operate.

Audience: a member of the public who installed a meeting summarizer. They did not come here to think about microphone permissions, and they will not read a settings page to discover one. Some of them are the restricted-org employees in PRODUCT.md, for whom recording their own voice may be a policy question rather than a preference.

Why this surface has to exist before the feature works: `shouldCaptureMic` requires `enabled && confirmedAt !== null`, and nothing in the product can currently set `confirmedAt`. Until this lands, the microphone is permanently inert and the `unconfirmed` state has no way out. It is the blocker, not a polish pass.

## What is already true in the implementation

Verified in source, and the implementation is right about all of it — the brief must not weaken any of it:

- **Consent gates capture, not just presentation.** `shouldCaptureMic` returns false while `confirmedAt` is null, so no microphone audio is recorded before an answer. `enabled: true` in defaults is a *pre-set preference*, not permission.
- **`MicCaptureState` is a five-way axis**, not a boolean: `off`, `unconfirmed`, `armed`, `recording`, `unavailable`. Only `unconfirmed` and `unavailable` are actionable.
- **A live microphone outranks the settings toggle.** Flipping the switch off mid-Meeting reports `recording`, not `off`, because the recorder still has it open. Never let the indicator claim otherwise.
- **`foldLocalMicrophone` uses AND across spans**, so a Meeting recorded in three spans where one had no microphone does not claim the local user was captured.
- **A refused microphone degrades, never fails.** Tab-only capture continues; a missing microphone costs half the words, never the meeting.

## Direction contract

THESIS: Ask before the first recording, in the surface the user is already looking at, in one sentence that says what will be recorded and what happens if they decline. This surface owns informed consent, and it refuses two category defaults: the settings-page toggle nobody finds, and the modal that blocks the meeting to extract a yes.

OWN-WORLD: The Status Readout, unchanged. No new color: the disclosure is Ink text with a Muted explanation, and the two answers are ordinary native buttons. A permission request is not a warning, so it never takes Alert Red — red here would read as "something is wrong", when nothing is.

STORY: The visitor understands that their own voice is not in the recording yet and what including it buys, believes declining is a real option with a stated consequence, and answers once — after which they are never asked again.

FIRST VIEWPORT: In the in-page capture prompt, directly above the shortcut, because that is the surface read immediately before invoking capture — told before it starts, not discovered afterwards. One Ink line, one Muted line, two buttons. The popup carries the same disclosure for users who start capture from the toolbar. Once answered, both revert to the ordinary prompt permanently.

FORM: An extension of two established surfaces, so no direction roll and no seed key. Ordered first of one candidate: disclosure inline in the pre-capture surface, because a settings toggle is not disclosure and a modal is not a choice.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Copy

Disclosure, shown while `mic` is `unconfirmed`:

> **Include your microphone?**
> Your voice is not recorded yet. Including it means the summary covers your side of the meeting too — everything is transcribed on this machine.
> `[ Include my microphone ]` `[ Tab audio only ]`

Rules:

- **Name what is recorded, not the permission.** "Include your microphone" is the user's frame; "grant microphone access" is Chromium's.
- **State the consequence of declining, and make it liveable.** "Tab audio only" is a complete, working mode, not a degraded one — the button says what it does rather than "No thanks", which frames declining as a refusal to cooperate.
- **Keep the privacy fact in the same breath as the ask.** "everything is transcribed on this machine" is the reason a member of the public can say yes, and it is true (local Whisper default). If a cloud Transcription Provider is selected, this sentence must change — see Unresolved.
- **Either answer confirms.** Both buttons set `confirmedAt`; the notice never asks twice. A user who declines has decided, not deferred.
- **Never pre-empt Chromium's own permission prompt with a fake one.** This disclosure explains; the browser still asks.

Per-state lines for the surfaces:

| `MicCaptureState` | Line | Treatment |
|---|---|---|
| `off` | nothing | Silent — a deliberate choice needs no notice |
| `unconfirmed` | the disclosure above | Ink + Muted, two buttons |
| `armed` | "Your microphone will be included." | 12px Muted, under the shortcut |
| `recording` | the recording dot line, unchanged | Text-or-Dot Rule; the dot already means live |
| `unavailable` | "Your microphone could not be used — recording the meeting audio only." | 12px Muted, raw reason in `title` |

`unavailable` is Muted, not red: it is a fact about this recording, not something the user can fix mid-meeting, and the meeting is still being captured. Raw Chromium errors never reach the visible line.

## Artifact consequence

`localMicrophone` on `Transcript` changes what the Summary Artifact may claim, so it belongs in the provenance clause specced in `src-pipeline-artifact-ts.md`. A recording that captured only the remote participants must not read as though the whole room was recorded. Suggested clause extension, to be settled with that brief rather than invented here: append "· your side not recorded" when `localMicrophone` is false and audio words were used.

## Unresolved — for the user, not for an agent

- **Should `enabled` default to `true`?** It is a pre-set preference behind a real consent gate, and the implementation's reasoning is sound (a meeting summarizer that cannot hear its own user is broken). But it does mean the disclosure arrives with the answer already leaning yes. Defensible either way; the user decides.
- **Cloud transcription invalidates consent already given — see the section below.** A conditional sentence is not enough.
- **ADR-0007 is cited in `mic-capture.ts` but does not exist** (`docs/adr/` ends at 0006, a numbering collision with the ONNX runtime ADR). A privacy escalation with no recorded rationale is the gap; the ADR needs writing by whoever owns that decision.

## The cloud interlock

The disclosure's yes is earned by one sentence: everything is transcribed on this machine. That sentence is what makes handing over a microphone reasonable for a member of the public. It is false whenever a cloud Transcription Provider is selected — and that is precisely when recording your own voice matters most.

**Making the copy conditional does not fix this.** Consent is collected at one moment; the Transcription Provider is a dropdown on a different page, changed on a different day. A user who says yes under the locality promise, then later switches to a cloud engine, has their microphone audio uploaded without anything re-asking. The consent stays on file while the claim that earned it quietly stops being true. Accurate-at-the-time is not the same as accurate.

**Recommended mechanism** (spans this brief's copy, the Settings page, and `confirmedAt`, so it is recorded here rather than decided here): selecting a cloud engine while `micCapture.confirmedAt !== null` **clears the confirmation**, so the next Meeting re-asks with copy that states the audio leaves the machine. This makes consent specific to what was actually promised, and it fails toward silence — tab-only capture — rather than toward an upload nobody agreed to. The cost is one re-ask, which a user will find reasonable precisely because the thing they agreed to changed.

Two copy variants, then. Local engine (the default), as specced above. Cloud engine selected:

> **Include your microphone?**
> Your voice is not recorded yet. Including it means the summary covers your side of the meeting too — and because you have chosen {engine} to transcribe, the recording, including your voice, is uploaded to {engine} to be transcribed.
> `[ Include my microphone ]` `[ Tab audio only ]`

Rules for the cloud variant:

- **Name the destination, not the category.** "uploaded to OpenAI" is the fact; "sent to the cloud" is a euphemism that lets the reader imagine something vaguer than what happens.
- **Say it in the same sentence as the benefit**, not as a footnote beneath it. A disclosure whose cost is set below the fold in smaller type is a disclosure designed to be skipped.
- **Do not soften with reassurance the product cannot make.** No retention claims, no "only for transcription" — the product does not control what a third-party engine does with the audio, so it must not imply it does.
- Still Ink and Muted, still not Alert Red: this is a factual consequence, not a warning. The gravity comes from the sentence, not the colour.

Whether the clearing mechanism ships is a consent decision for the user, not an agent call. Until it is settled, the honest fallback is the conditional copy above — better than a false promise, still weaker than a re-ask.
