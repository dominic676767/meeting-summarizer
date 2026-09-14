# Meeting Summarizer

A lightweight Chromium extension (Chrome/Edge) that captures **live captions** from Microsoft Teams web meetings, summarizes the meeting with **your LLM of choice** (Claude, OpenAI, Ollama, AWS Bedrock), and saves a single self-contained HTML summary — with the full transcript collapsible inside — to `Downloads/meeting-summaries/`.

Pure WebExtension: no companion app, no backend, nothing leaves your machine except the LLM call (or nothing at all, with Ollama).

## Install (unpacked, for development)

```sh
npm install
npm run build
```

Then in Chrome or Edge: `chrome://extensions` → enable **Developer mode** → *Load unpacked* → pick the `dist/` folder.

Unlike a Firefox temporary add-on, an unpacked Chromium extension survives browser restarts; click *Reload* on its card after each `npm run build`.

## Use

1. Open Settings (extension options), pick a Provider and paste its API key.
   - **Ollama**: run it with `OLLAMA_ORIGINS=chrome-extension://*` so the extension may call it.
   - **Bedrock**: use a Bedrock API key (bearer token). AWS SigV4 credentials are not supported.
2. Join a Teams meeting at `teams.microsoft.com` and **turn on live captions** (More → Language and speech → Turn on live captions).
3. The toolbar badge counts captured caption segments (a red `!` means captions are off).
4. When the call ends — or you click *Summarize now* in the popup — the summary lands in `Downloads/meeting-summaries/YYYY-MM-DD-<meeting-title>.html`.

If summarization fails (provider outage, missing key), the transcript is **held** — retry it from the popup, optionally after switching provider. Nothing is retained once the summary file is written.

## Summary shapes

Structured (TL;DR / decisions / action items with owners / open questions — default) or narrative recap. Both prompt templates are fully editable in Settings; defaults answer in the transcript's language.

## Development

```sh
npm test          # vitest — pipeline + Teams adapter seams
npm run typecheck
npm run build     # esbuild → dist/
```

Domain vocabulary lives in [CONTEXT.md](CONTEXT.md); architectural constraints in [docs/adr/](docs/adr/). Teams DOM fixtures and re-capture instructions: [tests/fixtures/](tests/fixtures/README.md).
