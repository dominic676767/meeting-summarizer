# Context: meeting-summarizer

A lightweight Chromium extension (pure JS/TS) that records a browser meeting's tab audio, transcribes it with a user-chosen transcription engine, fuses the words with scraped live captions for speaker attribution, summarizes the meeting with a user-chosen LLM when the meeting ends, and delivers the summary as a local HTML file.

## Glossary

### Caption Segment

One unit of live-caption text scraped from the meeting client's DOM: speaker name + utterance text + capture timestamp. From v2 its **words are no longer the source of truth** — it is the Speaker Track's raw material (see [[Speaker Track]]).

### Audio Recording

The captured audio for one Meeting: its [[Capture Span]]s, encoded incrementally to browser-managed storage (never held whole in memory). The source of truth for *what was said*. Every span of it is discarded once the Summary Artifact is written.

Two streams, summed: the meeting tab (the remote participants) and the local microphone (the user's own voice). Tab audio alone is only half the meeting — the tab carries what comes *out* of it, and no meeting client echoes your own voice back to you — so a recording without the microphone is missing the user's whole side of the call (ADR-0007). The microphone is off by default, and is opened only when the switch is on *and* the disclosure has been answered: two gates, both set by the one act of answering, because the safe state must not rest on either one alone — anything that reaches around the disclosure still finds the switch off, so the failure mode is silence rather than surveillance. Where it is refused or switched off the recording degrades to the remote participants alone and says so on the Summary Artifact.

### Capture Span

One stretch of audio recorded between a [[Capture Start]] and the next stop — its own file, with its own offset from the Meeting start (ADR-0005). A Meeting has as many spans as the user started capture times, because they may keep a sensitive stretch off the record and resume afterwards. At Meeting End every span is transcribed in order and the resulting Utterances concatenated, each shifted by its own span's offset so timings stay absolute relative to the Meeting. The gap between two spans is not missing data: it is audio the user chose not to record, and nothing is invented to fill it.

### Speaker Track

The ordered Caption Segments of one Meeting, used only for *who spoke when* — speaker names and timings. Retained because raw audio transcription yields anonymous diarization ("Speaker 1") and action items need real owners.

### Utterance

One transcribed span of speech: text, start/end offsets relative to the Meeting start, and an optional diarization label from the Transcription Provider. The Transcription Provider's output unit.

### Fused Transcript

The Transcript produced by attributing Utterances to speakers by overlapping their time ranges with the Speaker Track. Accurate words (from audio) plus real names (from captions). Replaces the caption-only Transcript as the pipeline's input.

### Transcript

The ordered, speaker-attributed record of one Meeting that the summarization pipeline consumes. In v2 this is a Fused Transcript; where audio is unavailable it degrades to the caption-only form (see [[Degraded Capture]]). Never stored as a separate file. Not the meeting platform's official cloud transcript, which this project never touches.

### Degraded Capture

A Meeting whose Transcript falls back to caption words alone: no Audio Recording exists (the user never started capture, or capture failed), or one exists but no audio words came out of it — transcription failed, the user skipped the wait, or it was a [[Silent Recording]]. The Summary Artifact states plainly that it was produced from captions, not audio.

### Silent Recording

An Audio Recording whose transcription output is refused for carrying no speech, so it never counts as audio words. Fed silence a Transcription Provider does not return nothing: it returns filler — Whisper's canonical artifact is the single word "you" — and unchecked that one token is stamped as recorded audio and replaces the caption words wholesale. So degenerate output is rejected before fusion, judged on the recording's duration and the substance of its content rather than a word count, and the Meeting keeps its caption words (a [[Degraded Capture]] with a reason).

A third outcome beside success and failure, and it must stay distinguishable from both: nothing failed, so it is never reported as a transcription error, and unlike a [[Held Recording]] it is not kept for retry — retrying silence only reproduces silence.

### Meeting

One session in a supported platform's web client, from capture start to detected Meeting End. Platform support is phased: Teams first, then Google Meet, then Zoom web.

### Platform Adapter

The per-platform module that knows how to find caption elements in that platform's DOM and how to detect Meeting End. One adapter per supported platform.

### Capture Start

The user-initiated moment recording begins. Chromium's `tabCapture` requires an explicit extension invocation, so this cannot be automatic; the extension prompts when it detects a Meeting.

### Meeting End

The auto-detected condition (call controls disappearing, call-ended DOM state, or tab closed) that stops the Audio Recording and triggers transcription then summarization. Detection logic is owned by the Platform Adapter.

### Transcription Provider

The user-selected engine that turns an Audio Recording into Utterances. Distinct from [[Provider]] — most LLM backends have no speech-to-text API. Local WASM Whisper is the default (nothing leaves the machine); cloud engines are opt-in.

### Meeting Language

The language the user declares their meetings are spoken in, passed to whichever [[Transcription Provider]] is selected as its language hint. Declared rather than detected: nothing in the pipeline detects it, and an engine given no hint silently assumes English — so an undeclared German meeting comes back *mistranscribed*, and the Prompt Templates then faithfully summarize the wrong words. It describes the Meeting, not the engine, so it is one setting rather than one per engine.

### Provider

The user-selected LLM backend that turns a Transcript into a Summary. Candidates: Claude (Anthropic API), OpenAI, Ollama (local), AWS Bedrock.

### Summary

The LLM-generated digest of one Meeting, in one of two user-selectable shapes: **structured** (TL;DR, decisions, action items with owners/dates, open questions — the default) or **narrative** (looser recap). Shape is driven by user-customizable prompt templates.

### Prompt Template

The user-editable text sent to the Provider to produce a Summary. One template per summary shape.

### Summary Artifact

The single persistent output of a Meeting: a local HTML file containing the Summary plus the full Transcript in a collapsible section. Nothing else is retained after it is written.

### Held Transcript

A Transcript whose summarization failed (Provider error, etc.). It is retained in extension storage for user-triggered retry rather than discarded — a Transcript is unrecoverable once dropped. A Held Transcript is released only when its Summary Artifact is successfully written.

### Held Recording

An Audio Recording whose *transcription* failed. Retained for retry for the same reason as a [[Held Transcript]]: the meeting is unrecoverable once its audio is dropped. Covers **every** [[Capture Span]] of the Meeting, so a retry transcribes all of them rather than the last stretch alone. Released only once transcription succeeds and its Transcript takes over the retry chain.
