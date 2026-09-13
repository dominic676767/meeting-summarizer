# Context: meeting-summarizer

A lightweight Firefox WebExtension (pure JS/TS) that scrapes live captions from browser-based meeting clients, summarizes the meeting with a user-chosen LLM when the meeting ends, and delivers the summary.

## Glossary

### Caption Segment

One unit of live-caption text scraped from the meeting client's DOM: speaker name + utterance text + capture timestamp. The raw material everything else is built from.

### Transcript

The ordered accumulation of Caption Segments for one Meeting. Exists only in memory/extension storage until the Summary Artifact is written; it is never stored as a separate file. Not to be confused with the meeting platform's official cloud transcript, which this project never touches.

### Meeting

One captioned session in a supported platform's web client, from first captured Caption Segment to detected meeting end. Platform support is phased: Teams first, then Google Meet, then Zoom web.

### Platform Adapter

The per-platform module that knows how to find caption elements in that platform's DOM and how to detect meeting end. One adapter per supported platform.

### Meeting End

The auto-detected condition (call-ended DOM state or tab closed) that triggers summarization. Detection logic is owned by the Platform Adapter.

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
