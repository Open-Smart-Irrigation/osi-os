'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VALIDATOR = path.join(__dirname, 'test-conditional-irrigation-command-boundary.js');
const FIXTURE = path.join(__dirname, 'fixtures/conditional-irrigation-command-boundary-local.json');

function runBoundary(boundary) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conditional-boundary-'));
  const file = path.join(dir, 'pending-boundary.json');
  try {
    fs.writeFileSync(file, JSON.stringify(boundary));
    return spawnSync(process.execPath, [VALIDATOR, file], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

test('local pending boundary accepts the typed create, full, partial, pause and retry set', () => {
  const result = runBoundary(fixture());
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /through production boundary and AJV/);
});

test('local pending boundary rejects a sparse edit without its row version', () => {
  const boundary = fixture();
  delete boundary.commands[2].pending.payload.schedules[0].expected_sync_version;
  const result = runBoundary(boundary);
  assert.notEqual(result.status, 0, 'a malformed persisted command must fail the boundary');
  assert.match(`${result.stdout}\n${result.stderr}`, /AJV-valid|expected_sync_version/);
});
