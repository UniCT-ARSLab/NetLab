const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const detailedSrc = path.join(__dirname, 'icon-1024.png');
const smallSrc = path.join(__dirname, 'icon-1024-small.png');
const buildDir = path.join(__dirname, '..');
const iconsDir = path.join(buildDir, 'icons');

// Below this size the "donut hole" dots in the detailed glyph have too few
// pixels to render cleanly and turn into a dark smudge — use the simplified,
// solid-dot variant instead. 48px and up render the detailed version fine.
const SMALL_ICO_SIZES = [16, 24, 32];
const DETAILED_ICO_SIZES = [48, 64, 72, 96, 128, 256];
const PNG_SET_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

function buildIco(entries) {
  // entries: [{ size, buffer }], each buffer a PNG. Modern ICO files can
  // store PNG-compressed images directly (Vista+), so no BMP re-encoding
  // is needed — just a directory header pointing at the raw PNG bytes.
  const count = entries.length;
  const headerSize = 6 + 16 * count;
  const dirBuf = Buffer.alloc(headerSize);
  dirBuf.writeUInt16LE(0, 0); // reserved
  dirBuf.writeUInt16LE(1, 2); // type: icon
  dirBuf.writeUInt16LE(count, 4);

  let offset = headerSize;
  const chunks = [dirBuf];
  entries.forEach((entry, i) => {
    const base = 6 + 16 * i;
    const dim = entry.size >= 256 ? 0 : entry.size; // 0 means 256 in ICO format
    dirBuf.writeUInt8(dim, base + 0); // width
    dirBuf.writeUInt8(dim, base + 1); // height
    dirBuf.writeUInt8(0, base + 2); // color count
    dirBuf.writeUInt8(0, base + 3); // reserved
    dirBuf.writeUInt16LE(1, base + 4); // planes
    dirBuf.writeUInt16LE(32, base + 6); // bit count
    dirBuf.writeUInt32LE(entry.buffer.length, base + 8); // size
    dirBuf.writeUInt32LE(offset, base + 12); // offset
    offset += entry.buffer.length;
    chunks.push(entry.buffer);
  });
  return Buffer.concat(chunks);
}

(async () => {
  const detailed = fs.readFileSync(detailedSrc);
  const small = fs.readFileSync(smallSrc);

  // PNG set used for the Linux icon set (build/icons/) — small sizes use the
  // simplified glyph too, since Linux desktop environments render these at
  // taskbar/panel size just like Windows does.
  for (const size of PNG_SET_SIZES) {
    const source = size <= 32 ? small : detailed;
    await sharp(source).resize(size, size).toFile(path.join(iconsDir, `${size}x${size}.png`));
  }

  await sharp(detailed).resize(512, 512).toFile(path.join(buildDir, 'icon.png'));

  // Windows .ico: build by hand so small entries can use the simplified
  // source and large entries the detailed one — png2icons only resizes a
  // single source image, it can't mix two.
  const icoEntries = [];
  for (const size of SMALL_ICO_SIZES) {
    icoEntries.push({ size, buffer: await sharp(small).resize(size, size).png().toBuffer() });
  }
  for (const size of DETAILED_ICO_SIZES) {
    icoEntries.push({ size, buffer: await sharp(detailed).resize(size, size).png().toBuffer() });
  }
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(icoEntries));

  // macOS .icns: Dock/Finder icons are rarely shown below ~64px, so the
  // detailed glyph alone is fine here.
  const icns = png2icons.createICNS(detailed, png2icons.BICUBIC, 0);
  fs.writeFileSync(path.join(buildDir, 'icon.icns'), icns);

  console.log('done');
})();
