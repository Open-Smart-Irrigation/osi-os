'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');

function runCase(mode) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reh-')), 'copy.db');
  let out, code = 0;
  try { out = execFileSync('node', [path.join(__dirname, 'rehearse-devices-rebuild.js'), mode, db], { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status || 1; }
  // The harness prints one JSON line to stdout; node:sqlite's ExperimentalWarning goes to stderr.
  // Take the last line that starts with '{' so the diagnostics survive a non-zero exit.
  const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() || '{}';
  return { json: JSON.parse(line), code };
}

test('healthy DB: guard SKIPS the rebuild, rows preserved', () => {
  const { json, code } = runCase('healthy');
  assert.strictEqual(code, 0, JSON.stringify(json));
  assert.strictEqual(json.skipped, true);
});

test('a row the target CHECK rejects is NEVER silently dropped, and the abort is surfaced', () => {
  const { json, code } = runCase('would-drop');
  assert.strictEqual(code, 0, JSON.stringify(json));
  assert.strictEqual(json.rowsPreserved, true);
  assert.strictEqual(json.errorSurfaced, true);
});

test('legit upgrade: rebuild succeeds, rows preserved, CHECK gains AQUASCOPE_LORAIN', () => {
  const { json, code } = runCase('legit-upgrade');
  assert.strictEqual(code, 0, JSON.stringify(json));
  assert.strictEqual(json.hasLorain, true);
});
