---
version: 1
slug: "src-pipeline-artifact-ts"
primary_target: "src/pipeline/artifact.ts"
related_targets: []
---

Scope: how the Summary Artifact states what it was made from (ticket #15). Visitor mode: Read.

Audience: whoever opens the saved HTML file later — often the author, sometimes a colleague it was forwarded to, possibly months after the meeting. They are deciding how much to trust a specific claim in it, and they cannot ask the tool anything; the file is all they have.

Why this is design work and not a log line: the artifact's words are the only place provenance can live, and the failure mode is a summary built from caption words that a reader assumes came from a recording. The pipeline's v2 shape produces three genuinely different levels of reliability, and a reader who cannot tell them apart will over-trust two of them.

## The three provenance levels

1. **Fused** — recorded audio for the words, Speaker Track captions for the names. The intended path: accurate words, real owners.
2. **Audio without attribution** — audio transcribed, but captions were unavailable or did not overlap, so speakers are the engine's anonymous diarization labels. Words are trustworthy; **owners are not**, which matters most for action items.
3. **Captions only (Degraded Capture)** — no Audio Recording. Caption words, with the platform's own misreadings and any lines the panel scrolled past. Speaker names are real.

## Direction contract

THESIS: The artifact tells the reader what it is made of, in its own first breath, and the action-items section inherits that caveat where owners are guessed. It owns the idea that a summary's authority is part of its content, and refuses the default of a confident document that never says where its words came from.

OWN-WORLD: The artifact's existing document world — Ink at 15px/1.5, 760px measure, Meta Gray metadata, one hairline, inline CSS, no external assets. Provenance is set in the existing Meta line, not a badge, banner, or callout box. A Degraded Capture is not an error and never takes Alert Red.

STORY: The reader understands within one line whether they are reading transcribed audio or scraped captions, believes the document is being straight with them, and calibrates their trust in the action items accordingly.

FIRST VIEWPORT: The Meta line directly under the title, extended with provenance as its final clause: `2026-09-14 · teams · 47 min · from recorded audio, speakers from captions`. Where owners are anonymous, the structured summary's action-items heading carries one Muted parenthetical noting speaker labels are unverified. Nothing else changes.

FORM: An extension of the artifact, so no direction roll and no seed key. Ordered first of one candidate: provenance in the Meta line, because a banner would make the honest path look like the broken one.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Exact copy

| Level | Meta clause | Transcript section label |
|---|---|---|
| Fused | "from recorded audio, speakers from captions" | "Full transcript" |
| Audio, no attribution | "from recorded audio · speakers not identified" | "Full transcript" |
| Captions only | "from live captions only — no audio was recorded" | "Full captions" |

Rules the implementation must not bend:

- **Never omit the clause.** An artifact with no provenance clause is indistinguishable from the best case, which is precisely the over-trust this ticket exists to prevent.
- **The collapsible section is labelled for what it contains.** Calling scraped captions a "transcript" is the same overclaim in miniature.
- **Do not soften level 3.** "no audio was recorded" is the fact; "limited audio" or "partial" is hedging that reads as a malfunction.
- **Where speakers are unverified, say so next to the owners**, not only in the Meta line — the action items are what get acted on, and that is where a wrong owner does damage.

## Required test coverage

`tests/pipeline.test.ts` currently asserts the literal string `"Full transcript"` in the artifact HTML. Changing the label for a Degraded Capture will break that assertion, which is the brief working, not collateral damage.

**Assert both labels, not just the new one.** Flipping the existing assertion to `"Full captions"` would let a future regression mislabel scraped captions as a transcript and still pass green. The label is a truth claim about what the section contains, so both claims need a test:

- an audio-derived artifact renders `"Full transcript"`;
- a Degraded Capture artifact renders `"Full captions"` and does **not** contain the string `"Full transcript"`.

Assert the Meta clause per level the same way — each level's clause present, and the caption-only artifact asserted *not* to contain the audio clause. A provenance bug that silently upgrades a caption-only summary to "from recorded audio" is the exact defect this ticket exists to prevent, so it needs a failing test rather than a careful reviewer.

## Unresolved

- Whether the Meeting duration belongs in the Meta line at all; it is proposed above because provenance reads better against a length, but it is a new fact in that line.
- Whether a forwarded artifact should also name the transcription engine and model. Useful for reproducibility, but it leaks the reader's tooling choices to recipients — the user's call.
