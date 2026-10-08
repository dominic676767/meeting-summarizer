import { describe, expect, it } from "vitest";
import {
  AUDIO_CLOCK_FAILURE,
  AUDIO_CLOCK_STALL_MS,
  ENCODER_FAILURE,
  ENCODER_STALL_MS,
  observeCaptureHealth,
  startCaptureHealth,
} from "../src/offscreen/capture-health";

describe("audio capture health", () => {
  it("uses only samples from an advancing audio clock", () => {
    const initial = startCaptureHealth(0, 0);
    const fresh = observeCaptureHealth(initial, 500, 0.5, 0);
    expect(fresh.signalElapsedMs).toBe(500);
    expect(fresh.health.failure).toBeNull();

    const stale = observeCaptureHealth(fresh.health, 1000, 0.5, 0);
    expect(stale.signalElapsedMs).toBe(0);
    expect(stale.health.audioAdvancedAt).toBe(500);
  });

  it("reports a frozen clock even when encoded chunks arrive", () => {
    const result = observeCaptureHealth(
      startCaptureHealth(0, 0.005333), AUDIO_CLOCK_STALL_MS, 0.005333, 1024,
    );
    expect(result.health.failure).toBe(AUDIO_CLOCK_FAILURE);
    expect(result.signalElapsedMs).toBe(0);
  });

  it("reports an encoder that stops while audio processing continues", () => {
    const result = observeCaptureHealth(
      startCaptureHealth(0, 0), ENCODER_STALL_MS, 20, 0,
    );
    expect(result.health.failure).toBe(ENCODER_FAILURE);
    expect(result.signalElapsedMs).toBe(0);
  });

  it("keeps a healthy encoder active as chunks arrive", () => {
    let health = startCaptureHealth(0, 0);
    for (let now = 5000; now <= 60_000; now += 5000) {
      health = observeCaptureHealth(health, now, now / 1000, now).health;
    }
    expect(health.failure).toBeNull();
  });

  it("does not count a long timer pause as sustained sound", () => {
    const result = observeCaptureHealth(startCaptureHealth(0, 0), 45_000, 45, 4096);
    expect(result.signalElapsedMs).toBe(500);
    expect(result.health.failure).toBeNull();
  });

  it("keeps a capture failure after the clock or encoder recovers", () => {
    const failed = observeCaptureHealth(
      startCaptureHealth(0, 0), AUDIO_CLOCK_STALL_MS, 0, 0,
    );
    const recovered = observeCaptureHealth(failed.health, 15_000, 15, 4096);
    expect(recovered.health.failure).toBe(AUDIO_CLOCK_FAILURE);
    expect(recovered.signalElapsedMs).toBe(0);
  });
});
