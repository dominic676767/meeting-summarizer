// Offscreen document: the only place with a DOM, so the only place that can
// record. MV3 service workers have no DOM (ADR-0004), and the document is
// created with reason USER_MEDIA rather than AUDIO_PLAYBACK, which self-closes
// after 30s without playback and would kill a long recording.
import { ext } from "../platform";
import type { OffscreenMessage, OffscreenStatusReply } from "../messages";

let recorder: MediaRecorder | undefined;
let context: AudioContext | undefined;
let stream: MediaStream | undefined;
let startedAt = 0;
/** Encoded bytes seen so far. Proves the encoder is running without holding
 * the audio: no Transcription Provider exists yet to consume it (see the
 * capture surface brief), so chunks are counted and released rather than
 * accumulated. Retaining them is the next slice's job, together with the
 * Held Recording store. */
let encodedBytes = 0;
let lastError: string | null = null;

/** Tab audio arrives as a stream whose constraints Chromium accepts only in
 * this non-standard form; the DOM lib has no type for them. */
interface TabCaptureConstraints {
  audio: { mandatory: { chromeMediaSource: "tab"; chromeMediaSourceId: string } };
}

async function start(streamId: string): Promise<void> {
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
  recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  recorder.ondataavailable = (e) => {
    encodedBytes += e.data.size;
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

ext.runtime.onMessage.addListener((raw: unknown) => {
  const msg = raw as OffscreenMessage;
  if (msg.type === "offscreen-start") {
    return (async () => {
      try {
        await start(msg.streamId);
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
  return undefined;
});
