# Zoom web client: research for a Zoom Platform Adapter

Researched 2026-10-02 for the planned Zoom Platform Adapter (CONTEXT.md, ADR-0002, ADR-0004). It covers two Speaker Track sources: live captions, and the active-speaker indicator as a fallback when captions are off.

**Sources.** Only primary sources were used:

- Zoom support articles (support.zoom.com).
- Zoom's Terms of Service.
- Chrome and Chromium docs and source.
- The W3C Media Capture spec.
- The Zoom web client's own HTML, JS and CSS, as served on 2026-10-02.

The served client was version `web_client/7.2.0.1.12783`, plus the `web_client_pwa/7.2.0.3239` shell. For the original 2026-10-02 research, I requested Zoom's public test meeting through the form at `https://zoom.us/test`, then downloaded the meeting HTML and its JS chunks without joining. Selectors from that source analysis are **UNVERIFIED-unstable** unless a later real-meeting result below confirms them. The 2026-10-03 and [2026-10-06 captures](zoom-capture/results-2026-10-06.md) add live DOM evidence. Zoom ships a new client version often; a capture confirms only the tested build and state.

In citations, "JS" means the minified served code under `https://st1.zoom.us/web_client/7.2.0.1.12783/js/`:

- `chunks/main-client.min.js` holds the UI.
- `chunks/loginview.min.js` holds strings, store logic and active-speaker handling.
- `chunks/run-feedback.min.js` holds the leave and feedback flow.

"PWA JS" means `https://st1.zoom.us/web_client_pwa/7.2.0.3239/js/main.js`.

ARCC: no `search_arcc` tool was registered in this session. I queried ARCC through the arcc CLI fallback (`arcc context search "browser extension scraping third-party meeting captions recording consent"`). It returned 0 hits, so standard practices apply.

---

## Summary: findings that change the adapter design

1. **The caption overlay does not carry speaker names as text.**
   - Each line of the new caption overlay is a `<span class="live-transcription-subtitle__item">` holding the text. It sits next to an optional avatar, which is `aria-hidden`.
   - When the speaker has no photo, the avatar is a `<div>` showing the speaker's *initials*. Otherwise it is an `<img alt="">`. The name is never rendered as text (JS, `main-client`, components `cq` and `Xr`).
   - The older overlay renders the text alone (JS).
   - Full display names appear only in the **full-transcript side panel**, as `.lt-full-transcript__display-name > b` (JS). Zoom's docs say each line is "labeled with the speaker's meeting display name" ([KB0059762]). The served web-client code does not do that in the overlay.
   - So the Teams approach of scraping overlay lines will not yield names on Zoom.
2. **The full-transcript panel is gated by a server option and is virtualized.**
   - The "View full transcript" menu item only shows when `meetingOptions.isEnableViewFullTranscript` is set (JS). Zoom's public test meeting does not set it.
   - Since May 2026, transcript access is a separate, host- or admin-controlled "Meeting transcript" setting. It includes "Allow all meeting participants to view transcripts during the meeting" ([KB0085668], [KB0085675]).
   - The panel is a `react-virtualized` List: only rows near the viewport are in the DOM. The name is printed only on the first row of a run of lines from the same speaker (JS).
3. **On `app.zoom.us`, the meeting runs inside an iframe.**
   - The Zoom Web App shell at `app.zoom.us/wc` loads the meeting into `<iframe id="webclient" class="pwa-webclient__iframe">` (PWA JS). Iframe mode is the default; "tab" mode is an account option (PWA JS).
   - The iframe is same-origin (`app.zoom.us`), so `all_frames: true` with an `https://app.zoom.us/*` match reaches it.
   - The top frame's URL is still rewritten to `/wc/<id>/join?fromPWA=1` while the meeting is shown (PWA JS, `enableMeetingRoute: true` in the served config).
   - Joining from a browser link redirects `zoom.us/wc/join/<id>` → `app.zoom.us/wc/join/<id>` (observed 302).
4. **A host-only rule (`isMeetingUrl`) is not enough; a path rule is needed.**
   - The same hosts serve the home page, chat, calendar, the post-meeting page and the meeting.
   - Zoom names the meeting paths itself: block "zoom.us/wc/\*/join and zoom.us/wc/\*/start" to block browser meetings ([KB0064261]).
   - The PWA's own regexes are `^/wc/join/(\d{9,11})`, `^/wc/(\d{9,11})/join`, `^/wc/start/(\d{9,11})`, `^/wc/(\d{9,11})/start`, `/wc/start/videomeeting|webmeeting` and `/wc/my/<name>` (PWA JS).
   - On leaving, the client does `history.replaceState` to `/wc/leave?meetingNumber=…` (JS, `run-feedback`). The URL changes *without a navigation*, and `/wc/leave` must count as "not in a meeting".
5. **Breakout rooms re-render in place, and their audio is isolated.**
   - Joining a breakout room goes through the client's "meeting reset" path; it is labelled `"join breakout room"`, the same path as `"meeting failover"`. A loading layer `.loading-layer--bo-room` is shown, and no page navigation was found (JS).
   - Breakout rooms "are completely isolated in terms of audio and video from the main session" ([KB0060313]). Tab audio and captions therefore follow whichever room the user is in.
6. **The host and admin control captions; a participant cannot override.**
   - Automated captions are an account, group or user setting, on by default for paid accounts ([KB0058810]).
   - "Allow only the following users to enable captions" turns the participant's button into **Request captions**. The host must approve ([KB0059762], [KB0062813]).
   - The host can turn captions off for everyone ([KB0062813]). Manual captioning, when enabled, blocks automated captions ([KB0062813]).
   - Since 18–26 May 2026, captions can no longer be saved; scrollback is limited to the last 3 minutes ([KB0063899], [KB0085668]).
7. **The active-speaker fallback exists in the DOM but is lossy.**
   - The active tile gets a `--active` modifier class: `gallery-video-container__video-frame--active`, `speaker-active-container__video-frame--active` or `speaker-bar-container__video-frame--active`.
   - The modifier is only applied when more than 2 tiles show (gallery), or at least 2 (speaker view).
   - Tile names are in `.video-avatar__avatar-footer` (JS).
   - A "Talking: A, B, C" label (`span.asntip`) lists up to 3 server-reported speakers, but only those *not* currently rendered as tiles. It is hidden in speaker, standard and side-by-side-speaker layouts (JS).
8. **One Chrome-side finding affects ADR-0007 directly.** In Chromium's source, the `audioCapture` permission for `extension_types: ["extension"]` is restricted to an allowlist of 7 extension IDs ([chromium-perm]). It is not in the extensions permission list ([chrome-perms]). The repo relies on `audioCapture` to grant the microphone to the offscreen document without a prompt (`src/manifest.json`, `src/background/mic-capture.ts`). That reliance needs a real check (see UNVERIFIED U14).

---

## 1. URLs and framing

### URL shapes

| Purpose | URL shape | Source |
|---|---|---|
| Web App home | `https://app.zoom.us/wc` (`/wc/` 301s to it), `/wc/home` | observed; [KB0064261], [KB0059744] |
| Invite link (launcher page, not the meeting) | `https://zoom.us/j/<id>?pwd=…`; also `/s/<id>` (start), `/w/<id>` (webinar), `/my/<name>` (personal link) | observed ("Launch Meeting - Zoom"); PWA JS accepts `["/j/","/s/","/w/","/my/"]` as meeting links |
| "Join from your browser" target | `https://zoom.us/wc/join/<id>?ref_from=launch&fromPWA=1&pwd=…` → 302 → `https://app.zoom.us/wc/join/<id>?…` | link decoded from the server-provided `window.launchBase64` on the `/j/` page; redirect observed |
| PWA-internal join | `https://app.zoom.us/wc?mn=<id>&ref_from=launch&pwd=…` | same decoded payload |
| Meeting (join/start) | `/wc/<id>/join`, `/wc/join/<id>`, `/wc/<id>/start`, `/wc/start/<id>`, `/wc/start/videomeeting`, `/wc/start/webmeeting`, `/wc/my/<name>`; meeting IDs are 9–11 digits | PWA JS route table `RU` and regexes `c,l,d,u,h,g,f` |
| Which paths Zoom itself treats as "the meeting" | "only block the meeting and webinar paths explicitly (zoom.us/wc/\*/join and zoom.us/wc/\*/start)" | [KB0064261] |
| Pre-join preview | rendered at the join URL with a `.preview-root` element; the client also treats paths containing `/preview` or `/jb` as preview | JS (`m9t=["/preview","/jb"]`) |
| Leave/feedback | `history.replaceState` to `/wc/leave?meetingNumber=<id>&feedback=false`; later `location.href = <baseUrl>/wc/leave?meetingNumber=<id>&feedback=true` | JS, `run-feedback` |
| Post-meeting | `https://zoom.us/postattendee?mn=…` → 302 to `https://www.zoom.com/en/lp/my-notes?from=web_join_post_meeting` | decoded launch payload; redirect observed |
| Vanity | `<company>.zoom.us`, letters/digits/dashes, at least 4 characters | [KB0061540] |
| Vanity meeting page | `https://stanford.zoom.us/wc/<id>/join` returned the meeting page directly, with no redirect to `app.zoom.us`. For a meeting from another account it showed a "Join External Meeting … does not belong to stanford.zoom.us" interstitial | observed |
| ZoomGov | `www.zoomgov.com` serves "Zoom for Government"; `zoomgov.com/wc/<id>/join` (fake ID) 302'd to `zoom.us`. The PWA's link validator accepts `^([^.]+\.)*zoomgov(dev)?(\.[^.]+?)+$` | observed; PWA JS. ZoomGov meeting paths are **UNVERIFIED** (U3) |
| Cluster hosts | `us02web.zoom.us/wc/<id>/join` → 302 → `app.zoom.us/wc/<id>/join` | observed |

### Top frame or iframe?

**It depends on the entry point.**

- **Zoom Web App (`app.zoom.us/wc/...`), the default path from invite links:**
  - The shell decides an "open mode". It is `"iframe"` unless the account option `Open_Wc_Mode_By_DIP` selects tab mode (`Always_Iframe=0`, `Dip_Iframe=1`, `Always_Tab=2`) (PWA JS, module with `getOpenMode`).
  - In iframe mode it renders `<div class="pwa-webclient"><div class="pwa-webclient__iframe-wrapper"><iframe class="pwa-webclient__iframe" id="webclient" src={meetingUrl} role="presentation">` (PWA JS).
  - When `enableMeetingRoute` is on (served config: `config.enableMeetingRoute = true`) and the mode is not tab, the shell also pushes the top-frame route to the meeting path with `fromPWA=1` (PWA JS, `getCleanPortalRouteFromMeetingUrl`).
  - In tab mode it calls `window.open(meetingUrl, "_blank")` (PWA JS, `openMeetingTabWithGuard`). The meeting then runs top-level in a new tab.
  - Top-level navigation in the same tab happens only on WebOS (`/Web0S/i`) (PWA JS).
- **The meeting document itself** posts `{type:"join", event:"wc_loaded"}` to `window.parent` when framed. When not framed, it posts on `BroadcastChannel("PWA_WEBCLIENT_BC_CHANNEL")` instead (inline script in the meeting HTML). So it is built to run either way.
- **Vanity hosts:** the meeting page was served top-level at `<vanity>.zoom.us/wc/<id>/join` (observed). Whether a vanity user's own meeting stays there or bounces to `app.zoom.us` is **UNVERIFIED** (U2).
- **Isolation:** the meeting page and the PWA shell both send `cross-origin-opener-policy: same-origin` and `cross-origin-embedder-policy: credentialless` (observed response headers). The iframe is same-origin with the shell.

Adapter consequences:

- Manifest matches must include `https://app.zoom.us/*` and `https://*.zoom.us/*`. ZoomGov hosts need adding once verified.
- Keep `all_frames: true`. Chrome injects into "all frames matching the specified URL requirements" ([chrome-cs]).
- In iframe mode, the caption and tile DOM lives in the **child** frame. The top frame holds the shell.

### Path rule for "in a meeting"

Proposed host plus path predicate. It is derived from [KB0064261] and the PWA regexes; real-session confirmation is U1.

```
host ∈ { zoom.us, app.zoom.us, *.zoom.us }   (+ zoomgov equivalents once verified)
AND path matches  ^/wc/(\d{9,11})/(join|start)\b
              or  ^/wc/(join|start)/(\d{9,11})\b
              or  ^/wc/start/(videomeeting|webmeeting)\b
              or  ^/wc/my/[^/]+
NOT  ^/wc/leave   (and not /wc/home, /wc/team-chat, /wc/meetings, /wc/calendar, …)
```

- The path is necessary but not sufficient. The same URL shows the pre-join preview, the waiting room and the "waiting for host" state (see §4). The background's URL check should only gate whether the adapter is active; the DOM decides whether the Meeting is in progress.
- The move to `/wc/leave` is a `history.replaceState`, so it raises no `tabs.onUpdated` page load. Whether Chrome reports the URL change through `tabs.onUpdated` (`changeInfo.url`) for a same-document change is part of U1.

---

## 2. Captions

### How a participant turns them on (web app)

- In the toolbar, click **Show Captions**. To set the spoken language, use the up-arrow, then **Caption language** ([KB0059762], "Web app" section).
- Strings in the served client include "Show Captions", "Hide Captions", "View full transcript", "Captions and Translation" and "Host Caption Control Settings" (JS, `apac.newLTT.*` and `apac.newLT.*`).
- **Each participant turns captions on for themselves.** Zoom: "users who turn on captions in a meeting or webinar can experience automated captions" ([KB0058810]).
- The caption *language* is shared: "The caption language selection impacts all participants" ([KB0059762]).

### Who controls what

| Control | Level | Source |
|---|---|---|
| **Automated captions** on or off; available languages | Account, group or user (admins can lock); "enabled by default for paid Zoom accounts"; some accounts lack it entirely | [KB0058810] |
| **Allow only the following users to enable captions** (Host, or Host and Co-host) | Sub-setting of the above; "participants can request that the host enable captions" | [KB0058810] |
| Host disables captions for everyone in the meeting | Host, in-meeting: **Host caption control settings** → "Allow closed captioning for this meeting" | [KB0062813] |
| Manual captions (a typist) | Enabling it means "you can't use automated captions in the meeting/webinar or breakout rooms" | [KB0062813] |
| **Full transcript** and **Save captions** settings | **Removed** in May 2026 and folded into **Meeting transcript** (Meeting > In Meeting (Advanced)) | [KB0085668] |
| **Meeting transcript** sub-settings: auto-generate; "Allow all meeting participants to view transcripts during the meeting"; "Allow saving of transcripts to computer by …" | Account, group or user; "not enabled by default—a host or admin must explicitly turn them on" | [KB0085668], [KB0085675] |
| Saving captions | Not possible since 18 May 2026; "up to 3 minutes of scroll back" during the meeting | [KB0063899], [KB0085668] |
| Participant requests a transcript | More → Transcript → **Request transcription**; the host chooses Decline or Start | [KB0085682] |

**Can a participant turn captions on if the host hasn't enabled them?**

- **No.** If the account or host has automated captions off, there is nothing to turn on ([KB0058810]).
- If the host restricted who can enable them, the participant can only **Request captions** ([KB0059762], [KB0062813]).
- If the host disabled captions for the meeting, captions end for everyone ([KB0062813]). In the client this is the `isCaptionDisabled` state, and the overlay then renders `null` (JS).

**Web app caveat.** Several caption articles list only desktop and mobile in their requirements ([KB0059762], [KB0062813], [KB0085682]). The feature table marks "Live transcription" and "Display closed captions" as enabled for the Web App ([KB0065520]). Whether **View full transcript** and **Request transcription** work in the web app is **UNVERIFIED** (U5).

### Speaker names: overlay or side panel only?

**Docs:** "When viewing captions, the spoken line is labeled with the speaker's meeting display name" ([KB0059762]). This is written generically, in the desktop part of the article.

**Served web client: names appear only in the full-transcript panel. The overlay shows at most initials or a photo.** From `main-client.min.js`:

- Overlay container: `.live-transcription-subtitle__box`, inside `.live-transcription-subtitle__frame` and `.live-transcription-subtitle__content`.
  - In "pin to bottom" mode it is portalled into `#wc-caption-pin-slot`.
  - In overlay mode it is wrapped in `.live-transcription-subtitle__overlay-container`.
- One line per message, built by component `cq`:
  ```
  <div id="live-transcription-subtitle">           ← duplicate ids, one per line
    [avatar: Xr({displayName, avatarUrl, className:"zmu-data-selector-item__icon", attr:{"aria-hidden":true}})]
    <span class="live-transcription-subtitle__item | live-transcription-subtitle__yellowitem">TEXT</span>
  </div>
  ```
  - The avatar is rendered only when the message has a user *and* `bAllowedAvatar` is true.
  - `Xr` renders a `<div>` containing the **initials** (computed from `displayName`) on a colour derived from the name when the user has the default avatar. Otherwise it renders `<img alt="" src=photo>`. The full name is not put in the DOM.
  - A line hides itself (`display:none`) 10 s after its text stops changing.
  - `__yellowitem` is used when the line is a translation.
- Legacy overlay (`newLTFeatureEnabled` false): `<div class="live-transcription-subtitle__box"><div id="live-transcription-subtitle" class="live-transcription-subtitle__item">TEXT</div></div>`. It holds text only.
- Full-transcript panel rows (`iIe`):
  ```
  <div class="lt-full-transcript__item easy-nav-list">
    [only when speaker changes:] <div class="lt-full-transcript__title(--first)">
        <avatar class="lt-full-transcript__avatar"/> <span class="lt-full-transcript__display-name"><b>NAME[ (captioner)]</b></span></div>
    <div><div class="lt-full-transcript__time">TIME</div><div class="lt-full-transcript__message">TEXT</div></div>
  </div>
  ```
  - The rows sit inside `.new-lt-list-container`, rendered by `react-virtualized` `AutoSizer`, `List` and `CellMeasurer`.
  - The list auto-scrolls to the newest row only when the user is within 3 rows of the bottom.
  - The name is shown when `userId` (or caption type) differs from the previous row.
  - Search box: `.lt-full-transcript-search-box__input`.
- Panel visibility: the menu item is shown only when `z.meetingOptions?.isEnableViewFullTranscript` is set, a server-provided meeting option. Zoom's public test meeting did not set it (served `config.meetingOptions`).

Implications:

- Speaker-attributed captions need the transcript panel. That depends on host or admin settings, and the scraper must:
  - keep the panel open;
  - carry the last seen name forward to unnamed rows;
  - handle rows that drop out of the DOM.
- Initials in the overlay could only ever match against a roster. That is ambiguous and not worth building on.
- Duplicate `id="live-transcription-subtitle"` values mean selectors must use classes, not `#id`.

### Other discoverable selectors (UNVERIFIED-unstable)

All from the served CSS `styles.wc_meeting.min.css` and JS:

- Layout: `#wc-container`, `#wc-header`, `#wc-content`, `#wc-container-left`, `#wc-container-right`, `#wc-footer`, `#wc-video-caption-split`.
- Leave button: `.footer__leave-btn-container`.
- Topic: `.head-meeting-topic`. `document.title` is set to the meeting topic, prefixed "(Locked) " when the meeting is locked (JS).
- Screen-reader live region: `#aria-notify-area`. Its `innerHTML` is replaced on announcements (JS).

---

## 3. Active speaker

### How the web client shows it

**Documented layouts in the Web App** ([KB0063672]):

- Speaker, Gallery and Multi-speaker.
- Speaker view "will switch the large video window between who is speaking with 3 or more participants".
- In Gallery, "that active speaker is relocated to the current page you are viewing and is highlighted … not possible when using a custom gallery order".

**What the served client renders** (JS, `main-client`):

- **Tile highlight classes:**
  - `gallery-video-container__video-frame--active`: when the tile's `userId` is the active speaker *and* more than 2 tiles are shown.
  - `speaker-active-container__video-frame--active`: when 2 or more tiles are shown.
  - `speaker-bar-container__video-frame--active`, `suspension-video-container__video-frame--active`, and `multi-speaker-*__video-frame--active`: multi-speaker.
  - Tiles are absolutely positioned `<div>`s over a shared video canvas. Each holds the name in `.video-avatar__avatar-footer`, which also carries the pronoun or audio-status text. When video is off, the name is also in `.video-avatar__avatar-name`, or as the `alt` of `.video-avatar__avatar-img`.
- **"Talking:" label:** `<span class="right asntip"><span>Talking: NAMES</span></span>`, plus a variant in the floating (suspension) view.
  - `NAMES` is `audio.asnIds.asnUser`, built from up to three server-sent IDs (`asn1`–`asn3`) and joined with `", "`.
  - A name is only added when that user is **not in the currently rendered tiles** (with special cases for content-only webinars and hidden self-view).
  - The label is suppressed in `speak-view`, `standard` (share) and `side-by-side-speaker-view` layouts and in the floating view.
  - Per-user `hasAsn` flags are cleared 3 s after the last notification (`H7=3e3`) (JS, `loginview`).
- **Participants panel:** speaking icons `participants-icon__voip-speaking-icon` and `participants-icon__phone-speaking-icon` exist (JS). The condition that renders them is **UNVERIFIED** (U9).

### Limitations

- **Two participants:** gallery adds no `--active` class with 2 or fewer tiles. Speaker view with only 2 people shows your video small and the other person's below, with no switching ([KB0063672], JS). A 1:1 has no usable indicator for the remote person; the local user is the microphone.
- **Your own speech:** whether *you* appear as the active speaker on your own screen is a setting: "See myself as the active speaker while speaking" ([KB0059423]). Its default is **UNVERIFIED** (U10).
- **Screen share:** the default share layout is "Standard", with tiles in a strip ([KB0063672]). The "Talking:" label is suppressed there; only the speaker-bar `--active` class (more than 2 tiles) remains (JS).
- **Gallery pagination:** documented as relocating the active speaker to the current page, except with a custom order ([KB0063672]). With "Follow host's video order", **UNVERIFIED** (U9).
- **Hide non-video participants** ("Hide participants' thumbnails if they don't have video enabled", [KB0059423]; also from View → Hide Non-video Participants, [KB0063672]):
  - Camera-off speakers have no tile.
  - They can only appear through the "Talking:" label, and only in gallery-type layouts.
- **Muted users:** the speaker IDs come from the server's audio pipeline (`asn1..3`, JS). That a muted user is never reported is an inference, **UNVERIFIED** (U9).
- **Simultaneous speakers:** up to 3 are reported (`asn1`–`asn3`); the tile highlight tracks one `activeSpeakerId` (JS). Speech that overlaps is attributed to one speaker or dropped.
- **Granularity:** the indicator turns over on a 3 s timer (JS), much coarser than caption segments. A Speaker Track built from it will have coarse turn edges.

---

## 4. Meeting lifecycle

| State | What docs say | What the client shows (JS, UNVERIFIED-unstable) |
|---|---|---|
| Launcher | Invite link prompts to open the app or "Join from your browser"; host must allow the link (default on); hidden when the host uses E2EE ([KB0060732], [KB0067293]) | `zoom.us/j/<id>` "Launch Meeting - Zoom" page (observed) |
| Guest gating | Invisible CAPTCHA for guests rolling out from 22 Jul 2026 ([KB0067293]); "Only authenticated users can join from web client" setting ([KB0084679]) | `isShowInvisibleCaptcha` in served config |
| Preview | "Check your audio and video settings, then click Join" ([KB0060732]) | `.preview-root` |
| Host not started | "The meeting is waiting for the host to join" ([KB0060501]) | strings "Waiting for the host to start the meeting." / "Please wait for the host to start this webinar" |
| Waiting room | Host admits one by one or all; can send people back; host disconnect can move everyone to the waiting room; customizable title, logo and video ([KB0059359], [KB0063329]) | `.waiting-room-container` > `.wr-information` / `.wr-topic` / `.wr-tip`; on-hold variant `.on-hold-main`; `.loading-layer--new-waiting-room-join` |
| In meeting | Toolbar at the bottom with Audio, Video, Participants, Chat, Share, More ([KB0064261]) | `#wc-footer`, `.footer__leave-btn-container`, `#wc-content` |
| Breakout join | Web app: Join from the pop-up, or later via Breakout Rooms ([KB0060313]) | "meeting reset" labelled "join breakout room"; `.loading-layer--bo-room`; strings "Joining Breakout Rooms...", "You are now in a Breakout Room" |
| Breakout close | Host closes all rooms with a 60 s countdown, or auto-move ([KB0062540], [KB0060313]) | "All Breakout Rooms will close in {0} seconds." |
| Reconnect | — | `.dialog-reconnect-container` (Retry / Leave); "meeting failover" uses the same reset path as breakouts |
| Host ends | Participants are told; recording-consent and other dialogs exist | strings "This meeting has been ended by host", "The meeting has been ended", "This meeting has been ended by your admin" |
| Socket gone | — | `#wc-leave` full-screen overlay "Meeting Disconnected" when the command socket is closed (not on preview) |
| Leave / after | — | `history.replaceState` → `/wc/leave?meetingNumber=…&feedback=false`, feedback UI, later navigation to `/wc/leave?…&feedback=true`; post-attendee URL or My Notes page ([decoded launch payload]) |
| PWA side | — | the iframe posts IPC events to the shell: `JOINING`, `SUCCESS`, `PRE_END`, `END`, `LEAVE`, `CLOSED`, `END_BY_HOST`, `REMOVED_BY_HOST`, `BO_WILL_CLOSE`, `RETURN_MAIN_SESSION` (PWA JS), using `{type, message:{sender:"wc", event, data}}` |

**Breakouts.** No navigation or reload was found in the breakout code. A breakout join is a store-level "meeting reset" with a loading layer (JS). It is documented as isolated audio and video ([KB0060313]), and cloud recording "will only record the main meeting" ([KB0062540]).

- The 2026-10-06 live tests confirmed that the caption root is removed and recreated on room entry and return. An adapter must find the new root and attach its observer again.
- One recorder captured remote speech before room entry, inside Room 1 and after return. The test did not supply continuous speech during the transitions, so it does not prove gap-free audio. Caption observer recovery remains **UNVERIFIED** (U7).

**Signals an adapter could use:**

- *In meeting:* path rule (§1), plus `.footer__leave-btn-container` inside `#wc-footer`, plus no `.preview-root`, `.waiting-room-container` or `#wc-leave`.
- *Ended:* any of:
  - pathname starting `/wc/leave`;
  - `#wc-leave` present;
  - the leave button gone for longer than the grace period. The existing `LEAVE_GRACE_MS` pattern applies, because breakout and reset loading layers temporarily replace the UI.

  Do not key on the ended-dialog *text*; it is localized (`langResource`).
- *Optional:* in iframe mode, a top-frame content script could listen for the iframe's `message` events (`event: "END" | "LEAVE" | …`). Chrome documents content scripts receiving `window.postMessage` events ([chrome-cs]). This is internal IPC and the most fragile option.

---

## 5. Audio

**Joining audio.**

- The web app has "Join computer audio" ([KB0065520]). Before entering you can test, then "In the meeting controls toolbar, click Join audio" ([KB0062765]).
- Auto-join by computer audio is a setting ([KB0060983]; Web App: [KB0065520] "Automatically join meeting by computer or device audio").
- Audio types are admin-configurable: Telephone and Computer, Computer only, or 3rd party ([KB0061105]).
- Consequence: until the user joins computer audio, the tab likely plays no meeting audio. If they join by phone, the tab carries no meeting audio at all. **UNVERIFIED** in a live tab (U12), and worth a warning in the UI.

**Is the local voice echoed into tab output?**

- Nothing in the docs says it is, and the client mixes no local mic into playback that I found. The repo's assumption (ADR-0007) stands, **UNVERIFIED** (U12).
- Two documented exceptions play local or test audio through the tab: **Test Mic** ("record audio and play it back") and **Test Speaker** ("play a test tone") ([KB0059423]). A capture started during setup would record them.

**`chrome.tabCapture` on a Zoom tab.**

- The captured tab's audio "will no longer be played to the user", so you must reconnect it to an `AudioContext` destination ([chrome-tabcapture]). This matches ADR-0004.
- Capture can start only after the user invokes the extension, on the active tab ([chrome-tabcapture]).
- "Capture is maintained across page navigations within the tab" and stops when the tab closes ([chrome-tabcapture]). Neither the `/wc/leave` URL swap nor a breakout reset should stop it.
- The stream ID from `getMediaStreamId` "can only be used once and expires after a few seconds" ([chrome-tabcapture]). It can be used in an offscreen document from Chrome 116 ([chrome-capture-howto]).
- I found no Chrome documentation of issues specific to Zoom or COOP/COEP-isolated tabs. The 2026-10-06 research harness captured remote speech from the joined `app.zoom.us` meeting inside `iframe#webclient`. Pre-Join-Audio capture and local echo remain **UNVERIFIED** (U12); this result does not establish behavior for every isolation policy.

**A second microphone stream from the offscreen document while Zoom holds the mic.**

- An offscreen document with reason `USER_MEDIA` is for `getUserMedia()` streams. It "can't be focused", has no lifetime limit (unlike `AUDIO_PLAYBACK`'s 30 s rule), and only one can be open at a time ([chrome-offscreen]).
- The Media Capture spec allows a lock to fail access: "If a hardware error such as an OS/program/webpage lock prevents access … reject p with … NotReadableError" ([w3c-mediacapture], CRD 9 Oct 2025). On macOS, the 2026-10-06 harness held live tab and offscreen microphone tracks while Zoom used computer audio, after microphone permission was granted in a visible extension page. No `NotReadableError` occurred. The attempted local speech produced near-silent audio and no caption, so useful local voice capture remains **UNVERIFIED** (U13), as do Windows and Linux behavior.
- **`audioCapture`:**
  - Chromium's `extensions/common/api/_permission_features.json` grants `audioCapture` to `platform_app`. For `extension` it is allowlisted to specific IDs only (crbug 292856, 409192, 496954, 431978) ([chromium-perm]).
  - The extensions permission list does not include it ([chrome-perms]).
  - If that holds for this build, then for a store-installed extension:
    - the manifest entry is ignored, with a warning;
    - microphone access in the offscreen document depends on the extension origin already having mic permission;
    - the mechanism ADR-0007 describes ("`audioCapture` grants the microphone … without prompting") would be wrong.

  This is outside Zoom scope but on the same audio path; verification is U14.
  In the 2026-10-06 harness, `permissions.getAll()` did not return `audioCapture`.
  A visible extension page changed microphone permission from `prompt` to `granted`;
  the later offscreen microphone start succeeded. Fresh-profile behavior in the
  complete product remains part of issue #49.

---

## 6. Policy (factual)

**Zoom Terms of Service** (effective 11 Aug 2023, [zoom-tos]):

- §7 Recordings: "You are responsible for compliance with all Laws governing the monitoring or recording of conversations as the Host or Phone Host … You will receive a notification (visual or otherwise) when recording is enabled. If you do not consent to being recorded, you can choose to leave the recorded session."
  - The notification refers to Zoom's own recording. This extension's recording raises no Zoom notification.
- §8 Prohibited uses include:
  - "(ii) … reverse engineer, or attempt to gain access to any underlying technology of the Services or Software";
  - "(ix) upload or transmit any software … or code that … is intended to harm or extract information or data from other hardware, software, networks, or other users";
  - "(xi) use the Services … in a manner that violates applicable Law, including … any other Laws requiring the consent of subjects of audio and video recordings".
- §9: users are "solely responsible for … compliance with all Laws … including Laws requiring you to provide proper End User notifications and to obtain proper End User consents".
- §10.1: transcripts and recordings generated in connection with the Services are "Customer Content".
- The ToS defines "Zoom Web-based Application" as the web client for joining "in a web browser without downloading any plugins or software".
- I found no clause that names browser extensions, DOM scraping or caption scraping. Whether §8(ii) or (ix) covers this product is a legal question, not answered here.

**Zoom's own recording-consent model** (what participants expect):

- When recording starts, or on joining a recorded meeting, participants are asked to consent, or can Leave ([KB0059819]). This applies to the desktop app, mobile app, web client, Zoom Rooms and VDI ([KB0068228]).
- Accounts with fewer than 100 licenses cannot disable or customize the disclaimer. Accounts with 100+ can disable it for internal users only; "required for all guest participants" ([KB0068228], [KB0068402]).
- Phone users always hear a voice prompt ([KB0068228]).
- Participants need **host permission** to make a computer (local) recording; admins configure who may request it and whether it is auto-approved ([KB0063640]). The web client "does not support local recording" ([KB0060313]).
- Apps with real-time access to meeting content show an **Active Apps Notifier** icon to everyone ([KB0062987]).
- The **"Allow users to hide feature disclaimers"** setting covers prompts for recording, Zoom AI, livestreaming and captions ([KB0077405]). Captions are therefore one of the features Zoom treats as needing a disclaimer prompt.
- Transcripts carry an optional "Custom disclaimer for transcripts … when transcripts are enabled" ([KB0085675]).

**Relevance and #48 decision.** The extension does not notify other participants or trigger Zoom's built-in recording notices when it captures tab audio or page captions. ADR-0007's disclosure covers the local user's microphone. The chosen scope for #48 is [README guidance only](../../README.md#participant-notice-and-consent): users must notify participants and obtain any required consent before audio or caption capture. No additional notice UI is part of this decision.

---

## Real-meeting results, 2026-10-03 (#37, first session)

These come from one 2-person meeting on `app.zoom.us` in iframe mode: the host plus one browser participant, in speaker view, with captions on. Trimmed fixtures are in `tests/fixtures/zoom-in-meeting.html` and `tests/fixtures/zoom-host-ended.html`.

- **U4, confirmed:**
  - An overlay line is an `aria-hidden` `.zmu-data-selector-item__icon` showing the speaker's *initial* ("T"), then `span.live-transcription-subtitle__item` with the text.
  - There is no name anywhere in the overlay.
  - The new overlay (`__box--overlay`) is what current builds render.
- **U1, partly settled:**
  - During the meeting, the top frame's URL was `/wc/<id>/join?ref_from=launch&pwd=…`, with no `fromPWA=1`. The iframe's URL was the same path without `pwd`.
  - After the host ended the meeting, `tabs.onUpdated` reported the top frame going to `/wc/home?ref_from=launch`, then `/wc/?ref_from=launch`, both with `status: loading`.
  - So in iframe mode the end ended at the Web App home, not at `/wc/leave`.
  - Still open:
    - leaving as a participant, rather than the host ending;
    - the `zoom.us/j` entry point;
    - whether `/wc/leave` appears in tab mode.
- **U8, partly settled:**
  - Confirmed in the DOM: `#wc-footer`, and `.footer__leave-btn-container` with `button[aria-label="Leave"]`. The `aria-label` is presumably localized.
  - **The ended-by-host dialog is a generic `.zm-modal`.** Its only distinguishing content is the localized text "This meeting has been ended by host".
  - **The leave button stays in the DOM while that dialog shows.** It showed for at least 20 s, until the top frame navigated. "Leave button present" therefore still reads as in the meeting at this point. End detection has to rely on the top frame's navigation away from the meeting path (#39), or on an open `.zm-modal` combined with something not localized.
  - `.head-meeting-topic` was absent. `document.title` *is* the topic ("<host>'s Personal Meeting Room").
  - `.preview-root`, `.waiting-room-container`, `#wc-leave` and `.dialog-reconnect-container` were not seen, because those states were not captured.
- **U9, one data point:**
  - With 2 participants in speaker view, neither tile carried a `--active` class, and no `.asntip` label was present. This fits "a 1:1 call has no usable indicator".
  - Tile names were confirmed in `.video-avatar__avatar-footer > span`, and in `img.video-avatar__avatar-img[alt]` when the person has a photo.
- **Not captured in this session:**
  - the full-transcript panel: no `lt-full-transcript` markup in any capture, so U5 and U6 are open;
  - breakout rooms: the "breakout" captures only show the toolbar auto-hiding (`footer__hidden`, `meeting-header__hidden`), so U7 is open;
  - the pre-join preview, the waiting room, and 3 or more participants.

## Real-meeting results, 2026-10-06 (#37, second session)

The host used the signed-in external Chrome app. The user had prepared Participant A/B/C
in Chrome, Firefox and Safari. Two temporary Chrome participants, D and E, supplied
synthetic speech through browser microphone inputs. After the meeting was recreated,
Participant A supplied another controlled speech clip. Zoom produced the captured
captions; the test did not insert caption text into the page. The tested meeting used
`iframe#webclient` and assets from `web_client/7.1.0.3.12693`.

- **U4, further evidence:** D and E each produced caption text with an `aria-hidden`
  initials icon (`PD` or `PE`), without a separate full speaker name in the overlay.
  A later overlay retained one row from each speaker. Both rows used
  `id="live-transcription-subtitle"`. The adapter must read all matching rows, not assume
  that this ID is unique. Later captures contain Participant A's initials (`PA`) and
  caption text in a retained row with `style="display: none;"`. These establish three
  speaking test participants across sessions. Three speakers retained together in
  one overlay, and a speaking profile photo, remain untested.
- **U9, further evidence:** `.speaker-bar-container__video-frame--active` identified
  D and E in separate speaker-view captures. A six-person gallery showed
  `.gallery-video-container__video-frame--active` on D. Names were present in tile
  footers. The overlay still held E's earlier text while D was active, so the current
  active tile must not be used to assign every retained caption row to one speaker.
  In a later four-person gallery, F's active class remained while all four people
  were muted. The participant panel exposed muted/video-off accessible labels and
  `audio-muted` SVG classes. It uses React Virtualized and must not be treated as a
  complete roster in larger meetings. Hide Non-Video left all four tiles visible
  when all cameras were off; its menu changed to Show Non-Video Participants. Six
  gallery-sort choices were captured. Share layout, mixed-camera hiding, actual
  muted speech and participant-panel speaking icons remain open.
- **U7, DOM round trip confirmed:** the top document, meeting iframe, meeting document
  and URLs stayed the same through breakout entry and automatic return. The caption
  root was removed and recreated. Its observed object identity changed from 4 in the
  main session to 5 in the breakout room and 6 after return. These numbers are capture
  identifiers, not DOM IDs. Captions needed to be shown again after both transitions;
  breakout entry also required the displayed English-language prompt to be saved.
  Captures include `Joining Room 1...`, `Returning to Main Session...`, and the room
  closing dialog with 50 seconds remaining. A later independent sampler recorded
  125 changed states during one audio recording. Its caption root identities were
  4, 9 and 13; these are a separate identity sequence from the first capture.
  The top document, iframe, meeting document and URL stayed the same. Remote speech
  was present before entry, inside Room 1 and after return. Join Audio and Show
  Captions needed to be used again after room changes. Audio during the transitions
  and caption observer recovery remain unverified.
- **U5/U6, blocked by the tested account:** the inspected caption and More menus did
  not expose View Full Transcript, and no full-transcript root was captured.
  Account settings showed Meeting transcript disabled and locked by the
  administrator. The precise mapping to the client flag `isEnableViewFullTranscript`
  is unverified. No account setting was changed.
- **U11, shared language confirmed:** with translation off, Participant B selected
  French. The confirmation said that captions would appear in that language for
  everyone. The host stayed on English before Save; both host and participant
  showed French after Save. English was then restored. Recognition accuracy and
  independent translated captions remain untested.
- **U8, timeout captured:** host and participant later displayed “Joining Meeting
  Timeout or Browser restriction”, with Report Problem, Retry and Leave controls.
  The cause and Retry behaviour are unverified. The user then created a new meeting;
  the host and Participant A were observed there. This is not evidence of recovery
  of the earlier meeting.

Nineteen trimmed fixtures, source timestamps, the transition sequences, audio measurements
and remaining tests are listed in the [session evidence report](zoom-capture/results-2026-10-06.md).
The temporary D/E sessions were closed. A further automated anonymous join was
refused by Zoom and was closed without bypassing the restriction. The recorder
research harness captured remote speech in signed-in Chrome and held a live microphone
track after a visible permission grant. These results do not verify useful local voice
capture, caption observer recovery or the complete extension flow.
Issue #37 remains open.

## Verification checklist and remaining tests

The table records the original questions. The two session reports above partly settle
U1, U4, U7, U8, U9, U11, U12, U13 and U14; they do not complete the whole checklist. For each remaining
state, save `document.documentElement.outerHTML` from both frames and each
`location.href` privately, then produce a trimmed fixture. Use the participant count,
account features and browser state required by that row.

| # | Claim | What settles it |
|---|---|---|
| U1 | Path rule (§1); top-frame URL during an iframe-mode meeting is `/wc/<id>/join?fromPWA=1`; Chrome reports the `/wc/leave` `replaceState` through `tabs.onUpdated` | Log `tabs.onUpdated` and the top and frame URLs through join → preview → meeting → leave → feedback, for `zoom.us/j` → browser join and for `app.zoom.us/wc` Home → Join |
| U2 | Vanity-host meetings stay top-level on `<vanity>.zoom.us/wc/...` | Join a meeting owned by a vanity account from its own link |
| U3 | ZoomGov hosts and paths (`zoomgov.com`, `app.zoomgov.com`?) | One capture from a ZoomGov meeting |
| U4 | Overlay speaker data, retained rows and repeated IDs; legacy vs new overlay | D, E and A are captured across sessions; A's retained rows are hidden. Add three speakers in one retained overlay and a speaking profile photo; check name data outside spoken caption text. |
| U5 | View full transcript and Request transcription work in the Web App; which admin setting maps to `isEnableViewFullTranscript` | Blocked on the tested account: Meeting transcript is disabled and locked by the administrator. Use an account where it is permitted, then check the participant menu and panel. |
| U6 | Full-transcript panel row markup, name-on-change rule, virtualization and auto-scroll behaviour while hidden or scrolled | Requires the U5 account capability. Capture panel DOM during a 10-minute, multi-speaker stretch; scroll up and back. |
| U7 | Breakout join and return re-render in place; caption elements, frame and URL survive or are replaced; tab capture continues | One recording contains remote speech before, inside and after a room round trip. Caption roots are replaced. Test continuous speech during transitions and caption observer recovery. |
| U8 | Selectors: `#wc-footer`, `.footer__leave-btn-container`, `.preview-root`, `.waiting-room-container`, `#wc-leave`, `.dialog-reconnect-container`, `.head-meeting-topic` | Capture each remaining lifecycle state in §4. A join-timeout/browser-restriction dialog is captured, but its cause and recovery are unverified. |
| U9 | `--active` tile classes, the "Talking:" label conditions, participants-panel speaking icons, behaviour of muted users, follow-host order | Speaker-view and six-person-gallery active classes, four muted panel rows, all-video-off Hide Non-Video and six sort choices are captured. Complete share layout, other counts, actual muted speech, mixed-camera hiding and speaking indicators. |
| U10 | Default of "See myself as the active speaker while speaking" in the Web App | Web App Settings → Video on a fresh profile |
| U11 | Caption language / "speaking language" set by a participant affects accuracy for all | With translation off, B's saved French setting propagated to the host; English was restored. Test recognition accuracy after a mismatch and independent translated captions if available. |
| U12 | Tab output carries remote audio only after Join Audio; no local echo; iframe audio is captured; COOP/COEP tab is capturable | Joined iframe remote audio is confirmed with the existing recorder in the harness. Test pre-Join-Audio behavior, confirmed local speech and echo. |
| U13 | A concurrent offscreen `getUserMedia` mic works while Zoom holds the mic (macOS, Windows, Linux) | Mac tab and mic tracks were live after a visible permission grant, without `NotReadableError`. Useful local speech and Windows/Linux behavior remain unverified. |
| U14 | `audioCapture` is ignored for this extension ID, and how the offscreen mic is actually granted today | The harness did not list `audioCapture` in granted permissions. Visible-page permission changed from prompt to granted and enabled a later mic start. Test fresh-profile product behavior under #49. |

---

## Sources

Zoom support (each article fetched 2026-10-02; title from its `TechArticle` metadata):

- [KB0058810]: Enabling or disabling automated captions. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0058810
- [KB0059762]: Viewing captions in a meeting or webinar. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059762
- [KB0062813]: Managing automated captions as the host of a meeting or webinar. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062813
- [KB0063899]: Saving closed captions in a meeting. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063899
- [KB0085668]: FAQ about meeting captions and transcript updates (May 2026). https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0085668
- [KB0085675]: Enabling or disabling meeting transcripts. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0085675
- [KB0085682]: Using Meeting transcripts. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0085682
- [KB0064261]: Getting started with the Zoom Web App. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064261
- [KB0059744]: Using the Zoom Web App on Chromebook and web browser. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059744
- [KB0065520]: Comparing Zoom Meetings and Webinars features by platform. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065520
- [KB0059423]: Changing settings in the Zoom Web App. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059423
- [KB0060732]: Joining a Zoom meeting. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060732
- [KB0067293]: Enabling or disabling the Join from your browser link setting. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067293
- [KB0084679]: Only authenticated users can join from web client. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0084679
- [KB0061540]: Guidelines for Vanity URL requests. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061540
- [KB0063672]: Adjusting your video layout during a virtual meeting. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063672
- [KB0060313]: Participating in meeting breakout rooms. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060313
- [KB0062540]: Managing meeting breakout rooms. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062540
- [KB0059359]: Enabling and customizing the waiting room. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059359
- [KB0063329]: Using waiting room during a meeting. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063329
- [KB0060501]: Allowing participants to join before host. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060501
- [KB0060983]: Automatically joining meetings with computer audio. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060983
- [KB0061105]: Configuring audio types for joining a meeting. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061105
- [KB0062765]: Testing your audio settings for Zoom meetings. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062765
- [KB0059819]: Providing consent to be recorded. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059819
- [KB0068228]: Modifying recording notification prompts. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0068228
- [KB0068402]: Customizing the recording consent disclaimer. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0068402
- [KB0063640]: Enabling or disabling computer recording. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063640
- [KB0062987]: Active App Notifier Report. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062987
- [KB0077405]: Allowing or preventing users from hiding feature disclaimers in meetings. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0077405

Zoom legal:

- [zoom-tos]: Zoom Terms of Service (effective 11 Aug 2023). https://www.zoom.com/en/trust/terms/

Served Zoom web client (fetched 2026-10-02):

- Launcher `https://zoom.us/j/<id>`: its inline `window.launchBase64` payload contains the `/wc/join/<id>`, `app.zoom.us/wc?mn=` and `/postattendee` URLs.
- PWA shell `https://app.zoom.us/wc/join/<id>`: inline `config` (`enableMeetingRoute`, `crossIsolationMode`) and `https://st1.zoom.us/web_client_pwa/7.2.0.3239/js/main.js` ("PWA JS").
- Meeting page `https://app.zoom.us/wc/<id>/join?webclientOpenMode=tab`, titled "Zoom meeting on web": inline config and `wc_loaded` script, and `https://st1.zoom.us/web_client/7.2.0.1.12783/js/webclient.es.min.js` with its chunks:
  - `…/js/chunks/main-client.min.js`
  - `…/js/chunks/loginview.min.js`
  - `…/js/chunks/run-feedback.min.js`
  - `…/js/chunks/configureStore.min.js`
  - `…/js/chunks/i18n-core.min.js`
- CSS: `https://st1.zoom.us/web_client/7.2.0.1.12783/css/styles.wc_meeting.min.css`.

Chrome, Chromium, W3C:

- [chrome-tabcapture]: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- [chrome-capture-howto]: https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
- [chrome-offscreen]: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- [chrome-cs]: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- [chrome-perms]: https://developer.chrome.com/docs/extensions/reference/permissions-list
- [chromium-perm]: https://chromium.googlesource.com/chromium/src/+/main/extensions/common/api/_permission_features.json
- [w3c-mediacapture]: https://www.w3.org/TR/mediacapture-streams/ (Candidate Recommendation Draft, 9 Oct 2025)

[KB0058810]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0058810
[KB0059762]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059762
[KB0062813]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062813
[KB0063899]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063899
[KB0085668]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0085668
[KB0085675]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0085675
[KB0085682]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0085682
[KB0064261]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064261
[KB0059744]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059744
[KB0065520]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065520
[KB0059423]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059423
[KB0060732]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060732
[KB0067293]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067293
[KB0084679]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0084679
[KB0061540]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061540
[KB0063672]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063672
[KB0060313]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060313
[KB0062540]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062540
[KB0059359]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059359
[KB0063329]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063329
[KB0060501]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060501
[KB0060983]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060983
[KB0061105]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061105
[KB0062765]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062765
[KB0059819]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059819
[KB0068228]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0068228
[KB0068402]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0068402
[KB0063640]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063640
[KB0062987]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062987
[KB0077405]: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0077405
[zoom-tos]: https://www.zoom.com/en/trust/terms/
[chrome-tabcapture]: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
[chrome-capture-howto]: https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
[chrome-offscreen]: https://developer.chrome.com/docs/extensions/reference/api/offscreen
[chrome-cs]: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
[chrome-perms]: https://developer.chrome.com/docs/extensions/reference/permissions-list
[chromium-perm]: https://chromium.googlesource.com/chromium/src/+/main/extensions/common/api/_permission_features.json
[w3c-mediacapture]: https://www.w3.org/TR/mediacapture-streams/
