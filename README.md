# Meeting Summarizer

A lightweight Chromium extension (Chrome/Edge) that records a Microsoft Teams web meeting's **tab audio**, transcribes it with **local WASM Whisper**, summarizes the meeting with **your LLM of choice** (Claude, OpenAI, Ollama, AWS Bedrock), and saves a single self-contained HTML summary — with the full transcript collapsible inside — to `Downloads/meeting-summaries/`.

Pure WebExtension: no companion app, no backend. Transcription runs on your machine by default, so the only things that leave it are the LLM call (nothing at all, with Ollama) and the one-time Whisper model download. Cloud transcription exists but is opt-in and off until you choose it.

Speaker names come from Teams' live captions, matched against the audio's timings. Whisper cannot tell voices apart, so a line the captions missed reads *Unknown speaker*; with ElevenLabs Scribe (below) it reads *Speaker 1*, *Speaker 2* instead. A meeting with no recording still gets a caption-only summary.

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
   - **Bedrock**: use a Bedrock API key (bearer token) only.
2. Join a Teams meeting at `teams.microsoft.com` and **turn on live captions** (More → Language and speech → Turn on live captions).
3. **Start recording** — the popup's *Start recording* button or `Ctrl/Cmd+Shift+U`. Chromium only lets an extension capture tab audio on an explicit invocation, so this click cannot be automatic. The badge reads `REC` while audio is being captured; you keep hearing the meeting normally.
4. When the call ends — or you click *Summarize now* in the popup — the recording is transcribed and then summarized, and the summary lands in `Downloads/meeting-summaries/YYYY-MM-DD-<meeting-title>.html`. The audio is deleted once the file is written.

The popup names each phase while you wait: the one-time model download (with megabytes transferred), transcription (with audio processed of audio total), then summarization. Local Whisper on a long meeting is genuinely slow; *Skip transcription, use captions* takes the caption-only summary instead of waiting.

If summarization fails (provider outage, missing key), the transcript is **held** — retry it from the popup, optionally after switching provider. Nothing is retained once the summary file is written.

## Transcription

Configured separately from the summary Provider, because most LLM backends have no speech-to-text API — a Claude or Bedrock key cannot transcribe audio.

Local Whisper is the default and needs no key. Pick a model size in Settings — tiny (~40 MB, fastest), base (~75 MB, default), small (~250 MB, most accurate). The model is fetched once from Hugging Face and cached by the browser; later meetings transcribe without re-downloading.

**Meeting language** is one setting for whichever engine is selected, and it defaults to **English**. Nothing detects it: the engine transcribes as if the language you picked were the one being spoken, so a meeting held in another language comes back as wrong words until you change it.

**OpenAI transcription** is the opt-in cloud alternative: faster and more accurate, at the cost of uploading the meeting's audio. It takes its own key in the Transcription section of Settings — separate from the OpenAI key used for summarizing — and a model that returns per-segment timestamps (`whisper-1`), because speaker names come from matching those timings against the captions. Switching engine changes what the next meeting uses; nothing else about the flow changes.

**ElevenLabs Scribe** is the second opt-in cloud engine, chosen for the one thing the others cannot do: it tells voices apart. Where the captions give no name, a line reads *Speaker 1* or *Speaker 2* rather than *Unknown speaker*. The cost is the same as OpenAI's — the meeting's audio is uploaded, and ElevenLabs may keep it under its own terms. It takes its own key in the Transcription section of Settings and the model `scribe_v2`. Audio goes up an hour at a time, and speaker labels only hold within one upload, so a recording that needs more than one labels each speaker with its part (*Speaker 1 (part 2)*) rather than risk giving two people the same name. See [ADR-0008](docs/adr/0008-elevenlabs-scribe-the-diarizing-cloud-engine.md).

**Amazon SageMaker** is the third opt-in cloud engine: your own endpoint, in your own AWS account, running **Qwen3-ASR 1.7B** from SageMaker JumpStart. Of the JumpStart speech-to-text models it has the best average English word error rate, and it covers 30 languages. The meeting's audio is uploaded to that endpoint, and what is kept there depends on how you set it up: with SageMaker data capture on, for example, every request is stored in S3. See [ADR-0009](docs/adr/0009-sagemaker-transcription-on-temporary-aws-credentials.md) and the research in [docs/research/](docs/research/sagemaker-jumpstart-stt.md).

1. Deploy `huggingface-asr-qwen3-asr-1-7b` from SageMaker JumpStart to a real-time endpoint. The default instance, `ml.g6.xlarge`, costs about $1.13 an hour in `us-east-1` for as long as it runs. The extension only calls the endpoint: it never creates, scales or deletes anything.
2. Give the credentials you will paste this one permission, and nothing more:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "sagemaker:InvokeEndpoint",
         "Resource": "arn:aws:sagemaker:<region>:<account-id>:endpoint/<endpoint-name>"
       }
     ]
   }
   ```

3. In Settings → Transcription, choose *Amazon SageMaker*, enter the region and the endpoint name, and paste **temporary** credentials: the `export AWS_…` lines from the AWS access portal, a credentials-file profile, or the output of `aws configure export-credentials`. Long-term keys (`AKIA…`) are refused. The credentials are kept in memory only, and are gone when you close the browser.
4. Click *Test the endpoint*. It sends one second of silence, never meeting audio, and says which part of the setup to fix, if any.

Qwen3-ASR returns words without timings, so the audio goes in pieces of about 10 seconds, cut at pauses, and each piece takes its speaker name from the captions. If the credentials expire before a meeting ends, the popup warns you while it records, and the meeting's audio is kept: paste fresh credentials and use *Retry transcription* in the popup. Qwen3-ASR does not list Hebrew, Norwegian or Ukrainian; for these, no language is sent and the model guesses.

Choosing a different cloud engine asks for microphone consent again, because the recording would go somewhere else: to a different company, or with SageMaker, to your own AWS account.

How the engines compare on the same audio — word error rate, and how often each word is credited to the right speaker — is measured with the harness in `eval/`; the method and the rules for what audio may be used are in [docs/evaluations](docs/evaluations/README.md).

## Summary shapes

Structured (TL;DR / decisions / action items with owners / open questions — default) or narrative recap. Both prompt templates are fully editable in Settings; defaults answer in the transcript's language.

## Development

```sh
npm test          # vitest — transcription, pipeline, and Teams adapter seams
npm run typecheck
npm run build     # esbuild → dist/

WHISPER_INTEGRATION=1 npm test   # additionally runs real Whisper on a committed
                                 # audio fixture (downloads the tiny model)
```

The tests stop where the browser starts: loopback, tab capture, storage, and anything needing a second person in a real meeting cannot be asserted here. Those live in [docs/manual-checks.md](docs/manual-checks.md), to be run against a real browser before a release.

How the code fits together, in diagrams: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Domain vocabulary lives in [CONTEXT.md](CONTEXT.md); architectural constraints in [docs/adr/](docs/adr/). Teams DOM fixtures and re-capture instructions: [tests/fixtures/](tests/fixtures/README.md).
