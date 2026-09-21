const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const resourcesDir = path.join(__dirname, "..", "resources");
fs.mkdirSync(resourcesDir, { recursive: true });

const combinedSvg = path.join(__dirname, "..", "www", "icon-source.svg");
const foregroundSvg = path.join(resourcesDir, "icon-foreground.svg");
const backgroundSvg = path.join(resourcesDir, "icon-background.svg");

(async () => {
  await sharp(combinedSvg).resize(1024, 1024).png().toFile(path.join(resourcesDir, "icon.png"));
  console.log("wrote icon.png");

  await sharp(foregroundSvg).resize(1024, 1024).png().toFile(path.join(resourcesDir, "icon-foreground.png"));
  console.log("wrote icon-foreground.png");

  await sharp(backgroundSvg).resize(1024, 1024).png().toFile(path.join(resourcesDir, "icon-background.png"));
  console.log("wrote icon-background.png");

  // Splash: dark background with the mark centered, well inside the safe
  // area so it isn't cropped on any device aspect ratio.
  const bg = await sharp(backgroundSvg).resize(2732, 2732).png().toBuffer();
  const mark = await sharp(combinedSvg).resize(760, 760).png().toBuffer();
  await sharp(bg)
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toFile(path.join(resourcesDir, "splash.png"));
  console.log("wrote splash.png");

  const bgDark = await sharp(backgroundSvg).resize(2732, 2732).png().toBuffer();
  await sharp(bgDark)
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toFile(path.join(resourcesDir, "splash-dark.png"));
  console.log("wrote splash-dark.png");
})();
