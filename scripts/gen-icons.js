const sharp = require("sharp");
const path = require("path");

const src = path.join(__dirname, "..", "www", "icon-source.svg");
const outDir = path.join(__dirname, "..", "www", "icons");

const sizes = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "icon-maskable-512.png", size: 512, padding: 0.15 },
  { file: "apple-touch-icon.png", size: 180 },
];

require("fs").mkdirSync(outDir, { recursive: true });

(async () => {
  for (const { file, size, padding } of sizes) {
    let img = sharp(src).resize(size, size);
    if (padding) {
      const inner = Math.round(size * (1 - padding * 2));
      img = sharp(src)
        .resize(inner, inner)
        .extend({
          top: Math.round((size - inner) / 2),
          bottom: Math.round((size - inner) / 2),
          left: Math.round((size - inner) / 2),
          right: Math.round((size - inner) / 2),
          background: "#12141a",
        });
    }
    await img.png().toFile(path.join(outDir, file));
    console.log("wrote", file);
  }
})();
