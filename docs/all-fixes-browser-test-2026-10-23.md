# All six fixes: browser test, 23 October 2026

The tested recording, transcription, recovery, and summary paths worked. Two metadata defects remain: the popup can show the wrong transcript source after audio retry, and a new Zoom meeting can retain an earlier silent session's start time. This run does not give a clean release sign-off.

## Build and test environment

- Requested branch: `test/all-fixes-2026-10-23`.
- Exact commit: `71916fa4441894717d235a579905ba4c57f398b0`.
- Source worktree: `.claude/worktrees/all-fixes`.
- Chrome loads the main checkout's `dist/`. The requested worktree was built, and its 18 built files were copied to that folder. SHA-256 checks confirmed that every file matched. The extension was reloaded while no recorder was active.
- Existing Google Chrome: `156.0.8078.47`; extension `0.1.1`.
- Real two-participant Zoom web calls in the existing browser. Participant A sent controlled speech through Zoom. The host recorded the remote audio.
- Transcription: local Ollama, `hf.co/ggml-org/Qwen3-ASR-1.7B-GGUF:Q8_0`, normally at `http://localhost:11434`.
- Summary Provider: AWS Bedrock, `global.anthropic.claude-sonnet-4-6`, in `us-east-1`, with the user's saved credentials.
- Host microphone capture stayed off. No microphone consent setting was changed.
- Work ran before and after the user's pause. The recorder and local test proxy were stopped for the pause. A different Zoom call was open when the user resumed.
- Product source was not changed during the browser tests. No PR or GitHub issue was created.

Evidence is in [`.eval/all-fixes-e2e-2026-10-23/`](../.eval/all-fixes-e2e-2026-10-23/). Times below use Kuala Lumpur time, UTC+8. JSON evidence uses UTC.

The evidence is local and excluded from Git. Its canonical location is `/Users/domhong/Projects/meeting-summarizer/.eval/all-fixes-e2e-2026-10-23/`. The test worktree links to that folder so the relative artifact links below work locally. This documentation commit includes the report only.

## Results

| Check | Result | Evidence and limit |
|---|---|---|
| Build and type check | PASS | `npm run build`; `npm run typecheck` in the requested worktree. |
| Automated tests | PASS | 51 test files passed; 945 tests passed. One optional test file and test were skipped. See `unit-tests.log`. |
| Real Zoom audio → Qwen3-ASR → Bedrock → HTML | PASS | The first summary contains both passages, the Green Bridge decision, the $300 budget, Alice's Friday task, and Bob's Monday task. |
| Quiet interval | PASS for the controlled source | About 44 seconds separated the two speech clips. The transcript contains exactly the two expected segments. This check did not retain raw audio for a sample-level silence measurement. |
| One summary for concurrent Meeting End requests | PASS | The user approved two simultaneous requests on one real recording. Both reached the extension. Exactly one new download, ID 66, completed. Its audio and held-item lists were cleared. See `double-end-replies.json` and `double-end-result.json`. |
| Capture Start after a completed session, before a new caption | PASS | The real extension shortcut created a new session and span while the caption count was zero. After speech and a new caption, the same span still belonged to the session, the recorder remained active, and the card said recording. See `restart-before-caption.json` and `restart-after-caption.json`. |
| Capture Start during transcription | PASS | The real shortcut was refused with “The last recording is still being processed.” No new recorder started. See `start-refused-during-processing.json`. |
| Durable audio after recorder loss | PASS for committed chunks | Before loss, six chunks were exported and hashed. After the offscreen document was closed without a recorder stop, those chunks had the same hash. Ten stored chunks decoded to 50.34 seconds. See `durability-proof.json`. |
| Recovery of that recording | PASS for data and artifact; UI defect below | The normal flow made a caption fallback with a capture warning and kept a Held Recording. **Retry transcription** recovered the expected speech, named the engine, retained the incomplete-capture warning, and cleared the held items and audio. |
| Refuse truncated summaries | PASS for the browser Ollama path | A local test endpoint returned a valid chat response with `done_reason: "length"`. Retry displayed “summary was cut off at the output token limit,” kept the transcript, and made no new download. Restoring Bedrock and retrying made a complete artifact. Other Provider refusal branches were covered by the automated suite. |
| Transcription survives worker restart | PASS | A local proxy delayed the real Ollama audio request by 45 seconds. With recording stopped and transcription active, Chrome's worker **Stop** control was used. The worker thread changed from 2 to 3; the offscreen task remained. Its real result produced one new artifact, ID 68, and cleared the audio. This was a forced restart, not a five-minute browser timeout test. |
| Request-host validation | PASS for Settings import checks | Remote summary and transcription URLs, a `localhost.attacker.invalid` lookalike, and a malformed Bedrock region were refused. The import did not save settings. Factory refusals were also covered by the automated suite. See `host-validation.json`. |
| Zoom **End Meeting for All**, with audio verified first | PASS for automatic completion; timing defect below | Before End, the host and recorder both reported recording, signal was present, and captions contained the test words. Zoom End produced exactly one new audio artifact, ID 72, without a manual summary request. Final state was `done`, outside the meeting, with no recorder, chunks, or held items. |
| Downloaded artifact checks | PASS within the stated checks | Eight artifacts were rendered and checked for expected words, source labels, applicable warnings, transcript segment counts, no scripts, and no horizontal overflow at 1100 px and 390 px. Screenshots were saved; representative outputs were inspected visually. Meeting duration is a separate finding below. |
| Final normal-service check | PASS | `npm run doctor -- --ollama`: all checks passed, including the exact extension origin and refusal of other extension origins. |

## Finding 1: audio retry leaves a caption-only label in the popup

**Priority: P2. Confirmed.**

After recorder loss, the caption fallback set the live session's audio-source state to captions only. Retry then successfully transcribed the saved audio and wrote an audio-based artifact.

At 15:27:50 the popup said both:

> Summary saved to Downloads/meeting-summaries.
>
> Captions only — the summary was not built from recorded audio.

A fresh popup document showed the same text at 15:29:21. The actual artifact says:

> from recorded audio, speakers from captions · audio capture failed · local microphone not recorded · local Ollama hf.co/ggml-org/Qwen3-ASR-1.7B-GGUF:Q8_0

Its full transcript contains the expected recovered speech. The capture warning remains valid because the recorder was interrupted. The caption-only statement is wrong.

The source supports this diagnosis. [`retryHeldRecording`](https://github.com/dominic676767/meeting-summarizer/blob/71916fa4441894717d235a579905ba4c57f398b0/src/background/background.ts#L694) builds a recovered transcript without updating the live session's `audioWords` or `noSpeech`. [`retryHeld`](https://github.com/dominic676767/meeting-summarizer/blob/71916fa4441894717d235a579905ba4c57f398b0/src/background/background.ts#L665) updates only matching sessions in the `failed` state. Here, the successful caption fallback had already made the session `done`. `statusFor()` therefore continues to return `degraded: true`.

Suggested correction: after successful recovery, update the matching session's transcript-source fields while preserving any valid capture-failure warning. Retest with a fresh popup.

Evidence:

- `durability-recovery-result.json`
- `durable-audio-retry-result.json`
- `durable-audio-retry-popup.json`
- `fresh-popup-after-audio-retry.json`
- [`durable-audio-recovered.html`](../.eval/all-fixes-e2e-2026-10-23/durable-audio-recovered.html)

Popup checks used the production `popup.html` in tabs bound to the host meeting. A native toolbar-popup inspection attempt was refused because its window was inactive. Native popup lifetime was not verified.

## Finding 2: a new Zoom meeting retains the earlier silent session's timing

**Priority: P2. Carryover confirmed; the meeting transition during the pause was not instrumented.**

Before the pause, the host was in one Zoom meeting. Its extension session started at 15:30:50 and held a silent recording span started at 15:33:08. The test stopped that recording when the user paused.

At resume, the host and guest URLs identified a different Zoom meeting. The extension still held the earlier session's `startedAt`, `recordingId`, silent span, and `noSpeech: true`. No test helper wrote session storage.

The final Capture Start at 16:03:53 added a second span to that old session. After real speech and native Zoom End, the final artifact showed:

- Meeting duration: **34:06**.
- The spoken test passage at **33:14**.

Those times use the previous meeting's start. The new meeting's exact start time was not observed, so this report does not assert its correct total duration.

The likely path is visible in the source. [`summarizeSession`](https://github.com/dominic676767/meeting-summarizer/blob/71916fa4441894717d235a579905ba4c57f398b0/src/background/background.ts#L506) leaves an empty or silent session in `capturing`. [`ensureSession`](https://github.com/dominic676767/meeting-summarizer/blob/71916fa4441894717d235a579905ba4c57f398b0/src/background/sessions.ts#L270) replaces only absent, `done`, or `failed` sessions. A new meeting in the same tab can therefore inherit the silent session and its old clock.

Suggested correction: distinguish a new platform meeting from continuation after **Summarize now**, including a previous meeting with no usable words. Run a fully observed silent-meeting → native End → new meeting → speech sequence to verify the correction.

Evidence:

- `paused-state.json`
- `resumed-state.json`
- `resumed-capture-start.json`
- `resumed-before-native-end.json`
- `resumed-native-end-action.json`
- [`native-zoom-end-summary.html`](../.eval/all-fixes-e2e-2026-10-23/native-zoom-end-summary.html)

## Artifact copies

| Artifact | Verified purpose |
|---|---|
| [`first-summary.html`](../.eval/all-fixes-e2e-2026-10-23/first-summary.html) | Two real Zoom audio passages and expected summary content |
| [`concurrent-end-summary.html`](../.eval/all-fixes-e2e-2026-10-23/concurrent-end-summary.html) | One file from two concurrent end requests |
| [`summary-retry.html`](../.eval/all-fixes-e2e-2026-10-23/summary-retry.html) | Held Transcript recovery through Bedrock |
| [`worker-restart-summary.html`](../.eval/all-fixes-e2e-2026-10-23/worker-restart-summary.html) | Completion after service-worker restart |
| [`recorder-loss-caption-fallback.html`](../.eval/all-fixes-e2e-2026-10-23/recorder-loss-caption-fallback.html) | Caption fallback with a capture-failure warning |
| [`durable-audio-recovered.html`](../.eval/all-fixes-e2e-2026-10-23/durable-audio-recovered.html) | Audio recovery from committed chunks |
| [`native-caption-end-summary.html`](../.eval/all-fixes-e2e-2026-10-23/native-caption-end-summary.html) | Earlier native End attempt where recording had not started |
| [`native-zoom-end-summary.html`](../.eval/all-fixes-e2e-2026-10-23/native-zoom-end-summary.html) | Final native End with audio verified first; old timing retained |

`artifact-verification.json` records source paths, hashes, text, and check results. Matching PNG files show the expanded transcripts.

## Test setup corrections and limits

- The initial speech-generation attempt made empty audio under the sandbox. The files were regenerated with working macOS speech access before the first successful speech test.
- The first truncation fixture handled the wrong Ollama route and returned a model-not-found error. The fixture was corrected, and the later retry verified the actual output-limit refusal. Both outcomes are retained in the logs.
- The first artifact validator incorrectly required an audio microphone label on caption-only summaries. That assertion was corrected; the full eight-artifact check then passed.
- Background popup tabs can delay their timer updates. Recovery checks included a visible page and a fresh popup document.
- The first final-end attempt produced a caption-only artifact because recording had not started. The later resumed test checked active recording, signal, and captions before native End.
- The first artifact's long duration was not independently validated. Finding 2 uses the observed change between distinct Zoom meeting URLs and the retained session data.
- No physical microphone, echo, headphone audibility, browser-process crash, disk-full condition, long-duration memory test, or five-minute automatic worker timeout was tested.
- The storage check proves survival of committed chunks. It does not prove survival of a chunk that had not yet committed.
- No live Teams speaker-name check or live Whisper, OpenAI, ElevenLabs, or SageMaker transcription test was run. Zoom speaker names remain `Unknown`.

## Final state

- The test calls were ended. Final extension state: `done`, `inMeeting: false`, `recording: false`.
- No offscreen document, stored audio chunks, Held Recordings, or Held Transcripts remained.
- Participant A's audio functions were restored; its test AudioContext was closed and all test tracks ended.
- Settings match the starting baseline, including Bedrock, the normal Ollama endpoint, engine naming off, and microphone capture off.
- The temporary proxy was stopped. The user's normal Ollama service was preserved.
- Nine temporary extension helpers were removed from `dist/`. The 18 production build files still match the requested commit's build.
- Four temporary inspection tabs were closed. The original browser tabs were preserved.
- The raw synthetic audio backup and test evidence remain under `.eval/`. Earlier test notes and product source were left unchanged.
