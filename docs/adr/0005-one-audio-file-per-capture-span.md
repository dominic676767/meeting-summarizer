# One audio file per Capture Span

A Meeting can be recorded in several stretches: the v2 user story includes keeping a sensitive part of a call off the record and resuming afterwards, and the popup has always offered Stop alongside Capture Start.

Until now every stretch of one Meeting was written to a single file keyed by the Meeting's recording id, and the writable was opened at byte zero. The second Capture Start therefore **truncated the first stretch and rewrote the file from the start**: only the last stretch survived, silently, with no warning and no way back. That violates the product principle that nothing unrecoverable is dropped silently, and it defeats the very story stopping capture exists for.

So each Capture Start now records its own **Capture Span**: its own file, keyed by the Meeting's recording id plus the span's offset from the Meeting start. At Meeting End every span is transcribed in order and their Utterances concatenated, each shifted by its own span's offset, so timings stay absolute relative to the Meeting — which is what fusion already assumes.

## Consequences

- **A Transcription Provider is handed a list of spans, not one blob.** The wrapper decodes each span, chunks it against the engine's input limit as before, and makes each engine span absolute with `span.startOffsetMs + window position`. An offset taken from the recording rather than from the span would drag every word of a later span back into an earlier span's turns and misattribute all of them.
- **Progress is measured against audio recorded, not Meeting time.** The gap was never recorded, so counting it as work still to do would stall the wait at a percentage that can never be reached. All spans are decoded before any is transcribed so the total is the Meeting's whole audio from the first tick; this costs no more memory than the single-file case, since the spans are the same audio minus what was kept off the record.
- **A Held Recording covers every span**, and its retry transcribes all of them. An entry held before spans existed is read as the single span it is, rather than stranded unretriable.
- **Cleanup deletes every span.** A Meeting that recorded three spans must leave no orphan on disk once its Summary Artifact is confirmed written.
- **The gap is not a fault and is never reported as one.** The user chose to stop recording; no silence is invented to fill it, and no warning is raised about it.
- Span ids are unique per Capture Start and sort by Capture Start, so a Meeting's files stay ordered and findable rather than anonymous.

## Considered Options

- **Append every span to one file with `createWritable({ keepExistingData: true })`** — rejected, and this is the trap worth recording: two Capture Starts mean two MediaRecorder sessions and therefore two WebM containers. A concatenation of them decodes only as far as the first container, so the fix would have traded silent truncation for silent corruption — the same data loss, harder to notice.
- **One MediaRecorder paused and resumed across the whole Meeting** — rejected: `MediaRecorder.pause()` keeps the captured tab stream live and the capture indicator up, so "off the record" would not actually be off the record. The user stopping capture must release the stream.
- **Re-encode the spans into one container at Meeting End** — rejected: it needs a full decode-and-mux pass over the whole meeting in the offscreen document to produce a file whose only consumer immediately decodes it again. Transcribing the spans in order costs nothing extra and keeps each span's offset explicit.
