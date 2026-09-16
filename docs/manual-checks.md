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

- [ ] **`MIC` while the recorder has the microphone in the mix, `REC` while it does not.** Consent given in Settings, a real meeting, capture started: the letters have to match what is actually open, not what was asked for.
- [ ] **A microphone revoked mid-Meeting drops the badge to `REC` while recording continues**, without the popup being opened. Revoke from Chrome's site controls or unplug the input device. This is the `mic-track-ended` path, and it is the one that fails silently — see the residual gap below.
- [ ] **Record, stop, then hover.** The tooltip must stop mentioning the microphone. `chrome.action.setTitle` being per-tab and sticky is the assumption the entire design rests on: if a stopped recording's sentence survives, the badge goes on claiming a live microphone in words. Nothing outside a browser can check this.
- [ ] **Two meeting tabs, one recording with the microphone and one without.** Each tab's badge and tooltip must show its own state; badge text and title are both set per-tab and nothing proves Chromium keeps them apart.
- [ ] **`MIC` and `REC` both render in full** at default and 200% OS zoom, on light and dark toolbar themes — and are distinguishable in a greyscale screenshot, which is the colour-alone check the pure function cannot make.
- [ ] **Past 999 caption lines the badge shows `999` and the tooltip the exact count.**

### Chrome's own microphone surfaces

Both of these decide how much this extension's own indicator has to carry, because an offscreen document has no UI and `audioCapture` grants the microphone without a prompt (ADR-0007).

- [ ] **Does Chrome show any microphone-in-use indicator for a `getUserMedia` call made in an offscreen document** rather than in the meeting tab? The meeting tab's microphone pip is not expected to light, since the call is not in that tab.
- [ ] **Does `chrome://settings/content/microphone` list the extension after consent**, giving the user a findable way to revoke it?

### Known gap, not a check

`statusFor` refreshes `micRecording` from the recorder, but it runs only when the popup asks. `captions-update` and `meeting-status` redraw the badge often without refreshing it, so they repaint a stale claim rather than correct it: a microphone lost without `mic-track-ended` arriving keeps the badge on `MIC` until somebody opens the popup — the surface the badge exists to spare them. Recorded here so the revocation check above is not read as covering it.

## The popup and logo redesign (#25)

Not yet landed — these live in `design-system/meeting-summarizer/MASTER.md` on the `popup-logo-redesign` branch and move here when it merges, per the rule above. In outline: the popup fixtures for every capture state, light and dark mode, increased text size, keyboard focus, reduced motion, forced colors, long meeting titles, delayed and rejected actions, the rasterized icon read at 16px against both toolbar themes, and `node scripts/check-popup-size.mjs` against a real Chromium — the last of which exists because Chromium sizes an action popup from its own document, and no page preview takes that path.
