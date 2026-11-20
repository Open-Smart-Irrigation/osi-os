'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const test = require('node:test');

const root = path.join(__dirname, '..');
const archive = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-archive');
const migrations = path.join(root, 'database/migrations/ordered');
const dayMs = 86400000;
const now = Date.parse('2026-11-20T12:00:00Z');
const cutoff = now - 365 * dayMs;
const floor = 1024 ** 3;
const iso = ms => new Date(ms).toISOString();
const goodClock = () => ({
  bootId: 'test-boot', uptime: 60000,
  marker: { boot_id: 'test-boot', epoch_ms: now - 60000, uptime_ms: 0, stratum: 2 },
});

function fixture(t, { beforeMigration = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-sdi12-retention-'));
  const filename = path.join(dir, 'farming.db');
  const db = new DatabaseSync(filename);
  const migration = prefix => fs.readFileSync(path.join(migrations,
    fs.readdirSync(migrations).find(name => name.startsWith(prefix))), 'utf8');
  db.exec(migration('0080__'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE canonical_readings (value INTEGER)');
  const createIndex = () => db.exec(migration('0083__'));
  if (!beforeMigration) createIndex();
  let free = floor;
  let statfsError = null;
  let opens = 0;
  const pressureState = {};
  let onDelete = () => 0;
  const insert = db.prepare(`INSERT INTO sdi12_transmissions
    (deveui, recorded_at, received_at, raw_ascii, frames_json, context_json)
    VALUES (?, ?, ?, '+0.00010', ?, ?) RETURNING id`);
  // The production helper exposes the selected sqlite3 driver's callback API.
  // The fixture adapts node:sqlite to that API, using a separate SQLite handle.
  const api = {
    OPEN_READWRITE: 2,
    openNativeFarming(mode, callback) {
      assert.equal(mode, this.OPEN_READWRITE);
      opens++;
      const connection = new DatabaseSync(filename);
      connection.function('fixture_on_delete', onDelete);
      function invoke(action, done) {
        setImmediate(() => {
          let result;
          try { result = action(); } catch (error) {
            if (error.errcode === 5) error.code = 'SQLITE_BUSY';
            if (error.errcode === 19 || (error.errcode & 255) === 19) error.code = 'SQLITE_CONSTRAINT';
            done(error);
            return;
          }
          done(null, result);
        });
      }
      setImmediate(() => callback(null));
      return {
        get(sql, params, done) { invoke(() => connection.prepare(sql).get(...params), done); },
        run(sql, params, done) {
          invoke(() => connection.prepare(sql).run(...params), (error, result) => done.call(result, error));
        },
        close(done) { invoke(() => connection.close(), done); },
      };
    },
  };
  const run = options => archive.maintain(api, {
    now, clock: goodClock, dbPath: filename, pressureState,
    statfs(directory) {
      assert.equal(directory, dir);
      if (statfsError) throw statfsError;
      return { bavail: free, bsize: 1 };
    },
    ...options,
  });
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    db, filename, run, createIndex,
    add(time, sensor = 'TEST_SENSOR_A', bytes = 0, recordedAt = null, contextJson = '{}') {
      return insert.get(sensor, recordedAt, iso(time), JSON.stringify(['x'.repeat(bytes)]), contextJson).id;
    },
    ids: () => db.prepare('SELECT id FROM sdi12_transmissions ORDER BY id').all().map(r => r.id),
    free(bytes) { free = bytes; },
    failProbe(error) { statfsError = error; },
    opens: () => opens,
    onDelete(callback) { onDelete = callback; },
  };
}

test('receipt time at 365 days expires, while a newer receipt keeps its raw data', async t => {
  const f = fixture(t);
  f.add(cutoff - 1, 'TEST_SENSOR_Z', 0, iso(now));
  f.add(cutoff);
  const recent = f.add(cutoff + 1, 'TEST_SENSOR_A', 0, '1970-01-01T00:00:00Z');
  f.db.exec('INSERT INTO canonical_readings VALUES (1)');
  assert.equal((await f.run()).deleted, 2);
  assert.deepEqual(f.ids(), [recent]);
  assert.equal(f.db.prepare('SELECT raw_ascii FROM sdi12_transmissions').get().raw_ascii, '+0.00010');
  assert.equal(f.db.prepare('SELECT value FROM canonical_readings').get().value, 1);
});

test('one tick expires at most eight rows, oldest first with ID as the global tiebreaker', async t => {
  const f = fixture(t);
  const last = f.add(cutoff);
  const ties = Array.from({ length: 11 }, (_, i) => f.add(cutoff - 1, 'TEST_SENSOR_' + (99 - i)));
  const first = f.add(cutoff - 2);
  f.free(floor - 4096);
  const result = await f.run();
  assert.equal(result.reason, 'expired');
  assert.equal(result.deleted, 8);
  assert.deepEqual(f.ids(), [last, ...ties.slice(7)]);
  assert.ok(!f.ids().includes(first));
  assert.equal((await f.run()).deleted, 5);
});

test('pressure deletes the oldest remaining rows until the measured floor is reached', async t => {
  const f = fixture(t);
  const newer = f.add(now - 2, 'TEST_SENSOR_A');
  const early = Array.from({ length: 10 }, (_, i) => f.add(now - 3, 'TEST_SENSOR_' + (99 - i), 10000));
  const later = f.add(now - 1);
  assert.equal((await f.run()).deleted, 0, 'exactly at the floor');
  let probes = 0;
  const statfs = () => ({ bavail: ++probes === 1 ? floor - 4096 : floor, bsize: 1 });
  const result = await f.run({ statfs });
  assert.equal(result.reason, 'pressure');
  assert.equal(result.deleted, 8);
  assert.equal(result.freeBytes, floor);
  assert.deepEqual(f.ids(), [newer, ...early.slice(8), later]);
  assert.equal((await f.run()).deleted, 0);
});

test('at a flat filesystem floor, reusable SQLite pages stop further pressure deletions', async t => {
  const f = fixture(t);
  for (let i = 0; i < 16; i++) f.add(now - dayMs, 'TEST_SENSOR_A', 10000);
  const fileSize = fs.statSync(f.filename).size;
  f.free(floor - 4096);
  const pressure = await f.run();
  assert.equal(pressure.deleted, 8);
  assert.equal(pressure.freeBytes, floor - 4096);
  assert.ok(pressure.reusableBytes >= 4096);
  assert.equal((await f.run()).reason, 'pressure_limited');
  assert.equal(f.ids().length, 8);
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const afterCheckpoint = fs.statSync(f.filename).size;
  for (let i = 0; i < 8; i++) f.add(now, 'TEST_SENSOR_A', 10000);
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(afterCheckpoint >= fileSize);
  assert.equal(fs.statSync(f.filename).size, afterCheckpoint, 'SQLite reuses the freed pages');
});

test('a pressure batch without space or page gains does not repeat until headroom improves', async t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) f.add(now - dayMs);
  f.free(floor - 8192);
  const first = await f.run();
  assert.equal(first.deleted, 8);
  assert.equal(first.reusableBytes, 0);
  assert.equal((await f.run()).reason, 'pressure_limited');
  assert.equal(f.ids().length, 12);
  f.free(floor - 4096);
  assert.equal((await f.run()).deleted, 8);
});

test('interruptions roll back the batch and the next run starts at the same oldest row', async t => {
  const f = fixture(t);
  for (let i = 0; i < 16; i++) f.add(cutoff - i);
  const initial = f.ids();
  f.db.exec(`CREATE TRIGGER fixture_interrupt BEFORE DELETE ON sdi12_transmissions
    WHEN OLD.id = 13 BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
  await assert.rejects(f.run(), /interrupted/);
  assert.deepEqual(f.ids(), initial);
  f.db.exec('DROP TRIGGER fixture_interrupt');
  assert.equal((await f.run()).deleted, 8);
  assert.deepEqual(f.ids(), initial.slice(0, 8));
});

test('empty, untrusted clocks, failed probe and emergency headroom', async t => {
  const f = fixture(t);
  assert.equal((await f.run()).reason, 'idle');
  f.free(floor - 8192);
  assert.equal((await f.run()).reason, 'pressure_empty');
  f.add(cutoff - 1);
  for (const [clock, reason] of [
    [() => ({}), 'clock_untrusted_missing_marker'],
    [() => ({ ...goodClock(), uptime: 0 }), 'clock_untrusted_jump'],
    [() => ({ ...goodClock(), marker: { ...goodClock().marker, epoch_ms: now + dayMs } }), 'clock_untrusted_backward'],
  ]) {
    assert.equal((await f.run({ clock })).reason, reason);
  }
  f.free(1024);
  assert.equal((await f.run()).reason, 'disk_critical');
  f.failProbe(new Error('mount probe offline'));
  assert.equal((await f.run()).reason, 'disk_probe_failed');
  assert.equal(f.opens(), 2, 'safety skips do not touch SQLite');
  assert.equal(f.ids().length, 1);
  f.failProbe(null);
  f.free(floor);
  const future = f.add(now + 500 * dayMs);
  assert.equal((await f.run()).deleted, 1);
  assert.deepEqual(f.ids(), [future], 'a future-stamped row does not advance the cutoff');
});

test('maintenance yields to an ingest writer and an ingest writer can commit during repeated pruning', async t => {
  const f = fixture(t);
  const maxContext = JSON.stringify('x'.repeat(256 * 1024 - 2));
  for (let i = 0; i < 16; i++) f.add(cutoff, 'TEST_SENSOR_A', 256 * 1024 - 4, null, maxContext);
  f.db.exec('BEGIN IMMEDIATE');
  try {
    f.db.exec('INSERT INTO canonical_readings VALUES (42)');
    const started = performance.now();
    assert.equal((await f.run()).reason, 'busy');
    assert.ok(performance.now() - started < 1000, 'maintenance must not wait on ingest');
    assert.equal(f.ids().length, 16);
  } finally {
    f.db.exec('COMMIT');
  }

  // Hold the actual pruning write lock while the other connection attempts
  // its canonical insert. A worker gives SQLite an independent busy handler.
  const signal = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  f.onDelete(() => {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    Atomics.wait(signal, 1, 0, 1000);
    assert.equal(Atomics.load(signal, 1), 1);
    Atomics.wait(signal, 2, 0, 50);
    return 0;
  });
  f.db.exec(`CREATE TRIGGER fixture_hold BEFORE DELETE ON sdi12_transmissions
    WHEN OLD.id = 1 BEGIN SELECT fixture_on_delete(); END`);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const { filename, signal } = workerData;
    const db = new DatabaseSync(filename);
    db.exec('PRAGMA busy_timeout=5000');
    parentPort.postMessage('ready');
    Atomics.wait(signal, 0, 0, 5000);
    const start = performance.now();
    Atomics.store(signal, 1, 1);
    Atomics.notify(signal, 1);
    db.exec('INSERT INTO canonical_readings VALUES (43)');
    parentPort.postMessage(performance.now() - start);
    db.close();
  `, { eval: true, workerData: { filename: f.filename, signal } });
  t.after(() => worker.terminate());
  await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  const ingested = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  assert.equal((await f.run()).deleted, 8);
  const waitMs = await ingested;
  assert.ok(waitMs >= 40 && waitMs < 5000, `ingest waited ${waitMs} ms on the pruning write`);
  t.diagnostic(`canonical insert with overlapping maximum-payload batch: ${waitMs.toFixed(1)} ms`);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM canonical_readings').get().n, 2);
  assert.equal((await f.run()).deleted, 8);
  assert.deepEqual(f.ids(), []);
});

test('0083 indexes a populated archive, and minute ticks keep up with 0.7 MiB/day/node', async t => {
  const f = fixture(t, { beforeMigration: true });
  const nodes = 4;
  const rowsPerDay = 72;
  const bytesPerRow = Math.round(0.7 * 1024 ** 2 / rowsPerDay);
  const recent = f.add(now);
  f.db.exec('BEGIN');
  for (let i = 0; i < rowsPerDay; i++) {
    for (let node = 0; node < nodes; node++) {
      f.add(cutoff - i * 20 * 60 * 1000, 'TEST_SENSOR_' + node, bytesPerRow);
    }
  }
  f.db.exec('COMMIT');
  const bytes = f.db.prepare('SELECT sum(length(frames_json)) AS n FROM sdi12_transmissions').get().n;
  assert.ok(Math.abs(bytes / 1024 ** 2 - 2.8) < 0.01);
  const before = f.db.prepare('SELECT * FROM sdi12_transmissions ORDER BY id').all();
  f.createIndex();
  assert.deepEqual(f.db.prepare('SELECT * FROM sdi12_transmissions ORDER BY id').all(), before);
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM sdi12_transmissions
    WHERE received_at <= ? ORDER BY received_at, id LIMIT 8`).all(iso(cutoff)).map(row => row.detail).join(' ');
  assert.match(plan, /SEARCH.*idx_sdi12_transmissions_receipt_time/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
  let ticks = 0;
  while ((await f.run()).deleted > 0) ticks++;
  assert.equal(ticks, 36);
  assert.deepEqual(f.ids(), [recent]);
  const yearMiB = rowsPerDay * bytesPerRow * 365 / 1024 ** 2;
  assert.ok(Math.abs(yearMiB - 255.5) < 0.1);
  t.diagnostic(`${yearMiB.toFixed(1)} MiB/year/node, ${ticks} minute ticks to expire one day for ${nodes} nodes`);
});
