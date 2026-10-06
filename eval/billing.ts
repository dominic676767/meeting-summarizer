// What a run will cost, stated before any audio leaves the machine.
//
// A cloud engine bills for audio minutes, and a free ElevenLabs plan has 4.5
// hours a month. So the harness prints the minutes each cloud engine will be
// sent, and runs nothing — local Whisper included — until the user passes
// --yes. Stopping the whole run rather than only the cloud part is deliberate:
// a run that quietly left out the engines being compared would print a table
// that looks complete.
import type { EngineInfo } from "./engines";

/** ElevenLabs' free plan, in minutes of audio a month. */
export const SCRIBE_FREE_PLAN_MIN = 4.5 * 60;

export interface BillingLine {
  engine: EngineInfo;
  /** Audio minutes sent, rounded up to a tenth so the printed figure never undersells. */
  audioMin: number;
  /** Uploads: one per window of the engine's input limit, per clip. */
  requests: number;
}

export function billingPlan(clipDurationsSec: readonly number[], engines: readonly EngineInfo[]): BillingLine[] {
  const totalSec = clipDurationsSec.reduce((a, b) => a + b, 0);
  return engines
    .filter((e) => e.uploads)
    .map((engine) => ({
      engine,
      audioMin: Math.ceil((totalSec / 60) * 10) / 10,
      requests: clipDurationsSec.reduce(
        (n, sec) => n + Math.max(1, Math.ceil((sec * 1000) / engine.maxInputMs)),
        0,
      ),
    }));
}

export function formatBilling(lines: readonly BillingLine[]): string {
  const rows = lines.map(({ engine, audioMin, requests }) => {
    const plan =
      engine.id === "elevenlabs"
        ? ` (${((audioMin / SCRIBE_FREE_PLAN_MIN) * 100).toFixed(1)}% of a 4.5 h free plan)`
        : "";
    const uploads = `${requests} upload${requests === 1 ? "" : "s"}`;
    return `  ${engine.name} ${engine.model}: ${audioMin.toFixed(1)} min of audio in ${uploads}${plan}`;
  });
  return ["Cloud engines will be sent, and bill for:", ...rows].join("\n");
}
