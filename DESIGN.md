---
name: Meeting Summarizer
description: A weightless, native-feeling utility whose color speaks only to report state.
colors:
  ink: "#1a1a1a"
  muted: "#555555"
  meta: "#666666"
  border: "#dddddd"
  border-faint: "#eeeeee"
  surface: "#ffffff"
  status-active: "#0e8a16"
  status-warning: "#d73a4a"
  status-error: "#aa0000"
typography:
  headline:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.4rem"
    fontWeight: 700
    lineHeight: 1.5
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
  meta:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: "monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "4px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button:
    padding: "6px 14px"
    typography: "{typography.label}"
  button-compact:
    padding: "4px 10px"
    typography: "{typography.label}"
  input:
    padding: "4px 6px"
    typography: "{typography.body}"
  fieldset:
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  textarea-template:
    typography: "{typography.mono}"
  status-active:
    textColor: "{colors.status-active}"
    typography: "{typography.label}"
  status-warning:
    textColor: "{colors.status-warning}"
    typography: "{typography.label}"
  status-idle:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
---

# Design System: Meeting Summarizer

## Overview

**Creative North Star: "The Status Readout"**

Meeting Summarizer is not an app you look at; it is an instrument you glance at. Its entire visible chrome — a 300px popup and a settings page — exists to report one thing quickly and honestly: is the meeting being captured, is something wrong, is a summary waiting? Color is the readout. It appears only to carry state, and everywhere else the interface is deliberately quiet: system font, black-on-white text, hairline dividers, and the browser's own controls. The design's ambition is to feel like part of the browser's own chrome rather than a product bolted onto it.

The system is flat by conviction, not by omission. There are no shadows, no gradients, no fills, no rounded "cards" — depth is a single 1px hairline where one section ends and another begins. Density is tight in the chrome (the popup earns its 300px) and generous in the one place made for reading, the Summary Artifact, which opens to a comfortable 760px measure at 15px/1.5. That split is intentional: the tool is compact, the document it produces is calm.

The current implementation leans entirely on native browser controls and the system font. That is documented here as the present state and a sensible default, but it is **provisional** — future work may add light custom styling to buttons and inputs, provided it stays within the utilitarian, meaning-only-color character below. What is *not* provisional is the restraint: color earns its place by meaning something, and flatness is the resting state.

Because the world is built from `system-ui` and the browser's own controls, it survives the Chromium migration (ADR-0003) unchanged: the same tokens render as native Chrome/Edge chrome rather than native Firefox chrome, which is the point of leaning on the platform in the first place. The toolbar mark was redrawn for Chromium as raster PNGs — see Shapes.

**Key Characteristics:**
- Color only ever reports state (active / warning / error); nothing decorative is colored.
- Flat throughout — depth is a single 1px hairline, never a shadow.
- System font, native controls; the UI reads as part of the browser.
- Compact chrome (13px), calm document (15px/1.5).
- Fully self-contained output: the Summary Artifact ships inline CSS and no external assets.

## Colors

A grayscale interface with a three-color semantic accent set that only ever signals meeting state.

### Primary
The product has no decorative brand color. Its "primary" expression is the semantic status set — the one place color is allowed.

- **Signal Green** (`#0e8a16`): the active/success signal. Used for the "Capturing…" status in the popup and the "Saved." confirmation in Settings. Presence of this green means the tool is working.
- **Alert Red** (`#d73a4a`): carries two meanings, and the pairing tells them apart. As the **warning** signal it is always set in weight-600 text — live captions are off (the state that makes the whole tool inert), or a meeting is being lost unrecorded — including the toolbar badge's red `!`. As the **live-recording** indicator it appears only as a filled dot beside Ink-weight text, never as colored type. Text means attention; a dot means live.
- **Fault Red** (`#aa0000`): the deeper error tone reserved for a Held Transcript's failure reason — a quieter, more sober red than the live warning, because it reports a past failure rather than an active one.

### Neutral
- **Ink** (`#1a1a1a`): primary reading text, used for the Summary Artifact body and headings.
- **Muted Gray** (`#555555`): secondary text — idle status, meeting title, field notes, section subheadings. The default color of anything that isn't the main message.
- **Meta Gray** (`#666666`): the artifact's metadata line (date · platform · segment count); one step lighter than Muted, for text that is present but subordinate.
- **Divider** (`#dddddd`): fieldset borders and the transcript's collapsible top rule.
- **Faint Divider** (`#eeeeee`): the lightest hairline, separating held-transcript rows.
- **Surface** (`#ffffff`): the implicit background everywhere; never tinted.

### Named Rules
**The Meaning-Only Color Rule.** Color exists to report state, never to decorate. If a colored element does not tell the user something about capture, saving, or failure, it should be grayscale. Green means working, red means attention *or* live capture, dark red means a past fault; everything else is ink and gray.

**The Text-or-Dot Rule.** Alert Red is the one color with two jobs, and its form disambiguates them: **red type** (weight 600) is a warning the user must act on; a **red dot** beside ordinary Ink text is the live-recording indicator, borrowing the universal convention every recorder shares. Never set recording state in red type, and never signal a warning with a bare dot. Approved as an amendment to this system, 2026-09-14.

## Typography

**Display / Body Font:** system-ui (with sans-serif fallback)
**Mono Font:** monospace — reserved for the editable prompt templates

**Character:** There is one typeface — the operating system's own — and the hierarchy is built almost entirely from size and weight, not from font changes. Monospace appears only where the user edits raw template text, signaling "this is code you can change."

### Hierarchy
- **Headline** (700, 1.4rem, 1.5): the Summary Artifact `<h1>` (meeting title) and the primary reading heading.
- **Title** (700, 1.15rem, 1.5): the artifact's section headings (`<h2>`), set with top margin to open space before each block.
- **Body** (400, 15px, 1.5): artifact reading text and transcript segments; the one place tuned for sustained reading.
- **Label** (600, 13px): the workhorse weight of the chrome — form labels, the popup's section headings, the transcript speaker name, and the collapsible summary trigger. Weight, not color, marks importance in grayscale zones.
- **Meta** (400, 0.85rem, Meta Gray): the artifact's single metadata line.
- **Mono** (400, 12px, monospace): the structured/narrative prompt-template editors only.

### Named Rules
**The Weight-Before-Color Rule.** In grayscale zones, importance is expressed by moving to the 600 label weight, not by adding color. Color is spent only on state (see the Meaning-Only Color Rule).

## Layout

Three surfaces, three widths, one spatial idea: fit the job.

- **Popup** — `min-width: 300px`, content padded `12px`. Compact and single-column; it is a readout, not a workspace.
- **Settings** — `margin: 16px`, capped at `max-width: 640px`. A single top-to-bottom form: provider select, a fieldset per provider (only the active one shown), summary-shape select, two template editors, Save.
- **Summary Artifact** — `max-width: 760px`, `margin: 2rem auto`, `padding: 0 1rem`. The only surface designed for reading, with the summary first and the full transcript folded into a `<details>` at the bottom.

Spacing rhythm is a small, tight scale (4 / 8 / 12 / 16px) in the chrome and rem-based breathing room (1–2rem) in the document. No responsive grid exists; each surface is a single fixed-max-width column, which is correct for its context (fixed popup, panel settings, printable document).

## Elevation & Depth

**No shadows. Anywhere.** The system is flat by conviction. Depth and separation are conveyed exclusively by 1px hairline rules: fieldset borders and the artifact's collapsible divider use Divider (`#dddddd`); held-transcript rows are separated by the lighter Faint Divider (`#eeeeee`). There is no elevation vocabulary to catalogue because the system has, correctly, none.

### Named Rules
**The Hairline Rule.** Separation is a 1px solid line, never a shadow, fill, or card. Two weights only: `#dddddd` for structural divisions, `#eeeeee` for list rows.

## Shapes

The form language is near-rectangular. The only radius in the entire system is `4px`, applied to the Settings fieldsets — a barely-softened corner that reads as "grouped," not "styled." Buttons, inputs, and selects currently use the browser's native shape (whatever the OS renders); this is provisional and may be given a light explicit radius later, but any such radius should stay at or below the 4px fieldset value to preserve the flat, squared character. Nothing in the system's chrome is pill-shaped or heavily rounded.

### The Mark

The toolbar icon (`src/icons/icon.svg`, rendered to PNG by `scripts/render-icons.mjs`) is the readout reduced to a single summary line: one white bar led by a Signal Green dot, on an Ink tile. The dot reads two ways at once — the bullet of a summary line, and the live-capture signal the popup reports in words. It is the one place a circle appears, and it earns it by being that status dot.

On a 32-unit grid: tile `rx 7`; dot `r 4.5` at (9.5, 16); bar 10 × 4 at (16, 14), squared ends. Bar edges sit on whole pixels at 16px so the line stays crisp in the toolbar. The 16/32/48 PNGs render full bleed; the 128 PNG is 96px of art centered in a transparent canvas, per the Chrome Web Store icon spec.

The Ink tile is how the mark survives both toolbar themes: Chromium has no `context-fill`, so instead of adapting the ink, the mark carries its own ground. On a light toolbar the tile reads; on a dark one it recedes and the bar and dot read. The tile is the mark's only fill — the chrome's no-fill rule governs the interface, not the icon.

**The One Signal Rule.** The mark carries exactly one colored element — the capture dot. If the icon ever needs a second state (paused, failed), it changes *that dot's* color and nothing else.

## Components

Every component today is either a native browser control or a thin styling of one. Character comes from restraint.

### Buttons
- **Shape:** native browser button (no custom radius or fill); `font: inherit`.
- **Action:** padding `6px 14px` in Settings (Save, Reset to default), `4px 10px` in the popup (Summarize now). Label weight (600, 13px) text.
- **States:** native UA hover/focus/active. *Provisional* — custom hover/focus treatment may be added later; if so, keep it subtle and utilitarian.

### Inputs / Fields
- **Style:** native text/password inputs and selects; `width: 100%`, `box-sizing: border-box`, padding `4px 6px`, `font: inherit`.
- **Labels:** block, 600 weight, sat directly above their field with a 2px gap.
- **Template editors:** full-width `<textarea>` in 12px monospace, signaling editable raw text.
- **Focus:** native. Provisional, per the buttons note.

### Fieldsets (provider / template panels)
- **Corner:** gently squared (`4px` radius) — the only rounded element in the system.
- **Border:** 1px Divider (`#dddddd`).
- **Behavior:** one provider fieldset is visible at a time; the rest carry a `hidden` class. Notes inside use Muted Gray at 12px, with inline `<code>` for setup strings.

### Status Line (signature)
The heart of "The Status Readout." A single line of 13px text whose color is its message:
- **Active:** Signal Green (`#0e8a16`) — "Capturing…".
- **Warning:** Alert Red (`#d73a4a`), weight 600 — captions are off.
- **Idle:** Muted Gray (`#555555`) — "Not in a meeting."
The meeting title sits below in Muted Gray, 12px, subordinate to the status.

### Popup Footer

- Divided from the content above by a Faint Divider (`#eeeeee`) top rule with `12px` above and `10px` below — the only structural division inside the popup.
- Holds the **Settings** button (the popup's route to the options page) and, above it, an unconfigured-provider hint in Muted Gray at 12px that hides itself once credentials exist.
- The hint is the popup's only instructional copy. It is a one-liner, never a panel, and it disappears permanently rather than being dismissible.

### Held Transcripts List (signature)
- A borderless list; each row is a flex line (`justify-content: space-between`, `align-items: center`, `gap: 8px`) separated by a Faint Divider top rule.
- The failure reason is Fault Red (`#aa0000`) at 11px — small, sober, informative.

### Summary Artifact (signature deliverable)
- A self-contained HTML document with inline CSS and zero external assets.
- Ink body at 15px/1.5, 760px measure; Headline title, Meta Gray metadata line.
- The full transcript lives in a `<details>` element with a weight-600, pointer-cursor `<summary>` trigger and a Divider top rule; each segment is a paragraph with a 600-weight speaker name.

## Do's and Don'ts

### Do:
- **Do** spend color only on meeting state — Signal Green for active/success, Alert Red for warnings (with weight 600), Fault Red for past failures. (The Meaning-Only Color Rule.)
- **Do** express importance with the 600 label weight in grayscale zones rather than reaching for color.
- **Do** separate sections with a single 1px hairline — `#dddddd` structurally, `#eeeeee` for list rows. (The Hairline Rule.)
- **Do** keep the chrome compact (13px, 4–16px spacing) and the Summary Artifact calm (15px/1.5, ~760px measure).
- **Do** keep the Summary Artifact fully self-contained: inline CSS, no external fonts, scripts, or images.
- **Do** use the system font for interface text and monospace only for editable template text.

### Don't:
- **Don't** add shadows, gradients, fills, or elevation of any kind — the system is flat.
- **Don't** introduce a decorative brand color or color any element that isn't reporting state.
- **Don't** round corners beyond the 4px fieldset radius, or make anything pill-shaped or circular.
- **Don't** widen the chrome into a "dashboard"; the popup is a readout, Settings is a single form column.
- **Don't** load web fonts, icon fonts, or external assets into any surface, and never into the artifact.
- **Don't** use Unicode glyphs or emoji to carry state (`●`, `⚠`). They announce as noise to screen readers and render as color emoji on many platforms, injecting non-state color. The status class and its words carry the state; the drawn mark is the only icon.
- **Don't** let a status change be visible-only. Any element whose text reports state carries a live region, so the readout reaches assistive tech as well as the eye.
