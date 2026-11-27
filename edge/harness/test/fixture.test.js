'use strict';
// confirm-ids H1: a refused recording keeps the old cassette/fixture pair, and
// a replay refuses a fixture.db that does not match meta.fixtureSha256.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { sha256File, stagedFixture, discardStaged, commitRecording, checkReplayFixture } = require('../lib/fixture');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.cwd(), 'fixture-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePair(dir, fixtureBytes) {
  fs.writeFileSync(path.join(dir, 'fixture.db'), fixtureBytes);
  const meta = { fixtureSha256: sha256File(path.join(dir, 'fixture.db')) };
  fs.writeFileSync(path.join(dir, 'cassette.json'), JSON.stringify({ meta }));
  return meta;
}

test('a refused recording leaves the previous pair matching', (t) => {
  const dir = tempDir(t);
  const meta = writePair(dir, 'old fixture');
  // The recorder stages the oracle backup, then the setup SQL check refuses.
  fs.writeFileSync(stagedFixture(dir).staged, 'new fixture');
  discardStaged(dir);
  assert.equal(fs.existsSync(stagedFixture(dir).staged), false);
  assert.equal(fs.readFileSync(path.join(dir, 'fixture.db'), 'utf8'), 'old fixture');
  assert.deepEqual(checkReplayFixture(dir, meta), { ok: true });
});

test('an accepted recording replaces fixture.db and its cassette together', (t) => {
  const dir = tempDir(t);
  writePair(dir, 'old fixture');
  fs.writeFileSync(stagedFixture(dir).staged, 'new fixture');
  const meta = { fixtureSha256: sha256File(stagedFixture(dir).staged) };
  commitRecording(dir, JSON.stringify({ meta }));
  assert.equal(fs.existsSync(stagedFixture(dir).staged), false);
  assert.equal(fs.readFileSync(path.join(dir, 'fixture.db'), 'utf8'), 'new fixture');
  const cassette = JSON.parse(fs.readFileSync(path.join(dir, 'cassette.json'), 'utf8'));
  assert.deepEqual(checkReplayFixture(dir, cassette.meta), { ok: true });
});

test('a replay refuses a fixture.db that does not match the cassette', (t) => {
  const dir = tempDir(t);
  const meta = writePair(dir, 'recorded fixture');
  fs.writeFileSync(path.join(dir, 'fixture.db'), 'other fixture');
  const result = checkReplayFixture(dir, meta);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match cassette meta\.fixtureSha256/);
  fs.rmSync(path.join(dir, 'fixture.db'));
  assert.match(checkReplayFixture(dir, meta).reason, /fixture\.db missing/);
});

test('a cassette without fixtureSha256 replays with a warning', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'fixture.db'), 'any');
  const result = checkReplayFixture(dir, {});
  assert.equal(result.ok, true);
  assert.match(result.warning, /no meta\.fixtureSha256/);
});
