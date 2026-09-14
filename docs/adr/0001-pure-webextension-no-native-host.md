# Pure WebExtension, no native host

**Status: accepted; browser target amended by ADR-0003 (Firefox → Chromium).** The core decision — no native host — still holds. ADR-0003 is what preserves it: Chromium's `tabCapture` gives accurate meeting audio in-extension, which on Firefox would have required exactly the companion binary rejected here.

The extension must be lightweight — no companion process, no extra install step, no burden on browser memory. So it is a pure JS/TS WebExtension: no Rust native-messaging host, no backend. That choice caps its capabilities, and the caps are deliberate:

- **No email delivery.** Extensions can't speak SMTP; email was dropped from v1 rather than adding a service dependency. The Summary Artifact (local HTML) is the sole deliverable.
- **Saves land under `Downloads/meeting-summaries/` only.** The downloads API is the only file-write path available; arbitrary directories are impossible without a native host.
- **Provider API keys live in `browser.storage.local`.** There is no more secure store without a native host.

## Considered Options

- **Rust native-messaging companion app** — would have enabled SMTP email, arbitrary save paths, and keys kept out of the browser, at the cost of a second binary to install, keep running, and update. Rejected for weight.
- **Rust→WASM inside the extension** — still needs the JS glue and lifts none of the sandbox restrictions. Rejected as complexity without payoff.
