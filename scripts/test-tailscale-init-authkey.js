'use strict';
// NEW-29: the image's first-boot Tailscale script stripped whitespace from
// the join key with `tr -d '[:space:]'`. The gateway bases' BusyBox tr has no
// character classes, so it deleted the letters s, p, a, c, e (and the
// brackets and colon) from the key instead, and a valid key holding any of
// them could not join. The key here is made up; its letters are the ones the
// class form deleted. The script runs with a tr that refuses a character
// class, as the bases would get it wrong, and stand-ins for the rest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = 'files/etc/uci-defaults/99_tailscale_init';

function findOnHost(name) {
  for (const dir of ['/usr/bin', '/bin']) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  throw new Error(`no ${name} on this host`);
}

for (const profile of ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709']) {
  test(`${profile}: the join key keeps every letter and loses only its whitespace`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-tailscale-init-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      stub('tr', `for a in "$@"; do case "$a" in *'[:'*':]'*) echo "tr: no character classes on the gateway bases" >&2; exit 97 ;; esac; done\nexec ${findOnHost('tr')} "$@"`);
      stub('tailscale', `printf '%s\\n' "$@" > ${JSON.stringify(path.join(dir, 'tailscale.args'))}`);
      stub('ping', 'exit 0');
      stub('sleep', 'exit 0');
      stub('logger', 'exit 0');
      stub('uci', 'echo osi-test-device');
      for (const name of ['cat', 'seq']) fs.symlinkSync(findOnHost(name), path.join(bin, name));
      const key = 'tskey-auth-kSpaceCaseApsec-0123';
      fs.writeFileSync(path.join(dir, 'authkey'), `  ${key}\t\r\n`);
      const source = fs.readFileSync(path.join(REPO, 'conf', profile, SCRIPT), 'utf8')
        .replace('AUTHKEY_FILE="/etc/tailscale/authkey"', `AUTHKEY_FILE=${JSON.stringify(path.join(dir, 'authkey'))}`);
      const run = spawnSync('/bin/sh', ['-c', source], { encoding: 'utf8', env: { PATH: bin } });
      assert.equal(run.status, 0, run.stderr);
      assert.doesNotMatch(run.stderr, /character classes/);
      const args = fs.readFileSync(path.join(dir, 'tailscale.args'), 'utf8').split('\n');
      assert.ok(args.includes(`--authkey=${key}`), args.join(' '));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
