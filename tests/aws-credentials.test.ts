// The pasted-credentials parser: every form a user is likely to copy, the
// refusal of long-term keys, and the reasons given when a paste is not enough.
// The values are made up and shaped so that no secret scanner reads them as keys.
import { describe, expect, it } from "vitest";
import {
  credentialsExpired,
  credentialsWarning,
  describeCredentials,
  maskKeyId,
  parseAwsCredentials,
  type AwsCredentials,
} from "../src/transcription/aws-credentials";

const ID = "ASIA-TEST-KEY-ID-WXYZ";
const SECRET = "test/secret/access+key";
const TOKEN = "test-session-token//with+base64==";
const EXPIRY = "2026-10-06T18:30:00Z";

const expected: AwsCredentials = {
  accessKeyId: ID,
  secretAccessKey: SECRET,
  sessionToken: TOKEN,
  expiresAt: Date.parse(EXPIRY),
};
const withoutExpiry: AwsCredentials = { accessKeyId: ID, secretAccessKey: SECRET, sessionToken: TOKEN };

function ok(text: string): AwsCredentials {
  const parsed = parseAwsCredentials(text);
  if (!parsed.ok) throw new Error(`expected credentials, got: ${parsed.reason}`);
  return parsed.credentials;
}

function reason(text: string): string {
  const parsed = parseAwsCredentials(text);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.reason;
}

describe("parseAwsCredentials", () => {
  it("reads `aws configure export-credentials --format env`, expiry included", () => {
    expect(
      ok(
        [
          `export AWS_ACCESS_KEY_ID=${ID}`,
          `export AWS_SECRET_ACCESS_KEY=${SECRET}`,
          `export AWS_SESSION_TOKEN=${TOKEN}`,
          `export AWS_CREDENTIAL_EXPIRATION=${EXPIRY}`,
        ].join("\n"),
      ),
    ).toEqual(expected);
  });

  it("reads quoted shell lines, as the SSO portal prints them", () => {
    expect(
      ok(
        [
          `export AWS_ACCESS_KEY_ID="${ID}"`,
          `export AWS_SECRET_ACCESS_KEY="${SECRET}"`,
          `export AWS_SESSION_TOKEN="${TOKEN}"`,
        ].join("\n"),
      ),
    ).toEqual(withoutExpiry);
  });

  it("reads Windows command-prompt and PowerShell lines", () => {
    const cmd = [`set AWS_ACCESS_KEY_ID=${ID}`, `set AWS_SECRET_ACCESS_KEY=${SECRET}`, `set AWS_SESSION_TOKEN=${TOKEN}`];
    const ps = [
      `$Env:AWS_ACCESS_KEY_ID="${ID}"`,
      `$Env:AWS_SECRET_ACCESS_KEY="${SECRET}"`,
      `$Env:AWS_SESSION_TOKEN="${TOKEN}"`,
    ];
    expect(ok(cmd.join("\r\n"))).toEqual(withoutExpiry);
    expect(ok(ps.join("\r\n"))).toEqual(withoutExpiry);
  });

  it("reads a credentials-file profile, header and all", () => {
    expect(
      ok(
        [
          "[123456789012_SageMakerInvoke]",
          `aws_access_key_id = ${ID}`,
          `aws_secret_access_key = ${SECRET}`,
          `aws_session_token = ${TOKEN}`,
        ].join("\n"),
      ),
    ).toEqual(withoutExpiry);
  });

  it("reads only the first profile of a pasted file", () => {
    expect(
      ok(
        [
          "[first]",
          `aws_access_key_id = ${ID}`,
          `aws_secret_access_key = ${SECRET}`,
          `aws_session_token = ${TOKEN}`,
          "[second]",
          "aws_access_key_id = ASIA-OTHER-KEY-ID",
        ].join("\n"),
      ).accessKeyId,
    ).toBe(ID);
  });

  it("reads the older aws_security_token name for the session token", () => {
    expect(
      ok([`aws_access_key_id=${ID}`, `aws_secret_access_key=${SECRET}`, `aws_security_token=${TOKEN}`].join("\n")),
    ).toEqual(withoutExpiry);
  });

  it("reads the JSON of `aws configure export-credentials --format process`", () => {
    expect(
      ok(
        JSON.stringify({
          Version: 1,
          AccessKeyId: ID,
          SecretAccessKey: SECRET,
          SessionToken: TOKEN,
          Expiration: EXPIRY,
        }),
      ),
    ).toEqual(expected);
  });

  it("reads STS's JSON, with the credentials one level down", () => {
    expect(
      ok(
        JSON.stringify({
          Credentials: {
            AccessKeyId: ID,
            SecretAccessKey: SECRET,
            SessionToken: TOKEN,
            Expiration: EXPIRY,
          },
          AssumedRoleUser: { Arn: "arn:aws:sts::123456789012:assumed-role/Invoke/me" },
        }),
      ),
    ).toEqual(expected);
  });

  it("keeps credentials whose expiry it cannot read, without an expiry", () => {
    expect(
      ok(
        [
          `export AWS_ACCESS_KEY_ID=${ID}`,
          `export AWS_SECRET_ACCESS_KEY=${SECRET}`,
          `export AWS_SESSION_TOKEN=${TOKEN}`,
          "export AWS_CREDENTIAL_EXPIRATION=soon",
        ].join("\n"),
      ),
    ).toEqual(withoutExpiry);
  });

  it("refuses a long-term access key, and says what to paste instead", () => {
    expect(
      reason(
        [
          "export AWS_ACCESS_KEY_ID=AKIA-TEST-LONG-TERM",
          `export AWS_SECRET_ACCESS_KEY=${SECRET}`,
          `export AWS_SESSION_TOKEN=${TOKEN}`,
        ].join("\n"),
      ),
    ).toMatch(/long-term access key.*ASIA/);
  });

  it("names every missing part of an incomplete set", () => {
    expect(reason(`export AWS_ACCESS_KEY_ID=${ID}`)).toBe(
      "Missing: secret access key, session token.",
    );
  });

  it("asks for credentials when the paste is empty", () => {
    expect(reason("  \n ")).toBe("Paste your temporary AWS credentials.");
  });

  it("says so when the text holds no credentials at all", () => {
    expect(reason("hello, world")).toBe("No AWS credentials found in this text.");
  });

  it("says so when JSON cannot be read", () => {
    expect(reason('{"AccessKeyId": ')).toBe("This looks like JSON, but it could not be read.");
  });
});

describe("maskKeyId", () => {
  it("shows the ends of a key ID and hides the rest", () => {
    expect(maskKeyId("ASIA-TEST-KEY-ID-WXYZ")).toBe("ASIA…WXYZ");
  });

  it("shows only the prefix of a short one", () => {
    expect(maskKeyId("ASIA1")).toBe("ASIA…");
  });
});

describe("credentialsExpired", () => {
  it("is true once a known expiry has passed", () => {
    expect(credentialsExpired({ ...withoutExpiry, expiresAt: 1_000 }, 1_000)).toBe(true);
  });

  it("is false before a known expiry", () => {
    expect(credentialsExpired({ ...withoutExpiry, expiresAt: 2_000 }, 1_000)).toBe(false);
  });

  it("is never true for an expiry nobody stated", () => {
    expect(credentialsExpired(withoutExpiry, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

// A fixed clock, so the sentences can be pinned whatever the test machine's locale.
const at = (ms: number) => `t${ms}`;

describe("describeCredentials", () => {
  it("asks for credentials when none are stored", () => {
    expect(describeCredentials(null, 0, at)).toBe("No credentials. Paste them above.");
  });

  it("names the key in use, masked, and until when", () => {
    expect(describeCredentials({ ...withoutExpiry, expiresAt: 5_000 }, 1_000, at)).toBe(
      "Using ASIA…WXYZ, valid until t5000.",
    );
  });

  it("says when the expiry is not known", () => {
    expect(describeCredentials(withoutExpiry, 1_000, at)).toBe(
      "Using ASIA…WXYZ. Their expiry time was not stated.",
    );
  });

  it("says when they expired, and what to do", () => {
    expect(describeCredentials({ ...withoutExpiry, expiresAt: 500 }, 1_000, at)).toBe(
      "ASIA…WXYZ expired at t500. Paste fresh ones.",
    );
  });
});

describe("credentialsWarning", () => {
  it("warns when there are no credentials at all, as after a browser restart", () => {
    expect(credentialsWarning(null, 0, at)).toMatch(/has no AWS credentials/);
  });

  it("warns once a known expiry has passed", () => {
    expect(credentialsWarning({ ...withoutExpiry, expiresAt: 500 }, 1_000, at)).toMatch(
      /expired at t500\. Paste fresh ones in Settings before this meeting ends/,
    );
  });

  it("says nothing while the credentials are still good, or of unknown expiry", () => {
    expect(credentialsWarning({ ...withoutExpiry, expiresAt: 5_000 }, 1_000, at)).toBeNull();
    expect(credentialsWarning(withoutExpiry, 1_000, at)).toBeNull();
  });
});
