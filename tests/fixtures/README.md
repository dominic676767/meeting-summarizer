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

## Capturing more

Join in Chrome as a participant. In the meeting tab's DevTools console (context `top`), define
`zoomDump` from #37 and call it once per state; it saves the top document and the iframe
separately, each headed by its URL. Raw captures contain names, emails, meeting IDs, meeting
passwords in URLs, and photo URLs. **Never commit one raw.** Cut it down to the elements a
test needs, replace every name with *Participant A/B/…*, and drop inline styles and image URLs.
