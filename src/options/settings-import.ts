// Settings import: the block a setup agent prepares, pasted on the Options page.
//
// It carries the user's choices only, never a secret and never consent. The
// parser fills the form and stores nothing; Save stays the one write path, so
// ADR-0001's storage rule and the microphone disclosure are unchanged (ADR-0010).
import type {
  MeetingLanguage,
  ProviderId,
  SummaryShape,
  TranscriptionProviderId,
  WhisperModelSize,
} from "../domain/types";

/** The version field that marks a block as ours, and its one known value. */
export const IMPORT_VERSION_FIELD = "meetingSummarizerSettings";
export const IMPORT_VERSION = 1;

/**
 * The languages offered, in the order they appear in the Settings select. A
 * Record over MeetingLanguage rather than a hand-written list so the compiler
 * refuses a page — or an import — that offers a code no engine was told about:
 * a code an engine rejects costs the whole Meeting a failed transcription.
 */
export const MEETING_LANGUAGES: Record<MeetingLanguage, string> = {
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

/** The choices an import may set. Every field is optional: an absent one leaves
 * the form as it is. */
export interface ImportedSettings {
  provider?: ProviderId;
  shape?: SummaryShape;
  nameEngineInArtifact?: boolean;
  anthropic?: { model?: string };
  openai?: { model?: string };
  ollama?: { baseUrl?: string; model?: string };
  bedrock?: { region?: string; model?: string };
  transcription?: {
    provider?: TranscriptionProviderId;
    language?: MeetingLanguage;
    localWhisper?: { model?: WhisperModelSize };
    openai?: { model?: string };
    elevenlabs?: { model?: string };
    sagemaker?: { region?: string; endpointName?: string };
  };
}

export type ImportResult =
  | { ok: true; settings: ImportedSettings; count: number }
  | { ok: false; reason: string };

const PROVIDERS: readonly ProviderId[] = ["anthropic", "openai", "ollama", "bedrock"];
const TRANSCRIPTION_PROVIDERS: readonly TranscriptionProviderId[] = [
  "local-whisper",
  "openai",
  "elevenlabs",
  "sagemaker",
];
const SHAPES: readonly SummaryShape[] = ["structured", "narrative"];
const WHISPER_MODELS: readonly WhisperModelSize[] = ["tiny", "base", "small"];

type Rule = "text" | "flag" | readonly string[];
type Shape = { [field: string]: Rule | Shape };

/** Everything an import may carry. Anything else is refused by name. */
const ALLOWED: Shape = {
  provider: PROVIDERS,
  shape: SHAPES,
  nameEngineInArtifact: "flag",
  anthropic: { model: "text" },
  openai: { model: "text" },
  ollama: { baseUrl: "text", model: "text" },
  bedrock: { region: "text", model: "text" },
  transcription: {
    provider: TRANSCRIPTION_PROVIDERS,
    language: Object.keys(MEETING_LANGUAGES),
    localWhisper: { model: WHISPER_MODELS },
    openai: { model: "text" },
    elevenlabs: { model: "text" },
    sagemaker: { region: "text", endpointName: "text" },
  },
};

/**
 * Fields refused with their own reason, wherever they appear. A key in an
 * import would sit in a file or on the clipboard as an "imported" value, and
 * consent is the user's own act: so these are refused, not dropped, and the
 * user is told where each one is entered instead.
 */
function forbidden(field: string): string | null {
  const name = field.toLowerCase().replace(/[^a-z]/g, "");
  if (name === "apikey" || name.endsWith("apikey")) {
    return `"${field}": API keys are never imported. Paste each key in its own field on this page.`;
  }
  if (/accesskey|secretkey|secretaccesskey|sessiontoken|credentials/.test(name)) {
    return `"${field}": AWS credentials are never imported. Paste them in the SageMaker credentials box.`;
  }
  if (name === "miccapture") {
    return `"${field}": microphone recording is never imported. Turn it on yourself under Recording.`;
  }
  if (name === "templates") {
    return `"${field}": Prompt Templates are not imported. Edit them under Summary.`;
  }
  return null;
}

/**
 * Reads a pasted settings block. Refuses the whole block on the first problem,
 * so that a half-applied import never leaves the form in a state the user did
 * not read.
 */
export function parseSettingsImport(text: string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "This is not a settings block: it is not valid JSON." };
  }
  if (!isObject(data)) {
    return { ok: false, reason: "This is not a settings block: expected a JSON object." };
  }
  const { [IMPORT_VERSION_FIELD]: version, ...rest } = data;
  if (version !== IMPORT_VERSION) {
    return {
      ok: false,
      reason:
        version === undefined
          ? `This is not a settings block: "${IMPORT_VERSION_FIELD}" is missing.`
          : `Unknown settings block version ${JSON.stringify(version)}; this page reads version ${IMPORT_VERSION}.`,
    };
  }
  const problem = check(rest, ALLOWED, "");
  if (problem) return { ok: false, reason: problem };
  const count = countValues(rest);
  if (count === 0) return { ok: false, reason: "The settings block holds no settings." };
  return { ok: true, settings: rest as ImportedSettings, count };
}

function check(value: Record<string, unknown>, shape: Shape, path: string): string | null {
  for (const [field, item] of Object.entries(value)) {
    const where = path + field;
    const refusal = forbidden(field);
    if (refusal) return refusal.replace(`"${field}"`, `"${where}"`);
    const rule = shape[field];
    if (rule === undefined) return `"${where}" is not a setting this page knows.`;
    if (rule === "text") {
      if (typeof item !== "string") return `"${where}" must be text.`;
    } else if (rule === "flag") {
      if (typeof item !== "boolean") return `"${where}" must be true or false.`;
    } else if (Array.isArray(rule)) {
      if (typeof item !== "string" || !rule.includes(item)) {
        return `"${where}" must be one of: ${rule.join(", ")}.`;
      }
    } else {
      if (!isObject(item)) return `"${where}" must be an object.`;
      const nested = check(item, rule as Shape, `${where}.`);
      if (nested) return nested;
    }
  }
  return null;
}

function countValues(value: Record<string, unknown>): number {
  let n = 0;
  for (const item of Object.values(value)) n += isObject(item) ? countValues(item) : 1;
  return n;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
