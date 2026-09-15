// Offscreen document: the only place with a DOM, so the only place that can
// record. MV3 service workers have no DOM (ADR-0004), and the document is
// created with reason USER_MEDIA rather than AUDIO_PLAYBACK, which self-closes
// after 30s without playback and would kill a long recording.
import { ext } from "../platform";
import type {
  OffscreenEventMessage,
  OffscreenMessage,
  OffscreenStatusReply,
  OffscreenTranscribeReply,
  TranscriptionProgress,
} from "../messages";
import { createTranscriptionProviderFor } from "../transcription/factory";
import {
  TranscriptionCancelled,
  TranscriptionSilent,
  type TranscriptionProvider,
} from "../transcription/provider";
import { deleteSpan, openAudioStore, readSpan, type AudioStore } from "./audio-store";
import { mixCapture, type MixGraph } from "./audio-mix";

let recorder: MediaRecorder | undefined;
let context: AudioContext | undefined;
let stream: MediaStream | undefined;
let micStream: MediaStream | undefined;
let store: AudioStore | undefined;
let startedAt = 0;
let encodedBytes = 0;
let lastError: string | null = null;
let micError: string | null = null;
// Chunk writes are chained so they land in emission order even though
// MediaRecorder fires ondataavailable synchronously while a prior write is
// still in flight.
let writeChain: Promise<void> = Promise.resolve();

/** Tab audio arrives as a stream whose constraints Chromium accepts only in
 * this non-standard form; the DOM lib has no type for them. */
interface TabCaptureConstraints {
  audio: { mandatory: { chromeMediaSource: "tab"; chromeMediaSourceId: string } };
}

/**
 * The local microphone, or nothing plus a reason.
 *
 * Never allowed to throw past here: a denied or absent microphone degrades this
 * Capture Span to today's tab-only capture, because losing the local user's voice
 * is bad and losing the whole meeting is unacceptable.
 *
 * Echo cancellation is on because the two streams overlap physically as well as
 * digitally — the remote participants come out of the user's speakers and back in
 * through their microphone, and without cancellation the recording carries them
 * twice, half a room-delay apart, which is worse for a transcription engine than
 * either copy alone.
 */
async function captureMicrophone(): Promise<MediaStream | undefined> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    micError = err instanceof Error ? err.message : String(err);
    return undefined;
  }
}

/** The real mix graph: one AudioContext, so one clock for both sources. */
function webAudioGraph(ctx: AudioContext): MixGraph<AudioNode> {
  const recorded = ctx.createMediaStreamDestination();
  return {
    source: (s) => ctx.createMediaStreamSource(s),
    connect: (from, to) => from.connect(to),
    speakers: ctx.destination,
    recorded,
    recordedStream: recorded.stream,
  };
}

/** Records one Capture Span into its own file. A second Capture Start in the same
 * Meeting arrives with a different span id, so it cannot touch what the first one
 * wrote (ADR-0005). */
async function start(
  streamId: string,
  spanId: string,
  tabId: number,
  mic: boolean,
): Promise<void> {
  if (recorder) return; // already recording; start is idempotent
  lastError = null;
  micError = null;
  const constraints: TabCaptureConstraints = {
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  };
  // The tab stream first, and without awaiting anything else on the way: the
  // stream id the service worker handed over is single-use and expires within
  // seconds of the user's invocation.
  stream = await navigator.mediaDevices.getUserMedia(
    constraints as unknown as MediaStreamConstraints,
  );
  micStream = mic ? await captureMicrophone() : undefined;

  // The capture track can end without us asking — the tab navigated away, or
  // crashed. Left unhandled the recorder keeps a dead stream and the session
  // goes on reporting `recording: true`, so the popup claims a recording that
  // is not happening. Tell the service worker instead of letting it lie.
  for (const track of stream.getTracks()) {
    track.addEventListener("ended", () => {
      void ext.runtime
        .sendMessage({ type: "capture-track-ended", tabId } satisfies OffscreenEventMessage)
        .catch(() => {
          // Service worker asleep; its own tab reconciliation is the backstop.
        });
    });
  }

  // The microphone is a fourth thing that can end on its own, and unlike the tab
  // track it can be revoked deliberately mid-meeting from Chrome's site controls.
  // The recording survives — the remote participants are still captured — so this
  // must NOT end the Meeting. What it must do is stop the span claiming to hold
  // the local user, because from here on it does not.
  for (const track of micStream?.getTracks() ?? []) {
    track.addEventListener("ended", () => {
      void ext.runtime
        .sendMessage({ type: "mic-track-ended", tabId } satisfies OffscreenEventMessage)
        .catch(() => {});
    });
  }

  // One AudioContext sums the tab and the microphone into one destination, and
  // keeps the tab playing to the speakers on the way past — tabCapture stops the
  // tab's own playback, so without that connection the meeting is silent for the
  // whole call (ADR-0004). The microphone is recorded but never played, or the
  // user hears themselves. One graph also means one clock, which is what keeps
  // Utterance offsets aligned for fusion (ADR-0007).
  context = new AudioContext();
  const mixed = mixCapture(webAudioGraph(context), { tab: stream, mic: micStream });

  encodedBytes = 0;
  writeChain = Promise.resolve();
  store = await openAudioStore(spanId);
  // The mix, not the raw tab stream: recording the tab stream directly is what
  // left the local user out of every Audio Recording.
  recorder = new MediaRecorder(mixed, { mimeType: "audio/webm" });
  recorder.ondataavailable = (e) => {
    if (e.data.size === 0) return;
    encodedBytes += e.data.size;
    const s = store;
    if (!s) return;
    // Append incrementally. A quota failure is recorded as a capture warning
    // rather than swallowed, so the user learns before the meeting is lost.
    writeChain = writeChain
      .then(() => s.append(e.data))
      .catch((err) => {
        lastError = err instanceof Error ? err.message : String(err);
      });
  };
  recorder.onerror = () => {
    lastError = "recorder error";
  };
  // A timeslice keeps encoding incremental instead of building one hour-long
  // buffer in memory, which would contradict the lightweightness requirement.
  recorder.start(5_000);
  startedAt = Date.now();
}

async function stop(): Promise<void> {
  const r = recorder;
  recorder = undefined;
  if (r && r.state !== "inactive") {
    await new Promise<void>((resolve) => {
      r.onstop = () => resolve();
      r.stop();
    });
  }
  // Let the last flushed chunks finish landing before the file is closed.
  await writeChain;
  await store?.close().catch(() => undefined);
  store = undefined;
  stream?.getTracks().forEach((t) => t.stop());
  stream = undefined;
  // Released with the tab stream, and for a stronger reason: a microphone track
  // left open holds Chromium's recording indicator up and keeps listening to a
  // room the user believes is off the record.
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = undefined;
  await context?.close().catch(() => undefined);
  context = undefined;
}

function status(): OffscreenStatusReply {
  return {
    recording: recorder !== undefined,
    startedAt: recorder ? startedAt : null,
    encodedBytes,
    error: lastError,
    // Reported from the live stream rather than from the request: asking for the
    // microphone and getting it are different things.
    micRecording: recorder !== undefined && micStream !== undefined,
    micError,
  };
}

// --- Transcription -----------------------------------------------------------
//
// Transcription lives here too, for the same reason recording does: the service
// worker has no DOM, so it can neither decode audio nor spawn the worker the
// WASM model runs in. Progress is pushed to the service worker rather than
// polled, because it is what makes a multi-minute wait readable as work.

let running: { provider: { close(): void }; abort: AbortController } | undefined;

/** The status region updates at most once a second (a screen reader should not
 * be flooded), so there is nothing to gain from posting faster. */
const PROGRESS_INTERVAL_MS = 1000;

function progressReporter(tabId: number, startedAt: number) {
  let lastPost = 0;
  return (progress: Omit<TranscriptionProgress, "startedAt">): void => {
    const now = Date.now();
    if (now - lastPost < PROGRESS_INTERVAL_MS) return;
    lastPost = now;
    void ext.runtime
      .sendMessage({ type: "transcription-progress", tabId, progress: { ...progress, startedAt } })
      .catch(() => undefined); // the service worker may be mid-restart
  };
}

async function transcribe(
  msg: OffscreenMessage & { type: "offscreen-transcribe" },
): Promise<OffscreenTranscribeReply> {
  if (running) {
    return { utterances: [], cancelled: true, noSpeech: null, error: "transcription already running" };
  }
  const report = progressReporter(msg.tabId, Date.now());
  const abort = new AbortController();
  let provider: (TranscriptionProvider & { close(): void }) | undefined;
  try {
    // Inside the try because selecting an unconfigured engine — a cloud one with
    // no key — fails here, and that failure must reach the caller as a held
    // recording rather than a rejected message.
    provider = createTranscriptionProviderFor(msg.transcription, {
      workerUrl: ext.runtime.getURL("whisper-worker.js"),
    });
    running = { provider, abort };
    // Every span of the Meeting, in order, each with the offset that keeps its
    // words where they actually fell in the Meeting.
    const spans = await Promise.all(
      msg.spans.map(async (span) => ({
        data: await readSpan(span.spanId),
        startOffsetMs: span.startOffsetMs,
      })),
    );
    // A span with no bytes is a Capture Start that recorded nothing (stopped
    // before the first chunk flushed, or its file went missing). It holds no
    // words, and handing it to the decoder would fail the whole run — costing
    // every other span of the Meeting for the sake of an empty one.
    const recorded = spans.filter((span) => span.data.size > 0);
    const utterances = await provider.transcribe(
      { spans: recorded },
      {
        signal: abort.signal,
        onModelProgress: (loadedBytes, totalBytes) =>
          report({
            phase: "model-download",
            loadedBytes,
            totalBytes,
            processedMs: null,
            totalMs: null,
          }),
        onAudioProgress: (processedMs, totalMs) =>
          report({
            phase: "transcribing",
            loadedBytes: null,
            totalBytes: null,
            processedMs,
            totalMs,
          }),
      },
    );
    return { utterances, cancelled: false, noSpeech: null, error: null };
  } catch (err) {
    // Silence is reported as itself, before the cancellation and failure checks:
    // the recording was refused for carrying no speech, which is neither an
    // outage to hold the audio for nor an error to show the user.
    if (err instanceof TranscriptionSilent) {
      return { utterances: [], cancelled: false, noSpeech: err.reason, error: null };
    }
    if (err instanceof TranscriptionCancelled || abort.signal.aborted) {
      return { utterances: [], cancelled: true, noSpeech: null, error: null };
    }
    return {
      utterances: [],
      cancelled: false,
      noSpeech: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    provider?.close();
    running = undefined;
  }
}

ext.runtime.onMessage.addListener((raw: unknown) => {
  const msg = raw as OffscreenMessage;
  if (msg.type === "offscreen-start") {
    return (async () => {
      try {
        await start(msg.streamId, msg.spanId, msg.tabId, msg.mic);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await stop();
      }
      return status();
    })();
  }
  if (msg.type === "offscreen-stop") {
    return (async () => {
      await stop();
      return status();
    })();
  }
  if (msg.type === "offscreen-status") {
    return Promise.resolve(status());
  }
  if (msg.type === "offscreen-transcribe") {
    return transcribe(msg);
  }
  if (msg.type === "offscreen-cancel-transcribe") {
    // Terminating the worker stops the WASM run mid-chunk, so the user who will
    // not wait is not made to wait anyway.
    running?.abort.abort();
    running?.provider.close();
    return Promise.resolve({ ok: true });
  }
  if (msg.type === "offscreen-discard-spans") {
    // Every span, not just the last: a Meeting that recorded three must leave no
    // orphan behind.
    return Promise.all(msg.spanIds.map((id) => deleteSpan(id))).then(() => ({ ok: true }));
  }
  return undefined;
});
