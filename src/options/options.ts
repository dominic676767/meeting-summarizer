// Options page: Provider selection + keys (browser.storage.local, ADR-0001),
// Summary shape toggle, and editable Prompt Templates.
import type {
  MeetingLanguage,
  Settings,
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
// Kept on their own prefix: the two axes share vendor names, and the point of
// this page is that they are not the same setting.
const transcriptionSelect = $<HTMLSelectElement>("transcription-provider");
const TRANSCRIPTION_PROVIDERS: TranscriptionProviderId[] = ["local-whisper", "openai"];

/**
 * The languages offered, in the order they appear in the select. A Record over
 * MeetingLanguage rather than a hand-written list of `<option>`s so the compiler
 * refuses a page that offers a code no engine was told about — a code an engine
 * rejects costs the whole Meeting a failed transcription.
 */
const MEETING_LANGUAGES: Record<MeetingLanguage, string> = {
  ar: "Arabic",
  zh: "Chinese",
  cs: "Czech",
  da: "Danish",
  nl: "Dutch",
  en: "English",
  fi: "Finnish",
  fr: "French",
  de: "German",
  el: "Greek",
  he: "Hebrew",
  hi: "Hindi",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  ms: "Malay",
  no: "Norwegian",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  es: "Spanish",
  sv: "Swedish",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
};
const languageSelect = $<HTMLSelectElement>("meeting-language");
for (const [code, label] of Object.entries(MEETING_LANGUAGES)) {
  languageSelect.add(new Option(label, code));
}

function showPanel(provider: string): void {
  for (const p of PROVIDERS) {
    $(`panel-${p}`).classList.toggle("hidden", p !== provider);
  }
}

function showTranscriptionPanel(provider: string): void {
  for (const p of TRANSCRIPTION_PROVIDERS) {
    $(`panel-transcription-${p}`).classList.toggle("hidden", p !== provider);
  }
}

providerSelect.addEventListener("change", () => showPanel(providerSelect.value));
transcriptionSelect.addEventListener("change", () =>
  showTranscriptionPanel(transcriptionSelect.value),
);

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
  transcriptionSelect.value = s.transcription.provider;
  showTranscriptionPanel(s.transcription.provider);
  languageSelect.value = s.transcription.language;
  $<HTMLSelectElement>("whisper-model").value = s.transcription.localWhisper.model;
  $<HTMLInputElement>("transcription-openai-key").value = s.transcription.openai.apiKey;
  $<HTMLInputElement>("transcription-openai-model").value = s.transcription.openai.model;
  $<HTMLInputElement>("name-engine").checked = s.nameEngineInArtifact;
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
    provider: transcriptionSelect.value as TranscriptionProviderId,
    language: languageSelect.value as MeetingLanguage,
    localWhisper: {
      model: $<HTMLSelectElement>("whisper-model").value as WhisperModelSize,
    },
    openai: {
      apiKey: $<HTMLInputElement>("transcription-openai-key").value.trim(),
      model: $<HTMLInputElement>("transcription-openai-model").value.trim(),
    },
  };
  s.nameEngineInArtifact = $<HTMLInputElement>("name-engine").checked;
  s.shape = $<HTMLSelectElement>("shape").value as SummaryShape;
  s.templates = {
    structured: $<HTMLTextAreaElement>("template-structured").value,
    narrative: $<HTMLTextAreaElement>("template-narrative").value,
  };
  // A rejected storage write used to vanish into an unhandled rejection, so a
  // user whose settings did not save was told "Saved." — or nothing at all. The
  // entered values are left in place either way, so a failure costs a second
  // click rather than the whole form.
  const result = $("saved");
  try {
    await saveSettings(s);
    result.classList.remove("failed");
    result.textContent = keyMissingFor(s)
      ? `Saved — but ${keyMissingFor(s)} still needs a key before a meeting can be summarized.`
      : "Saved.";
  } catch (err) {
    result.classList.add("failed");
    result.textContent = `Not saved: ${err instanceof Error ? err.message : String(err)}`;
  }
});

/**
 * The selected summary Provider's missing credential, if any. Saving an
 * incomplete configuration is allowed — a half-filled form is worth keeping —
 * but it must not read as ready when the next meeting will fail on it.
 */
function keyMissingFor(s: Settings): string | null {
  switch (s.provider) {
    case "anthropic":
      return s.anthropic.apiKey ? null : "Claude";
    case "openai":
      return s.openai.apiKey ? null : "OpenAI";
    case "bedrock":
      return s.bedrock.apiKey ? null : "Bedrock";
    case "ollama":
      return s.ollama.baseUrl ? null : "Ollama";
  }
}

void init();
