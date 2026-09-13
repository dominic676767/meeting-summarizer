import { describe, expect, it } from "vitest";
import { chunkSegments } from "../src/pipeline/chunking";
import { summarizeTranscript } from "../src/pipeline/pipeline";
import { DEFAULT_TEMPLATES } from "../src/pipeline/templates";
import { fakeClient, seg, transcript } from "./helpers";

const settings = { shape: "structured" as const, templates: DEFAULT_TEMPLATES };

function longTranscript(n: number) {
  return transcript({
    segments: Array.from({ length: n }, (_, i) =>
      seg(`Speaker${i % 4}`, `Point number ${i}: ${"blah ".repeat(20)}`, i),
    ),
  });
}

describe("map-reduce chunking", () => {
  it("stays single-shot when the prompt fits the context budget", async () => {
    const client = fakeClient({ contextBudget: 1_000_000 });
    await summarizeTranscript(longTranscript(50), settings, client);
    expect(client.prompts).toHaveLength(1);
  });

  it("activates exactly when the prompt exceeds the budget", async () => {
    const t = longTranscript(50);
    // Budget just below the single-shot prompt length → chunking must kick in.
    const probe = fakeClient({ contextBudget: 10_000_000 });
    await summarizeTranscript(t, settings, probe);
    const singleShotLen = probe.prompts[0]!.length;

    const over = fakeClient({ contextBudget: singleShotLen });
    await summarizeTranscript(t, settings, over);
    expect(over.prompts).toHaveLength(1); // exactly at budget → still single-shot

    const under = fakeClient({ contextBudget: singleShotLen - 1 });
    await summarizeTranscript(t, settings, under);
    expect(under.prompts.length).toBeGreaterThan(1);
  });

  it("represents content from every chunk in the final reduce prompt", async () => {
    const t = longTranscript(60);
    const client = fakeClient({
      contextBudget: 3_000,
      reply: (prompt, call) => `CHUNK_SUMMARY_${call} (${prompt.includes("Point number 0") ? "has-start" : ""}${prompt.includes("Point number 59") ? "has-end" : ""})`,
    });
    await summarizeTranscript(t, settings, client);
    const finalPrompt = client.prompts.at(-1)!;
    const chunkCalls = client.prompts.length - 1;
    expect(chunkCalls).toBeGreaterThan(1);
    for (let i = 1; i <= chunkCalls; i++) {
      expect(finalPrompt).toContain(`CHUNK_SUMMARY_${i}`);
    }
    // First and last transcript content each reached some chunk call.
    expect(client.prompts.slice(0, -1).some((p) => p.includes("Point number 0:"))).toBe(true);
    expect(client.prompts.slice(0, -1).some((p) => p.includes("Point number 59:"))).toBe(true);
    // The final call goes through the user's selected template.
    expect(finalPrompt).toContain("## Action items");
  });

  it("propagates a failing chunk call as PipelineError (Held Transcript path)", async () => {
    const client = fakeClient({ contextBudget: 3_000, failWith: new Error("chunk boom") });
    await expect(summarizeTranscript(longTranscript(60), settings, client)).rejects.toThrow(
      /chunk boom/,
    );
  });

  it("hard-splits a single segment larger than the chunk budget — nothing dropped", () => {
    const huge = seg("Alice", "x".repeat(5_000));
    const chunks = chunkSegments([huge], 1_000);
    expect(chunks.length).toBeGreaterThan(4);
    const total = chunks.flat().reduce((n, s) => n + s.text.length, 0);
    expect(total).toBe(5_000);
  });

  it("keeps segment order across chunks", () => {
    const segments = Array.from({ length: 30 }, (_, i) => seg("S", `t${i}`, i));
    const flat = chunkSegments(segments, 40).flat();
    expect(flat.map((s) => s.text)).toEqual(segments.map((s) => s.text));
  });
});
