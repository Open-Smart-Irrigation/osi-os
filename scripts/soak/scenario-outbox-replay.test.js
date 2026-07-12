'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { scratchDir, makeFacadeShim } = require('./rig');
const { synthesizeBacklog, drainBacklog, MIN_OUTBOX_DDL } = require('./scenario-outbox-replay');

async function freshOutbox() {
  const db = path.join(scratchDir('sov1-'), 'f.db');
  const shim = makeFacadeShim(db);
  await shim.exec(MIN_OUTBOX_DDL);
  return shim;
}

// In-process apply that models 1.B4's per-event-transaction contract: each event
// is applied independently; a poison event is rejected, never wedges the batch.
function fakeServer() {
  const applied = new Set();
  return {
    applied,
    apply(events) {
      const out = { delivered: [], rejected: [] };
      for (const e of events) {
        if (e.poison) { out.rejected.push({ uuid: e.event_uuid, reason: 'constraint_violation' }); continue; }
        if (applied.has(e.event_uuid)) { out.delivered.push(e.event_uuid); continue; } // idempotent
        applied.add(e.event_uuid);
        out.delivered.push(e.event_uuid);
      }
      return out;
    },
  };
}

test('a weeks-offline backlog drains to zero pending (minus terminally-rejected); no poison wedges a batch', async () => {
  const shim = await freshOutbox();
  const { inserted, poison } = await synthesizeBacklog(shim, { total: 2500, poisonEveryN: 500 });
  assert.ok(inserted > 2000 && poison >= 4, `inserted=${inserted} poison=${poison}`);
  const server = fakeServer();
  const res = await drainBacklog(shim, { applyBatch: (events) => server.apply(events) });
  // reconciliation: delivered + rejected + retryable == input
  assert.equal(res.delivered + res.rejected + res.retryable, inserted);
  assert.equal(res.rejected, poison, 'exactly the poison rows are terminally rejected');
  // no undelivered/unrejected rows remain (a wedged batch would leave a stuck LIMIT-100 window)
  assert.equal(res.remaining, 0, 'backlog fully drained');
  assert.ok(res.batches >= Math.ceil(inserted / 100), 'drained via LIMIT-100 batches');
});

test('re-drain of an already-delivered backlog is a clean no-op (idempotent replay)', async () => {
  const shim = await freshOutbox();
  const { inserted } = await synthesizeBacklog(shim, { total: 300, poisonEveryN: 0 });
  const server = fakeServer();
  await drainBacklog(shim, { applyBatch: (e) => server.apply(e) });
  const second = await drainBacklog(shim, { applyBatch: (e) => server.apply(e) });
  assert.equal(second.delivered + second.rejected + second.retryable, 0);
  assert.equal(second.remaining, 0);
  assert.equal(inserted, 300);
});
