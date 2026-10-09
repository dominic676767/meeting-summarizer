// Whether a Capture Span's MIXED audio actually carries sound.
//
// Two Summary Artifacts were produced from silent recordings, each stamped "from
// recorded audio", each holding the single word "you" — Whisper's canonical
// hallucination on silence — under a summary body of the LLM apologising that
// there was nothing to summarize. The user saw them only after the meeting had
// ended and the audio was gone.
//
// Measured on the mix (tab + microphone) rather than on bytes written: bytes only
// prove the encoder ran, and the encoder ran perfectly in both of those cases.
//
// ── TWO MEASUREMENTS, NOT ONE FLAG ──────────────────────────────────────────
//
// Silence feeds two decisions that need different rules, and conflating them
// produces a defect worse than the one this module exists to fix:
//
//   `hadSilentWindow` — a sustained silent window occurred at some point. Drives
//   the mid-meeting WARNING, and nothing else.
//
//   `hadAnySignal` — the recording held meaningful signal somewhere across its
//   whole length. The ONLY input to the end-of-meeting no-speech decision.
//
// A meeting silent for its first five minutes and then completely normal must
// raise the warning AND still be transcribed from audio. Keying the end-of-meeting
// decision off "a sustained silence occurred" would throw that meeting to captions
// and tell its reader "the recording contained no speech" — false, and worse than
// the original bug, because it DISCARDS GOOD AUDIO rather than misrepresenting
// empty audio.
//
// Pure — levels and elapsed time in, two booleans out — so both rules are pinned
// by tests over sample data, with no browser, no AudioContext and no real meeting.

/**
 * RMS below which a window of the mixed stream counts as silence. About -60 dBFS:
 * far below any speech (conversational level lands around 0.02–0.1) and above the
 * floor a muted tab and an echo-cancelled, noise-suppressed microphone leave
 * behind, which is near enough to digital zero.
 *
 * The transcription wrapper uses the same level to skip a window cut at pauses
 * that holds no signal, so "silent" means one thing across the extension.
 */
export const SILENT_BELOW_RMS = 0.001;

/**
 * How long silence must persist before it means anything. Conversational pauses
 * are seconds; nobody's turn-taking leaves three quarters of a minute of nothing.
 *
 * Now that the microphone is mixed in (ADR-0007), sustained silence is no longer
 * the expected case it used to be for a tab-only recording — it means something is
 * genuinely wrong: muted at the OS level, the wrong output device, a permission
 * lost. That is what makes it worth interrupting a meeting for.
 */
export const SUSTAINED_SILENCE_MS = 45_000;

/**
 * Non-silent audio the whole recording must add up to before it counts as holding
 * signal. A quarter of a second, so one encoder click or one keyboard tap does not
 * pass for a meeting, while anything anyone actually said clears it many times
 * over — the bar has to be low, because the cost of getting this wrong in the
 * strict direction is discarding a real recording.
 */
const SIGNAL_FROM_MS = 250;

/** What the two decisions are allowed to read. */
export interface SignalMeasure {
  /**
   * A sustained silent window has occurred. **Warning only** — never an input to
   * whether the audio gets transcribed.
   */
  hadSilentWindow: boolean;
  /**
   * Meaningful signal reached the mix at some point across the whole recording.
   * The only input to the no-speech / captions-fallback decision.
   */
  hadAnySignal: boolean;
  /** Consecutive silence up to now, for the internal measure in the warning's
   * `detail`. Never user-facing copy. */
  silentForMs: number;
}

/** The measure plus what it needs to keep accumulating. */
export interface SignalWatch extends SignalMeasure {
  /** Non-silent audio observed so far, against `SIGNAL_FROM_MS`. */
  readonly signalMs: number;
}

/** A Capture Span before anything has been heard of it. */
export const FRESH_WATCH: SignalWatch = {
  hadSilentWindow: false,
  hadAnySignal: false,
  silentForMs: 0,
  signalMs: 0,
};

/** Root mean square of one window of mono samples. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/**
 * Folds one window's level into the measure. `elapsedMs` is real time since the
 * previous window, not a nominal interval: a throttled timer that fires late has
 * still let that much audio past, and counting it as one tick would make a
 * background tab look talkative.
 */
export function observeLevel(watch: SignalWatch, rms: number, elapsedMs: number): SignalWatch {
  const silent = rms < SILENT_BELOW_RMS;
  const silentForMs = silent ? watch.silentForMs + elapsedMs : 0;
  const signalMs = silent ? watch.signalMs : watch.signalMs + elapsedMs;
  return {
    // Latching, both of them: a silent window that has passed still happened, and
    // signal that arrived cannot un-arrive.
    hadSilentWindow: watch.hadSilentWindow || silentForMs >= SUSTAINED_SILENCE_MS,
    hadAnySignal: watch.hadAnySignal || signalMs >= SIGNAL_FROM_MS,
    silentForMs,
    signalMs,
  };
}

/** Folds one window of samples in. What the live watcher calls each tick. */
export function observeSamples(
  watch: SignalWatch,
  samples: Float32Array,
  elapsedMs: number,
): SignalWatch {
  return observeLevel(watch, rmsOf(samples), elapsedMs);
}

/**
 * The measure for a whole recording given as windows of samples. The same fold
 * the live watcher runs, so a test over sample data pins the rules the browser
 * actually applies rather than a parallel copy of them.
 */
export function measureSignal(frames: Iterable<Float32Array>, frameMs: number): SignalMeasure {
  let watch = FRESH_WATCH;
  for (const frame of frames) watch = observeSamples(watch, frame, frameMs);
  return watch;
}

/**
 * The internal measure behind a silence warning, for its `detail` — a tooltip and
 * the log, never the visible sentence and never the Summary Artifact. "no signal
 * for 45s" is the engineer's version of the fact; the user's version names what
 * they can do about it.
 */
export function noSignalDetail(measure: SignalMeasure): string {
  return `no signal for ${Math.round(measure.silentForMs / 1000)}s`;
}
