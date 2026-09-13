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
