// Options page: Provider selection + keys (browser.storage.local, ADR-0001),
// Summary shape toggle, and editable Prompt Templates.
import type {
  ProviderId,
  SummaryShape,
  TranscriptionProviderId,
  WhisperModelSize,
} from "../domain/types";
import { DEFAULT_TEMPLATES } from "../pipeline/templates";
import { loadSettings, saveSettings } from "../settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const providerSelect = $<HTMLSelectElement>("provider");
const PROVIDERS: ProviderId[] = ["anthropic", "openai", "ollama", "bedrock"];

function showPanel(provider: string): void {
  for (const p of PROVIDERS) {
    $(`panel-${p}`).classList.toggle("hidden", p !== provider);
  }
}

providerSelect.addEventListener("change", () => showPanel(providerSelect.value));

async function init(): Promise<void> {
  const s = await loadSettings();
  providerSelect.value = s.provider;
  showPanel(s.provider);
  $<HTMLInputElement>("anthropic-key").value = s.anthropic.apiKey;
  $<HTMLInputElement>("anthropic-model").value = s.anthropic.model;
  $<HTMLInputElement>("openai-key").value = s.openai.apiKey;
  $<HTMLInputElement>("openai-model").value = s.openai.model;
  $<HTMLInputElement>("ollama-url").value = s.ollama.baseUrl;
  $<HTMLInputElement>("ollama-model").value = s.ollama.model;
  $<HTMLInputElement>("bedrock-key").value = s.bedrock.apiKey;
  $<HTMLInputElement>("bedrock-region").value = s.bedrock.region;
  $<HTMLInputElement>("bedrock-model").value = s.bedrock.model;
  $<HTMLSelectElement>("transcription-provider").value = s.transcription.provider;
  $<HTMLSelectElement>("whisper-model").value = s.transcription.localWhisper.model;
  $<HTMLSelectElement>("shape").value = s.shape;
  $<HTMLTextAreaElement>("template-structured").value = s.templates.structured;
  $<HTMLTextAreaElement>("template-narrative").value = s.templates.narrative;
}

$("reset-structured").addEventListener("click", () => {
  $<HTMLTextAreaElement>("template-structured").value = DEFAULT_TEMPLATES.structured;
});
$("reset-narrative").addEventListener("click", () => {
  $<HTMLTextAreaElement>("template-narrative").value = DEFAULT_TEMPLATES.narrative;
});

$("save").addEventListener("click", async () => {
  const s = await loadSettings();
  s.provider = providerSelect.value as ProviderId;
  s.anthropic = {
    apiKey: $<HTMLInputElement>("anthropic-key").value.trim(),
    model: $<HTMLInputElement>("anthropic-model").value.trim(),
  };
  s.openai = {
    apiKey: $<HTMLInputElement>("openai-key").value.trim(),
    model: $<HTMLInputElement>("openai-model").value.trim(),
  };
  s.ollama = {
    baseUrl: $<HTMLInputElement>("ollama-url").value.trim(),
    model: $<HTMLInputElement>("ollama-model").value.trim(),
  };
  s.bedrock = {
    apiKey: $<HTMLInputElement>("bedrock-key").value.trim(),
    region: $<HTMLInputElement>("bedrock-region").value.trim(),
    model: $<HTMLInputElement>("bedrock-model").value.trim(),
  };
  s.transcription = {
    provider: $<HTMLSelectElement>("transcription-provider").value as TranscriptionProviderId,
    localWhisper: {
      model: $<HTMLSelectElement>("whisper-model").value as WhisperModelSize,
    },
  };
  s.shape = $<HTMLSelectElement>("shape").value as SummaryShape;
  s.templates = {
    structured: $<HTMLTextAreaElement>("template-structured").value,
    narrative: $<HTMLTextAreaElement>("template-narrative").value,
  };
  await saveSettings(s);
  $("saved").classList.remove("hidden");
  setTimeout(() => $("saved").classList.add("hidden"), 1500);
});

void init();
