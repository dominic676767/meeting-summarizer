# Test steps for Zoom issue #37

Use these steps for [issue #37](https://github.com/dominic676767/meeting-summarizer/issues/37).
They collect real page HTML, URLs, and test observations. They do not enable Zoom support
in the extension.

The first session, on 2026-10-03, captured a two-person meeting and the host-end dialog.
The files called “panel”, “preview”, and “breakout” did not show those states.
Capture a state only when you can see it in the Zoom page.

The [2026-10-06 results](results-2026-10-06.md) add three speaking test participants
across sessions, a six-person gallery, breakout entry and return, muted-participant
controls, shared caption-language changes and a timeout dialog. They include 19
trimmed fixtures and audio measurements from the existing recorder in a research
harness. One recording contains remote speech before, inside and after a breakout
room. The report identifies the tests that remain open.

## 1. Prepare the meeting

1. Use Chrome on the computer that will collect the files.
2. Use one host and a second person. Start with three participants for the transcript
   tests. The full layout test also needs two and six participants. Extra devices can
   supply participant tiles. Use headphones or mute their audio to prevent feedback.
3. Tell each participant what you will capture. Obtain the consent that is required.
   Use test names such as **Participant A**, **Participant B**, and **Participant C**.
   Use test speech and a blank document for screen sharing.
4. Record the operating system, Chrome version, Zoom web client version if shown,
   and test date. Record the participant count for each capture.
5. In the host's Zoom settings, check **Automated captions**. Also check **Meeting
   transcript** and **Allow all meeting participants to view transcripts during the
   meeting**, if available. Record the exact settings and whether an admin locked them.
   Their effect in the web app is part of this test.
6. Enable a waiting room and breakout rooms for the test meeting. Disable join before
   host for the waiting-for-host test.
7. Keep raw files in `~/Downloads/zoom/`, outside the repository. Raw HTML and URL logs
   can contain names, emails, meeting IDs, passwords, and photo URLs. Remove these data
   before a file becomes a test fixture.

Use a fresh Chrome profile for the default-setting check in step 5. Do not change
**See myself as the active speaker while speaking** before you record its initial value.

## 2. Prepare the page capture helper

1. Open the Zoom meeting tab. Open DevTools with **Option–Command–I** on macOS.
2. Select **Console**. Select **top** in the execution-context menu.
3. Copy the full contents of [capture.js](capture.js) into the Console and run it.
   On macOS, this terminal command copies the file:

   ```sh
   pbcopy < /Users/domhong/Projects/meeting-summarizer/docs/research/zoom-capture/capture.js
   ```

4. When the required state is visible, run a command such as:

   ```js
   zoomDump("zoom-preview")
   ```

5. Check that the JSON file is in Downloads. Move the file into `~/Downloads/zoom/`.
   If Chrome blocks the download, allow downloads for this test tab and run the command again.

Each JSON file contains the top document's HTML and URL. It also contains the
`#webclient` frame's HTML and URL when that frame is present and readable.

- `frameStatus: "captured"` means both documents were read.
- `frameStatus: "not-present"` means there was no `iframe#webclient`. This can be valid
  when the meeting is in the top document.
- `frameStatus: "unreadable"` means the frame was present but could not be read. Select
  the `webclient` frame in the Console context menu. Paste `capture.js` there and run
  the same capture command. Keep both files, then select **top** again.

After a full page navigation, paste the helper again. A new helper instance has a new
`captureId`. Node IDs can be compared only within the same `captureId`.

The helper reads the page and starts a local file download. It does not operate Zoom
controls or record audio. An HTML file cannot show whether tab audio continued.

## 3. Start the URL log before you join

The page capture gives a URL at one point in time. A separate extension log is needed
to test `chrome.tabs.onUpdated`.

The local built manifest checked on 2026-10-04 has no Zoom host permissions. For this
test, add these two entries to `host_permissions` in `dist/manifest.json`:

```json
"https://zoom.us/*",
"https://*.zoom.us/*"
```

Add them to the existing array. Keep its other entries. These are temporary test
permissions. Do not edit `src/manifest.json` for this step. A new build replaces the
temporary entries.

1. Open `chrome://extensions`. Load or reload Meeting Summarizer from this repository's
   `dist` directory. Use **Load unpacked** if it is not installed.
2. Under Meeting Summarizer, open the **service worker** inspection link.
3. In its Console, paste and run [url-log.js](url-log.js). On macOS:

   ```sh
   pbcopy < /Users/domhong/Projects/meeting-summarizer/docs/research/zoom-capture/url-log.js
   ```

4. Open the Zoom web app home page in the tab that you will use for the test.
5. In the service worker Console, run:

   ```js
   await zoomUrlTabs()
   ```

6. Find that tab's numeric ID in the table. Replace `123` below with that ID:

   ```js
   await zoomUrlStart(123)
   ```

7. Keep the service worker DevTools open through join, meeting, and leave. Use the Zoom
   tab's DevTools for `zoomDump`. These are two different Consoles.
8. After the test, run this in the service worker Console:

   ```js
   zoomUrlStop()
   copy(JSON.stringify(zoomUrlLog, null, 2))
   ```

9. Save the clipboard text as a plain text `.json` file in `~/Downloads/zoom/`.

Run the URL test twice. Save the first log before you start the second:

| Log file | Entry route |
|---|---|
| `zoom-url-browser-join.json` | Navigate the tracked tab to a `zoom.us/j/...` meeting link. Select **Join from browser**. |
| `zoom-url-app-join.json` | Start at `app.zoom.us/wc`. Select **Join** and enter the meeting details. |

If Zoom opens another tab, start a log for that tab too. Save the old log first.
If the extension reloads or the service worker restarts, the listener is lost.
Start it again and note the gap. A gap cannot prove that a URL event was absent.

After a normal participant leave, compare the captured page URL with `changeUrl` in
the log. Record whether `/wc/leave` appeared and whether `tabs.onUpdated` reported it.
Do not force that path. Record `/wc/home`, `/wc/`, or any other actual result.

## 4. Capture the meeting states

For each row, make the state visible, then run `zoomDump("LABEL")`.
Use the label from the table. Add a suffix if you repeat a state.

| Label | Action and observation |
|---|---|
| `zoom-preview` | Stop at the camera/microphone preview before you enter. |
| `zoom-waiting-host` | Join before the host starts the meeting. Capture the waiting-for-host screen. |
| `zoom-waiting-room` | Have the host start the meeting but delay admission. Capture the waiting room. |
| `zoom-overlay-3` | Join, enable captions, and have three people speak in turn. Capture visible caption text. Repeat for a speaker with a photo and one without a photo. |
| `zoom-transcript-menu` | Open the caption or transcript menu. Capture the controls that are present or missing. |
| `zoom-panel-bottom` | Open **View full transcript**, if available. Have three people speak in turn. Capture the panel at its newest rows. |
| `zoom-panel-scrolled` | Continue the conversation for about ten minutes. Scroll up while new speech continues. Capture the older rows. |
| `zoom-panel-returned` | Scroll back to the newest rows. Capture again. Note whether old rows disappear from the DOM. |
| `zoom-panel-reopened` | Close the panel while speech continues, then reopen it. Capture the result. Note whether recent speech is present. |
| `zoom-breakout-before` | Capture the main room before the host sends you to a breakout room. |
| `zoom-breakout-joining` | Capture the visible transition into the breakout room, if it lasts long enough. |
| `zoom-breakout-inside` | Capture inside the breakout room, with captions visible if available. |
| `zoom-breakout-closing` | Have the host close the rooms. Capture the return countdown, including the 60-second countdown if offered. |
| `zoom-breakout-returned` | Capture after you return to the main room. Note any audio or caption interruption. |
| `zoom-reconnect` | Briefly disconnect the participant computer's network. Capture the reconnect message, then restore the connection. |
| `zoom-reconnected` | Capture the meeting after it recovers. |
| `zoom-host-ended` | Have the host end the meeting for everyone. Capture the dialog before it closes. |
| `zoom-after-host-ended` | Capture the resulting page and URL. Paste the helper again if the page navigated. |
| `zoom-user-leave` | In a separate join, capture the participant's leave confirmation, if shown. |
| `zoom-after-user-leave` | Confirm **Leave**. Capture the resulting page and URL, including `/wc/leave` if it appears. |

For the transcript setting test, record the menu and panel before and after the host
changes the relevant setting. Rejoin if Zoom requires it. Record the exact setting that
made the option available. If no option appears, save that result and the menu capture.
Do not label a caption overlay as a transcript panel.

For the breakout test, keep the capture helper installed in the top context if that page
survives. The bundle records IDs for the frame element, documents, and known caption
containers. These can help identify replacement. Missing selector matches alone do not
prove that a feature is absent. A full navigation resets the helper; note that reset.

## 5. Test the layouts and active-speaker display

Capture all nine combinations:

| Participant count | Gallery | Speaker | Screen share |
|---|---|---|---|
| 2 | `zoom-gallery-2` | `zoom-speaker-2` | `zoom-share-2` |
| 3 | `zoom-gallery-3` | `zoom-speaker-3` | `zoom-share-3` |
| 6 | `zoom-gallery-6` | `zoom-speaker-6` | `zoom-share-6` |

For each combination:

1. Have Participant A speak, then Participant B. Capture during each turn.
   Use suffixes such as `-a-speaking` and `-b-speaking`.
2. Record the visible active-speaker border, the **Talking:** label, and the speaking
   icon in the Participants panel, if present. Their absence is also a result.
3. Have one person speak while muted. Capture the result.
4. Turn one person's camera off. Enable **Hide non-video participants**. Have that person
   speak while unmuted. Capture the result.
5. If **Follow host's video order** is available, repeat a speaker change with it enabled.

In a fresh Chrome profile, record the initial value of **See myself as the active speaker
while speaking** under the web app's video settings, if available. Capture the setting
before you change it. Speak locally and record what appears. If the setting is missing,
record that result.

## 6. Test a vanity meeting link

Use a real meeting link from an account with a host such as `example.zoom.us`.
Join from that account's link. Capture the joined meeting and keep its URL log.
Record whether the meeting stays at that host, moves to `app.zoom.us`, or uses an iframe.

If no such account is available, mark U2 **still unknown**. Do not substitute a made-up
host or meeting ID.

## 7. Test the existing recorder with a research harness

The build checked on 2026-10-04 has a Teams content script only. The Zoom adapter and
manifest integration are not present. Adding the URL-log permissions does not enable
Zoom recording in the product.

An isolated research extension can start the existing recorder in a Zoom tab before
the complete adapter is available. Version 0.0.1 used the bundled, unchanged recorder
on 2026-10-06 in signed-in Chrome. It captured remote speech in the main meeting,
inside a breakout room and after return, in one recording. A separate macOS test
held live tab and microphone tracks after a visible permission grant, but did not
verify useful local speech. See the [results](results-2026-10-06.md) and
[audio evidence](audio-transitions-2026-10-06.json).
Record the harness version and permission state with each result. Keep recorder
findings separate from validation of the complete extension flow.

Use headphones and these checks:

| Check | Procedure and required observation |
|---|---|
| Before **Join audio** | Start tab recording with extension microphone capture off. Have the remote participant speak. Record whether that speech is present in playback. |
| After **Join audio** | Join computer audio. Have the remote participant speak again. Check the recording for that speech. |
| Local voice, extension microphone off | Speak locally. Check whether the recording contains your voice or an echo. Record any remote-device feedback. |
| Local voice, extension microphone on | Enable and confirm the extension's microphone consent. Start another recording while Zoom already uses the microphone. Have both people speak. Check that both voices are present without a duplicate local voice. |
| Microphone access failure | Record the operating system and exact error, including `NotReadableError` if it occurs. Do not infer Windows or Linux results from macOS. |
| Breakout continuity | Keep recording through a breakout round trip. Speak before, during, inside and after each transition. Use continuous source speech during the transitions to measure gaps; separate clips in each room cannot prove gap-free audio. |

Record the build used and save the test audio locally. A successful start indicator or a
DOM capture is not evidence that the saved audio contains the expected voices.

## 8. Return the evidence

Keep the raw JSON files, URL logs, and notes in `~/Downloads/zoom/`. In the notes, include:

- The test environment and settings from step 1.
- The label, participant count, layout, and actual visible state for each capture.
- Missing options, failed checks, and states that you could not test.
- Audio results only for tests you actually ran.

Then report that the captures are ready in that folder. The next repository work is to
remove private data, extract the required HTML into `tests/fixtures/`, and update
[the research table](../zoom-web-client.md#verification-checklist-and-remaining-tests).
Use **confirmed**, **wrong — with the correction**, or **still unknown** for each result.

U3 (ZoomGov), U11 (caption language), and U14 (microphone permission) are also in that
table. The shared caption language setting is confirmed for U11; recognition accuracy
and independent translation remain **still unknown**. Record new evidence for each
remaining check. U14 also has separate issue #49. These do not replace the checks
listed in #37.

Keep #37 open while its required evidence is missing.
