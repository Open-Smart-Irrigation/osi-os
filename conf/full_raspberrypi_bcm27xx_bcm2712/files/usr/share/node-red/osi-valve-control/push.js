'use strict';
const crypto = require('node:crypto');
const P = require('./plan');
const store = require('./store');
const runtime = require('./runtime');
const dispatch = require('./dispatch');

function hexOf(buf) { return Buffer.from(buf).toString('hex').toUpperCase(); }

function buildPlanPushes({ generation, days, lastHashes, force }) {
  const out = [];
  const last = lastHashes || {};
  if (generation === 'GEN2') {
    // Diff per weekday (CRITICAL 2, review round 1), not per group: a group's daymask is
    // just how the current compile happens to bucket identical days together, and that
    // bucketing can legitimately differ from compile to compile (e.g. a day changes then
    // reverts) even though a given weekday's own window did or didn't change. Pushing the
    // group whenever ANY of its weekdays is stale (or missing a hash — never pushed / only
    // superseded rows on record for it) keeps every weekday's actually-applied plan in sync
    // with what's compiled now, regardless of how it was grouped last time.
    for (const g of P.gen2Groups(days)) {
      const h = P.planHash(g.windows);
      const groupDays = g.daymask === 0x80 ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5, 6].filter((d) => (g.daymask >> d) & 1);
      const stale = force || groupDays.some((d) => last['GEN2DAY:' + d] !== h);
      if (!stale) continue;
      out.push({ purpose: 'DAYMASK_PLAN', weekday: null, daymask: g.daymask, fport: P.GEN2_SCHEDULER_FPORT, payloadHex: hexOf(P.encodeGen2(g.daymask, g.windows)), planHash: h });
    }
    return out;
  }
  for (let d = 0; d < 7; d += 1) {
    const h = P.planHash(days[d]);
    if (!force && last['WEEKDAY_PLAN:' + d] === h) continue;
    out.push({ purpose: 'WEEKDAY_PLAN', weekday: d, daymask: null, fport: P.WEEKDAY_FPORT_BASE + d, payloadHex: hexOf(P.encodeGen1Day(days[d])), planHash: h });
  }
  return out;
}

function buildDownlinkMessage({ appId, deviceEui, fport, payloadHex }) {
  const eui = String(deviceEui).toUpperCase();
  return {
    topic: 'application/' + appId + '/device/' + eui + '/command/down',
    payload: { devEui: eui, confirmed: false, fPort: fport, data: Buffer.from(payloadHex, 'hex').toString('base64') },
  };
}

function buildStatusPush(code) {
  if (!['0', '1', '2'].includes(String(code))) throw new Error('scheduler status code must be 0, 1 or 2');
  return { purpose: 'SCHEDULER_STATUS', weekday: null, fport: P.STATUS_FPORT, payloadHex: hexOf(Buffer.from(String(code), 'ascii')), planHash: null };
}

function buildClockPush(generation, now, timeZone) {
  if (generation === 'GEN2') return { purpose: 'CLOCK_SYNC', weekday: null, fport: P.CLOCK_REQ_FPORT, payloadHex: '01', planHash: null };
  return { purpose: 'CLOCK_SYNC', weekday: null, fport: P.CLOCK_FPORT, payloadHex: hexOf(P.gen1ClockPayload(now, timeZone)), planHash: null };
}

function toRow(deviceEui, p) {
  return { push_id: crypto.randomUUID(), device_eui: deviceEui, purpose: p.purpose, weekday: p.weekday, fport: p.fport, payload_hex: p.payloadHex, plan_hash: p.planHash || null, transport_json: p.transport_json || null };
}

function clearPlanPushes(generation) {
  if (generation === 'GEN2') {
    return [{ purpose: 'DAYMASK_PLAN', weekday: null, daymask: 0x80, fport: P.GEN2_SCHEDULER_FPORT, payloadHex: '80', planHash: P.planHash([]) }];
  }
  return Array.from({ length: 7 }, (_, weekday) => ({
    purpose: 'WEEKDAY_PLAN', weekday, daymask: null, fport: P.WEEKDAY_FPORT_BASE + weekday,
    payloadHex: hexOf(P.encodeGen1Day([])), planHash: P.planHash([]),
  }));
}

const LIFECYCLE_CLEAR_RESEND_PURPOSE = 'lifecycle_clear_resend';
const PREACCEPTANCE_PHASES = new Set(['enqueue_failed_before_acceptance', 'enqueue_rejected']);

function lifecycleScheduleSnapshot(row) {
  return {
    schedule_uuid: row.schedule_uuid,
    device_eui: String(row.device_eui).toUpperCase(),
    kind: row.kind,
    label: row.label == null ? null : row.label,
    weekdays_mask: row.weekdays_mask == null ? null : Number(row.weekdays_mask),
    start_time: row.start_time == null ? null : row.start_time,
    fire_at: row.fire_at == null ? null : row.fire_at,
    duration_minutes: Number(row.duration_minutes),
    timezone: row.timezone,
    enabled: Number(row.enabled),
    once_state: row.once_state == null ? null : row.once_state,
    once_fired_at: row.once_fired_at == null ? null : row.once_fired_at,
    sync_version: Number(row.sync_version || 0),
    deleted_at: row.deleted_at == null ? null : row.deleted_at,
    condition_policy_uuid: row.condition_policy_uuid == null ? null : row.condition_policy_uuid,
    effective_from: row.effective_from == null ? null : row.effective_from,
  };
}

function lifecycleScheduleSort(a, b) {
  return String(a.schedule_uuid).localeCompare(String(b.schedule_uuid));
}

function lifecycleDevice(row) {
  if (!row || !Number.isInteger(Number(row.id))) throw Object.assign(new Error('lifecycle_binding_missing'), { code: 'lifecycle_binding_missing' });
  return {
    row_id: Number(row.id),
    device_eui: String(row.deveui).toUpperCase(),
    type_id: row.type_id,
    user_id: row.user_id == null ? null : Number(row.user_id),
    irrigation_zone_id: row.irrigation_zone_id == null ? null : Number(row.irrigation_zone_id),
    deleted_at: row.deleted_at == null ? null : row.deleted_at,
  };
}

function lifecycleZone(row) {
  if (!row) return null;
  return { zone_uuid: row.zone_uuid, sync_version: Number(row.sync_version || 0), deleted_at: row.deleted_at == null ? null : row.deleted_at };
}

function lifecyclePolicy(row) {
  if (!row) return null;
  return { policy_uuid: row.policy_uuid, sync_version: Number(row.sync_version || 0), enabled: Number(row.enabled), deleted_at: row.deleted_at == null ? null : row.deleted_at };
}

async function lifecycleBindingTx(tx, { deviceEui, generation, zone, policy, retiredSchedules, liveSchedules } = {}) {
  const eui = String(deviceEui || '').toUpperCase();
  const deviceRow = await tx.get('SELECT id, deveui, type_id, user_id, irrigation_zone_id, deleted_at FROM devices WHERE UPPER(deveui)=UPPER(?)', [eui]);
  if (!deviceRow || deviceRow.type_id !== 'STREGA_VALVE') throw Object.assign(new Error('lifecycle_binding_missing'), { code: 'lifecycle_binding_missing' });
  const settings = await store.getSettings(tx, eui);
  const gen = generation || settings.strega_generation || 'GEN1';
  if (!['GEN1', 'GEN2'].includes(gen)) throw Object.assign(new Error('invalid_generation'), { code: 'invalid_generation' });
  const zoneId = deviceRow.irrigation_zone_id;
  const zoneRow = zoneId == null ? null : await tx.get('SELECT zone_uuid, sync_version, deleted_at FROM irrigation_zones WHERE id=?', [zoneId]);
  const retiredInput = Array.isArray(retiredSchedules) ? retiredSchedules : [];
  if (retiredInput.some((row) => !row || typeof row.schedule_uuid !== 'string' || !row.schedule_uuid.trim())) {
    throw Object.assign(new Error('lifecycle_binding_malformed'), { code: 'lifecycle_binding_malformed' });
  }
  const retiredIds = retiredInput.map((row) => row && row.schedule_uuid).filter(Boolean);
  if (retiredIds.length !== new Set(retiredIds).size) {
    throw Object.assign(new Error('lifecycle_binding_malformed'), { code: 'lifecycle_binding_malformed' });
  }
  const retiredRows = retiredIds.length
    ? await tx.all('SELECT schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, fire_at, duration_minutes, timezone, enabled, once_state, once_fired_at, sync_version, deleted_at, condition_policy_uuid, effective_from FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND schedule_uuid IN (' + retiredIds.map(() => '?').join(',') + ')', [eui].concat(retiredIds))
    : [];
  if (retiredRows.length !== new Set(retiredIds).size) {
    throw Object.assign(new Error('lifecycle_binding_missing'), { code: 'lifecycle_binding_missing' });
  }
  const retiredById = new Map(retiredRows.map((row) => [row.schedule_uuid, row]));
  const retired = retiredIds.map((id) => retiredById.get(id)).filter(Boolean).map(lifecycleScheduleSnapshot).sort(lifecycleScheduleSort);
  const policyId = policy && policy.policy_uuid
    || retired.find((row) => row.condition_policy_uuid && row.condition_policy_uuid.length) && retired.find((row) => row.condition_policy_uuid && row.condition_policy_uuid.length).condition_policy_uuid;
  const policyRow = policyId ? await tx.get('SELECT policy_uuid, sync_version, enabled, deleted_at FROM irrigation_policies WHERE policy_uuid=?', [policyId]) : null;
  const liveRows = liveSchedules === undefined
    ? await store.listSchedules(tx, eui)
    : liveSchedules;
  const live = (liveRows || []).map(lifecycleScheduleSnapshot).sort(lifecycleScheduleSort);
  return {
    device: lifecycleDevice(deviceRow),
    generation: gen,
    zone: lifecycleZone(zoneRow),
    policy: lifecyclePolicy(policyRow),
    retired_schedules: retired,
    live_schedule_snapshot: live,
  };
}

function lifecycleBindingEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function currentLifecycleBindingTx(tx, lifecycle) {
  if (!lifecycle || !lifecycle.device) return null;
  return lifecycleBindingTx(tx, {
    deviceEui: lifecycle.device.device_eui,
    // Read the current generation from valve_settings. Passing the captured
    // generation here would make a settings change invisible to the sender's
    // fence; the persisted value is the expected binding, not a query override.
    zone: lifecycle.zone,
    policy: lifecycle.policy,
    retiredSchedules: lifecycle.retired_schedules,
    liveSchedules: undefined,
  });
}

async function lifecycleBindingMatchesTx(tx, lifecycle) {
  const current = await currentLifecycleBindingTx(tx, lifecycle);
  return Boolean(current && lifecycleBindingEqual(current, {
    device: lifecycle.device,
    generation: lifecycle.generation,
    zone: lifecycle.zone,
    policy: lifecycle.policy,
    retired_schedules: lifecycle.retired_schedules,
    live_schedule_snapshot: current.live_schedule_snapshot,
  }) && lifecycleBindingEqual(current.live_schedule_snapshot, lifecycle.live_schedule_snapshot));
}

async function supersedeLifecycleAuthorityTx(tx, deviceEui, revision, reason, now) {
  const eui = String(deviceEui).toUpperCase();
  const row = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [eui]);
  const control = store.parseControl(row && row.conditional_control_json);
  if (control.mode !== 'LIFECYCLE_CLEAR' || (revision && control.desired_revision !== revision) || !control.lifecycle_clear) return false;
  const next = {
    ...control,
    mode: 'FIXED', desired_revision: null, required_push_ids: [], predecessor_push_ids: [],
    readiness: { state: 'INVALID', reason: 'lifecycle_clear_superseded' },
    lifecycle_clear: { ...control.lifecycle_clear, state: 'SUPERSEDED', superseded_at: now instanceof Date ? now.toISOString() : (now || new Date().toISOString()), superseded_reason: reason || 'binding_changed' },
  };
  await store.writeConditionalControl(tx, eui, next);
  return true;
}

// SQLite-only invalidation seam for lifecycle adapters. Callers must hold the valve
// writer and invoke it in the same transaction as the stable binding mutation.
async function invalidateLifecycleClearTx(tx, deviceEui, { revision, reason = 'binding_changed', now } = {}) {
  return supersedeLifecycleAuthorityTx(tx, deviceEui, revision, reason, now);
}

function lifecycleTransportMarker(revision) {
  return { lifecycle_clear_revision: revision };
}

function lifecycleMarker(row) {
  if (!row || !row.transport_json) return null;
  try {
    const parsed = typeof row.transport_json === 'string' ? JSON.parse(row.transport_json) : row.transport_json;
    return parsed && typeof parsed === 'object' && typeof parsed.lifecycle_clear_revision === 'string' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function lifecycleRowProvablyUnattempted(row) {
  const evidence = transportEvidence(row);
  return row && row.state === 'QUEUED' && !evidence.malformed && evidence.phase == null;
}

async function prepareLifecycleClearRevisionTx(tx, { deviceEui, generation, reason = 'lifecycle_clear', now, zone, policy, retiredSchedules, liveSchedules, force = true } = {}) {
  const eui = String(deviceEui || '').toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(eui)) throw Object.assign(new Error('invalid_device_eui'), { code: 'invalid_device_eui' });
  const binding = await lifecycleBindingTx(tx, { deviceEui: eui, generation, zone, policy, retiredSchedules, liveSchedules });
  const old = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [eui]);
  const control = store.parseControl(old && old.conditional_control_json);
  const predecessorRows = await tx.all("SELECT push_id, state, transport_json FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN','SCHEDULER_STATUS') AND state <> 'ACKED' ORDER BY rowid", [eui]);
  const predecessor_push_ids = predecessorRows.map((row) => row.push_id);
  for (const row of predecessorRows) {
    if (lifecycleRowProvablyUnattempted(row)) await tx.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE push_id=? AND state='QUEUED'", [row.push_id]);
  }
  // Design C: a fixed snapshot still waiting out its debounce window was never attempted, so its
  // rows were superseded above; the lifecycle clear owns the plan from here.
  await store.clearSnapshotPending(tx, eui);
  const revision = crypto.randomUUID();
  const rows = clearPlanPushes(binding.generation).map((p) => toRow(eui, { ...p, transport_json: lifecycleTransportMarker(revision) }));
  for (const row of rows) await store.insertPushes(tx, [row]);
  const preparedAt = now instanceof Date ? now.toISOString() : (now || new Date().toISOString());
  const lifecycle_clear = { v: 1, revision, state: 'PENDING', reason, prepared_at: preparedAt,
    device: binding.device, generation: binding.generation, zone: binding.zone, policy: binding.policy,
    retired_schedules: binding.retired_schedules, live_schedule_snapshot: binding.live_schedule_snapshot };
  const next = { ...control, mode: 'LIFECYCLE_CLEAR', generation: binding.generation, desired_revision: revision,
    required_push_ids: rows.map((row) => row.push_id), predecessor_push_ids,
    readiness: { state: 'PENDING', revision, reason: 'awaiting_clear_ack' }, prepared_at: preparedAt, reason,
    lifecycle_clear };
  await store.writeConditionalControl(tx, eui, next);
  return { revision, generation: binding.generation, required_push_ids: next.required_push_ids, predecessor_push_ids,
    rows, mode: 'LIFECYCLE_CLEAR', force, lifecycle_clear };
}

// Caller-owned transaction seam. It performs only SQLite work; no writer, network,
// timer, or Node-RED interaction is allowed here.
async function prepareClearRevisionTx(tx, { deviceEui, generation, schedules, now, reason = 'conversion', force = true } = {}) {
  const eui = String(deviceEui || '').toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(eui)) throw Object.assign(new Error('invalid_device_eui'), { code: 'invalid_device_eui' });
  const currentSchedules = schedules || await store.listSchedules(tx, eui);
  const mode = P.validateScheduleModes(currentSchedules, await store.listPoliciesForSchedules(tx, currentSchedules));
  if (!mode.ok) throw Object.assign(new Error('mixed_schedule_mode'), { code: mode.code, statusCode: mode.status, details: mode });
  const settings = await store.getSettings(tx, eui);
  const gen = generation || settings.strega_generation || 'GEN1';
  if (!['GEN1', 'GEN2'].includes(gen)) throw Object.assign(new Error('invalid_generation'), { code: 'invalid_generation' });
  const old = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [eui]);
  const control = store.parseControl(old && old.conditional_control_json);
  const predecessorRows = await tx.all("SELECT push_id, state FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN','SCHEDULER_STATUS') AND state <> 'ACKED' ORDER BY rowid", [eui]);
  const predecessor_push_ids = predecessorRows.map((r) => r.push_id);
  await tx.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN','SCHEDULER_STATUS') AND state='QUEUED'", [eui]);
  // Design C: the conditional clear replaces every slot, so a fixed snapshot still waiting out
  // its debounce window is obsolete (its rows were just superseded above).
  await store.clearSnapshotPending(tx, eui);
  const revision = crypto.randomUUID();
  const pushes = clearPlanPushes(gen);
  const rows = pushes.map((p) => toRow(eui, p));
  for (const row of rows) await store.insertPushes(tx, [row]);
  const next = { ...control, mode: 'CONDITIONAL', generation: gen, desired_revision: revision,
    required_push_ids: rows.map((r) => r.push_id), predecessor_push_ids,
    readiness: { state: 'PENDING', revision, reason: 'awaiting_clear_ack' },
    prepared_at: now instanceof Date ? now.toISOString() : (now || new Date().toISOString()), reason };
  if (reason === 'retry' && next.incident) {
    next.incident = { ...store.parseIncident(next.incident), retry_revision: revision };
  }
  await store.writeConditionalControl(tx, eui, next);
  return { revision, generation: gen, required_push_ids: next.required_push_ids, predecessor_push_ids, rows, mode: mode.mode, force };
}

async function prepareClearRevision({ db, ...options } = {}) {
  return db.transaction((tx) => prepareClearRevisionTx(tx, options));
}

async function conditionalReadinessTx(db, deviceEui) {
  const control = await store.conditionalControl(db, deviceEui);
  const settings = await store.getSettings(db, deviceEui);
  const revision = control.desired_revision || null;
  const required = Array.isArray(control.required_push_ids) ? control.required_push_ids : [];
  if (!revision || !required.length) return { state: 'PENDING', ready: false, revision, required_push_ids: required, reason: 'no_current_revision' };
  if (control.generation && control.generation !== settings.strega_generation) {
    return { state: 'PENDING', ready: false, revision, required_push_ids: required, reason: 'generation_mismatch', generation: control.generation, current_generation: settings.strega_generation };
  }
  const placeholders = required.map(() => '?').join(',');
  const rows = await db.all('SELECT push_id,device_eui,state,ack_status,acked_at FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND push_id IN (' + placeholders + ')', [deviceEui].concat(required));
  if (rows.length !== required.length) {
    return { state: 'PENDING', ready: false, revision, required_push_ids: required,
      missing_push_ids: required.filter((id) => !rows.some((row) => row.push_id === id)), reason: 'invalid_required_push_set' };
  }
  const byId = new Map(rows.map((r) => [r.push_id, r]));
  const missing = required.filter((id) => !byId.has(id) || byId.get(id).state !== 'ACKED');
  const predecessors = Array.isArray(control.predecessor_push_ids) ? control.predecessor_push_ids : [];
  const predRows = predecessors.length ? await db.all('SELECT push_id,state FROM valve_schedule_pushes WHERE push_id IN (' + predecessors.map(() => '?').join(',') + ')', predecessors) : [];
  const predMissing = predRows.filter((r) => !['ACKED', 'SUPERSEDED'].includes(r.state)).map((r) => r.push_id);
  if (missing.length) return { state: 'PENDING', ready: false, revision, required_push_ids: required, missing_push_ids: missing, blocking_predecessor_push_ids: predMissing, reason: 'awaiting_clear_ack' };
  const readyControl = { ...control, readiness: { state: 'READY', revision, reason: 'all_current_clear_acked' } };
  const persisted = await store.writeConditionalControlIfRevisionTx(db, deviceEui, revision, readyControl);
  if (!persisted) return { state: 'PENDING', ready: false, persisted: false, revision, required_push_ids: required, reason: 'revision_changed' };
  return { state: 'READY', ready: true, persisted: true, revision, required_push_ids: required, blocking_predecessor_push_ids: [], reason: 'all_current_clear_acked' };
}

async function conditionalReadiness(db, deviceEui) {
  if (typeof db.transaction === 'function') return db.transaction((tx) => conditionalReadinessTx(tx, deviceEui));
  return conditionalReadinessTx(db, deviceEui);
}

const RETRYABLE_RECONCILIATION_ERRORS = new Set([
  'enqueue_failed', 'enqueue_failed_before_acceptance', 'enqueue_rejected',
  'flush_failed', 'no_ack_24h', 'transport_failed', 'transport_uncertain',
]);

function pendingFixedGenerationTransition(control, generation) {
  const transition = control && control.fixed_generation_transition;
  return Boolean(transition
    && transition.state === 'PENDING'
    && transition.from === 'GEN1'
    && transition.to === generation
    && typeof transition.transition_id === 'string'
    && transition.transition_id.length > 0);
}

function transportEvidence(row) {
  if (!row || row.transport_json == null || row.transport_json === '') return { phase: null, state: null, malformed: false };
  try {
    const state = JSON.parse(row.transport_json);
    if (state && typeof state === 'object' && !Array.isArray(state)
        && typeof state.lifecycle_clear_revision === 'string' && state.phase == null) {
      return { phase: null, state, malformed: false };
    }
    if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.phase !== 'string') {
      return { phase: null, state: null, malformed: true };
    }
    if (!['INTENT', 'ATTEMPTED', 'ACCEPTED', 'UNKNOWN', 'enqueue_failed_before_acceptance', 'enqueue_rejected'].includes(state.phase)) {
      return { phase: state.phase, state, malformed: true };
    }
    return { phase: state.phase, state, malformed: false };
  } catch (_) {
    return { phase: null, state: null, malformed: true };
  }
}

function transportUncertain(row) {
  const evidence = transportEvidence(row);
  return evidence.malformed || ['INTENT', 'ATTEMPTED', 'ACCEPTED', 'UNKNOWN'].includes(evidence.phase)
    || (evidence.phase == null && row && row.state !== 'QUEUED');
}

function terminalAckFailure(row) {
  return ['negative_ack', 'malformed_ack', 'ack_protocol_unverified'].includes(String(row && row.error || ''));
}

function exactIds(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((id, index) => id === right[index]);
}

async function requiredPushRows(db, deviceEui, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = await db.all('SELECT * FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND push_id IN (' + ids.map(() => '?').join(',') + ')', [deviceEui].concat(ids));
  const byId = new Map(rows.map((row) => [row.push_id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function transitionPrepared(control) {
  const transition = control && control.fixed_generation_transition;
  const ids = transition && transition.required_push_ids;
  return Boolean(transition && typeof transition.plan_revision === 'string' && transition.plan_revision
    && Array.isArray(ids) && ids.length);
}

function resolvedClockTimezone(schedules, fallback) {
  const tzSchedule = (schedules || []).find((s) => s && s.kind === 'WEEKLY' && !s.deleted_at && Number(s.enabled) && s.timezone)
    || (schedules || []).find((s) => s && s.timezone);
  return String((tzSchedule && tzSchedule.timezone) || fallback || 'UTC');
}

function fixedScheduleSnapshot(schedules, clockTimezone) {
  return { schedules: (schedules || []).filter((s) => s && s.kind === 'WEEKLY' && !s.deleted_at && Number(s.enabled))
    .map((s) => ({ schedule_uuid: s.schedule_uuid, kind: s.kind, weekdays_mask: s.weekdays_mask,
      start_time: s.start_time, duration_minutes: s.duration_minutes, timezone: s.timezone,
      enabled: Number(s.enabled), effective_from: s.effective_from || null, condition_policy_uuid: s.condition_policy_uuid || null }))
    .sort((a, b) => String(a.schedule_uuid).localeCompare(String(b.schedule_uuid))), clock_timezone: String(clockTimezone || 'UTC') };
}

function sameFixedScheduleSnapshot(transition, schedules, timeZoneFallback) {
  return transition && transition.source_schedule_snapshot && !Array.isArray(transition.source_schedule_snapshot)
    && JSON.stringify(transition.source_schedule_snapshot) === JSON.stringify(fixedScheduleSnapshot(schedules, resolvedClockTimezone(schedules, timeZoneFallback)));
}

async function supersedeFixedTransition(db, deviceEui, reason, now) {
  const eui = String(deviceEui).toUpperCase();
  const apply = async (tx) => {
    const row = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [eui]);
    const control = store.parseControl(row && row.conditional_control_json);
    const transition = control.fixed_generation_transition;
    if (!pendingFixedGenerationTransition(control, 'GEN2')) return false;
    const next = { ...control, fixed_generation_transition: { ...transition, state: 'SUPERSEDED', superseded_at: now instanceof Date ? now.toISOString() : (now || new Date().toISOString()), superseded_reason: reason } };
    await store.writeConditionalControl(tx, eui, next);
    return true;
  };
  return typeof db.transaction === 'function' ? db.transaction(apply) : apply(db);
}

// The uplink worker records a GEN1->GEN2 promotion before it returns.  Preparation
// below binds the transition to one plan revision and one exact owner set before
// any ChirpStack call.  Completion requires the caller's original binding; a
// current-value reread cannot be used as proof for an older result.
async function markGenerationTransitionApplied(db, deviceEui, { generation = 'GEN2', compiledGeneration, transitionId, planRevision, requiredPushIds, now } = {}) {
  const target = String(generation || '').toUpperCase();
  if (target !== 'GEN2') return false;
  if (compiledGeneration != null && String(compiledGeneration).toUpperCase() !== target) return false;
  if (!transitionId || !planRevision || !Array.isArray(requiredPushIds) || !requiredPushIds.length) return false;
  const eui = String(deviceEui || '').toUpperCase();
  return dispatch.withValveWriter(eui, () => db.transaction(async (tx) => {
    const row = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [eui]);
    const control = store.parseControl(row && row.conditional_control_json);
    const transition = control.fixed_generation_transition;
    if (!pendingFixedGenerationTransition(control, target)
        || transition.transition_id !== transitionId
        || transition.plan_revision !== planRevision
        || !exactIds(transition.required_push_ids, requiredPushIds)) return false;
    const appliedAt = now instanceof Date ? now.toISOString() : (now || new Date().toISOString());
    const next = { ...control, fixed_generation_transition: { ...transition, state: 'APPLIED', applied_at: appliedAt } };
    const raw = row && row.conditional_control_json;
    if (raw == null) return false;
    const nextRaw = JSON.stringify(next);
    await tx.run('UPDATE valve_settings SET conditional_control_json=?, updated_at=datetime(\'now\') WHERE UPPER(device_eui)=UPPER(?) AND conditional_control_json=?', [nextRaw, eui, raw]);
    const after = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [eui]);
    return !!after && after.conditional_control_json === nextRaw;
  }));
}

async function prepareFixedGenerationTransitionLocked({ db, deviceEui, now, timeZoneFallback } = {}) {
  const eui = String(deviceEui || '').toUpperCase();
  const before = await store.conditionalControl(db, eui);
  const transition = before.fixed_generation_transition;
  if (!pendingFixedGenerationTransition(before, 'GEN2')) return { pending: false, generation: 'GEN2', rows: [], messages: [] };
  if (transitionPrepared(before)) {
    const schedules = await store.listSchedules(db, eui);
    if (!sameFixedScheduleSnapshot(transition, schedules, timeZoneFallback)) {
      await supersedeFixedTransition(db, eui, 'source_schedule_changed', now);
      return { pending: true, superseded: true, generation: 'GEN2', transition_id: transition.transition_id, rows: [], messages: [] };
    }
    const rows = await requiredPushRows(db, eui, transition.required_push_ids);
    if (rows.length !== transition.required_push_ids.length) {
      return { pending: true, invalidPreparedSet: true, generation: 'GEN2', transition_id: transition.transition_id,
        plan_revision: transition.plan_revision, required_push_ids: transition.required_push_ids, rows: [] };
    }
    return { pending: true, prepared: true, generation: 'GEN2', transition_id: transition.transition_id,
      plan_revision: transition.plan_revision, required_push_ids: transition.required_push_ids, rows,
      source_schedule_snapshot: transition.source_schedule_snapshot };
  }
  // A half-written binding is not a reason to compile again.  The initial marker
  // has neither field; any one-sided metadata is treated as unrecoverable until a
  // human/explicit retry repairs it, preserving the audit trail.
  if (transition.plan_revision != null || transition.required_push_ids != null) {
    return { pending: true, invalidPreparedSet: true, generation: 'GEN2', transition_id: transition.transition_id,
      plan_revision: transition.plan_revision || null, required_push_ids: transition.required_push_ids || [], rows: [] };
  }
  return db.transaction(async (tx) => {
    const control = await store.conditionalControl(tx, eui);
    const current = control.fixed_generation_transition;
    if (!pendingFixedGenerationTransition(control, 'GEN2')) return { pending: false, generation: 'GEN2', rows: [], messages: [] };
    if (transitionPrepared(control) || current.plan_revision != null || current.required_push_ids != null) {
      return prepareFixedGenerationTransitionLocked({ db: tx, deviceEui: eui, now, timeZoneFallback });
    }
    const schedules = await store.listSchedules(tx, eui);
    const mode = P.validateScheduleModes(schedules, await store.listPoliciesForSchedules(tx, schedules));
    if (!mode.ok) {
      const err = new Error(mode.code || 'mixed_schedule_mode'); err.statusCode = mode.status || 409; err.code = mode.code || 'mixed_schedule_mode'; err.details = mode; throw err;
    }
    if (mode.mode !== 'FIXED') return { pending: true, invalidPreparedSet: true, generation: 'GEN2', transition_id: current.transition_id, rows: [] };
    const compiled = P.compileWindows(schedules);
    if (compiled.errors.length) {
      const err = new Error('plan_conflict'); err.statusCode = 422; err.code = 'plan_conflict'; err.details = compiled.errors; throw err;
    }
    // Design C: the transition writes the full GEN2 snapshot (status first, every weekday covered,
    // empty days as explicit clears) and supersedes every outstanding plan/status row of either
    // generation. Its bound GEN2 CLOCK_SYNC is the clock-request frame ('01'), not a time value,
    // so it carries no stale clock; it stays bound to the transition's required set. A pending
    // fixed snapshot is obsolete once the transition owns the plan.
    const transitionSettings = await store.getSettings(tx, eui);
    const pushes = buildSnapshotPushes({ generation: 'GEN2', days: compiled.days, schedulerStatus: transitionSettings.scheduler_status,
      includePlan: true, gen2ClearPrefix: await gen2ClearPrefixEnabled(tx) });
    const clockTimezone = resolvedClockTimezone(schedules, timeZoneFallback);
    pushes.push(buildClockPush('GEN2', now || new Date(), clockTimezone));
    const rows = pushes.map((p) => toRow(eui, p));
    await store.supersedeOutstanding(tx, eui, SNAPSHOT_PURPOSES);
    await store.clearSnapshotPending(tx, eui);
    await store.insertPushes(tx, rows);
    const planRevision = crypto.randomUUID();
    const preparedAt = now instanceof Date ? now.toISOString() : (now || new Date().toISOString());
    const next = { ...control, fixed_generation_transition: {
      ...current, plan_revision: planRevision, required_push_ids: rows.map((row) => row.push_id), prepared_at: preparedAt,
      source_schedule_snapshot: fixedScheduleSnapshot(schedules, clockTimezone),
    } };
    await store.writeConditionalControl(tx, eui, next);
    await store.upsertSettings(tx, eui, { last_clock_sync_queued_at: preparedAt });
    return { pending: true, prepared: true, generation: 'GEN2', transition_id: current.transition_id,
      plan_revision: planRevision, required_push_ids: next.fixed_generation_transition.required_push_ids, rows,
      source_schedule_snapshot: next.fixed_generation_transition.source_schedule_snapshot,
      compiled: { days: compiled.days, errors: [] } };
  });
}

async function prepareFixedGenerationTransition({ db, deviceEui, now, timeZoneFallback } = {}) {
  const eui = String(deviceEui || '').toUpperCase();
  return dispatch.withValveWriter(eui, () => prepareFixedGenerationTransitionLocked({ db, deviceEui: eui, now, timeZoneFallback }));
}

async function conditionalReconciliationNeeded(db, deviceEui, { profileId, generationProfileId, now } = {}) {
  const settings = await store.getSettings(db, deviceEui);
  if (settings.strega_generation !== 'GEN2') return false;
  const schedules = await store.listSchedules(db, deviceEui);
  const mode = P.validateScheduleModes(schedules, await store.listPoliciesForSchedules(db, schedules));
  if (!mode.ok) return false;
  const control = await store.conditionalControl(db, deviceEui);
  if (mode.mode === 'FIXED' && pendingFixedGenerationTransition(control, 'GEN2')) {
    // This is a SQLite-only prepare, deliberately before the profile swap or any
    // queue I/O.  A matching or mismatching profile therefore recovers one exact set.
    if (typeof db.transaction === 'function') await prepareFixedGenerationTransition({ db, deviceEui, now: now || new Date() });
    return true;
  }
  if (generationProfileId && String(profileId || '') !== String(generationProfileId)) return true;
  if (mode.mode !== 'CONDITIONAL') return false;
  if (control.mode !== 'CONDITIONAL' || control.generation !== 'GEN2' || !control.desired_revision) return true;
  const readiness = control.readiness || {};
  if (readiness.state === 'READY') return false;
  const required = Array.isArray(control.required_push_ids) ? control.required_push_ids : [];
  if (!required.length) return true;
  const rows = await db.all('SELECT push_id,device_eui,state,error,transport_json FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND push_id IN (' + required.map(() => '?').join(',') + ')', [deviceEui].concat(required));
  if (rows.length !== required.length) return false;
  const byId = new Map(rows.map((row) => [row.push_id, row]));
  // A terminal device ACK blocks the whole current revision.  Automatic
  // reconciliation must not enqueue the remaining members around it; the
  // explicit retry path creates the next revision as one coherent set.
  if (rows.some((row) => terminalAckFailure(row))) return false;
  return required.some((id) => {
    const row = byId.get(id);
    if (!row) return true;
    const evidence = transportEvidence(row);
    // Transport evidence wins over stale/ambiguous labels.  This remains
    // actionable only so the sender can inspect/reuse the current set; it never
    // authorizes a new revision or a second one-shot send.
    if (evidence.malformed || ['INTENT', 'ATTEMPTED', 'ACCEPTED', 'UNKNOWN'].includes(evidence.phase)) return true;
    if (evidence.phase === 'enqueue_failed_before_acceptance' || evidence.phase === 'enqueue_rejected') return true;
    if (row.state === 'FAILED') return RETRYABLE_RECONCILIATION_ERRORS.has(String(row.error || ''));
    if (row.state !== 'QUEUED') return false;
    return evidence.phase == null;
  });
}

async function sendPreparedRevision({ db, deviceEui, revision, transport, now, warn } = {}) {
  const eui = String(deviceEui).toUpperCase();
  return dispatch.withValveWriter(eui, async () => {
    const control = await store.conditionalControl(db, eui);
    if (!revision || control.desired_revision !== revision) return { obsolete: true, sent: 0 };
    const schedules = await store.listSchedules(db, eui);
    const mode = P.validateScheduleModes(schedules, await store.listPoliciesForSchedules(db, schedules));
    if (!mode.ok || mode.mode !== 'CONDITIONAL') return { obsolete: true, sent: 0, mode: mode.mode };
    const ids = Array.isArray(control.required_push_ids) ? control.required_push_ids : [];
    if (!ids.length) return { obsolete: true, sent: 0 };
    if (!transport) throw Object.assign(new Error('transport_required'), { code: 'transport_required' });
    const rows = await db.all('SELECT * FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND push_id IN (' + ids.map(() => '?').join(',') + ') ORDER BY rowid', [eui].concat(ids));
    if (rows.length !== ids.length) {
      return { sent: 0, invalidRequiredSet: true, readiness: { state: 'BLOCKED', revision, reason: 'invalid_required_push_set' }, required_push_ids: ids };
    }
    const predecessorIds = new Set(Array.isArray(control.predecessor_push_ids) ? control.predecessor_push_ids : []);
    const conflict = await db.transaction((tx) => dispatch.findValveConflictTx(tx, eui, revision, now || new Date(), { reconciledPushIds: predecessorIds }));
    if (conflict) {
      const blocked = { ...await store.conditionalControl(db, eui), readiness: { state: 'BLOCKED', revision, reason: 'active_conflict', command_id: conflict.command_id || null } };
      const persisted = await store.writeConditionalControlIfRevision(db, eui, revision, blocked);
      return { sent: 0, blocked: true, casLost: !persisted, conflict, readiness: blocked.readiness };
    }
    const uncertain = rows.some((row) => transportUncertain(row));
    // A live OPEN_FOR_DURATION owner keeps the remote queue intact while the
    // conditional clear is recorded and sent; only an empty observation window
    // authorizes the destructive flush.  An attempted/accepted/unknown or
    // malformed owner is another independent no-flush fence: its queue outcome
    // is not disproved by a stale ledger label.
    const pendingObservation = await dispatch.hasBlockingObservation(db, eui);
    const flush = pendingObservation || uncertain
      ? { ok: true, phase: pendingObservation ? 'SKIPPED_PENDING_OBSERVATION' : 'SKIPPED_UNCERTAIN_TRANSPORT', skipped: true }
      : await dispatch.flushValveQueue({ db, deviceEui: eui, reason: 'conditional_clear', transport, now });
    // R3-M2: a clock sync this flush killed is SUPERSEDED and the clock tick re-armed.
    if (flush && flush.flush_id) await store.supersedeFlushedClock(db, eui, flush.flush_id);
    if (!flush || flush.ok !== true) {
      const latest = await store.conditionalControl(db, eui);
      const failed = { ...latest, readiness: { state: 'FAILED', revision, reason: 'flush_failed' }, flush_failure: flush && { phase: flush.phase, error: String(flush.error && flush.error.message || flush.error || '') } };
      const persisted = await store.writeConditionalControlIfRevision(db, eui, revision, failed);
      return { sent: 0, casLost: !persisted, flush, readiness: failed.readiness };
    }
    const results = [];
    for (const row of rows) {
      if (transportUncertain(row) || row.state === 'ACKED' || terminalAckFailure(row)) continue;
      const current = await store.conditionalControl(db, eui);
      if (current.desired_revision !== revision) return { obsolete: true, sent: results.length };
      const result = await dispatch.enqueueValveCommand({ db, deviceEui: eui, owner: { type: 'push', id: row.push_id }, item: { devEui: eui, fPort: Number(row.fport), data: Buffer.from(row.payload_hex, 'hex').toString('base64'), confirmed: false }, transport, now });
      results.push({ push_id: row.push_id, ...result });
    }
    const latest = await store.conditionalControl(db, eui);
    const failed = results.find((r) => r.phase && !['ACCEPTED', 'UNKNOWN'].includes(r.phase));
    latest.readiness = { state: failed ? 'FAILED' : 'PENDING', revision, reason: failed ? 'enqueue_failed' : 'awaiting_clear_ack' };
    if (!(await store.writeConditionalControlIfRevision(db, eui, revision, latest))) return { obsolete: true, sent: results.length, results };
    return { sent: results.length, flush, results, readiness: latest.readiness };
  });
}

function lifecycleFlushIntent(control) {
  const flushes = Array.isArray(control && control.flushes) ? control.flushes : [];
  return [...flushes].reverse().find((entry) => entry && entry.flush_id && entry.result_status !== 'COMPLETE' && entry.status !== 'COMPLETE') || null;
}

async function lifecycleRows(db, deviceEui, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = await db.all('SELECT * FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND push_id IN (' + ids.map(() => '?').join(',') + ')', [deviceEui].concat(ids));
  const byId = new Map(rows.map((row) => [row.push_id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function lifecycleStateTx(tx, deviceEui, revision) {
  const eui = String(deviceEui).toUpperCase();
  const controlRow = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [eui]);
  const control = store.parseControl(controlRow && controlRow.conditional_control_json);
  const lifecycle = control.lifecycle_clear;
  const ids = Array.isArray(control.required_push_ids) ? control.required_push_ids : [];
  const authoritative = control.mode === 'LIFECYCLE_CLEAR'
    && Boolean(revision)
    && control.desired_revision === revision
    && lifecycle
    && lifecycle.revision === revision
    && lifecycle.state !== 'SUPERSEDED';
  if (!authoritative || !ids.length) return { control, lifecycle, ids, rows: [], authoritative, bindingValid: false, rowsValid: false };
  const bindingValid = await lifecycleBindingMatchesTx(tx, lifecycle);
  const selected = await tx.all('SELECT * FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND push_id IN (' + ids.map(() => '?').join(',') + ')', [eui].concat(ids));
  const byId = new Map(selected.map((row) => [row.push_id, row]));
  const rows = ids.map((id) => byId.get(id)).filter(Boolean);
  const rowsValid = rows.length === ids.length
    && rows.every((row) => lifecycleMarker(row)?.lifecycle_clear_revision === revision);
  return { control, lifecycle, ids, rows, authoritative, bindingValid, rowsValid };
}

async function markLifecycleObsolete(db, deviceEui, revision, reason, now) {
  const eui = String(deviceEui).toUpperCase();
  return db.transaction((tx) => supersedeLifecycleAuthorityTx(tx, eui, revision, reason, now));
}

async function sendPreparedLifecycleClearLocked({ db, deviceEui, revision, transport, now, warn } = {}) {
  const eui = String(deviceEui).toUpperCase();
  const initial = await db.transaction((tx) => lifecycleStateTx(tx, eui, revision));
  const control = initial.control;
  const lifecycle = initial.lifecycle;
  if (!initial.authoritative) {
    return { obsolete: true, sent: 0, revision };
  }
  const ids = initial.ids;
  if (!ids.length) return { obsolete: true, sent: 0, revision };
  if (!transport) throw Object.assign(new Error('transport_required'), { code: 'transport_required' });
  if (!initial.bindingValid) {
    await markLifecycleObsolete(db, eui, revision, 'binding_changed', now);
    const staleRows = await lifecycleRows(db, eui, ids);
    for (const row of staleRows) if (lifecycleRowProvablyUnattempted(row)) await db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE push_id=? AND state='QUEUED'", [row.push_id]);
    return { obsolete: true, sent: 0, revision };
  }
  if (!initial.rowsValid) {
    await markLifecycleObsolete(db, eui, revision, 'required_push_set_changed', now);
    for (const row of initial.rows) if (lifecycleRowProvablyUnattempted(row)) await db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE push_id=? AND state='QUEUED'", [row.push_id]);
    return { obsolete: true, sent: 0, revision, invalidRequiredSet: !initial.rowsValid };
  }
  const rows = initial.rows;
  const preacceptance = rows.some((row) => PREACCEPTANCE_PHASES.has(transportEvidence(row).phase));
  const predecessorIds = new Set(Array.isArray(control.predecessor_push_ids) ? control.predecessor_push_ids : []);
  for (const id of ids) predecessorIds.add(id);
  const conflict = await db.transaction((tx) => dispatch.findValveConflictTx(tx, eui, revision, now || new Date(), { reconciledPushIds: predecessorIds }));
  const uncertain = rows.some((row) => transportUncertain(row));
  const pendingObservation = await dispatch.hasBlockingObservation(db, eui);
  let flush;
  if (conflict || pendingObservation || uncertain) {
    flush = { ok: true, skipped: true, phase: conflict ? 'SKIPPED_ACTIVE_OWNER' : (pendingObservation ? 'SKIPPED_PENDING_OBSERVATION' : 'SKIPPED_UNCERTAIN_TRANSPORT'), conflict: conflict || null };
  } else {
    const unfinished = lifecycleFlushIntent(control);
    flush = unfinished
      ? await dispatch.recoverValveFlush({ db, deviceEui: eui, flushId: unfinished.flush_id, transport, now })
      : await dispatch.flushValveQueue({ db, deviceEui: eui, reason: 'lifecycle_clear', transport, now });
  }
  // R3-M2: a clock sync this flush killed is SUPERSEDED and the clock tick re-armed.
  if (flush && flush.flush_id) await store.supersedeFlushedClock(db, eui, flush.flush_id);
  if (!flush || flush.ok !== true) {
    const latest = await store.conditionalControl(db, eui);
    const failed = { ...latest, readiness: { state: 'FAILED', revision, reason: 'flush_failed' },
      flush_failure: flush && { flush_id: flush.flush_id || null, phase: flush.phase || 'UNKNOWN', error: String(flush.error && flush.error.message || flush.error || '') } };
    await store.writeConditionalControlIfRevision(db, eui, revision, failed);
    return { sent: 0, revision, flush, readiness: failed.readiness };
  }
  const results = [];
  for (const originalRow of rows) {
    const currentState = await db.transaction((tx) => lifecycleStateTx(tx, eui, revision));
    if (!currentState.authoritative) return { obsolete: true, sent: results.length, revision, results };
    if (!currentState.bindingValid || !currentState.rowsValid) {
      await markLifecycleObsolete(db, eui, revision, currentState.bindingValid ? 'required_push_set_changed' : 'binding_changed', now);
      for (const row of currentState.rows) if (lifecycleRowProvablyUnattempted(row)) await db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE push_id=? AND state='QUEUED'", [row.push_id]);
      return { obsolete: true, sent: results.length, revision, results, invalidRequiredSet: !currentState.rowsValid };
    }
    const row = currentState.rows.find((candidate) => candidate.push_id === originalRow.push_id) || originalRow;
    const evidence = transportEvidence(row);
    if (evidence.malformed || ['INTENT', 'ATTEMPTED', 'ACCEPTED', 'UNKNOWN'].includes(evidence.phase) || PREACCEPTANCE_PHASES.has(evidence.phase) || row.state === 'ACKED' || terminalAckFailure(row)) continue;
    const result = await dispatch.enqueueValveCommand({ db, deviceEui: eui, owner: { type: 'push', id: row.push_id },
      item: { devEui: eui, fPort: Number(row.fport), data: Buffer.from(row.payload_hex, 'hex').toString('base64'), confirmed: false }, transport, now });
    results.push({ push_id: row.push_id, ...result });
  }
  const latest = await store.conditionalControl(db, eui);
  const failed = results.find((r) => r.phase && !['ACCEPTED', 'UNKNOWN'].includes(r.phase))
    || (preacceptance ? { phase: 'enqueue_failed_before_acceptance' } : null);
  latest.readiness = { state: failed ? 'FAILED' : 'PENDING', revision, reason: failed ? 'enqueue_failed' : 'awaiting_clear_ack' };
  const persisted = await store.writeConditionalControlIfRevision(db, eui, revision, latest);
  if (!persisted) return { obsolete: true, sent: results.length, revision, results };
  return { sent: results.length, revision, rows, flush, results, readiness: latest.readiness, blocked: Boolean(conflict || pendingObservation) };
}

async function sendPreparedLifecycleClear({ db, deviceEui, revision, transport, now, warn } = {}) {
  const eui = String(deviceEui).toUpperCase();
  return dispatch.withValveWriter(eui, () => sendPreparedLifecycleClearLocked({ db, deviceEui: eui, revision, transport, now, warn }));
}

async function retryLifecycleClear({ db, deviceEui, transport, now, warn, ...options } = {}) {
  const eui = String(deviceEui).toUpperCase();
  return dispatch.withValveWriter(eui, async () => {
    const control = await store.conditionalControl(db, eui);
    if (control.mode !== 'LIFECYCLE_CLEAR' || !control.lifecycle_clear || !control.desired_revision) return { obsolete: true, sent: 0 };
    const valid = await db.transaction((tx) => lifecycleBindingMatchesTx(tx, control.lifecycle_clear));
    if (!valid) {
      await markLifecycleObsolete(db, eui, control.desired_revision, 'binding_changed', now);
      return { obsolete: true, sent: 0, revision: control.desired_revision };
    }
    const rows = await lifecycleRows(db, eui, control.required_push_ids);
    const preacceptance = rows.some((row) => PREACCEPTANCE_PHASES.has(transportEvidence(row).phase));
    if (preacceptance) {
      const binding = control.lifecycle_clear;
      const prepared = await db.transaction((tx) => prepareLifecycleClearRevisionTx(tx, {
        db, deviceEui: eui, generation: binding.generation, reason: 'retry', now,
        zone: binding.zone, policy: binding.policy, retiredSchedules: binding.retired_schedules,
        liveSchedules: undefined, force: true,
      }));
      const send = transport ? await sendPreparedLifecycleClearLocked({ db, deviceEui: eui, revision: prepared.revision, transport, now, warn }) : null;
      return Object.assign(prepared, { send });
    }
    const send = transport ? await sendPreparedLifecycleClearLocked({ db, deviceEui: eui, revision: control.desired_revision, transport, now, warn }) : null;
    return { revision: control.desired_revision, required_push_ids: control.required_push_ids || [], rows, send };
  });
}

async function retryClearRevision({ db, deviceEui, ...options } = {}) {
  const eui = String(deviceEui).toUpperCase();
  return dispatch.withValveWriter(eui, async () => {
    const prepared = await prepareClearRevision({ db, deviceEui: eui, ...options, reason: 'retry', force: true });
    if (options.transport) return Object.assign(prepared, { send: await sendPreparedRevision({ db, deviceEui: eui, revision: prepared.revision, ...options }) });
    return prepared;
  });
}

async function sendPreparedGenerationTransitionLocked({ db, deviceEui, prepared, transport, now, warn, timeZoneFallback } = {}) {
  if (!prepared || !prepared.prepared || !prepared.plan_revision || !prepared.transition_id || !Array.isArray(prepared.required_push_ids)) {
    return Object.assign({}, prepared || {}, { generation: 'GEN2', sent: null, complete: false, messages: [] });
  }
  const eui = String(deviceEui).toUpperCase();
  const schedules = await store.listSchedules(db, eui);
  if (!sameFixedScheduleSnapshot(prepared, schedules, timeZoneFallback)) {
    await supersedeFixedTransition(db, eui, 'source_schedule_changed', now);
    return { ...prepared, rows: [], complete: false, superseded: true, messages: [] };
  }
  const rows = await requiredPushRows(db, eui, prepared.required_push_ids);
  if (rows.length !== prepared.required_push_ids.length) return { ...prepared, rows: [], complete: false, invalidPreparedSet: true, messages: [] };
  if (!transport) return { ...prepared, rows, complete: false, messages: [] };
  const uncertain = rows.some((row) => transportUncertain(row));
  const pendingObservation = await dispatch.hasBlockingObservation(db, eui);
  const flush = pendingObservation || uncertain
    ? { ok: true, skipped: true, phase: pendingObservation ? 'SKIPPED_PENDING_OBSERVATION' : 'SKIPPED_UNCERTAIN_TRANSPORT' }
    : await dispatch.flushValveQueue({ db, deviceEui: eui, reason: 'fixed_generation_transition', transport, now });
  // R3-M2: a clock sync this flush killed is SUPERSEDED and the clock tick re-armed.
  if (flush && flush.flush_id) await store.supersedeFlushedClock(db, eui, flush.flush_id);
  if (!flush || flush.ok !== true) return { ...prepared, rows, flush, transportResults: [], complete: false, messages: [] };
  const transportResults = [];
  for (const row of rows) {
    if (row.state === 'ACKED' || terminalAckFailure(row) || transportUncertain(row)) continue;
    const result = await dispatch.enqueueValveCommand({
      db, deviceEui: eui, owner: { type: 'push', id: row.push_id },
      item: { devEui: eui, fPort: Number(row.fport), data: Buffer.from(row.payload_hex, 'hex').toString('base64'), confirmed: false },
      transport, now,
    });
    transportResults.push({ push_id: row.push_id, ...result });
  }
  const latest = await requiredPushRows(db, eui, prepared.required_push_ids);
  const complete = latest.length === prepared.required_push_ids.length && latest.every((row) => {
    if (row.state === 'ACKED') return true;
    const evidence = transportEvidence(row);
    return evidence.phase === 'ACCEPTED';
  });
  return { ...prepared, rows: latest, flush, transportResults, complete, messages: [] };
}

async function reconcileGenerationTransitionLocked({ db, deviceEui, appId, force, now, flushQueue, transport, warn, timeZoneFallback } = {}) {
  const eui = String(deviceEui).toUpperCase();
  const schedules = await store.listSchedules(db, eui);
  const mode = P.validateScheduleModes(schedules, await store.listPoliciesForSchedules(db, schedules));
  if (!mode.ok) {
    const err = new Error(mode.code || 'mixed_schedule_mode'); err.statusCode = mode.status || 409; err.code = mode.code || 'mixed_schedule_mode'; err.details = mode; throw err;
  }
  const settings = await store.getSettings(db, eui);
  const control = await store.conditionalControl(db, eui);
  if (mode.mode === 'FIXED' && pendingFixedGenerationTransition(control, 'GEN2')) {
    const prepared = await prepareFixedGenerationTransitionLocked({ db, deviceEui: eui, now, timeZoneFallback });
    return sendPreparedGenerationTransitionLocked({ db, deviceEui: eui, prepared, transport, now, warn, timeZoneFallback });
  }
  if (mode.mode === 'CONDITIONAL' && control.mode === 'CONDITIONAL' && control.generation === settings.strega_generation
      && control.desired_revision && Array.isArray(control.required_push_ids) && control.required_push_ids.length) {
    const sent = transport ? await sendPreparedRevision({ db, deviceEui: eui, revision: control.desired_revision, transport, now, warn }) : null;
    return { generation: settings.strega_generation, rows: await requiredPushRows(db, eui, control.required_push_ids), messages: [],
      revision: control.desired_revision, required_push_ids: control.required_push_ids, sent };
  }
  return compileAndQueueLocked({ db, deviceEui: eui, appId, force, now, flushQueue, transport, warn, timeZoneFallback });
}

async function reconcileGenerationTransition(options = {}) {
  const eui = String(options.deviceEui || '').toUpperCase();
  return dispatch.withValveWriter(eui, () => reconcileGenerationTransitionLocked(options));
}

// Task 5b's narrow handoff: only an observation owner with an exact physical
// run reference may mark an incident reconciled, and only while the requested
// clear revision is still current and every current clear row is ACKED.
async function finalizeConditionalIncidentTx(tx, deviceEui, { revision, physical_run_reference, ended_at, reconciled_at } = {}) {
  const controlRow = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [deviceEui]);
  const control = store.parseControl(controlRow && controlRow.conditional_control_json);
  if (!revision || control.desired_revision !== revision) throw Object.assign(new Error('conditional_revision_changed'), { code: 'conditional_revision_changed' });
  const incident = store.parseIncident(control.incident);
  if (!incident || incident.physical_run_reference !== physical_run_reference) throw Object.assign(new Error('conditional_incident_reference_mismatch'), { code: 'conditional_incident_reference_mismatch' });
  if (incident.retry_revision !== revision) throw Object.assign(new Error('conditional_incident_retry_required'), { code: 'conditional_incident_retry_required' });
  if (incident.ended !== true || incident.state !== 'ENDED' || typeof incident.ended_at !== 'string' || !Number.isFinite(store.parseAckInstant(incident.ended_at))
      || (ended_at != null && (typeof ended_at !== 'string' || ended_at !== incident.ended_at))
      || typeof reconciled_at !== 'string' || !Number.isFinite(store.parseAckInstant(reconciled_at))) {
    throw Object.assign(new Error('conditional_incident_evidence_required'), { code: 'conditional_incident_evidence_required' });
  }
  const required = Array.isArray(control.required_push_ids) ? control.required_push_ids : [];
  if (!required.length) throw Object.assign(new Error('conditional_clear_not_ready'), { code: 'conditional_clear_not_ready' });
  const rows = await tx.all('SELECT push_id,device_eui,state FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND push_id IN (' + required.map(() => '?').join(',') + ')', [deviceEui].concat(required));
  if (rows.length !== required.length || rows.some((row) => row.state !== 'ACKED')) throw Object.assign(new Error('conditional_clear_not_ready'), { code: 'conditional_clear_not_ready' });
  return store.updateConditionalIncidentTx(tx, deviceEui, { ended: true, ended_at: incident.ended_at, reconciled_at, state: 'RECONCILED' });
}

// ---------------------------------------------------------------------------------------------
// CMD-04 PR0, design (C): snapshot compile (owner decision Q02 = (c): no automatic configuration
// re-send; a lost plan is surfaced, never silently expired). Merged onto the conditional-
// scheduling transport path: every STREGA write leaves through dispatch.enqueueValveCommand
// (durable owner, INTENT -> ATTEMPTED -> ACCEPTED/UNKNOWN) when a transport is supplied, which is
// always the case in production; the MQTT messages below are the no-transport fallback only.
//
// Every fixed-mode compile is a new intent and writes the COMPLETE desired state of every slot
// the valve can hold, read fresh from the DB inside the write transaction:
//   GEN1  SCHEDULER_STATUS first, then 7 WEEKDAY_PLAN rows (FPort 14..20; an empty day is the
//         all-FF plan).
//   GEN2  SCHEDULER_STATUS first, then DAYMASK_PLAN rows (FPort 25) whose masks together cover
//         all 7 days: plan.gen2Groups puts every weekday into exactly one group, and the days
//         without windows form a zero-window frame (one byte, the day bits; '80' clears every
//         day). Whether STREGA SV2 firmware accepts that frame as a clear is hardware gate 4,
//         still open. The conditional clear (clearPlanPushes, mode CONDITIONAL) relies on '80'.
//   CLOCK_SYNC is never part of a compile: the valve tick computes it fresh at send time.
// The compile flushes the device queue (unless an open is still awaiting observation), marks
// every outstanding plan/status row SUPERSEDED -- the new snapshot overwrites every slot they
// covered -- and a flushed, unconfirmed CLOCK_SYNC too (clearing last_clock_sync_queued_at so
// the next tick sends a fresh one). Nothing previously emitted is ever replayed.
//
// The snapshot is not sent by the edit itself. It stays pending (app_settings key
// 'valve_snapshot_pending:<EUI>') and emitPendingSnapshots, run by the valve tick, sends it once
// SNAPSHOT_DEBOUNCE_MS has passed since the last edit, so N edits in a short window cost the
// airtime of one snapshot. The pending marker survives a Node-RED restart.
//
// A valve this gateway never programmed (no WEEKLY schedule ever and no plan push on record)
// gets a status-only snapshot from a scheduler-status change, so a plan written over Bluetooth
// is not wiped by a pause.
// ---------------------------------------------------------------------------------------------
const SNAPSHOT_PURPOSES = ['WEEKDAY_PLAN', 'DAYMASK_PLAN', 'SCHEDULER_STATUS'];
const PLAN_PURPOSES = ['WEEKDAY_PLAN', 'DAYMASK_PLAN'];
const SNAPSHOT_DEBOUNCE_MS = 30 * 1000;
// (R5 L3) Upper bound on the debounce: a snapshot is sent at the latest this long after the
// first edit it carries, however often the plan keeps being edited.
const SNAPSHOT_MAX_DELAY_MS = 5 * 60 * 1000;
// (R5 G1) Interim GEN2 option, app_settings key, default off. When set ('1'/'true'/'yes'/'on'),
// a GEN2 snapshot is: status, the whole-plan clear '80', then only the day groups that carry
// windows -- instead of gen2Groups' zero-window frame for the empty days. Failure modes until
// hardware gate 4 says which frames SV2 firmware accepts: without the prefix, an ignored
// zero-window frame leaves a deleted day watering (fail-wet); with it, an accepted '80' plus
// ignored plan frames leaves the valve without a plan (fail-dry).
const GEN2_CLEAR_PREFIX_KEY = 'valve_gen2_snapshot_clear_prefix';
const STATUS_CODES = { ACTIVE: '0', SKIP_TODAY: '1', DEACTIVATED: '2' };

function statusCodeFor(status) {
  const code = STATUS_CODES[String(status == null ? 'ACTIVE' : status).toUpperCase()];
  if (!code) {
    const err = new Error('invalid_status'); err.statusCode = 422; err.code = 'invalid_status'; throw err;
  }
  return code;
}

function planConflictError(details) {
  const err = new Error('plan_conflict'); err.statusCode = 422; err.code = 'plan_conflict'; err.details = details; return err;
}

async function gen2ClearPrefixEnabled(db, warn) {
  const prefixSetting = await store.getGatewaySetting(db, GEN2_CLEAR_PREFIX_KEY, warn);
  return ['1', 'true', 'yes', 'on'].includes(String(prefixSetting == null ? '' : prefixSetting).trim().toLowerCase());
}

// (R5 M1) The scheduler status goes FIRST: a pause or skip reaches the valve on the next uplink,
// not after seven plan writes. On a status change the plan rows equal what the valve already
// holds (every earlier edit sent its own snapshot), so the status never runs ahead of an
// unknown plan.
function buildSnapshotPushes({ generation, days, schedulerStatus, includePlan, gen2ClearPrefix }) {
  const status = buildStatusPush(statusCodeFor(schedulerStatus));
  if (!includePlan) return [status];
  if (generation === 'GEN2' && gen2ClearPrefix) {
    const clear = { purpose: 'DAYMASK_PLAN', weekday: null, daymask: 0x80, fport: P.GEN2_SCHEDULER_FPORT, payloadHex: hexOf(P.encodeGen2(0x80, [])), planHash: P.planHash([]) };
    const groups = P.gen2Groups(days).filter((g) => g.windows.length > 0)
      .map((g) => ({ purpose: 'DAYMASK_PLAN', weekday: null, daymask: g.daymask, fport: P.GEN2_SCHEDULER_FPORT, payloadHex: hexOf(P.encodeGen2(g.daymask, g.windows)), planHash: P.planHash(g.windows) }));
    return [status, clear].concat(groups);
  }
  return [status].concat(buildPlanPushes({ generation, days, lastHashes: {}, force: true }));
}

function pushItem(eui, row) {
  return { devEui: eui, fPort: Number(row.fport), data: Buffer.from(row.payload_hex, 'hex').toString('base64'), confirmed: false };
}

// Send ledger rows through the awaited gRPC adapter, one durable push owner each, in order.
async function sendRows({ db, deviceEui, rows, transport, now }) {
  const results = [];
  for (const row of rows) {
    const result = await dispatch.enqueueValveCommand({ db, deviceEui, owner: { type: 'push', id: row.push_id }, item: pushItem(deviceEui, row), transport, now });
    results.push({ push_id: row.push_id, ...result });
  }
  return results;
}

// Queue standalone pushes without touching the device queue: the clock tick's CLOCK_SYNC
// (workers.runClockTick), and a scheduler status appended while the valve is in conditional
// mode (setSchedulerStatus below; the conditional clear revision stays in the radio queue).
// Never flushes. Supersedes older QUEUED rows of the same purpose. Plan changes never come
// through here: they are whole-state snapshots (compileAndQueue / queueSnapshot below).
async function queuePushes({ db, deviceEui, appId, pushes, transport, now, warn }) {
  const eui = String(deviceEui).toUpperCase();
  const rows = pushes.map((p) => toRow(eui, p));
  if (!rows.length) return { rows, messages: [], transportResults: [], requeued: 0 };
  await db.transaction(async (tx) => {
    for (const purpose of new Set(pushes.map((p) => p.purpose))) await store.supersedeOutstanding(tx, eui, [purpose]);
    await store.insertPushes(tx, rows);
  });
  if (warn && pushes.some((p) => PLAN_PURPOSES.includes(p.purpose))) {
    warn('[valve-control] queuePushes carried a plan push for ' + eui + '; plans belong in a snapshot');
  }
  if (transport) {
    // STREGA payloads leave through the awaited gRPC adapter. Keeping `messages` empty is the
    // hard boundary that prevents a caller from routing them to any MQTT output node.
    return { rows, messages: [], transportResults: await sendRows({ db, deviceEui: eui, rows, transport, now }), requeued: 0 };
  }
  return { rows, messages: rows.map((r) => buildDownlinkMessage({ appId, deviceEui: eui, fport: r.fport, payloadHex: r.payload_hex })), requeued: 0 };
}

// Write one snapshot: flush, supersede, insert, and either leave it pending for the debounced
// emitter (default) or send it now (emitNow: the decommission sweep, which already runs inside
// the valve tick). The pushes come either ready-made (`pushes`) or from `build(tx)`, which runs
// inside the write transaction (R5 M2: a compile reads the schedules as they are when it
// writes, so a concurrent compile on another DB handle cannot leave an older snapshot as the
// pending truth). With a transport the flush is dispatch.flushValveQueue (durable intent, owners
// captured and invalidated); `flushQueue: null` means "never flush" on either path.
async function queueSnapshot({ db, deviceEui, appId, pushes, build, flushQueue, transport, warn, now, emitNow }) {
  const eui = String(deviceEui).toUpperCase();
  const nowDate = now || new Date();
  let flushed = false;
  let flushResult = null;
  const pending = await dispatch.hasBlockingObservation(db, eui);
  if (!pending) {
    if (transport && flushQueue !== null) {
      flushResult = await dispatch.flushValveQueue({ db, deviceEui: eui, reason: 'plan_push', transport, now });
      flushed = Boolean(flushResult && flushResult.ok);
      // R3-M2: an uncertain flush may still have removed a queued clock sync: re-arm it too (the
      // completed case is handled in the transaction below).
      if (!flushed && flushResult && flushResult.flush_id) await store.supersedeFlushedClock(db, eui, flushResult.flush_id);
      // A failed or ambiguous flush leaves the old queue in an unknown state. The snapshot is
      // still written and will be appended behind it: FIFO then ends on the newest plan, so the
      // valve converges on the DB state. The caller surfaces the flush failure.
      if (!flushed) warn && warn('[valve-control] queue flush uncertain for ' + eui + '; the snapshot will be appended');
    } else if (typeof flushQueue === 'function') {
      try { await flushQueue(eui); flushed = true; } catch (e) { warn && warn('[valve-control] queue flush failed ' + eui + ': ' + (e && e.message ? e.message : e)); }
    }
  }
  let rows = [];
  let superseded = 0;
  await db.transaction(async (tx) => {
    const built = typeof build === 'function' ? await build(tx) : pushes;
    rows = built.map((p) => toRow(eui, p));
    superseded = await store.supersedeOutstanding(tx, eui, SNAPSHOT_PURPOSES);
    if (flushed && await store.supersedeOutstanding(tx, eui, ['CLOCK_SYNC'])) {
      await store.upsertSettings(tx, eui, { last_clock_sync_queued_at: null });
    }
    await store.insertPushes(tx, rows);
    if (emitNow) {
      await store.clearSnapshotPending(tx, eui);
    } else {
      // (R5 L3) keep the first edit's time across re-edits, for the max-delay bound.
      const previous = await store.getSnapshotPending(tx, eui);
      const firstEditedAt = (previous && (previous.first_edited_at || previous.edited_at)) || nowDate.toISOString();
      await store.setSnapshotPending(tx, eui, { edited_at: nowDate.toISOString(), first_edited_at: firstEditedAt, push_ids: rows.map((r) => r.push_id) });
    }
    // P3-E1 review fix (IMPORTANT 4): best-effort -- an emit failure here must not roll back the
    // push-ledger writes this same transaction just made (matches the flows.json seams' shape).
    try { await runtime.emitRuntimeChanged(tx, eui, warn); }
    catch (e) { warn && warn('[valve-control] queueSnapshot: runtime emit failed: ' + (e && e.message ? e.message : e)); }
  });
  const out = { rows, messages: [], flushed, flushResult, superseded, deferred: !emitNow, transportResults: [], requeued: 0 };
  if (emitNow) {
    if (transport) out.transportResults = await sendRows({ db, deviceEui: eui, rows, transport, now });
    else out.messages = rows.map((r) => buildDownlinkMessage({ appId, deviceEui: eui, fport: r.fport, payloadHex: r.payload_hex }));
  }
  return out;
}

// (R13 M3, converged with PR0 91b1466d4 / 2758ca709 T2) Send an emitted snapshot through the
// transport (dispatch owners). The first row that does not reach ACCEPTED stops the snapshot: a
// ChirpStack that refused one row will not take the next within the same tick, and trying would
// stall the tick for one deadline per row. That row and every row after it -- never tried -- are
// marked LOST ('not_resent_q02c') at once with a runtime emission, so a half-sent plan reads
// "device may not hold this plan" now instead of "queued" for 24 h. Nothing re-sends (Q02 c);
// LOST rows stay ACK candidates (B-2), so a row that did reach the valve still confirms.
async function sendSnapshotRows({ db, deviceEui, rows, transport, now, warn }) {
  const results = [];
  try {
    for (const row of rows) {
      const result = await dispatch.enqueueValveCommand({ db, deviceEui, owner: { type: 'push', id: row.push_id }, item: pushItem(deviceEui, row), transport, now });
      results.push({ push_id: row.push_id, ...result });
      if (result.phase !== 'ACCEPTED') break;
    }
  } catch (e) {
    results.push({ push_id: rows[results.length] && rows[results.length].push_id, phase: 'UNKNOWN', error: e });
  }
  const accepted = new Set(results.filter((r) => r.phase === 'ACCEPTED').map((r) => r.push_id));
  const lost = rows.filter((r) => !accepted.has(r.push_id)).map((r) => r.push_id);
  if (lost.length) {
    warn && warn('[valve-control] ' + deviceEui + ': the transport stopped at snapshot row ' + (accepted.size + 1) + ' of ' + rows.length + '; ' + lost.length + ' row(s) not accepted, marked LOST, not re-sent (Q02c)');
    try {
      await db.transaction(async (tx) => {
        await store.markPushesLost(tx, lost, store.LOST_NOT_RESENT);
        try { await runtime.emitRuntimeChanged(tx, deviceEui, warn); }
        catch (e) { warn && warn('[valve-control] snapshot loss: runtime emit failed: ' + (e && e.message ? e.message : e)); }
      });
    } catch (e) {
      warn && warn('[valve-control] could not mark the unsent snapshot rows LOST for ' + deviceEui + ': ' + (e && e.message ? e.message : e));
    }
  }
  return { results, lost };
}

// (PR0 2758ca709 T1/T3, on the transport path) A ChirpStack client built lazily from
// `transportFactory`: nothing is built until the first transport call (or ensure()), and close()
// releases it (each client owns gRPC channels; the valve tick runs every 60 s). If the factory
// throws, ensure() answers false and every call fails closed with transport_unavailable; the
// failure is warned about once per runtime. STREGA writes never fall back to MQTT here: they go
// through dispatch owners or not at all.
let transportUnavailableWarned = false;
function _resetTransportWarningsForTests() { transportUnavailableWarned = false; }

function lazyTransport(transportFactory, warn) {
  let client = null;
  let failed = null;
  const build = () => {
    if (client || failed) return client;
    try {
      client = transportFactory();
    } catch (e) {
      failed = e || new Error('chirpstack_transport_unavailable');
      if (!transportUnavailableWarned && warn) warn('[valve-control] ChirpStack client unavailable; STREGA writes fail closed and plan snapshots stay pending: ' + (e && e.message ? e.message : e));
      transportUnavailableWarned = true;
    }
    return client;
  };
  const call = (names) => (...args) => {
    const c = build();
    if (!c) { const e = new Error('chirpstack_transport_unavailable'); e.code = 'transport_unavailable'; return Promise.reject(e); }
    for (const name of names) if (typeof c[name] === 'function') return c[name](...args);
    return Promise.reject(new Error('transport method ' + names[0] + ' missing'));
  };
  return {
    lazy: true,
    ensure: () => Boolean(build()),
    built: () => Boolean(client),
    getDeviceQueue: call(['getDeviceQueue', 'getQueue']),
    flushDeviceQueue: call(['flushDeviceQueue', 'flushQueue', 'flush']),
    enqueueDownlink: call(['enqueueDownlink', 'enqueue']),
    close: () => {
      if (!client || typeof client.close !== 'function') return [];
      try {
        const errors = client.close();
        if (Array.isArray(errors) && errors.length && warn) warn('[valve-control] ChirpStack client close: ' + errors.map((e) => (e && e.message ? e.message : e)).join('; '));
        return errors || [];
      } catch (e) {
        warn && warn('[valve-control] ChirpStack client close failed: ' + (e && e.message ? e.message : e));
        return [e];
      } finally {
        client = null;
      }
    },
  };
}

// Run by the valve tick. Sends each pending snapshot exactly once -- the marker is deleted in
// the same transaction that reads the rows, before anything is handed to the transport -- when
// its last edit is at least debounceMs old, when its first edit is SNAPSHOT_MAX_DELAY_MS old
// (R5 L3), or when the gateway clock stepped back past it. Only rows still QUEUED and never
// attempted are sent. (R5 M5) While an open awaits observation the compile could not flush, so
// the snapshot is held: edit bursts during one unobserved open append one snapshot behind the
// radio queue, not one per burst. (R5 N1) The 5-minute cap overrides that hold.
// Each emission runs under the valve's writer, so it is serialised against compiles, cancels and
// the conditional senders of the same valve. (R13-m5) The hold is read before the writer is
// taken: an open reserved in between is enqueued ahead of the snapshot anyway (FIFO), so the
// valve still ends on the snapshot; the hold only saves airtime, it is not a safety fence.
// Transport: `transport` (dispatch owners) or `transportFactory` (a lazily built ChirpStack
// client, closed before returning). (PR0 T2) After a transport failure, snapshots of other
// valves due in the same tick stay pending (never emitted, so not a re-send) for the next tick.
// A client that cannot be built leaves every snapshot pending (fail closed, warned once). With
// neither, rows are returned as MQTT messages (tests and legacy callers only).
async function emitPendingSnapshots({ db, now, appId, warn, debounceMs, transport, transportFactory }) {
  const windowMs = debounceMs == null ? SNAPSHOT_DEBOUNCE_MS : debounceMs;
  const nowMs = (now || new Date()).getTime();
  const out = { messages: [], emitted: 0, transportFailures: [], transportDown: false };
  let pending = [];
  try { pending = await store.listSnapshotPending(db); }
  catch (e) { warn && warn('[valve-control] pending snapshots unreadable: ' + (e && e.message ? e.message : e)); return out; }
  const owned = !transport && typeof transportFactory === 'function' ? lazyTransport(transportFactory, warn) : null;
  const via = transport || owned;
  try {
    for (const p of pending) {
      if (out.transportDown) break;
      const editedMs = Date.parse(p.edited_at);
      const firstMs = Date.parse(p.first_edited_at || p.edited_at);
      const capReached = Number.isFinite(firstMs) && nowMs - firstMs >= SNAPSHOT_MAX_DELAY_MS;
      const due = capReached || !Number.isFinite(editedMs) || nowMs - editedMs >= windowMs || editedMs - nowMs > windowMs;
      if (!due) continue;
      if (!capReached && await dispatch.hasBlockingObservation(db, p.device_eui)) continue;
      // A transport that cannot be built: leave the snapshot pending (nothing was emitted).
      if (via && typeof via.ensure === 'function' && !via.ensure()) { out.transportDown = true; break; }
      const eui = String(p.device_eui).toUpperCase();
      let sent;
      try {
        sent = await dispatch.withValveWriter(eui, async () => {
          let rows = [];
          await db.transaction(async (tx) => {
            const current = await store.getSnapshotPending(tx, eui);
            if (!current || current.raw !== p.raw) return; // re-edited since the read: the next tick decides
            await store.clearSnapshotPending(tx, eui);
            rows = (await store.queuedPushesById(tx, eui, current.push_ids)).filter((r) => !transportEvidence(r).phase && !lifecycleMarker(r));
            // (R5 re-review N3/N4) A cancel compares this marker's raw value before and after its
            // flush to tell rows emitted during the flush (still on the air) from rows it removed.
            if (rows.length) await store.setSnapshotEmitted(tx, eui, { emitted_at: new Date().toISOString(), push_ids: rows.map((r) => r.push_id) });
          });
          if (!rows.length) return null;
          if (via) return Object.assign({ rows }, await sendSnapshotRows({ db, deviceEui: eui, rows, transport: via, now, warn }));
          return { rows, messages: rows.map((r) => buildDownlinkMessage({ appId, deviceEui: eui, fport: r.fport, payloadHex: r.payload_hex })) };
        });
      } catch (e) {
        warn && warn('[valve-control] snapshot emission failed for ' + eui + ': ' + (e && e.message ? e.message : e));
        out.transportFailures.push({ device_eui: eui, error: 'transport_uncertain', phase: 'UNKNOWN', detail: String(e && e.message || e) });
        out.transportDown = true;
        continue;
      }
      if (!sent) continue;
      out.emitted += 1;
      if (sent.messages) out.messages.push(...sent.messages);
      const failure = sent.results && sent.results.find((r) => r.phase && r.phase !== 'ACCEPTED');
      if (failure) {
        out.transportFailures.push({ device_eui: eui, error: failure.phase === 'UNKNOWN' ? 'transport_uncertain' : failure.phase, phase: failure.phase, push_id: failure.push_id, lost: sent.lost.length });
        out.transportDown = true;
      }
    }
  } finally {
    if (owned) owned.close();
  }
  return out;
}

// R19 finding 1 (release review of PR #515): a lifecycle or conversion clear is prepared in
// the mutation transaction and sent once after commit. When that send could not run (no
// transport, or the flush failed), its required rows stay QUEUED with no transport phase. The
// valve tick sends them here once ChirpStack answers. Only provably unattempted rows are sent
// (sendPrepared* skip any row with transport evidence), so Q02(c) still holds: an attempted,
// accepted or unknown row is never re-sent. A clear blocked by an active owner is re-checked
// every tick and never flushes the queue under that owner.
async function emitPendingClears({ db, now, warn, transport, transportFactory }) {
  const out = { sent: 0, attempted: 0, failures: [] };
  let rows = [];
  try {
    rows = await db.all("SELECT device_eui, conditional_control_json FROM valve_settings WHERE conditional_control_json IS NOT NULL AND conditional_control_json <> ''");
  } catch (e) {
    warn && warn('[valve-control] pending clears unreadable: ' + (e && e.message ? e.message : e));
    return out;
  }
  const candidates = [];
  for (const row of rows) {
    const control = store.parseControl(row.conditional_control_json);
    if (!control || !control.desired_revision) continue;
    if (control.mode !== 'LIFECYCLE_CLEAR' && control.mode !== 'CONDITIONAL') continue;
    if (control.mode === 'LIFECYCLE_CLEAR' && (!control.lifecycle_clear || control.lifecycle_clear.state === 'SUPERSEDED')) continue;
    const readiness = control.readiness || {};
    if (readiness.state === 'READY' || readiness.state === 'INVALID') continue;
    const ids = Array.isArray(control.required_push_ids) ? control.required_push_ids : [];
    if (!ids.length) continue;
    const required = await db.all('SELECT push_id, state, transport_json FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND push_id IN (' + ids.map(() => '?').join(',') + ')', [row.device_eui].concat(ids));
    if (!required.some((r) => lifecycleRowProvablyUnattempted(r))) continue;
    candidates.push({ eui: String(row.device_eui).toUpperCase(), mode: control.mode, revision: control.desired_revision });
  }
  if (!candidates.length) return out;
  const owned = !transport && typeof transportFactory === 'function' ? lazyTransport(transportFactory, warn) : null;
  const via = transport || owned;
  try {
    if (!via || (typeof via.ensure === 'function' && !via.ensure())) return out;
    for (const c of candidates) {
      out.attempted += 1;
      try {
        const result = c.mode === 'LIFECYCLE_CLEAR'
          ? await sendPreparedLifecycleClear({ db, deviceEui: c.eui, revision: c.revision, transport: via, now, warn })
          : await sendPreparedRevision({ db, deviceEui: c.eui, revision: c.revision, transport: via, now, warn });
        out.sent += Number(result && result.sent || 0);
        if (result && result.readiness && result.readiness.state === 'FAILED') out.failures.push({ device_eui: c.eui, reason: result.readiness.reason });
      } catch (e) {
        warn && warn('[valve-control] pending clear for ' + c.eui + ' failed: ' + (e && e.message ? e.message : e));
        out.failures.push({ device_eui: c.eui, reason: 'transport_uncertain' });
      }
    }
  } finally {
    if (owned) owned.close();
  }
  return out;
}

async function compileAndQueue({ db, deviceEui, appId, force, now, flushQueue, transport, warn, timeZoneFallback, automaticReconcile = false, auto = false, resendPurpose, settingsPatch, statusOnlyOnConflict, schedulerStatus } = {}) {
  const eui = String(deviceEui).toUpperCase();
  const fixedOptions = { db, deviceEui: eui, appId, force, now, flushQueue, transport, warn, timeZoneFallback, settingsPatch, statusOnlyOnConflict, schedulerStatus };
  return dispatch.withValveWriter(eui, () => (automaticReconcile || auto)
    ? reconcileGenerationTransitionLocked({ db, deviceEui: eui, appId, force, now, flushQueue, transport, warn, timeZoneFallback })
    : (resendPurpose === LIFECYCLE_CLEAR_RESEND_PURPOSE ? store.conditionalControl(db, eui).then((control) => control.mode === 'LIFECYCLE_CLEAR'
      ? retryLifecycleClear({ db, deviceEui: eui, transport, now, warn })
      : compileAndQueueLocked(fixedOptions))
      : compileAndQueueLocked(fixedOptions)));
}

// `force` is accepted for the callers' sake ("Resend plan", the GEN2 profile swap) but no longer
// changes a fixed-mode compile: every compile is a full snapshot. `schedulerStatus` overrides the
// stored status (direct callers only). `settingsPatch` (the status routes, via
// setSchedulerStatus) is written inside the snapshot transaction (R5 N2). `statusOnlyOnConflict`
// (R5 M3, the status routes): a stored plan that compileWindows rejects must not block
// pause/skip/resume, so the snapshot falls back to the status alone. timeZoneFallback is unused
// since CLOCK_SYNC left the compile; it stays in the signature for the callers.
async function compileAndQueueLocked({ db, deviceEui, appId, force, now, flushQueue, transport, warn, timeZoneFallback, settingsPatch, statusOnlyOnConflict, schedulerStatus }) {
  const eui = String(deviceEui).toUpperCase();
  const schedules = await store.listSchedules(db, eui);
  const settings = await store.getSettings(db, eui);
  const mode = P.validateScheduleModes(schedules, await store.listPoliciesForSchedules(db, schedules));
  if (!mode.ok) {
    const err = new Error(mode.code || 'mixed_schedule_mode'); err.statusCode = mode.status || 409; err.code = mode.code || 'mixed_schedule_mode'; err.details = mode; throw err;
  }
  if (mode.mode === 'CONDITIONAL') {
    const prepared = await prepareClearRevision({ db, deviceEui: eui, generation: settings.strega_generation, schedules, now, reason: force ? 'resend' : 'conversion', force: true });
    const sent = transport ? await sendPreparedRevision({ db, deviceEui: eui, revision: prepared.revision, transport, now, warn }) : null;
    return { compiled: { days: Array.from({ length: 7 }, () => []), errors: [] }, generation: settings.strega_generation, rows: prepared.rows, messages: [], revision: prepared.revision,
      required_push_ids: prepared.required_push_ids, predecessor_push_ids: prepared.predecessor_push_ids, sent };
  }
  // Leaving conditional mode invalidates the old readiness immediately.  The
  // snapshot below then sends the resident fixed program (or an empty program,
  // with explicit clears for every day, when the last conditional row was removed).
  const priorControl = await store.conditionalControl(db, eui);
  if (pendingFixedGenerationTransition(priorControl, 'GEN2')
      && transitionPrepared(priorControl)
      && !sameFixedScheduleSnapshot(priorControl.fixed_generation_transition, schedules, timeZoneFallback)) {
    await supersedeFixedTransition(db, eui, 'source_schedule_changed', now);
  }
  const leavingConditional = priorControl.mode === 'CONDITIONAL' || priorControl.desired_revision;
  let conversionWaitsFor = null;
  if (leavingConditional) {
    // (R13-M4) An open still active used to block the conversion with nothing written, nothing
    // sent and a 202 to the caller: the fixed plan was stored but never programmed. Design C
    // handles it like any compile during an open: the control becomes FIXED now, and the snapshot
    // below stays pending. queueSnapshot does not flush while the open awaits observation, and
    // the emitter holds the snapshot until the open is observed or the 5-minute cap, then appends
    // it behind the queue (FIFO ends on the fixed plan). The caller sees which open it waits for.
    const conflict = await db.transaction((tx) => dispatch.findValveConflictTx(tx, eui, 'conditional-mode-change', now || new Date()));
    if (conflict) {
      conversionWaitsFor = conflict.command_id || conflict.expectation_id || 'active_open';
      warn && warn('[valve-control] ' + eui + ': leaving conditional mode behind an active open (' + conversionWaitsFor + '); the fixed snapshot waits for it');
    }
    await store.writeConditionalControl(db, eui, { ...priorControl, mode: 'FIXED', desired_revision: null,
      required_push_ids: [], predecessor_push_ids: [], readiness: { state: 'INVALID', reason: conflict ? 'fixed_mode_pending_open' : 'fixed_mode' } });
  }
  const gen2ClearPrefix = await gen2ClearPrefixEnabled(db, warn);
  // (R5 re-review N2) The status routes' patch is written inside the snapshot transaction, before
  // the snapshot is built from the settings, so the stored status and the newest snapshot agree
  // by construction. The pre-flush validation build uses the patch's status as an override,
  // since nothing is written yet.
  const patchedStatus = settingsPatch && settingsPatch.scheduler_status != null ? settingsPatch.scheduler_status : null;
  const statusOverride = schedulerStatus != null ? schedulerStatus : patchedStatus;
  const build = async (q, override) => {
    const current = await store.listSchedules(q, eui);
    const currentSettings = await store.getSettings(q, eui);
    const compiled = P.compileWindows(current);
    // (R5 L1) Any WEEKLY row, tombstones included, is the intent to program the valve: a delete
    // on a valve whose push history is missing (restored DB, replacement gateway) still clears.
    // Leaving conditional mode always programs: the valve holds the conditional clear.
    let includePlan = Boolean(leavingConditional) || (await store.hasWeeklyEver(q, eui)) || (await store.hasPlanHistory(q, eui));
    if (compiled.errors.length) {
      if (!statusOnlyOnConflict) throw planConflictError(compiled.errors);
      includePlan = false;
    }
    const status = override != null ? override : currentSettings.scheduler_status;
    const pushes = buildSnapshotPushes({ generation: currentSettings.strega_generation, days: compiled.days, schedulerStatus: status, includePlan, gen2ClearPrefix });
    return { compiled, pushes, generation: currentSettings.strega_generation };
  };
  // Validate before the flush: a refused compile must not touch the radio queue.
  let built = await build(db, statusOverride);
  if (built.compiled.errors.length && warn) warn('[valve-control] ' + eui + ': plan_conflict in the stored schedules; sending the scheduler status alone');
  const queued = await queueSnapshot({ db, deviceEui: eui, appId, flushQueue, transport, warn, now, build: async (tx) => {
    if (settingsPatch) await store.upsertSettings(tx, eui, settingsPatch);
    built = await build(tx, schedulerStatus);
    return built.pushes;
  } });
  return Object.assign({ compiled: built.compiled, generation: built.generation }, queued, conversionWaitsFor ? { conversion_waits_for: conversionWaitsFor } : {});
}

// The REST and cloud scheduler-status routes (pause / skip today / resume). Never a lone status
// push behind a flush: in fixed mode the status rides first in a full snapshot (design C), so a
// plan snapshot still outstanding is replaced, never dropped (R11 probe 2: delete, then pause,
// inside one uplink). In conditional or lifecycle-clear mode the valve holds (or is being sent)
// the conditional clear: the status is appended to the radio queue with no flush, so the clear
// in flight is never killed, and the status row and valve_settings commit in one transaction
// (R13-m2). The policy worker honours DEACTIVATED and SKIP_TODAY for conditional openings
// (R13-M1). ACTIVE is refused in lifecycle-clear mode, and in conditional mode while the current
// clear is not confirmed READY: the valve may still hold a resident plan, and status 0 would let
// it run.
async function setSchedulerStatus({ db, deviceEui, appId, status, settingsPatch, now, flushQueue, transport, warn, timeZoneFallback } = {}) {
  const eui = String(deviceEui).toUpperCase();
  const code = statusCodeFor(status);
  const wanted = String(status).toUpperCase();
  const patch = settingsPatch || { scheduler_status: wanted };
  return dispatch.withValveWriter(eui, async () => {
    const control = await store.conditionalControl(db, eui);
    const schedules = await store.listSchedules(db, eui);
    const mode = P.validateScheduleModes(schedules, await store.listPoliciesForSchedules(db, schedules));
    const conditional = ['CONDITIONAL', 'LIFECYCLE_CLEAR'].includes(control.mode) || (mode.ok && mode.mode === 'CONDITIONAL');
    const clearReady = control.mode === 'CONDITIONAL' && Boolean(control.desired_revision) && Boolean(control.readiness)
      && control.readiness.state === 'READY' && control.readiness.revision === control.desired_revision;
    if (wanted === 'ACTIVE' && conditional && !clearReady) {
      throw Object.assign(new Error('conditional_readiness_pending'), { code: 'conditional_readiness_pending', statusCode: 409 });
    }
    // R19 finding 3: a stored mixed or orphaned program refuses every compile. Pause and skip
    // today must still work, so they go out as a status-only push; resume stays refused.
    const invalidMode = !mode.ok;
    if (invalidMode && wanted === 'ACTIVE') {
      throw Object.assign(new Error(mode.code || 'mixed_schedule_mode'), { code: mode.code || 'mixed_schedule_mode', statusCode: 409, details: mode });
    }
    if (conditional || invalidMode) {
      const rows = [toRow(eui, buildStatusPush(code))];
      await db.transaction(async (tx) => {
        await store.supersedeOutstanding(tx, eui, ['SCHEDULER_STATUS']);
        await store.insertPushes(tx, rows);
        await store.upsertSettings(tx, eui, patch);
      });
      const out = { statusOnly: true, conditional, invalidMode, rows, messages: [], transportResults: [], requeued: 0 };
      if (transport) out.transportResults = await sendRows({ db, deviceEui: eui, rows, transport, now });
      else out.messages = rows.map((r) => buildDownlinkMessage({ appId, deviceEui: eui, fport: r.fport, payloadHex: r.payload_hex }));
      return out;
    }
    return compileAndQueueLocked({ db, deviceEui: eui, appId, now, flushQueue, transport, warn, timeZoneFallback,
      settingsPatch: patch, statusOnlyOnConflict: true });
  });
}

function transportFailure(result) {
  if (!result) return null;
  if (result.flushResult && result.flushResult.ok === false) {
    return { error: 'transport_uncertain', phase: result.flushResult.phase || 'UNKNOWN', detail: result.flushResult };
  }
  if (result.flush && result.flush.ok === false) {
    return { error: 'transport_uncertain', phase: result.flush.phase || 'UNKNOWN', detail: result.flush };
  }
  const failed = (Array.isArray(result.transportResults) ? result.transportResults : (Array.isArray(result.results) ? result.results : []))
    .find((item) => item && item.phase && item.phase !== 'ACCEPTED');
  if (failed) return {
    error: failed.phase === 'UNKNOWN' ? 'transport_uncertain' : failed.phase,
    phase: failed.phase,
    detail: failed,
  };
  for (const nested of [result.send, result.sent]) {
    if (nested && typeof nested === 'object') {
      const nestedFailure = transportFailure(nested);
      if (nestedFailure) return nestedFailure;
    }
  }
  if (result.readiness && result.readiness.state === 'FAILED') {
    return { error: result.readiness.reason === 'flush_failed' ? 'transport_uncertain' : 'transport_failed', phase: result.readiness.reason || 'FAILED', detail: result };
  }
  return null;
}

async function applyGenerationTransition(db, deviceEui, result, now) {
  if (!result || String(result.generation || '').toUpperCase() !== 'GEN2') return false;
  if (result.transition_id && result.plan_revision && result.complete !== true) return false;
  if (transportFailure(result)) return false;
  return markGenerationTransitionApplied(db, deviceEui, {
    generation: 'GEN2', compiledGeneration: result.generation,
    transitionId: result.transition_id,
    planRevision: result.plan_revision,
    requiredPushIds: result.required_push_ids,
    now,
  });
}

module.exports = { buildPlanPushes, buildDownlinkMessage, buildStatusPush, buildClockPush, buildSnapshotPushes, statusCodeFor, queuePushes, queueSnapshot, emitPendingSnapshots, emitPendingClears, lazyTransport, _resetTransportWarningsForTests, compileAndQueue, setSchedulerStatus, transportFailure,
  clearPlanPushes, prepareClearRevisionTx, prepareClearRevision, prepareLifecycleClearRevisionTx, sendPreparedRevision, sendPreparedLifecycleClear,
  retryLifecycleClear, invalidateLifecycleClearTx, LIFECYCLE_CLEAR_RESEND_PURPOSE, conditionalReadinessTx, conditionalReadiness,
  conditionalReconciliationNeeded, prepareFixedGenerationTransition, reconcileGenerationTransition, markGenerationTransitionApplied,
  applyGenerationTransition, retryClearRevision, finalizeConditionalIncidentTx,
  SNAPSHOT_DEBOUNCE_MS, SNAPSHOT_MAX_DELAY_MS, SNAPSHOT_PURPOSES, GEN2_CLEAR_PREFIX_KEY };
