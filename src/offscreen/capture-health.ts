export const AUDIO_CLOCK_STALL_MS = 10_000;
export const ENCODER_STALL_MS = 20_000;
const MAX_SIGNAL_OBSERVATION_MS = 500;

export const AUDIO_CLOCK_FAILURE =
  "The audio stream stopped advancing. Microphone and meeting audio could not be verified.";
export const ENCODER_FAILURE =
  "The recorder stopped producing audio data.";

export interface CaptureHealth {
  readAt: number;
  audioTime: number;
  audioAdvancedAt: number;
  encodedBytes: number;
  encodedAt: number;
  failure: string | null;
}

export function startCaptureHealth(
  now: number,
  audioTime: number,
  encodedBytes = 0,
): CaptureHealth {
  return {
    readAt: now,
    audioTime,
    audioAdvancedAt: now,
    encodedBytes,
    encodedAt: now,
    failure: null,
  };
}

/**
 * An analyser can repeat its last buffer while the audio clock is stalled.
 * Only a fresh audio frame can supply evidence of sound or silence.
 */
export function observeCaptureHealth(
  previous: CaptureHealth,
  now: number,
  audioTime: number,
  encodedBytes: number,
): { health: CaptureHealth; signalElapsedMs: number } {
  const freshFrame = Number.isFinite(audioTime) && audioTime > previous.audioTime;
  const health: CaptureHealth = {
    readAt: now,
    audioTime: freshFrame ? audioTime : previous.audioTime,
    audioAdvancedAt: freshFrame ? now : previous.audioAdvancedAt,
    encodedBytes,
    encodedAt: encodedBytes > previous.encodedBytes ? now : previous.encodedAt,
    failure: previous.failure,
  };
  if (health.failure === null) {
    if (now - health.audioAdvancedAt >= AUDIO_CLOCK_STALL_MS) {
      health.failure = AUDIO_CLOCK_FAILURE;
    } else if (now - health.encodedAt >= ENCODER_STALL_MS) {
      health.failure = ENCODER_FAILURE;
    }
  }
  return {
    health,
    signalElapsedMs:
      freshFrame && health.failure === null
        ? Math.max(0, Math.min(MAX_SIGNAL_OBSERVATION_MS, now - previous.readAt))
        : 0,
  };
}
