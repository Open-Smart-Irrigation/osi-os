#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canonicalPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const mirrorPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));

function requiredNode(id) {
  const value = flows.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`${id} not found`);
  return value;
}

const build = requiredNode('sync-history-build');
build.func = String.raw`return (async()=>{
const helperLoad = osiLib.require('history-sync');
function setSyncState(patch) {
  const current = flow.get('sync_state') || {};
  flow.set('sync_state', Object.assign({}, current, patch));
}
if (!helperLoad.ok) {
  setSyncState({ lastHistorySyncError: { at: new Date().toISOString(), source: 'history-build', message: 'helper unavailable: ' + helperLoad.error }, updatedAt: new Date().toISOString() });
  node.error('Build History Batch helper unavailable: ' + helperLoad.error, msg);
  return null;
}
const helper = helperLoad.value;
const batchSize = 250;
const dirtyBatchSize = 50;
const tables = helper.tableNames();
const previousTable = flow.get('history_sync_last_table');
const tableName = helper.nextTable(previousTable, tables);
flow.set('history_sync_last_table', tableName);
const _db = new osiDb.Database('/data/db/farming.db');
const q = (sql, params = []) => new Promise((res,rej) => _db.all(sql, params, (e,r) => e?rej(e):res(r||[])));
const run = (sql, params = []) => new Promise((res,rej) => _db.run(sql, params, (e) => e?rej(e):res()));
const close = () => new Promise(res => _db.close(() => res()));
function normalizeCloudServerUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}
function normalizeGatewayDeviceEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!raw) return '';
  if (raw.length === 16) return raw === '0101010101010101' ? '' : raw;
  if (raw.length === 12) return raw.slice(0, 6) + 'FFFE' + raw.slice(6);
  return '';
}
function phaseForDirty(table, changeKind) {
  if (changeKind === 'repair') return 'repair';
  return ['device_data', 'chameleon_readings', 'dendrometer_readings', 'irrigation_events'].includes(table)
    ? 'correction'
    : 'derived';
}
function makeBatch(rows, phase, cursor, target, dirtyKeys) {
  const batchId = Date.now().toString(36) + '-' + tableName;
  const prepared = rows.map((row) => helper.prepareRow(tableName, target.gatewayEui, row));
  const segmentKeys = [];
  for (const row of rows) {
    try {
      const key = helper.segmentKey(tableName, row);
      if (!segmentKeys.includes(key)) segmentKeys.push(key);
    } catch (error) {
      node.warn('Build History Batch segment key failed: ' + (error && error.message ? error.message : error));
    }
  }
  msg.historyTable = tableName;
  msg.historyPhase = phase;
  msg.method = 'POST';
  msg.url = target.serverUrl + '/api/v1/sync/edge/history/batches';
  msg.headers = { 'Content-Type': 'application/json', 'X-OSI-History-Protocol': '1', Authorization: 'Bearer ' + target.syncToken };
  msg._historyBatch = {
    tableName,
    batchId,
    phase,
    rowCount: prepared.length,
    dirtyKeys: dirtyKeys || [],
    segmentKeys,
    snapshotHighId: cursor.snapshot_high_id,
    snapshotHighKey: cursor.snapshot_high_key,
    shadowCompleteCandidate: false
  };
  msg.payload = {
    protocolVersion: 1,
    gatewayDeviceEui: target.gatewayEui,
    batchId,
    tableName,
    phase: phase,
    hashVersion: 1,
    cursor: {
      state: cursor.state,
      snapshot_high_id: cursor.snapshot_high_id,
      snapshot_high_key: cursor.snapshot_high_key,
      last_acked_id: phase === 'shadow' ? cursor.last_shadow_acked_id : cursor.last_acked_id,
      last_acked_key: phase === 'shadow' ? cursor.last_shadow_acked_key : cursor.last_acked_key,
      batchSize
    },
    rows: prepared.map((row) => ({
      historyKey: row.historyKey,
      naturalKey: row.naturalKey,
      payloadHash: row.payloadHash,
      payload: row.payload
    }))
  };
  return msg;
}
try {
  const linkRows = await q("SELECT linked, server_url, gateway_device_eui FROM sync_link_state WHERE peer_node='cloud' LIMIT 1");
  const linkState = linkRows[0] || {};
  const targetRows = await q("SELECT server_url, server_sync_token FROM users WHERE server_url IS NOT NULL AND server_url <> '' ORDER BY server_linked_at DESC, id DESC LIMIT 1");
  const targetRow = targetRows[0] || {};
  const target = {
    serverUrl: normalizeCloudServerUrl(linkState.server_url || targetRow.server_url),
    syncToken: String(targetRow.server_sync_token || env.get('CLOUD_SYNC_TOKEN') || env.get('SYNC_TOKEN') || '').trim(),
    gatewayEui: normalizeGatewayDeviceEui(linkState.gateway_device_eui || env.get('DEVICE_EUI'))
  };
  const linked = !!flow.get('account_linked') || Number(linkState.linked || 0) === 1;
  if (!linked || !target.gatewayEui || !target.serverUrl) {
    await close();
    return null;
  }
  if (!target.syncToken) {
    setSyncState({ lastHistorySyncError: { at: new Date().toISOString(), source: 'history-build', message: 'missing sync token' }, updatedAt: new Date().toISOString() });
    await close();
    return null;
  }
  for (const table of tables) {
    await run("INSERT INTO sync_history_cursors(peer_node, table_name, state) VALUES('cloud', ?, 'shadow') ON CONFLICT(peer_node, table_name) DO NOTHING", [table]);
  }
  let cursor = (await q("SELECT * FROM sync_history_cursors WHERE peer_node='cloud' AND table_name=? LIMIT 1", [tableName]))[0] || {};
  const now = new Date().toISOString();
  if (cursor.next_attempt_at && Date.parse(cursor.next_attempt_at) > Date.now()) {
    setSyncState({ lastHistoryBackoffUntil: cursor.next_attempt_at, lastHistoryTable: tableName, updatedAt: now });
    await close();
    return null;
  }
  let state = cursor.shadow_completed_at ? String(cursor.state || 'backfill') : 'shadow';
  if (state !== cursor.state) {
    await run("UPDATE sync_history_cursors SET state=? WHERE peer_node='cloud' AND table_name=?", [state, tableName]);
    cursor = Object.assign({}, cursor, { state });
  }
  const kind = helper.cursorKind(tableName);
  if ((kind === 'id' && cursor.snapshot_high_id == null) || (kind === 'key' && cursor.snapshot_high_key == null)) {
    const high = (await q(helper.snapshotHighQuery(tableName)))[0] || {};
    if (kind === 'id') {
      await run("UPDATE sync_history_cursors SET snapshot_high_id=?, backfill_started_at=COALESCE(backfill_started_at, ?), last_error=NULL WHERE peer_node='cloud' AND table_name=?", [String(high.snapshot_high_id || 0), now, tableName]);
      cursor = Object.assign({}, cursor, { snapshot_high_id: String(high.snapshot_high_id || 0), backfill_started_at: cursor.backfill_started_at || now });
    } else {
      await run("UPDATE sync_history_cursors SET snapshot_high_key=?, backfill_started_at=COALESCE(backfill_started_at, ?), last_error=NULL WHERE peer_node='cloud' AND table_name=?", [String(high.snapshot_high_key || ''), now, tableName]);
      cursor = Object.assign({}, cursor, { snapshot_high_key: String(high.snapshot_high_key || ''), backfill_started_at: cursor.backfill_started_at || now });
    }
  }
  if (state === 'tail') {
    const dirty = await q(
      "SELECT * FROM sync_history_dirty_keys WHERE peer_node='cloud' AND table_name=? AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY changed_at, row_key LIMIT ?",
      [tableName, now, dirtyBatchSize]
    );
    if (dirty.length) {
      const changeKind = String(dirty[0].change_kind || 'correction');
      const selected = dirty.filter((entry) => String(entry.change_kind || 'correction') === changeKind);
      const rows = [];
      const dirtyKeys = [];
      for (const entry of selected) {
        const lookup = helper.rowByHistoryKeyQuery(tableName, entry.row_key);
        const found = await q(lookup.sql, lookup.params);
        if (!found.length) {
          await run(
            "UPDATE sync_history_dirty_keys SET attempts=attempts+1, last_error='source row missing', next_attempt_at=? WHERE peer_node='cloud' AND table_name=? AND row_key=?",
            [new Date(Date.now() + 300000).toISOString(), tableName, entry.row_key]
          );
          continue;
        }
        rows.push(found[0]);
        dirtyKeys.push(entry.row_key);
      }
      if (rows.length) {
        const result = makeBatch(rows, phaseForDirty(tableName, changeKind), cursor, target, dirtyKeys);
        await close();
        return result;
      }
    }
  }
  if (state === 'backfill' && helper.isCursorComplete(tableName, cursor, false)) {
    await run("UPDATE sync_history_cursors SET state='tail', backfill_completed_at=COALESCE(backfill_completed_at, ?), next_attempt_at=NULL WHERE peer_node='cloud' AND table_name=?", [now, tableName]);
    setSyncState({ lastHistoryBackfillCompletedAt: now, lastHistoryTable: tableName, updatedAt: now });
    await close();
    return null;
  }
  const shadow = state === 'shadow';
  const after = kind === 'id'
    ? (shadow ? cursor.last_shadow_acked_id : cursor.last_acked_id)
    : (shadow ? cursor.last_shadow_acked_key : cursor.last_acked_key);
  const snapshotHigh = kind === 'id' ? cursor.snapshot_high_id : cursor.snapshot_high_key;
  const phase = shadow ? 'shadow' : (state === 'backfill' ? 'backfill' : 'tail');
  const rows = await q(
    helper.batchQuery(tableName, phase),
    helper.batchQueryParams(tableName, phase, after, snapshotHigh, batchSize)
  );
  if (!rows.length) {
    if (shadow && !cursor.shadow_completed_at) {
      const empty = makeBatch([], 'shadow', cursor, target, []);
      empty._historyBatch.shadowCompleteCandidate = helper.isCursorComplete(tableName, cursor, true);
      await close();
      return empty;
    }
    setSyncState({ lastHistoryIdleAt: now, lastHistoryTable: tableName, updatedAt: now });
    await close();
    return null;
  }
  const result = makeBatch(rows, phase, cursor, target, []);
  await close();
  return result;
} catch (error) {
  try {
    await close();
  } catch (closeError) {
    node.warn('Build History Batch close failed: ' + (closeError && closeError.message ? closeError.message : closeError));
  }
  setSyncState({ lastHistorySyncError: { at: new Date().toISOString(), source: 'history-build', message: String(error && error.message || error) } });
  node.warn('History batch build failed: ' + (error && error.message ? error.message : error));
  return null;
}
})();`;

const mark = requiredNode('sync-history-mark');
mark.func = String.raw`return (async()=>{
const helperLoad = osiLib.require('history-sync');
function setSyncState(patch) {
  const current = flow.get('sync_state') || {};
  flow.set('sync_state', Object.assign({}, current, patch));
}
if (!helperLoad.ok) {
  setSyncState({ lastHistorySyncError: { at: new Date().toISOString(), source: 'history-mark', message: 'helper unavailable: ' + helperLoad.error }, updatedAt: new Date().toISOString() });
  node.error('Mark History Batch ACK helper unavailable: ' + helperLoad.error, msg);
  return null;
}
const helper = helperLoad.value;
const _db = new osiDb.Database('/data/db/farming.db');
const q = (sql, params = []) => new Promise((res,rej) => _db.all(sql, params, (e,r) => e?rej(e):res(r||[])));
const run = (sql, params = []) => new Promise((res,rej) => _db.run(sql, params, (e) => e?rej(e):res()));
const close = () => new Promise(res => _db.close(() => res()));
const now = new Date().toISOString();
const batch = msg._historyBatch || {};
const tableName = batch.tableName || msg.historyTable || 'device_data';
const response = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
async function retry(message) {
  const rows = await q("SELECT retry_count FROM sync_history_cursors WHERE peer_node='cloud' AND table_name=? LIMIT 1", [tableName]);
  const retryCount = Number((rows[0] || {}).retry_count || 0) + 1;
  const delayMs = Math.min(300000, 1000 * Math.pow(2, Math.min(retryCount, 8)));
  const nextAttempt = new Date(Date.now() + delayMs).toISOString();
  await run(
    "UPDATE sync_history_cursors SET retry_count=?, next_attempt_at=?, last_error=?, last_batch_id=?, last_batch_at=? WHERE peer_node='cloud' AND table_name=?",
    [retryCount, nextAttempt, message, batch.batchId || null, now, tableName]
  );
  setSyncState({ lastHistorySyncError: { at: now, source: 'history-batch', message, statusCode: Number(msg.statusCode || 0) }, lastHistoryBackoffUntil: nextAttempt });
}
async function recomputeSegments(segmentKeys) {
  for (const key of segmentKeys || []) {
    const lookup = helper.segmentQuery(tableName, key);
    const rows = await q(lookup.sql, lookup.params);
    const built = helper.buildSegment(tableName, String(response.gatewayDeviceEui || flow.get('gateway_device_eui') || env.get('DEVICE_EUI') || '').toUpperCase(), key, rows);
    for (const quarantined of built.quarantine) {
      await run(
        "INSERT INTO sync_history_quarantine(peer_node, table_name, history_key, payload_hash, reason, first_seen_at, last_seen_at, attempts) VALUES('cloud', ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(peer_node, table_name, history_key) DO UPDATE SET payload_hash=excluded.payload_hash, reason=excluded.reason, last_seen_at=excluded.last_seen_at, attempts=sync_history_quarantine.attempts+1",
        [tableName, quarantined.historyKey, quarantined.payloadHash, quarantined.quarantineReason, now, now]
      );
    }
    const manifest = built.manifest;
    await run(
      "INSERT INTO sync_history_segments(peer_node, table_name, segment_key, hash_version, canonical_row_count, syncable_row_count, syncable_payload_hash, quarantined_count, tombstone_count, covered_max_id, computed_at) VALUES('cloud', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(peer_node, table_name, segment_key, hash_version) DO UPDATE SET canonical_row_count=excluded.canonical_row_count, syncable_row_count=excluded.syncable_row_count, syncable_payload_hash=excluded.syncable_payload_hash, quarantined_count=excluded.quarantined_count, tombstone_count=excluded.tombstone_count, covered_max_id=excluded.covered_max_id, computed_at=excluded.computed_at",
      [tableName, key, manifest.hashVersion, manifest.canonicalRowCount, manifest.syncableRowCount, manifest.syncablePayloadHash, manifest.quarantinedCount, manifest.tombstoneCount, batch.snapshotHighId || null, now]
    );
  }
}
try {
  if (!msg.statusCode || msg.statusCode < 200 || msg.statusCode >= 300) {
    await retry(msg.error && msg.error.message ? msg.error.message : 'History batch delivery failed');
    await close();
    return null;
  }
  const phaseMatches = String(response.phase || '').toLowerCase() === String(batch.phase || '').toLowerCase();
  const serverConfirmed = phaseMatches && helper.serverConfirmsDurable(response);
  if (serverConfirmed) flow.set('history_mirror_write_v1_confirmed', true);
  const patch = helper.cursorPatchFromResponse(response);
  const cursor = (await q("SELECT * FROM sync_history_cursors WHERE peer_node='cloud' AND table_name=? LIMIT 1", [tableName]))[0] || {};
  if (batch.phase === 'shadow') {
    if (patch.last_acked_id != null || patch.last_acked_key != null) {
      await run(
        "UPDATE sync_history_cursors SET last_shadow_acked_id=COALESCE(?, last_shadow_acked_id), last_shadow_acked_key=COALESCE(?, last_shadow_acked_key), last_shadow_error=?, last_batch_id=?, last_batch_at=?, retry_count=0, next_attempt_at=? WHERE peer_node='cloud' AND table_name=?",
        [patch.last_acked_id || null, patch.last_acked_key || null, patch.last_error || null, batch.batchId || response.batchId || null, now, patch.next_attempt_at || null, tableName]
      );
    } else if (!batch.shadowCompleteCandidate) {
      await retry(patch.last_error || 'missing shadow ACK boundary');
      await close();
      return null;
    }
    const effective = Object.assign({}, cursor, {
      last_shadow_acked_id: patch.last_acked_id != null ? patch.last_acked_id : cursor.last_shadow_acked_id,
      last_shadow_acked_key: patch.last_acked_key != null ? patch.last_acked_key : cursor.last_shadow_acked_key
    });
    const complete = !!batch.shadowCompleteCandidate || helper.isCursorComplete(tableName, effective, true);
    if (serverConfirmed && complete && !patch.next_attempt_at) {
      await run(
        "UPDATE sync_history_cursors SET state='backfill', shadow_completed_at=COALESCE(shadow_completed_at, ?), durable_enabled_at=COALESCE(durable_enabled_at, ?), last_shadow_error=NULL, next_attempt_at=NULL WHERE peer_node='cloud' AND table_name=?",
        [now, now, tableName]
      );
    }
    setSyncState({ lastHistoryShadowSyncAt: now, lastHistoryShadowTable: tableName, lastHistoryShadowBatchId: batch.batchId || response.batchId || null, lastHistoryShadowRowCount: Number(batch.rowCount || 0), lastHistoryServerDurableConfirmed: serverConfirmed, lastHistorySyncError: patch.last_error ? { at: now, source: 'history-shadow-ack', message: patch.last_error } : null, updatedAt: now });
    await close();
    return null;
  }
  if (!helper.shouldApplyDurableAck(batch, response)) {
    await retry('durable mirror confirmation missing or phase mismatch');
    await close();
    return null;
  }
  if (patch.last_acked_id != null || patch.last_acked_key != null) {
    await run(
      "UPDATE sync_history_cursors SET last_acked_id=COALESCE(?, last_acked_id), last_acked_key=COALESCE(?, last_acked_key), last_batch_id=?, last_batch_at=?, last_error=?, retry_count=?, next_attempt_at=? WHERE peer_node='cloud' AND table_name=?",
      [patch.last_acked_id || null, patch.last_acked_key || null, batch.batchId || response.batchId || null, now, patch.last_error || null, Number(patch.retry_count || 0), patch.next_attempt_at || null, tableName]
    );
  } else {
    await retry(patch.last_error || 'missing ACK boundary');
    await close();
    return null;
  }
  const accepted = new Set((response.results || [])
    .filter((result) => ['APPLIED', 'UPDATED', 'DUPLICATE', 'QUARANTINED'].includes(result && result.status))
    .map((result) => String(result.historyKey || '')));
  for (const dirtyKey of batch.dirtyKeys || []) {
    if (accepted.has(String(dirtyKey))) {
      await run(
        "UPDATE sync_history_dirty_keys SET status='done', last_error=NULL, next_attempt_at=NULL WHERE peer_node='cloud' AND table_name=? AND row_key=?",
        [tableName, dirtyKey]
      );
    }
  }
  await recomputeSegments(batch.segmentKeys || []);
  const effective = Object.assign({}, cursor, {
    last_acked_id: patch.last_acked_id != null ? patch.last_acked_id : cursor.last_acked_id,
    last_acked_key: patch.last_acked_key != null ? patch.last_acked_key : cursor.last_acked_key
  });
  if (batch.phase === 'backfill' && helper.isCursorComplete(tableName, effective, false) && !patch.next_attempt_at) {
    await run(
      "UPDATE sync_history_cursors SET state='tail', backfill_completed_at=COALESCE(backfill_completed_at, ?), next_attempt_at=NULL WHERE peer_node='cloud' AND table_name=?",
      [now, tableName]
    );
  }
  setSyncState({ lastHistoryDurableAckAt: now, lastHistoryTable: tableName, lastHistoryAckedThroughId: response.ackedThroughId || null, lastHistoryAckedThroughKey: response.ackedThroughKey || null, lastHistorySyncError: patch.last_error ? { at: now, source: 'history-ack', message: patch.last_error } : null, updatedAt: now });
  flow.set('history_sync_v1_confirmed', true);
  await close();
  return null;
} catch (error) {
  try {
    await close();
  } catch (closeError) {
    node.warn('Mark History Batch ACK close failed: ' + (closeError && closeError.message ? closeError.message : closeError));
  }
  setSyncState({ lastHistorySyncError: { at: now, source: 'history-mark', message: String(error && error.message || error) } });
  node.warn('History batch mark failed: ' + (error && error.message ? error.message : error));
  return null;
}
})();`;

const manifestBuild = requiredNode('sync-history-manifest-build');
manifestBuild.func = manifestBuild.func
  .replace(
    "'       syncable_row_count, quarantined_count, syncable_payload_hash',",
    "'       syncable_row_count, quarantined_count, tombstone_count, syncable_payload_hash',"
  )
  .replace(
    'quarantinedCount: Number(row.quarantined_count),\n      syncablePayloadHash:',
    'quarantinedCount: Number(row.quarantined_count),\n      tombstoneCount: Number(row.tombstone_count || 0),\n      syncablePayloadHash:'
  );
if (!manifestBuild.func.includes('tombstoneCount')) {
  throw new Error('manifest tombstone anchors not found');
}

const manifestMark = requiredNode('sync-history-manifest-mark');
manifestMark.libs = [
  { var: 'osiDb', module: 'osi-db-helper' },
  { var: 'osiLib', module: 'osi-lib' }
];
manifestMark.func = String.raw`return (async()=>{
function setSyncState(patch) {
  const current = flow.get('sync_state') || {};
  flow.set('sync_state', Object.assign({}, current, patch));
}
const helperLoad = osiLib.require('history-sync');
if (!helperLoad.ok) {
  node.error('Mark History Manifest ACK helper unavailable: ' + helperLoad.error, msg);
  return null;
}
const helper = helperLoad.value;
const _db = new osiDb.Database('/data/db/farming.db');
const q = (sql, params = []) => new Promise((res,rej) => _db.all(sql, params, (e,r) => e?rej(e):res(r||[])));
const run = (sql, params = []) => new Promise((res,rej) => _db.run(sql, params, (e) => e?rej(e):res()));
const close = () => new Promise(res => _db.close(() => res()));
const now = new Date().toISOString();
try {
  if (!msg.statusCode || msg.statusCode < 200 || msg.statusCode >= 300) {
    setSyncState({ lastHistoryManifestError: { at: now, statusCode: Number(msg.statusCode || 0), message: msg.error && msg.error.message ? msg.error.message : 'History manifest delivery failed' } });
    await close();
    return null;
  }
  const comparisons = Array.isArray(msg.payload && msg.payload.segments) ? msg.payload.segments : [];
  let repairCount = 0;
  for (const comparison of comparisons) {
    if (!comparison || comparison.repairRequested !== true) continue;
    const lookup = helper.segmentQuery(comparison.tableName, comparison.segmentKey);
    const rows = await q(lookup.sql, lookup.params);
    const gatewayEui = String(flow.get('gateway_device_eui') || env.get('DEVICE_EUI') || '').trim().toUpperCase();
    for (const row of rows) {
      const prepared = helper.prepareRow(comparison.tableName, gatewayEui, row);
      await run(
        "INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, source_row_id, changed_at, status, attempts, next_attempt_at, last_error) VALUES('cloud', ?, ?, 'repair', ?, ?, 'pending', 0, NULL, NULL) ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET change_kind='repair', source_row_id=excluded.source_row_id, changed_at=excluded.changed_at, status='pending', attempts=0, next_attempt_at=NULL, last_error=NULL",
        [comparison.tableName, prepared.historyKey, row.id == null ? null : row.id, now]
      );
      repairCount += 1;
    }
  }
  setSyncState({ lastHistoryManifestAt: now, lastHistoryManifestSegmentCount: Number(msg.historyManifestSegmentCount || 0), lastHistoryManifestMatched: msg.payload && msg.payload.matched === true, lastHistoryManifestRepairCount: repairCount, lastHistoryManifestError: null, updatedAt: now });
  await close();
  return null;
} catch (error) {
  try {
    await close();
  } catch (closeError) {
    node.warn('Mark History Manifest ACK close failed: ' + (closeError && closeError.message ? closeError.message : closeError));
  }
  setSyncState({ lastHistoryManifestError: { at: now, message: String(error && error.message || error) }, updatedAt: now });
  node.warn('History manifest mark failed: ' + (error && error.message ? error.message : error));
  return null;
}
})();`;

const inject = requiredNode('sync-history-inject');
inject.name = 'Sync History Durable Batch';
inject.repeat = '30';

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
