// What the harness is given: clips, each a WAV, a hand-corrected reference
// transcript, and the clip's Meeting Language.
//
// Every input is checked before anything runs, and every problem in a file is
// reported at once. A reference is typed by hand, and a run that fails on its
// third typo after an engine has already been billed for the audio is the
// outcome this module exists to prevent.
import { resolve } from "node:path";
import type { MeetingLanguage } from "../src/domain/types";

/** One stretch of reference speech, as the reference file writes it: seconds. */
export interface ReferenceSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface Clip {
  name: string;
  audioPath: string;
  referencePath: string;
  language: MeetingLanguage;
}

export class InvalidInput extends Error {
  readonly problems: string[];
  constructor(what: string, problems: string[]) {
    super(`${what}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "InvalidInput";
    this.problems = problems;
  }
}

// A Record over the type rather than a bare list, so a Meeting Language added to
// the extension is a compile error here instead of a clip this harness refuses.
const MEETING_LANGUAGES: Record<MeetingLanguage, true> = {
  ar: true, cs: true, da: true, de: true, el: true, en: true, es: true, fi: true,
  fr: true, he: true, hi: true, hu: true, id: true, it: true, ja: true, ko: true,
  ms: true, nl: true, no: true, pl: true, pt: true, ro: true, ru: true, sv: true,
  th: true, tr: true, uk: true, vi: true, zh: true,
};

export function isMeetingLanguage(code: unknown): code is MeetingLanguage {
  return typeof code === "string" && Object.hasOwn(MEETING_LANGUAGES, code);
}

/**
 * How far a reference may run past the end of its audio. Hand-placed times are
 * rough by a fraction of a second; a reference a whole second longer than the
 * clip was written against some other clip.
 */
export const REFERENCE_OVERRUN_SEC = 1;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * A parsed reference file → its segments, sorted by start.
 *
 * Segments may overlap — two people talking at once is a real meeting — so no
 * ordering or gap rule applies beyond each segment's own start and end. Keys
 * other than the four are tolerated, so a reference can carry its own notes.
 */
export function validateReference(json: unknown, audioSec: number): ReferenceSegment[] {
  if (!Array.isArray(json)) throw new InvalidInput("reference", ["must be a JSON array of segments"]);
  if (json.length === 0) throw new InvalidInput("reference", ["has no segments"]);

  const problems: string[] = [];
  const segments: ReferenceSegment[] = [];
  json.forEach((entry: unknown, i) => {
    const at = `segment ${i}`;
    if (!isObject(entry)) {
      problems.push(`${at}: must be an object with speaker, start, end and text`);
      return;
    }
    const { speaker, start, end, text } = entry;
    const before = problems.length;
    if (typeof speaker !== "string" || speaker.trim() === "") {
      problems.push(`${at}: speaker must be a non-empty string`);
    }
    if (typeof text !== "string" || text.trim() === "") {
      problems.push(`${at}: text must be a non-empty string`);
    }
    if (!isTime(start)) problems.push(`${at}: start must be a number of seconds, 0 or more`);
    if (!isTime(end)) problems.push(`${at}: end must be a number of seconds, 0 or more`);
    if (isTime(start) && isTime(end) && end <= start) {
      problems.push(`${at}: end (${end}) must be after start (${start})`);
    }
    if (isTime(end) && end > audioSec + REFERENCE_OVERRUN_SEC) {
      problems.push(`${at}: ends at ${end}s, past the audio's ${audioSec.toFixed(1)}s`);
    }
    if (problems.length === before) {
      segments.push({
        speaker: (speaker as string).trim(),
        start: start as number,
        end: end as number,
        text: text as string,
      });
    }
  });
  if (problems.length) throw new InvalidInput("reference", problems);
  return segments.sort((a, b) => a.start - b.start);
}

/**
 * A parsed manifest → its clips, paths resolved against the manifest's own
 * directory so a manifest can sit beside the clips it lists.
 */
export function validateManifest(json: unknown, baseDir: string): Clip[] {
  if (!Array.isArray(json)) throw new InvalidInput("manifest", ["must be a JSON array of clips"]);
  if (json.length === 0) throw new InvalidInput("manifest", ["lists no clips"]);

  const problems: string[] = [];
  const clips: Clip[] = [];
  const names = new Set<string>();
  json.forEach((entry: unknown, i) => {
    const at = `clip ${i}`;
    if (!isObject(entry)) {
      problems.push(`${at}: must be an object with name, audio, reference and language`);
      return;
    }
    const { name, audio, reference, language } = entry;
    const before = problems.length;
    if (typeof name !== "string" || name.trim() === "") {
      problems.push(`${at}: name must be a non-empty string`);
    } else if (names.has(name)) {
      problems.push(`${at}: name "${name}" is used twice`);
    }
    if (typeof audio !== "string" || audio === "") problems.push(`${at}: audio must be a path`);
    if (typeof reference !== "string" || reference === "") {
      problems.push(`${at}: reference must be a path`);
    }
    if (!isMeetingLanguage(language)) {
      problems.push(`${at}: language ${JSON.stringify(language)} is not a Meeting Language code`);
    }
    if (problems.length === before) {
      names.add(name as string);
      clips.push({
        name: name as string,
        audioPath: resolve(baseDir, audio as string),
        referencePath: resolve(baseDir, reference as string),
        language: language as MeetingLanguage,
      });
    }
  });
  if (problems.length) throw new InvalidInput("manifest", problems);
  return clips;
}

/** The named clips, in manifest order; an unknown name is an error, not a skip. */
export function selectClips(clips: Clip[], names: string[] | undefined): Clip[] {
  if (!names) return clips;
  const unknown = names.filter((n) => !clips.some((c) => c.name === n));
  if (unknown.length) {
    throw new InvalidInput("--clips", unknown.map((n) => `no clip named "${n}" in the manifest`));
  }
  return clips.filter((c) => names.includes(c.name));
}
