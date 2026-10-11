# Qwen3-ASR in the user's own Ollama: a second local engine

**Status: accepted.** This adds to ADR-0004 and ADR-0009 and changes neither.

Ollama 0.40 runs speech-to-text models that take audio. The GGUF build of the model that the SageMaker engine runs, `hf.co/ggml-org/Qwen3-ASR-1.7B-GGUF:Q8_0`, lists the `audio` capability. So Ollama becomes the fifth Transcription Provider. It is the second local one: the audio goes to Ollama on this computer and no further. The user who already runs Ollama for summaries gets Qwen3-ASR's accuracy without the SageMaker endpoint, its cost and its credentials.

## The request

Ollama has no transcription route. The engine uses `/api/chat`, as the summary Provider does.

- **The audio is a WAV in `images`.** Ollama tells audio from pictures by the file's magic bytes (`RIFF`…`WAVE`). The WAV is 16 kHz mono 16-bit PCM from `pcm.ts`, in base64. The prompt is empty: Qwen3-ASR needs none.
- **`temperature` 0 and `num_ctx` 8192.** A 30-s window and its reply fit many times over.
- **The reply is `language <name><asr_text><words>`.** `textFromChat` drops everything up to the tag. A language line with no tag after it, such as `language None`, is no words. A reply with no message is a format failure, not silence.
- **The reply is capped.** `num_predict` = 16 per second of audio + 32, the SageMaker engine's `max_completion_tokens` for the same model. It stops an invented sentence from running on.

## The same windows as SageMaker

- **Windows cut at pauses, about 10 s, never more than 30 s.** Qwen3-ASR returns text only, so each window is one Utterance and takes its speaker from the captions, as with SageMaker. Ollama does not split a long clip: a 66-s clip lost about 11 s at the end, without an error. 30 s is well inside that.
- **Silent windows are not sent.** On this Ollama, 1 s of digital silence came back as `language Chinese<asr_text>嗯。`, 10 s as a Chinese sentence, and 5 s of faint noise as a Portuguese one. The wrapper's skip of windows below `SILENT_BELOW_RMS` applies here unchanged.

## The Meeting Language: the reply is begun for the model

Ollama has no language field for this model. But Ollama continues a final assistant message instead of starting a new one. So for a Meeting Language that Qwen3-ASR lists, the request ends with the assistant message `language English<asr_text>`, in Qwen3-ASR's own words, and the reply holds the words only.

Checked against the local Ollama, on the `bangsar-huddle` clip (English with Malay words) and on silence:

- **Where the audio is clear, nothing changes.** Each of the clip's six turns came back word for word the same with and without `language English<asr_text>`.
- **Where the audio leaves the language in doubt, the Meeting Language wins.** 10 s of silence with `language English<asr_text>` came back in English, with `language German<asr_text>` in German, and without either in Chinese.
- **It does not translate.** English speech begun with `language German`, `French`, `Chinese` or `Malay` still came back in English. This is unlike SageMaker, where `to_language` translates (ADR-0009). The Settings panel says so.
- **Hebrew, Norwegian and Ukrainian are not on Qwen3-ASR's list.** For these three nothing is begun, and the model detects the language. This is the same exception as ADR-0009's.

Not checked: speech in another language than English, because no such clip was at hand. A wrong Meeting Language is expected to change only the windows whose language is in doubt.

## Local, and kept local

`uploadsAudio("ollama")` is false. So choosing Ollama does not withdraw microphone consent, and the disclosure says that everything is transcribed on this machine. Three checks keep that true:

- **The base URL must be this computer.** The factory refuses any host but `localhost`, `127.0.0.1` and `[::1]` before any audio is sent, and the Settings page's Test button refuses it too. The manifest's host permissions name only the first two. A remote Ollama that allows this origin would still answer a browser request, so the check cannot be left to the browser.
- **The model must run here.** Ollama also serves models from its cloud under local names (`…:cloud`). `load()` asks `/api/show` about the model and refuses one that reports a `remote_host` or `remote_model`. It also refuses a model without the `audio` capability. Neither cloud model on the test machine has it.
- **The engine has its own base URL and model.** They are not the `ollama` Provider's. The summary model cannot transcribe, and TranscriptionSettings stays the one input of the factory, as for every other engine. The base URL defaults to the same `http://localhost:11434`, so a user who set up Ollama once has nothing to change but the engine.

Considered and rejected:

- **A remote Ollama on the user's own network.** The audio would leave the machine, and the consent would need a destination that the extension cannot name. It can be added later as an uploading engine of its own.
- **Reusing the `ollama` Provider's base URL.** The factory would need the whole Settings, and a change to the summary host would move the meeting audio without a word.

## Failures

Every failure is an `OllamaFailure` with a kind, and the Test button reports that kind.

- **Nothing answers** (`fetch` rejects): "Ollama is not running at `<base URL>`".
- **403:** Ollama refused this extension's origin. The message names `OLLAMA_ORIGINS` and the extension's origin, and gives the `launchctl` command from the installation guide.
- **404:** "run `ollama pull <model>`".
- **A model that cannot take audio, or runs on Ollama's cloud:** found by `load()`, before any audio is decoded.
- **Each call gives up after 120 s.** The first call of a run also loads the model (about 4 s on an M4 Pro), and a call can wait behind the other one in flight. There is no automatic retry: a failed window holds the Recording, as with every engine.

## Two windows in flight

Ollama runs one call at a time per model unless `OLLAMA_NUM_PARALLEL` says otherwise, and queues the rest. With two in flight, the next window's upload and decoding overlap the call in progress. On an M4 Pro, the 55-s clip took 2.2 s with one window in flight, 2.1 s with two and 2.1 s with four, once the model was loaded; the first run, with the model load, took 5.2 s. More than two would only lengthen the queue that each call's timeout has to cover, on a machine the user is also meeting on.

## Consequences

- No new dependency, no manifest change: `http://localhost/*` and `http://127.0.0.1/*` are already host permissions, for the summary Provider.
- The one-time setup is the summary Provider's (`OLLAMA_ORIGINS`, ADR-0010) plus `ollama pull hf.co/ggml-org/Qwen3-ASR-1.7B-GGUF:Q8_0` (about 2.5 GB).
- The settings import accepts `transcription.ollama.baseUrl` and `transcription.ollama.model`.
- With engine naming on, the Summary Artifact says "local Ollama `<model>`".
- The evaluation harness runs the engine on request (`--engines ollama`), with `OLLAMA_BASE_URL` and `OLLAMA_TRANSCRIPTION_MODEL` defaulting to the extension's defaults. On `bangsar-huddle` (55 s, 148 words, English with Malay words) it scored 14.9% WER (S 17, D 2, I 3) in five windows, the same in three runs, against 12.2% for the whole clip in one request. The language line begun for the model changed nothing in either case. The windows lose context for the Malay words.
