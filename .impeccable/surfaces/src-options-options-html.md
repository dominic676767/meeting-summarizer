---
version: 1
slug: "src-options-options-html"
primary_target: "src/options/options.html"
related_targets: ["src/options/options.ts"]
---

Scope: the Settings page's shape — how a routine setup reaches Save, and how a destructive template reset is recoverable. Visitor mode: Operate.

Audience: two different users on the same page. The routine one is here once, to pick a provider and paste a key. The advanced one is here to edit a Prompt Template, rarely, and deliberately. Today the page is built for the second and makes the first scroll past two large monospace textareas — Save sits roughly 1526px down at a 324px width.

## Two decisions, both previously deferred

### 1. Collapse the template editors — yes

Wrap each Prompt Template editor in a `<details>`, collapsed by default, summary reading **"Structured template"** / **"Narrative template"** with a Muted 12px hint beside it: "Editing optional".

Reasons this is right rather than merely shorter:

- **It matches the density split the system already documents.** DESIGN.md's chrome is deliberately compact; two 10-row and 6-row monospace textareas are the densest thing in the product and they sit in front of the one action every user needs.
- **`<details>` is already this system's disclosure idiom** — the Summary Artifact folds the transcript into one. Reusing it costs no new component and no new interaction to learn.
- **Progressive disclosure is the documented reason the popup stays low-load.** The same argument applies here: show what is needed now.

Constraints:

- The summary is a real heading-weight label (600, 13px), not a link, and carries a visible focus ring.
- A template the user has customized must not be hidden without a signal: when the stored template differs from the default, the summary carries a Muted "edited" marker so a collapsed editor never conceals a change the user made.
- Collapsed state is not persisted. The page opens collapsed every time; an advanced user opens it in one click and that is cheaper than remembering per-user state.

### 2. Make "Reset to default" undoable — yes, and not with a confirm dialog

Reset replaces a template the user may have spent real effort on, and today it is instant and final. But a confirm dialog is the wrong instrument: DESIGN.md refuses a modal for a task that needs neither interruption nor protected focus, and a confirm on a two-click path trains the user to click through it.

Instead, reset is **immediately reversible**: performing it swaps the button to **"Undo reset"** and keeps the previous text in memory. Clicking it restores exactly what was there. The offer stands until the user saves, navigates away, or edits the field — it does not expire on a timer, because a timed undo makes the user race a clock they did not know had started.

Constraints:

- The button's accessible name changes with it, so a screen-reader user hears "Undo reset" rather than a button that silently changed meaning.
- Undo restores the text only; it never re-saves on the user's behalf.
- The swap is announced once through the existing status live region: "Template reset — undo is available."
- Two templates means two independent undo states; resetting one must not offer to undo the other.

## Inherited, not restated

Everything in DESIGN.md's Components and the constraints listed in `src-popup-popup-ts.md` still binds here — native controls, the 4px fieldset radius as the only rounding, 12px fieldset padding on the documented 4/8/12/16 chrome scale, and the settled `flat-type-hierarchy` position: this page's compact 13px scale is sanctioned, with weight rather than size marking importance.

## Unresolved

- Whether the provider fieldsets should collapse on the same pattern. Probably not — the active provider's key is the thing a routine user came for — but if the Transcription Provider section grows the page again, revisit it rather than collapsing the one field that matters.
