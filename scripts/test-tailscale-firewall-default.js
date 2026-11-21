'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const RULE_FILE = 'files/usr/share/nftables.d/chain-pre/input/10-osi-tailscale.nft';
const PROFILES = ['bcm2712', 'bcm2709'];

for (const profile of PROFILES) {
  test(`${profile} firmware accepts input only from tailscale0 in its Tailscale drop-in`, () => {
    const rule = path.join(__dirname, '..', 'conf', `full_raspberrypi_bcm27xx_${profile}`, RULE_FILE);
    assert.equal(readFileSync(rule, 'utf8'), 'iifname "tailscale0" accept\n');
  });
}

test('the profile parity verifier checks the Tailscale drop-in', () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, 'verify-profile-parity.js')], { encoding: 'utf8' });
  assert.ok(output.split('\n').includes(`OK:   ${RULE_FILE}`), `profile parity must check ${RULE_FILE}`);
});
