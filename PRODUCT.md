# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are individual professionals who bring their own LLM access to their meetings:

- **BYO-LLM knowledge workers** who already pay for Claude, OpenAI, a local Ollama, or Bedrock and want to reuse that key for meeting notes instead of buying another meeting-AI subscription.
- **Restricted-org employees** who work where IT blocks cloud meeting-AI tools, but where a browser extension plus an approved (or fully local) LLM endpoint is permitted.

Both operate the product themselves, per-machine, without an admin deploying it for a fleet.

## Product Purpose

Capture the live captions of a browser-based meeting, and — when the meeting ends — turn that transcript into a written summary using an LLM the user already controls, delivered as a single self-contained local HTML file. It exists so meeting notes are possible without adopting the meeting platform's own cloud AI or a third-party SaaS transcriber. Success is: the user finishes a Teams meeting and, with no manual step, finds a usable summary in `Downloads/meeting-summaries/` that they trust because nothing left their machine except (optionally) the one LLM call they chose.

## Positioning

Scrapes live captions from the meeting client's DOM rather than calling any platform transcription API, and runs entirely as a pure WebExtension with no companion app or backend. The transcript exists only in extension memory/storage and is never persisted separately; the only retained output is a local HTML artifact. The LLM provider is the user's own (including fully local Ollama, in which case nothing at all leaves the machine). A neighboring meeting-notes product that relies on platform APIs, a cloud backend, or its own hosted model could not truthfully make the "nothing leaves your machine except your own LLM call" claim.

## Operating Context

- The user is in a live meeting in a supported platform's **web client** with **live captions turned on** (Teams first; Google Meet and Zoom web are phased-in later).
- The toolbar badge shows captured caption-segment count; a red `!` signals captions are off.
- Summarization triggers automatically on detected meeting end (call-ended DOM state or tab closed), or on demand via *Summarize now* in the popup.
- Two visual surfaces: the **popup** (status, manual trigger, held-transcript retry) and **Settings/options** (provider choice, API key, prompt templates). A third rendered output is the **Summary Artifact** HTML file.
- Provider setup has real-world friction the UI must account for: Ollama needs `OLLAMA_ORIGINS=moz-extension://*`; Bedrock needs a bearer API key (SigV4 credentials are not supported).

## Capabilities and Constraints

- Live-caption scraping and end-detection are owned by a per-platform **Platform Adapter**; platform support is phased (Teams → Google Meet → Zoom web).
- Summaries come in two user-selectable shapes driven by editable **Prompt Templates**: **structured** (TL;DR, decisions, action items with owners/dates, open questions — the default) and **narrative** (looser recap). Default templates answer in the transcript's language.
- Pure WebExtension caps, deliberately accepted (see `docs/adr/0001`): **no email delivery** (extensions can't speak SMTP); saves land **only** under `Downloads/meeting-summaries/` (the downloads API is the only write path); provider API keys live in `browser.storage.local` (no more secure store without a native host).
- A **Held Transcript** whose summarization failed is retained in storage for user-triggered retry (optionally after switching provider) and released only when its Summary Artifact is written — a dropped transcript is unrecoverable.
- Manifest V2, Firefox (`strict_min_version` 115.0). Providers: Anthropic (Claude), OpenAI, Ollama (local), AWS Bedrock.
- Domain terminology is fixed and defined in `CONTEXT.md` (Caption Segment, Transcript, Meeting, Platform Adapter, Meeting End, Provider, Summary, Prompt Template, Summary Artifact, Held Transcript).

## Brand Commitments

- Name: **Meeting Summarizer** (fixed).
- Identity is deliberately **utilitarian and no-nonsense** — a quiet local utility, not a marketed app. Future design work should keep it tool-like and unbranded rather than expressive.

## Evidence on Hand

Real, in-repo artifacts: working popup and options surfaces (`src/popup/`, `src/options/`), the Summary Artifact generator (`src/pipeline/artifact.ts`, `serialize.ts`), four provider integrations (`src/providers/`), the Teams adapter with DOM fixtures (`tests/fixtures/`), and architectural rationale in `docs/adr/`. No testimonials, customer names, usage metrics, benchmarks, pricing, or press exist — future work must not fabricate any.

## Product Principles

- **Nothing leaves the machine unbidden.** The single deliberate LLM call the user configured is the only network egress; with Ollama, none.
- **The user owns the model.** Bring-your-own provider and key, never a hosted model or subscription of ours.
- **No transcript is lost silently.** Failures hold the transcript for retry rather than dropping irrecoverable data.
- **Stay weightless.** Pure WebExtension, no companion app or backend; accept capability caps rather than add install weight.
- **Zero-step by default.** The summary should arrive on meeting end without the user having to remember to act.

## Accessibility & Inclusion

No product-specific requirement established. Follow standard good practice for the popup and settings surfaces.
