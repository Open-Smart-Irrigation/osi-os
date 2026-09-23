#!/usr/bin/env node
'use strict';

// Requeue one bounded list of explicitly named rejected events. A cloud replay
// receipt is required before --execute can mutate an outbox row.

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const policy = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-rejection-recovery');

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const opts = { execute: false, receiptPaths: [], eventUuidArgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') opts.execute = true;
    else if (arg === '--actor') opts.actor = requireValue(argv, i++, arg);
    else if (arg === '--receipt') opts.receiptPaths.push(requireValue(argv, i++, arg));
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    else if (!opts.dbPath) opts.dbPath = arg;
    else opts.eventUuidArgs.push(arg);
  }
  if (!opts.dbPath) throw new Error(usage());
  opts.eventUuids = policy.parseEventUuidList(opts.eventUuidArgs);
  if (opts.execute && opts.receiptPaths.length === 0) {
    throw new Error('--execute requires at least one --receipt JSON file');
  }
  opts.actor = String(opts.actor || process.env.USER || 'operator').trim();
  if (!opts.actor) throw new Error('--actor must be non-empty');
  return opts;
}

function usage() {
  return 'usage: requeue-rejected-outbox.js <farming.db> <event-uuid>... [--receipt FILE] [--actor ACTOR] [--execute]';
}

function receiptEntries(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && (value.cloudReplayRequest || value.request) && (value.cloudReplayResponse || value.response)) return [value];
  if (value && typeof value === 'object' && Array.isArray(value.receipts)) return value.receipts;
  if (value && typeof value === 'object') return Object.values(value);
  throw new Error('receipt file must contain a receipt object, array, or receipt map');
}

function readReceipts(paths) {
  const byEventUuid = new Map();
  for (const receiptPath of paths) {
    const raw = fs.readFileSync(receiptPath, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) {
      throw new Error(`receipt ${receiptPath} is not valid JSON: ${error.message}`);
    }
    for (const receipt of receiptEntries(parsed)) {
      const request = receipt && (receipt.cloudReplayRequest || receipt.request);
      if (!request || !request.eventUuid) {
        throw new Error(`receipt ${receiptPath} has no cloudReplayRequest.eventUuid`);
      }
      const eventUuid = String(request.eventUuid);
      if (byEventUuid.has(eventUuid)) throw new Error(`duplicate receipt for event UUID: ${eventUuid}`);
      byEventUuid.set(eventUuid, { receipt, json: JSON.stringify(receipt) });
    }
  }
  return byEventUuid;
}

function loadRow(db, eventUuid) {
  return db.prepare(`
    SELECT event_uuid, aggregate_type, aggregate_key, op, payload_json,
           sync_version, occurred_at, delivered_at, retry_count,
           gateway_device_eui, rejected_at, rejection_reason,
           last_retryable_failure_at, rejection_code, rejection_class,
           recovery_generation
      FROM sync_outbox WHERE event_uuid = ?
  `).get(eventUuid);
}

function assertRecoverableRow(row, eventUuid) {
  return policy.validateRecoverableRow(row, eventUuid);
}

function summarize(db, eventUuids, receipts) {
  return eventUuids.map((eventUuid) => {
    const row = loadRow(db, eventUuid);
    return {
      eventUuid,
      found: Boolean(row),
      rejected: Boolean(row && row.rejected_at !== null),
      delivered: Boolean(row && row.delivered_at !== null),
      generation: row ? row.recovery_generation : null,
      receipt: receipts.has(eventUuid),
    };
  });
}

function printSummary(rows, execute) {
  console.log(`[requeue] ${execute ? 'EXECUTE' : 'DRY RUN'} — ${rows.length} explicitly selected row(s)`);
  for (const row of rows) {
    console.log(`  ${row.eventUuid} found=${row.found} rejected=${row.rejected} delivered=${row.delivered} generation=${row.generation} receipt=${row.receipt}`);
  }
}

function executeRecovery(db, opts, receipts) {
  const attemptedAt = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const eventUuid of opts.eventUuids) {
      const row = loadRow(db, eventUuid);
      const payload = assertRecoverableRow(row, eventUuid);
      const receiptEntry = receipts.get(eventUuid);
      if (!receiptEntry) throw new Error(`receipt missing for event UUID: ${eventUuid}`);
      policy.validateReceipt(receiptEntry.receipt, {
        eventUuid,
        gatewayDeviceEui: row.gateway_device_eui,
        rejectionCode: row.rejection_code,
        rejectionClass: row.rejection_class,
      });
      const envelopeSha = policy.envelopeSha256(row, payload);
      policy.validateEnvelopeSha256(envelopeSha);
      db.prepare(`
        INSERT INTO sync_outbox_recovery_audit
          (event_uuid, generation, actor, attempted_at,
           previous_rejection_code, previous_rejection_class, previous_rejection_reason,
           envelope_sha256, receipt_json)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventUuid, opts.actor, attemptedAt,
        row.rejection_code, row.rejection_class, row.rejection_reason,
        envelopeSha, receiptEntry.json,
      );
      const changed = db.prepare(`
        UPDATE sync_outbox
           SET rejected_at = NULL,
               rejection_reason = NULL,
               rejection_code = NULL,
               rejection_class = NULL,
               last_retryable_failure_at = NULL,
               retry_count = 0,
               recovery_generation = 1
         WHERE event_uuid = ?
           AND delivered_at IS NULL
           AND rejected_at IS NOT NULL
           AND rejection_code = ?
           AND rejection_class = ?
           AND recovery_generation = 0
      `).run(eventUuid, policy.REPAIRABLE_REJECTION_CODE, policy.REPAIRABLE_REJECTION_CLASS);
      if (changed.changes !== 1) throw new Error(`event ${eventUuid} changed while recovery was running`);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* preserve the original failure */ }
    throw error;
  }
}

function run(opts) {
  if (!fs.existsSync(opts.dbPath)) throw new Error(`database file does not exist: ${opts.dbPath}`);
  const receipts = readReceipts(opts.receiptPaths);
  const db = new DatabaseSync(opts.dbPath);
  try {
    const rows = summarize(db, opts.eventUuids, receipts);
    printSummary(rows, opts.execute);
    if (!opts.execute) return { rows, changed: 0 };
    executeRecovery(db, opts, receipts);
    console.log(`[requeue] recovery committed for ${opts.eventUuids.length} row(s)`);
    return { rows, changed: opts.eventUuids.length };
  } finally {
    db.close();
  }
}

function main() {
  try {
    run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`[requeue] ${error.message}`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  readReceipts,
  loadRow,
  assertRecoverableRow,
  summarize,
  executeRecovery,
  run,
};
