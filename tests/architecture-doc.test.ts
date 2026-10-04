import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// docs/ARCHITECTURE.md is the visual map a newcomer reads before the code. A map
// that silently drops a module or a message is worse than none, so the parts of
// it that can be checked mechanically are checked here. Whether the diagrams are
// still true is the author's and reviewer's job (see the doc's last section).
const root = join(__dirname, "..");
const doc = readFileSync(join(root, "docs/ARCHITECTURE.md"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "icons" ? [] : sourceFiles(path);
    return /\.(ts|html|json)$/.test(entry.name) ? [relative(root, path)] : [];
  });
}

describe("docs/ARCHITECTURE.md", () => {
  it("names every source file", () => {
    const missing = sourceFiles(join(root, "src")).filter((file) => !doc.includes(`\`${file}\``));
    expect(missing, "add these to §3 and §13 of docs/ARCHITECTURE.md").toEqual([]);
  });

  it("documents every message type", () => {
    const messages = readFileSync(join(root, "src/messages.ts"), "utf8");
    const types = [...new Set([...messages.matchAll(/type: "([a-z-]+)"/g)].map((m) => m[1]!))];
    expect(types.length).toBeGreaterThan(0);
    const missing = types.filter((type) => !doc.includes(`\`${type}\``));
    expect(missing, "add these to §12 of docs/ARCHITECTURE.md").toEqual([]);
  });
});
