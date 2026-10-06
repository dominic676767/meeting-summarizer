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
// Two halves, as in the other cloud engines. The request and the reading of the
// reply are pure and tested without a network (`invokeInput`,
// `textFromResponse`, `sageMakerFailure`). The engine around them only sends one
// window through the AWS SDK and hands back what came back.
import {
  InvokeEndpointCommand,
  SageMakerRuntimeClient,
  type InvokeEndpointCommandInput,
} from "@aws-sdk/client-sagemaker-runtime";
import type { MeetingLanguage } from "../domain/types";
import type { AwsCredentials } from "./aws-credentials";
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
 * call after 60 s; the rest is the upload, the reply and the SDK's retries.
 * Giving up throws a TranscriptionError, which holds the Recording for a retry.
 */
export const SAGEMAKER_TIMEOUT_MS = 90_000;

/**
 * Sends `/invocations` to vLLM's transcription route. The JumpStart image's
 * middleware reads this header and leaves the body as it is.
 */
export const TRANSCRIPTION_ROUTE = "route=/v1/audio/transcriptions";

/** The SDK's standard retry for short failures: throttling and 5xx answers. */
const MAX_ATTEMPTS = 3;

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

/**
 * One window as the `InvokeEndpoint` call that transcribes it.
 *
 * The language goes in twice. vLLM forces Qwen3-ASR's language from
 * `to_language` only; `language` passes validation and picks how chunk texts
 * are joined. For a Meeting Language that Qwen3-ASR does not list, neither is
 * sent, and the model guesses (ADR-0009).
 *
 * The multipart body is built here as bytes, with a fixed boundary, so that the
 * SDK signs exactly the bytes that are sent.
 */
export function invokeInput(opts: {
  endpointName: string;
  samples: Float32Array;
  language: MeetingLanguage;
}): InvokeEndpointCommandInput {
  const fields: [string, string][] = LISTED_BY_QWEN3_ASR[opts.language]
    ? [
        ["to_language", opts.language],
        ["language", opts.language],
      ]
    : [];
  fields.push(["response_format", "json"]);
  return {
    EndpointName: opts.endpointName,
    ContentType: `multipart/form-data; boundary=${BOUNDARY}`,
    Accept: "application/json",
    CustomAttributes: TRANSCRIPTION_ROUTE,
    Body: multipartBody(wav16(opts.samples, SAGEMAKER_SAMPLE_RATE), fields),
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

/**
 * An error from the SDK → what it means for the user, with the part of the setup
 * to check. The SDK's messages never carry the credentials, so they can be shown.
 */
export function sageMakerFailure(
  err: unknown,
  where: { endpointName: string; region: string },
): SageMakerFailure {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
    OriginalStatusCode?: number;
    OriginalMessage?: string;
  };
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
      return new SageMakerFailure(
        "container",
        `the endpoint's container failed (${e.OriginalStatusCode ?? "no status"}): ${(e.OriginalMessage ?? message).slice(0, 300)}`,
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
  const status = e.$metadata?.httpStatusCode;
  if (status === 403) {
    return new SageMakerFailure("credentials", `AWS refused the call (403): ${message}`, options);
  }
  return new SageMakerFailure("other", `${name}: ${message}`, options);
}

/** Sends one prepared call. The SDK in the extension; a fake in tests. */
export type InvokeFn = (
  input: InvokeEndpointCommandInput,
  abortSignal: AbortSignal,
) => Promise<{ Body?: Uint8Array }>;

export function createSageMakerTranscriptionEngine(opts: {
  region: string;
  endpointName: string;
  credentials: AwsCredentials;
  /** The Meeting Language, sent as `to_language` when Qwen3-ASR lists it. */
  language: MeetingLanguage;
  /** Injected by tests; defaults to the AWS SDK. */
  invoke?: InvokeFn;
  /** Injected by tests; defaults to SAGEMAKER_TIMEOUT_MS. */
  timeoutMs?: number;
}): TranscriptionEngine {
  const where = { endpointName: opts.endpointName, region: opts.region };
  const timeoutMs = opts.timeoutMs ?? SAGEMAKER_TIMEOUT_MS;
  let client: SageMakerRuntimeClient | undefined;
  const invoke: InvokeFn =
    opts.invoke ??
    ((input, abortSignal) => {
      // One client for the engine, which lives for one transcription run. The
      // pasted credentials go in directly, so none of the SDK's credential chain
      // is reached.
      client ??= new SageMakerRuntimeClient({
        region: opts.region,
        credentials: {
          accessKeyId: opts.credentials.accessKeyId,
          secretAccessKey: opts.credentials.secretAccessKey,
          sessionToken: opts.credentials.sessionToken,
        },
        maxAttempts: MAX_ATTEMPTS,
      });
      return client.send(new InvokeEndpointCommand(input), { abortSignal });
    });

  return {
    name: "sagemaker",
    sampleRate: SAGEMAKER_SAMPLE_RATE,
    maxInputMs: SAGEMAKER_MAX_INPUT_MS,
    windowing: SAGEMAKER_WINDOWING,
    // Nothing to fetch or initialise: the model runs on the user's endpoint,
    // which is up whenever the user wants it used.
    load() {
      return Promise.resolve();
    },
    async transcribe(samples, signal): Promise<EngineSpan[]> {
      const durationSec = samples.length / SAGEMAKER_SAMPLE_RATE;
      const timeout = AbortSignal.timeout(timeoutMs);
      const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let reply: { Body?: Uint8Array };
      try {
        reply = await invoke(
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
      const text = textFromResponse(reply.Body).trim();
      // A window of silence has no words. Whether a whole recording was silence
      // is the wrapper's call, made once against its whole duration.
      return text === "" ? [] : [{ text, startSec: 0, endSec: durationSec }];
    },
    close() {
      client?.destroy();
    },
  };
}

/** Fields and a WAV as one multipart/form-data body. */
function multipartBody(wav: Uint8Array, fields: [string, string][]): Uint8Array {
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
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}
