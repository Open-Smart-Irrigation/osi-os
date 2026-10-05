'use strict';
// repair-watermark-unsettled.js on a scratch copy of the bundled seed database
// with synthetic WATERMARK rows shaped like a wet channel's field readings
// (#415): codes and resistances are realistic, identities are examples.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const SEED_DB = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db');
const conversion = require(path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/conversion.js'));
const repair = require('./repair-watermark-unsettled');

const DEVEUI = 'A840410000000001';
const OTHER = 'A840410000000002';
const GATEWAY = '0016C001F1000001';

let dir;
let dbPath;

function open() { return new DatabaseSync(dbPath); }

// One accepted profile 3 reading and its device_data row. ch: per channel
// { flags, status, kpa, r_solved }; swt: the device_data values.
function reading(db, { deveui = DEVEUI, at, ch1, ch2, swt1, swt2, source = 2, statusByte = 2, temp = 16.81, link = true }) {
  const ddId = Number(db.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1, swt_2, ext_temperature_c) VALUES (?, ?, ?, ?, ?)')
    .run(deveui, at, swt1, swt2, source === 2 ? temp : null).lastInsertRowid);
  const wrId = Number(db.prepare(
    'INSERT INTO watermark_readings (deveui, recorded_at, device_data_id, payload_hex, frame_status, soil_temp_c, soil_temp_source, status_byte, ' +
    'ch1_flags, ch1_r_solved, ch1_status, ch1_kpa, ch2_flags, ch2_r_solved, ch2_status, ch2_kpa, calibration_sync_version, conversion_version) ' +
    "VALUES (?, ?, ?, 'a203', 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 'wm-lsn50-p3-v1')"
  ).run(deveui, at, link ? ddId : null, temp, source, statusByte,
    ch1.flags, ch1.r_solved, ch1.status, ch1.kpa, ch2.flags, ch2.r_solved, ch2.status, ch2.kpa).lastInsertRowid);
  return { ddId, wrId };
}

const UNSETTLED = (r) => ({ flags: 0x24, r_solved: r, status: 'unsettled', kpa: null });
const OK = (r, kpa) => ({ flags: 0x20, r_solved: r, status: 'ok', kpa });

function seedRows(db) {
  const rows = {};
  // Three unsettled channel-1 readings (the wet channel), channel 2 fine.
  rows.a = reading(db, { at: '2026-09-30T17:39:41.000Z', ch1: UNSETTLED(2438), ch2: OK(7200, 37.2), swt1: null, swt2: 37.2 });
  rows.b = reading(db, { at: '2026-10-03T12:29:42.000Z', ch1: UNSETTLED(4953), ch2: OK(10500, 54.7), swt1: null, swt2: 54.7 });
  rows.c = reading(db, { at: '2026-10-05T05:04:43.000Z', ch1: UNSETTLED(6043), ch2: OK(11000, 57.3), swt1: null, swt2: 57.3 });
  // Settled neighbour: has a value, never touched.
  rows.ok = reading(db, { at: '2026-10-03T12:24:42.000Z', ch1: OK(4940, 26.7), ch2: OK(10490, 54.6), swt1: 26.7, swt2: 54.6 });
  // Unsettled on channel 2 of another device.
  rows.other = reading(db, { deveui: OTHER, at: '2026-10-03T12:30:00.000Z', ch1: OK(4000, 22.1), ch2: UNSETTLED(9977), swt1: 22.1, swt2: null });
  // Unsettled, but other problems too: never filled.
  rows.noTemp = reading(db, { at: '2026-10-01T00:00:00.000Z', ch1: UNSETTLED(4953), ch2: OK(10500, null), swt1: null, swt2: null, source: 1 });
  rows.failedProbe = reading(db, { at: '2026-10-01T00:05:00.000Z', ch1: UNSETTLED(4953), ch2: OK(10500, null), swt1: null, swt2: null, statusByte: 0x06 });
  rows.beyond = reading(db, { at: '2026-10-01T00:10:00.000Z', ch1: UNSETTLED(300000), ch2: OK(10500, 54.7), swt1: null, swt2: 54.7 });
  rows.untrusted = reading(db, { at: '2026-10-01T00:15:00.000Z', ch1: { ...UNSETTLED(4953), flags: 0x25 }, ch2: OK(10500, 54.7), swt1: null, swt2: 54.7 });
  rows.unlinked = reading(db, { at: '2026-10-01T00:20:00.000Z', ch1: UNSETTLED(4953), ch2: OK(10500, 54.7), swt1: null, swt2: 54.7, link: false });
  rows.ddHasValue = reading(db, { at: '2026-10-01T00:25:00.000Z', ch1: UNSETTLED(4953), ch2: OK(10500, 54.7), swt1: 26.9, swt2: 54.7 });
  rows.hot = reading(db, { at: '2026-10-01T00:30:00.000Z', ch1: UNSETTLED(4953), ch2: OK(10500, null), swt1: null, swt2: null, temp: 55 });
  rows.saturated = reading(db, { at: '2026-10-01T00:35:00.000Z', ch1: UNSETTLED(500), ch2: OK(10500, 54.7), swt1: null, swt2: 54.7 });
  // Filled, but its stored resistance sits on the 1000 ohm formula edge.
  rows.edge = reading(db, { at: '2026-10-02T00:00:00.000Z', ch1: UNSETTLED(1000), ch2: OK(10500, 54.7), swt1: null, swt2: 54.7 });
  return rows;
}

function setup({ linked }) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-unsettled-'));
  dbPath = path.join(dir, 'farming.db');
  fs.copyFileSync(SEED_DB, dbPath);
  const db = open();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'owner', 'x', ?)").run(now);
  for (const eui of [DEVEUI, OTHER]) {
    db.prepare("INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at, gateway_device_eui) VALUES (?, ?, 'DRAGINO_LSN50', 1, ?, ?, ?)")
      .run(eui, 'WM ' + eui.slice(-1), now, now, GATEWAY);
  }
  if (linked) {
    db.prepare("INSERT INTO sync_link_state (peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, ?, ?)").run(GATEWAY, now);
  }
  const rows = seedRows(db);
  // The append events the INSERT trigger queued on a linked gateway: delivered,
  // as on a gateway whose outbox has drained.
  db.exec("UPDATE sync_outbox SET delivered_at = occurred_at WHERE delivered_at IS NULL");
  db.close();
  return rows;
}

// A DEVICE_DATA_APPENDED event for one reading's device_data row, as the
// INSERT trigger writes it; delivered: whether the cloud already took it.
function outboxEvent(db, deveui, at, { delivered = false } = {}) {
  db.prepare("INSERT INTO sync_outbox (event_uuid, aggregate_type, aggregate_key, op, payload_json, occurred_at, delivered_at) VALUES (?, 'DEVICE_DATA', ?, 'DEVICE_DATA_APPENDED', '{}', ?, ?)")
    .run('ev-' + deveui + at, deveui + '|' + at, at, delivered ? at : null);
}

function snapshot() {
  const db = open();
  const out = {
    dd: db.prepare('SELECT id, swt_1, swt_2 FROM device_data ORDER BY id').all().map((r) => ({ ...r })),
    wr: db.prepare('SELECT id, ch1_status, ch1_kpa, ch2_status, ch2_kpa, conversion_version FROM watermark_readings ORDER BY id').all().map((r) => ({ ...r })),
    dirty: db.prepare("SELECT row_key, source_row_id, status, changed_at FROM sync_history_dirty_keys WHERE table_name = 'device_data' ORDER BY row_key").all().map((r) => ({ ...r })),
    outbox: db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n
  };
  db.close();
  return out;
}

const kpaAt = (r) => conversion.tensionFromResistance(r, 16.81).kpa;

describe('repair-watermark-unsettled', () => {
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  describe('on a linked gateway', () => {
    let rows;
    beforeEach(() => { rows = setup({ linked: true }); });

    it('dry run counts per device and channel and writes nothing', async () => {
      const before = snapshot();
      const lines = [];
      const result = await repair.run(dbPath, { apply: false, log: (l) => lines.push(l) });
      assert.deepEqual(snapshot(), before);
      assert.deepEqual(result.fill, { [DEVEUI + ' ch1']: 4, [OTHER + ' ch2']: 1 });
      assert.deepEqual(result.skipped, {
        [DEVEUI + ' ch1']: {
          temperature_missing: 2, temperature_out_of_range: 1, outside_200ss_range: 1, saturated: 1,
          invalid_sample: 1, no_device_data_row: 1, device_data_has_value: 1
        }
      });
      assert.equal(result.boundary, 1);
      assert.deepEqual(result.backlog, {});
      assert.equal(result.oldest, '2026-09-30T17:39:41.000Z');
      assert.equal(result.applied, false);
      const text = lines.join('\n');
      assert.match(text, /dry run/);
      assert.match(text, new RegExp(DEVEUI + ' ch1: fill 4'));
      assert.match(text, /on a formula edge .*: 1\n/);
      assert.match(text, /outbox backlog .*: 0/);
      assert.match(text, /oldest value to fill: 2026-09-30T17:39:41.000Z/);
      assert.match(text, new RegExp(OTHER + ' ch2: fill 1'));
    });

    it('apply fills only flag-only rows, in both tables, and queues one correction per row', async () => {
      const before = snapshot();
      const result = await repair.run(dbPath, { apply: true, log: () => {} });
      assert.equal(result.applied, true);
      const after = snapshot();
      const dd = Object.fromEntries(after.dd.map((r) => [r.id, r]));
      const wr = Object.fromEntries(after.wr.map((r) => [r.id, r]));

      assert.equal(result.filled, 5);
      for (const [key, r] of [['a', 2438], ['b', 4953], ['c', 6043], ['edge', 1000]]) {
        assert.equal(dd[rows[key].ddId].swt_1, kpaAt(r), key + ' device_data');
        assert.equal(wr[rows[key].wrId].ch1_kpa, kpaAt(r), key + ' readings');
        assert.equal(wr[rows[key].wrId].ch1_status, 'unsettled', key + ' keeps its flag');
        assert.equal(wr[rows[key].wrId].conversion_version, 'wm-lsn50-p3-v1', key + ' keeps the version that ingested it');
      }
      // Field example rows: near the analysis' "if converted" values; those rows
      // had their own soil temperatures (16.5-17.0 C), these use 16.81 C.
      assert.ok(Math.abs(dd[rows.a.ddId].swt_1 - 15.3) <= 0.2);
      assert.ok(Math.abs(dd[rows.b.ddId].swt_1 - 26.8) <= 0.2);
      assert.ok(Math.abs(dd[rows.c.ddId].swt_1 - 31.8) <= 0.2);
      assert.equal(dd[rows.other.ddId].swt_2, kpaAt(9977));
      assert.equal(wr[rows.other.wrId].ch2_kpa, dd[rows.other.ddId].swt_2);

      // Untouched: settled rows, rows with other faults, the unlinked reading,
      // and a device_data cell that already has a value.
      const beforeDd = Object.fromEntries(before.dd.map((r) => [r.id, r]));
      const beforeWr = Object.fromEntries(before.wr.map((r) => [r.id, r]));
      for (const key of ['ok', 'noTemp', 'failedProbe', 'beyond', 'untrusted', 'unlinked', 'ddHasValue', 'hot', 'saturated']) {
        assert.deepEqual(dd[rows[key].ddId], beforeDd[rows[key].ddId], key + ' device_data untouched');
        assert.deepEqual(wr[rows[key].wrId], beforeWr[rows[key].wrId], key + ' readings untouched');
      }

      // The dirty-history trigger carries each corrected row to the cloud once;
      // no hand-made DEVICE_DATA_APPENDED event.
      const filledIds = ['a', 'b', 'c', 'edge', 'other'].map((k) => rows[k].ddId).sort((x, y) => x - y);
      assert.deepEqual(after.dirty.map((d) => d.source_row_id).sort((x, y) => x - y), filledIds);
      assert.ok(after.dirty.every((d) => d.status === 'pending' && d.row_key.startsWith('DEVICE_DATA|' + GATEWAY + '|')));
      assert.equal(after.outbox, before.outbox);
    });

    it('is safe to run twice: the second run fills nothing and queues nothing', async () => {
      await repair.run(dbPath, { apply: true, log: () => {} });
      const first = snapshot();
      const second = await repair.run(dbPath, { apply: true, log: () => {} });
      assert.deepEqual(second.fill, {});
      assert.equal(second.filled, 0);
      assert.deepEqual(snapshot(), first);
    });
  });

  describe('with unsent DEVICE_DATA events for rows it would fill', () => {
    beforeEach(() => {
      setup({ linked: true });
      const db = open();
      outboxEvent(db, DEVEUI, '2026-09-30T17:39:41.000Z');
      outboxEvent(db, DEVEUI, '2026-10-03T12:29:42.000Z');
      outboxEvent(db, DEVEUI, '2026-10-05T05:04:43.000Z', { delivered: true });
      outboxEvent(db, DEVEUI, '2026-10-03T12:24:42.000Z'); // a settled row: not affected
      db.close();
    });

    it('the dry run reports the backlog per device', async () => {
      const lines = [];
      const result = await repair.run(dbPath, { apply: false, log: (l) => lines.push(l) });
      assert.deepEqual(result.backlog, { [DEVEUI]: 2 });
      assert.match(lines.join('\n'), new RegExp('outbox backlog .*: 2 \\(' + DEVEUI + ' 2\\)'));
    });

    it('apply refuses and writes nothing', async () => {
      const before = snapshot();
      await assert.rejects(repair.run(dbPath, { apply: true, log: () => {} }), /wait for the outbox to drain/);
      assert.deepEqual(snapshot(), before);
    });

    it('apply proceeds with the explicit override', async () => {
      const result = await repair.run(dbPath, { apply: true, ignoreOutboxBacklog: true, log: () => {} });
      assert.equal(result.filled, 5);
    });
  });

  it('a failure inside the write transaction commits nothing', async () => {
    const rows = setup({ linked: true });
    const db = open();
    db.exec('CREATE TRIGGER test_fail_bu BEFORE UPDATE OF swt_1 ON device_data WHEN NEW.id = ' + rows.b.ddId +
      " BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    db.close();
    const before = snapshot();
    await assert.rejects(repair.run(dbPath, { apply: true, log: () => {} }), /test failure/);
    assert.deepEqual(snapshot(), before);
  });

  it('says whether the oldest value is still inside each rollup window', async () => {
    setup({ linked: true });
    const inside = await repair.run(dbPath, { apply: false, nowMs: Date.parse('2026-10-06T00:00:00Z'), log: () => {} });
    assert.deepEqual(inside.windows, { gateway_hourly: true, gateway_daily: true, cloud_hourly: true, cloud_daily: true });
    const lines = [];
    const later = await repair.run(dbPath, { apply: false, nowMs: Date.parse('2026-10-08T00:00:00Z'), log: (l) => lines.push(l) });
    assert.deepEqual(later.windows, { gateway_hourly: true, gateway_daily: true, cloud_hourly: false, cloud_daily: true });
    assert.match(lines.join('\n'), /cloud hourly 7 d: outside/);
  });

  it('on an unlinked gateway it fills the values and queues no correction', async () => {
    setup({ linked: false });
    const result = await repair.run(dbPath, { apply: true, log: () => {} });
    assert.equal(result.linked, false);
    assert.deepEqual(result.fill, { [DEVEUI + ' ch1']: 4, [OTHER + ' ch2']: 1 });
    assert.equal(snapshot().dirty.length, 0);
  });

  it('parses the override flag', () => {
    assert.equal(repair.parseArgs(['x.db', '--apply', '--ignore-outbox-backlog']).ignoreOutboxBacklog, true);
    assert.equal(repair.parseArgs(['x.db']).apply, false);
  });

  it('refuses a missing database file', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-unsettled-'));
    await assert.rejects(repair.run(path.join(dir, 'absent.db'), { apply: false, log: () => {} }), /does not exist/);
  });
});
