import type { CaptionSegment, Transcript } from "../src/domain/types";
import type { ProviderClient } from "../src/providers/provider";

export function seg(speaker: string, text: string, capturedAt = 0): CaptionSegment {
  return { speaker, text, capturedAt };
}

export function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    platform: "teams",
    title: "Weekly Sync",
    startedAt: Date.UTC(2026, 8, 13, 10, 0, 0),
    endedAt: Date.UTC(2026, 8, 13, 10, 30, 0),
    segments: [
      seg("Alice", "We should ship the beta next Friday."),
      seg("Bob", "Agreed. I will own the release checklist."),
      seg("Alice", "Open question: do we support Firefox ESR?"),
    ],
    ...overrides,
  };
}

/** Fake Provider client recording every prompt it receives. */
export function fakeClient(opts?: {
  reply?: (prompt: string, call: number) => string;
  contextBudget?: number;
  failWith?: Error;
}): ProviderClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "fake",
    contextBudget: opts?.contextBudget ?? 1_000_000,
    prompts,
    async complete(prompt: string) {
      prompts.push(prompt);
      if (opts?.failWith) throw opts.failWith;
      return opts?.reply ? opts.reply(prompt, prompts.length) : "## TL;DR\nStub summary.";
    },
  };
}
