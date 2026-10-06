// The SageMaker engine with the AWS SDK replaced: the call it prepares, how it
// reads the reply, what each failure tells the user, and the factory's checks
// before any audio is sent. A real endpoint is the manual check's job.
import type { InvokeEndpointCommandInput } from "@aws-sdk/client-sagemaker-runtime";
import { describe, expect, it } from "vitest";
import type { MeetingLanguage, TranscriptionSettings } from "../src/domain/types";
import type { AwsCredentials } from "../src/transcription/aws-credentials";
import { createTranscriptionProviderFor } from "../src/transcription/factory";
import {
  createTranscriptionProvider,
  TranscriptionCancelled,
  TranscriptionError,
  type DecodeAudio,
} from "../src/transcription/provider";
import {
  createSageMakerTranscriptionEngine,
  invokeInput,
  SAGEMAKER_MAX_INPUT_MS,
  SAGEMAKER_WINDOWING,
  SageMakerFailure,
  sageMakerFailure,
  textFromResponse,
  TRANSCRIPTION_ROUTE,
  UNLISTED_LANGUAGES,
  type InvokeFn,
} from "../src/transcription/sagemaker";

const RATE = 16_000;
const CREDENTIALS: AwsCredentials = {
  accessKeyId: "ASIA-TEST-KEY-ID",
  secretAccessKey: "test-secret",
  sessionToken: "test-token",
};
const WHERE = { endpointName: "qwen3-asr", region: "eu-west-1" };

const silence = (seconds: number) => new Float32Array(Math.round(seconds * RATE));
const reply = (body: unknown) => ({ Body: new TextEncoder().encode(JSON.stringify(body)) });

/** The multipart body's parts by name. latin1 maps each byte to one character. */
function partsOf(input: InvokeEndpointCommandInput): Map<string, { head: string; value: string }> {
  const boundary = /boundary=(.+)$/.exec(input.ContentType ?? "")?.[1] ?? "";
  // invokeInput always builds the body as bytes; the SDK's type also allows text.
  const text = new TextDecoder("latin1").decode(input.Body as Uint8Array);
  const parts = new Map<string, { head: string; value: string }>();
  for (const chunk of text.split(`--${boundary}`).slice(1, -1)) {
    const [head = "", ...rest] = chunk.split("\r\n\r\n");
    const name = /name="([^"]+)"/.exec(head)?.[1] ?? "";
    parts.set(name, { head, value: rest.join("\r\n\r\n").replace(/\r\n$/, "") });
  }
  return parts;
}

function input(language: MeetingLanguage = "de", seconds = 2): InvokeEndpointCommandInput {
  return invokeInput({ endpointName: WHERE.endpointName, samples: silence(seconds), language });
}

describe("invokeInput", () => {
  it("sends the window to vLLM's transcription route on the named endpoint", () => {
    const call = input();
    expect(call.EndpointName).toBe("qwen3-asr");
    expect(call.CustomAttributes).toBe(TRANSCRIPTION_ROUTE);
    expect(call.CustomAttributes).toBe("route=/v1/audio/transcriptions");
    expect(call.ContentType).toMatch(/^multipart\/form-data; boundary=\S+$/);
    expect(call.Accept).toBe("application/json");
  });

  it("uploads the window as a 16-bit mono WAV of exactly its samples", () => {
    const file = partsOf(input("en", 2)).get("file");
    expect(file?.head).toContain('filename="window.wav"');
    expect(file?.head).toContain("Content-Type: audio/wav");
    expect(file?.value.slice(0, 4)).toBe("RIFF");
    expect(file?.value.slice(8, 12)).toBe("WAVE");
    expect(file?.value.length).toBe(44 + 2 * RATE * 2);
  });

  it("forces the Meeting Language through to_language, and names it in language too", () => {
    const parts = partsOf(input("de"));
    expect(parts.get("to_language")?.value).toBe("de");
    expect(parts.get("language")?.value).toBe("de");
    expect(parts.get("response_format")?.value).toBe("json");
  });

  it("sends no language at all for the Meeting Languages Qwen3-ASR does not list", () => {
    expect(UNLISTED_LANGUAGES).toEqual(["he", "no", "uk"]);
    for (const language of UNLISTED_LANGUAGES) {
      const parts = partsOf(input(language));
      expect(parts.has("to_language")).toBe(false);
      expect(parts.has("language")).toBe(false);
      expect(parts.get("response_format")?.value).toBe("json");
    }
  });
});

describe("textFromResponse", () => {
  it("reads the text of vLLM's transcription reply", () => {
    expect(textFromResponse(reply({ text: "guten Tag", usage: { type: "duration", seconds: 2 } }).Body)).toBe(
      "guten Tag",
    );
  });

  it("calls a reply without text a format failure: the call missed the route", () => {
    const chat = reply({ choices: [{ message: { content: "language German<asr_text>guten Tag" } }] });
    expect(() => textFromResponse(chat.Body)).toThrow(SageMakerFailure);
    expect(() => textFromResponse(chat.Body)).toThrow(/no text/);
  });

  it("calls a reply that is not JSON a format failure", () => {
    const page = new TextEncoder().encode("<html>Bad gateway</html>");
    try {
      textFromResponse(page);
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(SageMakerFailure);
      expect((err as SageMakerFailure).kind).toBe("format");
    }
  });
});

describe("sageMakerFailure", () => {
  const kindOf = (err: unknown) => sageMakerFailure(err, WHERE).kind;

  it("says expired credentials are expired, and what to do", () => {
    const failure = sageMakerFailure({ name: "ExpiredTokenException", message: "The security token included in the request is expired" }, WHERE);
    expect(failure.kind).toBe("credentials");
    expect(failure.message).toMatch(/expired — paste fresh ones in Settings/);
  });

  it("calls a refused signature or key a credentials failure", () => {
    expect(kindOf({ name: "UnrecognizedClientException" })).toBe("credentials");
    expect(kindOf({ name: "InvalidSignatureException" })).toBe("credentials");
    expect(kindOf({ name: "Error", $metadata: { httpStatusCode: 403 } })).toBe("credentials");
  });

  it("names the permission that is missing when access is denied", () => {
    const failure = sageMakerFailure({ name: "AccessDeniedException" }, WHERE);
    expect(failure.kind).toBe("credentials");
    expect(failure.message).toContain("sagemaker:InvokeEndpoint");
    expect(failure.message).toContain("qwen3-asr");
  });

  it("names the endpoint and region that were not found", () => {
    const failure = sageMakerFailure(
      { name: "ValidationError", message: "Endpoint qwen3-asr of account 123456789012 not found." },
      WHERE,
    );
    expect(failure.kind).toBe("endpoint");
    expect(failure.message).toContain("qwen3-asr was not found in eu-west-1");
  });

  it("passes on what the container said when it failed", () => {
    const failure = sageMakerFailure(
      { name: "ModelError", OriginalStatusCode: 500, OriginalMessage: "audio decode failed" },
      WHERE,
    );
    expect(failure.kind).toBe("container");
    expect(failure.message).toContain("(500): audio decode failed");
  });

  it("keeps anything else as it came", () => {
    const failure = sageMakerFailure(new TypeError("Failed to fetch"), WHERE);
    expect(failure.kind).toBe("other");
    expect(failure.message).toContain("TypeError: Failed to fetch");
  });

  it("is a TranscriptionError, so the Recording is held", () => {
    expect(sageMakerFailure({ name: "ModelError" }, WHERE)).toBeInstanceOf(TranscriptionError);
  });
});

describe("the SageMaker engine", () => {
  function engine(invoke: InvokeFn, timeoutMs?: number) {
    return createSageMakerTranscriptionEngine({
      ...WHERE,
      credentials: CREDENTIALS,
      language: "en",
      invoke,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  it("asks the wrapper for windows cut at pauses, none longer than Qwen3-ASR's clip", () => {
    const e = engine(() => Promise.resolve(reply({ text: "" })));
    expect(e.windowing).toEqual(SAGEMAKER_WINDOWING);
    expect(e.maxInputMs).toBe(SAGEMAKER_MAX_INPUT_MS);
    expect(SAGEMAKER_MAX_INPUT_MS).toBe(30_000);
  });

  it("turns a window's reply into one span that covers the window", async () => {
    const spans = await engine(() => Promise.resolve(reply({ text: "  hello there " }))).transcribe(silence(4));
    expect(spans).toEqual([{ text: "hello there", startSec: 0, endSec: 4 }]);
  });

  it("returns no span for a window with no words", async () => {
    expect(await engine(() => Promise.resolve(reply({ text: " " }))).transcribe(silence(4))).toEqual([]);
  });

  it("turns an SDK error into a failure that holds the Recording", async () => {
    const call = engine(() => Promise.reject({ name: "ExpiredTokenException" })).transcribe(silence(1));
    await expect(call).rejects.toBeInstanceOf(SageMakerFailure);
    await expect(call).rejects.toMatchObject({ kind: "credentials" });
  });

  it("gives up after its timeout, as a failure to hold", async () => {
    const hang: InvokeFn = (_input, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const call = engine(hang, 20).transcribe(silence(1));
    await expect(call).rejects.toBeInstanceOf(SageMakerFailure);
    await expect(call).rejects.toThrow(/no response after/);
  });

  it("hands the SDK a signal that the user's cancel aborts", async () => {
    let seen: AbortSignal | undefined;
    const hang: InvokeFn = (_input, signal) => {
      seen = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    };
    const user = new AbortController();
    const call = engine(hang).transcribe(silence(1), user.signal);
    user.abort();
    await expect(call).rejects.toBeDefined();
    expect(seen?.aborted).toBe(true);
  });

  it("reaches the wrapper as a cancel, not a failure, when the user skips the wait", async () => {
    const user = new AbortController();
    const hang: InvokeFn = (_input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
        queueMicrotask(() => user.abort());
      });
    const decode: DecodeAudio = () => Promise.resolve({ samples: silence(3), sampleRate: RATE });
    const provider = createTranscriptionProvider({ name: "sagemaker", engine: engine(hang), decode });
    await expect(
      provider.transcribe({ spans: [{ data: new Blob(), startOffsetMs: 0 }] }, { signal: user.signal }),
    ).rejects.toBeInstanceOf(TranscriptionCancelled);
  });
});

describe("the factory's SageMaker checks", () => {
  const settings = (over: Partial<TranscriptionSettings["sagemaker"]> = {}): TranscriptionSettings => ({
    provider: "sagemaker",
    language: "de",
    localWhisper: { model: "base" },
    openai: { apiKey: "", model: "whisper-1" },
    elevenlabs: { apiKey: "", model: "scribe_v2" },
    sagemaker: { region: "eu-west-1", endpointName: "qwen3-asr", ...over },
  });
  const decode: DecodeAudio = () => Promise.resolve({ samples: silence(5), sampleRate: RATE });
  const recording = { spans: [{ data: new Blob(), startOffsetMs: 0 }] };

  it("holds the Recording when no endpoint is configured", () => {
    expect(() =>
      createTranscriptionProviderFor(settings({ endpointName: "" }), {
        workerUrl: "w.js",
        awsCredentials: CREDENTIALS,
      }),
    ).toThrow(/no endpoint configured/);
  });

  it("holds the Recording when no credentials are pasted", () => {
    expect(() =>
      createTranscriptionProviderFor(settings(), { workerUrl: "w.js", awsCredentials: null }),
    ).toThrow(/no AWS credentials/);
  });

  it("holds the Recording before any upload when the credentials have expired", () => {
    let calls = 0;
    expect(() =>
      createTranscriptionProviderFor(settings(), {
        workerUrl: "w.js",
        awsCredentials: { ...CREDENTIALS, expiresAt: 1_000 },
        now: 2_000,
        invoke: () => {
          calls++;
          return Promise.resolve(reply({ text: "" }));
        },
      }),
    ).toThrow(TranscriptionError);
    expect(calls).toBe(0);
  });

  it("transcribes through the endpoint, in the Meeting Language", async () => {
    const calls: InvokeEndpointCommandInput[] = [];
    const provider = createTranscriptionProviderFor(settings(), {
      workerUrl: "w.js",
      decode,
      awsCredentials: { ...CREDENTIALS, expiresAt: 10_000 },
      now: 2_000,
      invoke: (call) => {
        calls.push(call);
        return Promise.resolve(reply({ text: "guten Tag zusammen" }));
      },
    });
    const utterances = await provider.transcribe(recording);
    expect(utterances.map((u) => u.text)).toEqual(["guten Tag zusammen"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.EndpointName).toBe("qwen3-asr");
    expect(partsOf(calls[0]!).get("to_language")?.value).toBe("de");
  });
});
