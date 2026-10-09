# Future improvements

Updated 9 October 2026.

The project owner deferred the pending Zoom handover items below to future work on 9 October 2026. They remain open. This decision does not mark a failed check as passed or complete the manual release checklist.

The [live test handover](zoom-live-test-handoff-2026-10-07.md) preserves the test history. The [manual checklist](manual-checks.md) remains the record for browser release checks. Compatibility with `main` and any requirements missing from the original [Zoom specification](https://github.com/dominic676767/meeting-summarizer/issues/36) are separate merge-review questions.

## Pending work

| ID | Improvement | Current evidence | Completion check |
| --- | --- | --- | --- |
| FI-01 | Correct false repeated text in long transcripts. | The 27:19 Zoom report contains 30 standalone “next room” segments, 27 standalone “bathroom” segments, and six repeated courtesy segments 120 seconds apart. Short audio comparisons did not reproduce the full failure. Changing the decoder token limit had no verified benefit. | Retain a new complete recording of at least 125 seconds. Use known local and remote passages, a quiet interval, a planned repeated sentence, and a final marker. Compare the audio with the final transcript. Remove false added text while preserving real speech and planned repetition. |
| FI-02 | Verify transcript timestamps and report duration. | Commit `f92319a` uses the actual recorder start time for each capture span. Automated tests cover that time and its fallback. Live timestamp and duration accuracy remain unverified. | Record the meeting start, capture start, passage times, and Zoom End time. Compare them with transcript times and report duration, including a stop-and-resume gap. |
| FI-03 | Verify microphone loss and recovery during recording. | Idle Settings refusal and retry passed. Notification retries have automated coverage. Permission loss or device removal during a real recording remains untested. | Remove microphone access during capture. Confirm that remote audio continues, `REC!` and the warning appear without opening the popup, and local capture can resume after access returns. Record whether a manual restart is required. |
| FI-04 | Verify combined local and remote speech and echo. | Local and remote speech have passed in separate recordings. This does not prove both inputs in one complete recording. | Confirm both known passages in the same audio file and final transcript. Confirm that the user hears the meeting and does not hear their own microphone through the extension. |
| FI-05 | Verify immediate cleanup and the remaining recording indicators. | Later checks found recording stopped, no offscreen recorder, a cleared meeting flag, and a cleared badge. Immediate OS microphone indicator closure was not measured. | Observe the OS microphone indicator, recorder, badge, and tooltip at completion. Complete the per-tab badge, fault visibility, theme, and display-scale checks in the manual checklist. |
| FI-06 | Complete the remaining browser release checks. | The manual checklist still has open checks for long recordings, storage limits, OS-level refusal, Settings entry points, and local model setup. | Verify incremental storage and bounded recording memory, quota-failure recovery, OS-level microphone refusal, each Settings entry path, and the first local model download. Record browser version and observed results for each check. |
| FI-07 | Make default test discovery exclude saved work. | The default test search also collects incomplete source copies under `.eval/checkpoints/`. These copies fail because they contain only part of the source tree. | Configure default test discovery to select the current project tests and exclude `.eval/` and `.claude/`. Preserve the private evidence files. |

## Next transcript-quality investigation

Use a new test recording. Retain the complete audio before automatic report cleanup, and record each passage time. Include speech before and after the 120-second boundary.

End the meeting with Zoom **End Meeting for All**. Let the extension finish automatically, then compare the audio, transcript, summary, timestamps, duration, and immediate cleanup. A short standalone decoder test is supporting evidence; it does not complete the installed extension check.

Do not resume analysis of the old long recording that the project owner asked to stop analysing.

## Test command for this checkout

Until FI-07 is complete, exclude saved work explicitly:

```sh
npm test -- --exclude '**/.claude/**' --exclude '**/.eval/**'
npm run typecheck
```

The real-model test requires `WHISPER_INTEGRATION=1`. Report its result separately when it is not run.

## Recorded passes

The handover records passes across separate runs for live captions, remote speech, physical microphone speech, and automatic report creation after Zoom End. It also records fresh microphone permission refusal and recovery in idle Settings. These results remain valid within their recorded scope.
