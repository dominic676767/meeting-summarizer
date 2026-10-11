import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the real suite. Without this, Vitest also collects the copies of
    // tests/ in agent worktrees (.claude/worktrees/), eval checkpoints (.eval/)
    // and .scratch/, which run the suite again or fail to load.
    include: ["tests/**/*.test.ts"],
  },
});
