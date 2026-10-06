// Windows cut at pauses: where the cuts land, and that they never break the
// limits an engine set. Built on synthetic audio whose loud and quiet stretches
// are known to the sample, so every expected cut can be stated exactly.
import { describe, expect, it } from "vitest";
import { pauseWindows, type SampleWindow } from "../src/transcription/pauses";

const RATE = 16_000;
const OPTS = { targetMs: 10_000, maxMs: 30_000 };

/**
 * `seconds` of audio at a constant level of 0.5 — loud, and the same energy in
 * every frame — with each listed stretch set to its own level instead.
 */
function audio(
  seconds: number,
  stretches: { from: number; to: number; level: number }[] = [],
): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE)).fill(0.5);
  for (const { from, to, level } of stretches) {
    samples.fill(level, Math.round(from * RATE), Math.round(to * RATE));
  }
  return samples;
}

const sec = (sample: number) => sample / RATE;
const lengths = (windows: SampleWindow[]) => windows.map((w) => sec(w.end - w.start));

function expectContiguous(windows: SampleWindow[], n: number): void {
  expect(windows[0]?.start).toBe(0);
  for (let i = 1; i < windows.length; i++) {
    expect(windows[i]?.start).toBe(windows[i - 1]?.end);
  }
  expect(windows.at(-1)?.end).toBe(n);
}

describe("pauseWindows", () => {
  it("cuts nothing out of nothing", () => {
    expect(pauseWindows(new Float32Array(0), RATE, OPTS)).toEqual([]);
  });

  it("keeps audio that fits the range whole", () => {
    const samples = audio(12);
    expect(pauseWindows(samples, RATE, OPTS)).toEqual([{ start: 0, end: samples.length }]);
  });

  it("cuts in the middle of a pause", () => {
    const samples = audio(30, [{ from: 8, to: 8.5, level: 0 }]);
    const [first] = pauseWindows(samples, RATE, OPTS);
    expect(sec(first?.end ?? 0)).toBeGreaterThanOrEqual(8);
    expect(sec(first?.end ?? 0)).toBeLessThanOrEqual(8.5);
  });

  it("takes the pause nearer the target when two are equally quiet", () => {
    const samples = audio(30, [
      { from: 6, to: 6.5, level: 0 },
      { from: 12, to: 12.5, level: 0 },
    ]);
    const [first] = pauseWindows(samples, RATE, OPTS);
    expect(sec(first?.end ?? 0)).toBeGreaterThanOrEqual(12);
    expect(sec(first?.end ?? 0)).toBeLessThanOrEqual(12.5);
  });

  it("takes the quietest pause over a nearer, louder one", () => {
    const samples = audio(30, [
      { from: 9.5, to: 10, level: 0.05 },
      { from: 14, to: 14.5, level: 0 },
    ]);
    const [first] = pauseWindows(samples, RATE, OPTS);
    expect(sec(first?.end ?? 0)).toBeGreaterThanOrEqual(14);
    expect(sec(first?.end ?? 0)).toBeLessThanOrEqual(14.5);
  });

  it("cuts unbroken sound at the target length", () => {
    const samples = audio(60);
    const windows = pauseWindows(samples, RATE, OPTS);
    expectContiguous(windows, samples.length);
    for (const length of lengths(windows)) {
      expect(length).toBeGreaterThan(9.8);
      expect(length).toBeLessThan(10.2);
    }
  });

  it("never makes a window longer than one and a half targets", () => {
    const samples = audio(300, [{ from: 2, to: 2.5, level: 0 }]);
    const windows = pauseWindows(samples, RATE, OPTS);
    expectContiguous(windows, samples.length);
    for (const length of lengths(windows)) expect(length).toBeLessThanOrEqual(15);
  });

  it("never makes a window longer than maxMs, whatever the target", () => {
    const samples = audio(100);
    const windows = pauseWindows(samples, RATE, { targetMs: 20_000, maxMs: 25_000 });
    expectContiguous(windows, samples.length);
    for (const length of lengths(windows)) expect(length).toBeLessThanOrEqual(25);
  });

  it("covers every sample once, in order, through pauses and sound alike", () => {
    const samples = audio(95.3, [
      { from: 4, to: 4.3, level: 0 },
      { from: 21, to: 21.9, level: 0.01 },
      { from: 40, to: 47, level: 0 },
    ]);
    expectContiguous(pauseWindows(samples, RATE, OPTS), samples.length);
  });
});
