// Builds the Chromium (MV3) WebExtension into dist/.
// No runtime dependencies are bundled — the extension is plain JS + HTML.
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

await cp("src/manifest.json", `${outdir}/manifest.json`);
await cp("src/offscreen/offscreen.html", `${outdir}/offscreen.html`);
await cp("src/popup/popup.html", `${outdir}/popup.html`);
await cp("src/options/options.html", `${outdir}/options.html`);
await cp("src/icon.svg", `${outdir}/icon.svg`);

console.log("built → dist/");
