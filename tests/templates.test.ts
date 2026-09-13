import { describe, expect, it } from "vitest";
import { summarizeTranscript } from "../src/pipeline/pipeline";
import { DEFAULT_TEMPLATES } from "../src/pipeline/templates";
import { fakeClient, transcript } from "./helpers";

describe("summary shapes and Prompt Templates", () => {
  it("the narrative shape selects the narrative template", async () => {
    const client = fakeClient();
    await summarizeTranscript(
      transcript(),
      { shape: "narrative", templates: DEFAULT_TEMPLATES },
      client,
    );
    const prompt = client.prompts[0]!;
    expect(prompt).toContain("narrative recap");
    expect(prompt).not.toContain("## Action items");
    expect(prompt).toContain("Alice: We should ship the beta next Friday.");
  });

  it("a user-customized template is exactly what reaches the Provider", async () => {
    const client = fakeClient();
    const custom = "Summarize in pirate speak. ALWAYS ANSWER IN ENGLISH.\n\n{{transcript}}";
    await summarizeTranscript(
      transcript(),
      { shape: "structured", templates: { ...DEFAULT_TEMPLATES, structured: custom } },
      client,
    );
    const prompt = client.prompts[0]!;
    expect(prompt.startsWith("Summarize in pirate speak. ALWAYS ANSWER IN ENGLISH.")).toBe(true);
    expect(prompt).not.toContain("same language as the transcript");
    expect(prompt).toContain("Bob: Agreed.");
  });

  it("a custom template missing the placeholder still receives the transcript", async () => {
    const client = fakeClient();
    await summarizeTranscript(
      transcript(),
      { shape: "structured", templates: { ...DEFAULT_TEMPLATES, structured: "Just summarize." } },
      client,
    );
    expect(client.prompts[0]).toContain("Alice: We should ship the beta next Friday.");
  });

  it("both default templates instruct transcript-language matching", () => {
    expect(DEFAULT_TEMPLATES.structured).toContain("same language as the transcript");
    expect(DEFAULT_TEMPLATES.narrative).toContain("same language as the transcript");
  });
});
