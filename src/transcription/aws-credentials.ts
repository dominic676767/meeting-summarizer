// Temporary AWS credentials, as the user pastes them for the SageMaker engine.
//
// Only temporary ones (ADR-0009). A long-term `AKIA…` key kept in a browser
// works until somebody revokes it, so it is refused before it is stored. A
// temporary key expires by itself, and the one cost of that is a Held Recording
// that waits for fresh credentials.
//
// Users copy credentials as a block, in whichever form their tool prints, so the
// parser reads the common forms rather than asking for three fields:
//   - shell lines: `export AWS_ACCESS_KEY_ID=…`, `set …`, `$Env:…="…"`
//   - credentials-file lines: `aws_access_key_id = …` under a `[profile]`
//   - JSON: `aws configure export-credentials`, or STS's `{"Credentials": …}`
//
// Pure: text in, credentials or the reason there are none out.

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Epoch ms. Absent when the pasted form does not say. */
  expiresAt?: number;
}

export type ParsedCredentials =
  | { ok: true; credentials: AwsCredentials }
  | { ok: false; reason: string };

type Field = "accessKeyId" | "secretAccessKey" | "sessionToken" | "expiration";

/** Every name a field goes by, lower-cased: shell, credentials file and JSON. */
const NAMES: Record<string, Field> = {
  aws_access_key_id: "accessKeyId",
  accesskeyid: "accessKeyId",
  aws_secret_access_key: "secretAccessKey",
  secretaccesskey: "secretAccessKey",
  aws_session_token: "sessionToken",
  // The older name. Some tools still print it, and it holds the same token.
  aws_security_token: "sessionToken",
  sessiontoken: "sessionToken",
  aws_credential_expiration: "expiration",
  expiration: "expiration",
};

const LABELS: Record<Exclude<Field, "expiration">, string> = {
  accessKeyId: "access key ID",
  secretAccessKey: "secret access key",
  sessionToken: "session token",
};

export function parseAwsCredentials(text: string): ParsedCredentials {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "Paste your temporary AWS credentials." };
  const fields = trimmed.startsWith("{") ? fromJson(trimmed) : fromLines(trimmed);
  if (fields === null) {
    return { ok: false, reason: "This looks like JSON, but it could not be read." };
  }
  if (Object.keys(fields).length === 0) {
    return { ok: false, reason: "No AWS credentials found in this text." };
  }
  const missing = (Object.keys(LABELS) as (keyof typeof LABELS)[]).filter((f) => !fields[f]);
  if (missing.length > 0) {
    return { ok: false, reason: `Missing: ${missing.map((f) => LABELS[f]).join(", ")}.` };
  }
  const accessKeyId = fields.accessKeyId ?? "";
  if (accessKeyId.startsWith("AKIA")) {
    return {
      ok: false,
      reason:
        "This is a long-term access key (AKIA…). Paste temporary credentials instead: their key ID starts with ASIA.",
    };
  }
  const expiresAt = fields.expiration ? Date.parse(fields.expiration) : Number.NaN;
  return {
    ok: true,
    credentials: {
      accessKeyId,
      secretAccessKey: fields.secretAccessKey ?? "",
      sessionToken: fields.sessionToken ?? "",
      ...(Number.isNaN(expiresAt) ? {} : { expiresAt }),
    },
  };
}

/** Enough of a key ID to tell two apart, never the whole of it: `ASIA…WXYZ`. */
export function maskKeyId(accessKeyId: string): string {
  return accessKeyId.length > 8
    ? `${accessKeyId.slice(0, 4)}…${accessKeyId.slice(-4)}`
    : `${accessKeyId.slice(0, 4)}…`;
}

/** Whether a known expiry has passed. Unknown expiry is never called expired. */
export function credentialsExpired(c: AwsCredentials, now: number): boolean {
  return c.expiresAt !== undefined && c.expiresAt <= now;
}

/** A time of day as the user's locale writes it, e.g. 14:05. */
const timeOfDay = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The stored credentials as the Settings page reports them. */
export function describeCredentials(
  c: AwsCredentials | null,
  now: number,
  clock: (ms: number) => string = timeOfDay,
): string {
  if (!c) return "No credentials. Paste them above.";
  const id = maskKeyId(c.accessKeyId);
  if (c.expiresAt === undefined) return `Using ${id}. Their expiry time was not stated.`;
  return credentialsExpired(c, now)
    ? `${id} expired at ${clock(c.expiresAt)}. Paste fresh ones.`
    : `Using ${id}, valid until ${clock(c.expiresAt)}.`;
}

/**
 * What the popup warns while a meeting records with SageMaker selected, or null
 * when nothing is wrong yet. Missing credentials count too: session storage
 * empties when the browser closes, so after a restart this is the usual case.
 */
export function credentialsWarning(
  c: AwsCredentials | null,
  now: number,
  clock: (ms: number) => string = timeOfDay,
): string | null {
  if (!c) {
    return "Recording — but SageMaker has no AWS credentials. Paste them in Settings before this meeting ends.";
  }
  if (c.expiresAt !== undefined && credentialsExpired(c, now)) {
    return `Recording — but the SageMaker credentials expired at ${clock(c.expiresAt)}. Paste fresh ones in Settings before this meeting ends.`;
  }
  return null;
}

/** JSON → fields, or null when the text is not JSON at all. */
function fromJson(text: string): Partial<Record<Field, string>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  // STS prints the credentials inside a `Credentials` object; the process format
  // prints them at the top level.
  const outer = parsed as Record<string, unknown>;
  const inner = outer["Credentials"] ?? outer["credentials"];
  const source = (typeof inner === "object" && inner !== null ? inner : outer) as Record<
    string,
    unknown
  >;
  const fields: Partial<Record<Field, string>> = {};
  for (const [key, value] of Object.entries(source)) {
    const field = NAMES[key.toLowerCase()];
    if (field && (typeof value === "string" || typeof value === "number")) {
      fields[field] = String(value);
    }
  }
  return fields;
}

/** Shell or credentials-file lines → fields. Reads the first profile only. */
function fromLines(text: string): Partial<Record<Field, string>> {
  const fields: Partial<Record<Field, string>> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      // A second profile: the user pasted a whole file. The first set read is the
      // one they meant; mixing two would make a set nobody issued.
      if (Object.keys(fields).length > 0) break;
      continue;
    }
    const match = /^(?:export\s+|set\s+|\$env:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    const field = NAMES[(match[1] ?? "").toLowerCase()];
    if (field) fields[field] = unquote(match[2] ?? "");
  }
  return fields;
}

function unquote(value: string): string {
  const v = value.trim().replace(/;$/, "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(v);
  return quoted ? (quoted[2] ?? "") : v;
}
