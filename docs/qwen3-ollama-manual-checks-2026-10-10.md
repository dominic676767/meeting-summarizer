# Qwen3-ASR in Ollama: Chrome checks, 10 October 2026

The Test button passed all six requested setup cases. The later measured-silence test and both microphone-consent transitions passed. Skip completed in 1.001 seconds and saved a caption-only artifact without a new held item. Stopping Ollama held the recording, and Retry recovered the complete test passage. Three defects were found: the retry artifact omits the engine label, a skipped artifact says that no audio was recorded, and the popup microphone explanation is empty. Zoom speaker names remain `Unknown`, and word errors were observed.

## Test setup

- Used the user's already open Google Chrome, application version **155.0.8059.39** on macOS. The page user agent reported **154.0.0.0**; the raw evidence retains that value. The application version was read separately through Chrome's Apple Events interface.
- Tested the current **`ollama-asr-engine` working tree**, including its existing uncommitted Qwen3-ASR changes. The base commit was `91f51c5`. This was not a test of that commit alone.
- Ran `npm run build` successfully, then selected **Reload** on the installed Meeting Summarizer extension card. The extension ID was `hbobmcebmpakimlijcjiaklipegdelap`.
- Controlled the Settings page through its DOM and actual button handlers with Chrome's existing Apple Events access. The Test button used real browser network requests. No response was mocked.
- The existing Ollama server on port **11434** was running but refused the extension's origin. `launchctl getenv OLLAMA_ORIGINS` returned no value. A doctor run outside the shell sandbox confirmed the origin failure.
- Started a separate Ollama test server on **127.0.0.1:11435**, allowing only `chrome-extension://hbobmcebmpakimlijcjiaklipegdelap`. It used the existing Qwen3-ASR model. The user's desktop Ollama app and launch environment were left unchanged.
- Downloaded the local text model **`qwen3:0.6b`** for the no-audio-capability check. No meeting audio was sent to a cloud model.

The first sandboxed doctor run returned `EPERM` for localhost. This was a sandbox access failure, not evidence that Ollama was stopped. The later permitted run reached the service and identified the 403 origin failure.

## Test button results

These checks ran from approximately **13:54 to 13:56 MYT** on 10 October 2026. Every test button became available again after its result.

| Case | Browser result | Result |
| --- | --- | --- |
| Qwen3-ASR with the allowed extension origin | `Ollama answered, with a model that takes audio.` | Pass |
| Stop the temporary server on port 11435 | `Ollama: Ollama is not running at http://localhost:11435 — open the Ollama app, then retry.` | Pass |
| Existing port 11434 server with no allowed extension origin | `Allowed origins: Ollama refused this extension (403): OLLAMA_ORIGINS does not allow chrome-extension://hbobmcebmpakimlijcjiaklipegdelap.` The message included the correct `launchctl setenv` command and restart instruction. | Pass |
| Model `qwen3-asr-manual-check-missing:20261010`, which was not installed | `Model: model … is not in Ollama at http://localhost:11435 — run ollama pull …` | Pass |
| Local text model `qwen3:0.6b` | `Model: model qwen3:0.6b cannot take audio — choose a speech-to-text model such as hf.co/ggml-org/Qwen3-ASR-1.7B-GGUF:Q8_0.` | Pass |
| Base URL `http://192.0.2.1:11434` | `The base URL must be this computer, for example http://localhost:11434.` | Pass |

An extra check selected the already installed `glm-4.7:cloud`. Its model lookup returned HTTP 410 because that model had been retired. The UI displayed this error and did not proceed to transcription. This does not verify the separate remote-model metadata refusal.

The stopped-server test used a real stopped Ollama service on the test port. It did not exercise quitting and reopening the desktop app. The origin failure was already present on the desktop service; the test did not unset a working origin setting and restart that app.

## Popup explanation failure

After selecting and saving **Qwen3-ASR in Ollama**, the actual extension `popup.html` was opened in a Chrome tab. At **13:58 MYT**, its DOM had:

```json
{
  "status": "Not in a meeting.",
  "micWhy": "",
  "disclosureHidden": true,
  "heldRecordingCount": 0,
  "heldTranscriptCount": 0
}
```

The Settings page correctly displayed:

> Your microphone is recorded and mixed with the meeting audio, then transcribed on this computer.

The popup does not receive its corresponding explanation. In `src/popup/popup.ts`, `micWhy()` defines the local and cloud wording, and `micWhyEl` identifies `#mic-why`, but nothing calls the function or assigns text to the element. The built `dist/popup.js` also has no assignment. Thus the current implementation cannot display the required local-transcription sentence in that element.

This was a check of the real popup document while idle. The native toolbar popup during a meeting was not tested. No microphone permission or consent was granted by the agent. No source fix was made as part of this check.

## Checklist status

| Checklist item | Status and prerequisite |
| --- | --- |
| Two-person meeting transcribed from audio with correct caption names | Partial. The real Zoom run produced an audio transcript, but both names were `Unknown` and both markers were inaccurate. Teams is required for named captions. |
| Thirty-second silent stretch adds no lines | Pass in the later measured run. Retained audio has a 232.82-second quiet section between speech bursts, and the final transcript contains only the two spoken passages. |
| Skip transcription produces a caption-only summary and no Held Recording | Pass for the later run at 19:19 MYT. Wait ended in 1.001 s; caption-only file saved; no new held item. The older failed recording remained. |
| Ollama stopped before Meeting End produces a Held Recording that can be retried | Pass at 19:24–19:26 MYT. Real ASR service stopped; recording held with the not-running reason; restart and Retry produced the complete audio passage. |
| Saved Summary Artifact names `local Ollama <model>` | Failed on the retry path. The normal run included the label; the retry artifact omitted it while the setting was still on. |
| Local Whisper → Ollama and SageMaker → Ollama retain microphone consent | Both transitions passed in actual Chrome storage after explicit user authorization. The combined checklist item remains open because the popup explanation is empty. |

## Follow-up: real Zoom audio run

The user prepared a two-participant Zoom mock call, chose **remote audio only**, and confirmed completion of both requested passages and a 30-second muted interval. The agent enabled English Zoom captions. The extension used Qwen3-ASR for transcription and the temporary local text model `qwen3:0.6b` for summary generation. Engine naming was enabled.

The popup reported recording with the microphone off. The agent selected **Summarize now** at **14:34:18 MYT**. The popup reported that the summary was saved at **14:34:30 MYT**, and both held-item lists were empty.

The saved file is `/Users/domhong/Downloads/meeting-summaries/2026-10-10-Dominic-Hong-s-Zoom-Meeting.html`. Its metadata reads:

> 2026-10-10 · Zoom · 23:27 · from recorded audio, speakers from captions · local microphone not recorded · local Ollama hf.co/ggml-org/Qwen3-ASR-1.7B-GGUF:Q8_0

The recording status showed about **4:55** at completion. The **23:27** artifact duration includes the earlier meeting session and is not the recording length.

| Passage | Expected | Saved transcript |
| --- | --- | --- |
| First marker and plan | “The first marker is copper lantern seven. We will ship the beta next Friday. Morgan will send the test report on Monday.” | `21:40 Unknown: The first copper and seven. We will share better next Friday. Morgan will send a test report on Monday.` |
| Final marker | “The final marker is violet bridge nine. The silent interval is complete. We agreed to review the results on Tuesday.” | `22:02 Unknown: The final marker is Violet Bridgman. The silent interval is complete. We agree to review the results on Tuesday.` |

The browser's Zoom captions rendered the last marker as **“Violet Rich 9”**, which differs from the ASR transcript. The saved file and real Ollama request log establish that the audio transcription path ran. They do not establish accurate transcription of the requested markers.

There were exactly two transcript lines and no extra utterance between them. However, their start times are only **22 seconds apart**, which does not verify the user's confirmed 30-second pause. No raw recording was retained for a separate timing check before the normal artifact-cleanup path. No cause for this mismatch is established.

The first attempt to prepare the skip test was interrupted when the Zoom call ended. No skip action or new skip-test artifact was observed. The agent opened a new mock call for the remaining tests.

At **15:42 MYT**, the generated HTML was also opened in Chrome. Its engine metadata was visibly rendered, and opening **Full transcript** displayed the same two lines shown above.

## Follow-up blocker

The replacement call remained at **one participant** and **Join Audio**. At **15:39** and again at **15:43 MYT**, Zoom displayed:

> Your microphone is not working. Please check your connection or use a different mic.
>
> Your browser is preventing access to your microphone.

The extension was not recording. Its popup reported:

> Audio capture failed. Saved audio is kept for recovery.

The status tooltip read:

> The audio stream stopped advancing. Microphone and meeting audio could not be verified.

Both held-item lists were empty in the inspected popup. These observations do not establish the cause of the audio failure or whether stored span data can be recovered. The agent did not grant microphone permission, change source code, or treat this failure as an Ollama transcription-retry test.

To complete the two outstanding recording checks, restore the Zoom computer-audio connection and rejoin the second test participant. Meeting Summarizer's own microphone can remain off, in accordance with the user's remote-only choice.

## Evidence and restoration

Raw test results, temporary helpers, build hashes and the popup observation are saved locally under `.eval/qwen3-ollama-manual-2026-10-10/`. That directory is ignored by Git. No API keys or AWS credentials were printed or saved in the evidence.

The temporary Ollama server was stopped, and the text model added for this test was removed. The model list then matched the initial list. The extension's original transcription selection, **Local Whisper**, was restored and verified after a Settings reload. The summary Provider remained **Claude**, engine naming remained off, and microphone recording remained off. The original Chrome tabs and the Settings tab were kept open.

The normal Ollama service still needs its origin setting corrected before this extension can use port 11434. The successful test on port 11435 does not establish that the user's normal service is ready.

During the follow-up, the temporary service and text model were started again, and Settings were changed for the live tests. A separate temporary summary service was also prepared on port 11436.

At **15:45 MYT**, final cleanup was complete. Both temporary services were stopped, the added text model was removed, and the model list again matched the initial list. The extension was reloaded to close its capture contexts. A fresh Settings page confirmed **Claude**, **Local Whisper**, English, engine naming off, and microphone recording off. The Ollama form values were restored to their original defaults. Existing capture or recovery data was not deleted by these cleanup actions. The replacement Zoom call and the saved HTML remained open for the user.

## Later continuation: successful skip test

The user prepared a new two-participant mock call and confirmed the participants were ready. Test services and Settings were restored for this continuation. The normal recording tab still carried the previous audio-stream failure, so the agent opened a fresh tab for the same mock call and preserved the held audio. An attempted **Reclaim Host** action was refused by automatic approval review and was not executed. The agent selected **Stay Co-Host** and continued with that role.

The user repeated the caption fallback passage while a fresh remote-only recording ran. At **19:19:04.125 MYT**, a DOM observer selected the actual **Skip transcription, use captions** button when it became visible. The observer did not change network responses or application state.

| Observation | Time or result |
| --- | --- |
| Skip selected | 19:19:04.125 MYT |
| UI changed from transcribing to summarizing | 19:19:05.126 MYT |
| Measured wait after Skip | **1,000.8 ms** |
| UI reported summary saved | 19:19:06.156 MYT |
| Held Recordings | One older failure before and after; no new entry |
| Held Transcripts | Zero |
| Artifact | `/Users/domhong/Downloads/meeting-summaries/2026-10-10-Dominic-Hong-s-Zoom-Meeting (2).html` |

The file contains the caption fallback test, the code **123**, and the agenda sentence. Its source is correctly labeled **live captions only**. Its further explanation, **“no audio was recorded”**, is inaccurate: recording ran, but the transcription was skipped.

Evidence: `.eval/qwen3-ollama-manual-2026-10-10/skip-metrics.json`, `skip-complete-processing.jsonl`, and `skip-complete-artifact-1.html`.

## Later continuation: successful outage recovery

The user read the recovery passage in a fresh remote-only recording. At **19:24:39 MYT**, the popup showed a healthy recording with the microphone off. The real ASR process on port 11435 was stopped before **Summarize now** was selected at **19:24:41.754 MYT**. This uses the extension's manual Meeting End trigger; it does not establish automatic completion after **End Meeting for All**.

The separate local summary service on port 11436 remained available. The browser saved a caption-only artifact and added one Held Recording with:

> ollama transcription: Ollama is not running at http://localhost:11435 — open the Ollama app, then retry

The held-recording count changed from one to two. The earlier item was the existing audio-stream failure and was not part of this outage test.

After restarting ASR, the agent selected **Retry transcription** for the entry with the current Ollama-outage reason at **19:26:15.660 MYT**. By **19:26:21.574 MYT**, the new held item was removed. The older failed recording remained, and there was no Held Transcript. The real Ollama server logged successful `/api/show` and `/api/chat` calls.

| Artifact | Result |
| --- | --- |
| `/Users/domhong/Downloads/meeting-summaries/2026-10-10-Dominic-Hong-s-Zoom-Meeting (3).html` | Caption fallback while ASR was stopped |
| `/Users/domhong/Downloads/meeting-summaries/2026-10-10-Dominic-Hong-s-Zoom-Meeting (4).html` | Recovered audio transcript after Retry |

The recovered transcript contains the complete requested passage:

> 04:03 Unknown: This is the recovery test. We will meet on Friday. Alex will send the report tomorrow.

Its metadata says **from recorded audio, speakers from captions · local microphone not recorded**. Thus recovery succeeded, but the **local Ollama model label is missing**. A freshly opened Settings page after this download showed Ollama selected and **Name the transcription engine in saved summaries** still checked.

The retry path calls `fuseTranscript()` without attaching the engine metadata. Unlike the normal path, it therefore cannot supply that label to the artifact renderer. No source fix was made.

Evidence: `outage-processing.jsonl`, `outage-artifact-1.html`, `retry-success-processing.jsonl`, `retry-success-artifact-1.html`, `final-retry-state.json`, and `ollama-retry-server.log` under the same local evidence directory.

## Final state after the later continuation

At **19:32 MYT**, Settings were verified back at their original values: Claude for summaries, Local Whisper for transcription, English, engine naming off, and microphone recording off. The two temporary Ollama ports had no listener, and the extra text model had been removed. The user's normal Ollama service and original models were preserved.

The popup showed no active recording, no Held Transcript, and one older Held Recording with the audio-stream failure. The successfully retried outage recording was no longer held. The older item was preserved for investigation.

The small local summary model supported workflow testing; these checks do not establish summary quality. No source-code fix, commit, or push was made.

## Later continuation: measured silence

The user prepared another two-participant Zoom mock call. The extension microphone stayed off, and English captions were enabled. Before recording, the agent listed the existing OPFS audio files so that the older held recording would not be exported or changed.

An initial waiting span contained only near-silence. It was stopped and retained separately. A resumed span captured the two requested passages. Participant A was muted through the actual Zoom control between the passages. Read-back observations confirmed mute at **20:01:25.810** and **20:02:47.298 MYT**, a lower bound of **81.488 seconds**. The interval exceeded the planned 30 seconds because of the test interaction and subsequent wait.

Before summarization, the resumed span was stopped, copied from OPFS, and decoded with `OfflineAudioContext` at 16 kHz, the same browser decoding method used by the extension. Channels were averaged as in the production decoder. RMS was measured in 20 ms frames against the extension's `0.001` silence threshold.

| Audio measure | Result |
| --- | --- |
| Retained spoken span | `measured-silence.webm`, 6,926,973 bytes |
| Decoded duration | 447.66 seconds |
| Decoded sample rate | 16,000 Hz |
| Channels before averaging | Two |
| Peak frame RMS | 0.10937 |
| Quiet section between speech bursts | 190.76–423.58 seconds within the span |
| Quiet-section duration | **232.82 seconds** |
| SHA-256 | `391a26cf774cf4f798d54ce532192166df2709f3179d43b51a13d261efe09dc0` |

The popup hides **Summarize now** after Stop. An attempted keyboard restart started capture in the participant tab instead of the intended host tab; the extension correctly refused a second capture. The raw files identified the extra capture by its tab ID. The two known mock-call tabs were then closed, stopping that capture and triggering processing of the retained host recording. This automation issue is not evidence of a Qwen3-ASR defect.

The resulting file is `/Users/domhong/Downloads/meeting-summaries/2026-10-10-Dominic-Hong-s-Zoom-Meeting (5).html`. It is labeled as recorded audio with the correct local Ollama model and contains exactly two transcript lines:

> 20:07 Unknown: Before the exam interval, Alex will send the report on Monday.
>
> 24:06 Unknown: After the interval, we will meet on Friday.

No additional utterance appeared in the measured quiet interval. The **no invented lines during silence** check passed. The requested word *silent* was transcribed as *exam* in the first passage and omitted in the second; these are word-accuracy observations. The displayed times are not proof of exact word-level alignment, and the earlier unretained run's timing discrepancy remains unexplained.

Evidence is retained in `measured-silence.webm`, `measured-silence-audio-analysis.json`, `silence-muted-start.json`, `silence-muted-end.json`, `silence-final-processing.jsonl`, and `silence-final-artifact-1.html` under the local evidence directory.

## Later continuation: microphone-consent preservation

These were settings-only checks after recording had stopped. The user explicitly instructed the agent to enable **Record my microphone** and Save under Local Whisper. The user then separately authorized the SageMaker consent check and selected **leave microphone on**. Chrome microphone permission was not requested, audio capture was not started, and no SageMaker endpoint request was made.

A temporary extension page read only the engine selection, microphone-enabled flag, confirmation timestamp, and engine-naming flag from actual Chrome storage. It did not write settings or record audio. All changes used the existing Settings controls. The page was reloaded before each engine switch so the form used the saved values as its baseline.

| Transition | Observed result |
| --- | --- |
| Local Whisper → Ollama, 20:23 MYT | Microphone enabled before and after; the non-null confirmation timestamp was unchanged |
| SageMaker → Ollama, 20:27 MYT | Separately authorized SageMaker consent remained enabled; its non-null confirmation timestamp was unchanged |

Both preservation checks passed. The empty popup explanation remains a separate failure, so the combined consent/disclosure checklist item stays open.

Evidence: `consent-whisper-before.json`, `consent-whisper-to-ollama.json`, `consent-sagemaker-before.json`, and `consent-sagemaker-to-ollama.json`.

At **20:32 MYT**, cleanup restored the other original Settings: Claude for summaries, Local Whisper for transcription, and engine naming off. **The microphone setting remained on with its confirmation intact**, as the user explicitly chose. The temporary inspection page was closed and removed from `dist/`; its read-only source was kept with the evidence. Both temporary Ollama services were stopped and the added text model was removed. Raw silence-test audio and the older failed recording were preserved. No recording was active during these consent checks.
