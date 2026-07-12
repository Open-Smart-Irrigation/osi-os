#!/usr/bin/env node
'use strict';
const { emitArtifact, scratchDir, makeFacadeShim } = require('./rig');

const MIN_OUTBOX_DDL = `
CREATE TABLE sync_outbox (
  event_uuid TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_key TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  delivered_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT
);`;

async function synthesizeBacklog(shim, { total, poisonEveryN }) {
  let inserted = 0;
  let poison = 0;
  await shim.transaction(async (s) => {
    for (let i = 0; i < total; i += 1) {
      const isPoison = poisonEveryN > 0 && i % poisonEveryN === 0;
      const uuid = `evt-${String(i).padStart(6, '0')}`;
      const payload = isPoison ? '{"bad":' : '{"ok":true}';
      await s.run(
        `INSERT INTO sync_outbox (event_uuid, aggregate_type, aggregate_key, op, payload_json, occurred_at)
         VALUES ('${uuid}', 'device_data', 'k${i}', 'insert', '${payload}', '2026-05-01T00:00:00Z')`
      );
      inserted += 1;
      if (isPoison) poison += 1;
    }
  });
  return { inserted, poison };
}

const DRAIN_SQL = `
  SELECT event_uuid, aggregate_type, aggregate_key, op, payload_json, occurred_at
  FROM sync_outbox
  WHERE delivered_at IS NULL AND rejected_at IS NULL
  ORDER BY occurred_at ASC, event_uuid ASC
  LIMIT 100`;

async function drainBacklog(shim, { applyBatch }) {
  let batches = 0;
  let delivered = 0;
  let rejected = 0;
  let retryable = 0;
  for (let guard = 0; guard < 100000; guard += 1) {
    const rows = await shim.all(DRAIN_SQL);
    if (rows.length === 0) break;
    batches += 1;
    const events = rows.map((r) => ({
      event_uuid: r.event_uuid,
      aggregate_type: r.aggregate_type,
      payload_json: r.payload_json,
      poison: (() => { try { JSON.parse(r.payload_json); return false; } catch (_) { return true; } })(),
    }));
    const result = applyBatch(events);
    const now = new Date().toISOString();
    for (const uuid of result.delivered) {
      await shim.run(`UPDATE sync_outbox SET delivered_at='${now}' WHERE event_uuid='${uuid}'`);
      delivered += 1;
    }
    for (const r of result.rejected) {
      await shim.run(
        `UPDATE sync_outbox SET rejected_at='${now}', rejection_reason='${r.reason}' WHERE event_uuid='${r.uuid}'`
      );
      rejected += 1;
    }
    if (result.delivered.length === 0 && result.rejected.length === 0) {
      retryable += rows.length;
      break;
    }
  }
  const remaining = (await shim.get(
    'SELECT COUNT(*) c FROM sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL'
  )).c;
  return { batches, delivered, rejected, retryable, remaining };
}

async function run({ total = 10000, poisonEveryN = 500, applyBatch, artifactDir } = {}) {
  const db = require('node:path').join(scratchDir('sov1-run-'), 'f.db');
  const shim = makeFacadeShim(db);
  await shim.exec(MIN_OUTBOX_DDL);
  const t0 = Date.now();
  const { inserted, poison } = await synthesizeBacklog(shim, { total, poisonEveryN });
  const drain = await drainBacklog(shim, { applyBatch: applyBatch || (() => ({ delivered: [], rejected: [] })) });
  const timingsMs = Date.now() - t0;
  const outcome = (drain.remaining === 0
    && drain.delivered + drain.rejected + drain.retryable === inserted
    && timingsMs < 60000) ? 'pass' : 'fail';
  const result = {
    inputs: { total, poisonEveryN, applyTarget: applyBatch ? 'injected' : 'null' },
    invariants: { inserted, poison, ...drain },
    outcome,
    timingsMs,
    notes: 'Edge-side companion to 1.B4 server backlog-drain; drain query mirrors flows node sync-outbox-build (LIMIT 100).',
  };
  await new Promise((res) => shim.close(res));
  if (artifactDir) result.artifactPath = emitArtifact(artifactDir, 'outbox-replay', result);
  return result;
}

module.exports = { MIN_OUTBOX_DDL, synthesizeBacklog, drainBacklog, run };

if (require.main === module) {
  run({ artifactDir: require('node:path').join(__dirname, 'artifacts') })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.outcome === 'pass' ? 0 : 1); })
    .catch((e) => { console.error(`[outbox-replay] ERROR: ${e.message}`); process.exit(2); });
}
