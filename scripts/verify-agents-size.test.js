'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { LIMIT_BYTES, REQUIRED_HEADINGS, headingOffset, check } = require('./verify-agents-size');

const SCRIPT = path.join(__dirname, 'verify-agents-size.js');

const tempRoots = [];
process.on('exit', () => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function doc(prefixBytes = 0, suffixBytes = 0) {
  const pad = (n) => (n > 0 ? `${'x'.repeat(n - 1)}\n` : '');
  return `# AGENTS.md\n${pad(prefixBytes)}${REQUIRED_HEADINGS.map((h) => `${h}\n\nbody\n`).join('\n')}${pad(suffixBytes)}`;
}

function run(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-size-'));
  tempRoots.push(root);
  const file = path.join(root, 'AGENTS.md');
  fs.writeFileSync(file, content);
  const r = spawnSync(process.execPath, [SCRIPT, `--file=${file}`], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('headingOffset counts bytes, not characters', () => {
  const buf = Buffer.from('# T — é\n## Agent skills\n');
  assert.equal(headingOffset(buf, '## Agent skills'), Buffer.byteLength('# T — é\n'));
});

test('headingOffset matches whole lines only', () => {
  const buf = Buffer.from('## Agent skills index\n### Agent skills\n## Agent skills\n');
  assert.equal(headingOffset(buf, '## Agent skills'), Buffer.byteLength('## Agent skills index\n### Agent skills\n'));
});

test('a small file with every required heading passes', () => {
  const r = run(doc());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /verify-agents-size: OK/);
});

test('a file over the limit fails', () => {
  const r = run(doc(0, LIMIT_BYTES));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /over the 30720-byte limit/);
});

test('a required heading past the limit fails', () => {
  const content = doc(LIMIT_BYTES);
  const { errors } = check(Buffer.from(content));
  assert.ok(errors.some((e) => e.includes('"## Host access gate" starts at byte')), errors.join('\n'));
  const r = run(content);
  assert.equal(r.code, 1, r.out);
});

test('a missing required heading fails', () => {
  const r = run(doc().replace('## Session closeout\n', '## Closeout\n'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /"## Session closeout" is missing/);
});

test('an unreadable file exits 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--file=/nonexistent/AGENTS.md'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('the repository AGENTS.md passes', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
