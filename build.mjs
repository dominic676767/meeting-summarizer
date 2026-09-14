// Builds the Chromium (MV3) WebExtension into dist/.
//
// The extension is plain JS + HTML apart from one unavoidable dependency: local
// WASM Whisper, which needs transformers.js and the ONNX runtime. Those are
// confined to the whisper-worker bundle, so nothing else pays for them, and the
// runtime's .wasm binary is copied in rather than fetched from a CDN — remote
// code is a store-policy violation and a second download for every user.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: {
    background: "src/background/background.ts",
    "teams-content": "src/content/teams-content.ts",
    "capture-prompt": "src/content/capture-prompt.ts",
    offscreen: "src/offscreen/offscreen.ts",
    popup: "src/popup/popup.ts",
    options: "src/options/options.ts",
  },
  bundle: true,
  // The MV3 service worker, content scripts, and offscreen document are all
  // loaded as classic scripts, not ES modules.
  format: "iife",
  target: "chrome116",
  outdir,
  sourcemap: false,
  minify: false,
});

// The Whisper worker is the one ES module: the ONNX runtime loads its WASM glue
// with a dynamic import, which a classic worker cannot do.
await build({
  entryPoints: { "whisper-worker": "src/transcription/whisper-worker.ts" },
  bundle: true,
  format: "esm",
  target: "chrome116",
  outdir,
  sourcemap: false,
  minify: false,
});

// The asyncify pair: the variant transformers.js selects on Chromium.
await mkdir(`${outdir}/ort`, { recursive: true });
for (const file of [
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
]) {
  await cp(`node_modules/onnxruntime-web/dist/${file}`, `${outdir}/ort/${file}`);
}

await cp("src/manifest.json", `${outdir}/manifest.json`);
await cp("src/offscreen/offscreen.html", `${outdir}/offscreen.html`);
await cp("src/popup/popup.html", `${outdir}/popup.html`);
await cp("src/options/options.html", `${outdir}/options.html`);
await cp("src/icon.svg", `${outdir}/icon.svg`);

console.log("built → dist/");
