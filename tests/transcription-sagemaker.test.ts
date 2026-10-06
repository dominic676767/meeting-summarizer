// The SageMaker engine with the network replaced: the call it prepares, how it
// is signed, how the reply and each failure are read, and the factory's checks
// before any audio is sent. A real endpoint is the manual check's job.
import { SignatureV4 } from "@smithy/signature-v4";
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
  awsErrorOf,
  createSageMakerTranscriptionEngine,
  invokeInput,
  SAGEMAKER_MAX_INPUT_MS,
  SAGEMAKER_WINDOWING,
  SageMakerFailure,
  sageMakerFailure,
  signedInvoke,
  textFromResponse,
  TRANSCRIPTION_ROUTE,
  UNLISTED_LANGUAGES,
  WebCryptoSha256,
  type InvokeCall,
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
const reply = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));

/** The multipart body's parts by name. latin1 maps each byte to one character. */
function partsOf(call: InvokeCall): Map<string, { head: string; value: string }> {
  const boundary = /boundary=(.+)$/.exec(call.contentType)?.[1] ?? "";
  const text = new TextDecoder("latin1").decode(call.body);
  const parts = new Map<string, { head: string; value: string }>();
  for (const chunk of text.split(`--${boundary}`).slice(1, -1)) {
    const [head = "", ...rest] = chunk.split("\r\n\r\n");
    const name = /name="([^"]+)"/.exec(head)?.[1] ?? "";
    parts.set(name, { head, value: rest.join("\r\n\r\n").replace(/\r\n$/, "") });
  }
  return parts;
}

function input(language: MeetingLanguage = "de", seconds = 2): InvokeCall {
  return invokeInput({ endpointName: WHERE.endpointName, samples: silence(seconds), language });
}

/** A fetch that records each request and answers with `answer`. */
function fakeFetch(answer: () => Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    requests.push({ url, init });
    return Promise.resolve(answer());
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

describe("invokeInput", () => {
  it("sends the window to vLLM's transcription route on the named endpoint", () => {
    const call = input();
    expect(call.endpointName).toBe("qwen3-asr");
    expect(call.customAttributes).toBe(TRANSCRIPTION_ROUTE);
    expect(call.customAttributes).toBe("route=/v1/audio/transcriptions");
    expect(call.contentType).toMatch(/^multipart\/form-data; boundary=\S+$/);
    expect(call.accept).toBe("application/json");
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

describe("signedInvoke", () => {
  it("signs the call for the sagemaker service in the endpoint's region, with the session token", async () => {
    const { fetchFn, requests } = fakeFetch(() => new Response(reply({ text: "hi" })));
    const call = input();
    const signal = new AbortController().signal;
    await signedInvoke({ region: "eu-west-1", credentials: CREDENTIALS, fetchFn })(call, signal);

    const [request] = requests;
    expect(request?.url).toBe("https://runtime.sagemaker.eu-west-1.amazonaws.com/endpoints/qwen3-asr/invocations");
    const headers = request?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIA-TEST-KEY-ID\/\d{8}\/eu-west-1\/sagemaker\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token;x-amzn-sagemaker-custom-attributes, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["x-amz-security-token"]).toBe("test-token");
    expect(headers["x-amzn-sagemaker-custom-attributes"]).toBe(TRANSCRIPTION_ROUTE);
    expect(headers["content-type"]).toBe(call.contentType);
    // The browser sets Host from the URL and refuses it as a header.
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("host");
    expect(request?.init.body).toBe(call.body);
    expect(request?.init.signal).toBe(signal);
  });

  it("returns the reply's bytes", async () => {
    const { fetchFn } = fakeFetch(() => new Response(reply({ text: "guten Tag" })));
    const body = await signedInvoke({ region: "eu-west-1", credentials: CREDENTIALS, fetchFn })(
      input(),
      new AbortController().signal,
    );
    expect(textFromResponse(body)).toBe("guten Tag");
  });

  it("throws AWS's error type and message for a failed reply", async () => {
    const { fetchFn } = fakeFetch(
      () =>
        new Response(JSON.stringify({ message: "Endpoint qwen3-asr of account 123456789012 not found." }), {
          status: 400,
          headers: { "x-amzn-ErrorType": "ValidationError:http://internal.amazon.com/coral/com.amazon.sagemaker/" },
        }),
    );
    const call = signedInvoke({ region: "eu-west-1", credentials: CREDENTIALS, fetchFn })(
      input(),
      new AbortController().signal,
    );
    await expect(call).rejects.toMatchObject({
      name: "ValidationError",
      status: 400,
      message: "Endpoint qwen3-asr of account 123456789012 not found.",
    });
  });
});

describe("WebCryptoSha256, as the signer's hash", () => {
  it("signs AWS's published get-vanilla example to its published signature", async () => {
    // From AWS's Signature Version 4 test suite: the example credentials, the
    // example date, a GET of / with only the Host header.
    const signer = new SignatureV4({
      service: "service",
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      sha256: WebCryptoSha256,
      applyChecksum: false,
    });
    const signed = await signer.sign(
      {
        method: "GET",
        protocol: "https:",
        hostname: "example.amazonaws.com",
        path: "/",
        query: {},
        headers: { host: "example.amazonaws.com" },
      },
      { signingDate: new Date("2015-08-30T12:36:00Z") },
    );
    expect(signed.headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
});

describe("textFromResponse", () => {
  it("reads the text of vLLM's transcription reply", () => {
    expect(textFromResponse(reply({ text: "guten Tag", usage: { type: "duration", seconds: 2 } }))).toBe(
      "guten Tag",
    );
  });

  it("calls a reply without text a format failure: the call missed the route", () => {
    const chat = reply({ choices: [{ message: { content: "language German<asr_text>guten Tag" } }] });
    expect(() => textFromResponse(chat)).toThrow(SageMakerFailure);
    expect(() => textFromResponse(chat)).toThrow(/no text/);
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

describe("awsErrorOf", () => {
  const bytes = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));

  it("takes the error type from the header, without AWS's namespace", () => {
    expect(
      awsErrorOf(400, "ValidationError:http://internal.amazon.com/coral/com.amazon.sagemaker/", bytes({ message: "bad" })),
    ).toEqual({ name: "ValidationError", message: "bad", status: 400 });
  });

  it("falls back to the body's __type when the header is absent", () => {
    expect(
      awsErrorOf(403, null, bytes({ __type: "com.amazon.coral.service#ExpiredTokenException", message: "expired" })).name,
    ).toBe("ExpiredTokenException");
  });

  it("keeps a container failure's own status and message", () => {
    expect(
      awsErrorOf(
        424,
        "ModelError:http://internal.amazon.com/coral/com.amazon.sagemaker/",
        bytes({ OriginalStatusCode: 500, OriginalMessage: "audio decode failed", message: "Received server error (500)" }),
      ),
    ).toEqual({
      name: "ModelError",
      message: "Received server error (500)",
      status: 424,
      originalStatus: 500,
      originalMessage: "audio decode failed",
    });
  });

  it("keeps an error page's text when the body is not JSON", () => {
    expect(awsErrorOf(502, null, new TextEncoder().encode("Bad gateway"))).toEqual({
      name: "HTTP 502",
      message: "Bad gateway",
      status: 502,
    });
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
    expect(kindOf({ name: "HTTP 403", status: 403 })).toBe("credentials");
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
      { name: "ModelError", originalStatus: 500, originalMessage: "audio decode failed" },
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

  it("turns a failed call into a failure that holds the Recording", async () => {
    const call = engine(() => Promise.reject({ name: "ExpiredTokenException", status: 403 })).transcribe(silence(1));
    await expect(call).rejects.toBeInstanceOf(SageMakerFailure);
    await expect(call).rejects.toMatchObject({ kind: "credentials" });
  });

  it("reads a failure off a real reply, through the signed fetch", async () => {
    const { fetchFn } = fakeFetch(
      () => new Response(JSON.stringify({ message: "expired" }), { status: 403, headers: { "x-amzn-ErrorType": "ExpiredTokenException" } }),
    );
    const e = createSageMakerTranscriptionEngine({ ...WHERE, credentials: CREDENTIALS, language: "en", fetchFn });
    await expect(e.transcribe(silence(1))).rejects.toThrow(/credentials have expired/);
  });

  it("gives up after its timeout, as a failure to hold", async () => {
    const hang: InvokeFn = (_call, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const call = engine(hang, 20).transcribe(silence(1));
    await expect(call).rejects.toBeInstanceOf(SageMakerFailure);
    await expect(call).rejects.toThrow(/no response after/);
  });

  it("hands the request a signal that the user's cancel aborts", async () => {
    let seen: AbortSignal | undefined;
    const hang: InvokeFn = (_call, signal) => {
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
    const hang: InvokeFn = (_call, signal) =>
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
    const calls: InvokeCall[] = [];
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
    expect(calls[0]?.endpointName).toBe("qwen3-asr");
    expect(partsOf(calls[0]!).get("to_language")?.value).toBe("de");
  });
});
