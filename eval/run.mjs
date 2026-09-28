// Runs the evaluation harness: `npm run eval -- --help`.
//
// The harness imports the extension's own TypeScript, which resolves its
// imports the bundler's way (no extensions), so Node cannot run it directly.
// It is bundled with the esbuild the extension already builds with, into the
// git-ignored .eval/build, and run from there. Packages stay external, so
// transformers.js loads from node_modules exactly as the Whisper integration
// test loads it.
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outfile = fileURLToPath(new URL("../.eval/build/cli.mjs", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("./cli.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  outfile,
  logLevel: "warning",
});

const { main } = await import(pathToFileURL(outfile).href);
// npm runs scripts from the package root; INIT_CWD is where the user typed the
// command, which is what their relative paths mean.
process.exitCode = await main(process.argv.slice(2), {
  cwd: process.env.INIT_CWD ?? process.cwd(),
  root,
});
