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

// --- Bovey cloud full-parity Task P4-E1: terminal actuation history (VALVE_ACTUATION_ARCHIVED) ---
//
// Maps a TERMINAL valve_actuation_expectations.reconciliation_state to the ValveActuation
// resource's `status` vocabulary (docs/contracts/sync-schema/resources.schema.json). Only
// terminal reconciliation states appear here -- PENDING_OBSERVATION/OBSERVED_RUNNING are active,
// not archived, and are intentionally absent (buildActuationPayload/emitActuationArchived below
// no-op for them, so a caller never needs its own "is this terminal" check before calling in).
// COMMAND_FAILED is NOT included: the edge panel (get-actuations-response's deriveStatus, in
// flows.json) derives COMMAND_FAILED from applied_commands.result at GET-time, not from
// reconciliation_state -- there is no discrete write inside "the reconciliation monitor + cancel
// path" (this task's scoped emission seams) that ever marks a row command-failed, so this task
// does not emit it. See docs/superpowers/sdd/2026-08-25-bovey-cloud-full-parity-program/
// task-p4e1-report.md for the full trace of why (applied_commands is written by the generic
// osi-command-ledger module, shared across command domains well outside these two seams).
const TERMINAL_STATUS_BY_RECONCILIATION_STATE = {
  OBSERVED_COMPLETE: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  STALE_NO_OBSERVATION: 'OPEN_TIMEOUT',
  STALE_OPEN_OBSERVED: 'CLOSE_TIMEOUT',
};

// Assembles the ValveActuation resource payload for one expectation row, mirroring the field
// values GET /api/irrigation/recent-actuations serves for the same row (get-actuations-query's
// SQL + get-actuations-response's Format Response function in flows.json) -- zone_uuid replaces
// the edge-local zone_id (sync payloads never carry local integer ids) and duration_seconds
// replaces commanded_duration_seconds (renamed, same value). `status` is the row's terminal
// state, not recomputed against a wall-clock grace window: once terminal the row never changes
// again, so there is nothing left to time out further. Returns null when the expectation does
// not exist, or exists but has not (yet) reached a terminal reconciliation_state.
async function buildActuationPayload(db, expectationId) {
  const row = await db.get(
    'SELECT vae.expectation_id, vae.device_eui, vae.reconciliation_state, vae.trigger, ' +
      'vae.commanded_at, vae.observed_open_at, vae.observed_close_at, vae.expected_close_at, ' +
      'vae.commanded_duration_seconds, vae.estimated_gross_liters, vae.volume_source, vae.cancel_reason, ' +
      '(SELECT zone_uuid FROM irrigation_zones WHERE id = vae.zone_id AND deleted_at IS NULL) AS zone_uuid, ' +
      'ac.result_detail AS command_result_detail ' +
      'FROM valve_actuation_expectations vae LEFT JOIN applied_commands ac ON ac.command_id = vae.command_id ' +
      'WHERE vae.expectation_id = ?',
    [expectationId]
  );
  if (!row) return null;
  const status = TERMINAL_STATUS_BY_RECONCILIATION_STATE[row.reconciliation_state];
  if (!status) return null;
  return {
    contract_version: 1,
    expectation_id: row.expectation_id,
    device_eui: String(row.device_eui).toUpperCase(),
    zone_uuid: row.zone_uuid || null,
    status,
    trigger: row.trigger || null,
    commanded_at: row.commanded_at,
    observed_open_at: row.observed_open_at || null,
    observed_close_at: row.observed_close_at || null,
    expected_close_at: row.expected_close_at || null,
    duration_seconds: row.commanded_duration_seconds != null ? Number(row.commanded_duration_seconds) : null,
    estimated_gross_liters: row.estimated_gross_liters != null ? Number(row.estimated_gross_liters) : null,
    volume_source: row.volume_source || null,
    cancel_reason: row.cancel_reason || null,
    command_result_detail: row.command_result_detail || null,
    // No sync_version bookkeeping column exists on this table (unlike ValveSettings) -- the
    // cloud applier is last-write-wins on this field instead, the same as ValveRuntime.as_of.
    // Deterministic from the row's own terminal timestamps, never wall-clock "now": the row
    // never changes again once terminal, so a repeated emission (bootstrap replay, a later
    // trigger-backfill touching the same row) resolves to the SAME archived_at rather than
    // drifting forward on every re-run.
    archived_at: row.observed_close_at || row.expected_close_at || row.commanded_at,
  };
}

// Builds and enqueues a VALVE_ACTUATION_ARCHIVED sync_outbox row for one expectation. Reuses the
// same link/gateway resolution and best-effort-INSERT shape as emitRuntimeChanged above (see its
// comment block for the guard rationale) -- the only difference is this event carries no
// meaningful `now` override (there is nothing to snapshot-build; buildActuationPayload reads
// entirely from the row's own persisted, immutable-once-terminal fields).
//
// No-ops (returning null) when: unlinked; no resolvable gateway_device_eui (warns); the
// expectation does not exist; or the expectation has not reached a terminal state yet -- this
// last guard means callers (cancel.js, the strega-reconciliation-monitor flows.json node) can
// call in unconditionally after ANY transition without checking terminality themselves.
async function emitActuationArchived(db, deviceEui, expectationId, warn) {
  const link = await resolveLinkAndGateway(db, deviceEui);
  if (!link.linked) return null;
  if (!link.gatewayDeviceEui) {
    if (typeof warn === 'function') warn('[valve-control] actuation-archive emit skipped for ' + deviceEui + ': no resolvable gateway_device_eui');
    return null;
  }
  const payload = await buildActuationPayload(db, expectationId);
  if (!payload) return null;
  const eventUuid = crypto.randomUUID();
  await db.run(
    'INSERT INTO sync_outbox (' +
      'event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui' +
    ') VALUES (?,?,?,?,?,?,?,?)',
    [
      eventUuid,
      'VALVE_ACTUATION',
      payload.expectation_id,
      'VALVE_ACTUATION_ARCHIVED',
      JSON.stringify(payload),
      // Same rationale as VALVE_RUNTIME_CHANGED above: no backing sync_version to stamp, the
      // cloud applier is last-write-wins on payload.archived_at instead.
      0,
      payload.archived_at,
      link.gatewayDeviceEui,
    ]
  );
  return { event_uuid: eventUuid, payload };
}

module.exports = {
  buildRuntimePayload,
  emitRuntimeChanged,
  buildActuationPayload,
  emitActuationArchived,
  TERMINAL_STATUS_BY_RECONCILIATION_STATE,
};
