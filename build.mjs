// Builds the Firefox WebExtension into dist/.
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
    popup: "src/popup/popup.ts",
    options: "src/options/options.ts",
  },
  bundle: true,
  // MV2 background/content scripts are classic scripts, not modules.
  format: "iife",
  target: "firefox115",
  outdir,
  sourcemap: false,
  minify: false,
});

await cp("manifest.json", `${outdir}/manifest.json`);
await cp("src/popup/popup.html", `${outdir}/popup.html`);
await cp("src/options/options.html", `${outdir}/options.html`);

console.log("built → dist/");
