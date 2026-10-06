# Manual checks

The things this extension has to get right that no test in this repo can establish. One document for the whole project rather than a list per ticket, because the reason these checks exist is that somebody has to sit in front of a real browser and look — and that person does it once, for everything outstanding, not once per ticket they happen to remember.

Read this before a release.

## What belongs here

**A check belongs here if and only if code cannot establish it.** Three things make a check uncheckable in code, and each of them is a real reason:

- the behaviour only exists in a browser the tests do not run (Chromium's own capture, storage, and permission machinery);
- the only witness is a person (what the user hears in their headphones, what the toolbar looks like at 16px);
- the fact needs a second human being (whether two voices land in one file).

Everything else is a test, and belongs in `tests/`. A manual check that could have been an assertion is a check nobody will run: it costs a release day, it is skipped under pressure, and it silently stops being true. If you are about to add one, first ask whether the honest rule underneath it is a pure function — most of the microphone's rules turned out to be, which is why `tests/mic-capture.test.ts` exists and is short.

A ticket that defers a check adds it here, under the ticket's number, rather than leaving it in its own body. That is the whole mechanism: tickets close, this file does not.

## How to record an answer

Every check below is **unrun**. Nothing in this document has been verified, and an unrun check is not a passing one.

When you run one, write the answer underneath it: the date, the browser and its version, and what actually happened — including "worked" if it worked. An answer that only says "checked" is worth no more than the empty box, because the next person cannot tell what was checked or whether the version they are shipping still does it.

Where an answer changes a decision, it belongs in the ADR as well. #24's Chrome-indicator question is the standing example: if Chromium surfaces a live microphone nowhere, then this extension's own badge is load-bearing for *consent* rather than for convenience, and that is a consequence for ADR-0007 rather than a line in this file.

---

## Tab audio capture (#12)

- [ ] **The user keeps hearing the meeting for the whole call while recording.** `tabCapture` stops the tab's audio reaching the speakers unless the stream is reconnected through an `AudioContext` (ADR-0004). Nothing in the code can hear the difference and the meeting client reports nothing wrong — the only witness is the user's own ears, and the failure is total.
- [ ] **The recording indicator is visible whenever audio is being captured, and reads differently from capturing captions alone.** The badge text is a pure function of session state and is tested as one; whether the rendered toolbar badge is actually legible and actually distinguishable is not. Now largely covered by the badge checks under #24 — run those and this one is answered with them.
- [ ] **Audio appends incrementally to browser-managed storage over a long meeting**, and memory does not grow with the meeting's length. The point of OPFS here is that an Audio Recording is never held whole in memory, which only a long real recording demonstrates.
- [ ] **A storage-quota failure surfaces as a capture warning and the recording continues.** Needs a genuinely exhausted quota; a test can only exercise the branch, not the browser's behaviour on reaching it.
- [ ] **Local WASM Whisper runs in the browser** and finishes a real meeting's audio, including the one-time model download.

## The local microphone (#22)

- [ ] **Two people's voices genuinely land in one file.** This can only be established in a real two-party meeting: the mix is tested against a fake graph, which proves both streams were wired to the recording and cannot prove either carried sound.
- [ ] **The user does not hear themselves.** `tests/mic-capture.test.ts` asserts the absence of the `mic → speakers` wire, which is the only way to catch a loopback outside a real call — but an echo is inaudible in the Audio Recording and audible only to the person wearing the headphones, so somebody has to wear them.
- [ ] **A microphone denied at the OS level degrades to tab-only capture** rather than failing the recording, and the popup says which of the three causes happened (switched off, disclosure unanswered, refused). The states are pure and tested; that Chromium's actual refusal lands in the "refused" one is not.

## The recording badge (#24)

What the badge says for a given session is a pure function — `badgeFor` in `src/background/badge.ts` — and the whole table is asserted in `tests/badge.test.ts`. What Chromium does with the answer is not, and neither is whether a person can read it.

- [ ] **The recorder reports `micRecording` truthfully in a real meeting.** Consent given in Settings, capture started: with the microphone genuinely in the mix the report must be true, and with it absent — refused, or no input device — false. Which letters follow from the report is `badgeFor`'s table and already tested; whether the report matches what a real `getUserMedia` stream actually opened is not.
- [ ] **A microphone revoked mid-Meeting drops the badge to `REC` while recording continues**, without the popup being opened. Revoke from Chrome's site controls or unplug the input device. This is the `mic-track-ended` path, and it is the one that fails silently — see the residual gap below.
- [ ] **Record, stop, then hover.** The tooltip must stop mentioning the microphone. `chrome.action.setTitle` being per-tab and sticky is the assumption the entire design rests on: if a stopped recording's sentence survives, the badge goes on claiming a live microphone in words. Nothing outside a browser can check this.
- [ ] **Two meeting tabs, one recording with the microphone and one without.** Each tab's badge and tooltip must show its own state; badge text and title are both set per-tab and nothing proves Chromium keeps them apart.
- [ ] **A fault while recording shows `MIC!` or `REC!` without the popup being opened.** Force silence (mute the meeting and yourself) or revoke the microphone mid-recording: all four characters must show unclipped, and the tooltip must lead with the warning. Four characters is the most a Chromium badge is believed to fit, and only a browser can say whether it does.
- [ ] **`MIC`, `REC`, and a three-digit count such as `999` all render in full** at default and 200% OS zoom, on light and dark toolbar themes — and are distinguishable in a greyscale screenshot, which is the colour-alone check the pure function cannot make.

### Chrome's own microphone surfaces

Both of these decide how much this extension's own indicator has to carry, because an offscreen document has no UI and `audioCapture` grants the microphone without a prompt (ADR-0007).

- [ ] **Does Chrome show any microphone-in-use indicator for a `getUserMedia` call made in an offscreen document** rather than in the meeting tab? The meeting tab's microphone pip is not expected to light, since the call is not in that tab.
- [ ] **Does `chrome://settings/content/microphone` list the extension after consent**, giving the user a findable way to revoke it?

### Known gap, not a check

`statusFor` refreshes `micRecording` from the recorder, but it runs only when the popup asks. `captions-update` and `meeting-status` redraw the badge often without refreshing it, so they repaint a stale claim rather than correct it: a microphone lost without `mic-track-ended` arriving keeps the badge on `MIC` until somebody opens the popup — the surface the badge exists to spare them. Recorded here so the revocation check above is not read as covering it.

## ElevenLabs Scribe (#34)

Everything Scribe decides about a transcript is a pure function and is tested with the HTTP call faked: the word list turned into spans, the renumbered and part-named labels, the request's fields, the timeout, the cancel reaching an upload in flight, and the consent rule (`micConsentAfterSave`). None of that proves the live endpoint answers the request the engine sends, or that the pages show what the code sets. These checks do. They need a real ElevenLabs key, so they are also the only place the engine meets the real service before a release.

**Run them on audio you are allowed to upload.** A mock meeting with people who have agreed to be recorded and sent to ElevenLabs, never a work or customer call. Choosing this engine uploads the meeting.

Setup: `npm run build`, reload the unpacked extension, and in Settings choose **ElevenLabs Scribe**, paste the key, and leave the model as `scribe_v2`. Turn on **Name the transcription engine in saved summaries** for the artifact check below.

- [ ] **The live endpoint accepts the request and returns diarized words.** A two-person mock meeting of a few minutes, captions on, ends in a Summary Artifact whose transcript came from recorded audio. The request shape is asserted against a fake; only the real service can say it accepts bare PCM with `file_format=pcm_s16le_16` and the language code, and that the extension's host permission lets the offscreen document reach it.
- [ ] **Where captions give no name, lines read `Speaker 1` / `Speaker 2`, not `Unknown speaker`.** Turn live captions off for a stretch of the meeting and speak in turns. The fallback is tested in fusion; that Scribe really separates two voices in a real mix (tab audio plus microphone, ADR-0007) is the claim this engine exists to make.
- [ ] **Stopping and resuming capture names each label's part.** Stop recording partway, resume, and again leave a stretch uncaptioned: labels in the second stretch read `Speaker 1 (part 2)`. Tested with a fake engine; this checks the parts line up with real Capture Spans.
- [ ] **The popup says where the audio is while it waits**: *Uploading to ElevenLabs to transcribe…*, with no percentage, until the summary is written.
- [ ] **"Skip transcription, use captions" during the upload ends the wait within a few seconds**, produces a caption-only summary, and leaves nothing in the Held Recordings list. Also look at the ElevenLabs usage page afterwards and record whether the cancelled upload was billed. The extension cannot know, and a user skipping a long upload should be told if it still costs them.
- [ ] **A wrong key holds the Recording, and fixing the key recovers it.** Save a deliberately wrong key, run a short meeting: it lands in Held Recordings with an HTTP 401 reason. Correct the key and use **Retry transcription**: the same meeting is summarized from audio.
- [ ] **The Meeting Language reaches the live endpoint.** Set the language to Malay and hold a short stretch in Malay, then Chinese in Mandarin: the transcript comes back in that language and script, not translated and not romanized. How *accurate* it is belongs to the evaluation in `docs/evaluations/`, not here.
- [ ] **The Summary Artifact names the engine as `ElevenLabs scribe_v2`** when engine naming is on, and names no engine when it is off.

### Consent when the destination changes (ADR-0008)

The rule is pure and tested. What is not is the options page wiring the right inputs into it and showing the right company name.

- [ ] **Local → ElevenLabs asks again, naming ElevenLabs.** With microphone consent given under local Whisper, select ElevenLabs Scribe and save. The microphone disclosure's cloud variant must read *uploaded to ElevenLabs*, and the popup must treat the microphone as unconfirmed until the disclosure is answered again.
- [ ] **OpenAI → ElevenLabs asks again, naming ElevenLabs.** The same, starting from consent given under OpenAI. This is the case ADR-0008 changed.
- [ ] **Saving again under ElevenLabs does not ask again.** After answering the disclosure under ElevenLabs, change an unrelated setting such as the summary shape and save: consent stays.
- [ ] **ElevenLabs → local keeps consent**, and the disclosure goes back to the on-this-machine wording.

## Amazon SageMaker (#50)

Everything the engine decides is a pure function and is tested with the network faked: the request (route header, multipart body, `to_language`), the signing (pinned to AWS's published `get-vanilla` example), how a reply and a failure are read, the credentials parser, the pause windows, and the factory's refusals. None of that proves that a real endpoint accepts the call, or that the pages show what the code sets. These checks do. They need your own JumpStart endpoint and temporary AWS credentials, so they are also the only place the engine meets SageMaker before a release.

**Run them on audio you are allowed to upload to that AWS account.** A mock meeting with people who have agreed to it, never a work or customer call.

Setup: deploy `huggingface-asr-qwen3-asr-1-7b` from SageMaker JumpStart. `npm run build`, reload the unpacked extension, and in Settings choose **Amazon SageMaker**. Enter the region and the endpoint name, and paste temporary credentials that allow only `sagemaker:InvokeEndpoint` on that endpoint. Turn on **Name the transcription engine in saved summaries** for the artifact check below.

- [ ] **The Test button reports OK, and names each broken part.** First with everything right: *The endpoint answered, in the format the engine reads.* Then one fault at a time: a wrong endpoint name (*Endpoint: … was not found in …*), credentials without the permission (*Credentials: … may not invoke …*), and credentials that have expired (*Credentials: … expired*). The mapping is tested on fake replies; only a real endpoint shows that AWS sends those error types.
- [ ] **A paste is stored in memory only.** After a valid paste, the box empties and the panel names the key, masked. In the Settings page's DevTools, Application → Extension storage: **Session** holds `sagemakerCredentials`, and **Local** holds no part of them. Close and reopen the browser: the panel says there are no credentials.
- [ ] **A real meeting is transcribed from audio, with caption names.** A two-person mock meeting of a few minutes, captions on, ends in a Summary Artifact whose transcript came from recorded audio, and whose lines carry the right speakers. This is the claim that the pause windows make up for the missing timestamps.
- [ ] **The Meeting Language reaches the model.** Set the language to German and hold a short stretch in German: the transcript comes back in German, not translated. Then choose Ukrainian: the panel's note says the model guesses, and a transcript still comes back.
- [ ] **Credentials that expire during a meeting cost a retry, not the meeting.** Paste credentials with a short life, from `aws configure export-credentials`, so that the expiry is known. Start recording and wait until they expire: the popup warns while it records. At Meeting End the recording lands in Held Recordings with the *expired* reason, and a caption summary is written. Paste fresh credentials and use **Retry transcription**: the same meeting is summarized from audio.
- [ ] **A silent stretch adds no invented lines.** Mute the meeting and yourself for 30 s in the middle of a mock meeting. The transcript must have no line in that stretch. Qwen3-ASR invents text for digital silence, so this checks that a real recording's silence is below the level at which the wrapper skips a window.
- [ ] **"Skip transcription, use captions" ends the wait within a few seconds**, produces a caption-only summary, and leaves nothing in the Held Recordings list.
- [ ] **The Summary Artifact names the engine as `Amazon SageMaker <endpoint>`** when engine naming is on, and names no engine when it is off.
- [ ] **Local → SageMaker, and ElevenLabs → SageMaker, ask again for microphone consent**, and the disclosure reads *uploaded to Amazon SageMaker, in the AWS account your credentials belong to*.

## The popup and logo redesign (#25)

Not yet landed. Its checks live in `design-system/meeting-summarizer/MASTER.md` on the `popup-logo-redesign` branch and move here when #25 merges, per the rule above.
