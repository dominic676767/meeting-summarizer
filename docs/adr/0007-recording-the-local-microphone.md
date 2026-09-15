# Recording the local microphone

ADR-0004 treated "tab audio" as the meeting's audio. It is only half of it. `tabCapture` yields what comes *out* of the tab — the remote participants — and the meeting client never echoes the local user's own voice back to them, so the user's every contribution was missing from every Audio Recording. In a 1:1 meeting that is half the conversation; in a solo test it is all of it, and the recording is pure silence.

So the extension now also captures the microphone via `getUserMedia` and sums both streams through one `AudioContext` into a single recording. One graph means one clock, which is what keeps Utterance offsets absolute so fusion against the Speaker Track still attributes correctly. The microphone is recorded but never connected to the speakers — the tab is, or the meeting goes silent (ADR-0004) — because looping the mic back would make the user hear themselves.

This was found the worst way: two Summary Artifacts stamped "from recorded audio" whose entire transcript was the single word "you", Whisper's canonical hallucination on silence. The recordings were silent because the user was the one talking.

## The privacy escalation, and why the default is off

Recording somebody's microphone is categorically different from recording a tab. It is the one escalation here that cannot be taken back, it triggers a permission prompt, and this extension is meant for members of the public.

**`micCapture.enabled` therefore defaults to `false`, and a disclosure the user answers turns it on.** The tempting alternative — default `true`, gated on a separate `confirmedAt` confirmation — was rejected: it makes the safe state depend on a second mechanism holding, so anything that reaches around the gate (a refactor dropping the check, or a user saving the options page for an unrelated reason) starts recording a microphone without consent. Off by default fails to silence rather than to surveillance.

**Consent is recorded only when the user actually moves the checkbox.** Leaving a box as you found it is the absence of a decision, not a decision — which is exactly why pre-ticked consent boxes are the pattern regulators single out. Saving the options page to change a summary shape must never be read as answering the microphone disclosure.

## Consequences

- **A microphone is a fourth thing that can end on its own**, on top of the three ADR-0005/e39cd25 cover, and it is the only one a user can revoke deliberately mid-meeting from Chrome's site controls. That does not end the Meeting — the remote participants are still being captured — but the span stops holding the local user, so `localMicrophone` goes false and the user is warned while they can still act.
- **`localMicrophone` is folded with AND across Capture Spans.** A Meeting where one stretch was recorded without the microphone does not contain the whole of the local user, and the Summary Artifact must not imply it does.
- **A denied or absent microphone degrades to tab-only capture with a warning**, never a failed recording. Half a meeting beats none.
- **The disclosure copy cannot claim the audio stays on this machine** — that is false whenever the cloud Transcription Provider is selected, which is precisely the case where recording your own voice matters most. The copy has to be conditional on the selected engine.

## Considered Options

- **Tab audio only** — the status quo this replaces. Silently omits the user from their own meeting summaries.
- **Microphone only** — already rejected in ADR-0004, and rightly: it captures the local user and no one else. The error there was concluding tab-only was therefore the meeting.
- **Default `enabled: true` behind a confirmation gate** — rejected above: fail-unsafe.
