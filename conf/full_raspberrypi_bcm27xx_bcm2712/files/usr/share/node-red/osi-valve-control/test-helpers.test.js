'use strict';
// F142. tempDb() copies the bundled farming.db into a fresh mkdtemp directory and used to
// leave it there. These suites call it around 155 times per full run, and the leftovers
// are ~1.6 MB each, so the temp dir grows by a quarter of a gigabyte every run. On this
// project's workstation 3 561 /tmp/vc-* directories had accumulated (about 5.7 GB), which
// filled a 12 GB tmpfs and made unrelated suites fail with ENOSPC rather than with
// anything to do with the code under test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDb, trackedTempDirs } = require('./test-helpers');

test('tempDb cleanup() removes the directory it created (F142)', async () => {
  const { db, dir, cleanup } = await tempDb();
  assert.ok(fs.existsSync(dir), 'the fixture directory exists while the test runs');
  assert.ok(fs.existsSync(path.join(dir, 'farming.db')), 'the fixture DB was copied into it');
  assert.ok(trackedTempDirs().includes(dir), 'the directory is tracked for the exit sweep');

  db.close();
  cleanup();

  assert.equal(fs.existsSync(dir), false, 'cleanup() must remove the directory');
  assert.equal(trackedTempDirs().includes(dir), false, 'and stop tracking it');
});

test('tempDb cleanup() is safe to call twice and after db.close() (F142)', async () => {
  const { db, dir, cleanup } = await tempDb();
  db.close();
  cleanup();
  cleanup();
  assert.equal(fs.existsSync(dir), false);
});

test('a fixture the test never cleans up is still tracked, so the exit sweep gets it (F142)', async () => {
  // This is the case that actually leaked: the great majority of call sites take only
  // `db` and never see a directory to remove. Tracking has to be automatic for those.
  const before = trackedTempDirs().length;
  const { db, dir } = await tempDb();
  assert.equal(trackedTempDirs().length, before + 1);
  assert.ok(trackedTempDirs().includes(dir), 'an un-cleaned fixture must remain tracked');
  db.close();
  // Left deliberately un-cleaned: the process exit hook is what must reclaim it.
});

test('the exit hook is installed exactly once no matter how many fixtures are made (F142)', async () => {
  const listenersBefore = process.listenerCount('exit');
  const fixtures = [await tempDb(), await tempDb(), await tempDb()];
  assert.equal(process.listenerCount('exit'), listenersBefore,
    'tempDb must not add a new exit listener per call');
  for (const fixture of fixtures) {
    fixture.db.close();
    fixture.cleanup();
  }
});
