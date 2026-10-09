# Evaluating the Transcription Providers

The harness under `eval/` runs the Transcription Providers on the same clip and scores each against a hand-corrected reference. The providers are local Whisper, OpenAI's `whisper-1`, ElevenLabs Scribe and, when it is asked for by name, Qwen3-ASR on your own SageMaker endpoint. Each runs through the extension's own code: the engine it ships, wrapped by the same `createTranscriptionProvider`. So chunking, offsets, part-labelling, pause windows and the Silent Recording check are the product's, and the numbers describe what a user gets.

This document is the method. The results at the end hold numbers only, never a transcript.

## Data rules

- **Non-work audio only.** A clip is either a mock meeting whose every participant agreed to be recorded for this purpose, or a public clip you are allowed to use. Public clips are kept locally and never redistributed. A real meeting from work is never a clip, however harmless it seems: its participants agreed to a meeting, not to an evaluation.
- **Nothing but method and numbers enters git.** Clips, reference transcripts and engine output all live under `.eval/`, which is git-ignored. So is any `.wav` or `.reference.json` anywhere else in the repository, except the one committed test fixture. The JSON results contain every engine's Utterances, which are the clip's content, so they stay under `.eval/results/` too.
- A cloud engine's run sends the clip to that company under its own terms: OpenAI for `whisper-1`, ElevenLabs for Scribe. A SageMaker run sends it to your own AWS account, which keeps what its setup keeps. The data rules above are what make that acceptable.

## Preparing a clip

Each clip is three things, kept together under `.eval/clips/`.

**The audio.** A WAV file of 16-bit PCM, mono, at 16 kHz, which is the rate every engine here listens at. The harness reads nothing else, and it never resamples, so no converter of its own stands between the clip and the numbers. Convert anything else with:

```sh
ffmpeg -i <input> -ac 1 -ar 16000 -c:a pcm_s16le <clip>.wav
```

**The reference.** A JSON array of segments, times in seconds from the start of the clip:

```json
[
  { "speaker": "Aisha", "start": 0.0, "end": 4.2, "text": "Can we ship the beta on Friday?" },
  { "speaker": "Bo", "start": 4.0, "end": 6.5, "text": "Yes, if QA signs off." }
]
```

Transcribe what was said, not what was meant: keep false starts and repetitions an engine would be right to hear. Segments may overlap where people talk at once. The harness refuses a reference with an empty speaker or text, an end not after its start, or an end more than a second past the audio. It reports every problem in the file at once, before anything runs.

**The Meeting Language.** The ISO-639-1 code the clip is spoken in, as the extension's settings offer it (`en`, `de`, `zh`, …). Every engine is given it as its language hint, exactly as the extension gives it the user's declaration.

Several clips are listed in a manifest, with paths relative to the manifest:

```json
[
  { "name": "standup", "audio": "standup.wav", "reference": "standup.reference.json", "language": "en" },
  { "name": "planung", "audio": "planung.wav", "reference": "planung.reference.json", "language": "de" }
]
```

## Running it

```sh
npm run eval -- --manifest .eval/clips/clips.json
npm run eval -- --manifest .eval/clips/clips.json --clips standup --engines local-whisper,elevenlabs --yes
npm run eval -- --audio .eval/clips/a.wav --reference .eval/clips/a.reference.json --language zh --yes
```

| Flag | Meaning |
| --- | --- |
| `--manifest <path>` | The clips to run. Or give one clip with `--audio`, `--reference` and `--language`. |
| `--clips <a,b>` | Only these clips from the manifest. An unknown name is an error, not a skip. |
| `--engines <ids>` | Any of `local-whisper`, `openai`, `elevenlabs`, `sagemaker`. Default: the first three. SageMaker runs only when named, because it needs an endpoint you deployed. |
| `--whisper-model <size>` | `tiny`, `base` or `small`. Default: `base`, the extension's default. |
| `--out <dir>` | Where the JSON results go. Default: `.eval/results`. |
| `--yes` | Proceed once the cloud bill has been printed. |

Keys come only from `OPENAI_API_KEY` and `ELEVENLABS_API_KEY` in the environment. There is no flag for one. A key is never printed or written, and is scrubbed from any error an endpoint returns.

SageMaker reads the AWS CLI's own variables, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, plus `AWS_REGION` and `SAGEMAKER_ENDPOINT`. So `eval "$(aws configure export-credentials --format env)"` sets the credentials. They are scrubbed from errors like a key.

**Before any cloud call** the harness prints the audio minutes and uploads each cloud engine will be billed for. For Scribe it also prints the share of a 4.5-hour free plan. For SageMaker it says that the endpoint bills by its running time, not by the minute, and the upload count is approximate, because its windows are cut at pauses. Without `--yes` it then stops, and nothing runs, local Whisper included. The figure is the clips' audio duration rounded up to a tenth of a minute. A provider's own rounding per request may differ slightly.

The Markdown table goes to stdout and everything else to stderr, so `npm run -s eval -- … > table.md` captures the table alone.

## What runs

| Engine | Model | Input per request |
| --- | --- | --- |
| local Whisper | `onnx-community/whisper-<size>`, q8 | 2 minutes |
| OpenAI | `whisper-1` | 10 minutes |
| ElevenLabs | `scribe_v2` | 1 hour |
| Amazon SageMaker | Qwen3-ASR, on your endpoint | about 10 seconds, cut at pauses; 30 seconds at most |

Model ids and input limits are read from the extension's code, not restated. A clip longer than an engine's limit is split into windows exactly as a Capture Span is. A diarizing engine's labels then carry their part ("Speaker 1 (part 2)"), as ADR-0008 decided. SageMaker's windows are cut at pauses instead, as ADR-0009 decided, because its words come back without timings.

Local Whisper runs in Node through transformers.js, with the worker's model repository, `dtype: "q8"`, `session_options: { graphOptimizationLevel: "disabled" }`, `whisperRunOptions(language)` and span mapping. What cannot be the same is the host, and every report says so:

- **Backend.** It runs on `onnxruntime-node`, on the native CPU with several threads. The extension runs `onnxruntime-web`: single-threaded WASM, and a different ONNX Runtime version. So local Whisper's **accuracy** is comparable to the extension's, but its **speed is not**.
- **No worker.** It runs in the Node process rather than a dedicated worker in the offscreen document.
- **Disk cache.** The model is cached in `.eval/models` rather than the browser cache. The first run's load time includes the download.
- **WAV, not WebM.** The audio is read from WAV rather than decoded from the recorder's WebM, so compression loss in a real recording is not measured, for any engine.

## Metrics

### Normalisation

The reference and the engine output get the same normalisation, in this order:

1. Unicode NFKC, so full-width and compatibility forms read as their plain letters and digits.
2. Lowercase.
3. Apostrophes (`'` and `’`) deleted, so "don't" and "dont" are one word.
4. Every other Unicode punctuation or symbol character (categories P and S) replaced by a space, so "follow-up" is two words on both sides.
5. Runs of whitespace collapsed to one space; the ends trimmed.

Nothing else is folded. "10" against "ten" is an error, and so is a second spelling of one word.

The reference text is its segments joined in order of start time. The engine's text is its Utterances joined in order. Where the reference has overlapping speech, the order within the overlap is the reference's, and an engine that heard it in another order is charged for it.

### Word error rate, or character error rate

**Word error rate** = (substitutions + deletions + insertions) ÷ words in the normalised reference. The three counts are the smallest unit-cost edit that turns the reference into the engine's output. Ties break in the order substitution, deletion, insertion, so the split is the same every run. The rate can exceed 100%, because insertions are unbounded.

**Character error rate** is the same calculation over characters, with all whitespace removed. It is used instead for Meeting Languages written without spaces between words: **Chinese (`zh`), Japanese (`ja`) and Thai (`th`)**. Split on whitespace, a whole sentence of these would be one "word", and one wrong character would cost the sentence. Korean writes spaces and is scored by word. The table's Metric column says which was used.

Worked examples, from the tests:

| Reference | Engine | Counts | Rate |
| --- | --- | --- | --- |
| Ship the beta today. | ship a beta | S 1 ("the" → "a"), D 1 ("today"), of 4 words | WER 50% |
| Yes. | yes, yes, yes | I 2, of 1 word | WER 200% |
| OK — let's ship. | ok lets ship | none after normalisation | WER 0% |
| 我们下周发布。 | 我们下周发部 | S 1 (布 → 部), of 6 characters | CER 16.7% |

### Speaker accuracy

Only for an engine that diarizes, which today is Scribe. The Whisper engines read **n/a: no diarization**, not zero.

1. **Mapping, many-to-one.** Each engine label is mapped to the reference speaker it overlaps most in total time. Two labels may map to one person. That is deliberate: across engine calls the product gives one voice a label per part (ADR-0008), and a one-to-one mapping would score that as an error. A tie goes to the reference speaker who speaks first. A label that overlaps nobody maps to nobody.
2. **Accuracy** = reference speech covered by an Utterance whose label maps to whoever was speaking ÷ all reference speech.
   - Reference speech no labelled Utterance covers counts as not correct.
   - Crosstalk counts once per speaker, so one label cannot be right for two people at once.
   - Engine speech where the reference has none is not penalised. So this is not a diarization error rate: it asks only whether what was said is credited to whoever said it.
   - Durations are exact interval arithmetic, with no frame grid.
3. **Speaker labels / reference.** The distinct labels the engine produced, against the distinct reference speakers. Many-to-one mapping cannot see one label spread over everybody: that engine scores its dominant speaker's share. This count is what exposes it.

Worked examples, from the tests:

| Reference | Engine | Mapping | Accuracy |
| --- | --- | --- | --- |
| Aisha 0–4 s, Bo 4–8 s | Speaker 1 0–5 s, Speaker 2 5–8 s | 1 → Aisha (4 s), 2 → Bo (3 s) | 7 ÷ 8 = 87.5% |
| Aisha 0–6 s, Bo 6–8 s | Speaker 1 0–8 s | 1 → Aisha | 6 ÷ 8 = 75%, with 1 label against 2 speakers |

This measures the engine alone. In the extension a Speaker Track name wins wherever captions overlap, and an engine's label is only the fallback (ADR-0008). A clip has no Speaker Track, so fusion is not measured here.

### Also reported

- **Audio**: the clip's length.
- **Load**: model load in seconds, including any download. It happens once per run and is shown on every local Whisper row. Cloud engines have nothing to load.
- **Transcribe**: wall-clock seconds from the recording handed to the Transcription Provider to its Utterances. For a cloud engine this includes the upload.
- **Outcome**: a failure, or a Silent Recording refused by the provider, is reported in place of a rate, with the reason beneath the table.

Engines run one at a time, so no two compete for the machine.

## Results

_To be filled in after a run. Method as above; harness at commit `<commit>`._

| Clip | Language | Audio | Metric | Engine | Error rate | Speaker accuracy | Speaker labels / reference | Transcribe |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `<clip>` | `<code>` | `<m:ss>` | `<WER/CER>` | local Whisper (`base`) | `<%>` | n/a: no diarization | n/a / `<n>` | `<s>` |
| `<clip>` | `<code>` | `<m:ss>` | `<WER/CER>` | OpenAI (`whisper-1`) | `<%>` | n/a: no diarization | n/a / `<n>` | `<s>` |
| `<clip>` | `<code>` | `<m:ss>` | `<WER/CER>` | ElevenLabs (`scribe_v2`) | `<%>` | `<%>` | `<labels>` / `<n>` | `<s>` |

_Clips: `<how many, and what kind — e.g. two consenting mock meetings, three and four speakers>`._

_Host: `<machine, OS, Node version>`. Local Whisper's times are not the extension's; see "What runs"._
