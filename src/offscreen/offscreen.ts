// Offscreen document: the only place with a DOM, so the only place that can
// record. MV3 service workers have no DOM (ADR-0004), and the document is
// created with reason USER_MEDIA rather than AUDIO_PLAYBACK, which self-closes
// after 30s without playback and would kill a long recording.
import { ext } from "../platform";
import type {
  OffscreenMessage,
  OffscreenStatusReply,
  OffscreenTranscribeReply,
  TranscriptionProgress,
} from "../messages";
import { createLocalWhisperProvider } from "../transcription/local-whisper";
import { TranscriptionCancelled } from "../transcription/provider";
import { deleteRecording, openAudioStore, readRecording, type AudioStore } from "./audio-store";

let recorder: MediaRecorder | undefined;
let context: AudioContext | undefined;
let stream: MediaStream | undefined;
let store: AudioStore | undefined;
let startedAt = 0;
let encodedBytes = 0;
let lastError: string | null = null;
// Chunk writes are chained so they land in emission order even though
// MediaRecorder fires ondataavailable synchronously while a prior write is
// still in flight.
let writeChain: Promise<void> = Promise.resolve();

/** Tab audio arrives as a stream whose constraints Chromium accepts only in
 * this non-standard form; the DOM lib has no type for them. */
interface TabCaptureConstraints {
  audio: { mandatory: { chromeMediaSource: "tab"; chromeMediaSourceId: string } };
}

async function start(streamId: string, recordingId: string): Promise<void> {
  if (recorder) return; // already recording; start is idempotent
  lastError = null;
  const constraints: TabCaptureConstraints = {
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  };
  stream = await navigator.mediaDevices.getUserMedia(
    constraints as unknown as MediaStreamConstraints,
  );

  // tabCapture stops playing the tab's audio to the user, so the stream has to
  // be reconnected to a destination or the meeting goes silent for the whole
  // call (ADR-0004). This is not optional polish.
  context = new AudioContext();
  context.createMediaStreamSource(stream).connect(context.destination);

  encodedBytes = 0;
  writeChain = Promise.resolve();
  store = await openAudioStore(recordingId);
  recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
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
  await context?.close().catch(() => undefined);
  context = undefined;
}

function status(): OffscreenStatusReply {
  return {
    recording: recorder !== undefined,
    startedAt: recorder ? startedAt : null,
    encodedBytes,
    error: lastError,
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
  if (running) return { utterances: [], cancelled: true, error: "transcription already running" };
  const report = progressReporter(msg.tabId, Date.now());
  const abort = new AbortController();
  const provider = createLocalWhisperProvider({
    model: msg.model,
    workerUrl: ext.runtime.getURL("whisper-worker.js"),
  });
  running = { provider, abort };
  try {
    const data = await readRecording(msg.recordingId);
    const utterances = await provider.transcribe(
      { data, startOffsetMs: msg.startOffsetMs },
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
    return { utterances, cancelled: false, error: null };
  } catch (err) {
    if (err instanceof TranscriptionCancelled || abort.signal.aborted) {
      return { utterances: [], cancelled: true, error: null };
    }
    return {
      utterances: [],
      cancelled: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    provider.close();
    running = undefined;
  }
}

ext.runtime.onMessage.addListener((raw: unknown) => {
  const msg = raw as OffscreenMessage;
  if (msg.type === "offscreen-start") {
    return (async () => {
      try {
        await start(msg.streamId, msg.recordingId);
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
  if (msg.type === "offscreen-discard-recording") {
    return deleteRecording(msg.recordingId).then(() => ({ ok: true }));
  }
  return undefined;
});
