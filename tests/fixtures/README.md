# Fixtures

## `known-phrase.wav` — audio for the opt-in Whisper run

16 kHz mono 16-bit PCM, about two seconds, saying *"We should ship the beta next
Friday."* It exists so one test can assert that real Whisper produces real words
(`WHISPER_INTEGRATION=1 npm test`); every other transcription test drives a fake
engine. Synthesised rather than recorded, so it carries nobody's voice:

```sh
say -v Samantha -o /tmp/phrase.aiff "We should ship the beta next Friday."
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/phrase.aiff tests/fixtures/known-phrase.wav
```

If you replace it, update `KNOWN_PHRASE` in `tests/transcription-whisper.test.ts`
to a phrase the new audio actually contains.

# Teams DOM fixtures

These fixtures are trimmed captures of the Teams **web client (v2)** DOM. They
are the regression net ADR-0002 anticipates: when Teams redesigns its caption
markup, the adapter breaks here first.

## Re-capturing after a Teams redesign

1. Join a Teams meeting at https://teams.microsoft.com in Firefox and turn on
   live captions (More → Language and speech → Turn on live captions).
2. Open devtools → Inspector, find the captions container
   (search the tree for `closed-captions-renderer` / `closed-caption-text`).
3. Right-click the container → Copy → Outer HTML, paste into
   `teams-captions.html`, trim to a handful of caption items, and strip any
   real names / content.
4. For the call-ended state: leave the meeting, copy the post-call screen's
   distinguishing element (rejoin button / call rating) into
   `teams-post-call.html`.
5. Update the selectors in the Teams adapter to match, and keep both fixture
   and adapter in the same commit.

# Zoom DOM fixtures

Trimmed captures of the Zoom web client's **meeting frame**: on `app.zoom.us` that is the
`#webclient` iframe, not the top document. They are the start of the regression net for the
Zoom adapter (#40). Every Zoom selector not in a fixture here is still a lead from the
served client code (`docs/research/zoom-web-client.md`), not a fact.

- `zoom-in-meeting.html`: 2 people, speaker view, captions on.
- `zoom-host-ended.html`: the ended-by-host dialog, with the leave button still present.

The following captures are from 2026-10-06, with client assets
`web_client/7.1.0.3.12693`:

- `zoom-caption-speaker-d.html`: D's caption overlay and the visible speaker bar, with
  D's active tile.
- `zoom-caption-speaker-e.html`: E's caption overlay and the visible speaker bar, with
  E's active tile.
- `zoom-gallery-six.html`: six participant tiles, D's active tile, and retained D/E
  caption rows. The two rows have the same `live-transcription-subtitle` ID.
- `zoom-breakout-caption.html`: E's caption text in the breakout room after captions
  were enabled again.
- `zoom-breakout-closing.html`: caption text and the actual room-closing dialog, with
  50 seconds remaining.
- `zoom-main-caption-restored.html`: E's caption text after automatic return to the
  main session and enabling captions again.
- `zoom-breakout-joining.html`: the visible `Joining Room 1...` loading state.
- `zoom-breakout-returning.html`: the visible `Returning to Main Session...` state.
- `zoom-transcript-admin-disabled.html`: account-settings DOM showing Meeting
  transcript disabled and locked by the administrator. This is not meeting-frame DOM.
- `zoom-gallery-nonvideo-hidden.html`: four video-off tiles remain visible after
  Hide Non-Video Participants was selected; the menu then offers Show Non-Video
  Participants.
- `zoom-participants-muted.html`: four muted participant rows, their accessible
  labels and muted-audio SVG classes, with Participant F's active tile retained.
- `zoom-gallery-sort-menu.html`: the six observed first-name, last-name and
  entry-time sorting choices.
- `zoom-caption-language-confirmation.html`: the French selection and confirmation
  that the caption language changes for everyone.
- `zoom-caption-language-french-host.html`: the host's French caption-language menu
  after Participant B saved the shared change.
- `zoom-caption-language-french-participant.html`: Participant B's French
  caption-language menu after the same change.
- `zoom-caption-language-english-restored.html`: the host's English caption-language
  menu after English was saved again.
- `zoom-join-timeout.html`: the join-timeout or browser-restriction dialog and its
  Report Problem, Retry and Leave controls.

Two later fixtures add Participant A after the meeting was recreated:

- `zoom-caption-speaker-a-hidden.html` — main-meeting caption at 09:09:44.954 UTC.
- `zoom-main-caption-a-return-hidden.html` — caption after return from Room 1 at
  09:45:10.025 UTC.

Both preserve the observed `style="display: none;"` on the retained caption row.
They show stored caption text after speech; they are not visible speaking snapshots.

Each file includes its source basename, UTC capture time and scope in a comment.
Participant F is the anonymized host. These are DOM excerpts with a fixture wrapper;
they do not reproduce the complete meeting page. Caption text, relevant classes and
repeated caption IDs are preserved. Speaker bars show only a subset of the meeting.
See the [session evidence report](../../docs/research/zoom-capture/results-2026-10-06.md)
for the observations and test limits.

The muted capture shows that an active-tile class alone does not prove current
speech. The participant panel is virtualized and may contain only part of a larger
roster. The Hide Non-Video capture covers an all-video-off meeting only. The language
captures have translation off and prove a shared setting change, not recognition
accuracy. The timeout dialog does not establish its cause or a successful recovery.

## Capturing more

Follow the [#37 capture steps](../../docs/research/zoom-capture/README.md). They include
`zoomDump`, a URL logger, and the required meeting states. Run `zoomDump` in the meeting
tab's DevTools Console with context `top`. It saves a JSON file with the top document and
the `#webclient` iframe, plus each URL. The guide gives a separate frame capture procedure
if the top document cannot read the iframe.

Raw captures contain names, emails, meeting IDs, meeting passwords in URLs, and photo URLs.
**Never commit one raw.** Keep raw files outside the repository. Extract only the HTML
elements a test needs, replace every name with *Participant A/B/…*, and remove emails,
meeting IDs, passwords, inline styles, and image URLs before saving a fixture here.
Keep only a narrowly selected visibility style when the test depends on it. The two
Participant A fixtures retain only `display: none;` on the caption row.
