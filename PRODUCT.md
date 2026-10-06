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

Record a browser meeting's tab audio, transcribe it with a user-chosen transcription engine, fuse those words with scraped live captions so every line has a real speaker's name, and — when the meeting ends — summarize it with an LLM the user already controls, delivered as a single self-contained local HTML file. It exists so meeting notes are possible without adopting the meeting platform's own cloud AI or a third-party SaaS transcriber. Success is: the user clicks once to start capture, and after the call ends finds a usable summary in `Downloads/meeting-summaries/` whose words are what was actually said and whose action items name real owners — trusted because, with the default local transcription engine and a local LLM, nothing left their machine at all.

## Positioning

Summarizes what was actually said, not what the caption panel happened to show, while staying a pure extension with no companion app or backend. Words come from recorded tab audio; scraped captions are kept only as the Speaker Track supplying real owner names, because transcription engines return anonymous diarization ("Speaker 1"). Both the transcription engine and the LLM are the user's own, and the defaults (local WASM Whisper, optional local Ollama) mean a complete meeting can be captured, transcribed, and summarized with zero network egress. Neither the audio nor the transcript is persisted beyond the pipeline; the only retained output is a local HTML artifact. A neighboring meeting-notes product built on platform APIs, a cloud backend, or its own hosted model could not truthfully make the "nothing leaves your machine" claim.

## Operating Context

- The user is in a live meeting in a supported platform's **web client** with **live captions turned on** (Teams first; Google Meet and Zoom web are phased-in later). Captions remain a hard dependency for speaker attribution, so "turn captions on" stays in the setup instructions.
- **Capture cannot start automatically.** Chromium's `tabCapture` requires an explicit extension invocation, so the user clicks to begin recording; the extension prompts when it detects a meeting. Meeting *end* detection stays automatic.
- The toolbar badge shows captured caption-segment count; a red `!` signals captions are off.
- Transcription then summarization trigger automatically on detected meeting end (call controls disappearing, call-ended DOM state, or tab closed), or on demand via *Summarize now* in the popup.
- Two visual surfaces: the **popup** (status, capture start, manual trigger, held-item retry) and **Settings/options** (provider choice, API key, prompt templates). A third rendered output is the **Summary Artifact** HTML file.
- Setup has real-world friction the UI must account for: Ollama needs its origin allowed for the extension; Bedrock needs a bearer API key; cloud transcription engines require their own credentials, while the default local Whisper needs none. SageMaker is the most demanding: the user deploys the endpoint, and pastes temporary AWS credentials that expire and that the browser forgets when it closes.

## Capabilities and Constraints

- **Chromium (Chrome/Edge), Manifest V3** — the Firefox build is retired (`docs/adr/0003`). Firefox cannot capture meeting audio at all: `getDisplayMedia` audio is unsupported and `tabCapture` was never implemented, leaving only the local microphone, which excludes every remote participant.
- **Two distinct provider abstractions, and conflating them is a mistake:** a **Transcription Provider** (Audio Recording → Utterances) and a **Provider** (Transcript → Summary). Most LLM backends offer no speech-to-text, so the sets do not overlap — Claude and Bedrock-as-configured cannot transcribe. Local WASM Whisper is the default transcription engine; cloud engines are opt-in. Summary providers: Anthropic (Claude), OpenAI, Ollama (local), AWS Bedrock.
- **MV3 architecture constraints** (`docs/adr/0004`): recording lives in an offscreen document with reason `USER_MEDIA` (service workers have no DOM, and `AUDIO_PLAYBACK` self-closes after 30s); the captured stream must be looped back to an `AudioContext` destination or the user hears silence for the whole meeting; audio is encoded incrementally to browser-managed storage, never held whole in memory; session state must survive service-worker suspension.
- Live-caption scraping and end-detection are owned by a per-platform **Platform Adapter**; platform support is phased (Teams → Google Meet → Zoom web).
- Summaries come in two user-selectable shapes driven by editable **Prompt Templates**: **structured** (TL;DR, decisions, action items with owners/dates, open questions — the default) and **narrative** (looser recap). Default templates answer in the transcript's language.
- Pure extension caps, deliberately accepted (`docs/adr/0001`): **no email delivery** (extensions can't speak SMTP); saves land **only** under `Downloads/meeting-summaries/` (the downloads API is the only write path); API keys live in extension local storage (no more secure store without a native host). Chromium tab audio is what preserves this rule — accurate audio on Firefox would have required the companion binary that ADR-0001 rejects.
- **Nothing unrecoverable is dropped silently.** A **Held Recording** (transcription failed) and a **Held Transcript** (summarization failed) are both retained for user-triggered retry, released only once the next stage succeeds. A **Degraded Capture** — no audio, because the user never started capture or it failed — falls back to caption words alone, and the Summary Artifact says so plainly.
- Domain terminology is fixed and defined in `CONTEXT.md` (Caption Segment, Audio Recording, Speaker Track, Utterance, Fused Transcript, Transcript, Degraded Capture, Meeting, Platform Adapter, Capture Start, Meeting End, Transcription Provider, Provider, Summary, Prompt Template, Summary Artifact, Held Transcript, Held Recording).

## Brand Commitments

- Name: **Meeting Summarizer** (fixed).
- Identity is deliberately **utilitarian and no-nonsense** — a quiet local utility, not a marketed app. Future design work should keep it tool-like and unbranded rather than expressive.

## Evidence on Hand

Real, in-repo artifacts: working popup and options surfaces (`src/popup/`, `src/options/`), the Summary Artifact generator (`src/pipeline/artifact.ts`, `serialize.ts`), four summary-provider integrations (`src/providers/`), the Teams adapter with DOM fixtures (`tests/fixtures/`), and architectural rationale in `docs/adr/`.

**The audio pipeline is decided, not built.** ADR-0003/0004 and the CONTEXT.md v2 vocabulary record the Chromium/audio direction, but `src/` is still the Firefox MV2 caption-only implementation: no tab capture, no offscreen document, no Transcription Provider, and the manifest, `browser.*` calls, and SVG toolbar icon are all Firefox-specific. Future work must not describe audio capture, fusion, or Chromium support as shipped.

No testimonials, customer names, usage metrics, benchmarks, pricing, or press exist — future work must not fabricate any.

## Product Principles

- **Nothing leaves the machine unbidden.** Only the calls the user configured go out, and the defaults (local Whisper, optional local Ollama) can make that zero.
- **The user owns the models.** Bring-your-own transcription engine and LLM, never a hosted model or subscription of ours.
- **Summarize what was said.** Ground-truth audio for words, captions only for who said them; never let a caption panel's misses or misreadings become the record.
- **Nothing unrecoverable is dropped silently.** Failures hold the audio or transcript for retry, and a degraded capture admits what it lacked.
- **Stay weightless.** Pure extension, no companion app or backend; accept capability caps rather than add install weight.
- **One click, then hands off.** Capture start is the only thing the product may ask for; everything after it — end detection, transcription, summarization, delivery — happens without the user remembering to act.

## Accessibility & Inclusion

No product-specific requirement established. Follow standard good practice for the popup and settings surfaces.
