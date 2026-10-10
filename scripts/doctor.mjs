// Checks that this clone is ready to load in Chrome: one pass/fail line per
// check, exit 1 if any check failed. Written for the setup agent that follows
// docs/guide/installation.md, and safe to run at any time: it reads, never writes.
//
//   npm run doctor               the build and the toolchain
//   npm run doctor -- --ollama   also Ollama, when Ollama is the chosen Provider
//   npm run doctor -- --ollama --ollama-url=http://host:port   Ollama elsewhere
//
// A warning never fails the run. A failure prints what to do next.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const NODE_FLOOR = 22;
export const OLLAMA_URL = "http://localhost:11434";
/** An ID no real extension has: Ollama must refuse it if it allows only ours. */
const FOREIGN_ID = "a".repeat(32);

/** Chrome's extension ID for a manifest `key`: SHA-256 of the DER public key,
 * first 16 bytes, each hex digit mapped to a letter a–p. */
export function extensionIdFromKey(key) {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((d) => String.fromCharCode(97 + parseInt(d, 16))).join("");
}

export function checkNode(version = process.versions.node) {
  const major = Number(version.split(".")[0]);
  return major >= NODE_FLOOR
    ? pass(`Node ${version}`)
    : fail(`Node ${version} is older than ${NODE_FLOOR}`, `Install Node ${NODE_FLOOR} (see .nvmrc), then run npm ci.`);
}

export function checkBuild(root) {
  const results = [];
  results.push(
    existsSync(resolve(root, "node_modules"))
      ? pass("Dependencies installed")
      : fail("node_modules is missing", "Run npm ci."),
  );
  const built = resolve(root, "dist/manifest.json");
  if (!existsSync(built)) {
    results.push(fail("dist/ is not built", "Run npm run build."));
    return results;
  }
  const source = JSON.parse(readFileSync(resolve(root, "src/manifest.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(built, "utf8"));
  results.push(
    manifest.version === source.version && manifest.key === source.key
      ? pass(`dist/ is built (version ${manifest.version})`)
      : fail("dist/ is older than src/manifest.json", "Run npm run build, then select Reload on the extension card."),
  );
  for (const file of ["ort/ort-wasm-simd-threaded.wasm", "ort/ort-wasm-simd-threaded.mjs"]) {
    results.push(
      existsSync(resolve(root, "dist", file))
        ? pass(`dist/${file}`)
        : fail(`dist/${file} is missing`, "Run npm ci, then npm run build."),
    );
  }
  if (manifest.key) results.push(info(`Extension ID ${extensionIdFromKey(manifest.key)}`));
  results.push(info(`Load unpacked folder: ${resolve(root, "dist")}`));
  return results;
}

export function checkPlatform(platform = process.platform, chromeInstalled = existsSync("/Applications/Google Chrome.app")) {
  if (platform !== "darwin") return [warn(`This guide supports macOS only; this is ${platform}`)];
  return [
    chromeInstalled
      ? pass("Google Chrome is installed")
      : warn("Google Chrome is not in /Applications", "Install Google Chrome, or load the extension in your own Chromium build."),
  ];
}

export async function checkHuggingFace(fetchImpl = fetch) {
  try {
    const response = await fetchImpl("https://huggingface.co/api/models/onnx-community/whisper-base", {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok
      ? pass("Hugging Face is reachable (local Whisper downloads its model from there)")
      : warn(`Hugging Face answered ${response.status}`, "Local Whisper's first meeting needs huggingface.co.");
  } catch (err) {
    return warn(`Hugging Face is not reachable: ${message(err)}`, "Local Whisper's first meeting needs huggingface.co.");
  }
}

/**
 * Ollama must answer, allow this extension's origin, and refuse every other
 * extension. A 403 for our origin is the usual state after a reboot, because
 * `launchctl setenv` does not persist.
 */
export async function checkOllama(extensionId, fetchImpl = fetch, baseUrl = OLLAMA_URL) {
  const probe = (origin) =>
    fetchImpl(`${baseUrl}/api/tags`, {
      headers: { Origin: origin },
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.status);
  const ours = `chrome-extension://${extensionId}`;
  let status;
  try {
    status = await probe(ours);
  } catch (err) {
    return [fail(`Ollama is not running at ${baseUrl}: ${message(err)}`, "Open the Ollama app, then run this again.")];
  }
  if (status === 403) {
    return [
      pass(`Ollama is running at ${baseUrl}`),
      fail(
        `Ollama refuses this extension (OLLAMA_ORIGINS does not allow ${ours})`,
        `Run: launchctl setenv OLLAMA_ORIGINS "${ours}" — then quit and reopen the Ollama app.`,
      ),
    ];
  }
  if (status !== 200) return [fail(`Ollama answered ${status} for this extension`, "Check the Ollama app.")];
  const foreign = await probe(`chrome-extension://${FOREIGN_ID}`).catch(() => 0);
  return [
    pass(`Ollama is running at ${baseUrl}`),
    pass("Ollama allows this extension"),
    foreign === 403
      ? pass("Ollama refuses other extensions")
      : warn(
          "Ollama allows every extension, not only this one",
          "Set OLLAMA_ORIGINS to this extension's origin only, and turn off the Ollama app's setting that exposes it to the browser.",
        ),
  ];
}

const pass = (text) => ({ level: "pass", text });
const fail = (text, fix) => ({ level: "fail", text, fix });
const warn = (text, fix) => ({ level: "warn", text, fix });
const info = (text) => ({ level: "info", text });
const message = (err) => (err instanceof Error ? (err.cause?.code ?? err.message) : String(err));

const MARK = { pass: "ok  ", fail: "FAIL", warn: "warn", info: "    " };

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const results = [checkNode(), ...checkBuild(root), ...checkPlatform(), await checkHuggingFace()];
  if (process.argv.includes("--ollama")) {
    const key = JSON.parse(readFileSync(resolve(root, "src/manifest.json"), "utf8")).key;
    const url = process.argv.find((arg) => arg.startsWith("--ollama-url="))?.slice("--ollama-url=".length);
    results.push(...(await checkOllama(extensionIdFromKey(key), fetch, url?.replace(/\/+$/, "") || OLLAMA_URL)));
  }
  for (const r of results) {
    console.log(`${MARK[r.level]}  ${r.text}`);
    if (r.fix && r.level !== "pass") console.log(`      → ${r.fix}`);
  }
  const failed = results.filter((r) => r.level === "fail").length;
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
