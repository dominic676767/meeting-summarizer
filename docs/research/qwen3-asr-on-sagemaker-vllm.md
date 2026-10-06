# Qwen3-ASR 1.7B on the JumpStart vLLM image: how a client calls it through InvokeEndpoint

Researched 2026-10-06 for the planned SageMaker transcription engine. The question is: how does the extension call `huggingface-asr-qwen3-asr-1-7b` (spec 1.0.2) with one SigV4-signed `InvokeEndpoint` call, and how does it force the Meeting Language? This note follows up U1 and U7 of [sagemaker-jumpstart-stt.md](sagemaker-jumpstart-stt.md). That note has the candidates, the accuracy numbers, the prices, the 6 MB / 60 s limits and the body-size arithmetic. This note does not repeat them.

**Sources.** Only primary sources were used:

- The public JumpStart cache `jumpstart-cache-prod-us-west-2`: the spec `specs_v1.0.2.json` and two files of the prepacked artifact ([spec], [js:model.py], [js:tmpl]).
- The image itself, from the ECR Public registry `public.ecr.aws/deep-learning-containers/vllm`. I read the manifests of eight tags, two image configs and three small layers, with an anonymous pull token ([ecr]). I called no AWS account and sent no SigV4 request. JumpStart pulls the same tag name from the private registry `763104351884.dkr.ecr.<region>.amazonaws.com` ([spec]). That the private tag has the same digest is UNVERIFIED (U1).
- `aws/deep-learning-containers` at commit `bdc480f` (2026-10-05): the changelog, the image data files, the build config, the Dockerfile and the scripts ([dlc:…]).
- vLLM source at commit `3f5bd482`. That is the exact commit inside `server-sagemaker-cuda-v1` ([img:manifest]). All `[vllm:…]` keys point to this commit, not to the tag `v0.22.1` that the sibling note used.
- Qwen's model card and model files on Hugging Face at revision `7278e1e` ([card], [hf:…]). Qwen's GitHub repo `QwenLM/Qwen3-ASR` at commit `7c6daf7` ([qwen:…]).

Keys in square brackets resolve in §10. "l." gives line numbers in that file.

---

## Summary: findings that change the design

1. **`server-sagemaker-cuda-v1` runs vLLM 0.20.0.dev361 (commit `3f5bd482`), not 0.19.1.**
   - In the registry, `-v1` has the same manifest digest as `-v1.4` ([ecr]).
   - The `-v1` image config has the label `com.amazonaws.ml.engines.sagemaker.dlc.framework.vllm-server.0-20-0-dev361` and `dlc_minor_version = 4` ([ecr]). The image's `SOURCE_MANIFEST` names vLLM commit `3f5bd482` and lists no patches ([img:manifest]).
   - The DLC docs data file still puts `server-sagemaker-cuda-v1` under `0.19.1+amzn2023.6ef1efd5` ([dlc:data-v1] l.2, l.12). That file is out of date.
   - `server-sagemaker-cuda-v2.0` runs vLLM `0.22.1rc0` (commit `6aabe221`) ([ecr], [img:manifest-v2.0], [dlc:changelog] v2.0.0). This answers the version part of the sibling note's U1.
2. **The JumpStart Qwen3-ASR endpoint already has the transcription route.** The `-v1` image starts vLLM with a DLC middleware. The middleware sends `/invocations` to the path in `X-Amzn-SageMaker-Custom-Attributes: route=<path>` ([img:entry] l.41–46, [img:serve] l.25–52). AWS added it in v1.4.0 ([dlc:changelog] v1.4.0). The `-v2.0` image has the same file ([img:serve-v2.0]). This answers most of the sibling note's U7. No live call confirms it (U2).
3. **To force the Meeting Language, send `to_language`. The `language` field does not reach the model.** For Qwen3-ASR, vLLM writes `language <Name><asr_text>` into the prompt from `to_language` only ([vllm:qwen3] l.552–583). vLLM does not copy `language` into `to_language` ([vllm:proto] l.199–215). `language` only selects the separator between 30-s chunks ([vllm:stt] l.72–80, l.497–499).
4. **On the transcription route, vLLM strips the `language <Name><asr_text>` prefix. The chat route returns it** (§4, §5).
5. **The chat route cannot force the language with the shipped chat template.** Qwen's template writes only the system text, the audio placeholders and the generation prompt. It drops all user text and all assistant messages ([hf:tmpl]). So an assistant prefill does not reach the model, and JumpStart's "Transcribe the following audio." text has no effect. vLLM also refuses a chat template in the request on this image ([vllm:engine] l.520–538).
6. **The transcription route cuts the audio into chunks of 30 s or less. The chat route sends the whole clip in one prompt.** vLLM takes the 30-s limit from `preprocessor_config.json` ([vllm:qwen3] l.541–549, [hf:pre]). Qwen's own package accepts up to 1,200 s in one pass ([qwen:utils] l.34). Design option (my inference): cut each request at a caption speaker turn, and keep it at 30 s or less. Then vLLM does not split it, and the language is still forced.
7. **For 28 of Qwen's 30 languages, the ISO-639-1 code maps to the exact name that Qwen uses.** Filipino and Cantonese do not map ([vllm:langs] l.6–64, [qwen:utils] l.37–68). See §7.
8. **Silence.** Qwen's parser reads `language None<asr_text>` as "no speech" ([qwen:utils] l.414, l.449–455). Without `to_language`, vLLM turns that output into empty text ([vllm:qwen3] l.585–601). With `to_language`, the prompt already names the language, so the model cannot answer `None`. What it returns then is UNVERIFIED (U5).
9. **The request to send** is in §8.

---

## 1. Image versions and where the image source is

| tag | manifest digest (first 16 hex) | vLLM | vLLM commit | release date |
|---|---|---|---|---|
| `server-sagemaker-cuda-v1.0` | `950112443d2114a6` | 0.19.1 | `6ef1efd5` | 2026-04-25 |
| `server-sagemaker-cuda-v1.1` | `a40278ee646e4cd8` | 0.19.1 | `6ef1efd5` | 2026-04-28 |
| `server-sagemaker-cuda-v1.2` | `11fa347aa8025478` | 0.20.0.dev60 | `8a8c9b56` | 2026-04-30 |
| `server-sagemaker-cuda-v1.3` | `5535a17c49d21e58` | 0.20.0.dev361 | `3f5bd482` | 2026-05-12 |
| `server-sagemaker-cuda-v1.4` | `5f2076d835997811` | 0.20.0.dev361 | `3f5bd482` | 2026-05-22 |
| **`server-sagemaker-cuda-v1`** (JumpStart Qwen3-ASR) | **`5f2076d835997811`** (same as v1.4) | **0.20.0.dev361** | **`3f5bd482`** | (moving tag) |
| `server-sagemaker-cuda-v2.0` (JumpStart Voxtral) | `1d94de7a64e81cb0` | 0.22.1rc0 | `6aabe221` | 2026-06-05 |

The digests come from the registry ([ecr]). The versions, commits and dates come from the changelog ([dlc:changelog]). For `-v1` and `-v2.0`, the image labels and `SOURCE_MANIFEST` confirm the version and the commit ([ecr], [img:manifest], [img:manifest-v2.0]).

- The changelog gives the tag format `server-cuda[-vMAJOR[.MINOR[.PATCH]]]` ([dlc:changelog] v1.0.0). The registry shows that `-v1` moved to v1.4 ([ecr]). So `-v1` is a moving tag. AWS can move it again (my inference, U1).
- The `-v1` config was created 2026-06-01T18:58:40Z. Its `SOURCE_MANIFEST` says "Built: 2026-05-28 23:58:18 UTC" ([ecr], [img:manifest]). So AWS rebuilt v1.4 after the release date, with the same vLLM commit.
- `0.20.0.dev361` is a development version, not a vLLM release tag (my reading of the version string). Neither image runs the vLLM tag `v0.22.1`.
- The JumpStart spec was last modified 2026-06-29, after v2.0 shipped. It still uses `-v1` ([spec]).
- The `-v2` tag has a different digest (`64fa565e864edb53`) from `-v2.0` ([ecr]). So `-v2` also moved on.

Where the source is, in `aws/deep-learning-containers` at `bdc480f`:

- There is no top-level `vllm/` folder, no vLLM buildspec and no committed `available_images.md` (repo tree listing).
- Build config: `.github/config/image/vllm/sagemaker-amzn2023.yml`. It names the Dockerfile `docker/vllm/Dockerfile.amzn2023` and the target `vllm-sagemaker-amzn2023` ([dlc:config] l.17–18). At this commit it builds v2.6 ([dlc:config] l.28–29).
- Dockerfile: the SageMaker stage starts at l.490. It installs `libsndfile` (l.495), copies the two scripts (l.501–502) and sets the entrypoint (l.507) ([dlc:docker]).
- Scripts: `scripts/docker/vllm/sagemaker_entrypoint.sh` and `scripts/docker/vllm/sagemaker_serve.py`. The repo's `sagemaker_serve.py` is byte-identical to the copy in both images ([dlc:serve], [img:serve]). The image history shows the older path `./scripts/vllm/` ([ecr]).
- Release notes: `docs/vllm/changelog/index.md` ([dlc:changelog]).
- Image list: `docs/src/data/vllm-server/*.yml`. The docs build renders these files through `docs/src/templates/reference/available_images.template.md` ([dlc:template]). There is no data file for v1.2, v1.3 or v1.4.

## 2. Routing in the image

Startup ([img:entry]):

- The entrypoint runs `standard-supervisor python3 -m vllm.entrypoints.openai.api_server` on port 8080 (l.9, l.46).
- It adds `--model /opt/ml/model` when `SM_VLLM_MODEL` is not set and `/opt/ml/model` is not empty (l.12–15). The JumpStart spec does not set `SM_VLLM_MODEL` ([spec]).
- It turns each `SM_VLLM_*` variable into a flag. The value `true` gives the flag alone. The value `false` drops the flag (l.24–39). The spec sets `SM_VLLM_MAX_MODEL_LEN=32768` on both instance types ([spec]). So vLLM gets `--max-model-len 32768`.
- It adds `--middleware sagemaker_serve.SageMakerRouteMiddleware` (l.41–44). vLLM adds a middleware class with `app.add_middleware` ([vllm:api] l.301–307).

The route parser, from `/usr/local/bin/sagemaker_serve.py` in the `-v1` image ([img:serve] l.25–30):

```python
def _parse_route(headers: list[tuple[bytes, bytes]]) -> str | None:
    for key, value in headers:
        if key.lower() == b"x-amzn-sagemaker-custom-attributes":
            m = re.search(r"route=(/[^\s,]+)", value.decode())
            return m.group(1) if m else None
    return None
```

The rewrite ([img:serve] l.43–52):

```python
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["path"] == "/invocations":
            route = _parse_route(scope.get("headers", []))
            if route:
                logger.info("Rerouting /invocations -> %s", route)
                scope = dict(scope)
                scope["path"] = route
                scope["raw_path"] = route.encode()

        await self.app(scope, receive, send)
```

What this means:

- **Header.** The docstring gives the SDK form `CustomAttributes="route=/v1/audio/transcriptions"` ([img:serve] l.3–6).
- **Default route.** Without `route=`, the request stays on `/invocations`. The docstring says that it "falls through to vLLM's built-in /invocations handler (chat/completion/embed)" ([img:serve] l.8–9). That handler needs a JSON body (`Depends(validate_json_request)`, [vllm:sm] l.55–63). It tries each request type in order and uses the first type that validates ([vllm:sm] l.77–89). For a text-generation model, the order is chat completions, then completions ([vllm:factories] l.38–39). So JumpStart's chat payload goes to chat completions.
- **Multipart body.** The middleware changes only `path` and `raw_path`. It passes `receive` on unchanged, so it does not read or change the body ([img:serve] l.43–52). The docstring says: "SageMaker passes ContentType and Body through to the container verbatim, so clients can send multipart/form-data directly for audio endpoints." ([img:serve] l.11–12). vLLM's transcription route reads `file` as a form upload ([vllm:proto] l.63). A multipart body without `route=` fails the JSON check of the default handler (my reading of [vllm:sm] l.55–63).
- **No allowlist.** The parser accepts any value that starts with `/`. The value stops at the first space or comma ([img:serve] l.28). So other attributes can share the header after a comma (my reading).
- **Side effect (my reading).** A rerouted request does not reach vLLM's `invocations` function. So the three decorators on that function do not apply to it: the custom handler from `model.py`, the session manager and the LoRA adapter injection ([vllm:sm] l.64–66). The Qwen3-ASR artifact registers no handler (§3). So this changes nothing here.
- I did not read `model-hosting-container-standards`. The image installs `>=0.1.15,<1.0.0` ([ecr]). vLLM calls its `bootstrap(app)` ([vllm:sm] l.102–103). That call can add more middleware (UNVERIFIED, U3).

## 3. What the JumpStart artifact adds

- `code/model.py` is a startup hook. It installs the bundled `av`, `soundfile` and `resampy` wheels from `/opt/ml/model/lib`. Then it reloads `vllm.multimodal.media.audio` ([js:model.py] l.10–24). It registers no `/ping` or `/invocations` handler.
- The image loads `model.py` from the model artifacts (changelog v1.3.0: "Custom `/ping` and `/invocations` handler support via `model.py` in model artifacts", [dlc:changelog]).
- vLLM's audio module puts a `PlaceholderModule` in place of a missing `av` or `soundfile` ([vllm:audio] l.21–29). The spec turns on network isolation (`inference_enable_network_isolation: true`, [spec]). So the container cannot download these packages, and the hook installs them from the artifact.
- Both routes decode audio with `load_audio` from that module ([vllm:stt] l.46, l.206–210, [vllm:audio] l.132–141). So the hook serves the transcription route too, if it serves JumpStart's own chat samples (my reading, U2).
- The spec's `predictor_specs` list only `application/json` ([spec]). That list is for the SageMaker Python SDK predictor. A raw `InvokeEndpoint` call sets its own `Content-Type` (my reading).

## 4. Qwen3-ASR on `/v1/audio/transcriptions` at vLLM `3f5bd482`

**Transcription support.** Yes. `Qwen3ASRForConditionalGeneration` implements `SupportsTranscription` ([vllm:qwen3] l.264–270). It sets `supported_languages = ISO639_1_SUPPORTED_LANGS` ([vllm:qwen3] l.285). It does not set `supports_segment_timestamp`, so the default `False` applies ([vllm:iface] l.1086). vLLM refuses `verbose_json` for such a model ([vllm:stt] l.401–407).

**The prompt.** vLLM builds the prompt from `to_language` only ([vllm:qwen3] l.557, l.566–576):

```python
        full_lang_name_to = cls.supported_languages.get(to_language, to_language)
        if to_language is None:
            prompt = (
                f"<|im_start|>user\n{audio_placeholder}<|im_end|>\n"
                f"<|im_start|>assistant\n"
            )
        else:
            prompt = (
                f"<|im_start|>user\n{audio_placeholder}<|im_end|>\n"
                f"<|im_start|>assistant\nlanguage {full_lang_name_to}{_ASR_TEXT_TAG}"
            )
```

- `language`: vLLM validates it ([vllm:stt] l.187) and passes it on as `stt_params.language` ([vllm:proto] l.210). The Qwen3-ASR prompt does not read it.
- `to_language`: vLLM validates it with the same check ([vllm:stt] l.188–192). It passes it on as `stt_params.to_language` ([vllm:proto] l.213). The prompt maps the ISO-639-1 code to a name with the 57-entry map, for example `de` to `German` ([vllm:langs] l.6–64).
- vLLM does not set `to_language` from `language`. The client must send it. The field's docstring is out of date for this model: "Please note that this is not currently used by supported models at this time" ([vllm:proto] l.132–137).
- `prompt` and `hotwords` also go into `stt_params` ([vllm:proto] l.212, l.214). The Qwen3-ASR prompt ignores both ([vllm:qwen3] l.552–583).
- The prompt has no system turn. Qwen's own package sends a system turn, empty when there is no context ([qwen:infer] l.448–452). The effect of this difference is UNVERIFIED (U6).
- Qwen ran its evaluations with no language parameter ([card] l.569). So the published WER numbers are for auto-detect. The effect of a forced language on accuracy is UNVERIFIED (U6).

**Which codes pass validation** ([vllm:iface] l.1135–1158):

- A code in the 57-entry map passes.
- Another code passes with a warning if it is in transformers' Whisper `LANGUAGES` list ([vllm:iface] l.29, l.1130–1132). I did not read that list (U4).
- All other codes fail with `Unsupported language: …`.
- A code that passes but is not in the map goes into the prompt as the raw code, for example `language yue<asr_text>` ([vllm:qwen3] l.566).

**Post-processing.** Yes, vLLM strips the prefix ([vllm:qwen3] l.585–601):

```python
    @classmethod
    def post_process_output(cls, text: str) -> str:
        """
        Post-process Qwen3-ASR raw output to extract clean transcription.

        The model outputs in format: "language {lang}<asr_text>{transcription}"
        This method strips the language prefix and asr_text tags.
        """
        if not text:
            return ""

        if _ASR_TEXT_TAG not in text:
            return text

        # Split on <asr_text> tag and take the transcription part
        _, text_part = text.rsplit(_ASR_TEXT_TAG, 1)
        return text_part
```

- vLLM calls it for each chunk on the non-streaming path ([vllm:stt] l.546).
- With `to_language`, the prefix is part of the prompt, not of the output. So the output has no tag, and the method returns it unchanged (l.596–597).
- The streaming path does not strip the prefix. A TODO says so ([vllm:stt] l.643–646). `InvokeEndpoint` does not stream, so this does not apply.
- `rsplit` keeps the text after the last tag. Qwen's parser splits at the first tag ([qwen:utils] l.442). The results differ only when the text has a second tag.

**Clip length and chunking.**

- `max_audio_clip_s` comes from the feature extractor's `chunk_length` ([vllm:qwen3] l.541–549). Qwen's `preprocessor_config.json` sets `chunk_length: 30` ([hf:pre]). So the limit is 30 s.
- Qwen3-ASR keeps the default `min_energy_split_window_size = 1600`. So `allow_audio_chunking` is true ([vllm:cfg] l.74, l.81–85).
- vLLM splits a longer clip ([vllm:stt] l.212–229), with 1 s of overlap ([vllm:cfg] l.69). Each chunk gets the same prompt, with the same forced language ([vllm:stt] l.240–247).
- vLLM joins the chunk texts with `" "`, or with `""` when `language` is `ja` or `zh` ([vllm:stt] l.72–80, l.497–499, l.547; [vllm:iface] l.1101). So send `language` too, with the same code as `to_language`.
- The response is `{"text": …}`, plus `usage` with `"type": "duration"` and the whole seconds ([vllm:stt] l.550–556).
- vLLM's upload limit is still 25 MB ([vllm:envs] l.77, l.851–852). The 6 MB body limit is the tighter one.
- `max_completion_tokens` is a form field ([vllm:proto] l.186). vLLM computes the token cap for each chunk from it, the context length and the model defaults ([vllm:stt] l.441–446). Qwen's `generation_config.json` sets no token limit ([hf:gen]). So without the field, the cap is not the 256 of the JumpStart chat samples (my reading; I did not read `get_max_tokens`).

## 5. The chat-completions route (JumpStart's sample payload)

**The output starts with `language <Name><asr_text>`** (my reading of the code; I saw no saved output, U10):

- On the chat route, vLLM has no Qwen3-ASR post-processing. In the parts of vLLM that I checked out (entrypoints, renderers, transformers_utils), the only other mention of `asr_text` is the streaming TODO in §4.
- `<asr_text>` is not a special token. It has id 151704 and `"special": false` ([hf:tok]). So `skip_special_tokens` does not remove it.
- Qwen's own vLLM example tells the client to parse the chat content with `parse_asr_output` ([card] l.239–243).

**The chat template.** Qwen's `chat_template.json` and the JumpStart copy are byte-identical ([hf:tmpl], [js:tmpl]). Decoded, the template ends with:

```jinja
{{- '<|im_start|>system\n' + (ns.system_text if ns.system_text is string else '') + '<|im_end|>\n' -}}
{{- '<|im_start|>user\n' + ns2.audio_tokens + '<|im_end|>\n' -}}
{%- if add_generation_prompt -%}
{{- '<|im_start|>assistant\n' -}}
{%- endif -%}
```

- It writes the system text, one `<|audio_start|><|audio_pad|><|audio_end|>` for each audio part, and the generation prompt. It writes no user text and no assistant message.
- It finds audio parts with `c.type == 'audio' or ('audio' in c) or ('audio_url' in c)` ([hf:tmpl]). vLLM detects the "openai" content format for a template that loops over the content ([vllm:hf] l.428–445). Then it passes each audio part as `{"type": "audio"}` ([vllm:chat-utils] l.1729). That is why JumpStart's `input_audio` parts match (my reading).
- vLLM's Qwen3-ASR processor sets `truncation=False` ([vllm:proc] l.115–116). So the chat route does not cut the clip at 30 s (my reading).
- The JumpStart samples set `max_tokens: 256` ([spec]). The card says to set a larger value for long audio ([card] l.121). The `language <Name><asr_text>` prefix also uses some of these tokens (my inference).

**How Qwen forces the language.** The card says: `language=None, # set "English" to force the language` ([card] l.126). The package docstring says: "If language is provided, the prompt will force the output to be text-only by appending "language {Language}<asr_text>" to the assistant prompt." ([qwen:infer] l.141–142). The code ([qwen:infer] l.454–465):

```python
    def _build_text_prompt(self, context: str, force_language: Optional[str]) -> str:
        """
        Build the string prompt for one request.

        If force_language is provided, "language X<asr_text>" is appended after the generation prompt
        to request text-only output.
        """
        msgs = self._build_messages(context=context, audio_payload="")
        base = self.processor.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False)
        if force_language:
            base = base + f"language {force_language}{'<asr_text>'}"
        return base
```

**Can the client do the same on the JumpStart chat route? Not with the shipped template.**

- **Assistant prefill with `continue_final_message`.** vLLM offers this flag to "prefill" part of the reply ([vllm:chat-proto] l.257–266). But the template never writes an assistant message. So the prefill text cannot reach the prompt. What vLLM returns then (an error, or a prompt with no assistant turn) is UNVERIFIED (U7).
- **A text prompt in the user message.** The template drops it. So the text in JumpStart's `transcribeWithPrompt` sample never reaches the model ([spec], [hf:tmpl]).
- **A system message.** The template keeps it. Qwen's package puts its "context" there ([qwen:infer] l.448–452). Qwen documents no language control through it. Its effect is UNVERIFIED (U7).
- **A chat template in the request.** vLLM refuses it: "Chat template is passed with request, but --trust-request-chat-template is not set. Refused request with untrusted chat template." ([vllm:engine] l.520–538). The flag is off by default ([vllm:chat-utils] l.1251), and the JumpStart environment does not set it ([spec]). If you create the SageMaker model yourself, `SM_VLLM_TRUST_REQUEST_CHAT_TEMPLATE=true` adds the flag ([img:entry] l.24–39). A request template with an assistant branch could then carry the prefix. This path is UNVERIFIED (U7). The transcription route does the same job without it.

## 6. Silence and audio without speech

- Qwen's parser lists the case: `"language None<asr_text>": treat as empty audio -> ("", "")` ([qwen:utils] l.414). The code ([qwen:utils] l.449–455):

  ```python
      # empty audio heuristic
      if "language none" in meta_lower:
          t = text_part.strip()
          if not t:
              return "", ""
          # if model still returned something, keep it but language unknown
          return "", t
  ```

- The result class says that the language is "Empty string if unknown or silent audio." ([qwen:infer] l.58–65).
- With a forced language, Qwen's parser treats the whole output as text ([qwen:utils] l.416–417, l.434–436). So Qwen's own code has no silence case for a forced language.
- Transcription route, no `to_language`: `post_process_output` returns the text after the tag. For `language None<asr_text>`, that is `""` (my reading of [vllm:qwen3] l.585–601).
- Transcription route, with `to_language`: UNVERIFIED (U5). The model can return empty text, or it can invent text.
- Chat route: the client gets the raw `language None<asr_text>`. The client must turn it into empty text, as Qwen's parser does.
- Qwen's parser also runs `detect_and_fix_repetitions` on each output ([qwen:utils] l.335, l.432). vLLM's `post_process_output` does not ([vllm:qwen3] l.585–601). So a repetition loop on noise reaches the client unchanged (my inference).
- The card and the repo files that I read have no saved example output for silence.

## 7. Languages

The card lists 30 languages with codes ([card] l.39): zh, en, yue, ar, de, fr, es, pt, id, it, ko, ru, th, vi, ja, tr, hi, ms, nl, sv, da, fi, pl, cs, fil, fa, el, hu, mk, ro. It also lists 22 Chinese dialects. Qwen's package names the same 30 languages ([qwen:utils] l.37–68).

- 28 of the codes are ISO-639-1 codes. For each of them, vLLM's map gives the same English name that Qwen uses: zh, en, ar, de, fr, es, pt, id, it, ko, ru, th, vi, ja, tr, hi, ms, nl, sv, da, fi, pl, cs, fa, el, hu, mk, ro ([vllm:langs] l.6–64, [qwen:utils] l.37–68).
- `yue` (Cantonese) and `fil` (Filipino) have three letters, so they are not ISO-639-1 codes. vLLM's map has neither of them.
- vLLM maps `tl` to `Tagalog`. Qwen calls the language `Filipino`. Whether the model obeys `language Tagalog<asr_text>` is UNVERIFIED (U4).
- vLLM's map also has 29 codes that Qwen does not list, for example `uk` (Ukrainian) ([vllm:langs]). With these codes, vLLM forces a language that the card does not claim.

So the extension can send the Meeting Language as `to_language` with no mapping table, for the 28 codes. For any other code, it should not send `to_language`, and the model detects the language (my recommendation).

## 8. The request for "transcribe this WAV, language de"

```http
POST /endpoints/<endpoint-name>/invocations HTTP/1.1
Host: runtime.sagemaker.<region>.amazonaws.com
Content-Type: multipart/form-data; boundary=qwen3asrboundary
X-Amzn-SageMaker-Custom-Attributes: route=/v1/audio/transcriptions
Authorization: AWS4-HMAC-SHA256 ... (SigV4, service "sagemaker")

--qwen3asrboundary
Content-Disposition: form-data; name="file"; filename="window.wav"
Content-Type: audio/wav

<WAV bytes>
--qwen3asrboundary
Content-Disposition: form-data; name="to_language"

de
--qwen3asrboundary
Content-Disposition: form-data; name="language"

de
--qwen3asrboundary
Content-Disposition: form-data; name="response_format"

json
--qwen3asrboundary--
```

- `to_language=de` makes vLLM write `language German<asr_text>` into the prompt ([vllm:qwen3] l.566–576).
- `language=de` passes validation and selects the `" "` separator ([vllm:stt] l.72–80).
- `model` is optional ([vllm:proto] l.69). If you send it, send the served name. With `--model /opt/ml/model`, that is `/opt/ml/model` (my inference from [img:entry] l.12–15). JumpStart's Voxtral payload sends this value (sibling note, [spec:voxtral] there).
- `response_format=json` is the default ([vllm:proto] l.95). Do not send `verbose_json` (§4).
- Expected response: `{"text": "<German text>", "usage": {"type": "duration", "seconds": <n>}}` ([vllm:stt] l.550–556).
- Keep each window at 30 s or less if you do not want vLLM to split it (§4).
- Build the multipart bytes yourself, with a fixed boundary, before you sign them. SigV4 signs a hash of the body. With a `FormData` body, the browser sets the boundary after your signing step (my inference, U8).
- Use the chat route only if you want one pass over a long window and accept language auto-detect. Then send JumpStart's JSON body with no `route=`. Set `max_tokens` high enough, and strip the prefix as Qwen's parser does (§5, §6).

## 9. UNVERIFIED items

- **U1.** I read the public registry, not the private one that JumpStart uses. That `763104351884.dkr.ecr.<region>.amazonaws.com/vllm:server-sagemaker-cuda-v1` has the digest `5f2076d835997811…` is UNVERIFIED. The tag moves. I did not confirm when SageMaker resolves a tag to a digest. If you create the model yourself, you can pin `server-sagemaker-cuda-v1.4`.
- **U2.** I made no live call. The `route=` header, the multipart body, the audio packages from the hook and the response on a real endpoint are all untested.
- **U3.** I did not read `model-hosting-container-standards` or `standard-supervisor`. They can add middleware or change requests.
- **U4.** I did not read transformers' Whisper `LANGUAGES` list in the image. So I do not know if `yue` or `fil` pass vLLM's validation. I also did not confirm that the model obeys `language Tagalog` or `language yue`.
- **U5.** I did not confirm what the model returns for silence when the prompt forces a language.
- **U6.** I did not measure the accuracy effect of vLLM's prompt (no system turn), of a forced language, or of the 30-s split, against Qwen's own one-pass path.
- **U7.** On the chat route, I did not test `continue_final_message`, a system message that names the language, or a request template with `--trust-request-chat-template`.
- **U8.** I did not test a SigV4-signed multipart body from a browser `fetch`.
- **U9.** I did not confirm the speed: whether a window of 30 s, or about 3 min in 30-s chunks, finishes within 60 s on ml.g6.xlarge.
- **U10.** I saw no saved chat-route output. That the content starts with `language <Name><asr_text>` comes from the code, the tokenizer config and Qwen's example (§5).

## 10. References

JumpStart cache paths are relative to `https://jumpstart-cache-prod-us-west-2.s3.us-west-2.amazonaws.com/`. DLC links are at commit `bdc480f6544aea22ec224b3854b875c12650418b`. vLLM links are at commit `3f5bd482f5c1a5dbdffbbf68d624e20bb7032013`.

- [spec] `community_models/huggingface-asr-qwen3-asr-1-7b/specs_v1.0.2.json` (Last-Modified 2026-06-29 15:18:38 GMT, ETag `2ff269f4e80c7e09af9d956bd43b6c39`).
- [js:model.py] `huggingface-asr/huggingface-asr-qwen3-asr-1-7b/artifacts/inference-prepack/v1.0.0/code/model.py` (887 bytes; the artifact root also has an 887-byte `model.py`).
- [js:tmpl] `huggingface-asr/huggingface-asr-qwen3-asr-1-7b/artifacts/inference-prepack/v1.0.0/chat_template.json`.
- [spec:voxtral] see the sibling note [sagemaker-jumpstart-stt.md](sagemaker-jumpstart-stt.md), §8.
- [ecr] `https://public.ecr.aws/v2/deep-learning-containers/vllm/manifests/<tag>` and `.../blobs/<digest>`, read 2026-10-06 with an anonymous pull token from `https://public.ecr.aws/token/`. Config of `-v1`: `sha256:5690a31475607fa9d56ce0fc0ee07f3ee09aaf97defc843595f6a70d9e469382`. Config of `-v2.0`: `sha256:f5f343fa24c707b73c89cd883029a1b39757191fb354eebb2ce536d442eeab4d`.
- [img:manifest] `/vllm-workspace/SOURCE_MANIFEST` in `-v1` (layer `sha256:33652dde9f80cfe1…`).
- [img:manifest-v2.0] `/vllm-workspace/SOURCE_MANIFEST` in `-v2.0` (layer `sha256:4bcf3f27c02f0e29…`).
- [img:entry] `/usr/local/bin/sagemaker_entrypoint.sh` in `-v1` (layer `sha256:5a0764b7cd6c0b65…`). The `-v2.0` copy is identical.
- [img:serve] `/usr/local/bin/sagemaker_serve.py` in `-v1` (layer `sha256:0d13374d3e2853c3…`).
- [img:serve-v2.0] `/usr/local/bin/sagemaker_serve.py` in `-v2.0` (layer `sha256:5e25f7dca051b05c…`). It is identical to [img:serve].
- [dlc:changelog] https://github.com/aws/deep-learning-containers/blob/bdc480f6544aea22ec224b3854b875c12650418b/docs/vllm/changelog/index.md
- [dlc:data-v1] https://github.com/aws/deep-learning-containers/blob/bdc480f6544aea22ec224b3854b875c12650418b/docs/src/data/vllm-server/0.19.1+amzn2023.6ef1efd5-gpu-sagemaker.yml
- [dlc:config] https://github.com/aws/deep-learning-containers/blob/bdc480f6544aea22ec224b3854b875c12650418b/.github/config/image/vllm/sagemaker-amzn2023.yml
- [dlc:docker] https://github.com/aws/deep-learning-containers/blob/bdc480f6544aea22ec224b3854b875c12650418b/docker/vllm/Dockerfile.amzn2023
- [dlc:serve] https://github.com/aws/deep-learning-containers/blob/bdc480f6544aea22ec224b3854b875c12650418b/scripts/docker/vllm/sagemaker_serve.py
- [dlc:template] https://github.com/aws/deep-learning-containers/blob/bdc480f6544aea22ec224b3854b875c12650418b/docs/src/templates/reference/available_images.template.md
- [vllm:qwen3] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/model_executor/models/qwen3_asr.py
- [vllm:iface] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/model_executor/models/interfaces.py
- [vllm:langs] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/model_executor/models/whisper_utils.py
- [vllm:stt] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/entrypoints/openai/speech_to_text/speech_to_text.py
- [vllm:proto] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/entrypoints/openai/speech_to_text/protocol.py
- [vllm:cfg] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/config/speech_to_text.py
- [vllm:envs] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/envs.py
- [vllm:sm] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/entrypoints/sagemaker/api_router.py
- [vllm:factories] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/entrypoints/openai/generate/factories.py
- [vllm:api] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/entrypoints/openai/api_server.py
- [vllm:chat-proto] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/entrypoints/openai/chat_completion/protocol.py
- [vllm:engine] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/entrypoints/openai/engine/serving.py
- [vllm:chat-utils] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/entrypoints/chat_utils.py
- [vllm:hf] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/renderers/hf.py
- [vllm:proc] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/transformers_utils/processors/qwen3_asr.py
- [vllm:audio] https://github.com/vllm-project/vllm/blob/3f5bd482f5c1a5dbdffbbf68d624e20bb7032013/vllm/multimodal/media/audio.py
- [card] https://huggingface.co/Qwen/Qwen3-ASR-1.7B/blob/7278e1e70fe206f11671096ffdd38061171dd6e5/README.md (Qwen; revision last modified 2026-01-30).
- [hf:tmpl] https://huggingface.co/Qwen/Qwen3-ASR-1.7B/blob/7278e1e70fe206f11671096ffdd38061171dd6e5/chat_template.json
- [hf:tok] https://huggingface.co/Qwen/Qwen3-ASR-1.7B/blob/7278e1e70fe206f11671096ffdd38061171dd6e5/tokenizer_config.json (`added_tokens_decoder["151704"]`).
- [hf:pre] https://huggingface.co/Qwen/Qwen3-ASR-1.7B/blob/7278e1e70fe206f11671096ffdd38061171dd6e5/preprocessor_config.json
- [hf:gen] https://huggingface.co/Qwen/Qwen3-ASR-1.7B/blob/7278e1e70fe206f11671096ffdd38061171dd6e5/generation_config.json
- [qwen:utils] https://github.com/QwenLM/Qwen3-ASR/blob/7c6daf77a2421100f5fb066495372c00129d39ff/qwen_asr/inference/utils.py
- [qwen:infer] https://github.com/QwenLM/Qwen3-ASR/blob/7c6daf77a2421100f5fb066495372c00129d39ff/qwen_asr/inference/qwen3_asr.py
