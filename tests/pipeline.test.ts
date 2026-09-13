import { describe, expect, it } from "vitest";
import { PipelineError, summarizeTranscript } from "../src/pipeline/pipeline";
import { DEFAULT_TEMPLATES } from "../src/pipeline/templates";
import { fakeClient, transcript } from "./helpers";

const settings = { shape: "structured" as const, templates: DEFAULT_TEMPLATES };

describe("summarization pipeline", () => {
  it("sends the serialized Transcript inside the structured template", async () => {
    const client = fakeClient();
    await summarizeTranscript(transcript(), settings, client);
    expect(client.prompts).toHaveLength(1);
    const prompt = client.prompts[0]!;
    expect(prompt).toContain("Alice: We should ship the beta next Friday.");
    expect(prompt).toContain("Bob: Agreed. I will own the release checklist.");
    expect(prompt).toContain("## Action items");
    expect(prompt).toContain("same language as the transcript");
    expect(prompt).not.toContain("{{transcript}}");
  });

  it("produces a self-contained artifact: summary + collapsible full transcript", async () => {
    const client = fakeClient({
      reply: () => "## TL;DR\nBeta ships Friday.\n\n## Decisions\n- Ship beta **Friday**",
    });
    const { html } = await summarizeTranscript(transcript(), settings, client);
    expect(html).toContain("<h2>TL;DR</h2>");
    expect(html).toContain("<p>Beta ships Friday.</p>");
    expect(html).toContain("<li>Ship beta <strong>Friday</strong></li>");
    expect(html).toContain("<details>");
    expect(html).toContain("Full transcript");
    expect(html).toContain("Open question: do we support Firefox ESR?");
    expect(html).not.toMatch(/src=|href=/); // no external assets
  });

  it("escapes HTML from transcript and summary content", async () => {
    const t = transcript({
      title: "<script>alert(1)</script>",
      segments: [{ speaker: "Mallory<b>", text: "use <img> tags", capturedAt: 0 }],
    });
    const client = fakeClient({ reply: () => "TL;DR: beware <script> tags" });
    const { html } = await summarizeTranscript(t, settings, client);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Mallory&lt;b&gt;");
  });

  it("wraps provider failure in PipelineError (the Held Transcript path)", async () => {
    const client = fakeClient({ failWith: new Error("HTTP 529 overloaded") });
    await expect(summarizeTranscript(transcript(), settings, client)).rejects.toThrow(
      PipelineError,
    );
    await expect(summarizeTranscript(transcript(), settings, client)).rejects.toThrow(
      /HTTP 529 overloaded/,
    );
  });

  it("rejects an empty Transcript", async () => {
    await expect(
      summarizeTranscript(transcript({ segments: [] }), settings, fakeClient()),
    ).rejects.toThrow(PipelineError);
  });
});
