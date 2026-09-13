# Live caption scraping, not platform APIs

Transcripts are built by content scripts scraping the live-caption DOM of each meeting platform's web client (Teams first, then Google Meet, then Zoom web) — not by fetching official transcripts from platform cloud APIs. Official transcripts sit behind OAuth flows and org-admin settings most users can't touch; caption scraping works for any user who can turn captions on, and yields speaker names for free.

## Consequences

- **Captions must be on** during the meeting, or nothing is captured — hence the warning badge in the popup when in a meeting with no segments arriving.
- **Per-platform DOM scrapers are brittle by design.** When a platform redesigns its caption markup, that Platform Adapter breaks and needs updating. This is the accepted maintenance cost, isolated behind the Platform Adapter boundary — don't "fix" it by reaching for the cloud APIs without revisiting this ADR.
