#!/usr/bin/env node
'use strict';
// Execute the real flow gates on the prepared adapters without writing either
// reserved flow file. Invoke this suite through osi-heavy, like the other gates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyTo } = require('./x3-zone-env-adapters');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-handoff-'));
const sources = new Map();
try {
  for (const profile of ['bcm2712', 'bcm2709']) {
    const relative = `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`;
    const original = fs.readFileSync(path.join(root, relative), 'utf8');
    sources.set(relative, original);
    const flows = JSON.parse(original);
    assert.equal(JSON.stringify(flows, null, 2) + '\n', original, relative + ' roundtrip');
    const target = path.join(scratch, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(applyTo(flows), null, 2) + '\n');
  }
  const preload = path.join(__dirname, 'lib/x3-flows-read-overlay.cjs');
  const env = { ...process.env, X3_REPO_ROOT: root, X3_RENDER_ROOT: scratch,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require=' + preload].filter(Boolean).join(' ') };
  // The direct scan has no CLI entry point: call its exported scanner and use
  // a negative control so a no-op command cannot manufacture a pass signal.
  const scan = `const fs=require('fs'),assert=require('assert/strict'),{scanFunctionNodes}=require('./scripts/flows-bare-require-scan');
for(const p of ['bcm2712','bcm2709'])assert.deepEqual(scanFunctionNodes(JSON.parse(fs.readFileSync('conf/full_raspberrypi_bcm27xx_'+p+'/files/usr/share/flows.json'))),[]);
assert.equal(scanFunctionNodes([{type:'function',func:"require('osi-zone-env')"}]).length,1);
console.log('flows-bare-require-scan: OK (both staged profiles; negative control rejected)');`;
  const commands = [
    ['-e', scan],
    ...['verify-profile-parity.js', 'verify-helper-registration.js', 'verify-module-file-deploy-coverage.js',
      'verify-flows-fn-parse.js', 'verify-no-new-silent-catch.js', 'verify-no-stray-ddl.js',
      'verify-flows-size-ratchet.js', 'test-flows-wiring.js', 'verify-sync-flow.js'].map(gate => ['scripts/' + gate]),
  ];
  for (const args of commands) {
    const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'handoff gate failed: ' + (args[0] === '-e' ? 'bare-require scan' : args[0]));
  }
  console.log('X3 staged handoff gates: OK (repository flows untouched)');
} finally {
  for (const [relative, original] of sources) assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), original, 'reserved flow changed during verification');
  fs.rmSync(scratch, { recursive: true, force: true });
}
