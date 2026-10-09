# Zoom branch merge review — 9 October 2026

**Decision: the branch is not ready to merge into `main`.**

The review used branch `zoom-36-web-client` at `f92319ab738e515ce75bd4a9c1f275b23ed4192c` and the refreshed remote `main` at `6e565ba64ea819d9b07ca54362c9f32cdfe2a620`. Their common ancestor is `0943fe576cf1d36a589e09d5b7333ffcace92796`.

The pending handover items are now recorded as [future improvements](future-improvements.md), as requested by the project owner. They are excluded from the new merge blockers below. No source fix, commit, push, or branch merge was performed during this review.

## Merge compatibility

The branch has 10 commits that are absent from `main`. It lacks 27 commits from `main`, including ElevenLabs Scribe and SageMaker transcription.

This command checked the merge without changing either branch or the working files:

```sh
git merge-tree --write-tree --name-only \
  6e565ba64ea819d9b07ca54362c9f32cdfe2a620 \
  f92319ab738e515ce75bd4a9c1f275b23ed4192c
```

It returned conflicts in six files:

| File | Integration needed |
| --- | --- |
| `.gitignore` | Preserve both branches' private-work exclusions. |
| `README.md` | Combine Zoom guidance with the transcription engines now on `main`. |
| `docs/ARCHITECTURE.md` | Describe both the new engines and the Zoom capture changes. |
| `src/background/background.ts` | Retain the shared engine-name import and content-script recovery. |
| `src/options/options.ts` | Retain engine consent and temporary AWS credential handling alongside the microphone permission flow. |
| `src/transcription/provider.ts` | Combine cancellation, concurrent and pause-based windows, and speaker-label scoping with the new inference-duration accounting. Selecting either side alone would lose required behavior. |

No open pull request was found for this branch. No merged-result CI status was available.

## Standards

**Two findings; the most serious is P2 transcript-word loss.**

1. **P2 — Preserve genuine short replies in the local Whisper result.** [local-whisper.ts](../src/transcription/local-whisper.ts#L81), line 81, adds `msg.spans.filter((span) => !isSilenceArtifact(span.text))`. It removes complete utterances such as “You.”, “Thanks.”, and “Goodbye.” solely from their text, including during otherwise valid speech. This conflicts with [CONTEXT.md](../CONTEXT.md#L13), line 13, and [ADR-0004](adr/0004-audio-transcription-fused-with-caption-speaker-track.md#L5), line 5: audio supplies the words that were said.

   A controlled Worker response returned `["Who will own the migration?", "You.", "Thanks."]` after four seconds of 16 kHz input at amplitude `0.01`. The engine from common ancestor `0943fe5` returned all three spans. The engine from `f92319a` returned only the question. Both versions were bundled in memory from their pinned Git sources. This reproduces the changed result filter; it is not a live speech-recognition test. The deletion defect is separate from the deferred false-added-text issue.

2. **P3 — Use the documented failure color.** [artifact.ts](../src/pipeline/artifact.ts#L51), line 51, adds `#9b2c1d` for capture failures. [DESIGN.md](../DESIGN.md#L217), line 217, specifies Fault Red `#aa0000` for past failures. Use that token or document the new token. This is a small, non-blocking design mismatch.

No additional code-smell finding warrants action. The deferred manual checks remain deferred.

## Spec

The branch implements **partial Zoom support**. It does not complete [issue #36](https://github.com/dominic676767/meeting-summarizer/issues/36).

Missing or partial requirements:

1. **Named full-transcript input is missing.** The spec requires “The full-transcript panel, when the host allows it and the user has it open. It gives real names.” [zoom.ts](../src/adapters/zoom.ts#L74), lines 74–102, reads only overlay captions and assigns every entry `Unknown`. The account restriction and accepted research skip explain the gap; they do not establish implementation.

2. **Active-speaker fallback and its ADR are missing.** The spec states, “Active-speaker detection ships in v1, not as a follow-up. It needs its own ADR”. The [adapter interface](../src/adapters/adapter.ts#L12) provides caption snapshots only. No active-speaker implementation or new ADR exists. [ADR-0004](adr/0004-audio-transcription-fused-with-caption-speaker-track.md#L16), line 16, still requires captions for attribution.

3. **Platform order remains unchanged.** The requested “Zoom before Google Meet” order is absent from [CONTEXT.md](../CONTEXT.md#L49), line 49, and [PRODUCT.md](../PRODUCT.md#L40), line 40. Both still place Meet first.

Incorrect behavior:

4. **The popup hides the missing-speaker warning when anonymous captions arrive.** The spec says, “The popup explains why and what the user can do.” [popup.ts](../src/popup/popup.ts#L354), lines 354–377, checks only whether the caption count is zero. One Zoom overlay caption removes the warning although its speaker is `Unknown`. The popup also gives no host-controlled transcript guidance.

Supporting scope expansion:

- The spec says, “Audio capture, transcription, fusion, summarization and the Summary Artifact do not change.” The branch adds microphone permission handling, Whisper silence filtering, and artifact capture warnings. Later authorized live-test fixes explain this expansion; it is not a new blocker.

**Counts: three missing or partial requirements, one incorrect behavior, and one supporting scope expansion.** The most serious Spec gap is the absence of the required speaker-identification sources. The accepted future quality checks and skipped issue #37 research are excluded from these counts.

## Validation

Validation ran in an isolated copy of the current tracked files and the new future-improvements document. It used the project's Node `22.22.2` and existing dependencies. The installed extension's `dist/` directory was not changed.

| Check | Result |
| --- | --- |
| Current automated suite | 576 passed; one optional real-model test skipped; 36 test files. |
| TypeScript | Passed. |
| Production build | Passed. |
| Built manifest | Referenced files exist; Zoom scripts are included in all matching frames; Settings opens in its own tab; unsupported `audioCapture` permission is absent. |
| Whitespace and edited documentation links | Passed. |
| Short-reply regression comparison | Failed on the reviewed branch; passed at the common ancestor. |
| Merge simulation | Failed with six conflicting files. |
| Live browser and merged-result tests | Not run in this review. |

The existing automated suite does not test the valid-short-reply case demonstrated above. Its passing result does not clear that defect.

## Work required before merge

1. Correct the new short-reply deletion defect and verify that genuine speech survives the silence filter.
2. Integrate the latest `main`, resolve all six conflicts, and preserve the Scribe and SageMaker behavior.
3. Align the merge description and issue scope with the implemented feature. A partial Zoom merge must not close the full issue #36 specification.
4. Run tests, TypeScript, and the build on the resolved combined code. Include the provider cancellation, windowing, engine selection, and consent tests from `main`.

Standards: two findings, with P2 transcript-word loss the most serious. Spec: four unmet requirements, with speaker identification the largest gap.
