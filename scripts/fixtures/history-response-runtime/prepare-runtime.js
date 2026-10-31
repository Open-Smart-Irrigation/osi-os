'use strict';
// Verify the pinned Node-RED archives and HTTPIn source used by the fixture.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.cwd();
const ARCHIVES = [
  ['node-red', 'https://registry.npmjs.org/node-red/-/node-red-3.1.15.tgz',
    'a93c606f3620b4acc4900a428ad76f389508b9113d1ccd13d6c908b6c95741a6'],
  ['nodes', 'https://registry.npmjs.org/@node-red/nodes/-/nodes-3.1.15.tgz',
    '1cc4b4465e20ad686b8aa94a9ce252f2a5503ec59af834b50b9fe06ca4330c9f'],
];
const HTTPIN_SHA = 'a5b03d988d2bd9d7779e28bdfcca19d062ace6e7a6df6a08eae701b02939e6db';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(url + ': HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('official archive acquisition timeout')));
    req.on('error', reject);
  });
}

async function main() {
  // The feed's Makefile is the authority for the top-level pin.
  const makefile = fs.readFileSync(path.join(ROOT, 'feeds/chirpstack-openwrt-feed/apps/node-red/Makefile'), 'utf8');
  assert.match(makefile, /^PKG_VERSION:=3\.1\.15$/m);
  assert.match(makefile, new RegExp('^PKG_HASH:=' + ARCHIVES[0][2] + '$', 'm'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-436-archive-'));
  try {
    for (const [name, url, expected] of ARCHIVES) {
      const data = await get(url);
      assert.equal(sha256(data), expected, name + ' archive SHA-256');
      const archive = path.join(dir, name + '.tgz');
      fs.writeFileSync(archive, data);
      const packageText = spawnSync('tar', ['-xzOf', archive, 'package/package.json'], { encoding: 'utf8' });
      assert.equal(packageText.status, 0, packageText.stderr);
      const pkg = JSON.parse(packageText.stdout);
      assert.equal(pkg.version, '3.1.15');
      if (name === 'node-red') assert.equal(pkg.dependencies['@node-red/nodes'], '3.1.15');
      if (name === 'nodes') {
        const source = spawnSync('tar', ['-xzOf', archive, 'package/core/network/21-httpin.js']);
        assert.equal(source.status, 0, String(source.stderr));
        assert.equal(sha256(source.stdout), HTTPIN_SHA, 'feed-bound response source');
        assert.match(source.stdout.toString(), /RED\.nodes\.registerType\("http response",HTTPOut\)/);
      }
      console.log(name + ' archive sha256=' + expected + ' version=' + pkg.version);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
