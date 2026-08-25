'use strict';
// Derived valve runtime-state sync (Bovey cloud full-parity Task P3-E1). Unlike
// valve_settings/valve_schedules (migrations 0024/0025 -- an SQL AFTER INSERT/UPDATE trigger
// pair keyed off a real backing table), ValveRuntime has no table of its own: it is assembled
// at emit time from valve_actuation_expectations and valve_schedule_pushes, mirroring the same
// derivation api.js's GET /api/valves route already runs (shapeValve() + store.pushSummary()).
// Emission therefore has to happen from the JS code paths that change this state, not from a
// trigger. The enqueue itself is cloned from osi-journal/lifecycle.js's emitJournalOutbox(): a
// direct `INSERT INTO sync_outbox` with the op bound as a parameter (not a SQL literal), which
// is the established "JS code-path emitter" shape in this codebase -- as opposed to the trigger
// shape 0024/0025 use.
//
// Coalescing: a burst of state changes (e.g. an ack immediately followed by a reconciliation
// transition) can legitimately emit more than one VALVE_RUNTIME_CHANGED event for the same
// device in quick succession. That is accepted by design -- the cloud applier is last-write-wins
// on `as_of` -- and this module deliberately does not debounce/coalesce them itself.
const crypto = require('node:crypto');
const store = require('./store');

// Same COALESCE(NULLIF(trim(devices.gateway_device_eui)), NULLIF(trim(sync_link_state.gateway_
// device_eui))) fallback chain the 0024/0025 trigger payloads use, plus the `linked = 1` gate the
// triggers guard on (`WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND
// linked = 1)`). A device-level override is checked first: a per-device gateway_device_eui exists
// for exactly the same reason the trigger SQL checks it (see 0024/0025 comments).
async function resolveLinkAndGateway(db, deviceEui) {
  const [linkRow, deviceRow] = await Promise.all([
    db.get("SELECT linked, gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'"),
    db.get('SELECT gateway_device_eui FROM devices WHERE UPPER(deveui) = UPPER(?) AND deleted_at IS NULL', [deviceEui]),
  ]);
  const linked = !!linkRow && Number(linkRow.linked) === 1;
  const fromDevice = deviceRow && deviceRow.gateway_device_eui ? String(deviceRow.gateway_device_eui).trim() : '';
  const fromLink = linkRow && linkRow.gateway_device_eui ? String(linkRow.gateway_device_eui).trim() : '';
  return { linked, gatewayDeviceEui: fromDevice || fromLink || null };
}

function buildActiveActuation(row) {
  if (!row) return null;
  return {
    expectation_id: row.expectation_id,
    reconciliation_state: row.reconciliation_state,
    commanded_at: row.commanded_at,
    expected_close_at: row.expected_close_at,
    duration_seconds: row.duration_seconds,
    trigger: row.trigger || null,
  };
}

// Assembles the ValveRuntime resource payload (docs/contracts/sync-schema/resources.schema.json)
// for one device, reusing store.js's derivations -- the same ones api.js's shapeValve()/
// pushSummary() use for the edge GET /api/valves response, so the cloud sees exactly the field
// values/casing the edge GUI itself renders from.
//
// `now` (optional Date) is a snapshot-build-time override, for test determinism only -- see
// emitRuntimeChanged's comment below for why production callers never pass one.
async function buildRuntimePayload(db, deviceEui, now) {
  const eui = String(deviceEui).toUpperCase();
  const [active, staleState, pushes, settings] = await Promise.all([
    store.activeActuation(db, eui),
    store.recentStaleState(db, eui),
    store.pushSummary(db, eui),
    store.getSettings(db, eui),
  ]);
  const pushState = {
    queued: Number(pushes.queued || 0),
    acked: Number(pushes.acked || 0),
    failed: Number(pushes.failed || 0),
    last_plan_acked_at: pushes.last_plan_acked_at || null,
  };
  // GEN2 has no meaningful per-weekday row (DAYMASK_PLAN rows carry weekday=null); the schedule
  // dialog itself only shows the "overall" badge for GEN2 for the same reason (ValveScheduleDialog.
  // tsx's per-weekday filter finds nothing to show). Mirrors that: weekday_states is GEN1-only.
  if ((settings.strega_generation || 'GEN1') === 'GEN1') {
    // P3-E1 review fix (IMPORTANT 2): store.weekdayPushStates returns EVERY surviving ledger row,
    // unbounded -- supersedeQueued only ever touches state='QUEUED' rows, so an already-ACKED row
    // is never superseded by a later re-edit of the same weekday and both rows survive the
    // state IN ('QUEUED','ACKED','FAILED') filter forever. Collapse to one entry per weekday here,
    // the same first-wins-in-queued_at-DESC-order collapse store.pushSummary()'s own
    // latestStateBySlot already applies for its aggregate counts -- rows arrive pre-sorted
    // `ORDER BY queued_at DESC`, so the first row seen per weekday is the newest.
    const rows = await store.weekdayPushStates(db, eui);
    const latestByWeekday = new Map();
    for (const r of rows) {
      if (r.purpose !== 'WEEKDAY_PLAN') continue;
      if (!latestByWeekday.has(r.weekday)) latestByWeekday.set(r.weekday, r);
    }
    pushState.weekday_states = [...latestByWeekday.values()]
      .sort((a, b) => a.weekday - b.weekday)
      .map((r) => ({ weekday: r.weekday, state: r.state, acked_at: r.acked_at || null }));
  }
  return {
    contract_version: 1,
    device_eui: eui,
    active_actuation: buildActiveActuation(active),
    recent_stale_state: staleState,
    push_state: pushState,
    // P3-E1 review fix (IMPORTANT 3): as_of is stamped exactly once, here, at the instant this
    // snapshot is actually assembled -- never from an event-specific timestamp (an uplink's
    // receivedAt, an expectation's commanded_at, a cancel's own `now`). Those can be older than
    // the previous emission's as_of (a delayed/replayed uplink, e.g.), which would let a NEWER,
    // more accurate snapshot lose a last-write-wins comparison on the cloud to an OLDER, stale
    // one. `now` exists only so tests can pin this value; no production call site passes it.
    as_of: (now instanceof Date ? now : new Date()).toISOString(),
  };
}

// Builds and enqueues a VALVE_RUNTIME_CHANGED sync_outbox row for deviceEui. `db` may be the
// live osi-db-helper facade or a transaction scope (tx) -- both expose get/all/run, matching the
// convention documented at the top of store.js -- so callers already inside a db.transaction()
// (e.g. the reconciliation monitor, push.js's queuePushes) can pass `tx` and get the emission
// inside the same atomic write as the state change it reports.
//
// Returns null (no-op) when unlinked, matching the trigger pair's own `WHEN EXISTS (... linked =
// 1)` guard -- there is nothing useful to enqueue for a gateway that has never linked to a cloud
// account. Also a no-op (with a warn) when no gateway_device_eui resolves at all -- same guard
// the gateway_locations trigger (trg_gateway_locations_outbox_ai) uses: an outbox row with a NULL
// gateway_device_eui is an undeliverable orphan, not a harmless placeholder.
//
// `warn` is optional (best-effort logging only -- every call site here is itself best-effort, see
// each seam's own try/catch). `now` is a snapshot-build-time override for test determinism only;
// production callers never pass it (see buildRuntimePayload's comment on as_of above).
async function emitRuntimeChanged(db, deviceEui, warn, now) {
  const link = await resolveLinkAndGateway(db, deviceEui);
  if (!link.linked) return null;
  if (!link.gatewayDeviceEui) {
    if (typeof warn === 'function') warn('[valve-control] runtime emit skipped for ' + deviceEui + ': no resolvable gateway_device_eui');
    return null;
  }
  const payload = await buildRuntimePayload(db, deviceEui, now);
  const eventUuid = crypto.randomUUID();
  await db.run(
    'INSERT INTO sync_outbox (' +
      'event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui' +
    ') VALUES (?,?,?,?,?,?,?,?)',
    [
      eventUuid,
      'VALVE_RUNTIME',
      payload.device_eui,
      'VALVE_RUNTIME_CHANGED',
      JSON.stringify(payload),
      // No backing sync_version to stamp (derived state, no owning row) -- the cloud applier is
      // last-write-wins on payload.as_of instead; sync_outbox.sync_version stays a constant 0.
      0,
      payload.as_of,
      link.gatewayDeviceEui,
    ]
  );
  return { event_uuid: eventUuid, payload };
}

module.exports = { buildRuntimePayload, emitRuntimeChanged };
