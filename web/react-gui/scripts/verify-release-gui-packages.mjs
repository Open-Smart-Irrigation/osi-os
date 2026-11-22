import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [build, feed, tarball] = process.argv.slice(2);
if (!build || !feed || !tarball) {
  throw new Error('Usage: verify-release-gui-packages.mjs <build> <firmware-feed-gui> <react_gui.tar.gz>');
}
const extracted = mkdtempSync(path.join(tmpdir(), 'osi-gui-tarball-'));
try {
  execFileSync('tar', ['-xzf', path.resolve(tarball), '-C', extracted], { stdio: 'inherit' });
  // The firmware's files/gui/* install and the release tarball need the
  // runtime assets. The Vite manifest is build evidence.
  for (const packaged of [feed, extracted]) {
    execFileSync('diff', ['-qr', '--exclude=.vite', build, packaged], { stdio: 'inherit' });
  }
  console.log('Firmware feed GUI and upgrade tarball match the tested GUI build.');
} finally {
  rmSync(extracted, { recursive: true, force: true });
}
