// Windows cut at pauses, for an engine whose output carries no timestamps.
//
// Such an engine returns one block of text per call, so each window becomes one
// Utterance, and fusion can give one Utterance only one speaker. Fixed windows
// then name one speaker per window and cut a word in half at every boundary.
// Short windows that end where somebody stopped talking fix both: most hold one
// speaker, and a cut lands between words rather than inside one.
//
// Pure: samples in, sample indices out. The provider wrapper uses it only for an
// engine that asks for it, so the engines that return timestamps keep their long
// windows.

/** How an engine wants its windows cut. */
export interface PauseWindowing {
  /** The window length a cut aims for, ms. */
  targetMs: number;
  /** The longest window there may ever be, ms. */
  maxMs: number;
}

/** One window, as sample indices into the samples it was cut from: [start, end). */
export interface SampleWindow {
  start: number;
  end: number;
}

/** The step at which loudness is measured. */
const FRAME_MS = 20;

/**
 * The quiet stretch a cut looks for. Long enough to be a pause between words or
 * between speakers, not the closure inside a word like "stop".
 */
const PAUSE_MS = 200;

/**
 * Cuts `samples` into windows that end at the quietest moment near `targetMs`.
 *
 * Each cut is the middle of the quietest 200 ms between half and one and a half
 * times the target, and never later than `maxMs`. Where two stretches are equally
 * quiet — digital silence, or a constant tone — the one nearer the target wins.
 * What is left once it fits inside that range becomes the last window, however
 * short. The windows cover every sample once, in order.
 */
export function pauseWindows(
  samples: Float32Array,
  sampleRate: number,
  opts: PauseWindowing,
): SampleWindow[] {
  const n = samples.length;
  if (n === 0) return [];
  const toSamples = (ms: number) => Math.max(1, Math.round((ms / 1000) * sampleRate));
  const frameLen = toSamples(FRAME_MS);
  const pauseFrames = Math.max(1, Math.round(PAUSE_MS / FRAME_MS));
  const target = toSamples(opts.targetMs);
  const earliest = Math.max(1, Math.floor(target / 2));
  const latest = Math.max(earliest, Math.min(Math.floor(target * 1.5), toSamples(opts.maxMs)));

  // Energy summed per frame, then as running totals, so the energy of any run of
  // frames is one subtraction.
  const frames = Math.ceil(n / frameLen);
  const total = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) {
    let energy = 0;
    const end = Math.min(n, (f + 1) * frameLen);
    for (let i = f * frameLen; i < end; i++) {
      const s = samples[i] ?? 0;
      energy += s * s;
    }
    total[f + 1] = (total[f] ?? 0) + energy;
  }
  const energyOf = (f: number) => (total[f + pauseFrames] ?? 0) - (total[f] ?? 0);
  // The cut goes in the middle of the quiet stretch, not at its edge, so a word
  // that starts as the pause ends is not clipped.
  const middleOf = (f: number) => f * frameLen + Math.floor((pauseFrames * frameLen) / 2);

  const windows: SampleWindow[] = [];
  let start = 0;
  while (n - start > latest) {
    // Candidate stretches start on the frame grid and must end by `latest`.
    const first = Math.ceil((start + earliest) / frameLen);
    const last = Math.floor((start + latest) / frameLen) - pauseFrames;
    let cut = start + target;
    if (last >= first) {
      let best = first;
      let bestEnergy = energyOf(first);
      let bestDistance = Math.abs(middleOf(first) - (start + target));
      for (let f = first + 1; f <= last; f++) {
        const energy = energyOf(f);
        const distance = Math.abs(middleOf(f) - (start + target));
        if (energy < bestEnergy || (energy === bestEnergy && distance < bestDistance)) {
          best = f;
          bestEnergy = energy;
          bestDistance = distance;
        }
      }
      cut = middleOf(best);
    }
    cut = Math.min(Math.max(cut, start + 1), start + latest);
    windows.push({ start, end: cut });
    start = cut;
  }
  windows.push({ start, end: n });
  return windows;
}
