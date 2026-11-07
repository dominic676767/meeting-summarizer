// The settings import: what a setup agent may prepare, and the refusals that
// keep keys, credentials, consent and templates out of it.
import { describe, expect, it } from "vitest";
import { parseSettingsImport, type ImportedSettings } from "../src/options/settings-import";

function block(fields: Record<string, unknown>): string {
  return JSON.stringify({ meetingSummarizerSettings: 1, ...fields });
}

function ok(text: string): ImportedSettings {
  const parsed = parseSettingsImport(text);
  if (!parsed.ok) throw new Error(`expected settings, got: ${parsed.reason}`);
  return parsed.settings;
}

function reason(text: string): string {
  const parsed = parseSettingsImport(text);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.reason;
}

describe("parseSettingsImport", () => {
  it("reads every choice a setup agent may prepare", () => {
    const settings = {
      provider: "ollama",
      shape: "narrative",
      nameEngineInArtifact: true,
      anthropic: { model: "claude-sonnet-5" },
      openai: { model: "gpt-4o" },
      ollama: { baseUrl: "http://localhost:11434", model: "llama3.1" },
      bedrock: { region: "eu-west-1", model: "anthropic.claude-x" },
      transcription: {
        provider: "sagemaker",
        language: "de",
        localWhisper: { model: "small" },
        openai: { model: "whisper-1" },
        elevenlabs: { model: "scribe_v2" },
        sagemaker: { region: "us-east-1", endpointName: "qwen3-asr" },
        ollama: { baseUrl: "http://localhost:11434", model: "hf.co/ggml-org/Qwen3-ASR-1.7B-GGUF:Q8_0" },
      },
    };
    const parsed = parseSettingsImport(block(settings));
    expect(parsed).toEqual({ ok: true, settings, count: 18 });
  });

  it("accepts a block with only a few choices", () => {
    expect(ok(block({ transcription: { language: "fr" } }))).toEqual({
      transcription: { language: "fr" },
    });
  });

  it.each([
    ["anthropic", { anthropic: { apiKey: "x" } }, "anthropic.apiKey"],
    ["OpenAI", { openai: { apiKey: "x" } }, "openai.apiKey"],
    ["Bedrock", { bedrock: { apiKey: "x" } }, "bedrock.apiKey"],
    ["OpenAI transcription", { transcription: { openai: { apiKey: "x" } } }, "transcription.openai.apiKey"],
    ["ElevenLabs", { transcription: { elevenlabs: { apiKey: "x" } } }, "transcription.elevenlabs.apiKey"],
    ["a snake-case key", { api_key: "x" }, "api_key"],
  ])("refuses an API key (%s) by name, and says where it goes instead", (_, fields, where) => {
    const text = reason(block(fields));
    expect(text).toContain(`"${where}"`);
    expect(text).toContain("API keys are never imported");
  });

  it.each(["accessKeyId", "secretAccessKey", "sessionToken", "aws_secret_access_key", "credentials"])(
    "refuses AWS credentials (%s)",
    (field) => {
      expect(reason(block({ transcription: { sagemaker: { [field]: "x" } } }))).toContain(
        "AWS credentials are never imported",
      );
    },
  );

  it.each([
    ["bedrock.region", { bedrock: { region: "attacker.example/?" } }],
    ["transcription.sagemaker.region", { transcription: { sagemaker: { region: "us-east-1.attacker.example" } } }],
  ])("refuses %s when it is not an AWS region, since it becomes the request host", (where, fields) => {
    expect(reason(block(fields))).toBe(`"${where}" must be an AWS region, for example us-east-1.`);
  });

  it.each(["us-east-1", "eu-central-2", "ap-southeast-4", "us-gov-west-1"])(
    "accepts the real region %s",
    (region) => {
      expect(ok(block({ bedrock: { region }, transcription: { sagemaker: { region } } }))).toEqual({
        bedrock: { region },
        transcription: { sagemaker: { region } },
      });
    },
  );

  it.each([
    ["ollama.baseUrl", { ollama: { baseUrl: "http://ollama.example:11434" } }],
    ["transcription.ollama.baseUrl", { transcription: { ollama: { baseUrl: "https://ollama.example" } } }],
  ])("refuses %s when it is not this computer", (where, fields) => {
    expect(reason(block(fields))).toBe(`"${where}" must be this computer, for example http://localhost:11434.`);
  });

  it("refuses microphone recording, which only the user's own answer turns on", () => {
    expect(reason(block({ micCapture: { enabled: true, confirmedAt: 1 } }))).toContain(
      "microphone recording is never imported",
    );
  });

  it("refuses the Prompt Templates", () => {
    expect(reason(block({ templates: { structured: "x" } }))).toContain("not imported");
  });

  it("refuses a field it does not know, naming its path", () => {
    expect(reason(block({ ollama: { port: "11434" } }))).toBe(
      '"ollama.port" is not a setting this page knows.',
    );
  });

  it.each([
    [{ provider: "gemini" }, '"provider" must be one of: anthropic, openai, ollama, bedrock.'],
    [{ transcription: { language: "xx" } }, '"transcription.language" must be one of'],
    [{ transcription: { localWhisper: { model: "large" } } }, "tiny, base, small"],
    [{ nameEngineInArtifact: "yes" }, "must be true or false"],
    [{ ollama: { model: 3 } }, '"ollama.model" must be text.'],
    [{ ollama: "llama3.1" }, '"ollama" must be an object.'],
  ])("refuses a value outside what the page offers: %j", (fields, message) => {
    expect(reason(block(fields))).toContain(message);
  });

  it("refuses text that is not a versioned settings block", () => {
    expect(reason("provider=ollama")).toContain("not valid JSON");
    expect(reason("[1]")).toContain("expected a JSON object");
    expect(reason(JSON.stringify({ provider: "ollama" }))).toContain("is missing");
    expect(reason(JSON.stringify({ meetingSummarizerSettings: 2 }))).toContain("version 2");
    expect(reason(block({}))).toContain("holds no settings");
  });
});
