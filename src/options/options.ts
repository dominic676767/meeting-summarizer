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
  // The microphone disclosure has to describe the destination the audio will
  // actually reach, so it follows the engine rather than stating locality that a
  // cloud selection makes false.
  const cloud = provider !== "local-whisper";
  $("mic-why-local").classList.toggle("hidden", cloud);
  $("mic-why-cloud").classList.toggle("hidden", !cloud);
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
  $<HTMLInputElement>("mic-capture").checked = s.micCapture.enabled;
  micCaptureAsLoaded = s.micCapture.enabled;
  micConsentProviderAsLoaded = s.transcription.provider;
  $<HTMLInputElement>("name-engine").checked = s.nameEngineInArtifact;
  $<HTMLSelectElement>("shape").value = s.shape;
  $<HTMLTextAreaElement>("template-structured").value = s.templates.structured;
  $<HTMLTextAreaElement>("template-narrative").value = s.templates.narrative;
  for (const refresh of editorRefreshers) refresh();
}

const editorRefreshers: Array<() => void> = [];

/**
 * The microphone checkbox as the page loaded it. Save compares against this so
 * an untouched box never records consent the user did not give.
 */
let micCaptureAsLoaded = false;
/** The Transcription Provider the microphone consent on file was given under. */
let micConsentProviderAsLoaded: TranscriptionProviderId = "local-whisper";
const editorUndoClears: Array<() => void> = [];

/**
 * Reset, made undoable rather than confirmed.
 *
 * A modal would be the wrong instrument: a confirm on a two-click path trains
 * people to click through it, and this task needs neither interruption nor
 * protected focus. So Reset does the thing and offers it back. The offer stands
 * until save, navigation, or an edit — deliberately with no timer, because a
 * timed undo makes the user race a clock they never saw start.
 *
 * Each template owns its own undo state; resetting one must not withdraw the
 * other's offer.
 */
function wireTemplateEditor(shape: "structured" | "narrative"): void {
  const area = $<HTMLTextAreaElement>(`template-${shape}`);
  const btn = $<HTMLButtonElement>(`reset-${shape}`);
  const marker = $(`edited-${shape}`);
  const resetLabel = btn.textContent ?? "Reset to default";
  const undoLabel = `Undo reset of ${shape} template`;
  let previous: string | null = null;

  /** A collapsed editor must not conceal a change the user made. */
  function refreshMarker(): void {
    marker.hidden = area.value === DEFAULT_TEMPLATES[shape];
  }

  function clearUndo(): void {
    previous = null;
    btn.textContent = resetLabel;
  }

  btn.addEventListener("click", () => {
    if (previous === null) {
      previous = area.value;
      area.value = DEFAULT_TEMPLATES[shape];
      btn.textContent = undoLabel;
    } else {
      area.value = previous;
      clearUndo();
    }
    refreshMarker();
  });

  // Typing means the user has moved on from the reset; the old text is no longer
  // what they would expect Undo to bring back.
  area.addEventListener("input", () => {
    clearUndo();
    refreshMarker();
  });

  editorRefreshers.push(refreshMarker);
  editorUndoClears.push(clearUndo);
}

wireTemplateEditor("structured");
wireTemplateEditor("narrative");

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
  // Consent is only recorded when the user actually MOVED the checkbox. Saving
  // the page for an unrelated reason — changing the summary shape, pasting a key
  // — must never be read as answering the microphone disclosure: leaving a box
  // as you found it is the absence of a decision, not a decision. Without this,
  // any future change back to a ticked default would silently harvest consent
  // from every incidental Save.
  const micChecked = $<HTMLInputElement>("mic-capture").checked;
  // Consent has to stay specific to what was promised. A user says yes to the
  // microphone partly because transcription happens on their machine; selecting a
  // cloud engine makes that untrue, and their voice would start being uploaded
  // under a consent that predates the change. So the confirmation is withdrawn
  // and the disclosure asks again, naming the destination. Failing toward one
  // extra ask beats failing toward an upload nobody agreed to.
  const switchedToCloud =
    s.transcription.provider !== "local-whisper" &&
    s.transcription.provider !== micConsentProviderAsLoaded;
  s.micCapture = {
    enabled: micChecked,
    confirmedAt: switchedToCloud
      ? null
      : micChecked === micCaptureAsLoaded
        ? s.micCapture.confirmedAt
        : Date.now(),
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
    for (const clear of editorUndoClears) clear();
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
