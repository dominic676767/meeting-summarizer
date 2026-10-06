// The third cloud Transcription Provider: the user's own Amazon SageMaker
// endpoint, running Qwen3-ASR from SageMaker JumpStart (ADR-0009).
//
// Opt-in like the other cloud engines: nothing here is reachable until the user
// selects the engine and pastes temporary AWS credentials. The audio goes to the
// user's own AWS account rather than to a vendor, but it still leaves the
// machine, and every surface says so.
//
// Qwen3-ASR returns text and no timestamps, so this engine asks the wrapper for
// short windows cut at pauses: each window becomes one Utterance, and fusion
// takes its speaker from the captions.
//
// Each call is signed by the AWS SDK's own SigV4 signer (`@smithy/signature-v4`)
// and sent with plain `fetch`. The SDK's client would do the same job at eleven
// times the bundle size, for the one request this engine ever makes.
//
// Two halves, as in the other cloud engines. The request and the reading of the
// reply are pure and tested without a network (`invokeInput`,
// `textFromResponse`, `awsErrorOf`, `sageMakerFailure`). The engine around them
// only signs and sends one window and hands back what came back.
import { SignatureV4 } from "@smithy/signature-v4";
import type { MeetingLanguage } from "../domain/types";
import type { AwsCredentials } from "./aws-credentials";
import type { FetchFn } from "./openai";
import type { PauseWindowing } from "./pauses";
import { wav16 } from "./pcm";
import { TranscriptionError, type EngineSpan, type TranscriptionEngine } from "./provider";

/** Qwen3-ASR listens at 16 kHz, like every engine here. */
export const SAGEMAKER_SAMPLE_RATE = 16_000;

/**
 * Qwen3-ASR's clip length. vLLM splits a longer clip into 30-s chunks and
 * shifts their times by a fixed 30 s each, so a window of 30 s or less reaches
 * the model whole. At 32 kB/s a 30-s WAV is under 1 MB, far inside SageMaker's
 * 6 MB request limit.
 */
export const SAGEMAKER_MAX_INPUT_MS = 30_000;

/**
 * About 10 s per window, so that most windows hold one speaker: fusion gives a
 * text-only window one name.
 */
export const SAGEMAKER_WINDOWING: PauseWindowing = {
  targetMs: 10_000,
  maxMs: SAGEMAKER_MAX_INPUT_MS,
};

/**
 * How long one window may take before it is given up on. SageMaker stops a
 * call after 60 s; the rest is the upload and the reply. Giving up throws a
 * TranscriptionError, which holds the Recording for a retry.
 */
export const SAGEMAKER_TIMEOUT_MS = 90_000;

/**
 * Sends `/invocations` to vLLM's transcription route. The JumpStart image's
 * middleware reads this header and leaves the body as it is.
 */
export const TRANSCRIPTION_ROUTE = "route=/v1/audio/transcriptions";

/**
 * The reply's length cap, per second of audio and in all. Speech runs at about
 * 4–6 tokens a second, so the cap never cuts real words. It exists for noise:
 * on a live endpoint, 10 s of silence with no language set ran past 70 s,
 * unanswered, and with a cap it came back in 4 s.
 */
export const MAX_TOKENS_PER_SECOND = 16;
export const MAX_TOKENS_BASE = 32;

/**
 * Windows in flight at once. Each call costs about 1.7 s however short its
 * audio, and on a live endpoint four 10-s windows at once took as long as one.
 */
export const SAGEMAKER_CONCURRENCY = 4;

const BOUNDARY = "meeting-summarizer-sagemaker";

/**
 * Whether Qwen3-ASR lists each Meeting Language. A Record over the type, so a new
 * Meeting Language is a compile error here until somebody checks Qwen's list.
 */
const LISTED_BY_QWEN3_ASR: Record<MeetingLanguage, boolean> = {
  ar: true,
  cs: true,
  da: true,
  de: true,
  el: true,
  en: true,
  es: true,
  fi: true,
  fr: true,
  he: false,
  hi: true,
  hu: true,
  id: true,
  it: true,
  ja: true,
  ko: true,
  ms: true,
  nl: true,
  no: false,
  pl: true,
  pt: true,
  ro: true,
  ru: true,
  sv: true,
  th: true,
  tr: true,
  uk: false,
  vi: true,
  zh: true,
};

/** The Meeting Languages that Qwen3-ASR does not list. It guesses for these. */
export const UNLISTED_LANGUAGES: readonly MeetingLanguage[] = (
  Object.keys(LISTED_BY_QWEN3_ASR) as MeetingLanguage[]
).filter((code) => !LISTED_BY_QWEN3_ASR[code]);

/** Which part of the setup a failure points at. The Test button reports this. */
export type SageMakerFailureKind = "credentials" | "endpoint" | "container" | "format" | "other";

/** A TranscriptionError that also says which part of the setup failed. */
export class SageMakerFailure extends TranscriptionError {
  readonly kind: SageMakerFailureKind;
  constructor(kind: SageMakerFailureKind, message: string, options?: { cause?: unknown }) {
    super(`sagemaker transcription: ${message}`, options);
    this.name = "SageMakerFailure";
    this.kind = kind;
  }
}

/** One `InvokeEndpoint` call, before it is signed. */
export interface InvokeCall {
  endpointName: string;
  contentType: string;
  accept: string;
  customAttributes: string;
  body: Uint8Array<ArrayBuffer>;
}

/**
 * One window as the `InvokeEndpoint` call that transcribes it.
 *
 * The language goes in twice. vLLM forces Qwen3-ASR's language from
 * `to_language` only; `language` passes validation and picks how chunk texts
 * are joined. For a Meeting Language that Qwen3-ASR does not list, neither is
 * sent, and the model guesses (ADR-0009).
 *
 * The multipart body is built here as bytes, with a fixed boundary, because the
 * signature covers a hash of the exact bytes that are sent: a FormData body
 * would get its boundary from the browser after signing.
 */
export function invokeInput(opts: {
  endpointName: string;
  samples: Float32Array;
  language: MeetingLanguage;
}): InvokeCall {
  const fields: [string, string][] = LISTED_BY_QWEN3_ASR[opts.language]
    ? [
        ["to_language", opts.language],
        ["language", opts.language],
      ]
    : [];
  const seconds = opts.samples.length / SAGEMAKER_SAMPLE_RATE;
  fields.push(
    ["response_format", "json"],
    ["max_completion_tokens", String(Math.ceil(seconds * MAX_TOKENS_PER_SECOND) + MAX_TOKENS_BASE)],
  );
  return {
    endpointName: opts.endpointName,
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
    accept: "application/json",
    customAttributes: TRANSCRIPTION_ROUTE,
    body: multipartBody(wav16(opts.samples, SAGEMAKER_SAMPLE_RATE), fields),
  };
}

/**
 * The reply → the window's text.
 *
 * vLLM's transcription route answers `{"text": …}`. Anything else means the call
 * did not reach that route, which is a setup problem, not silence: an endpoint
 * that ignores the route header answers with a chat completion or an error page.
 */
export function textFromResponse(body: Uint8Array | undefined): string {
  const raw = new TextDecoder().decode(body ?? new Uint8Array());
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new SageMakerFailure("format", `the reply is not JSON: ${raw.slice(0, 200)}`, { cause });
  }
  const text = (parsed as { text?: unknown } | null)?.text;
  if (typeof text !== "string") {
    throw new SageMakerFailure("format", `the reply has no text: ${raw.slice(0, 200)}`);
  }
  return text;
}

/** A failed reply, as AWS describes it. */
export interface AwsError {
  /** AWS's error type, e.g. `ValidationError` or `ExpiredTokenException`. */
  name: string;
  message: string;
  status: number;
  /** A container failure's own status and message, as SageMaker passes them on. */
  originalStatus?: number;
  originalMessage?: string;
}

/**
 * A failed reply → AWS's error type, message and status. The type comes from the
 * `x-amzn-ErrorType` header, or else from the body's `__type`, without the
 * namespace AWS puts around it on either.
 */
export function awsErrorOf(status: number, errorType: string | null, body: Uint8Array): AwsError {
  const raw = new TextDecoder().decode(body);
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    // Not JSON: an error page from somewhere in front of SageMaker. The raw text
    // is the message.
  }
  const typed = errorType ?? (typeof parsed["__type"] === "string" ? parsed["__type"] : "");
  const name = (typed.split(":")[0] ?? "").split("#").pop() || `HTTP ${status}`;
  const message = parsed["message"] ?? parsed["Message"] ?? raw;
  return {
    name,
    message: String(message).slice(0, 300),
    status,
    ...(typeof parsed["OriginalStatusCode"] === "number"
      ? { originalStatus: parsed["OriginalStatusCode"] }
      : {}),
    ...(typeof parsed["OriginalMessage"] === "string"
      ? { originalMessage: parsed["OriginalMessage"] }
      : {}),
  };
}

/**
 * A failed call → what it means for the user, with the part of the setup to
 * check. AWS's messages never carry the credentials, so they can be shown.
 */
export function sageMakerFailure(
  err: unknown,
  where: { endpointName: string; region: string },
): SageMakerFailure {
  const e = (typeof err === "object" && err !== null ? err : {}) as Partial<AwsError>;
  const name = e.name ?? "Error";
  const message = (e.message ?? String(err)).slice(0, 300);
  const options = { cause: err };
  switch (name) {
    case "ExpiredTokenException":
    case "ExpiredToken":
    case "RequestExpired":
      return new SageMakerFailure(
        "credentials",
        "the AWS credentials have expired — paste fresh ones in Settings, then retry",
        options,
      );
    case "UnrecognizedClientException":
    case "InvalidClientTokenId":
    case "InvalidSignatureException":
    case "IncompleteSignatureException":
    case "SignatureDoesNotMatch":
    case "MissingAuthenticationTokenException":
      return new SageMakerFailure(
        "credentials",
        `AWS refused the credentials (${name}) — check them in Settings`,
        options,
      );
    case "AccessDeniedException":
      return new SageMakerFailure(
        "credentials",
        `these AWS credentials may not invoke endpoint ${where.endpointName} (sagemaker:InvokeEndpoint)`,
        options,
      );
    case "ModelError":
      // vLLM's own /invocations takes JSON only. A container that refuses the
      // multipart body did not take the transcription route: it is the wrong
      // image, or the route header did not reach it.
      if (/Unsupported Media Type/i.test(`${e.originalMessage ?? ""} ${message}`)) {
        return new SageMakerFailure(
          "format",
          `the container refused the upload, so the call did not reach vLLM's transcription route: ${(e.originalMessage ?? message).slice(0, 200)}`,
          options,
        );
      }
      return new SageMakerFailure(
        "container",
        `the endpoint's container failed (${e.originalStatus ?? "no status"}): ${(e.originalMessage ?? message).slice(0, 300)}`,
        options,
      );
    case "ValidationError":
      return /not found/i.test(message)
        ? new SageMakerFailure(
            "endpoint",
            `endpoint ${where.endpointName} was not found in ${where.region}`,
            options,
          )
        : new SageMakerFailure("endpoint", `SageMaker refused the call: ${message}`, options);
  }
  if (e.status === 403) {
    return new SageMakerFailure("credentials", `AWS refused the call (403): ${message}`, options);
  }
  return new SageMakerFailure("other", `${name}: ${message}`, options);
}

const TEST_LEADS: Record<SageMakerFailureKind, string> = {
  credentials: "Credentials",
  endpoint: "Endpoint",
  container: "Container",
  format: "Reply format",
  other: "Failed",
};

/**
 * The Settings page's Test button report, from one call's outcome: which part of
 * the setup failed, in words the user can act on.
 */
export function testReport(
  outcome: { ok: true; text: string } | { ok: false; error: unknown },
): string {
  // The words are not quoted: Qwen3-ASR answers the test's silence with words it
  // invents ("Okay."), and quoting them would read as a fault in a healthy setup.
  if (outcome.ok) return "The endpoint answered, in the format the engine reads.";
  const { error } = outcome;
  if (!(error instanceof SageMakerFailure)) {
    return `Failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const detail = error.message.replace(/^sagemaker transcription: /, "");
  return error.kind === "format"
    ? `${TEST_LEADS.format}: the endpoint did not answer the way the JumpStart Qwen3-ASR image does. Check that it runs that model (${detail}).`
    : `${TEST_LEADS[error.kind]}: ${detail}.`;
}

/**
 * Sends one prepared call and returns the reply's body. Throws an AwsError for a
 * failed reply. Signed fetch in the extension; a fake in tests.
 */
export type InvokeFn = (call: InvokeCall, signal: AbortSignal) => Promise<Uint8Array>;

/**
 * `InvokeEndpoint` over `fetch`, signed with SigV4 for the `sagemaker` service in
 * the endpoint's region.
 */
export function signedInvoke(opts: {
  region: string;
  credentials: AwsCredentials;
  fetchFn?: FetchFn;
}): InvokeFn {
  const signer = new SignatureV4({
    service: "sagemaker",
    region: opts.region,
    // The pasted credentials, as they are: nothing of the SDK's credential
    // chain is reached.
    credentials: {
      accessKeyId: opts.credentials.accessKeyId,
      secretAccessKey: opts.credentials.secretAccessKey,
      sessionToken: opts.credentials.sessionToken,
    },
    sha256: WebCryptoSha256,
    // No x-amz-content-sha256 header: AWS's own clients send it to S3 only.
    applyChecksum: false,
  });
  const fetchFn = opts.fetchFn ?? fetch;
  const hostname = `runtime.sagemaker.${opts.region}.amazonaws.com`;
  return async (call, signal) => {
    const path = `/endpoints/${encodeURIComponent(call.endpointName)}/invocations`;
    const signed = await signer.sign({
      method: "POST",
      protocol: "https:",
      hostname,
      path,
      query: {},
      headers: {
        host: hostname,
        "content-type": call.contentType,
        accept: call.accept,
        "x-amzn-sagemaker-custom-attributes": call.customAttributes,
      },
      body: call.body,
    });
    // Host is signed, but the browser sets it from the URL and refuses it as a
    // header; the two agree because both come from `hostname`.
    const headers = Object.fromEntries(
      Object.entries(signed.headers).filter(([name]) => name.toLowerCase() !== "host"),
    );
    const res = await fetchFn(`https://${hostname}${path}`, {
      method: "POST",
      headers,
      body: call.body,
      signal,
    });
    const body = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw awsErrorOf(res.status, res.headers.get("x-amzn-errortype"), body);
    return body;
  };
}

export function createSageMakerTranscriptionEngine(opts: {
  region: string;
  endpointName: string;
  credentials: AwsCredentials;
  /** The Meeting Language, sent as `to_language` when Qwen3-ASR lists it. */
  language: MeetingLanguage;
  fetchFn?: FetchFn;
  /** Injected by tests in place of the signed fetch. */
  invoke?: InvokeFn;
  /** Injected by tests; defaults to SAGEMAKER_TIMEOUT_MS. */
  timeoutMs?: number;
}): TranscriptionEngine {
  const where = { endpointName: opts.endpointName, region: opts.region };
  const timeoutMs = opts.timeoutMs ?? SAGEMAKER_TIMEOUT_MS;
  const invoke =
    opts.invoke ??
    signedInvoke({
      region: opts.region,
      credentials: opts.credentials,
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });

  return {
    name: "sagemaker",
    sampleRate: SAGEMAKER_SAMPLE_RATE,
    maxInputMs: SAGEMAKER_MAX_INPUT_MS,
    windowing: SAGEMAKER_WINDOWING,
    concurrency: SAGEMAKER_CONCURRENCY,
    // Nothing to fetch or initialise: the model runs on the user's endpoint,
    // which is up whenever the user wants it used.
    load() {
      return Promise.resolve();
    },
    async transcribe(samples, signal): Promise<EngineSpan[]> {
      const durationSec = samples.length / SAGEMAKER_SAMPLE_RATE;
      const timeout = AbortSignal.timeout(timeoutMs);
      const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let body: Uint8Array;
      try {
        body = await invoke(
          invokeInput({ endpointName: opts.endpointName, samples, language: opts.language }),
          abort,
        );
      } catch (cause) {
        // A user's cancel is rethrown as it came: the wrapper, which knows the
        // signal was the user's, turns it into TranscriptionCancelled.
        if (signal?.aborted) throw cause;
        if (timeout.aborted) {
          throw new SageMakerFailure(
            "other",
            `no response after ${Math.round(timeoutMs / 1000)} s`,
            { cause },
          );
        }
        throw sageMakerFailure(cause, where);
      }
      const text = textFromResponse(body).trim();
      // A window of silence has no words. Whether a whole recording was silence
      // is the wrapper's call, made once against its whole duration.
      return text === "" ? [] : [{ text, startSec: 0, endSec: durationSec }];
    },
  };
}

/**
 * SHA-256, or HMAC-SHA256 when given a key, on the browser's Web Crypto. The
 * signer asks for its hash by constructor; this is the one it is given, so no
 * hashing code is bundled.
 */
export class WebCryptoSha256 {
  private readonly key: Uint8Array<ArrayBuffer> | null;
  private chunks: Uint8Array<ArrayBuffer>[] = [];

  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.key = secret === undefined ? null : bytesOf(secret);
  }

  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.chunks.push(bytesOf(data));
  }

  async digest(): Promise<Uint8Array> {
    const data = concat(this.chunks);
    if (this.key === null) return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    const key = await crypto.subtle.importKey(
      "raw",
      this.key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  }

  reset(): void {
    this.chunks = [];
  }
}

function bytesOf(data: string | ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  const view =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // A copy, so a caller reusing its buffer cannot change what gets hashed.
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Fields and a WAV as one multipart/form-data body. */
function multipartBody(wav: Uint8Array, fields: [string, string][]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [
    encoder.encode(
      `--${BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="window.wav"\r\n' +
        "Content-Type: audio/wav\r\n\r\n",
    ),
    wav,
    encoder.encode("\r\n"),
  ];
  for (const [name, value] of fields) {
    parts.push(
      encoder.encode(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(encoder.encode(`--${BOUNDARY}--\r\n`));
  return concat(parts);
}
