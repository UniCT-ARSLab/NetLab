const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const src = path.join(__dirname, 'icon-1024.png');
const buildDir = path.join(__dirname, '..');
const iconsDir = path.join(buildDir, 'icons');

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

(async () => {
  const input = fs.readFileSync(src);

  for (const size of sizes) {
    const out = path.join(iconsDir, `${size}x${size}.png`);
    await sharp(input).resize(size, size).toFile(out);
  }

  await sharp(input).resize(512, 512).toFile(path.join(buildDir, 'icon.png'));

  const ico = png2icons.createICO(input, png2icons.BICUBIC, 0, false, true);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);

  const icns = png2icons.createICNS(input, png2icons.BICUBIC, 0);
  fs.writeFileSync(path.join(buildDir, 'icon.icns'), icns);

  console.log('done');
})();
