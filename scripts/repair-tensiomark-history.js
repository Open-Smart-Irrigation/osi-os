#!/usr/bin/env node
'use strict';

// Repairs the historical Tensiomark kPa rounding loss from a copied farming.db.
// The default is a read-only report. Applying requires an explicit backup dir;
// all writes are issued through the sqlite3 CLI so this also runs on Pi Node 20.
//
// Apply refuses, like repair-watermark-clipped.js, when the gateway is not
// cloud-linked or when an undelivered DEVICE_DATA_APPENDED event exists for a
// candidate row: the correction travels through the device_data dirty-key
// path and must not race an older rounded append still in the outbox. Both
// checks run before the backup and again inside the write transaction.
//
// sqlite3 CLI version caveat: the gateway's sqlite3 may print REALs with fewer
// significant digits in -json output than a workstation's (3.53 prints 17).
// Stored canonical REALs are therefore never compared after JSON parsing:
// every canonical comparison runs in SQL against the expected value with a
// relative tolerance of CANONICAL_TOLERANCE (see canonicalStateSql), which also
// absorbs last-digit differences in older sqlite3 decimal-literal parsing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const EUI_RE = /^[A-F0-9]{16}$/;
const SQLITE = process.env.SQLITE3 || 'sqlite3';
const TRIGGERS = ['trg_sync_device_data_dirty_au', 'trg_sync_tensiomark_observations_dirty_au'];
const CONVERSION = 'matric-potential-hpa-v1';
const NORMALIZATION_VERSION = 2;
// Far below the legacy two-decimal rounding step (>= 0.005 kPa when it changed
// a value) and far above double rounding noise.
const CANONICAL_TOLERANCE = 1e-12;
const CANONICAL_KEYS = ['swt_1', 'swt_2', 'swt_3', 'soil_temp_1', 'soil_temp_2', 'soil_temp_3', 'bat_v'];
const CLASSIFY_CHUNK = 200;

function usage() {
  throw new Error('usage: node scripts/repair-tensiomark-history.js --db <path> --deveui <16-hex> [--apply --backup-dir <dir>]');
}

function parseArgs(argv) {
  const options = { apply: false, db: null, deveui: null, backupDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') options.db = argv[++i];
    else if (arg === '--deveui') options.deveui = String(argv[++i] || '').trim().toUpperCase();
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--backup-dir') options.backupDir = argv[++i];
    else if (arg === '--help') usage();
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.db || !options.deveui || !EUI_RE.test(options.deveui)) usage();
  if (!fs.existsSync(options.db) || !fs.statSync(options.db).isFile()) throw new Error('database path must be an existing file');
  if (options.apply && !options.backupDir) throw new Error('--apply requires --backup-dir');
  return options;
}

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite SQL number');
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqliteJson(dbPath, query) {
  const output = execFileSync(SQLITE, ['-readonly', '-json', '-cmd', '.timeout 30000', dbPath, query], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function sqliteWrite(dbPath, script) {
  return execFileSync(SQLITE, ['-bail', '-cmd', '.timeout 30000', dbPath], {
    input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

function scalar(dbPath, query, field) {
  const row = sqliteJson(dbPath, query)[0];
  return row ? row[field] : undefined;
}

function integrity(dbPath) {
  const check = sqliteJson(dbPath, 'PRAGMA integrity_check;').map((row) => row.integrity_check);
  if (check.length !== 1 || check[0] !== 'ok') throw new Error('integrity_check_failed');
  const foreign = sqliteJson(dbPath, 'PRAGMA foreign_key_check;');
  if (foreign.length) throw new Error('foreign_key_check_failed');
}

function normalizer() {
  const candidates = [
    path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/tensiomark-live'),
    '/srv/node-red/osi-sdi12-normalize/tensiomark-live',
    '/usr/share/node-red/osi-sdi12-normalize/tensiomark-live',
    '/usr/lib/node-red/osi-sdi12-normalize/tensiomark-live',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(`${candidate}.js`)) return require(candidate);
  }
  throw new Error('tensiomark_normalizer_unavailable');
}

function roundLegacy(value) {
  return Math.round(value * 100) / 100;
}

function sameNumber(actual, expected) {
  return typeof actual === 'number' && Number.isFinite(actual) && actual === expected;
}

// SQL truth value: column holds a finite number within tolerance of expected.
function nearSql(column, expected) {
  const literal = sql(expected);
  return `(typeof(${column}) IN ('integer','real') AND abs(${column} - ${literal}) <= ${CANONICAL_TOLERANCE} * max(1.0, abs(${literal})))`;
}

function channelConditionSql(column, key, expected) {
  const full = nearSql(column, expected);
  return key.startsWith('swt_') ? `(${full} OR ${nearSql(column, roundLegacy(expected))})` : full;
}

// 'full' when the stored value is the full-precision expectation, 'legacy' when
// it is the legacy two-decimal swt value, otherwise 'mismatch'.
function canonicalStateSql(column, key, expected) {
  const legacy = key.startsWith('swt_') ? ` WHEN ${nearSql(column, roundLegacy(expected))} THEN 'legacy'` : '';
  return `CASE WHEN ${nearSql(column, expected)} THEN 'full'${legacy} ELSE 'mismatch' END`;
}

function canonicalChannelEntries(channels) {
  const entries = Object.entries(channels || {});
  if (entries.some(([key, value]) => !CANONICAL_KEYS.includes(key) || typeof value !== 'number' || !Number.isFinite(value))) return null;
  return entries;
}

// One query per chunk of candidates; returns Map(observation id -> {key: state}).
function classifyCanonical(dbPath, pending) {
  const states = new Map();
  for (let start = 0; start < pending.length; start += CLASSIFY_CHUNK) {
    const selects = pending.slice(start, start + CLASSIFY_CHUNK).map(({ row, entries }) => {
      const pairs = entries.map(([key, expected]) => `${sql(key)},${canonicalStateSql(`d.${key}`, key, expected)}`).join(',');
      return `SELECT ${sql(row.id)} AS observation_id, json_object(${pairs}) AS states FROM device_data d WHERE d.id=${sql(row.device_data_id)}`;
    });
    for (const result of sqliteJson(dbPath, selects.join(' UNION ALL ') + ';')) {
      states.set(Number(result.observation_id), JSON.parse(result.states));
    }
  }
  return states;
}

function canonicalChannelsMatch(state, entries) {
  return entries.every(([key]) => state[key] === 'full' || (key.startsWith('swt_') && state[key] === 'legacy'));
}

function canonicalChannelsAreFull(state, entries) {
  return entries.every(([key]) => state[key] === 'full');
}

function normalizedIsCurrent(value, result) {
  if (!value || value.normalization_version !== NORMALIZATION_VERSION || value.conversion !== CONVERSION
    || value.disposition !== 'accepted' || JSON.stringify(value.native_pf || {}) !== JSON.stringify(result.nativePf || {})) return false;
  return Object.entries(result.channels || {}).every(([key, expected]) => sameNumber(value.channels && value.channels[key], expected));
}

function loadRows(dbPath, deveui) {
  const rows = sqliteJson(dbPath, `SELECT o.id,o.device_data_id,o.deveui,o.recorded_at,o.received_at,hex(CAST(o.raw_response AS BLOB)) AS raw_response_hex,o.payload_base64,o.configuration_hash,o.configuration_json,o.disposition,o.normalized_json,
      d.id AS canonical_id,d.deveui AS canonical_deveui,d.recorded_at AS canonical_recorded_at
    FROM tensiomark_observations o LEFT JOIN device_data d ON d.id=o.device_data_id
    WHERE upper(o.deveui)=${sql(deveui)} ORDER BY o.id`);
  return rows.map((row) => Object.assign(row, {
    // sqlite3's JSON printer normalizes CRLF in TEXT output; the hex projection
    // preserves the retained packet bytes exactly for parser and SQL guards.
    raw_response: Buffer.from(row.raw_response_hex || '', 'hex').toString('latin1'),
  }));
}

function analyzeRow(row, duplicateKeys, normalize) {
  if (row.disposition !== 'accepted') return { reason: 'rejected_disposition' };
  const duplicateKey = `${row.device_data_id}|${String(row.deveui).toUpperCase()}|${row.recorded_at}`;
  if (duplicateKeys.has(duplicateKey)) return { reason: 'ambiguous_duplicate_observation' };
  if (!Number.isInteger(Number(row.device_data_id)) || Number(row.canonical_id) !== Number(row.device_data_id)
    || String(row.canonical_deveui || '').toUpperCase() !== String(row.deveui).toUpperCase()
    || row.canonical_recorded_at !== row.recorded_at) return { reason: 'canonical_row_mismatch' };
  let validation;
  try { validation = normalize.validateTensiomarkLayout(row.configuration_json); } catch (_) { validation = { ok: false }; }
  if (!validation.ok || row.configuration_hash !== validation.configurationHash) return { reason: 'configuration_mismatch' };
  if (typeof row.payload_base64 !== 'string' || !row.payload_base64) return { reason: 'payload_missing' };
  let result;
  try {
    result = normalize.normalizeTensiomarkUplink({ payloadBase64: row.payload_base64, fPort: 2 }, validation, { recordedAt: row.recorded_at });
  } catch (_) { result = null; }
  if (!result || !result.tensiomarkObservation || result.tensiomarkObservation.disposition !== 'accepted'
    || result.tensiomarkObservation.rawResponse !== row.raw_response) return { reason: 'payload_validation_failed' };
  const native = result.nativePf;
  if (!native || typeof native !== 'object' || Array.isArray(native)) return { reason: 'native_pf_unavailable' };
  const sourceTokens = new Map(row.raw_response.split('\r\n').filter(Boolean).map(line => {
    const match = /^([0-9A-Za-z])[+-][0-9]+\.[0-9]+([+-][0-9]+\.[0-9]+)$/.exec(line);
    return match ? [match[1], match[2]] : [null, null];
  }));
  const sensorsByChannel = new Map(validation.layout.sensors.map(sensor => [`swt_${sensor.channel}`, sensor]));
  const swtKeys = Object.keys(result.channels || {}).filter(key => key.startsWith('swt_'));
  if (swtKeys.length !== sensorsByChannel.size || !swtKeys.every(key => {
    const sensor = sensorsByChannel.get(key);
    return sensor && typeof native[key] === 'string' && native[key] === sourceTokens.get(sensor.address);
  })) return { reason: 'native_pf_unavailable' };
  let previous;
  try { previous = JSON.parse(row.normalized_json); } catch (_) { return { reason: 'normalized_json_invalid' }; }
  const entries = canonicalChannelEntries(result.channels);
  if (!entries) return { reason: 'canonical_value_mismatch' };
  return { reason: 'needs_canonical', row, result, previous, entries };
}

function finishRow(pending, state) {
  const { row, result, previous, entries } = pending;
  if (!state || !canonicalChannelsMatch(state, entries)) return { reason: 'canonical_value_mismatch' };
  if (canonicalChannelsAreFull(state, entries) && normalizedIsCurrent(previous, result)) return { reason: 'already_correct' };
  const next = Object.assign({}, previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {});
  next.normalization_version = NORMALIZATION_VERSION;
  next.conversion = CONVERSION;
  next.native_pf = result.nativePf || {};
  next.channels = Object.assign({}, next.channels || {}, result.channels || {});
  next.disposition = 'accepted';
  next.previous_normalized_json = row.normalized_json;
  return {
    reason: 'repairable', row, result, normalizedJson: JSON.stringify(next),
  };
}

function duplicateKeys(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (row.disposition !== 'accepted') continue;
    const key = `${row.device_data_id}|${String(row.deveui).toUpperCase()}|${row.recorded_at}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function precondition(candidate) {
  const row = candidate.row;
  const conditions = [
    `o.id=${sql(row.id)}`, `o.device_data_id=${sql(row.device_data_id)}`, `o.deveui=${sql(row.deveui)}`,
    `o.recorded_at=${sql(row.recorded_at)}`,
    "o.disposition='accepted'",
    `(SELECT COUNT(*) FROM tensiomark_observations other WHERE other.device_data_id=o.device_data_id AND upper(other.deveui)=upper(o.deveui) AND other.recorded_at=o.recorded_at AND other.disposition='accepted')=1`,
    `hex(CAST(o.raw_response AS BLOB))=${sql(Buffer.from(row.raw_response, 'latin1').toString('hex').toUpperCase())}`,
    `o.payload_base64=${sql(row.payload_base64)}`, `o.configuration_hash=${sql(row.configuration_hash)}`,
    `o.configuration_json=${sql(row.configuration_json)}`, `o.normalized_json=${sql(row.normalized_json)}`,
    `d.id=${sql(row.device_data_id)}`, `upper(d.deveui)=upper(${sql(row.deveui)})`,
    `d.recorded_at=${sql(row.recorded_at)}`,
  ];
  for (const [key, expected] of Object.entries(candidate.result.channels || {})) {
    conditions.push(channelConditionSql(`d.${key}`, key, expected));
  }
  return `SELECT CASE WHEN EXISTS (SELECT 1 FROM tensiomark_observations o JOIN device_data d ON d.id=o.device_data_id WHERE ${conditions.join(' AND ')}) THEN 1 ELSE json_extract('not-json','$') END;`;
}

function linkedSql() {
  return "EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node='cloud' AND linked=1 AND trim(COALESCE(gateway_device_eui,'')) <> '')";
}

// Undelivered, unrejected DEVICE_DATA_APPENDED events for the candidates'
// canonical rows (aggregate_key = deveui|recorded_at, as the outbox trigger writes).
function pendingSql(candidates) {
  if (!candidates.length) return '0';
  const keys = candidates.map(({ row }) => `(SELECT deveui || '|' || recorded_at FROM device_data WHERE id=${sql(row.device_data_id)})`);
  return `EXISTS (SELECT 1 FROM sync_outbox so WHERE so.aggregate_type='DEVICE_DATA' AND so.op='DEVICE_DATA_APPENDED'
    AND so.delivered_at IS NULL AND so.rejected_at IS NULL AND so.aggregate_key IN (${keys.join(',')}))`;
}

function syncState(dbPath, candidates) {
  const row = sqliteJson(dbPath, `SELECT ${linkedSql()} AS linked, ${pendingSql(candidates)} AS pending;`)[0] || {};
  return { linked: Number(row.linked) === 1, pending: Number(row.pending) === 1 };
}

function applyRepairs(dbPath, candidates) {
  const statements = ['BEGIN IMMEDIATE;'];
  statements.push(`SELECT CASE WHEN ${linkedSql()} THEN 1 ELSE json_extract('not-json','$') END;`);
  statements.push(`SELECT CASE WHEN NOT ${pendingSql(candidates)} THEN 1 ELSE json_extract('not-json','$') END;`);
  for (const candidate of candidates) {
    const row = candidate.row;
    statements.push(precondition(candidate));
    const updates = Object.entries(candidate.result.channels || {}).filter(([key]) => key.startsWith('swt_'))
      .map(([key, value]) => `${key}=${sql(value)}`).join(',');
    statements.push(`UPDATE device_data SET ${updates} WHERE id=${sql(row.device_data_id)};`);
    statements.push("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('not-json','$') END;");
    statements.push(`UPDATE tensiomark_observations SET normalized_json=${sql(candidate.normalizedJson)} WHERE id=${sql(row.id)} AND normalized_json=${sql(row.normalized_json)};`);
    statements.push("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('not-json','$') END;");
  }
  statements.push('COMMIT;');
  sqliteWrite(dbPath, statements.join('\n'));
}

function backup(dbPath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  let backupPath = path.resolve(backupDir, `tensiomark-repair-${stamp}.db`);
  let suffix = 1;
  while (fs.existsSync(backupPath)) backupPath = path.resolve(backupDir, `tensiomark-repair-${stamp}-${suffix++}.db`);
  const dotPath = backupPath.replaceAll('"', '""');
  execFileSync(SQLITE, ['-bail', '-cmd', `.timeout 30000`, dbPath], { input: `.backup "${dotPath}"\n`, encoding: 'utf8' });
  integrity(backupPath);
  return backupPath;
}

function main(argv) {
  const options = parseArgs(argv);
  integrity(options.db);
  const triggerRows = sqliteJson(options.db, `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${TRIGGERS.map(sql).join(',')})`);
  const installed = new Set(triggerRows.map((row) => row.name));
  if (TRIGGERS.some((name) => !installed.has(name))) throw new Error('required_dirty_triggers_missing');
  const normalize = normalizer();
  const sourceRows = loadRows(options.db, options.deveui);
  const duplicate = duplicateKeys(sourceRows);
  const counts = {};
  const candidates = [];
  const pending = [];
  const tally = (result) => {
    counts[result.reason] = (counts[result.reason] || 0) + 1;
    if (result.reason === 'repairable') candidates.push(result);
  };
  for (const row of sourceRows) {
    const result = analyzeRow(row, duplicate, normalize);
    if (result.reason === 'needs_canonical') pending.push(result);
    else tally(result);
  }
  const states = classifyCanonical(options.db, pending);
  for (const item of pending) tally(finishRow(item, states.get(Number(item.row.id))));
  const sync = syncState(options.db, candidates);
  const summary = {
    deveui: options.deveui, scanned: sourceRows.length, repairable: candidates.length,
    applied: 0, reasons: counts, linked: sync.linked, pendingAppend: sync.pending, backupVerified: false,
  };
  if (options.apply && candidates.length) {
    if (!sync.linked) throw new Error('refusing: apply requires a cloud-linked gateway');
    if (sync.pending) throw new Error('refusing: an undelivered DEVICE_DATA_APPENDED event exists for a candidate row; wait for delivery');
    summary.backupPath = backup(options.db, options.backupDir);
    summary.backupVerified = true;
    applyRepairs(options.db, candidates);
    summary.applied = candidates.length;
  }
  process.stdout.write(JSON.stringify(summary) + '\n');
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(String(error && error.message || error) + '\n');
  process.exitCode = 2;
}
