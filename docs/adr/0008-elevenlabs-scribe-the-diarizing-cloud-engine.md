# ElevenLabs Scribe, the diarizing cloud engine

ADR-0004 kept captions as the Speaker Track because transcription engines return anonymous diarization at best, and it gave the Utterance an optional diarization label for the engine that does. No engine did. Local Whisper and OpenAI's `whisper-1` return words and timings but not who spoke, so every Utterance no caption turn overlapped became *Unknown speaker*. That happens whenever captions lag, drop a line, or were never turned on.

ElevenLabs Scribe returns a speaker id with every word. So it is added as a third Transcription Provider, opt-in exactly like OpenAI: nothing is uploaded until the user selects it and enters its own key. Fusion is unchanged. A caption name still wins wherever one overlaps, and only where none does does the Utterance fall back to Scribe's label. A name is still never invented: "Speaker 2" is what the engine heard, not a guess at who it was.

## The labels hold only within one request

Scribe's `speaker_0` in one upload and `speaker_0` in the next need not be the same person. Everything else in this decision follows from that.

- **The engine renumbers labels "Speaker 1", "Speaker 2"… by first appearance** and keeps nothing of Scribe's own ids, which mean nothing outside the request.
- **The wrapper, not the engine, makes labels distinct across requests.** It is the only place that knows there was more than one. Once a recording takes several engine calls, every label names its part ("Speaker 1 (part 2)"), numbered across Capture Spans. Two people then never share one label, at the cost of one person sometimes carrying two. That is the right way round: two labels for one voice is a transcript a reader can reconcile, and one label for two voices silently merges their words. This lives in the wrapper so that any later diarizing engine inherits it, and an engine that does not diarize is untouched.
- **Scribe uploads an hour per request**, against OpenAI's ten minutes. Scribe accepts far more than an hour, but each extra window is another place one person's label can split. An hour covers most Capture Spans in a single call.

## What a long request broke

A window that long made two existing gaps matter.

- **Cancel was checked only between windows.** "Use captions" would have waited out an hour's upload before anything happened. `TranscriptionEngine.transcribe` now takes the user's signal, and both cloud engines pass it into their fetch. The wrapper treats whatever an engine throws after that signal fired as the user skipping the wait, not as a failure to hold the Recording for.
- **Nothing timed out.** A stalled upload would spin forever. Scribe gives up after a minute plus the window's own duration, as a `TranscriptionError`, so the Recording is held for a retry. OpenAI keeps no timeout for now, because adding one changes behaviour that shipped in #17. It deserves its own decision.
- **Progress had nothing to report** until a whole upload came back. So while a cloud engine has reported nothing, the popup says the audio is being uploaded to it. That is true for the whole wait, where a percentage would be invented.

## Consent: contradicts ADR-0007, but only its text

ADR-0007 says switching between cloud engines does not re-ask for microphone consent. The code has always re-asked whenever the selected engine is a cloud one different from the one consent was given under. With one cloud engine the two never disagreed; with two they do.

The code is kept, and ADR-0007 is amended to match it. ADR-0007's own rule is that the cloud disclosure must name the destination, because "the cloud" is not one. A yes to "uploaded to OpenAI" is not a yes to "uploaded to ElevenLabs": it is a different company with different terms, and a user who trusts one need not trust the other. So consent is withdrawn whenever the destination changes, including from one cloud engine to another. The nagging ADR-0007 wanted to avoid is one extra question, asked only on a deliberate switch. That is the same trade ADR-0007 already made when it chose failing toward one extra ask over failing toward an upload nobody agreed to.

## Consequences

- **Every surface that names an engine reads one Record over the engine ids.** Those surfaces are the options page's microphone disclosure, the popup's, the "uploading to…" status, and the engine line in a Summary Artifact. Before this change the names were written out separately as two-way choices, so a third engine would have been called "local Whisper" in a saved summary and left the disclosure saying OpenAI. Adding an engine without naming it is now a compile error.
- **The settings panel promises nothing about retention.** It says ElevenLabs may keep the audio under its own terms. Zero-retention is an enterprise option this project cannot assume a user has.
- **The declared Meeting Language is sent as Scribe's `language_code`**, like every engine's hint. Scribe can detect language itself, but the Meeting Language is one declaration for the whole Meeting precisely so that no engine guesses per window.
- **Audio is uploaded as bare 16 kHz PCM** rather than WAV. The PCM encoding moved to its own module so the two cloud engines cannot drift on clamping or rounding.
- The extension's host permissions gain `https://api.elevenlabs.io/*`.

## Considered Options

- **Keep OpenAI's ten-minute windows** — rejected. Labels would reset every ten minutes with nothing to mark it, so "Speaker 1" at minute nine and at minute eleven could be two people read as one.
- **One request per Capture Span, uncapped** — rejected. A span has no upper length, and neither would a request's duration, so no timeout could be set that was both generous enough and ever likely to fire.
- **Map diarization labels to caption names** (if Speaker 2 mostly overlaps Aisha's turns, call all of Speaker 2 Aisha) — deferred. It is the largest gain in attribution this engine makes possible, but it changes fusion's rules about when a name may be applied, and that deserves its own decision rather than riding in with an engine.
- **Record microphone and tab as separate channels** and let Scribe transcribe each — deferred. It would make the local user always attributable, but it reverses ADR-0007's single mixed stream and touches the recorder.
- **ElevenLabs' single-use tokens instead of the API key** — not needed. They exist so a website need not ship a secret to every visitor's browser. Here the key is the user's own, entered by them and stored in extension storage beside the others (ADR-0001).
