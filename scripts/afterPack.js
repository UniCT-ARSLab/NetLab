// electron-builder afterPack hook — fixes spawn-helper execute bit inside the .app bundle.
// node-pty is unpacked from asar (asarUnpack config) but retains the original 644 permissions.
const { chmodSync, existsSync } = require('fs');
const { join } = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const unpackedBase = join(
    context.appOutDir,
    `${appName}.app`,
    'Contents', 'Resources',
    'app.asar.unpacked',
    'node_modules', 'node-pty', 'prebuilds',
  );

  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    const helper = join(unpackedBase, arch, 'spawn-helper');
    if (existsSync(helper)) {
      chmodSync(helper, 0o755);
      console.log(`afterPack: fixed execute bit on ${arch}/spawn-helper`);
    }
  }
};
