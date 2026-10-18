#!/usr/bin/env node
'use strict';
// Fill the soil tension of WATERMARK readings that conversion wm-lsn50-p3-v1
// stored without a value only because the firmware flagged them unsettled
// (#415). From wm-lsn50-p3-v2 on, ingest stores those values itself; this
// one-off repair closes the gaps left in history before the upgrade.
//
// Operator tool. deploy.sh never runs it. It needs this file and
// lib/osi-migrate/runner-iface.js in the same relative layout (on a gateway,
// stage both under one directory, e.g. /tmp/wm-repair/scripts and
// /tmp/wm-repair/lib/osi-migrate), node and the sqlite3 CLI.
//
//   node scripts/repair-watermark-unsettled.js <farming.db>            dry run (default, read-only)
//   node scripts/repair-watermark-unsettled.js <farming.db> --apply    write
//   --helper-dir <dir>         osi-watermark-helper location (default: this
//                              repository's copy, else /srv/node-red/osi-watermark-helper)
//   --ignore-outbox-backlog    apply although DEVICE_DATA events for rows it
//                              fills are still unsent. RISK: such an event
//                              carries the old null value; delivered after
//                              the correction, it overwrites the corrected
//                              value on the cloud with null for good.
//
// A channel is filled only when ALL of these hold:
//   - watermark_readings: frame accepted, chN_status 'unsettled', chN_kpa NULL;
//   - flags: unsettled (0x04) set, no untrusted flag (0x01, 0x02, 0x08, 0x10);
//   - temperature: measured by the DS18B20 (source 2, failure bit clear);
//   - tensionFromResistance(chN_r_solved, temperature) is 'ok' (0-50 C, not
//     short, saturated or outside the 200SS range);
//   - the linked device_data row exists, belongs to the same device and its
//     swt_N is NULL.
// Anything else is counted as skipped, with its reason, and left alone.
//
// Writes, in one transaction: watermark_readings.chN_kpa and device_data.swt_N,
// each guarded by "IS NULL", so a second run changes nothing. chN_status stays
// 'unsettled' (the flag travels with the value) and conversion_version stays
// 'wm-lsn50-p3-v1': a v1 row with status 'unsettled' and a kPa is a repaired
// row.
//
// Accuracy: the value comes from the stored chN_r_solved, which the gateway
// solved with the calibration of the time but rounded to whole ohms. About
// 1.7 % of recomputed values therefore differ from live v2 conversion by
// 0.1 kPa. A true resistance within 0.5 ohm above the 1000 ohm or 8000 ohm
// formula edge is stored as exactly 1000 or 8000 and is converted with the
// segment below: 0.2-0.7 kPa off at 17 C, up to 20 kPa at 50 C. The output
// counts those rows ("on a formula edge").
//
// Cloud: on a linked gateway, the device_data UPDATE fires
// trg_sync_device_data_dirty_au, one sync_history_dirty_keys row per corrected
// device_data row, and the history correction phase sends it. No
// DEVICE_DATA_APPENDED event is written by hand. An unsent append event for a
// filled row would later overwrite the correction with null, so --apply
// refuses while any is pending (see --ignore-outbox-backlog).
//
// Rollups: corrected hours refresh only inside the rollup windows (gateway
// hourly 8 d, daily 120 d; cloud hourly 7 d, daily 90 d). Older buckets stay
// stale until a rollup backfill. The output gives the oldest value it fills
// and whether it is still inside each window.
//
// Take the usual pre-repair backup of /data/db first.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cliRunner, parseSqliteJsonOutput } = require('../lib/osi-migrate/runner-iface');

const FLAG_UNSETTLED = 0x04;
const FLAGS_UNTRUSTED = 0x1B;
const SOURCE_DS18B20 = 2;
const DS18B20_FAILED = 0x04;
const FORMULA_EDGES_OHM = [1000, 8000];
const EUI = /^[0-9A-F]{16}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLUP_WINDOWS = [
  ['gateway_hourly', 'gateway hourly', 8], ['gateway_daily', 'gateway daily', 120],
  ['cloud_hourly', 'cloud hourly', 7], ['cloud_daily', 'cloud daily', 90]
];

function loadConversion(helperDir) {
  const candidates = helperDir
    ? [helperDir]
    : [path.join(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper'),
      '/srv/node-red/osi-watermark-helper'];
  for (const dir of candidates) {
    const file = path.join(dir, 'conversion.js');
    if (fs.existsSync(file)) return require(file);
  }
  throw new Error('osi-watermark-helper conversion.js not found in: ' + candidates.join(', '));
}

// Dry run: every query through a read-only sqlite3 process.
function readOnlyRunner(dbPath) {
  return {
    async all(sql) {
      return parseSqliteJsonOutput(execFileSync('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 30000', dbPath, sql],
        { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 }));
    }
  };
}

function temperatureOf(row) {
  const t = row.soil_temp_c;
  if (row.soil_temp_source !== SOURCE_DS18B20 || (Number(row.status_byte) & DS18B20_FAILED) || t === null) return null;
  return t;
}

// Returns { kpa } or { skip: reason } for one channel of one candidate row.
function judge(row, conversion) {
  const flags = Number(row.flags);
  if (!(flags & FLAG_UNSETTLED) || (flags & FLAGS_UNTRUSTED)) return { skip: 'invalid_sample' };
  if (row.r_solved === null) return { skip: 'no_resistance' };
  const temp = temperatureOf(row);
  if (temp === null) return { skip: 'temperature_missing' };
  const t = conversion.tensionFromResistance(row.r_solved, temp);
  if (t.status !== 'ok') return { skip: t.status };
  if (row.dd_id === null) return { skip: 'no_device_data_row' };
  if (row.dd_deveui !== row.deveui) return { skip: 'device_data_other_device' };
  if (row.dd_swt !== null) return { skip: 'device_data_has_value' };
  return { kpa: t.kpa };
}

function candidateSql(n) {
  return 'SELECT wr.id, UPPER(wr.deveui) AS deveui, wr.soil_temp_c, wr.soil_temp_source, wr.status_byte, ' +
    `wr.ch${n}_flags AS flags, wr.ch${n}_r_solved AS r_solved, dd.id AS dd_id, UPPER(dd.deveui) AS dd_deveui, ` +
    `dd.swt_${n} AS dd_swt, dd.recorded_at AS dd_recorded_at, dd.deveui || '|' || dd.recorded_at AS dd_key ` +
    'FROM watermark_readings wr LEFT JOIN device_data dd ON dd.id = wr.device_data_id ' +
    `WHERE wr.frame_status = 'accepted' AND wr.ch${n}_status = 'unsettled' AND wr.ch${n}_kpa IS NULL ` +
    'ORDER BY wr.deveui, wr.recorded_at, wr.id';
}

// Unsent append events, keyed like trg_dp_device_data_outbox_ai keys them.
const PENDING_DEVICE_DATA_SQL = "SELECT aggregate_key FROM sync_outbox WHERE aggregate_type = 'DEVICE_DATA' " +
  "AND op = 'DEVICE_DATA_APPENDED' AND delivered_at IS NULL AND rejected_at IS NULL";

function updateSql(n, fill) {
  if (!Number.isInteger(fill.id) || !Number.isInteger(fill.dd_id) || !Number.isFinite(fill.kpa) || !EUI.test(fill.deveui)) {
    throw new Error('refusing to write an unexpected value: ' + JSON.stringify(fill));
  }
  return `UPDATE watermark_readings SET ch${n}_kpa = ${fill.kpa} WHERE id = ${fill.id} ` +
    `AND ch${n}_status = 'unsettled' AND ch${n}_kpa IS NULL;\n` +
    `UPDATE device_data SET swt_${n} = ${fill.kpa} WHERE id = ${fill.dd_id} ` +
    `AND UPPER(deveui) = '${fill.deveui}' AND swt_${n} IS NULL;\n`;
}

async function plan(db, conversion) {
  const fill = {};
  const skipped = {};
  const fills = [];
  for (const n of [1, 2]) {
    for (const row of await db.all(candidateSql(n))) {
      const key = row.deveui + ' ch' + n;
      const verdict = judge(row, conversion);
      if (verdict.skip) {
        skipped[key] = skipped[key] || {};
        skipped[key][verdict.skip] = (skipped[key][verdict.skip] || 0) + 1;
        continue;
      }
      fill[key] = (fill[key] || 0) + 1;
      fills.push({ n, id: row.id, dd_id: row.dd_id, deveui: row.deveui, kpa: verdict.kpa,
        r_solved: row.r_solved, recorded_at: row.dd_recorded_at, dd_key: row.dd_key });
    }
  }
  return { fill, skipped, fills };
}

async function run(dbPath, { apply = false, helperDir = null, ignoreOutboxBacklog = false, nowMs = Date.now(), log = console.log } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error('refusing: database file does not exist: ' + dbPath);
  const conversion = loadConversion(helperDir);
  const db = apply ? cliRunner(dbPath) : readOnlyRunner(dbPath);
  const table = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'watermark_readings'");
  if (!table.length) throw new Error('refusing: no watermark_readings table in ' + dbPath);
  const link = await db.all("SELECT linked FROM sync_link_state WHERE peer_node = 'cloud'");
  const linked = link.length > 0 && Number(link[0].linked) === 1;

  const { fill, skipped, fills } = await plan(db, conversion);
  const pending = new Set((await db.all(PENDING_DEVICE_DATA_SQL)).map((r) => r.aggregate_key));
  const backlog = {};
  const seenKeys = new Set();
  for (const f of fills) {
    if (!pending.has(f.dd_key) || seenKeys.has(f.dd_key)) continue;
    seenKeys.add(f.dd_key);
    backlog[f.deveui] = (backlog[f.deveui] || 0) + 1;
  }
  const backlogTotal = Object.values(backlog).reduce((a, b) => a + b, 0);
  const boundary = fills.filter((f) => FORMULA_EDGES_OHM.includes(f.r_solved)).length;
  const oldest = fills.reduce((min, f) => (min === null || f.recorded_at < min ? f.recorded_at : min), null);
  const windows = {};
  if (oldest) {
    const ageMs = nowMs - Date.parse(oldest);
    for (const [id, , days] of ROLLUP_WINDOWS) windows[id] = ageMs <= days * DAY_MS;
  }

  log(`[repair-watermark-unsettled] ${apply ? 'apply' : 'dry run'}: ${dbPath}`);
  const keys = Array.from(new Set(Object.keys(fill).concat(Object.keys(skipped)))).sort();
  for (const key of keys) {
    const reasons = Object.entries(skipped[key] || {}).map(([r, c]) => `${r} ${c}`).join(', ');
    log(`  ${key}: fill ${fill[key] || 0}${reasons ? `, skipped ${reasons}` : ''}`);
  }
  log(`  on a formula edge (stored 1000 or 8000 ohm, may be converted with the wrong segment): ${boundary}`);
  log(`  outbox backlog (unsent DEVICE_DATA events for rows to fill): ${backlogTotal}` +
    (backlogTotal ? ` (${Object.entries(backlog).map(([d, c]) => `${d} ${c}`).join(', ')})` : ''));
  if (oldest) {
    log(`  oldest value to fill: ${oldest}; rollup windows: ` + ROLLUP_WINDOWS
      .map(([id, label, days]) => `${label} ${days} d: ${windows[id] ? 'inside' : 'outside (stale until a rollup backfill)'}`).join('; '));
  }

  let filled = 0;
  if (apply && fills.length) {
    if (backlogTotal > 0 && !ignoreOutboxBacklog) {
      throw new Error(`refusing: ${backlogTotal} unsent DEVICE_DATA event(s) carry the old null value for rows to fill; ` +
        'wait for the outbox to drain and run again (or pass --ignore-outbox-backlog and accept that those rows may end null on the cloud)');
    }
    await db.exec('BEGIN IMMEDIATE;\n' + fills.map((f) => updateSql(f.n, f)).join('') + 'COMMIT;\n');
    // Count what really changed: a planned channel still waiting was skipped by its guard.
    const still = new Set();
    for (const n of [1, 2]) for (const row of await db.all(candidateSql(n))) still.add(n + ':' + row.id);
    filled = fills.filter((f) => !still.has(f.n + ':' + f.id)).length;
  }
  const total = fills.length;
  log(`  total: ${apply ? `filled ${filled} of ${total} planned` : `would fill ${total}`} channel value(s); cloud link ${linked
    ? 'on: each corrected device_data row is queued once as a history correction'
    : 'off: nothing is queued'}`);
  return { applied: apply, linked, fill, skipped, filled, boundary, backlog, oldest, windows };
}

function parseArgs(argv) {
  const out = { dbPath: null, apply: false, helperDir: null, ignoreOutboxBacklog: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--ignore-outbox-backlog') out.ignoreOutboxBacklog = true;
    else if (a === '--helper-dir') out.helperDir = argv[++i];
    else if (!a.startsWith('--') && !out.dbPath) out.dbPath = a;
    else throw new Error('unknown argument: ' + a);
  }
  if (!out.dbPath) {
    throw new Error('usage: repair-watermark-unsettled.js <farming.db> [--apply] [--helper-dir <dir>] [--ignore-outbox-backlog]');
  }
  return out;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => { const a = parseArgs(process.argv.slice(2)); return run(a.dbPath, a); })
    .catch((e) => { console.error('[repair-watermark-unsettled] FAILED: ' + e.message); process.exit(1); });
}

module.exports = { run, judge, parseArgs };
