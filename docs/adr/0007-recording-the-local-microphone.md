# Recording the local microphone

ADR-0004 treated "tab audio" as the meeting's audio. It is only half of it. `tabCapture` yields what comes *out* of the tab — the remote participants — and the meeting client never echoes the local user's own voice back to them, so the user's every contribution was missing from every Audio Recording. In a 1:1 meeting that is half the conversation; in a solo test it is all of it, and the recording is pure silence.

So the extension now also captures the microphone via `getUserMedia` and sums both streams through one `AudioContext` into a single recording. One graph means one clock, which is what keeps Utterance offsets absolute so fusion against the Speaker Track still attributes correctly. The microphone is recorded but never connected to the speakers — the tab is, or the meeting goes silent (ADR-0004) — because looping the mic back would make the user hear themselves.

This was found the worst way: two Summary Artifacts stamped "from recorded audio" whose entire transcript was the single word "you", Whisper's canonical hallucination on silence. The recordings were silent because the user was the one talking.

## The privacy escalation, and why the default is off

Recording somebody's microphone is categorically different from recording a tab. It is the one escalation here that cannot be taken back, and this extension is meant for members of the public.

**And the browser will not ask on our behalf.** An offscreen document has no UI, so `getUserMedia` cannot raise Chromium's own permission prompt there; the extension declares `audioCapture`, which grants the microphone to its own pages without prompting. That removes the browser from the loop entirely — there is no version of this where somebody else tells the user. The extension's own disclosure is not a courtesy on top of a system prompt, it is the only disclosure that exists, which is why its wording and its consent semantics carry the whole weight.

**`micCapture.enabled` therefore defaults to `false`, and a disclosure the user answers turns it on.** Answering is one act that writes both `enabled` and `confirmedAt`, and capture needs both; they are separate fields because consent can be withdrawn on its own (below) while the switch stays on. The tempting alternative — default `true`, gated on a separate `confirmedAt` confirmation — was rejected: it makes the safe state depend on a second mechanism holding, so anything that reaches around the gate (a refactor dropping the check, or a user saving the options page for an unrelated reason) starts recording a microphone without consent. Off by default fails to silence rather than to surveillance.

**Consent is recorded only when the user actually moves the checkbox.** Leaving a box as you found it is the absence of a decision, not a decision — which is exactly why pre-ticked consent boxes are the pattern regulators single out. Saving the options page to change a summary shape must never be read as answering the microphone disclosure. This is the non-obvious half of the fail-safe design and the easiest thing for a later change to simplify away, so it is written down here rather than left to a comment: an untouched control confirms nothing, whatever the default happens to be.

**Consent is withdrawn when its premise changes.** The disclosure that earns a yes says the audio is transcribed on this machine. Selecting a cloud Transcription Provider afterwards makes that promise false, so `confirmedAt` is cleared and the user is asked again, naming the destination. Consent that was accurate when given is not the same as consent that is accurate now, and a voice recording uploaded under a week-old yes to a different question is not consented to. Switching between cloud engines does not re-ask — that would nag someone who has already answered the cloud disclosure — and a withdrawal outranks a checkbox the user has just ticked, because ticking answers the local disclosure and cannot answer a cloud one they have not been shown.

## Consequences

- **A microphone is a fourth thing that can end on its own**, on top of the three ADR-0005/e39cd25 cover, and it is the only one a user can revoke deliberately mid-meeting from Chrome's site controls. That does not end the Meeting — the remote participants are still being captured — but the span stops holding the local user, so `localMicrophone` goes false and the user is warned while they can still act.
- **`localMicrophone` is folded with AND across Capture Spans.** A Meeting where one stretch was recorded without the microphone does not contain the whole of the local user, and the Summary Artifact must not imply it does.
- **Recording never waits on the microphone and never fails on it.** An unanswered disclosure, a denied permission, and a machine with no input device all land in the same place — today's tab-only capture, plus a warning naming which of the three happened, because only one of them is something the user can fix. Losing the local user's words is bad; losing the meeting is the one outcome this product may not produce.
- **The disclosure copy cannot claim the audio stays on this machine** — that is false whenever the cloud Transcription Provider is selected, which is precisely the case where recording your own voice matters most. So the disclosure has two variants rather than one conditional sentence, and reaching it while a cloud engine is selected is itself the signal that the cloud variant is needed: local-engine consent is never cleared, so a user can only arrive there by having switched.
- **The cloud variant must name the destination.** "The cloud" is not a destination; OpenAI is. Copy that names the service, states the cost in the same sentence as the benefit, and makes no retention promise this project cannot keep, because we do not control what happens to audio once it leaves.

## Considered Options

- **Tab audio only** — the status quo this replaces. Silently omits the user from their own meeting summaries.
- **Microphone only** — already rejected in ADR-0004, and rightly: it captures the local user and no one else. The error there was concluding tab-only was therefore the meeting.
- **Default `enabled: true` behind a confirmation gate** — rejected above: fail-unsafe. The argument for it was that off-by-default ships a summarizer quietly wrong for every user who never finds the switch. That cost is real, and it is paid instead by making the disclosure prominent rather than by pre-ticking the box.
- **Ask for the microphone on every Capture Start** — rejected: a prompt during the first minute of a call is a prompt dismissed on reflex, which is worse disclosure than one considered answer.
