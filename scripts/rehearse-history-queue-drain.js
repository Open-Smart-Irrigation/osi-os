#!/usr/bin/env node
'use strict';
// Rehearses the history correction queue drain on a COPY of a gateway database:
// runs the shipped Build / POST / Mark History Batch bodies of this checkout
// tick by tick (30 s, the inject interval) and the Build / POST / Mark History
// Manifest bodies every 10 ticks (300 s), against a fake cloud with the cloud's
// ordering, hash, row-index, quarantine and manifest-comparison rules.
// Nothing leaves the machine.
//
//   node scripts/rehearse-history-queue-drain.js --db <pulled farming.db> --work <scratch directory>
//       [--hours 24] [--start <ISO>] [--cloud-index <csv>] [--repair-from <db> --repair-after-min 60]
//
// The source file is never opened: it (and its -wal) is copied to <work>/farming.db
// first. --work must be an empty directory, a new path, or a directory an earlier
// run created (it holds the marker file); the working copy in it is replaced on
// every run. Paths under /data/db (a gateway's live database directory) are
// refused for all three arguments, after resolving symbolic links.
// The fake cloud's row index starts as "the cloud holds the edge's current row"
// for every row the tail can reach, except a pending 'correction' key (the cloud
// holds the old value) and rows of an unresolvable zone (quarantined). Segments
// listed in --cloud-index (CSV table_name,segment_key,history_key,payload_hash,...,
// an export of the cloud's edge_history_row_index) replace that assumption.
// --repair-from copies swt_1 of the rows that are pending 'correction' keys in that
// database onto the working copy after --repair-after-min simulated minutes, as a
// repair run on the gateway would (the dirty trigger queues the corrections).
// radio_uplinks is left out: its rows live in a separate radio database, and the
// nodes skip it unless OSI_RADIO_CAPTURE_ENABLED is set (not set here).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHarness } = require('./history-sync-flow-harness');

const LIVE_DB_DIR = '/data/db';
const WORK_MARKER = '.history-queue-rehearsal';
const TABLES = ['device_data', 'chameleon_readings', 'dendrometer_readings', 'dendrometer_daily',
  'zone_daily_environment', 'zone_daily_recommendations', 'irrigation_events', 'valve_actuation_expectations'];
// A table is drained when no key queued longer ago than this is still pending.
const DRAINED_AGE_MS = 15 * 60 * 1000;

function parseArgs(argv) {
  const options = { hours: 24, start: null, db: null, work: null, cloudIndex: null, repairFrom: null, repairAfterMin: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') options.db = argv[++i];
    else if (arg === '--work') options.work = argv[++i];
    else if (arg === '--hours') options.hours = Number(argv[++i]);
    else if (arg === '--start') options.start = argv[++i];
    else if (arg === '--cloud-index') options.cloudIndex = argv[++i];
    else if (arg === '--repair-from') options.repairFrom = argv[++i];
    else if (arg === '--repair-after-min') options.repairAfterMin = Number(argv[++i]);
    else throw new Error('unknown argument ' + arg);
  }
  if (!options.db || !options.work) throw new Error('usage: --db <copy> --work <scratch directory> [--hours N] [--start ISO] [--cloud-index csv] [--repair-from db --repair-after-min N]');
  if (!(options.hours > 0)) throw new Error('--hours must be positive');
  return options;
}

// The real path of p, also when p does not exist yet: the nearest existing
// parent is resolved, and a link whose target is missing is followed.
function realPath(p, depth = 0) {
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync(absolute);
  } catch (_) {
    if (depth > 40) throw new Error('too many symbolic links: ' + p);
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    const resolvedParent = realPath(parent, depth + 1);
    const candidate = path.join(resolvedParent, path.basename(absolute));
    let link = null;
    try { link = fs.readlinkSync(candidate); } catch (_) { /* not a link: a path that does not exist yet */ }
    return link === null ? candidate : realPath(path.resolve(resolvedParent, link), depth + 1);
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Checks --work, --db and --repair-from before anything is written and returns
// the working copy's path inside --work.
function prepareWork(options) {
  const work = realPath(options.work);
  const sources = [options.db, options.repairFrom].filter(Boolean).map(realPath);
  const liveDirs = [LIVE_DB_DIR, realPath(LIVE_DB_DIR)];
  for (const p of [work, ...sources]) {
    if (liveDirs.some((dir) => isInside(p, dir))) throw new Error('refusing a path under ' + LIVE_DB_DIR + ' (' + p + '); pull a copy first');
  }
  for (const source of sources) {
    if (isInside(source, work)) throw new Error('--work must not contain --db or --repair-from (' + source + ')');
  }
  if (fs.existsSync(work)) {
    if (!fs.statSync(work).isDirectory()) throw new Error('--work must be a scratch directory, not a file (' + work + ')');
    const entries = fs.readdirSync(work);
    if (entries.length && !entries.includes(WORK_MARKER)) {
      throw new Error('--work is not empty and was not created by this script (no ' + WORK_MARKER + ' in ' + work + ')');
    }
  } else {
    fs.mkdirSync(work, { recursive: true });
  }
  fs.writeFileSync(path.join(work, WORK_MARKER), 'Scratch directory of scripts/rehearse-history-queue-drain.js; its working copy is replaced on every run.\n');
  return path.join(work, 'farming.db');
}

function queue(db) {
  const out = {};
  for (const row of db.prepare("SELECT table_name, status, COUNT(*) AS n FROM sync_history_dirty_keys WHERE peer_node='cloud' GROUP BY 1, 2").all()) {
    (out[row.table_name] = out[row.table_name] || {})[row.status] = Number(row.n);
  }
  return out;
}

function seedCloud(h, db, gatewayEui, cloudIndexPath) {
  const helper = h.helper;
  const corrections = new Set(db.prepare("SELECT table_name || char(0) || row_key AS k FROM sync_history_dirty_keys WHERE status='pending' AND change_kind='correction'").all().map((r) => r.k));
  let seeded = 0;
  for (const table of TABLES) {
    const rows = db.prepare(helper.batchQuery(table, 'tail')).all(...helper.batchQueryParams(table, 'tail', null, null, 1e9));
    for (const row of rows) {
      const prepared = helper.prepareRow(table, gatewayEui, row);
      if (prepared.quarantineReason) continue;
      const indexKey = table + '\u0000' + prepared.historyKey;
      const segmentKey = helper.segmentKey(table, row);
      if (table.startsWith('zone_') && /^zone-id:/.test(String(row.zone_uuid || ''))) {
        h.cloud.quarantine.add(indexKey);
        h.cloud.segments.set(indexKey, segmentKey);
        continue;
      }
      h.cloud.seed(table, prepared.historyKey, segmentKey, corrections.has(indexKey) ? 'cloud-holds-old-value' : prepared.payloadHash);
      seeded += 1;
    }
  }
  let exported = 0;
  if (cloudIndexPath) {
    const lines = fs.readFileSync(cloudIndexPath, 'utf8').split('\n').filter((line) => line && !line.startsWith('table_name,'));
    const parsed = lines.map((line) => line.split(','));
    const listed = new Set(parsed.map(([table, segment]) => table + '\u0000' + segment));
    for (const [indexKey] of [...h.cloud.index]) {
      if (listed.has(indexKey.split('\u0000')[0] + '\u0000' + h.cloud.segments.get(indexKey))) h.cloud.index.delete(indexKey);
    }
    for (const [table, segment, historyKey, hash] of parsed) h.cloud.seed(table, historyKey, segment, hash);
    exported = parsed.length;
  }
  return { seeded, exported };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workDb = prepareWork(options);
  for (const suffix of ['', '-wal']) {
    const target = workDb + suffix;
    fs.rmSync(target, { force: true });
    if (fs.existsSync(options.db + suffix)) {
      fs.copyFileSync(options.db + suffix, target);
      fs.chmodSync(target, 0o600); // a pulled backup is often read-only
    }
  }
  fs.rmSync(workDb + '-shm', { force: true });
  const db = new DatabaseSync(workDb);
  // Scratch copy only: no fsync per statement (a .dump-restored copy is in rollback-journal mode).
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;');
  const link = db.prepare("SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud'").get() || {};
  const latest = db.prepare('SELECT MAX(changed_at) AS at FROM sync_history_dirty_keys').get().at;
  const start = options.start || new Date(Date.parse(latest || '2026-01-01T00:00:00Z') + 60000).toISOString();
  const h = createHarness({ db, start, env: { DEVICE_EUI: link.gateway_device_eui }, manifestEvery: 10 });
  const seed = seedCloud(h, db, link.gateway_device_eui, options.cloudIndex);

  let repairRows = null;
  if (options.repairFrom) {
    const repaired = new DatabaseSync(options.repairFrom, { readOnly: true });
    repairRows = repaired.prepare("SELECT d.id, d.swt_1 FROM sync_history_dirty_keys k JOIN device_data d ON d.id = CAST(substr(k.row_key, length(rtrim(k.row_key, '0123456789')) + 1) AS INTEGER) WHERE k.table_name='device_data' AND k.status='pending' AND k.change_kind='correction'").all();
    repaired.close();
  }
  const repairTick = Math.round(options.repairAfterMin * 2);
  let repairAt = null;
  let allCorrectionsOnCloudAt = null;
  const correctionsOnCloud = () => repairRows.filter((row) => {
    const prepared = h.helper.prepareRow('device_data', link.gateway_device_eui, db.prepare('SELECT * FROM device_data WHERE id=?').get(row.id));
    return h.cloud.index.get('device_data\u0000' + prepared.historyKey) === prepared.payloadHash;
  }).length;

  const before = queue(db);
  const timeline = [];
  const lastUndrained = {};
  const ticks = Math.round(options.hours * 120);
  for (let i = 0; i < ticks; i += 1) {
    if (repairRows && i === repairTick) {
      repairAt = new Date(h.now()).toISOString();
      const update = db.prepare('UPDATE device_data SET swt_1=? WHERE id=?');
      for (const row of repairRows) update.run(row.swt_1, row.id);
      // The dirty trigger dates the keys with the wall clock; move them to the simulated clock.
      db.prepare("UPDATE sync_history_dirty_keys SET changed_at=? WHERE changed_at > ?").run(repairAt, repairAt);
    }
    await h.tick();
    if (repairAt && !allCorrectionsOnCloudAt && i % 10 === 0 && correctionsOnCloud() === repairRows.length) {
      allCorrectionsOnCloudAt = new Date(h.now()).toISOString();
    }
    const cutoff = new Date(h.now() - DRAINED_AGE_MS).toISOString();
    for (const row of db.prepare("SELECT table_name FROM sync_history_dirty_keys WHERE status='pending' AND changed_at < ? GROUP BY 1").all(cutoff)) {
      lastUndrained[row.table_name] = h.now();
    }
    if (i % 120 === 119) {
      timeline.push({
        at: new Date(h.now()).toISOString(),
        pending: Object.fromEntries(db.prepare("SELECT table_name, COUNT(*) AS n FROM sync_history_dirty_keys WHERE status='pending' GROUP BY 1").all().map((r) => [r.table_name, Number(r.n)]))
      });
    }
  }
  const end = h.now();
  const cutoff = new Date(end - DRAINED_AGE_MS).toISOString();
  const lastManifest = h.cloud.manifests.at(-1) || [];
  const tables = {};
  for (const table of TABLES) {
    const pendingOld = db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE table_name=? AND status='pending' AND changed_at < ?").get(table, cutoff).n;
    const batches = h.cloud.batches.filter((b) => b.tableName === table);
    const drainedAtMs = lastUndrained[table] ? lastUndrained[table] + 30000 : Date.parse(start);
    tables[table] = {
      before: before[table] || {},
      after: queue(db)[table] || {},
      pendingOlderThan15MinAtEnd: Number(pendingOld),
      drained: Number(pendingOld) === 0,
      drainedAt: Number(pendingOld) === 0 ? new Date(drainedAtMs).toISOString() : null,
      minutesToDrain: Number(pendingOld) === 0 ? Math.round((drainedAtMs - Date.parse(start)) / 60000) : null,
      rowsSent: batches.reduce((s, b) => s + b.keys.length, 0),
      rowsByPhase: batches.reduce((o, b) => Object.assign(o, { [b.phase]: (o[b.phase] || 0) + b.keys.length }), {}),
      tailBatchesAfterDrain: batches.filter((b) => b.phase === 'tail' && b.at >= drainedAtMs).length,
      rejectedBatches: batches.filter((b) => b.rejected).length,
      segmentsStillRequestedByLastManifest: lastManifest.filter((s) => s.startsWith(table + '|')).map((s) => s.slice(table.length + 1))
    };
  }
  const corrections = repairRows ? {
    repairAt,
    rows: repairRows.length,
    onCloudAtEnd: correctionsOnCloud(),
    allOnCloudAt: allCorrectionsOnCloudAt,
    minutesAfterRepair: allCorrectionsOnCloudAt ? Math.round((Date.parse(allCorrectionsOnCloudAt) - Date.parse(repairAt)) / 60000) : null
  } : null;
  const report = {
    source: path.basename(options.db),
    start,
    simulatedHours: options.hours,
    cloudIndex: { seededFromEdge: seed.seeded, fromExport: seed.exported, exportFile: options.cloudIndex ? path.basename(options.cloudIndex) : null },
    tables,
    correctionsOnCloud: corrections,
    timeline,
    cursorsAfter: db.prepare("SELECT table_name, state, last_acked_id, last_acked_key, retry_count, next_attempt_at, last_error FROM sync_history_cursors WHERE peer_node='cloud'").all().map((c) => Object.assign({}, c)),
    droppedLogged: h.warnings.map((w) => /dropped (\d+) queued (\S+)/.exec(w)).filter(Boolean).reduce((o, m) => Object.assign(o, { [m[2]]: (o[m[2]] || 0) + Number(m[1]) }), {}),
    otherWarnings: [...new Set(h.warnings.filter((w) => !/dropped \d+ queued/.test(w)))].slice(0, 20)
  };
  db.close();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write('rehearse-history-queue-drain: ' + (error && error.stack || error) + '\n');
  process.exit(1);
});
