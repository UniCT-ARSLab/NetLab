// node-pty ships spawn-helper with 644 permissions on macOS (missing execute bit).
// This script is run via postinstall to fix it.
const { chmodSync, existsSync } = require('fs');
const { join } = require('path');

if (process.platform !== 'darwin') process.exit(0);

const prebuilds = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(prebuilds, arch, 'spawn-helper');
  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
    console.log(`node-pty: fixed execute bit on ${arch}/spawn-helper`);
  }
}
