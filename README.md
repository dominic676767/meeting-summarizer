# Meeting Summarizer

A lightweight Chromium extension (Chrome/Edge) that records a Microsoft Teams or Zoom web meeting's **tab audio**, transcribes it with **local WASM Whisper**, summarizes the meeting with **your LLM of choice** (Claude, OpenAI, Ollama, AWS Bedrock), and saves a single self-contained HTML summary — with the full transcript collapsible inside — to `Downloads/meeting-summaries/`.

Zoom web client support is implemented on this branch. The four requested live functional tests passed across separate runs by 8 October 2026. See [the live test handover](docs/zoom-live-test-handoff-2026-10-07.md) for the evidence and limits. The full manual release checks remain open.

Pure WebExtension: no companion app, no backend. Transcription runs on your machine by default, so the only things that leave it are the LLM call (nothing at all, with Ollama) and the one-time Whisper model download. Cloud transcription exists but is opt-in and off until you choose it.

Speaker attribution is not wired up yet: base Whisper performs no diarization, so transcript lines read as *Unknown speaker* until captions are fused with the audio. A meeting with no recording still gets a caption-only summary.

## Install (unpacked, for development)

```sh
npm install
npm run build
```

Then in Chrome or Edge: `chrome://extensions` → enable **Developer mode** → *Load unpacked* → pick the `dist/` folder.

Unlike a Firefox temporary add-on, an unpacked Chromium extension survives browser restarts; click *Reload* on its card after each `npm run build`.

For a meeting in an incognito window, open the extension's *Details* page and enable **Allow in Incognito**.

## Participant notice and consent

**You are responsible for notifying other participants and obtaining any required consent before the extension captures meeting audio or captions.** Follow applicable recording and privacy laws, your organisation's policies, and the meeting platform's terms.

The extension does not notify other participants or trigger the meeting platform's built-in recording notices. This applies to Teams and Zoom web client support, including caption-only capture. A browser permission or your own microphone consent does not obtain consent from other participants.

Tell participants how you intend to use the recording, transcript, and summary, including whether audio or transcripts will be sent to external providers you select.

## Use

1. Open Settings (extension options), pick a Provider and paste its API key.
   - **Ollama**: run it with `OLLAMA_ORIGINS=chrome-extension://*` so the extension may call it.
   - **Bedrock**: use a Bedrock API key (bearer token). AWS SigV4 credentials are not supported.
   - If you enable the local microphone, select **Allow microphone access** in Settings and select **Allow** in Chrome. Then return to the meeting and start recording.
2. Join a Teams or Zoom meeting in the browser and **turn on live captions** if available.
   - **Teams**: at `teams.microsoft.com`, select More → Language and speech → Turn on live captions.
   - **Zoom web client**: at `app.zoom.us/wc/...`, select More → Show Captions. If captions are unavailable, ask the host to enable them. Audio transcription can also run without captions.
3. **Start recording** — the popup's *Start recording* button or `Ctrl/Cmd+Shift+U`. Chromium only lets an extension capture tab audio on an explicit invocation, so this click cannot be automatic. The badge reads `REC` while audio is being captured; you keep hearing the meeting normally.
4. When the call ends — or you click *Summarize now* in the popup — the recording is transcribed and then summarized, and the summary lands in `Downloads/meeting-summaries/YYYY-MM-DD-<meeting-title>.html`. The audio is deleted once the file is written.

The popup names each phase while you wait: the one-time model download (with megabytes transferred), transcription (with audio processed of audio total), then summarization. Local Whisper on a long meeting is genuinely slow; *Skip transcription, use captions* takes the caption-only summary instead of waiting.

If summarization fails (provider outage, missing key), the transcript is **held** — retry it from the popup, optionally after switching provider. Nothing is retained once the summary file is written.

Zoom captions currently use **Unknown** as the speaker name. The extension waits 30 seconds after the Zoom meeting controls disappear before it treats the meeting as ended. This permits short transitions, such as a breakout room change.

## Transcription

Configured separately from the summary Provider, because most LLM backends have no speech-to-text API — a Claude or Bedrock key cannot transcribe audio.

Local Whisper is the default and needs no key. Pick a model size in Settings — tiny (~40 MB, fastest), base (~75 MB, default), small (~250 MB, most accurate). The model is fetched once from Hugging Face and cached by the browser; later meetings transcribe without re-downloading.

**Meeting language** is one setting for whichever engine is selected, and it defaults to **English**. Nothing detects it: the engine transcribes as if the language you picked were the one being spoken, so a meeting held in another language comes back as wrong words until you change it.

**OpenAI transcription** is the opt-in cloud alternative: faster and more accurate, at the cost of uploading the meeting's audio. It takes its own key in the Transcription section of Settings — separate from the OpenAI key used for summarizing — and a model that returns per-segment timestamps (`whisper-1`), because speaker names come from matching those timings against the captions. Switching engine changes what the next meeting uses; nothing else about the flow changes.

## Summary shapes

Structured (TL;DR / decisions / action items with owners / open questions — default) or narrative recap. Both prompt templates are fully editable in Settings; defaults answer in the transcript's language.

## Development

```sh
npm test          # vitest — transcription, pipeline, Teams, Zoom, and capture
npm run typecheck
npm run build     # esbuild → dist/

WHISPER_INTEGRATION=1 npm test   # additionally runs real Whisper on a committed
                                 # audio fixture (downloads the tiny model)
```

The tests stop where the browser starts: loopback, tab capture, storage, and anything needing a second person in a real meeting cannot be asserted here. Those live in [docs/manual-checks.md](docs/manual-checks.md), to be run against a real browser before a release.

How the code fits together, in diagrams: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Domain vocabulary lives in [CONTEXT.md](CONTEXT.md); architectural constraints in [docs/adr/](docs/adr/). Teams DOM fixtures and re-capture instructions: [tests/fixtures/](tests/fixtures/README.md).
