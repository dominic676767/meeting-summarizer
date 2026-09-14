// Retry-to-success at the pipeline seam: the same Transcript that failed
// converges to a normal Summary Artifact once the Provider recovers (or the
// user switches Provider). The storage bookkeeping around it is glue.
import { describe, expect, it } from "vitest";
import { PipelineError, summarizeTranscript } from "../src/pipeline/pipeline";
import { DEFAULT_TEMPLATES } from "../src/pipeline/templates";
import { fakeClient, transcript } from "./helpers";

const settings = { shape: "structured" as const, templates: DEFAULT_TEMPLATES };

describe("Held Transcript retry", () => {
  it("a failed Transcript retried with a working Provider yields the artifact", async () => {
    const t = transcript();

    const broken = fakeClient({ failWith: new Error("provider outage") });
    await expect(summarizeTranscript(t, settings, broken)).rejects.toThrow(PipelineError);

    // Retry after switching Provider — same Transcript, unchanged.
    const recovered = fakeClient({ reply: () => "## TL;DR\nRecovered summary." });
    const { html } = await summarizeTranscript(t, settings, recovered);
    expect(html).toContain("Recovered summary.");
    expect(html).toContain("Open question: do we support Firefox ESR?");
  });

  it("the failure reason is carried on the PipelineError for the held entry", async () => {
    const broken = fakeClient({ failWith: new Error("HTTP 429 rate limited") });
    const err = await summarizeTranscript(transcript(), settings, broken).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect(String(err.message)).toContain("HTTP 429 rate limited");
  });
});

// --- The audio a Held Transcript still owns ----------------------------------
//
// A Held Transcript is released only once its Summary Artifact is written, and
// that same write discards the Meeting's audio. So the entry has to name every
// Capture Span: whatever it fails to name is what stays on the user's disk
// forever. ext.storage is faked (src/platform.ts resolves the namespace off
// globalThis) and the store imported after it exists.

const stored: Record<string, unknown> = {};
(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local: {
      get: (key: string) => Promise.resolve(key in stored ? { [key]: stored[key] } : {}),
      set: (patch: Record<string, unknown>) => {
        Object.assign(stored, patch);
        return Promise.resolve();
      },
    },
  },
};

const store = await import("../src/background/held");

describe("the audio a Held Transcript keeps alive", () => {
  it("names every Capture Span, so a Meeting that recorded three leaves no orphan", async () => {
    const spans = [
      { spanId: "7-1000.0", startOffsetMs: 0 },
      { spanId: "7-1000.300000", startOffsetMs: 300_000 },
      { spanId: "7-1000.900000", startOffsetMs: 900_000 },
    ];
    const entry = await store.holdTranscript(transcript(), "provider outage", {
      recordingId: "7-1000",
      spans,
    });
    expect((await store.getHeld(entry.id))?.spans).toEqual(spans);
  });

  it("reads an entry held before Capture Spans existed as the one file it is", async () => {
    // The old shape named its audio by the recording id alone. Left unread, the
    // artifact write that releases this entry would delete nothing.
    stored.held = {
      "rec-7-legacy": {
        id: "rec-7-legacy",
        transcript: transcript(),
        reason: "provider outage",
        failedAt: 1,
        recordingId: "7-legacy",
      },
    };
    expect((await store.getHeld("rec-7-legacy"))?.spans).toEqual([
      { spanId: "7-legacy", startOffsetMs: 0 },
    ]);
  });

  it("names no file for a Meeting that has no Audio Recording", async () => {
    const entry = await store.holdTranscript(transcript(), "provider outage");
    expect((await store.getHeld(entry.id))?.recordingId).toBeUndefined();
    expect((await store.getHeld(entry.id))?.spans).toBeUndefined();
  });
});
