#!/usr/bin/env node
'use strict';
// Fill the soil tension of WATERMARK readings that conversion wm-lsn50-p3-v1
// stored without a value only because the firmware flagged them unsettled
// (#415). From wm-lsn50-p3-v2 on, ingest stores those values itself; this
// one-off repair closes the gaps left in history before the upgrade.
//
// Operator tool. deploy.sh never runs it.
//
//   node scripts/repair-watermark-unsettled.js <farming.db>            dry run (default)
//   node scripts/repair-watermark-unsettled.js <farming.db> --apply    write
//   --helper-dir <dir>   osi-watermark-helper location (default: this
//                        repository's copy, else /srv/node-red/osi-watermark-helper)
//
// A channel is filled only when ALL of these hold:
//   - watermark_readings: frame accepted, chN_status 'unsettled', chN_kpa NULL;
//   - flags: unsettled (0x04) set, no untrusted flag (0x01, 0x02, 0x08, 0x10);
//   - temperature: measured by the DS18B20 (source 2, failure bit clear), 0-50 C;
//   - tensionFromResistance(chN_r_solved, temperature) is 'ok' (not short,
//     saturated or outside the 200SS range);
//   - the linked device_data row exists, belongs to the same device and its
//     swt_N is NULL.
// Anything else is counted as skipped, with its reason, and left alone.
//
// Writes, in one transaction: watermark_readings.chN_kpa and device_data.swt_N,
// each guarded by "IS NULL", so a second run changes nothing. chN_status stays
// 'unsettled' (the flag travels with the value) and conversion_version stays
// 'wm-lsn50-p3-v1': a v1 row with status 'unsettled' and a kPa is a repaired
// row. The value comes from the stored chN_r_solved, which the gateway solved
// with the calibration of the time. Its rounding to whole ohms moves the
// tension by under 0.01 kPa, so rarely the stored 0.1 kPa digit differs from
// what v2 ingest would have stored.
//
// Cloud: on a linked gateway, the device_data UPDATE fires
// trg_sync_device_data_dirty_au, one sync_history_dirty_keys row per corrected
// device_data row, and the history correction phase sends it. No
// DEVICE_DATA_APPENDED event is written by hand (the cloud would reject it as
// equal_version_payload_conflict). Rollups refresh at the nightly history
// rollup job (hourly buckets for the last 8 days, daily 120, weekly 370).
//
// Take the usual pre-repair backup of /data/db first.

const fs = require('node:fs');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');

const FLAG_UNSETTLED = 0x04;
const FLAGS_UNTRUSTED = 0x1B;
const SOURCE_DS18B20 = 2;
const DS18B20_FAILED = 0x04;
const EUI = /^[0-9A-F]{16}$/;

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
    `wr.ch${n}_flags AS flags, wr.ch${n}_r_solved AS r_solved, dd.id AS dd_id, UPPER(dd.deveui) AS dd_deveui, dd.swt_${n} AS dd_swt ` +
    'FROM watermark_readings wr LEFT JOIN device_data dd ON dd.id = wr.device_data_id ' +
    `WHERE wr.frame_status = 'accepted' AND wr.ch${n}_status = 'unsettled' AND wr.ch${n}_kpa IS NULL ` +
    'ORDER BY wr.deveui, wr.recorded_at, wr.id';
}

function updateSql(n, fill) {
  if (!Number.isInteger(fill.id) || !Number.isInteger(fill.dd_id) || !Number.isFinite(fill.kpa) || !EUI.test(fill.deveui)) {
    throw new Error('refusing to write an unexpected value: ' + JSON.stringify(fill));
  }
  return `UPDATE watermark_readings SET ch${n}_kpa = ${fill.kpa} WHERE id = ${fill.id} ` +
    `AND ch${n}_status = 'unsettled' AND ch${n}_kpa IS NULL;\n` +
    `UPDATE device_data SET swt_${n} = ${fill.kpa} WHERE id = ${fill.dd_id} ` +
    `AND UPPER(deveui) = '${fill.deveui}' AND swt_${n} IS NULL;\n`;
}

async function run(dbPath, { apply = false, helperDir = null, log = console.log } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error('refusing: database file does not exist: ' + dbPath);
  const conversion = loadConversion(helperDir);
  const db = cliRunner(dbPath);
  const table = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'watermark_readings'");
  if (!table.length) throw new Error('refusing: no watermark_readings table in ' + dbPath);
  const link = await db.all("SELECT linked FROM sync_link_state WHERE peer_node = 'cloud'");
  const linked = link.length > 0 && Number(link[0].linked) === 1;

  const fill = {};
  const skipped = {};
  let sql = '';
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
      sql += updateSql(n, { id: row.id, dd_id: row.dd_id, deveui: row.deveui, kpa: verdict.kpa });
    }
  }

  log(`[repair-watermark-unsettled] ${apply ? 'apply' : 'dry run'}: ${dbPath}`);
  const keys = Array.from(new Set(Object.keys(fill).concat(Object.keys(skipped)))).sort();
  for (const key of keys) {
    const reasons = Object.entries(skipped[key] || {}).map(([r, c]) => `${r} ${c}`).join(', ');
    log(`  ${key}: ${apply ? 'filled' : 'fill'} ${fill[key] || 0}${reasons ? `, skipped ${reasons}` : ''}`);
  }
  const total = Object.values(fill).reduce((a, b) => a + b, 0);
  log(`  total: ${apply ? 'filled' : 'would fill'} ${total} channel value(s); cloud link ${linked
    ? 'on: each corrected device_data row is queued once as a history correction'
    : 'off: nothing is queued'}`);
  if (apply && sql) await db.exec('BEGIN IMMEDIATE;\n' + sql + 'COMMIT;\n');
  return { applied: apply, linked, fill, skipped };
}

function parseArgs(argv) {
  const out = { dbPath: null, apply: false, helperDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--helper-dir') out.helperDir = argv[++i];
    else if (!a.startsWith('--') && !out.dbPath) out.dbPath = a;
    else throw new Error('unknown argument: ' + a);
  }
  if (!out.dbPath) throw new Error('usage: repair-watermark-unsettled.js <farming.db> [--apply] [--helper-dir <dir>]');
  return out;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => { const a = parseArgs(process.argv.slice(2)); return run(a.dbPath, a); })
    .catch((e) => { console.error('[repair-watermark-unsettled] FAILED: ' + e.message); process.exit(1); });
}

module.exports = { run, judge, parseArgs };
