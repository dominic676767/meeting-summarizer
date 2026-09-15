# Mixing the local microphone into the recording

**This corrects ADR-0004.** That ADR said transcript words come from "recorded tab audio" and treated tab audio as the meeting's audio. It is not: `chromeMediaSource: "tab"` captures what comes *out* of the tab, which is the remote participants, and Teams never echoes the local user's own voice back to them. So tab audio is at best half of a 1:1 meeting, and in a call where the local user does the talking it is silence.

Two Summary Artifacts made the cost visible. Each ran 27s and 41s, each was stamped "from recorded audio · speakers not identified", and each contained exactly one Utterance: the single word "you" — Whisper's canonical output when fed silence. The summary body was the LLM apologising that there was nothing to summarize. ADR-0004's own rejected option, "mic-only capture via `getUserMedia` — captures only the local user, not the meeting", was right about mic-only and wrong to conclude that tab-only was therefore the meeting.

So one Audio Recording is now the **sum of both**: the tab stream and a `getUserMedia` microphone stream, summed in one `AudioContext` into one `MediaStreamAudioDestinationNode`, which is what the MediaRecorder records.

## Why one graph rather than two recorders

Utterance offsets are absolute ms from the Meeting start, and fusion attributes speech by overlapping them against the Speaker Track. Two independently started MediaRecorders would drift — different start instants, different clocks — and drift there does not look like drift. It looks like the wrong person having said something, silently, in an artifact whose whole purpose is telling the reader who owns which action item. One graph, one destination, one recorder is what makes alignment a property of the shape rather than something to keep checking.

It also keeps ADR-0005 intact: one file per Capture Span, and each span's mix is built and torn down with its own recorder.

## The microphone is recorded, never played

The tab source keeps its connection to `context.destination`, because `tabCapture` stops the tab's own playback and without it the user hears silence for the whole call (ADR-0004). The microphone source is connected to the recording destination **only**. Connecting it to the speakers as well would echo the user to themselves through their own headphones — a defect, and one that is completely invisible in the resulting file, which is why the mix is a pure function over an injected graph (`src/offscreen/audio-mix.ts`) whose test asserts where each source went rather than what came out.

Browser echo cancellation is on for the microphone. The two streams also overlap physically: the remote participants come out of the user's speakers and back in through their microphone, and uncancelled that puts them in the recording twice, a room-delay apart — worse for a transcription engine than either copy alone.

## Privacy: an escalation, treated as one

Recording somebody's microphone is a larger step than recording a tab they chose to record, and this tool is meant for members of the public. Two facts shape the decision:

1. **A meeting summarizer that cannot hear its own user is broken.** Half the conversation missing is not a degraded mode, it is a wrong answer with a confident tone. So the setting ships **on**.
2. **An offscreen document cannot show Chromium's permission prompt.** It has no UI, so `getUserMedia` there cannot raise one; the extension declares `audioCapture`, which grants the microphone to its own pages without a prompt. That removes the browser's disclosure, so the extension has to be the disclosure. There is no version of this where the user is told by somebody else.

Hence: on by default, but **never before the user has answered a disclosure**. `micCapture.confirmedAt` is null on a fresh install and on upgrade, and a Capture Start in that state records tab audio only. The popup asks once, in two plainly-labelled buttons — "Record my microphone" and "Other participants only" — and either answer settles it, because declining is a decision and a user who declined must not be nagged. Saving the Settings page counts as an answer too, since the checkbox's note is the same disclosure.

Recording never waits on this, and never fails on it. An unanswered disclosure, a denied permission, and a machine with no input device all land in the same place: today's tab-only capture, plus a warning that says which of the three happened. Losing the local user's words is bad; losing the meeting is the one outcome this product may not produce.

## Consequences

- **"From recorded audio" needed a second clause.** An artifact that recorded only the remote participants now carries `local microphone not recorded` in its Meta line. Absent reads as not-recorded, so a Held Transcript from before this change tells the truth about itself rather than inheriting the better claim. The clause is suppressed on a caption-only artifact, where no audio was recorded at all and the Meta line says so already.
- **The claim is folded with AND across Capture Spans.** A Meeting recorded in three stretches of which one had no microphone does not contain the whole of the local user's side of it, so it does not claim to. Rounding up here would be the same overclaim this ticket exists to remove, one level down.
- **The recording indicator names the microphone in words.** "Recording, microphone on — 1:23" against "Recording, microphone off — 1:23", both as Ink text beside the red dot. No second colour and no glyph: under the Text-or-Dot Rule red type is a warning to act on, and microphone-off is a setting the user chose, not a fault. The two microphone states that *are* actionable — never answered, and asked for but refused — take the status line as weight-600 red instead, above the no-captions warning, because missing captions cost the names on the action items while a missing microphone costs half the words.
- **Disclosure lands on the surface before the gesture.** The in-page summons card states what the microphone will do, because that is the surface the user reads immediately before pressing the shortcut. The popup's Start path says the same thing.
- **`audioCapture` is a new manifest permission**, so an already-installed extension is disabled pending the user's re-approval on update. Unavoidable, and honest: the permission genuinely is new.
- **None of this is covered by a browser test.** The mix graph, the state machine, and the artifact clause are all tested at pure seams with injected fakes. Whether two people's voices actually land in one decodable file can only be established in a real two-party meeting, and must be re-checked there whenever this graph changes.

## Considered options

- **Keep tab-only and warn that the local user is missing** — rejected: it makes the tool's central failure a documented feature. The user cannot fix it from their side; only the recorder can.
- **A second MediaRecorder on the microphone, transcribed as a second track** — rejected: two containers, two clocks, and a fusion step that would have to align them against nothing. It buys the ability to tell the two apart, which the Speaker Track already provides by name.
- **`getDisplayMedia` with system audio instead of a microphone** — rejected: it captures whatever else is playing on the machine, needs a per-call picker the user must not be asked to operate mid-meeting, and on macOS it captures no system audio at all.
- **Mic capture off by default, opt-in** — rejected as the primary default: it ships a summarizer that is quietly wrong for every user who never finds the switch. The disclosure gate is what makes on-by-default defensible, and it is deliberately not the same thing as opt-in — the box is already ticked, and the user is confirming rather than discovering.
- **Ask for the microphone on every Capture Start** — rejected: a per-meeting prompt during the first minute of a call is a prompt that gets dismissed on reflex, which is worse disclosure than one considered answer.
