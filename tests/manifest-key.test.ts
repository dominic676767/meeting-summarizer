// The manifest `key` fixes the extension ID for every clone, so Ollama can allow
// this extension's origin and no other (ADR-0010). Chrome derives the ID from the
// key: the first 16 bytes of SHA-256 of the DER public key, each hex digit mapped
// to a letter a–p. Every place that prints the ID must agree with that.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const EXTENSION_ID = "hbobmcebmpakimlijcjiaklipegdelap";

function idFromKey(key: string): string {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((d) => String.fromCharCode(97 + parseInt(d, 16))).join("");
}

describe("the manifest key", () => {
  const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8")) as { key?: string };

  it("gives the extension the ID the docs and Settings page name", () => {
    expect(manifest.key).toBeTypeOf("string");
    expect(idFromKey(manifest.key!)).toBe(EXTENSION_ID);
  });

  it.each(["src/options/options.html", "README.md", "docs/guide/installation.md"])(
    "%s names only this extension's origin for Ollama",
    (file) => {
      const text = readFileSync(file, "utf8");
      expect(text).toContain(`chrome-extension://${EXTENSION_ID}`);
      expect(text).not.toContain("chrome-extension://*");
    },
  );
});
