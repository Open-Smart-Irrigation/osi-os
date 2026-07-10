'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'verify-flows-size-ratchet.js');
const SURFACE = 'flows.json';
const SURFACE_ARGS = ['--surface', SURFACE];

function git(dir, args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); }
function writeFlows(dir, nodes) {
  fs.writeFileSync(path.join(dir, SURFACE), JSON.stringify(nodes, null, 2) + '\n');
}
function initRepo(nodes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flows-size-ratchet-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@e.com']);
  git(dir, ['config', 'user.name', 'T']);
  writeFlows(dir, nodes);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}
function run(dir, extra = []) {
  return spawnSync(process.execPath, [
    script, '--root', dir, '--git-root', dir, '--base-ref', 'HEAD',
    '--baseline', path.join(dir, 'baseline.json'), ...SURFACE_ARGS, ...extra,
  ], { cwd: dir, encoding: 'utf8' });
}
function writeBaseline(dir) {
  execFileSync(process.execPath, [
    script, '--root', dir, '--git-root', dir, '--base-ref', 'HEAD',
    '--baseline', path.join(dir, 'baseline.json'), ...SURFACE_ARGS, '--write-baseline',
  ], { cwd: dir });
}
const fn = (id, func, extra = {}) => ({ id, type: 'function', name: id, func, ...extra });
const BASE = [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(200))];

test('PASS when HEAD == base', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verify-flows-size-ratchet: OK/);
});

test('PASS when an existing node shrinks and the total drops (no baseline regen needed)', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(50))]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /below committed baseline/);
});

test('FAIL when an existing node grows', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(400))]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /node shrinkme grew/);
});

test('FAIL when the per-profile total increases', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [...BASE, fn('newsmall', 'return 1;')]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /total embedded JS increased/);
});

test('FAIL when a NEW node exceeds the 4096 ceiling', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'y'.repeat(1)), fn('toobig', 'z'.repeat(5000))]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /new node toobig exceeds/);
});

test('FAIL when a large NEW node has a fat SQL literal and no osiLib (thin-node rule)', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  const fatSql = "const q=`SELECT " + 'a,'.repeat(400) + "b FROM device_data`;";
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'y'.repeat(1)),
    fn('fatnew', 'x'.repeat(4097) + '\n' + fatSql)]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /oversized SQL literal/);
});

test('PASS when a large NEW node loads via osiLib.require', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'y'.repeat(1)),
    fn('adapter', "const h=osiLib.require('x');\n" + 'k'.repeat(4097),
      { libs: [{ var: 'osiLib', module: 'osi-lib' }] })]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /new node adapter exceeds/);
  assert.doesNotMatch(r.stderr, /oversized SQL literal/);
});

test('fails closed when --base-ref is unreachable', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  const r = spawnSync(process.execPath, [
    script, '--root', dir, '--git-root', dir,
    '--base-ref', 'refs/remotes/origin/does-not-exist',
    '--baseline', path.join(dir, 'baseline.json'), ...SURFACE_ARGS,
  ], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /failing closed/);
});

test('gate 2: FAILS when HEAD total EXCEEDS the committed baseline (unrecorded growth)', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  const bp = path.join(dir, 'baseline.json');
  const doctored = JSON.parse(fs.readFileSync(bp, 'utf8'));
  doctored.files[SURFACE].total = 1;
  fs.writeFileSync(bp, JSON.stringify(doctored, null, 2) + '\n');
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /exceeds committed baseline/);
});

test('accepts the committed shipped baseline against origin/main', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/verify-flows-size-ratchet-baseline.json')), true,
    'baseline must be committed');
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verify-flows-size-ratchet: OK/);
});
