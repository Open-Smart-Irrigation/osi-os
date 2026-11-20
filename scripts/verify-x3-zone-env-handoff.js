#!/usr/bin/env node
'use strict';
// Execute the real flow gates on the prepared adapters without writing either
// reserved flow file. Invoke this suite through osi-heavy, like the other gates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { renderHandoff, renderPatch, HANDOFF_FILES } = require('./x3-zone-env-adapters');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-handoff-'));
const sources = new Map();
try {
  for (const relative of HANDOFF_FILES) sources.set(relative, fs.readFileSync(path.join(root, relative), 'utf8'));
  renderHandoff(scratch);
  // The submitted patch is a reviewed artifact, not a second untested renderer.
  const submitted = fs.readFileSync(path.join(__dirname, 'fixtures/x3-zone-env/adapter-handoff.patch'), 'utf8');
  assert.equal(renderPatch(scratch), submitted, 'checked-in handoff patch differs from renderer');
  const patchTree = path.join(scratch, 'patch-check');
  for (const relative of HANDOFF_FILES) {
    const target = path.join(patchTree, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, sources.get(relative));
  }
  const headers=[...submitted.matchAll(/^(?:--- a\/|\+\+\+ b\/)(.+)$/gm)].map(match=>match[1]);
  assert.deepEqual([...new Set(headers)].sort(),[...HANDOFF_FILES].sort(),'patch may touch only the approved handoff paths');
  const patched = spawnSync('git', ['apply', '--whitespace=nowarn'], { cwd: patchTree, input: submitted, encoding: 'utf8' });
  if(patched.error) throw patched.error;
  assert.equal(patched.status, 0, patched.stdout + patched.stderr);
  for (const relative of HANDOFF_FILES) assert.ok(fs.readFileSync(path.join(patchTree, relative)).equals(fs.readFileSync(path.join(scratch, relative))), 'patch/render bytes differ: ' + relative);
  const preload = path.join(__dirname, 'lib/x3-flows-read-overlay.cjs');
  const env = { ...process.env, X3_REPO_ROOT: root, X3_RENDER_ROOT: scratch,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require=' + preload].filter(Boolean).join(' ') };
  // The direct scan has no CLI entry point: call its exported scanner and use
  // a negative control so a no-op command cannot manufacture a pass signal.
  const scan = `const fs=require('fs'),assert=require('assert/strict'),{scanFunctionNodes}=require('./scripts/flows-bare-require-scan');
for(const p of ['bcm2712','bcm2709'])assert.deepEqual(scanFunctionNodes(JSON.parse(fs.readFileSync('conf/full_raspberrypi_bcm27xx_'+p+'/files/usr/share/flows.json'))),[]);
assert.equal(scanFunctionNodes([{type:'function',func:"require('osi-zone-env')"}]).length,1);
console.log('flows-bare-require-scan: OK (both staged profiles; negative control rejected)');`;
  const commands = process.argv.includes('--runtime-only') ? [['scripts/test-x3-zone-env-runtime.js'], ['scripts/test-x3-zone-env-runtime.js','--non-utc']] : [
    ['scripts/test-x3-zone-env-parity.js','--verify'],
    ['scripts/test-x3-zone-env-additive.js'],
    ['-e', scan],
    ...['verify-profile-parity.js', 'verify-helper-registration.js', 'verify-module-file-deploy-coverage.js',
      'verify-flows-fn-parse.js', 'verify-no-new-silent-catch.js', 'verify-no-stray-ddl.js',
      'verify-flows-size-ratchet.js', 'test-flows-wiring.js', 'test-task5b2-projections.js',
      'verify-osi-lib-db-caller-binding.js', 'verify-osi-lib-db-caller-binding.test.js',
      'verify-auth-flag-off-hermetic.js', 'verify-auth-flag-off-hermetic.test.js',
      'test-x3-zone-env-revision.js', 'test-x3-zone-env-packaging.js', 'verify-sync-flow.js'].map(gate => ['scripts/' + gate]),
  ];
  for (const args of commands.filter(args => !process.argv.includes('--affected') || args[0] !== 'scripts/verify-sync-flow.js')) {
    const result = spawnSync(process.execPath, args, { cwd: root, env: { ...env, TZ: args.includes('--non-utc') ? 'Europe/Zurich' : process.env.TZ || 'UTC' }, stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'handoff gate failed: ' + (args[0] === '-e' ? 'bare-require scan' : args[0]));
  }
  console.log('X3 staged handoff gates: OK (repository flows untouched)');
} finally {
  for (const [relative, original] of sources) assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), original, 'reserved flow changed during verification');
  fs.rmSync(scratch, { recursive: true, force: true });
}
