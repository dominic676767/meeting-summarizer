---
version: 1
slug: "src-content-capture-prompt-ts"
primary_target: "src/content/capture-prompt.ts"
related_targets: ["src/popup/popup.ts","src/popup/popup.html"]
---

Scope: the Capture Start surface (in-page prompt in the meeting tab) and the popup's recording state vocabulary. Visitor mode: Operate.

Audience: a BYO-LLM knowledge worker or restricted-org employee already in a Teams meeting, attention on the call, not on the browser chrome. Job: begin recording before anything is said, without thinking about the extension. Task frequency: once per meeting, under time pressure, with an unrecoverable cost for missing it.

Constraint that shapes everything: Chromium's `tabCapture` starts only after the *extension* is invoked on the tab — a toolbar action click, a registered keyboard command, or a context-menu item. A click on an injected in-page button does not grant that permission. So the in-page surface cannot itself start capture; it can only summon the gesture that does.

## Direction contract

THESIS: The prompt is a summons, not a control. It owns one idea — capture is not running and the meeting is being lost right now — and refuses the category default of an injected floating widget that mimics the host app's buttons and pretends to be part of the meeting. It never impersonates Teams chrome, and it never offers a button that cannot legally do what it says.

OWN-WORLD: The documented Status Readout world, inherited whole and isolated in a shadow root against the host page's CSS: `system-ui`, white ground, Ink text, flat, one 1px `#eee` hairline, 4px radius ceiling, and the single Signal Green capture dot as the only color. Recording state turns that dot Alert Red — the one place red means "live", earned because the recording indicator is the universal exception.

STORY: The visitor understands that the extension saw the meeting and is standing by, believes starting is one keystroke rather than a hunt, and presses that key (or clicks the toolbar mark) before the first agenda item.

FIRST VIEWPORT: Bottom-left of the meeting tab, clear of Teams' own bottom-center call controls and right-hand panels. A 260px card: the green dot and "Not recording" on line one at the label weight, the meeting title muted beneath, then the keyboard shortcut set as the affordance itself — a real key rendering, not prose — and a quiet "Not now" that dismisses for this meeting. Once recording, it collapses to a single line with the red dot and elapsed time, then disappears.

FORM: An extension of an established surface, so no direction roll and no seed key — the world is settled by DESIGN.md and only this addition's purpose, hierarchy, states, and join are being resolved. Ordered first of one candidate: the summons card, because the platform constraint eliminates every design that starts capture in the page.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## State vocabulary (popup and prompt share it)

One vocabulary, two renderings. The popup reports every state; the prompt exists only for `detected` and shows a collapsed line during `recording`. Copy is the product's own language, never an internal term: "segments" is a Caption Segment count the user did not ask for, so the popup counts them only while that is the sole evidence capture is working.

| State | Popup line | Class / color | Popup affordance | Prompt |
|---|---|---|---|---|
| `idle` | "Not in a meeting." | `idle` / Muted `#555` | Settings only | absent |
| `detected` | "Meeting detected — not recording." | `warning` / Alert Red `#d73a4a`, weight 600 | **Start recording** (primary) | the summons card |
| `recording` | "Recording — {elapsed}" | `recording` / Alert Red dot, Ink text | Stop, Summarize now | collapsed line, red dot + elapsed |
| `recording` + no captions | "Recording, but no captions arriving — turn captions on." | `warning` / Alert Red, weight 600 | Stop, Summarize now | collapsed line, unchanged |
| `transcribing` | "Transcribing audio…" | `capturing` / Signal Green | none (`aria-busy`) | absent |
| `summarizing` | "Summarizing…" | `capturing` / Signal Green | none (`aria-busy`) | absent |
| `done` | "Summary saved to Downloads/meeting-summaries." | `capturing` / Signal Green | Settings only | absent |
| `failed` | "Summarization failed — transcript held for retry below." | `warning` / Alert Red, weight 600, `aria-live=assertive` | held list + Retry | absent |

`degraded` is a modifier, not a state: when a Meeting produced no Audio Recording, the popup appends "Captions only — no audio was recorded." at 12px Muted under the `done` line. It is not an error and never uses Alert Red.

`captureWarning` is the second modifier, and it outranks the state line. A non-fatal capture fault — storage quota exhausted, a recorder error — means the recording is degrading *while the user still has time to act*, so it renders above the status line in weight-600 Alert Red type (a warning, per the Text-or-Dot Rule), with the recording dot still showing beneath if capture is somehow continuing. Copy names the problem and the recovery in the product's language: "Storage is full — recording stopped. The captions are still being captured." A capture warning that only appears after the meeting is a warning that arrived too late to matter, so it must surface the moment the offscreen recorder reports it, not at Meeting End.

**Red carries two meanings here, and that is deliberate.** Alert Red is the documented warning color, and `detected` is genuinely a warning — the meeting is being lost. During `recording` the same red reads as the universal recording indicator. Both are "something is happening you must know about", so the color holds; the dot's presence distinguishes live capture from a warning. This is a durable addition to the Meaning-Only Color Rule and needs the user's approval before it enters DESIGN.md.

**Reconciliation note.** `SessionState` (background, per-tab lifecycle) and `CaptureState` (wire vocabulary, what the surfaces render) are deliberately separate; the background maps one to the other. The old `capturing` has no `CaptureState` member by design — it split into `detected` and `recording`, which is the distinction Chromium's invocation requirement forces.

## Accessibility invariants

Carried from the popup's hardening pass, and binding on the prompt too: the status line is a live region (`polite`, `assertive` for warning and failure), `aria-busy` marks the transcribing and summarizing waits, no Unicode glyph or emoji carries state, and the prompt is reachable and dismissible by keyboard with a visible focus ring. The prompt mounts in a shadow root so the host page cannot restyle it and it cannot restyle the host page.

## Unresolved

- Transcription Provider settings UI, Held Recording rows, the artifact's Degraded Capture notice, and raster icons are explicitly out of this pass.
- Whether the default keyboard shortcut collides with Teams' own bindings needs testing in a real Chrome load.
