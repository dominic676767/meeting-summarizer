# Amazon SageMaker: the user's own endpoint, on temporary AWS credentials

**Status: accepted.** This narrows a rule. `bedrock.ts`, the README and the Bedrock settings note said that AWS SigV4 credentials are not supported. The rule is now that **long-lived AWS keys are not supported**. Bedrock keeps its API key.

The user wants their meetings transcribed by a speech-to-text model that they host on Amazon SageMaker AI, in their own AWS account. So SageMaker becomes the fourth Transcription Provider. It is opt-in, like the other cloud engines. The extension only calls an endpoint that already exists. It never creates, scales or deletes AWS resources, and it assumes that the endpoint is up.

## The model: Qwen3-ASR from JumpStart

The research is in [sagemaker-jumpstart-stt.md](../research/sagemaker-jumpstart-stt.md) and [qwen3-asr-on-sagemaker-vllm.md](../research/qwen3-asr-on-sagemaker-vllm.md). No JumpStart deployment meets every need as JumpStart ships it. Qwen3-ASR 1.7B (`huggingface-asr-qwen3-asr-1-7b`) was chosen for accuracy. It has the best average English word error rate of the JumpStart models (4.31 on the Open ASR Leaderboard), 8.31 on AMI meeting speech, and 30 languages. It returns text only.

- **One fixed request format.** A SageMaker endpoint has no standard contract: each container sets its own. The engine speaks the format of the JumpStart Qwen3-ASR image, and is built so that a second preset is a small addition. A configurable mapping was rejected: nobody can test it against real containers, and the user would have to find a wrong JSON path.
- **vLLM's transcription route, not the chat route.** The JumpStart image has a middleware that sends `/invocations` to the path in `X-Amzn-SageMaker-Custom-Attributes: route=…`. On `/v1/audio/transcriptions`, vLLM forces Qwen3-ASR's language from the `to_language` field. JumpStart's own sample payload uses the chat route instead, where Qwen's chat template drops the text that would force the language. There the model guesses the language in each window. So the body is multipart: the WAV, `to_language` and `language` (both set to the Meeting Language) and `response_format=json`.
- **Windows cut at pauses.** A text-only reply makes each window one Utterance, and fusion can give an Utterance only one speaker. So the engine sets `windowing`. The wrapper then cuts its windows at the quietest 200 ms near 10 s, and never later than 30 s (`pauses.ts`). 30 s is Qwen3-ASR's clip length: vLLM splits longer audio and moves each chunk's times by a fixed 30 s, which can drift from where it really cut. Only engines that ask for these windows get them. Scribe and OpenAI keep theirs.
- **Silent windows are not sent.** On the live endpoint, silence came back as invented text: "Okay." for 1 s, "I'm not sure what you're talking about." for 10 s. The wrapper's Silent Recording check judges whole recordings, so it cannot catch one silent stretch inside a real meeting. So a window cut at pauses whose loudest 200 ms is below the recorder's own silence level (`SILENT_BELOW_RMS`, about −60 dBFS) is skipped. A window that holds only noise above that level can still get invented words.
- **The reply is capped.** Each call sends `max_completion_tokens` = 16 per second of audio + 32. On the live endpoint, 10 s of silence with no language set got no reply within 70 s; with a cap it came back in 4 s. Speech uses about 4–6 tokens per second, so the cap does not cut real words.
- **Four windows are in flight at once.** Each call costs about 1.7 s however short its audio, and four 10-s windows at once took as long as one. The wrapper keeps the Meeting order, and a failure or a cancel stops the other calls. An hour of audio then takes a few minutes instead of 10 to 15.
- **Three Meeting Languages are not Qwen3-ASR's.** Hebrew, Norwegian and Ukrainian are not on its list. For these three, no language is sent and the model guesses. This is an exception to the rule that the Meeting Language is declared, never detected. The user chose it over refusing the upload, and the Settings panel says so. The panel also says that with this engine a wrong Meeting Language gives a translation: English audio sent with `to_language=de` came back in German.

## Temporary credentials only

`InvokeEndpoint` accepts only requests signed with SigV4. AWS's bearer tokens for SageMaker reach only the OpenAI-compatible chat path, not `/invocations`. So the extension must sign with AWS credentials, which the old rule refused. The reason for that rule was a long-lived secret in browser storage, which works until somebody revokes it. That reason is kept, and the rule now names it.

- **The user pastes temporary credentials**: an access key, a secret and a session token. `parseAwsCredentials` refuses long-term `AKIA…` keys and incomplete sets. One paste box reads the forms that tools print: shell lines, a credentials-file profile, and the JSON from `aws configure export-credentials` or STS.
- **They live in `chrome.storage.session`**: in memory only, never on disk, and cleared when the browser closes. ADR-0001's "keys live in `storage.local`" does not apply to them.
- **The offscreen document cannot reach storage.** So the service worker reads the credentials when a transcription starts and sends them in `offscreen-transcribe`, and only when SageMaker is the selected engine.
- **Expiry costs a retry, not a meeting.** When the credentials expire before a meeting ends, its audio becomes a Held Recording, and fresh credentials plus Retry recover it. The factory refuses credentials that are past a stated expiry before any upload. While a meeting records, the popup warns when the credentials are expired or missing. After a browser restart, missing is the usual state.
- **The README gives an invoke-only IAM policy**: `sagemaker:InvokeEndpoint` on the one endpoint's ARN.

Considered and rejected:

- **Long-term IAM user keys.** The easiest to set up, and exactly what the rule exists to prevent.
- **A Cognito identity pool.** No secret is stored, but anyone with the pool ID could call the endpoint, and the user must create the pool and an unauthenticated role.
- **API Gateway or Lambda in front of the endpoint, with an API key.** This keeps the old rule, but it adds AWS infrastructure, and the extension would no longer call SageMaker.

## Signing: the SDK's signer, not its client

The AWS SDK's own SigV4 signer, `@smithy/signature-v4`, signs each call, and plain `fetch` sends it.

The SDK client (`SageMakerRuntimeClient` with `InvokeEndpointCommand`) was built first and measured. It made the offscreen bundle 431 KB unminified, against 31 KB before. Most of that was `@smithy/core` (236 KB) and `@aws-sdk/core` (76 KB), for the one request this engine makes. The Settings page's Test button would have carried it a second time. With the signer alone, the offscreen bundle is 80 KB and the Settings page 68 KB, including the engine and its splitter.

- **The hash is the browser's.** The signer gets a SHA-256 built on Web Crypto, so no hashing code is bundled. A test signs AWS's published `get-vanilla` example and gets the published signature.
- **The request is AWS's usual one.** No `x-amz-content-sha256` header, which AWS's own clients send to S3 only. Host is signed but left out of the fetch headers, because the browser sets it from the URL.
- **Reading a failed reply is now the engine's job.** The error type comes from the `x-amzn-ErrorType` header or the body's `__type`. Every failure becomes a `SageMakerFailure` with a kind (credentials, endpoint, container, format or other), and the Test button reports that kind.
- **No automatic retry.** A failed window holds the Recording, as it does with every other engine.
- **Each call gives up after 90 s.** SageMaker itself stops a call after 60 s.

A signer of the project's own, on Web Crypto, was considered. The user chose signing code that AWS maintains instead. The full client was tried, then replaced because of its size.

## Consent and naming

SageMaker is a destination of its own. Switching to it withdraws microphone consent, as ADR-0008 decided for any change of destination. Consent stays tied to the engine id, not to the endpoint. The company and its terms do not change when the endpoint changes, and the extension cannot see the account without an extra STS call.

The disclosure says "Amazon SageMaker, in the AWS account your credentials belong to" (`uploadDestination`). With engine naming on, the Summary Artifact says "Amazon SageMaker `<endpoint>`". The panel promises nothing about retention: what the account keeps depends on how it is set up, for example data capture to S3.

## Consequences

- One new runtime dependency: `@smithy/signature-v4`, and the parts of `@smithy/core` that it uses.
- No manifest change: `https://*.amazonaws.com/*` already covers the runtime host in every region.
- The evaluation harness runs the engine on request (`--engines sagemaker`), with the AWS CLI's environment variables.
- **Checked against a live endpoint** ([qwen3-asr-live-check.md](../research/qwen3-asr-live-check.md)). The route, the multipart body and `to_language` work. The endpoint has no inference component, so the panel has no field for one. The Test button reports that the endpoint answered, without quoting the words that it invents for the test's silence. Not checked live: the extension's own signer, and the error replies for expired or refused credentials.

## Considered options for the model

- **Whisper large-v3 on the SageMaker vLLM container.** Segment timestamps and a language hint, and the research's first choice. Not chosen: Qwen3-ASR is more accurate on meeting speech, 8.31 on AMI against 13.63.
- **Parakeet TDT 0.6B v2 (AWS Marketplace).** Word timestamps and speaker labels, but English only, with NVIDIA's fee of $1 per hour on top of the instance.
- **Granite Speech 4.1 2B.** The best AMI score (7.06), but six languages, and its language field has no effect.
- **The AWS WhisperX container.** Segments, words and speakers, but not in JumpStart.
- **VoxCPM2.** A text-to-speech model: it cannot transcribe.
- **Bidirectional streaming.** Chrome's `fetch` cannot make that call.
- **Async inference, serverless and scale to zero.** Out of scope. Qwen3-ASR needs a GPU, and serverless endpoints have none.
