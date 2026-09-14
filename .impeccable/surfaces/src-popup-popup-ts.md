---
version: 1
slug: "src-popup-popup-ts"
primary_target: "src/popup/popup.ts"
related_targets: []
---

Scope: how the popup reports the three long phases between Meeting End and a finished summary (ticket #13). Visitor mode: Operate.

Audience: the same meeting-goer, now waiting. They have left the call and want to know whether the tool is working or wedged. Local WASM Whisper on an hour of audio is slow enough that silence is indistinguishable from a hang, so progress reporting here is a correctness requirement, not polish.

The three phases have completely different time profiles and must never be merged into one "Working…":

1. **Model download** — one-time, hundreds of megabytes, determinate. If this is not visibly distinguished from per-meeting work, the user concludes every meeting will take this long and turns the feature off.
2. **Transcription** — long, proportional to meeting length, per-meeting.
3. **Summarization** — short, one provider call, already has its state.

## Direction contract

THESIS: Name the phase and show the ground truth for it. This surface owns the idea that a long wait is trustworthy only when the user can tell which phase they are in, whether it is one-time or every-time, and that it is moving. It refuses the category default of one indeterminate spinner standing in for a multi-minute job.

OWN-WORLD: The Status Readout, unchanged. Signal Green for working phases, Ink for measured values, Muted for the subordinate detail line. No new color, no spinner iconography, no progress ring — progress is a determinate bar only where the number is real, and words where it is not.

STORY: The visitor understands which of the three phases is running, believes the wait is bounded and one-time where it is, and leaves the popup rather than force-quitting the browser.

FIRST VIEWPORT: The status line names the phase. Beneath it, one Muted 12px detail line carries the measure: for the download, transferred of total plus the fact that it happens once; for transcription, audio processed of audio total, which is honest even when the engine reports no percentage; for summarization, nothing, because it is short. A determinate bar appears only under the download and only because those bytes are known.

FORM: An extension of the popup, so no direction roll and no seed key. Ordered first of one candidate: phase-named progress with a real measure, because every alternative reduces to hiding which phase is running.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Copy and states

| Phase | Popup line | Detail line (12px Muted) |
|---|---|---|
| Model download | "Downloading the transcription model…" | "{n} MB of {total} MB · one-time setup" |
| Transcription | "Transcribing audio…" | "{mm}:{ss} of {mm}:{ss} processed" |
| Transcription, no engine progress | "Transcribing audio…" | "{elapsed} elapsed · long meetings take a while" |
| Summarization | "Summarizing…" | none |

Rules the implementation must not bend:

- **Never show a percentage the engine did not report.** A fabricated percentage that stalls at 90% is worse than elapsed time.
- **"One-time setup" must appear in the download's detail line**, or the user prices every future meeting at this wait.
- **The wait is cancellable, and cancelling degrades rather than loses.** A user who will not wait for transcription can stop it and take a Degraded Capture — the caption-only summary — instead. Losing the meeting because they were impatient is the one outcome this product may not produce. The control reads "Skip transcription, use captions", never "Cancel", because "Cancel" implies losing the meeting.
- `aria-busy="true"` on the status region for the whole wait, `aria-live="polite"`, and the detail line updates no more than once a second so a screen reader is not flooded.

## Design system constraints that bind every popup change

These are settled in DESIGN.md, not proposals. Any ticket touching the popup's status line — #13, #16 (Held Recording rows), or later — inherits them:

- **The Text-or-Dot Rule.** Alert Red `#d73a4a` has two jobs and its form tells them apart: red *type* at weight 600 is a warning the user must act on; a red *dot* beside ordinary Ink text is the live-recording indicator. Never render recording state as red type; never signal a warning with a bare dot. (User-approved amendment, 2026-09-14.)
- **The Meaning-Only Color Rule.** Nothing decorative is colored. Green means working, red means attention or live capture, dark red `#aa0000` means a past fault, everything else is Ink or Muted.
- **No glyph or emoji carries state.** No `●`, no `⚠`. They announce as noise to screen readers and render as color emoji on many platforms, injecting non-state color. The class and the words carry the state; a drawn dot element is not a glyph.
- **No status change is visible-only.** The status region is a live region (`polite`; `assertive` for warnings and failures) and `aria-busy` marks every wait. A progress phase that only the eye can see fails the same test the original popup failed.
- **Degraded is not an error.** A caption-only run is a normal outcome and never takes Alert Red; it is 12px Muted supporting text.

## Unresolved

- Whether the engine exposes per-chunk progress at all; the no-progress row exists because it may not.
- Whether the model download should be offerable ahead of the first meeting from Settings, which would move this phase out of the critical path entirely. Worth its own decision.
