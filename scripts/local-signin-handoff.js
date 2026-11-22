#!/usr/bin/env node
'use strict';
// Staged flows.json change for local sign-in (auth-process-result, both
// profiles). The new node body lives in
// scripts/fixtures/local-signin/auth-process-result.json together with the
// exact body it replaces, so the patch refuses to apply over a node that has
// changed since it was staged.
//
//   node scripts/local-signin-handoff.js            report the state (legacy|applied) of both profiles
//   node scripts/local-signin-handoff.js --apply    replace the node body in both profiles
//   node scripts/local-signin-handoff.js --stage <dir>
//                                                    write patched copies of both profiles under
//                                                    <dir>/<profile path>, leaving the repo untouched
//
// Edits go through JSON.parse / JSON.stringify(flows, null, 2) + '\n' after a
// byte-identical no-op round-trip check (osi-flows-json-editing).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const FIXTURE = path.join(__dirname, 'fixtures/local-signin/auth-process-result.json');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function loadPatch() {
  const patch = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  if (sha256(patch.preImageFunc) !== patch.preImageSha256) {
    throw new Error('fixture pre-image does not match its recorded SHA-256');
  }
  return patch;
}

function render(flows) {
  return JSON.stringify(flows, null, 2) + '\n';
}

function readProfile(root, rel) {
  const raw = fs.readFileSync(path.join(root, rel), 'utf8');
  const flows = JSON.parse(raw);
  if (render(flows) !== raw) throw new Error(rel + ': no-op round-trip is not byte-identical');
  return flows;
}

function nodeState(flows, patch, rel) {
  const node = flows.find((candidate) => candidate.id === patch.id);
  if (!node) throw new Error(rel + ': missing node ' + patch.id);
  if (node.func === patch.func) return { node, state: 'applied' };
  if (node.func === patch.preImageFunc) return { node, state: 'legacy' };
  throw new Error(rel + ': ' + patch.id + ' differs from both the staged pre-image (sha256 ' +
    patch.preImageSha256 + ') and the staged body; restage the patch');
}

function patchedFlows(root, rel, patch) {
  const flows = readProfile(root, rel);
  const { node } = nodeState(flows, patch, rel);
  node.func = patch.func;
  return flows;
}

function main(argv) {
  const patch = loadPatch();
  if (argv[0] === '--apply') {
    const rendered = PROFILES.map((rel) => render(patchedFlows(ROOT, rel, patch)));
    if (rendered[0] !== rendered[1]) throw new Error('patched profiles differ');
    PROFILES.forEach((rel, i) => fs.writeFileSync(path.join(ROOT, rel), rendered[i]));
    console.log('local-signin-handoff: applied to both profiles');
    return;
  }
  if (argv[0] === '--stage') {
    const dir = argv[1];
    if (!dir) throw new Error('--stage requires a directory');
    for (const rel of PROFILES) {
      const out = path.join(path.resolve(dir), rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, render(patchedFlows(ROOT, rel, patch)));
    }
    console.log('local-signin-handoff: staged both profiles under ' + path.resolve(dir));
    return;
  }
  if (argv.length) throw new Error('unknown argument: ' + argv[0]);
  for (const rel of PROFILES) {
    console.log(rel + ': ' + nodeState(readProfile(ROOT, rel), patch, rel).state);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error('local-signin-handoff: FAIL - ' + (error && error.message ? error.message : error));
    process.exit(1);
  }
}

module.exports = { PROFILES, loadPatch, nodeState, patchedFlows, readProfile };
