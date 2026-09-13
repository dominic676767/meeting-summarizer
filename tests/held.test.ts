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
