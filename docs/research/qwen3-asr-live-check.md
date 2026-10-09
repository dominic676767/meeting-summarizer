# Qwen3-ASR on a live SageMaker endpoint: research for the SageMaker transcription engine

Checked 2026-10-06 for the SageMaker engine (#50, ADR-0009), against the endpoint that the user deployed from JumpStart. This note records what only a live endpoint can show. It follows [qwen3-asr-on-sagemaker-vllm.md](qwen3-asr-on-sagemaker-vllm.md), which read the image's source, and does not repeat it.

**Sources.** Only the live endpoint and the AWS APIs that describe it:

- `DescribeEndpoint`, `DescribeEndpointConfig`, `DescribeModel` and `ListInferenceComponents` in `ap-northeast-2`.
- About 40 `InvokeEndpoint` calls through the AWS CLI. Each call sent the multipart body exactly as `invokeInput` builds it: the same boundary, the same fields, and the header `X-Amzn-SageMaker-Custom-Attributes: route=/v1/audio/transcriptions`.
- The credentials were temporary and limited by a session policy to these actions. No resource was created, changed or deleted.

**The audio.** macOS `say` writes empty files in this environment, both inside and outside the sandbox. So every speech clip is the committed fixture `tests/fixtures/known-phrase.wav` ("We should ship the beta next Friday.", 1.93 s, made with `say`), repeated with pauses: 9.5 s (4 phrases), 29.9 s (13 phrases) and 60.1 s (24 phrases). The silent clips are digital zeros. No meeting audio was sent. Because all the speech is one English voice, this note checks the contract, not accuracy.

---

## Summary: findings that change the design

1. **The endpoint has no inference component.** `ListInferenceComponents` returns none, and the one variant serves the model directly. So the Settings panel needs no inference component field.
2. **The route, the multipart body and `to_language` work as the source said.** The reply is `{"text": …, "usage": {"type": "duration", "seconds": …}}`, with no `language …<asr_text>` prefix.
3. **A forced language translates.** The English phrase with `to_language=de` came back in German: "Wir sollten die Beta nächsten Freitag versenden." So with this engine, a wrong Meeting Language gives a translation, not the wrong words that the general Settings note describes.
4. **Silence becomes invented text.** With the language forced, 1 s of silence came back as "Okay." and 10 s as "I'm not sure what you're talking about." 220 s of silence came back as 200 words of fluent nonsense. A silent stretch inside a real meeting would add lines that nobody said. The wrapper's Silent Recording check judges whole recordings only, so it cannot catch this.
5. **Silence with no language can run away.** 10 s of silence with no `to_language`, which is the path for Hebrew, Norwegian and Ukrainian, got no reply within 70 s, three times over (184 s in all). With `max_completion_tokens=128` the same call returned in 4 s, as "No, no, no, …". Without a cap, one such window outlasts the engine's 90 s timeout, and the whole Recording is held.
6. **One call has a fixed cost of about 1.7 s.** A 1.9-s clip took 1.7–2.0 s. A 10-s window took 2.5 s, and a 30-s window 4.9 s. With one call at a time, an hour of audio in 10-s windows (360 calls) would take 10 to 15 minutes.
7. **Parallel calls are almost free.** Four 10-s windows at once took 2.75 s, the same as one. Eight took 3.6 s. The 60-s clip, cut by `pauseWindows` and sent four at a time, took 6.3 s.
8. **Windows cut at pauses lose no words.** The 60-s clip was cut at 10.0, 20.0, 30.0, 40.0 and 50.1 s, each inside a pause, and the six windows returned all 24 phrases. One 30-s window holding 13 copies of the phrase returned 12. This happened with and without a token cap, so it is the model dropping a repeat, not truncation.
9. **The request-size limit is above 6 MB.** A 7 MB body was accepted. The engine's windows are under 1 MB, so the conflict between the API reference (6 MB) and the Developer Guide (25 MB) does not matter here.

## The endpoint

| Item | Value |
|---|---|
| Endpoint | `jumpstart-dft-hf-asr-qwen3-asr-1-7b-20261006-094333`, `InService` |
| Config | `qwen3-asr-1-7b-noiso-epc-094333`, one variant `AllTraffic` |
| Instance | `ml.g6.2xlarge`, 1 instance |
| Image | `763104351884.dkr.ecr.ap-northeast-2.amazonaws.com/vllm:server-sagemaker-cuda-v1` |
| Network isolation | off (the config's name says `noiso`) |
| Data capture | off |
| Inference components | none |
| Environment | `HF_MODEL_ID=/opt/ml/model`, `SM_VLLM_MAX_MODEL_LEN=32768`, `SAGEMAKER_MODEL_SERVER_TIMEOUT=3600` |

## The calls

Times are wall time for one AWS CLI call, including the CLI's own start-up of about one second. Every call had the route header, unless the row says otherwise.

| Call | Audio | `to_language` | Time | Reply |
|---|---|---|---|---|
| T1 | phrase, 1.9 s | `en` | 1.9 s | "We should ship the beta next Friday." |
| T2 | phrase | none | 2.0 s | the same |
| T3 | phrase | `de` | 1.7 s | "Wir sollten die Beta nächsten Freitag versenden." |
| T4 | 4 phrases, 9.5 s | `en` | 2.5 s | all 4 phrases |
| T5 | 13 phrases, 29.9 s | `en` | 4.9 s | 12 phrases |
| T6 | silence, 1 s | `en` | 1.7 s | "Okay." |
| T7 | silence, 10 s | `en` | 2.1 s | "I'm not sure what you're talking about." |
| T8 | silence, 10 s | none | no reply in 70 s, three times | — |
| T8b | silence, 10 s, `max_completion_tokens=128` | none | 4.0 s | "No, no, no, …" |
| T5b | 13 phrases, `max_completion_tokens=512` | `en` | 4.4 s | 12 phrases |
| T9 | phrase, **no route header** | `en` | 1.7 s | `ModelError` 400: "Unsupported Media Type: Only 'application/json' is allowed" |
| T10 | silence, 220 s, 7 MB | `en` | 6.3 s | 200 invented words |
| T11 | endpoint that does not exist | `en` | 1.9 s | `ValidationError`: "Endpoint meeting-summarizer-no-such-endpoint of account 197139663096 not found." |

Parallel calls, each a 9.5-s window with `max_completion_tokens=192`, all replies correct:

| At once | Wall time | Audio per second |
|---|---|---|
| 1 | 2.81 s | 3.4 s |
| 4 | 2.75 s | 13.8 s |
| 8 | 3.57 s | 21.3 s |

## What this does to the engine

- **T9** confirms why the route header is needed: without it, vLLM's own `/invocations` accepts JSON only. The engine reports this as a container failure. That is right, but the Test button would explain it better as a format failure.
- **T11** shows that the error type and message are the ones `sageMakerFailure` reads: the engine reports "endpoint … was not found in ap-northeast-2".
- **T3** contradicts the general Meeting Language note on the Settings page for this engine: Qwen3-ASR translates into the declared language.
- **T6 and T7** mean that the Test button's one second of silence gets an invented answer ("Okay.") from a healthy endpoint. Its report should say that the endpoint answered in the expected format without quoting the text.

## Not checked

- **The extension's own signer against this endpoint.** The CLI signed every call above. Running `signedInvoke` against the endpoint needs the credentials in a script's environment, and that was not allowed in this session. The signer is pinned to AWS's published `get-vanilla` example, and the manual check's Test button covers it in a browser.
- **The error replies for expired, refused or forbidden credentials.** The session's credentials were valid throughout, and its policy allowed `InvokeEndpoint` more broadly than was asked for, so no `AccessDeniedException` came back either.
- **Accuracy, and languages other than English and German output.** That belongs to the evaluation harness (`docs/evaluations/`), on consenting clips.
- **The upper limit of the request size.** Not needed: the engine's windows are under 1 MB.

## What was decided from it

- No inference component field in the Settings panel.
- A window cut at pauses whose loudest 200 ms is below `SILENT_BELOW_RMS` (about −60 dBFS) is skipped.
- Each call sends `max_completion_tokens` = 16 per second of audio + 32.
- Four windows are in flight at once.
- The Test button reports that the endpoint answered, without quoting the reply, and a refused upload counts as a format failure.
- The SageMaker panel says that a wrong Meeting Language comes back translated.

## References

- The endpoint: `arn:aws:sagemaker:ap-northeast-2:197139663096:endpoint/jumpstart-dft-hf-asr-qwen3-asr-1-7b-20261006-094333`.
- The fixture: `tests/fixtures/known-phrase.wav` and how it was made, `tests/fixtures/README.md`.
- The body builder used for every call: the same fields and boundary as `invokeInput` in `src/transcription/sagemaker.ts`.
- The windows: `pauseWindows` with `SAGEMAKER_WINDOWING`, from `src/transcription/pauses.ts`.
