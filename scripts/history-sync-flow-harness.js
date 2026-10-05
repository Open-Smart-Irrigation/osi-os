'use strict';
// Runs the shipped history-sync function nodes (Build History Batch, POST History
// Batch, Mark History Batch ACK, and the 5-minute Build / POST / Mark History
// Manifest) against a real SQLite database and a fake cloud that applies the
// ordering, hash and row-index rules of the cloud's EdgeHistoryIngestService and
// the segment comparison of HistoryManifestIngestService (protocol 1, hash v1). Used by
// scripts/test-sync-history-queue-drain.js and scripts/rehearse-history-queue-drain.js.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const PROFILES = ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709'];

function loadProfile(profile) {
  const base = path.join(root, 'conf', profile, 'files/usr/share');
  const flows = JSON.parse(fs.readFileSync(path.join(base, 'flows.json'), 'utf8'));
  const helperPath = path.join(base, 'node-red/osi-history-sync-helper/index.js');
  delete require.cache[require.resolve(helperPath)];
  return { flows, helper: require(helperPath) };
}

// Java Long.parseLong of the text after the last '|', or null.
function cursorId(historyKey) {
  const text = String(historyKey);
  const pos = text.lastIndexOf('|');
  if (pos < 0) return null;
  const tail = text.slice(pos + 1);
  return /^[+-]?\d+$/.test(tail) ? BigInt(tail) : null;
}

// Port of EdgeHistoryIngestService.firstOutOfOrderNumericRow.
function firstOutOfOrderRow(rows) {
  let previous = null;
  let previousKey = null;
  for (const row of rows) {
    const current = cursorId(row.historyKey);
    const outOfOrder = current !== null && previous !== null
      ? current <= previous
      : previousKey !== null && row.historyKey <= previousKey;
    if (outOfOrder) return row;
    previous = current;
    previousKey = row.historyKey;
  }
  return null;
}

function createFakeCloud(helper, options = {}) {
  const index = new Map();
  const hashMismatch = options.hashMismatch || new Set();
  // A zone the cloud cannot resolve ('zone-id:N', the edge's placeholder for a
  // zone without uuid) ends in QUARANTINED, as resolveZone throws there.
  const quarantines = options.quarantineRow || ((tableName, payload) => /^zone-id:/.test(String(payload.zone_uuid || '')) && tableName.startsWith('zone_'));
  const segments = new Map(); // table\0historyKey -> segment key (row index and quarantine)
  const quarantine = new Set(); // table\0historyKey
  const batches = [];
  const manifests = [];
  function apply(request) {
    const record = { tableName: request.tableName, phase: request.phase, keys: request.rows.map((r) => r.historyKey), rejected: null, at: options.now ? options.now() : null };
    batches.push(record);
    const answer = (ackedThroughId, ackedThroughKey, results) => ({
      batchId: request.batchId,
      tableName: request.tableName,
      hashVersion: request.hashVersion,
      ackedThroughId: ackedThroughId === null ? null : Number(ackedThroughId),
      ackedThroughKey,
      maxBatchRows: 500,
      retryAfterMs: 30000,
      results,
      phase: request.phase,
      durableMirrorConfirmed: true
    });
    if (options.systemicReason && request.rows.length) {
      record.rejected = options.systemicReason;
      return answer(null, null, [{ historyKey: request.rows[0].historyKey, status: 'REJECTED_PERMANENT', reason: options.systemicReason }]);
    }
    const outOfOrder = firstOutOfOrderRow(request.rows);
    if (outOfOrder) {
      record.rejected = 'out_of_order_history_key';
      return answer(null, null, [{ historyKey: outOfOrder.historyKey, status: 'REJECTED_PERMANENT', reason: 'out_of_order_history_key' }]);
    }
    const results = [];
    let ackedThroughId = null;
    let ackedThroughKey = null;
    for (const row of request.rows) {
      const computed = helper.hashHistoryRow(request.tableName, row.historyKey, row.payload);
      if (computed !== row.payloadHash || hashMismatch.has(row.historyKey)) {
        record.rejected = 'hash_mismatch';
        results.push({ historyKey: row.historyKey, status: 'REJECTED_PERMANENT', reason: 'hash_mismatch' });
        break;
      }
      const indexKey = request.tableName + '\u0000' + row.historyKey;
      if (request.phase !== 'shadow' && quarantines(request.tableName, row.payload)) {
        quarantine.add(indexKey);
        segments.set(indexKey, helper.segmentKey(request.tableName, row.payload));
        results.push({ historyKey: row.historyKey, status: 'QUARANTINED', reason: 'zone not found' });
        const qid = cursorId(row.historyKey);
        if (qid !== null) ackedThroughId = qid;
        ackedThroughKey = row.historyKey;
        continue;
      }
      let status = 'APPLIED';
      if (request.phase === 'shadow') status = 'APPLIED';
      else if (index.get(indexKey) === row.payloadHash) status = 'DUPLICATE';
      else if (index.has(indexKey)) status = 'UPDATED';
      if (request.phase !== 'shadow') {
        index.set(indexKey, row.payloadHash);
        quarantine.delete(indexKey);
        segments.set(indexKey, helper.segmentKey(request.tableName, row.payload));
      }
      results.push({ historyKey: row.historyKey, status, reason: null });
      const id = cursorId(row.historyKey);
      if (id !== null) ackedThroughId = id;
      ackedThroughKey = row.historyKey;
    }
    return answer(ackedThroughId, ackedThroughKey, results);
  }
  // Port of HistoryManifestIngestService.applyManifest over the fake row index.
  function applyManifest(request) {
    const rowsBySegment = new Map();
    const quarantinedBySegment = new Map();
    for (const [indexKey, hash] of index) {
      const segmentId = indexKey.split('\u0000')[0] + '\u0000' + segments.get(indexKey);
      if (!rowsBySegment.has(segmentId)) rowsBySegment.set(segmentId, []);
      rowsBySegment.get(segmentId).push({ historyKey: indexKey.split('\u0000')[1], payloadHash: hash });
    }
    for (const indexKey of quarantine) {
      const segmentId = indexKey.split('\u0000')[0] + '\u0000' + segments.get(indexKey);
      quarantinedBySegment.set(segmentId, (quarantinedBySegment.get(segmentId) || 0) + 1);
    }
    const comparisons = (request.segments || []).map((segment) => {
      const segmentId = segment.tableName + '\u0000' + segment.segmentKey;
      const rows = (rowsBySegment.get(segmentId) || []).slice().sort((a, b) => (a.historyKey < b.historyKey ? -1 : a.historyKey > b.historyKey ? 1 : 0));
      const digest = crypto.createHash('sha256');
      for (const row of rows) {
        digest.update(row.historyKey, 'utf8');
        digest.update(Buffer.from([0]));
        digest.update(row.payloadHash, 'utf8');
        digest.update('\n', 'utf8');
      }
      const quarantined = quarantinedBySegment.get(segmentId) || 0;
      const mismatches = [];
      if (segment.canonicalRowCount !== rows.length + quarantined) mismatches.push('canonicalRowCount');
      if (segment.syncableRowCount !== rows.length) mismatches.push('syncableRowCount');
      if (segment.quarantinedCount !== quarantined) mismatches.push('quarantinedCount');
      if (segment.tombstoneCount !== 0) mismatches.push('tombstoneCount');
      if (digest.digest('hex') !== segment.syncablePayloadHash) mismatches.push('syncablePayloadHash');
      return { tableName: segment.tableName, segmentKey: segment.segmentKey, mismatchFields: mismatches, repairRequested: segment.tombstoneCount === 0 && mismatches.length > 0 };
    });
    manifests.push(comparisons.filter((c) => c.repairRequested).map((c) => c.tableName + '|' + c.segmentKey));
    return { segmentCount: comparisons.length, matched: comparisons.every((c) => !c.mismatchFields.length), segments: comparisons };
  }
  // Seeds the cloud's row index (e.g. from an export, or as "has the edge's current row").
  function seed(tableName, historyKey, segmentKey, payloadHash) {
    const indexKey = tableName + '\u0000' + historyKey;
    index.set(indexKey, payloadHash);
    segments.set(indexKey, segmentKey);
  }
  return { apply, applyManifest, seed, batches, manifests, index, segments, quarantine };
}

function createHarness(options) {
  const profile = options.profile || PROFILES[0];
  const { flows, helper } = loadProfile(profile);
  const db = options.db || new DatabaseSync(options.dbPath || ':memory:');
  let clock = Date.parse(options.start || '2026-10-05T12:00:00.000Z');
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock);
    }
    static now() { return clock; }
  }
  class Database {
    all(sql, params, cb) {
      let rows;
      try { rows = db.prepare(sql).all(...params); } catch (e) { cb(e); return; }
      // Test hook: a concurrent writer acting between a read and the next statement.
      if (options.afterAll) options.afterAll(sql, params, rows, db);
      cb(null, rows);
    }
    run(sql, params, cb) { try { db.prepare(sql).run(...params); cb(null); } catch (e) { cb(e); } }
    close(cb) { if (cb) cb(); }
  }
  const cloud = createFakeCloud(helper, Object.assign({ now: () => clock }, options.cloud || {}));
  const memory = new Map([['account_linked', true]]);
  if (options.lastTable) memory.set('history_sync_last_table', options.lastTable);
  const warnings = [];
  const env = { get: (name) => (options.env || {})[name] };
  const osiCloudHttp = {
    requestJsonIpv4: async (request) => {
      const body = JSON.parse(JSON.stringify(request.payload));
      const answer = /\/history\/manifests$/.test(request.url) ? cloud.applyManifest(body) : cloud.apply(body);
      return { statusCode: 200, headers: {}, payload: JSON.parse(JSON.stringify(answer)) };
    }
  };
  // options.radio: a node:sqlite database holding radio_uplinks, served as the
  // radio helper's shared store (the nodes read radio rows through it).
  const radioStore = options.radio ? {
    all: async (sql, params = []) => options.radio.prepare(sql).all(...params),
    bridgeDirty: async () => 0
  } : null;
  function libraryFor(name) {
    if (name === 'history-sync') return { ok: true, value: helper };
    if (name === 'radio' && radioStore) return { ok: true, value: { getSharedStore: () => radioStore } };
    return { ok: false, error: 'unknown ' + name };
  }
  function nodeFunc(id) {
    const node = flows.find((entry) => entry.id === id);
    if (!node) throw new Error('flow node missing: ' + id);
    return node.func;
  }
  async function invoke(id, msg) {
    const context = {
      msg,
      env,
      Date: FakeDate,
      osiDb: { Database },
      osiLib: { require: libraryFor },
      osiCloudHttp,
      flow: { get: (key) => memory.get(key), set: (key, value) => memory.set(key, value) },
      node: { warn: (text) => warnings.push(String(text)), error: (text) => warnings.push('ERROR ' + String(text)) }
    };
    return vm.runInNewContext('(async function(){' + nodeFunc(id) + '})', context)();
  }
  let ticks = 0;
  // The 300-s manifest inject: Build, POST and Mark History Manifest.
  async function manifest() {
    const built = await invoke('sync-history-manifest-build', {});
    if (!built) return false;
    const answered = await invoke('sync-history-manifest-http', built);
    if (answered) await invoke('sync-history-manifest-mark', answered);
    return true;
  }
  // One 30-s inject tick: every options.manifestEvery ticks the manifest runs
  // first; then build, and (if a batch was built) POST and mark.
  async function tick() {
    if (options.manifestEvery && ticks % options.manifestEvery === 0) await manifest();
    ticks += 1;
    const built = await invoke('sync-history-build', {});
    let marked = false;
    if (built) {
      const answered = await invoke('sync-history-http', built);
      if (answered) {
        await invoke('sync-history-mark', answered);
        marked = true;
      }
    }
    clock += options.tickMs || 30000;
    return { table: memory.get('history_sync_last_table'), built: !!built, marked };
  }
  return {
    db,
    helper,
    cloud,
    memory,
    warnings,
    invoke,
    tick,
    manifest,
    now: () => clock,
    advance: (ms) => { clock += ms; }
  };
}

module.exports = { PROFILES, createHarness, createFakeCloud, firstOutOfOrderRow, cursorId, loadProfile };
