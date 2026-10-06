# SageMaker JumpStart speech-to-text: research for a SageMaker transcription engine

Researched 2026-10-06 for the planned SageMaker transcription engine (branch `sagemaker-transcription`). The question is: which speech-to-text (ASR) model on SageMaker JumpStart is the best engine for recorded meeting audio? The extension's five constraints decide "best". They come from the brief for this research:

1. **API.** The extension calls a real-time endpoint with SigV4-signed plain `InvokeEndpoint` through `fetch`. The body is 6,291,456 bytes at most (about 3 min of 16 kHz 16-bit mono WAV). Each call has 60 s. Bidirectional streaming, async inference and serverless are out of scope.
2. **Timestamps.** The extension overlaps each segment's time range with live-caption speaker turns. A text-only response gives one speaker per request window.
3. **Language hint.** The extension sends the declared Meeting Language as an ISO-639-1 code. An engine that only auto-detects is not wanted.
4. **Accuracy and languages.** AMI (meeting speech) matters most. Many languages are wanted.
5. **Cost.** The us-east-1 hourly price of the default and the smallest instance, any Marketplace fee, and the license.

**Sources.** Only primary sources were used:

- The public JumpStart cache `jumpstart-cache-prod-us-west-2`: the two manifests, each model's spec, the inference code and the model card inside each prepacked artifact, and the example notebooks. The bucket allows anonymous list and get. I did not call an AWS account, and I sent no signed request.
- The AWS Price List bulk file for SageMaker in us-east-1, version `20261005212151` (published 2026-10-05T21:21:51Z).
- The two AWS Marketplace listings for the Parakeet NIMs, as served on 2026-10-06.
- The Hugging Face Open ASR Leaderboard: the Space's version registry in `init.py` (newest entry `02-10-2026`), and the result files at the revisions that this entry pins.
- vLLM source at tag `v0.22.1`. That is the vLLM version of the container that JumpStart uses for Granite Speech ([spec:granite]).
- The owners' model cards. JumpStart ships each card as `README.md` in the prepacked artifact. For Whisper, I read OpenAI's card on Hugging Face.

Labels:

- **(L)** means independent: the number comes from the leaderboard's own result files.
- **(V)** means vendor-reported: the number comes from the owner's model card or eval file.
- Keys in square brackets, for example [spec:qwen3], resolve in §8.

The brief names a GitHub repo `hf-audio/open_asr_leaderboard`. GitHub returns 404 for it. The eval code is in `huggingface/open_asr_leaderboard`. The Space does not read its numbers from GitHub. It reads Hugging Face dataset files ([lb-space]).

---

## Summary: findings that change the design

1. **No JumpStart deployment meets all five constraints as shipped.**
   - Only the two NVIDIA Parakeet NIMs return timestamps, and both are English-only ([nb:tdt], [nb:ctc]).
   - Every Hugging Face ASR model on JumpStart returns text only ([code:whisper], [code:nemotron], [spec:qwen3], [vllm-serving] l.413–417).
2. **Whisper's JumpStart container hides timestamps that the model can produce.**
   - The model predicts sentence-level and word-level timestamps (`return_timestamps=True` or `"word"`) ([card:whisper]).
   - The JumpStart handler decodes with `skip_special_tokens=True` and returns `{"text": [...]}`. The spec offers an `application/json;verbose` accept type, but the code says "Verbose and non-verbose response are identical" ([code:whisper], [spec:whisper-v3]).
   - The handler uses one 30-s window. The bundled `preprocessor_config.json` sets `chunk_length: 30` and `n_samples: 480000` ([cfg:whisper]). So the handler cuts audio after 30 s (UNVERIFIED by test, U4).
3. **The smallest change that exposes them: put the same Whisper weights on the SageMaker vLLM container, and call vLLM's transcription route.**
   - JumpStart already uses this route on its vLLM image. Voxtral's default payload is multipart, with `custom_attributes: "route=/v1/audio/transcriptions"`, on `vllm:server-sagemaker-cuda-v2.0` ([spec:voxtral]).
   - vLLM v0.22.1 returns `verbose_json` segments only for a model class that sets `supports_segment_timestamp`. Other models get "Currently do not support verbose_json" ([vllm-serving] l.413–417). Of the four model files I read, only Whisper sets it ([vllm-whisper] l.816).
   - For Whisper, vLLM takes an ISO-639-1 `language` and writes it into the `<|xx|>` prompt token ([vllm-whisper] l.818–849). That is the Meeting Language format, with no mapping.
   - vLLM splits audio longer than 30 s, with 1 s of overlap ([vllm-cfg] l.63–74, [vllm-serving] l.224–238). It adds `chunk index × 30 s` to the times in each chunk ([vllm-serving] l.554, l.310–352).
   - The timestamps are segment-level. I found no word-level code path in the v0.22.1 serving code.
4. **Recommendation: Whisper large-v3, deployed that way. Runner-up: Parakeet TDT 0.6B v2 NIM, for English-only meetings.** See §5 and §6.
5. **The cost of that choice is accuracy on meetings.**
   - AMI-Cleaned WER (L): Granite Speech 4.1 2B 7.06, Qwen3-ASR 1.7B 8.31, Parakeet TDT 0.6B v2 9.09, Whisper large-v3 13.63 ([lb-en]). Whisper makes about twice Granite's errors on meeting speech.
   - In return, Whisper gives timestamps, the language hint and 99 languages. It also has the best mean multilingual WER of the candidates: FLEURS 3.41 over six languages (L) ([lb-ml]).
6. **Each engine wants a different language format.**
   - Whisper on JumpStart: an English language name plus `task`, in JSON, with the audio as a hex string ([code:whisper]).
   - Whisper on vLLM: the ISO-639-1 code ([vllm-whisper]).
   - Nemotron: a locale such as `en-US`, or `auto` ([spec:nemotron]).
   - Parakeet: `language_code=en-US` only ([nb:tdt]).
   - Granite on vLLM: vLLM checks `language` against six codes, but the transcribe prompt does not use it ([vllm-granite] l.80–87, l.867–869).
   - Qwen3-ASR on vLLM: vLLM uses `to_language`, not `language` ([vllm-qwen3] l.557–575).
7. **A real-time endpoint costs money for each hour that it runs.** The cheapest fit is `ml.g6.xlarge` at $1.1267/h ([price]). If it runs all the time, that is about $822 a month (my arithmetic, 730 h). The NIMs add $1.00 per host per hour ([mp:tdt], [mp:ctc]).
8. **Design option (my inference, not a sourced fact).** A text-only engine can still attribute speakers if the extension cuts each request at a caption speaker turn. Then Qwen3-ASR becomes a fair choice. But its JumpStart body still has no language field (U7).

---

## 1. Candidates in the JumpStart manifests

Method: I downloaded both manifests. I matched model ids, `search_keywords` and whole proprietary entries against speech terms. I also listed every id prefix.

- `models_manifest.json`: 28,199 entries, Last-Modified 2026-10-04 ([manifest]).
- `proprietary-sdk-manifest.json`: 516 entries for 122 model ids, Last-Modified 2026-09-15 ([prop-manifest]).

Speech-to-text ids (newest spec version):

- `huggingface-asr-whisper-{tiny,base,small,medium,large,large-v2}` (3.1.0), `huggingface-asr-whisper-large-v3` (1.1.0) and `huggingface-asr-whisper-large-v3-turbo` (1.1.17).
- `huggingface-asr-qwen3-asr-1-7b` (1.0.2).
- `huggingface-asr-ibm-granite-granite-speech-4-1-2b` (1.0.0).
- `huggingface-asr-voxtral-mini-4b-realtime-2602` (1.0.0).
- `huggingface-asr-nvidia-nemotron-3-5-asr-streaming-0-6b` (1.0.0).
- Proprietary: `nvidia-parakeetvtdt-0-6b-v2` (2.0) and `nvidia-parakeet-1-1b-ctc-en-us-asr` (1.3). Both carry the keyword "Audio2Text" ([prop-manifest]).

The re-scan found no ASR model that the earlier list missed. These are in neither manifest:

- NVIDIA Canary (any version), Granite Speech 8B, `granite-speech-4.1-2b-plus`, Granite Speech 5.0, Phi-4-multimodal, Kyutai, Moonshine, SenseVoice and Paraformer.
- Any other Marketplace speech-to-text vendor. The only other audio vendors in the proprietary manifest are `cambai-mars6` and `cartesia-sonic-3-sagemaker`. Their names match text-to-speech products. I did not read their specs (UNVERIFIED, U13).
- Nemotron 3 Nano Omni is present, but as a VLM. Its spec lists `input_modalities: ["Text","Image"]` ([spec:omni]). So it is not an audio path on JumpStart.

## 2. Comparison table

How to read the table:

- "AMI WER" shows two leaderboard columns: AMI-Cleaned, then the original AMI. A dash means the file has no value ([lb-en]).
- "avg EN WER" is the `avg` column of the same file. It is the mean of the file's eight public English test sets.
- "multilingual WER" is the mean FLEURS WER over the six languages that the leaderboard scores: fr, de, es, it, pt and nl ([lb-ml]). Other numbers are marked.
- "$/h" is the us-east-1 On-Demand real-time hosting price ([price]).
- "fits 6 MB / 60 s" uses the brief's limits. Base64 inflates audio by 4/3, so 6 MB of JSON holds about 147 s of 16 kHz 16-bit mono WAV. Binary multipart holds about 196 s. The times are my arithmetic.

| model | JumpStart id | AMI WER | avg EN WER | languages | multilingual WER | timestamps via JumpStart | language hint | default instance | $/h | Marketplace fee | license | fits 6 MB / 60 s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Whisper large-v3 | `huggingface-asr-whisper-large-v3` | 13.63 / 14.86 (L) | 5.78 (L) | 99 (L metadata) | 3.41 (L) | No. The handler drops them | JSON `language` name plus `task`; hex audio | ml.g5.2xlarge | 1.515; smallest ml.g4dn.2xlarge 0.94 | None | Apache-2.0 | Size yes. Audio after 30 s is cut (U4) |
| ↳ same weights on the SageMaker vLLM container (not a JumpStart deployment) | (none) | same | same | same | same | Segment times through `verbose_json` (U1) | ISO-639-1 `language` | ml.g6.xlarge (my choice) | 1.1267 | None | Apache-2.0 | Yes: about 3 min binary; vLLM splits at 30 s (U3, U5) |
| Whisper large-v3-turbo | `huggingface-asr-whisper-large-v3-turbo` | 13.88 / 15.16 (L) | 6.36 (L) | 99 (L metadata) | 3.89 (L) | No | Same as large-v3 | ml.g5.2xlarge | 1.515; smallest ml.g4dn.2xlarge 0.94 | None | MIT (L metadata, U10) | Size yes. 30-s window |
| Qwen3-ASR 1.7B | `huggingface-asr-qwen3-asr-1-7b` | 8.31 / – (L, `-hf` row, U8) | 4.31 (L) | 30, plus 22 Chinese dialects (V) | 3.85 (L); FLEURS 4.90 (V) | No. Chat text only | None in the JumpStart body (U7) | ml.g6.xlarge | 1.1267; also the smallest | None | Apache-2.0 | About 147 s per call (base64) |
| Granite Speech 4.1 2B | `huggingface-asr-ibm-granite-granite-speech-4-1-2b` | 7.06 / 7.72 (L); 8.09 (V) | 4.62 (L); 5.33 (V) | 6: en, fr, de, es, pt, ja | UNVERIFIED (U9) | No. The model has none | None that has an effect | ml.g6.xlarge | 1.1267; the only type | None | Apache-2.0 | About 2 min in one prompt (2,048-token cap, U6) |
| Parakeet TDT 0.6B v2 NIM | `nvidia-parakeetvtdt-0-6b-v2` | 9.09 / 10.4 (L, open checkpoint, U8) | 4.70 (L) | 1 (English) | n/a | Word times and speaker tags through `/invocations/grpc` (shape U2) | `language_code=en-US` only | ml.g6e.12xlarge | 13.1158; smallest ml.g6.2xlarge 1.222 | $1.00/host/h | NVIDIA EULA (U2) | Yes: binary multipart |
| Parakeet CTC 1.1B en-US NIM | `nvidia-parakeet-1-1b-ctc-en-us-asr` | 12.23 / 14.76 (L, open checkpoint, U8) | 5.92 (L) | 1 (English) | n/a | Speaker tags through gRPC; word times U2 | `language_code=en-US` only | ml.g6e.12xlarge | 13.1158; smallest ml.g6.2xlarge 1.222 | $1.00/host/h | NVIDIA EULA (U2) | Yes: binary multipart |
| Nemotron 3.5 ASR streaming 0.6B | `huggingface-asr-nvidia-nemotron-3-5-asr-streaming-0-6b` | 13.43 / – (L) | 7.88 (L) | 40 locales (V) | 7.51 (L) | No | Locale, for example `en-US`, or `auto` | ml.g5.2xlarge | 1.515; the only type | None | OpenMDW-1.1 | About 147 s per call (base64) |
| Voxtral Mini 4B Realtime 2602 | `huggingface-asr-voxtral-mini-4b-realtime-2602` | 13.34 / 15.91 (L); AMI IHM 15.05 (V) | 6.46 (L) | 13 (spec) | 5.14 (L); 8.72 (V, 13 languages) | No. vLLM refuses `verbose_json` | `language` through the vLLM route (U1) | ml.g6.16xlarge | 4.246; smallest ml.g6.xlarge 1.1267 (U11) | None | Apache-2.0 | Yes: binary multipart. Slowest (RTFx 102.6, L) |

The open-weight rows have no Marketplace fee because their specs have no Marketplace listing or model package ([spec:whisper-v3], [spec:qwen3]). The older Whisper ids are not in the table. The large-v2 handler is byte-identical to the large-v3 handler ([code:whisper-v2]). The current leaderboard file has no rows for tiny, base, small, medium, large or large-v2 ([lb-en]).

## 3. Details per candidate

### 3.1 Whisper large-v3 and large-v3-turbo

- **Container.** large-v3 uses the PyTorch inference image 2.5.1. Turbo uses the Hugging Face PyTorch image 2.1.0 ([spec:whisper-v3], [spec:whisper-turbo]). The handler is `code/inference.py` in the prepacked artifact, because `hosting_use_script_uri` is `false`.
- **Request.** There are two forms ([code:whisper]):
  - `audio/wav`: raw bytes. This form takes no parameters, so it takes no language.
  - `application/json`: `audio_input` as a hex string. `language` and `task` are optional, but you must send both or neither. The other allowed keys are generation settings: `forced_decoder_ids`, `max_length`, `num_return_sequences`, `num_beams`, `top_p`, `early_stopping`, `do_sample`, `no_repeat_ngram_size`, `top_k`, `temperature`, `min_length`, `max_new_tokens`, `min_new_tokens`, `length_penalty` and `max_time`. There is no timestamp key.
- **Language.** The handler lower-cases the value and checks it against `SUPPORTED_LANGUAGES`. That is a list of English names, for example `english` and `german` ([code:whisper] `constants/constants.py`). So the extension must map ISO-639-1 to a name.
- **Response.** `{"text": ["..."]}`.
- **Limits.**
  - The model sees one 30-s window per request (see the summary, item 2).
  - Hex doubles the size: 6 MB of hex holds about 98 s of audio. Only the first 30 s count.
- **Instances.** large-v3: ml.g5.2xlarge (default), ml.g5.4xlarge, ml.g5.8xlarge, ml.p3.2xlarge and ml.g4dn.2xlarge ([spec:whisper-v3]). Turbo has the same list ([spec:whisper-turbo]). The Price List has no us-east-1 hosting row for ml.p3.2xlarge ([price]).
- **Turbo handler.** It has the same decode and the same "identical" comment ([code:whisper-turbo]).
- **Accuracy (L).**
  - large-v3: avg 5.78, RTFx 470.2, AMI-Cleaned 13.63 ([lb-en]). Long-form average 11.23: earnings21 9.71, earnings22 13.16, TED-LIUM 3.15 ([lb-lf]). Multilingual means: FLEURS 3.41, MCV 5.59, MLS 4.96 ([lb-ml]).
  - Turbo: avg 6.36, RTFx 797.0, AMI-Cleaned 13.88. Long-form average 11.01. Multilingual means: FLEURS 3.89, MCV 7.66, MLS 5.00.
- **License.** large-v3 is Apache-2.0 ([spec:whisper-v3], [card:whisper]). The turbo spec has no license field. The leaderboard metadata says MIT (U10).

### 3.2 Qwen3-ASR 1.7B

- **Container.** `vllm:server-sagemaker-cuda-v1` ([spec:qwen3]). The artifact's `code/model.py` is only a startup hook. It installs audio wheels and reloads vLLM's audio module ([code:qwen3]).
- **Request.** The default payloads use the chat-completions format ([spec:qwen3]):
  - `messages[].content[]` holds `{"type": "input_audio", "input_audio": {"data": <base64 WAV>, "format": "wav"}}`.
  - An optional text part says "Transcribe the following audio."
  - The samples set `max_tokens: 256`.
- **Response.** Chat-completions text. There is no timestamp field.
- **Timestamps.** The model card says that timestamps need a separate model, Qwen3-ForcedAligner-0.6B. It "supports timestamp prediction for arbitrary units within up to 5 minutes of speech in 11 languages" ([card:qwen3]). That aligner is not in the JumpStart manifests.
- **Language.** The JumpStart body has no language field. In vLLM v0.22.1, the transcription path pre-fills `language <Name><asr_text>` from `to_language` ([vllm-qwen3] l.552–575). I could not confirm that the JumpStart image accepts that route (U7).
- **Limits.** Base64 gives about 147 s per 6 MB. The card says to set a larger `max_new_tokens` for long audio ([card:qwen3]). The JumpStart samples use 256.
- **Instances.** ml.g6.xlarge (default) and ml.g6.2xlarge ([spec:qwen3]).
- **Accuracy.**
  - (L): the leaderboard row is `Qwen/Qwen3-ASR-1.7B-hf` (U8). avg 4.31 is the best of all candidates and tenth on the whole leaderboard. AMI-Cleaned 8.31, RTFx 819.96 ([lb-en]). Multilingual means: FLEURS 3.85, MCV 5.30, MLS 7.91 ([lb-ml]).
  - (V): MLS 8.55, CommonVoice 9.18, Fleurs 4.90 ([card:qwen3]).
- **Languages (V).** 30 languages and 22 Chinese dialects ([card:qwen3]).
- **License.** Apache-2.0 ([spec:qwen3]).

### 3.3 Granite Speech 4.1 2B

- **Container.** The vLLM 0.22.1 image (`vllm:0.22.1-gpu-py312-cu130-ubuntu22.04-sagemaker`), with `SM_VLLM_MAX_MODEL_LEN=2048` ([spec:granite]).
- **Request.** The bundled `inference.py` does not run. Its docstring says: "The deployed vLLM 0.22.1 SageMaker DLC serves ibm-granite/granite-speech-4.1-2b with its NATIVE OpenAI-compatible server" ([code:granite]). The spec has no default payload. So the `InvokeEndpoint` body is UNVERIFIED (U6).
- **Timestamps.** This model has none. IBM's card says: "granite-speech-4.1-2b-plus adds speaker-attributed ASR and word-level time stamps" ([card:granite]). The `-plus` model is not on JumpStart. Whether vLLM serves its timestamps is UNVERIFIED.
- **Language.** vLLM v0.22.1 accepts en, fr, de, ja, pt and es ([vllm-granite] l.80–87). The transcribe prompt is fixed: "can you transcribe the speech into a written format?" ([vllm-granite] l.867–869). So `language` does not steer the model.
- **Limits (my estimate).**
  - vLLM's formula gives about 10 audio tokens per second. It uses the projector window 15 and the downsample rate 5 from `config.json` ([vllm-granite] l.891–913).
  - With 2,048 tokens for audio plus transcript, one prompt holds about 2 min of audio.
  - On vLLM's transcription route, vLLM splits at 30 s, so the cap applies to each 30-s chunk. I assumed a mel hop length of 160 (U6).
- **Accuracy.**
  - (L): avg 4.62, AMI-Cleaned 7.06, RTFx 545.6 ([lb-en]). That is the best AMI of the candidates, and eighth on the whole leaderboard for AMI-Cleaned.
  - (V): the eval file, dated 2026-04-23, gives mean WER 5.33, AMI 8.09 and RTFx 231.29 ([eval:granite]). It uses the older, uncleaned test sets.
  - Multilingual: the leaderboard has only the separate `-nar` model. IBM's card shows its multilingual WER only as images (U9).
- **Languages.** English, French, German, Spanish, Portuguese and Japanese ([spec:granite], [card:granite]).
- **Instance.** ml.g6.xlarge only ([spec:granite]). **License.** Apache-2.0.

### 3.4 Parakeet TDT 0.6B v2 and Parakeet CTC 1.1B (NVIDIA NIMs)

- **Packaging.** These are Marketplace model packages. Each spec lists model package ARNs for many regions, including us-east-1 ([spec:tdt], [spec:ctc]).
- **Request.** The JumpStart notebooks send `multipart/form-data` with `file` (WAV) and `language_code` (`en-US`). The gRPC test also sends `speaker_diarization` and `max_speakers` ([nb:ctc]).
- **Routing.** The TDT notebook says ([nb:tdt]):
  - "Small files (< 4MB): Automatically routed through HTTP for fast processing."
  - "Large files (≥ 4MB): Automatically routed through gRPC for efficient streaming."
  - Use `X-Amzn-SageMaker-Custom-Attributes: /invocations/http` or `/invocations/grpc` to force a route.
  - "The gRPC mode enables advanced features like speaker diarization and word-level timestamps."
- **Response.** The notebooks print the JSON response, but they contain no saved output. So the shape stays UNVERIFIED (U2). The CTC notebook mentions diarization on gRPC, but not word timestamps.
- **Instances.**
  - Both specs set ml.g6e.12xlarge as the default.
  - TDT allows ml.g6e.2xlarge to ml.g6e.48xlarge and ml.g6.2xlarge to ml.g6.48xlarge ([spec:tdt]).
  - CTC also allows ml.g5 sizes and ml.p4d/ml.p4de ([spec:ctc]).
  - The notebooks deploy on ml.g6e.2xlarge (TDT) and ml.g5.4xlarge (CTC).
- **Fee.** Each usage dimension that I read costs $1.00 per host per hour. That includes "ml.g6.2xlarge Inference (Real-Time)" and "ml.g6e.12xlarge Inference (Real-Time)" ([mp:tdt], [mp:ctc]).
- **License.** The vendor's EULA governs use ([mp:tdt], [mp:ctc]). I did not read the EULA text (U2). The open checkpoints on the leaderboard carry CC-BY-4.0 ([lb-en]). That license may not apply to the NIM build.
- **Accuracy (L, open checkpoints, U8).** TDT v2: avg 4.70, AMI-Cleaned 9.09, RTFx 6024.7, long-form average 11.18 ([lb-en], [lb-lf]). CTC 1.1B: avg 5.92, AMI-Cleaned 12.23.
- **Languages.** English only.

### 3.5 Nemotron 3.5 ASR streaming 0.6B

- **Container.** The PyTorch image 2.5.1. The spec's script is a no-op. The real handler is `code/inference.py` in the artifact ([spec:nemotron], [code:nemotron]).
- **Request.** There are two forms ([code:nemotron], [spec:nemotron]):
  - `audio/wav`: the language is `en-US`.
  - JSON: `{"audio_base64": <base64 WAV>, "language": "fr-FR"}`. The value `"auto"` makes the model detect the language and keep the language tag in the text.
- **Response.** `{"text": ..., "language": ...}`. There are no timestamps.
- **Limits.** The handler has no cap. It sends the whole clip through one `generate` call. The card says "Maximum Length in seconds specific to GPU Memory" ([card:nemotron]). Base64 gives about 147 s per 6 MB.
- **Language.** Locales. The card lists 40 language-locales in three tiers: 19 transcription-ready, 13 broad-coverage and 8 adaptation-ready ([card:nemotron]). The extension must map ISO-639-1 to a locale.
- **Accuracy (L).** avg 7.88 (the worst of the candidates), AMI-Cleaned 13.43, RTFx 1344.6 ([lb-en]). Multilingual means: FLEURS 7.51, MCV 10.16, MLS 10.51 ([lb-ml]).
- **Instance.** ml.g5.2xlarge only ([spec:nemotron]).
- **License.** OpenMDW-1.1. The card says "This model is ready for commercial use." ([card:nemotron]).

### 3.6 Voxtral Mini 4B Realtime 2602

- **Container.** `vllm:server-sagemaker-cuda-v2.0`. The artifact's `code/inference.py` is an empty file ([spec:voxtral], [code:voxtral]).
- **Request.** Multipart with `file` and `model: /opt/ml/model`, and the custom attributes `route=/v1/audio/transcriptions` ([spec:voxtral]).
- **Response.** vLLM `json`, that is `{"text"}`. vLLM refuses `verbose_json` for a model without `supports_segment_timestamp` ([vllm-serving] l.413–417).
- **Language.** vLLM v0.22.1 passes `language` into Mistral's `TranscriptionRequest` ([vllm-voxtral-rt] l.466–482). The vLLM version inside the `server-sagemaker-cuda-v2.0` image is unknown (U1).
- **Streaming.** The card says: "We strongly recommend using websockets to set up audio streaming sessions." ([card:voxtral]). Plain `InvokeEndpoint` gets the offline path.
- **Accuracy.**
  - (L): avg 6.46, AMI-Cleaned 13.34, RTFx 102.6 (the slowest candidate) ([lb-en]). Multilingual means: FLEURS 5.14, MCV 7.89, MLS 7.50 ([lb-ml]).
  - (V): FLEURS average 8.72% at 480 ms delay; AMI IHM 15.05% ([card:voxtral]).
- **Instances.** The default is ml.g6.16xlarge. The spec allows 18 types; the smallest is ml.g6.xlarge. The spec also sets `min_memory_mb: 131072` (U11) ([spec:voxtral]).
- **License.** Apache-2.0 ([spec:voxtral], [card:voxtral]).

## 4. Cost (us-east-1, On-Demand real-time hosting)

Hourly prices from the `USE1-Host:<type>` rows ([price]):

- ml.g4dn.2xlarge: $0.94
- ml.g6.xlarge: $1.1267
- ml.g6.2xlarge: $1.222
- ml.g5.2xlarge: $1.515
- ml.g6e.2xlarge: $2.8026
- ml.g6.16xlarge: $4.246
- ml.g6e.12xlarge: $13.1158
- ml.p3.2xlarge: no row

Per candidate, default instance and then smallest instance:

- Whisper on JumpStart: $1.515, then $0.94.
- Whisper on the vLLM container: $1.1267 on ml.g6.xlarge (U3). ml.g4dn.2xlarge is cheaper, but I did not confirm that the vLLM image runs on it (U12).
- Qwen3-ASR and Granite Speech: $1.1267.
- Voxtral: $4.246, then $1.1267.
- Nemotron: $1.515.
- Parakeet TDT and CTC, with the $1.00 fee: $14.1158, then $2.222 on ml.g6.2xlarge ([mp:tdt], [mp:ctc]).

If the endpoint runs all the time (730 h a month, my arithmetic): about $822 on ml.g6.xlarge, about $1,622 for a Parakeet NIM on ml.g6.2xlarge, and about $10,305 for a Parakeet NIM on its default instance.

## 5. Ranking

Rules: I apply the constraints in the brief's order. A hard fail on constraint 1 removes a model. Timestamps (2) and the language hint (3) weigh more than WER (4). Cost (5) breaks ties.

1. **Whisper large-v3 on the SageMaker vLLM container.** It passes 1, 2 (segment times) and 3. It covers many languages and costs $1.1267/h. It is weak on AMI. As JumpStart ships it, the same model is a poor fit: text only, and 30-s windows give one speaker for each 30 s.
2. **Runner-up: Parakeet TDT 0.6B v2 NIM.** It is the only JumpStart listing that returns timestamps as shipped, and its AMI WER is good. It fails "many languages", because it is English-only. At its smallest size, it costs about twice the recommended engine.
3. **Whisper large-v3-turbo on the same vLLM path.** It fits the same way as #1, and it is faster (RTFx 797 against 470). Its WER is worse on every test set. Use it only if #1 does not finish within 60 s.
4. **Qwen3-ASR 1.7B.** It has the best avg EN WER (4.31), many languages and a low price. The model gives no timestamps, and the JumpStart body has no language field.
5. **Granite Speech 4.1 2B.** It has the best AMI WER (7.06) and a low price. It gives no timestamps, it does not use the language, it has six languages, and it has a 2,048-token cap. Its body is UNVERIFIED.
6. **Parakeet CTC 1.1B NIM.** English only. AMI-Cleaned 12.23. Its word timestamps are UNVERIFIED.
7. **Nemotron 3.5 ASR streaming 0.6B.** It takes a locale hint and has 40 locales. It gives no timestamps and has the worst WER here.
8. **Voxtral Mini 4B Realtime 2602.** It gives no timestamps and is the slowest. It is a streaming model used offline, and its default instance is large.

## 6. Recommendation

Use **Whisper large-v3**: the `openai/whisper-large-v3` weights behind `huggingface-asr-whisper-large-v3`. Serve them on the SageMaker vLLM container, and call them through `route=/v1/audio/transcriptions`.

Reasons:

1. **Timestamps.** It is the only multilingual candidate whose timestamps can reach the extension through plain `InvokeEndpoint` ([vllm-whisper] l.816, [vllm-serving] l.413–417).
2. **Language hint.** vLLM takes the ISO-639-1 Meeting Language as it is, and it forces that language in the decoder prompt. There is no auto-detect when `language` is set ([vllm-whisper] l.818–849).
3. **Languages and cost.** 99 languages, the best mean FLEURS WER of the candidates, Apache-2.0, no Marketplace fee, and $1.1267/h on ml.g6.xlarge ([lb-ml], [card:whisper], [price]).

What the extension gives up: about twice Granite's error rate on AMI (13.63 against 7.06, L).

The smallest change. This part is outside JumpStart, so I keep it short:

- Create a SageMaker model from the image tag that the Voxtral spec uses, `vllm:server-sagemaker-cuda-v2.0` ([spec:voxtral]). Use the same environment pattern, `HF_MODEL_ID=/opt/ml/model`.
- For model data, you can point at the S3 prefix that JumpStart already hosts for Whisper, `huggingface-asr/huggingface-asr-whisper-large-v3/artifacts/inference/v1.0.0/` ([spec:whisper-v3]). It holds standard Hugging Face files: `config.json`, two `safetensors` shards, the tokenizer files and `preprocessor_config.json`. That vLLM loads this prefix without change is UNVERIFIED.
- Send multipart with `file`, `model`, `language=<ISO-639-1>`, `response_format=verbose_json` and `timestamp_granularities[]=segment` ([vllm-proto] l.69–106). Set the header `X-Amzn-SageMaker-Custom-Attributes: route=/v1/audio/transcriptions`. Each segment in the response has `start` and `end` in seconds ([vllm-proto] l.346–361).
- Window length:
  - A window of 30 s or less gives exact times.
  - A longer window (up to about 3 min) makes vLLM split it. vLLM picks each split point by low audio energy within a 1-s overlap ([vllm-cfg] l.63–74). But it shifts each chunk by exactly `index × 30 s` ([vllm-serving] l.554). So later segment times can be off by about the overlap (my reading of the code, U5).
- vLLM's own upload cap is 25 MB (`VLLM_MAX_AUDIO_CLIP_FILESIZE_MB`) ([vllm-envs] l.79). The 6 MB body limit is the tighter one.

A second, larger change keeps the JumpStart PyTorch container: replace the handler with one that calls `generate(..., return_timestamps=True)` and keeps the timestamp tokens. That needs your own model code and your own long-form logic. The vLLM path needs no model code.

## 7. UNVERIFIED items

- **U1.** I did not confirm that the SageMaker vLLM image honors `route=/v1/audio/transcriptions` for Whisper weights and returns `verbose_json` through `InvokeEndpoint`. JumpStart uses the route only for Voxtral ([spec:voxtral]). The vLLM version inside `server-sagemaker-cuda-v2.0` is unknown. My vLLM facts come from v0.22.1.
- **U2.** For the Parakeet NIMs, I did not confirm the response shape for words, times and speaker tags, the audio-length limits, or the EULA terms. The notebooks contain no saved output.
- **U3.** I did not confirm the speed for 3-min windows on ml.g6.xlarge within 60 s. The leaderboard's RTFx comes from other hardware.
- **U4.** That the JumpStart Whisper handler cuts audio after 30 s is my inference from the code and the bundled 30-s preprocessor config. I did not test it.
- **U5.** I did not test how far vLLM's `index × 30 s` offset drifts from the real split points. I did not read `split_audio`.
- **U6.** For Granite Speech, I did not confirm the `InvokeEndpoint` body on the vLLM 0.22.1 container. The 2-min estimate also assumes a mel hop length of 160.
- **U7.** I did not confirm that Qwen3-ASR takes a language hint through JumpStart. The chat body has no field. The vLLM `to_language` path needs the transcription route on the `server-sagemaker-cuda-v1` image.
- **U8.** The leaderboard rows may not match the JumpStart weights exactly. The Qwen3 row is the `-hf` conversion. The Parakeet rows are the open checkpoints, not the NIM builds.
- **U9.** I have no multilingual WER for Granite Speech 4.1 2B. The card shows it only as images, and the leaderboard has only the `-nar` model.
- **U10.** For the Whisper large-v3-turbo license, I have only the leaderboard metadata. The JumpStart spec has no license field, and I did not read the owner's card.
- **U11.** I did not confirm that ml.g6.xlarge works for Voxtral, because the spec sets `min_memory_mb: 131072`.
- **U12.** I did not confirm that the vLLM image runs on ml.g4dn.2xlarge.
- **U13.** I did not read the specs for `cambai-mars6` and `cartesia-sonic-3-sagemaker`. I judged them text-to-speech by name.

## 8. References

All JumpStart cache paths are relative to `https://jumpstart-cache-prod-us-west-2.s3.us-west-2.amazonaws.com/`. The prepacked artifacts are S3 prefixes; I read single files from them.

- [manifest] `models_manifest.json` (Last-Modified 2026-10-04 22:26:57 GMT).
- [prop-manifest] `proprietary-sdk-manifest.json` (Last-Modified 2026-09-15 13:02:52 GMT).
- [spec:whisper-v3] `community_models/huggingface-asr-whisper-large-v3/specs_v1.1.0.json`.
- [spec:whisper-turbo] `community_models/huggingface-asr-whisper-large-v3-turbo/specs_v1.1.17.json`.
- [spec:qwen3] `community_models/huggingface-asr-qwen3-asr-1-7b/specs_v1.0.2.json`.
- [spec:granite] `community_models/huggingface-asr-ibm-granite-granite-speech-4-1-2b/specs_v1.0.0.json`.
- [spec:voxtral] `community_models/huggingface-asr-voxtral-mini-4b-realtime-2602/specs_v1.0.0.json`.
- [spec:nemotron] `community_models/huggingface-asr-nvidia-nemotron-3-5-asr-streaming-0-6b/specs_v1.0.0.json`.
- [spec:omni] `community_models/huggingface-vlm-nvidia-nemotron3-nano-omni-30ba3b-reasoning-fp8/specs_v1.2.0.json`.
- [spec:tdt] `proprietary-models/nvidia-parakeetvtdt-0-6b-v2/proprietary_specs_2.0.json`.
- [spec:ctc] `proprietary-models/nvidia-parakeet-1-1b-ctc-en-us-asr/proprietary_specs_1.3.json`.
- [code:whisper] `huggingface-asr/huggingface-asr-whisper-large-v3/artifacts/inference-prepack/v1.1.0/code/` (`inference.py`, `audio_validation.py`, `constants/constants.py`).
- [cfg:whisper] `huggingface-asr/huggingface-asr-whisper-large-v3/artifacts/inference-prepack/v1.1.0/preprocessor_config.json`.
- [code:whisper-turbo] `huggingface-asr/huggingface-asr-whisper-large-v3-turbo/artifacts/inference-prepack/v1.0.0/code/inference.py`.
- [code:whisper-v2] `huggingface-asr/huggingface-asr-whisper-large-v2/artifacts/inference-prepack/v2.1.0/code/inference.py`.
- [code:qwen3] `huggingface-asr/huggingface-asr-qwen3-asr-1-7b/artifacts/inference-prepack/v1.0.0/code/model.py`.
- [code:granite] `huggingface-asr/huggingface-asr-ibm-granite-granite-speech-4-1-2b/artifacts/inference-prepack/v1.0.0/code/inference.py`.
- [code:voxtral] `huggingface-asr/huggingface-asr-voxtral-mini-4b-realtime-2602/artifacts/inference-prepack/v1.0.0/code/inference.py` (0 bytes).
- [code:nemotron] `huggingface-asr/huggingface-asr-nvidia-nemotron-3-5-asr-streaming-0-6b/artifacts/inference-prepack/v1.0.0/code/inference.py`.
- [card:qwen3], [card:granite], [card:voxtral], [card:nemotron] `README.md` in the same four prepack prefixes. These are the owners' Hugging Face model cards: Qwen, IBM, Mistral AI and NVIDIA.
- [eval:granite] `huggingface-asr/huggingface-asr-ibm-granite-granite-speech-4-1-2b/artifacts/inference-prepack/v1.0.0/.eval_results/open_asr_leaderboard.yaml`.
- [card:whisper] https://huggingface.co/openai/whisper-large-v3 (`README.md`; OpenAI).
- [nb:tdt] `pmm-notebooks/pmm-notebook-nvidia-parakeetvtdt-0-6b-v2-jl.ipynb`.
- [nb:ctc] `pmm-notebooks/pmm-notebook-nvidia-parakeet-1-1b-ctc-en-us-asr-jl.ipynb`.
- [mp:tdt] https://aws.amazon.com/marketplace/pp/prodview-r2hrzimxjtjfg (served 2026-10-06).
- [mp:ctc] https://aws.amazon.com/marketplace/pp/prodview-h7nkt7zwciqqi (served 2026-10-06).
- [price] https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSageMaker/current/us-east-1/index.csv (version `20261005212151`).
- [lb-space] https://huggingface.co/spaces/hf-audio/open_asr_leaderboard/blob/main/init.py (`VERSIONS["02-10-2026"]`).
- [lb-en] https://huggingface.co/datasets/hf-audio/open-asr-leaderboard-results/blob/c23ca4f10e5f1a77c9fd3b41e17cd06a04f0f56c/english_short_latest.csv
- [lb-ml] https://huggingface.co/datasets/hf-audio/multilingual_evals/tree/54d262667d97d24108560c3b6858713b7eb01ecc (`multilingual_{fr,de,es,it,pt,nl}.csv`).
- [lb-lf] https://huggingface.co/datasets/hf-audio/leaderboard_longform/blob/4f164c2c904b630d9777323b5d2e7f1f549d0143/longform_latest.csv
- [vllm-serving] https://github.com/vllm-project/vllm/blob/v0.22.1/vllm/entrypoints/speech_to_text/base/serving.py
- [vllm-proto] https://github.com/vllm-project/vllm/blob/v0.22.1/vllm/entrypoints/speech_to_text/transcription/protocol.py
- [vllm-cfg] https://github.com/vllm-project/vllm/blob/v0.22.1/vllm/config/speech_to_text.py
- [vllm-envs] https://github.com/vllm-project/vllm/blob/v0.22.1/vllm/envs.py
- [vllm-whisper] https://github.com/vllm-project/vllm/blob/v0.22.1/vllm/model_executor/models/whisper.py
- [vllm-granite] https://github.com/vllm-project/vllm/blob/v0.22.1/vllm/model_executor/models/granite_speech.py
- [vllm-qwen3] https://github.com/vllm-project/vllm/blob/v0.22.1/vllm/model_executor/models/qwen3_asr.py
- [vllm-voxtral-rt] https://github.com/vllm-project/vllm/blob/v0.22.1/vllm/model_executor/models/voxtral_realtime.py
