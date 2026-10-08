import type { PlatformAdapter } from "../adapters/adapter";
import { startContentScript } from "./runner";

// Programmatic injection after an extension reload can overlap a declarative
// injection. Each frame must have only one observer for each platform.
const mounted = globalThis as typeof globalThis & {
  meetingSummarizerContent?: Record<string, () => void>;
};

export function mountContentScript(adapter: PlatformAdapter): void {
  const scripts = mounted.meetingSummarizerContent ??= {};
  scripts[adapter.platform]?.();
  scripts[adapter.platform] = startContentScript(adapter);
}
