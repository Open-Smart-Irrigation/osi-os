#!/usr/bin/env node
'use strict';
// scripts/dev/edit-sync-delivery-consumers.js
//
// Guarded parse-mutate-serialize editor for Task 2 of
// docs/superpowers/plans/2026-07-15-sync-delivery-stop-loss.md.
//
// Replaces the `func` text of the two "delivery" flow nodes with the
// fail-closed rewrite:
//   - sync-outbox-mark   ("Mark Synced Events Delivered")
//   - sync-bootstrap-mark ("Mark Bootstrap Synced")
// in the canonical bcm2712 flows.json, then mirrors the result byte-for-byte
// onto the bcm2709 profile. Per the osi-flows-json-editing skill's iron rule,
// flows.json is never hand-edited: this script is the sole write path.
//
// Idempotent: rerunning after the fix is already applied performs no
// mutation (func already matches the target text) and the roundtrip guard
// still passes on both profiles - a byte-identical round trip when no
// mutation is applied.
//
// Usage: node scripts/dev/edit-sync-delivery-consumers.js

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function assertRoundtripByteIdentical(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  const reserialized = serialize(parsed);
  if (Buffer.compare(original, reserialized) !== 0) {
    throw new Error(
      'Roundtrip guard failed for ' + filePath + ': file formatting has drifted from '
      + "JSON.stringify(x, null, 2) + '\\n'. STOP and investigate before mutating.",
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Target func bodies (Task 2: isHttpSuccess integer-200-299 predicate; no
// whole-batch deliveredIds fallback; unique-result-per-eventUuid
// classification with duplicate/malformed/unrequested handling; bootstrap
// requires isHttpSuccess AND payload.success === true before any durable
// write). Neither node is on the live-gateway-identity restart-sentinel
// preflight list (that list is the *-build producer nodes; these are the
// *-mark response consumers), so there is no sentinel reader to preserve
// here - see the plan's Global constraints and AGENTS.md PR #146 note.
// ---------------------------------------------------------------------------

const SYNC_OUTBOX_MARK_FUNC = `return (async()=>{
function setSyncState(patch) {
  const current = flow.get('sync_state') || {};
  flow.set('sync_state', Object.assign({}, current, patch));
}
function isHttpSuccess(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300;
}
function boundedIssueSummary(issues) {
  if (!issues.length) return null;
  const shown = issues.slice(0, 5).join('; ');
  const suffix = issues.length > 5 ? ('; +' + (issues.length - 5) + ' more') : '';
  return (shown + suffix).slice(0, 500);
}
if (!isHttpSuccess(msg.statusCode)) {
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'outbox',
      message: 'Outbox delivery failed',
      statusCode: Number.isInteger(msg.statusCode) ? msg.statusCode : null
    }
  });
  return null;
}
if (!Array.isArray(msg._syncEventIds) || !msg._syncEventIds.length) return null;
const requestedIds = msg._syncEventIds.map((id) => String(id));
const requestedSet = new Set(requestedIds);
const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
const eventResults = Array.isArray(payload.results) ? payload.results : (Array.isArray(payload.eventResults) ? payload.eventResults : null);
const terminalStatuses = new Set(['APPLIED', 'DUPLICATE']);
const deliveredIds = [];
const rejectedEvents = [];
const rejectedIds = [];
const retryableIds = [];
const issues = [];
if (!Array.isArray(eventResults)) {
  for (const id of requestedIds) retryableIds.push(id);
  issues.push('protocol_response_missing_results');
} else {
  const grouped = new Map();
  const unrequestedIds = new Set();
  for (const raw of eventResults) {
    const result = raw && typeof raw === 'object' ? raw : {};
    const eventUuid = String(result.eventUuid || result.event_uuid || '').trim();
    if (!eventUuid) continue;
    if (!requestedSet.has(eventUuid)) { unrequestedIds.add(eventUuid); continue; }
    if (!grouped.has(eventUuid)) grouped.set(eventUuid, []);
    grouped.get(eventUuid).push(result);
  }
  for (const id of unrequestedIds) issues.push('protocol_response_unrequested_result:' + id);
  for (const id of requestedIds) {
    const matches = grouped.get(id) || [];
    if (!matches.length) {
      retryableIds.push(id);
      issues.push('protocol_response_missing_result:' + id);
      continue;
    }
    if (matches.length > 1) {
      retryableIds.push(id);
      issues.push('protocol_response_duplicate_result:' + id);
      continue;
    }
    const result = matches[0];
    const status = String(result.status || '').trim().toUpperCase();
    if (!status) {
      retryableIds.push(id);
      issues.push('protocol_response_malformed_result:' + id);
    } else if (terminalStatuses.has(status)) {
      deliveredIds.push(id);
    } else if (status === 'REJECTED') {
      const reason = String(result.reason || result.error || result.message || 'rejected').trim() || 'rejected';
      rejectedEvents.push({ eventUuid: id, reason });
      rejectedIds.push(id);
    } else if (status === 'RETRYABLE_ERROR' || result.retryable === true) {
      retryableIds.push(id);
    } else {
      retryableIds.push(id);
      issues.push('protocol_response_malformed_result:' + id);
    }
  }
}
const classified = new Set();
for (const group of [deliveredIds, rejectedIds, retryableIds]) {
  for (const id of group) {
    if (classified.has(id)) {
      throw new Error('sync-outbox-mark: event ' + id + ' classified into more than one disposition group');
    }
    classified.add(id);
  }
}
if (!deliveredIds.length && !rejectedIds.length && !retryableIds.length) return null;
const _db = new osiDb.Database('/data/db/farming.db');
const run = (sql) => new Promise((res,rej) => _db.run(sql, e => e?rej(e):res()));
const close = () => new Promise(res => _db.close(() => res()));
const escapeSql = (value) => String(value == null ? '' : value).replace(/'/g, "''");
try {
  const now = new Date().toISOString();
  if (deliveredIds.length) {
    const ids = deliveredIds.map(v => "'" + escapeSql(v) + "'").join(',');
    await run("UPDATE sync_outbox SET delivered_at = '" + escapeSql(now) + "' WHERE event_uuid IN (" + ids + ")");
  }
  for (const rejected of rejectedEvents) {
    await run("UPDATE sync_outbox SET rejected_at = '" + escapeSql(now) + "', rejection_reason = '" + escapeSql(rejected.reason) + "' WHERE event_uuid = '" + escapeSql(rejected.eventUuid) + "'");
  }
  if (retryableIds.length) {
    const ids = retryableIds.map(v => "'" + escapeSql(v) + "'").join(',');
    await run("UPDATE sync_outbox SET retry_count = retry_count + 1, last_retryable_failure_at = '" + escapeSql(now) + "' WHERE event_uuid IN (" + ids + ")");
  }
  const currentState = flow.get('sync_state') || {};
  const patch = {
    lastOutboxBatchCount: deliveredIds.length + rejectedIds.length,
    lastOutboxRetryableCount: retryableIds.length,
    lastOutboxRejectedCount: rejectedIds.length,
    updatedAt: now
  };
  if (deliveredIds.length + rejectedIds.length > 0) {
    patch.lastOutboxDeliverySuccessAt = now;
  }
  if (!issues.length) {
    if (currentState.lastError && currentState.lastError.source === 'outbox') patch.lastError = null;
  } else {
    patch.lastError = {
      at: now,
      source: 'outbox',
      message: boundedIssueSummary(issues) || 'protocol_response_missing_results',
      statusCode: Number.isInteger(msg.statusCode) ? msg.statusCode : null
    };
  }
  setSyncState(patch);
  await close();
  return null;
} catch (e) {
  try { await close(); } catch(_) {}
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'outbox',
      message: String(e.message || e),
      statusCode: null
    }
  });
  node.warn('Sync outbox mark failed: ' + e.message);
  return null;
}
})();`;

const SYNC_BOOTSTRAP_MARK_FUNC = `return (async()=>{
function setSyncState(patch) {
  const current = flow.get('sync_state') || {};
  flow.set('sync_state', Object.assign({}, current, patch));
}
function isHttpSuccess(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300;
}
function decodeJwtExp(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  let value = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  try {
    const decodedPayload = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    const exp = Number(decodedPayload.exp || 0);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch (_) {
    return null;
  }
}
const payload = msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)
  ? msg.payload
  : null;
if (!isHttpSuccess(msg.statusCode) || !payload || payload.success !== true) {
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'bootstrap',
      message: String((payload || {}).message || (payload || {}).error || (payload || {}).detail || 'Bootstrap sync failed'),
      statusCode: Number.isInteger(msg.statusCode) ? msg.statusCode : null
    }
  });
  return null;
}
const _db = new osiDb.Database('/data/db/farming.db');
const run = (sql, params = []) => new Promise((res,rej) => _db.run(sql, params, (e) => e?rej(e):res()));
const close = () => new Promise(res => _db.close(() => res()));
try {
  const now = new Date().toISOString();
  await run("INSERT INTO sync_cursor(peer_node,last_full_backfill_at) VALUES('cloud',?) ON CONFLICT(peer_node) DO UPDATE SET last_full_backfill_at=excluded.last_full_backfill_at", [now]);
  const nextSyncToken = String(payload.token || '').trim();
  if (nextSyncToken && Number.isFinite(Number(msg._syncLinkedUserId || 0)) && Number(msg._syncLinkedUserId || 0) > 0) {
    const syncTokenExpiresAt = Number(payload.syncTokenExpiresAt || 0) || decodeJwtExp(nextSyncToken) || null;
    await run(
      'UPDATE users SET server_sync_token = ?, server_sync_token_expires_at = ? WHERE id = ?',
      [nextSyncToken, syncTokenExpiresAt, Number(msg._syncLinkedUserId)]
    );
  }
  const currentState = flow.get('sync_state') || {};
  const gatewayMigration = payload.gatewayMigration || {};
  const previousGatewayDeviceEuis = Array.isArray(gatewayMigration.previousGatewayDeviceEuis) && gatewayMigration.previousGatewayDeviceEuis.length
    ? gatewayMigration.previousGatewayDeviceEuis
    : (Array.isArray(currentState.gatewayMigrationPreviousGatewayDeviceEuis) ? currentState.gatewayMigrationPreviousGatewayDeviceEuis : []);
  const currentGatewayDeviceEui = String(gatewayMigration.currentGatewayDeviceEui || currentState.gatewayMigrationLastTo || env.get('DEVICE_EUI') || '').trim().toUpperCase() || null;
  const patch = {
    lastBootstrapSuccessAt: now,
    updatedAt: now,
    gatewayMigrationInProgress: false
  };
  if ((gatewayMigration && gatewayMigration.migrated) || currentState.gatewayMigrationPendingBootstrap) {
    patch.gatewayMigrationPendingBootstrap = false;
    patch.gatewayMigrationPaused = false;
    patch.gatewayMigrationPreviousGatewayDeviceEuis = [];
    patch.gatewayMigrationLastTo = currentGatewayDeviceEui;
    patch.gatewayMigrationLastResult = {
      status: 'bootstrapped',
      at: now,
      reason: 'canonical_gateway_changed',
      from: previousGatewayDeviceEuis,
      to: currentGatewayDeviceEui
    };
  }
  if (currentState.lastError && (currentState.lastError.source === 'bootstrap' || currentState.lastError.source === 'gateway-identity')) patch.lastError = null;
  setSyncState(patch);
  await close();
  return null;
} catch (e) {
  try { await close(); } catch(_) {}
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'bootstrap',
      message: String(e.message || e),
      statusCode: null
    }
  });
  node.warn('Sync bootstrap mark failed: ' + e.message);
  return null;
}
})();`;

const TARGETS = [
  { id: 'sync-outbox-mark', func: SYNC_OUTBOX_MARK_FUNC },
  { id: 'sync-bootstrap-mark', func: SYNC_BOOTSTRAP_MARK_FUNC },
];

function run() {
  console.log('Roundtrip guard (pre-mutation) ...');
  const flows = assertRoundtripByteIdentical(CANONICAL);
  console.log('  OK: canonical byte-identical before mutation. Node count:', flows.length);

  let mutated = 0;
  for (const target of TARGETS) {
    const node = flows.find((n) => n && n.id === target.id);
    if (!node || node.type !== 'function') {
      throw new Error('missing function node ' + target.id);
    }
    if (node.func === target.func) {
      console.log('  SKIP: ' + target.id + ' already matches target func (no-op)');
      continue;
    }
    node.func = target.func;
    mutated += 1;
    console.log('  MUTATED: ' + target.id);
  }

  fs.writeFileSync(CANONICAL, serialize(flows));
  fs.writeFileSync(MIRROR, serialize(flows));
  console.log('Wrote canonical + mirror. Nodes mutated this run:', mutated);

  assertRoundtripByteIdentical(CANONICAL);
  assertRoundtripByteIdentical(MIRROR);
  console.log('Roundtrip guard (post-write) OK on both profiles.');
}

if (require.main === module) {
  try {
    run();
  } catch (e) {
    console.error('edit-sync-delivery-consumers: FAIL - ' + e.message);
    process.exit(1);
  }
}

module.exports = { SYNC_OUTBOX_MARK_FUNC, SYNC_BOOTSTRAP_MARK_FUNC, TARGETS };
