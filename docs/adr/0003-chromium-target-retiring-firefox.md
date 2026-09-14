# Chromium target, retiring the Firefox build

The product goal changed from "summarize whatever the captions say" to "summarize what was actually said". That requires capturing the meeting's audio, and **Firefox cannot do it**: `getDisplayMedia` audio capture is unsupported in every Firefox version on every platform, and `tabCapture` was never implemented there. The only audio a Firefox extension can reach is the local microphone — which excludes every remote participant.

So the extension migrates to Chromium (Chrome/Edge, Manifest V3) and the Firefox build is retired rather than maintained in parallel.

## Consequences

- **This is what saves ADR-0001.** Accurate audio on Firefox would have required a native-messaging companion to tap system audio. On Chromium the browser itself provides tab audio, so the extension stays pure and install-free.
- **Manifest V3 service worker, not a persistent background page.** No DOM in the service worker, so all recording moves into an offscreen document (ADR-0004). Session state must survive service-worker suspension.
- **Capture can no longer start automatically.** `tabCapture` requires an explicit extension invocation (activeTab-like), so the user must click to begin recording. Meeting *end* detection remains automatic.
- Firefox-specific work is dropped: MV2 manifest, `browser.*` namespace assumptions, the `browserAction`/`action` shim.

## Considered Options

- **Dual-target** (Chromium audio + Firefox captions-only) — rejected: doubles the capture surface and keeps alive the exact caption-scraping path this change exists to move past.
- **Native-messaging companion on Firefox** — rejected: reintroduces the install step ADR-0001 rules out, for a browser the user has no requirement to stay on.
