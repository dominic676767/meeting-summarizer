// Rasterizes src/icons/icon.svg into the PNG sizes Chromium requires (it
// rejects SVG extension icons). Run after editing the SVG; the PNGs are
// committed so the build needs no image tooling.
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const svg = await readFile("src/icons/icon.svg");

// Toolbar and extensions-page sizes render full bleed.
for (const size of [16, 32, 48]) {
  await sharp(svg, { density: (72 * size) / 32 })
    .resize(size, size)
    .png()
    .toFile(`src/icons/icon-${size}.png`);
}

// Chrome Web Store: 96px of art centered in a 128px transparent canvas.
await sharp(svg, { density: (72 * 96) / 32 })
  .resize(96, 96)
  .extend({ top: 16, bottom: 16, left: 16, right: 16, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile("src/icons/icon-128.png");

console.log("rendered → src/icons/");
