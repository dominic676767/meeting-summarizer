// Settings persistence in browser.storage.local (ADR-0001: no native host,
// keys live here).
import type { Settings } from "./domain/types";
import { DEFAULT_TEMPLATES } from "./pipeline/templates";

export const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  shape: "structured",
  templates: { ...DEFAULT_TEMPLATES },
  anthropic: { apiKey: "", model: "claude-sonnet-5" },
  openai: { apiKey: "", model: "gpt-4o" },
  ollama: { baseUrl: "http://localhost:11434", model: "llama3.1" },
  bedrock: { apiKey: "", region: "us-east-1", model: "anthropic.claude-sonnet-4-20250514-v1:0" },
};

export async function loadSettings(): Promise<Settings> {
  const stored = (await browser.storage.local.get("settings")) as { settings?: Partial<Settings> };
  const s = stored.settings ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    templates: { ...DEFAULT_SETTINGS.templates, ...s.templates },
    anthropic: { ...DEFAULT_SETTINGS.anthropic, ...s.anthropic },
    openai: { ...DEFAULT_SETTINGS.openai, ...s.openai },
    ollama: { ...DEFAULT_SETTINGS.ollama, ...s.ollama },
    bedrock: { ...DEFAULT_SETTINGS.bedrock, ...s.bedrock },
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ settings });
}
