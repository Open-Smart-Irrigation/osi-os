'use strict';

// The due worker owns the calendar-to-decision boundary. It discovers only
// active policy rows, then does authority, evidence, claim and reservation
// writes in one short transaction under the complete valve writer set. The
// transport attempt happens after that transaction commits.

const crypto = require('node:crypto');
const model = require('./model');
const evaluate = require('./evaluate');
const occurrences = require('./occurrences');
const observations = require('./observations');
const policyStore = require('./store');
const clock = require('./clock');
const clockBounds = require('./clock-bounds');
const effects = require('../osi-valve-control/effects');
const dispatch = require('../osi-valve-control/dispatch');
const valveStore = require('../osi-valve-control/store');
const push = require('../osi-valve-control/push');

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const AUDIT_OVERLAP_MS = 10 * 60 * 1000;
const NEXT_OCCURRENCE_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;
const EUI_RE = /^[0-9A-F]{16}$/;
const DURABLE_UNFINISHED_STATES = ['PENDING', 'CLAIMED', 'RESERVED', 'ATTEMPTED'];

const JOINED_COLUMNS = `
  p.policy_uuid, p.zone_uuid, p.condition_json, p.timezone AS policy_timezone,
  p.enabled AS policy_enabled, p.observation_window_minutes, p.min_interval_minutes,
  p.max_daily_minutes, p.delivery_settings_json, p.effective_from AS policy_effective_from,
  p.sync_version AS policy_sync_version, p.deleted_at AS policy_deleted_at,
  iz.id AS zone_id, iz.zone_uuid AS current_zone_uuid,
  vs.schedule_uuid, vs.device_eui, vs.kind AS schedule_kind,
  vs.weekdays_mask, vs.start_time, vs.duration_minutes, vs.timezone AS schedule_timezone,
  vs.enabled AS schedule_enabled, vs.sync_version AS schedule_sync_version,
  vs.condition_policy_uuid, vs.effective_from AS schedule_effective_from,
  vs.deleted_at AS schedule_deleted_at,
  d.type_id, d.irrigation_zone_id, d.deleted_at AS device_deleted_at,
  d.current_state, d.updated_at AS device_updated_at`;

const ACTIVE_POLICIES_SQL = `SELECT ${JOINED_COLUMNS}
  FROM irrigation_policies p
  JOIN irrigation_zones iz ON iz.zone_uuid=p.zone_uuid AND iz.deleted_at IS NULL
  JOIN valve_schedules vs ON vs.condition_policy_uuid=p.policy_uuid
  JOIN devices d ON UPPER(d.deveui)=UPPER(vs.device_eui)
    AND d.irrigation_zone_id=iz.id AND d.deleted_at IS NULL
  WHERE p.enabled=1 AND p.deleted_at IS NULL
    AND vs.kind='WEEKLY' AND vs.enabled=1 AND vs.deleted_at IS NULL
    AND d.type_id='STREGA_VALVE'
  ORDER BY vs.device_eui, vs.schedule_uuid`;

const CURRENT_ROW_SQL = `SELECT ${JOINED_COLUMNS}
  FROM irrigation_policies p
  JOIN irrigation_zones iz ON iz.zone_uuid=p.zone_uuid AND iz.deleted_at IS NULL
  JOIN valve_schedules vs ON vs.condition_policy_uuid=p.policy_uuid
  JOIN devices d ON UPPER(d.deveui)=UPPER(vs.device_eui)
    AND d.irrigation_zone_id=iz.id AND d.deleted_at IS NULL
  WHERE p.policy_uuid=? AND vs.schedule_uuid=?
  LIMIT 1`;

const DURABLE_UNFINISHED_SQL = `SELECT * FROM irrigation_occurrences
  WHERE state IN (${DURABLE_UNFINISHED_STATES.map(() => '?').join(',')})
  ORDER BY due_at, schedule_uuid, local_date, local_time`;

class WorkerError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.code = code;
    this.details = details;
  }
}

function parseInstant(value) {
  const parsed = evaluate.parseInstant(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoNow(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : parseInstant(value);
  if (!Number.isFinite(ms)) throw new WorkerError('invalid_now', 'worker now is not a strict timestamp');
  return new Date(ms).toISOString();
}

function optionNowMs(options, fallback) {
  const supplied = typeof options.currentNow === 'function'
    ? options.currentNow()
    : options.now === undefined ? Date.now() : fallback;
  const ms = supplied instanceof Date ? supplied.getTime() : typeof supplied === 'number' ? supplied : parseInstant(supplied);
  return Number.isFinite(ms) ? ms : fallback;
}

function jsonObject(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function normalizeEui(value) {
  const eui = String(value == null ? '' : value).trim().toUpperCase();
  if (!EUI_RE.test(eui)) throw new WorkerError('invalid_device_eui', 'device_eui is invalid');
  return eui;
}

function joinedRow(row) {
  if (!row) return null;
  const deviceEui = normalizeEui(row.device_eui);
  const policy = {
    policy_uuid: String(row.policy_uuid), zone_uuid: String(row.zone_uuid),
    zone_id: Number(row.zone_id), condition: jsonObject(row.condition_json, null),
    timezone: String(row.policy_timezone || 'UTC'), enabled: Number(row.policy_enabled) === 1,
    observation_window_minutes: Number(row.observation_window_minutes),
    min_interval_minutes: Number(row.min_interval_minutes), max_daily_minutes: Number(row.max_daily_minutes),
    delivery_settings: jsonObject(row.delivery_settings_json, {}),
    effective_from: row.policy_effective_from || null, sync_version: Number(row.policy_sync_version),
    deleted_at: row.policy_deleted_at || null,
  };
  const schedule = {
    schedule_uuid: String(row.schedule_uuid), device_eui: deviceEui, kind: String(row.schedule_kind),
    weekdays_mask: Number(row.weekdays_mask), start_time: row.start_time,
    duration_minutes: Number(row.duration_minutes), timezone: String(row.schedule_timezone || policy.timezone),
    enabled: Number(row.schedule_enabled) === 1, sync_version: Number(row.schedule_sync_version),
    condition_policy_uuid: row.condition_policy_uuid || null,
    effective_from: row.schedule_effective_from || null, deleted_at: row.schedule_deleted_at || null,
  };
  return {
    policy, schedule,
    zone: { id: Number(row.zone_id), zone_uuid: String(row.current_zone_uuid || row.zone_uuid) },
    device: {
      deveui: deviceEui, type_id: row.type_id, irrigation_zone_id: Number(row.irrigation_zone_id),
      current_state: row.current_state, updated_at: row.device_updated_at,
    },
  };
}

function occurrenceKey(schedule, due) {
  return { schedule_uuid: schedule.schedule_uuid, local_date: due.local_date, local_time: due.local_time };
}

function occurrenceIdentity(key) {
  return [key.schedule_uuid, key.local_date, key.local_time].join('|');
}

const SOURCE_SCOPE_REASONS = new Set([
  'device_not_found', 'device_not_assigned_to_zone', 'channel_not_allowed',
  'channel_not_commissioned', 'sensor_not_enabled',
]);

function conditionReason(result, observation) {
  if (!result) return 'sensor_unavailable';
  if (result.reason === 'maintain_recovery_hold' || result.reason === 'maintain_rain_suppression') return 'dendro_hold';
  if (result.status === 'NOT_MET') return 'condition_not_met';
  if (result.status === 'UNKNOWN' && observation && Array.isArray(observation.sources)
      && observation.sources.some((source) => SOURCE_SCOPE_REASONS.has(String(source && source.reason || '')))) return 'scope_lost';
  return 'sensor_unavailable';
}

function maxDurationMinutes(policy, schedule) {
  const base = Number(schedule.duration_minutes);
  if (String(policy.condition && policy.condition.kind).toUpperCase() === 'DENDRO'
      && policy.condition.response_mode === 'proportional') return Math.ceil(base * 1.5);
  return base;
}

function actionFromEvidence(evidence, result) {
  const analysis = evidence && evidence.analysis;
  if (analysis && analysis.action) return analysis.action;
  const source = result && Array.isArray(result.sources) && result.sources[0];
  return source && source.analysis && source.analysis.action;
}

async function clockStatus(options, bounds = {}) {
  const nowMs = options.nowMs;
  const context = {
    now: nowMs, lastDue: bounds.lastDue || null, latestSample: bounds.latestSample || null,
    clockOptions: options.clockOptions || {},
  };
  let result;
  try {
    if (typeof options.clock === 'function') result = await options.clock(context);
    else if (options.clock && typeof options.clock.runtimeClockStatus === 'function') result = await options.clock.runtimeClockStatus(context);
    else if (options.clock && typeof options.clock === 'object' && Object.prototype.hasOwnProperty.call(options.clock, 'trusted')) result = options.clock;
    else result = clock.openClockStatus({ ...(options.clockOptions || {}), now: nowMs, lastDue: bounds.lastDue || null, latestSample: bounds.latestSample || null });
  } catch (error) {
    return { trusted: false, reason: 'clock_untrusted_error', error: String(error && error.message || error) };
  }
  if (!result || result.trusted !== true) return { trusted: false, reason: result && result.reason || 'clock_untrusted' };
  return result;
}

function trustedOrThrow(status) {
  if (!status || status.trusted !== true) throw new WorkerError('clock_untrusted', 'conditional due evaluation requires a trusted runtime clock', { reason: status && status.reason || 'clock_untrusted' });
}

function candidateSort(left, right) {
  return left.due.dueAt.localeCompare(right.due.dueAt)
    || left.schedule.schedule_uuid.localeCompare(right.schedule.schedule_uuid)
    || left.policy.policy_uuid.localeCompare(right.policy.policy_uuid);
}

function durableFallbackCandidate(row) {
  const evidence = jsonObject(row.decision_evidence_json, {});
  const timezone = String(evidence.timezone || 'UTC');
  const condition = evidence.condition && typeof evidence.condition === 'object'
    ? evidence.condition
    : { kind: 'DENDRO', minimum_stress: 'mild', response_mode: 'fixed' };
  const deviceEui = normalizeEui(row.device_eui);
  const policyRevision = Number(row.policy_sync_version != null ? row.policy_sync_version : row.policy_revision) || 0;
  const scheduleRevision = Number(row.schedule_sync_version != null ? row.schedule_sync_version : row.schedule_revision) || 0;
  return {
    policy: {
      policy_uuid: String(row.policy_uuid || ''), zone_uuid: String(row.zone_uuid || ''), zone_id: null,
      condition, timezone, enabled: false, observation_window_minutes: Number(evidence.observation_window_minutes) || 60,
      min_interval_minutes: Number(evidence.minimum_gap_minutes) || 0, max_daily_minutes: Number(evidence.max_daily_minutes) || 1440,
      delivery_settings: {}, effective_from: null, sync_version: policyRevision, deleted_at: 'durable_owner_missing',
    },
    schedule: {
      schedule_uuid: String(row.schedule_uuid), device_eui: deviceEui, kind: 'WEEKLY', weekdays_mask: 0,
      start_time: row.local_time || '00:00', duration_minutes: Number(evidence.requested_duration_minutes) || 1,
      timezone, enabled: false, sync_version: scheduleRevision, condition_policy_uuid: row.policy_uuid || null,
      effective_from: null, deleted_at: 'durable_owner_missing',
    },
    zone: { id: 0, zone_uuid: String(row.zone_uuid || '') },
    device: { deveui: deviceEui, type_id: 'STREGA_VALVE', irrigation_zone_id: null, current_state: null, updated_at: null },
  };
}

async function durableCandidate(db, row) {
  const deviceEui = normalizeEui(row.device_eui);
  const raw = row.policy_uuid && row.schedule_uuid
    ? await db.get(CURRENT_ROW_SQL, [row.policy_uuid, row.schedule_uuid])
    : null;
  const current = joinedRow(raw);
  const base = current && current.schedule.device_eui === deviceEui ? current : durableFallbackCandidate(row);
  const policyRevision = Number(row.policy_sync_version != null ? row.policy_sync_version : row.policy_revision);
  const scheduleRevision = Number(row.schedule_sync_version != null ? row.schedule_sync_version : row.schedule_revision);
  const candidate = {
    policy: { ...base.policy },
    schedule: { ...base.schedule, device_eui: deviceEui },
    zone: { ...base.zone },
    device: { ...base.device, deveui: deviceEui },
    due: { dueAt: row.due_at, local_date: row.local_date, local_time: row.local_time },
    valve_euis: [deviceEui],
  };
  if (Number.isFinite(policyRevision)) candidate.policy.sync_version = policyRevision;
  if (Number.isFinite(scheduleRevision)) candidate.schedule.sync_version = scheduleRevision;
  if (row.zone_uuid != null) {
    candidate.policy.zone_uuid = String(row.zone_uuid);
    candidate.zone.zone_uuid = String(row.zone_uuid);
  }
  return candidate;
}

async function discoverDurableCandidates(db, nowMs) {
  const rows = await db.all(DURABLE_UNFINISHED_SQL, DURABLE_UNFINISHED_STATES);
  const result = [];
  for (const row of rows || []) {
    const dueMs = parseInstant(row.due_at);
    if (dueMs == null || dueMs > nowMs) continue;
    result.push(await durableCandidate(db, row));
  }
  return result;
}

async function discoverCandidates(db, runtime, nowMs) {
  const rows = await db.all(ACTIVE_POLICIES_SQL);
  const groups = new Map();
  for (const raw of rows || []) {
    const item = joinedRow(raw);
    if (!item || !item.policy.condition) continue;
    let group = groups.get(item.policy.policy_uuid);
    if (!group) {
      group = { policy: item.policy, zone: item.zone, schedules: [], valve_euis: new Set() };
      groups.set(item.policy.policy_uuid, group);
    }
    group.schedules.push(item.schedule);
    group.valve_euis.add(item.schedule.device_eui);
  }
  const audit = occurrences.missedAuditBounds(runtime && runtime.last_trusted_tick_at, new Date(nowMs).toISOString());
  const auditLowerMs = audit && parseInstant(audit.from) != null ? parseInstant(audit.from) : nowMs - LOOKBACK_MS;
  // A tick may crash after its checkpoint is written but before the first
  // occurrence is durable.  Re-audit an overlap within the accepted lookback;
  // the composite occurrence identity, rather than a timestamp cursor, owns
  // replay and deduplication.
  const lowerMs = Math.max(nowMs - LOOKBACK_MS, auditLowerMs - AUDIT_OVERLAP_MS);
  const from = new Date(lowerMs - 1).toISOString();
  const to = new Date(nowMs).toISOString();
  const lastDecidedMs = parseInstant(runtime && runtime.last_decided_due_at);
  const result = [];
  for (const group of groups.values()) {
    const policyEffectiveMs = parseInstant(group.policy.effective_from);
    for (const schedule of group.schedules) {
      for (const due of occurrences.occurrencesBetween(schedule, from, to)) {
        const dueMs = parseInstant(due.dueAt);
        if (dueMs == null || (policyEffectiveMs != null && dueMs <= policyEffectiveMs)) continue;
        if (lastDecidedMs != null && dueMs < lastDecidedMs) {
          // The timestamp is only a lower bound.  A missing composite row is
          // unfinished work, and ATTEMPTED/RESERVED owners remain recoverable;
          // terminal rows can be skipped after their exact key is found.
          const existing = await policyStore.getOccurrence(db, occurrenceKey(schedule, due));
          if (existing && !['PENDING', 'CLAIMED', 'RESERVED', 'ATTEMPTED'].includes(existing.state)) continue;
        }
        result.push({ policy: group.policy, zone: group.zone, schedule, due, valve_euis: [...group.valve_euis].sort() });
      }
    }
  }
  const byOccurrence = new Map(result.map((candidate) => [occurrenceIdentity(occurrenceKey(candidate.schedule, candidate.due)), candidate]));
  for (const candidate of await discoverDurableCandidates(db, nowMs)) {
    const identity = occurrenceIdentity(occurrenceKey(candidate.schedule, candidate.due));
    if (!byOccurrence.has(identity)) byOccurrence.set(identity, candidate);
  }
  return [...byOccurrence.values()].sort(candidateSort);
}

async function currentCandidateTx(tx, candidate) {
  const row = await tx.get(CURRENT_ROW_SQL, [candidate.policy.policy_uuid, candidate.schedule.schedule_uuid]);
  return joinedRow(row);
}

function activeAuthority(current, candidate) {
  if (!current) return false;
  if (!current.policy.enabled || current.policy.deleted_at != null || current.schedule.kind !== 'WEEKLY'
      || !current.schedule.enabled || current.schedule.deleted_at != null) return false;
  if (current.schedule.timezone !== current.policy.timezone) return false;
  if (current.policy.policy_uuid !== candidate.policy.policy_uuid
      || current.schedule.schedule_uuid !== candidate.schedule.schedule_uuid
      || current.schedule.condition_policy_uuid !== candidate.policy.policy_uuid) return false;
  if (current.policy.zone_uuid !== candidate.policy.zone_uuid || current.zone.zone_uuid !== candidate.zone.zone_uuid) return false;
  if (current.device.type_id !== 'STREGA_VALVE' || current.device.irrigation_zone_id !== current.zone.id) return false;
  return true;
}

function sameRevision(current, candidate) {
  return Number(current.policy.sync_version) === Number(candidate.policy.sync_version)
    && Number(current.schedule.sync_version) === Number(candidate.schedule.sync_version);
}

async function nextDueForValve(tx, schedule, dueAt) {
  const rows = await tx.all("SELECT * FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND kind='WEEKLY' AND enabled=1 AND deleted_at IS NULL", [schedule.device_eui]);
  const dueMs = parseInstant(dueAt);
  if (dueMs == null) return null;
  const from = new Date(dueMs + 1).toISOString();
  const to = new Date(dueMs + NEXT_OCCURRENCE_HORIZON_MS).toISOString();
  const next = [];
  for (const row of rows || []) {
    for (const occurrence of occurrences.occurrencesBetween(row, from, to)) next.push(occurrence);
  }
  next.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.schedule_uuid.localeCompare(b.schedule_uuid));
  return next[0] || null;
}

function evidenceBase({ candidate, current, due, now, evaluation, observation, readiness, reason, qualification }) {
  return {
    due_at: due.dueAt, timezone: current.policy.timezone, policy_uuid: current.policy.policy_uuid,
    schedule_uuid: current.schedule.schedule_uuid, policy_sync_version: current.policy.sync_version,
    schedule_sync_version: current.schedule.sync_version, reason: reason || null,
    condition: current.policy.condition, evaluation: evaluation || null, observation: observation || null,
    readiness: readiness || null, qualification: qualification || null,
    qualification_context: { device_eui: current.schedule.device_eui, identity: qualification && qualification.identity || null },
    selected_at: now, requested_duration_minutes: Number(current.schedule.duration_minutes),
    source_policy: candidate.policy.policy_uuid,
  };
}

function staleEvidence(candidate, current, reason, now) {
  const policy = current && current.policy || candidate.policy;
  const schedule = current && current.schedule || candidate.schedule;
  return {
    due_at: candidate.due.dueAt, timezone: policy.timezone, policy_uuid: candidate.policy.policy_uuid,
    schedule_uuid: candidate.schedule.schedule_uuid, policy_sync_version: candidate.policy.sync_version,
    schedule_sync_version: candidate.schedule.sync_version, reason,
    current_policy_sync_version: current && current.policy.sync_version || null,
    current_schedule_sync_version: current && current.schedule.sync_version || null,
    current_zone_uuid: current && current.zone.zone_uuid || null,
    current_device_eui: current && current.schedule.device_eui || null,
    requested_duration_minutes: Number(schedule.duration_minutes), selected_at: now,
  };
}

async function decideSkippedTx(tx, occurrence, { decision, reason, evidence, dueAt, now }) {
  const transitioned = await policyStore.transitionOccurrenceTx(tx, occurrence, {
    state: 'SKIPPED', decision, decision_reason: reason,
    decision_evidence_json: JSON.stringify(evidence), decision_at: now,
  }, { now });
  await policyStore.updateRuntimeStateTx(tx, { last_decided_due_at: dueAt, updated_at: now });
  return { kind: 'skipped', occurrence: transitioned.occurrence, reason };
}

function accountingBlocksUnknown(accounting, localDays, nowMs, minimumGapMinutes) {
  if (accounting.unknown_duration_command_ids && accounting.unknown_duration_command_ids.length) return true;
  return (accounting.unknown_intervals || []).some((interval) => {
    if (interval.possible_start_unbounded || interval.possible_end_unbounded) return true;
    const affected = new Set(interval.affected_local_days || []);
    if (localDays.some((day) => affected.has(day))) return true;
    const possibleEndMs = parseInstant(interval.possible_end_at);
    const gapMs = Number(minimumGapMinutes) * 60 * 1000;
    return Number.isFinite(possibleEndMs) && Number.isFinite(nowMs)
      && Number.isFinite(gapMs) && gapMs >= 0 && nowMs < possibleEndMs + gapMs;
  });
}

async function recoverExistingOwner(db, occurrence, now) {
  if (!occurrence || occurrence.command_id == null) return null;
  const ownerRow = await db.get(
    'SELECT expectation_id, device_eui, transport_json FROM valve_actuation_expectations WHERE command_id=? AND UPPER(device_eui)=UPPER(?) ORDER BY rowid DESC LIMIT 1',
    [occurrence.command_id, occurrence.device_eui],
  );
  if (!ownerRow) return null;
  const transport = jsonObject(ownerRow.transport_json, {});
  if (!['INTENT', 'ATTEMPTED', 'ACCEPTED'].includes(String(transport.phase || ''))) return null;
  const recovered = await dispatch.recoverValveCommand({
    db,
    deviceEui: ownerRow.device_eui,
    owner: { type: 'expectation', id: ownerRow.expectation_id },
    now,
  });
  const current = await policyStore.getOccurrence(db, {
    schedule_uuid: occurrence.schedule_uuid,
    local_date: occurrence.local_date,
    local_time: occurrence.local_time,
  });
  return { kind: 'recovered', occurrence: current || occurrence, recovery: recovered };
}

async function prepareCandidate(options, candidate) {
  const { db, nowMs } = options;
  const key = occurrenceKey(candidate.schedule, candidate.due);

  return dispatch.withValveWriters(candidate.valve_euis, async () => {
    const writerNowMs = optionNowMs(options, nowMs);
    const writerNow = isoNow(writerNowMs);
    const existingBefore = await policyStore.getOccurrence(db, key);
    if (existingBefore && existingBefore.state === 'ATTEMPTED') {
      const recovered = await recoverExistingOwner(db, existingBefore, writerNow);
      if (recovered) return recovered;
    }
    if (existingBefore && !['PENDING', 'CLAIMED', 'RESERVED'].includes(existingBefore.state)) return { kind: 'replay', occurrence: existingBefore };
    const candidateBounds = await clockBounds.readClockBounds(db, candidate.policy.condition, candidate.zone.id);
    if (candidateBounds.latestSampleUnknown) throw new WorkerError('clock_untrusted', 'indexed timestamp bound is malformed', { reason: 'clock_untrusted_lower_bound' });
    const checked = await clockStatus({ ...options, nowMs: writerNowMs }, candidateBounds);
    trustedOrThrow(checked);
    clockBounds.assertClockBoundsAtActivation(candidateBounds, writerNowMs);
    const prepared = await db.transaction(async (tx) => {
      const existing = await policyStore.getOccurrenceTx(tx, key);
      const current = await currentCandidateTx(tx, candidate);
      const bounds = await clockBounds.readClockBounds(
        tx,
        current ? current.policy.condition : candidate.policy.condition,
        current ? current.zone.id : candidate.zone.id,
      );
      if (bounds.latestSampleUnknown) throw new WorkerError('clock_untrusted', 'indexed timestamp bound is malformed', { reason: 'clock_untrusted_lower_bound' });
      clockBounds.assertClockBoundsAtActivation(bounds, writerNowMs);
      if (existing && !['PENDING', 'CLAIMED', 'RESERVED'].includes(existing.state)) return { kind: 'replay', occurrence: existing };
      if (!activeAuthority(current, candidate)) {
        let stale = existing;
        if (!stale) {
          stale = await policyStore.insertOccurrenceTx(tx, {
            ...key, policy_uuid: candidate.policy.policy_uuid, zone_uuid: candidate.policy.zone_uuid,
            device_eui: candidate.schedule.device_eui, due_at: candidate.due.dueAt,
            policy_revision: candidate.policy.sync_version, schedule_revision: candidate.schedule.sync_version,
            policy_sync_version: candidate.policy.sync_version, schedule_sync_version: candidate.schedule.sync_version,
          });
        }
        if (['PENDING', 'CLAIMED'].includes(stale.state)) {
          return decideSkippedTx(tx, stale, {
            decision: 'SKIPPED', reason: 'scope_lost', dueAt: candidate.due.dueAt, now: writerNow,
            evidence: staleEvidence(candidate, current, 'scope_lost', writerNow),
          });
        }
        return { kind: 'scope_lost', occurrence: stale };
      }
      if (!sameRevision(current, candidate)) {
        let stale = existing;
        if (!stale) {
          stale = await policyStore.insertOccurrenceTx(tx, {
            ...key, policy_uuid: candidate.policy.policy_uuid, zone_uuid: candidate.policy.zone_uuid,
            device_eui: candidate.schedule.device_eui, due_at: candidate.due.dueAt,
            policy_revision: candidate.policy.sync_version, schedule_revision: candidate.schedule.sync_version,
            policy_sync_version: candidate.policy.sync_version, schedule_sync_version: candidate.schedule.sync_version,
          });
        }
        if (['PENDING', 'CLAIMED'].includes(stale.state)) {
          return decideSkippedTx(tx, stale, {
            decision: 'SKIPPED', reason: 'revision_conflict', dueAt: candidate.due.dueAt, now: writerNow,
            evidence: staleEvidence(candidate, current, 'revision_conflict', writerNow),
          });
        }
        return { kind: 'revision_conflict', occurrence: stale };
      }
      if (existing && ['PENDING', 'CLAIMED'].includes(existing.state)
          && (Number(existing.policy_sync_version) !== Number(current.policy.sync_version)
            || Number(existing.schedule_sync_version) !== Number(current.schedule.sync_version))) {
        return decideSkippedTx(tx, existing, {
          decision: 'SKIPPED', reason: 'revision_conflict', dueAt: candidate.due.dueAt, now: writerNow,
          evidence: staleEvidence(candidate, current, 'revision_conflict', writerNow),
        });
      }

      if (existing && existing.state === 'RESERVED') {
        const expectation = existing.command_id && await tx.get('SELECT * FROM valve_actuation_expectations WHERE command_id=? AND UPPER(device_eui)=UPPER(?) ORDER BY rowid DESC LIMIT 1', [existing.command_id, current.schedule.device_eui]);
        const transportState = jsonObject(expectation && expectation.transport_json, {});
        if (!expectation || !transportState.effect_snapshot) return { kind: 'dispatch_unknown', occurrence: existing, reason: 'effect_snapshot_missing' };
        return {
          kind: 'resume', occurrence: existing, owner: { type: 'expectation', id: expectation.expectation_id },
          device_eui: current.schedule.device_eui,
          frame: { fPort: transportState.effect_snapshot.fPort, data: transportState.effect_snapshot.data, confirmed: false, encrypted: false, provenance: transportState.effect_snapshot.provenance },
          expiresAt: existing.expires_at, qualification: transportState.effect_snapshot.qualification,
          policy: current.policy, schedule: current.schedule,
        };
      }

      let occurrence = existing;
      if (!occurrence) {
        occurrence = await policyStore.insertOccurrenceTx(tx, {
          ...key, policy_uuid: current.policy.policy_uuid, zone_uuid: current.policy.zone_uuid,
          device_eui: current.schedule.device_eui, due_at: candidate.due.dueAt,
          policy_revision: current.policy.sync_version, schedule_revision: current.schedule.sync_version,
          policy_sync_version: current.policy.sync_version, schedule_sync_version: current.schedule.sync_version,
        });
      }
      const claimed = await policyStore.claimOccurrenceTx(tx, key, { now: writerNow, policySyncVersion: current.policy.sync_version, scheduleSyncVersion: current.schedule.sync_version });
      if (!claimed.claimed) return { kind: 'replay', occurrence: claimed.occurrence };
      occurrence = claimed.occurrence;

      const window = occurrences.decisionWindow(candidate.due.dueAt, writerNow);
      if (!window.eligible) {
        if (window.reason === 'missed_start') {
          return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: 'missed_start', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, reason: 'missed_start' }) });
        }
        return { kind: 'not_due', occurrence };
      }

      const readiness = await push.conditionalReadinessTx(tx, current.schedule.device_eui);
      if (!readiness.ready) {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: 'plan_update_pending', dueAt: candidate.due.dueAt, now: writerNow, readiness, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, reason: 'plan_update_pending' }) });
      }
      const settings = await valveStore.getSettings(tx, current.schedule.device_eui);
      if (String(settings.scheduler_status || '').toUpperCase() === 'SKIP_TODAY' && String(settings.skip_today_date || '') === String(candidate.due.local_date)) {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: 'skip_today', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, reason: 'skip_today' }) });
      }
      // R13-M1: Pause on the valve (scheduler_status DEACTIVATED, the tile's and the cloud's
      // SET_VALVE_SCHEDULER_STATUS) stops conditional openings until Resume, like skip-today.
      if (String(settings.scheduler_status || '').toUpperCase() === 'DEACTIVATED') {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: 'scheduler_paused', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, reason: 'scheduler_paused' }) });
      }
      // R17-M1 / D18: VWC as a control input is gated (default off). An existing VWC policy is
      // inactive while the gate is off: skipped and surfaced, never evaluated or treated as met.
      if (policyStore.isVwcCondition(current.policy.condition) && !(await policyStore.vwcConditionEnabled(tx))) {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: 'vwc_condition_disabled', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, reason: 'vwc_condition_disabled' }) });
      }
      const control = await valveStore.conditionalControl(tx, current.schedule.device_eui);
      if (control.incident && control.incident.state !== 'RECONCILED') {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: 'unexpected_watering', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, reason: 'unexpected_watering' }) });
      }

      const readEvidence = options.readEvidence || observations.readEvidence;
      const observation = await readEvidence({ db: tx, policy: current.policy, dueAt: candidate.due.dueAt });
      const evaluation = evaluate.evaluateCondition(current.policy.condition, observation, candidate.due.dueAt, current.policy.observation_window_minutes);
      if (evaluation.status !== 'MET') {
        const reason = conditionReason(evaluation, observation);
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: evaluation.status === 'NOT_MET' ? 'NOT_MET' : 'UNKNOWN', reason, dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, evaluation, observation, reason }) });
      }

      const action = actionFromEvidence(observation, evaluation);
      const qualification = effects.qualificationResult(options.qualificationProvider, { device_eui: current.schedule.device_eui, policy: current.policy, schedule: current.schedule, due_at: candidate.due.dueAt, evaluation });
      if (!qualification.qualified) {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: qualification.reason || 'qualification_unavailable', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, evaluation, observation, reason: qualification.reason || 'qualification_unavailable', qualification }) });
      }

      let effectiveDuration;
      try { effectiveDuration = model.durationFor(current.policy.condition, Number(current.schedule.duration_minutes), action); }
      catch (error) {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'UNKNOWN', reason: 'sensor_unavailable', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, evaluation, observation, reason: 'invalid_duration', qualification }) });
      }
      const next = await nextDueForValve(tx, current.schedule, candidate.due.dueAt);
      const interval = effects.resolveDeliveryInterval({ policy: current.policy, device_eui: current.schedule.device_eui }).interval_minutes;
      const computed = model.actualOccurrenceBounds({ dueAt: candidate.due.dueAt, nextDueAt: next && next.dueAt, maxDurationMinutes: maxDurationMinutes(current.policy, current.schedule), gapMinutes: Number(current.policy.min_interval_minutes), deliveryIntervalMinutes: interval, qualificationMarginSeconds: qualification.margin_seconds, timezone: current.policy.timezone, reservationStartAt: writerNow });
      if (!computed.ok || !computed.value) {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: 'command_expired', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, evaluation, observation, reason: computed.error || 'invalid_occurrence_bounds', qualification }) });
      }
      const bound = computed.value;
      const latestPhysicalStartMs = parseInstant(bound.latest_physical_start_at);
      const queueExpiresMs = parseInstant(bound.queue_expires_at);
      const reservationEndMs = latestPhysicalStartMs == null ? null : latestPhysicalStartMs + effectiveDuration * 60000;
      const reservationEnd = reservationEndMs == null ? null : new Date(reservationEndMs).toISOString();
      const localDays = reservationEndMs == null ? [] : model.localDaysForInterval(writerNowMs, reservationEndMs, current.policy.timezone);
      if (queueExpiresMs == null || queueExpiresMs <= writerNowMs || !reservationEnd || !localDays.length) {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: 'command_expired', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, evaluation, observation, reason: 'command_expired', qualification }) });
      }

      const accounting = await dispatch.getDailyAccountingTx(tx, { deviceEui: current.schedule.device_eui, timezone: current.policy.timezone });
      if (accountingBlocksUnknown(accounting, localDays, writerNowMs, Number(current.policy.min_interval_minutes))) {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: 'recent_irrigation', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, evaluation, observation, reason: 'recent_irrigation', qualification }) });
      }
      if (localDays.some((day) => Number(accounting.days[day] || 0) + effectiveDuration > Number(current.policy.max_daily_minutes))) {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: 'daily_limit', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, evaluation, observation, reason: 'daily_limit', qualification }) });
      }
      if (await dispatch.hasBlockingObservation(tx, current.schedule.device_eui)) {
        trustedOrThrow(checked);
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason: 'recent_irrigation', dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, evaluation, observation, reason: 'recent_irrigation', qualification }) });
      }

      const commandId = crypto.randomUUID();
      const conflict = await dispatch.findValveConflictTx(tx, current.schedule.device_eui, commandId, writerNow, { policy: current.policy, delivery_settings: current.policy.delivery_settings, clock: checked, qualificationProvider: () => qualification, current_state: current.device.current_state, current_state_at: current.device.updated_at });
      if (conflict) {
        trustedOrThrow(checked);
        const reason = conflict.transport_phase ? 'plan_update_pending' : 'valve_busy';
        return decideSkippedTx(tx, occurrence, { decision: 'SKIPPED', reason, dueAt: candidate.due.dueAt, now: writerNow, evidence: evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, evaluation, observation, reason, qualification }) });
      }

      const exclusionEnd = new Date(reservationEndMs + Number(current.policy.min_interval_minutes) * 60000).toISOString();
      const decisionEvidence = evidenceBase({ candidate, current, due: candidate.due, now: writerNow, readiness, evaluation, observation, reason: 'condition_met', qualification });
      decisionEvidence.bounds = { ...bound, future_effect_end: reservationEnd, reservation_end_at: reservationEnd, local_days: localDays, exclusion_end_at: exclusionEnd };
      const command = {
        device_eui: current.schedule.device_eui, command_id: commandId, action: 'OPEN_FOR_DURATION_CONDITIONAL',
        duration_minutes: effectiveDuration, effective_duration_minutes: effectiveDuration,
        zone_id: current.zone.id, trigger: 'conditional', conditional: true, occurrence: key,
        expires_at: bound.queue_expires_at, reservation_start_at: writerNow, reservation_end_at: reservationEnd,
        exclusion_end_at: exclusionEnd, minimum_gap_minutes: Number(current.policy.min_interval_minutes),
        timezone: current.policy.timezone, local_days: localDays, decision: 'IRRIGATE', decision_reason: 'condition_met',
        decision_at: writerNow, decision_evidence_json: JSON.stringify(decisionEvidence),
      };
      await policyStore.transitionOccurrenceTx(tx, occurrence, {
        expires_at: bound.queue_expires_at,
        updated_at: writerNow,
      }, { now: writerNow });
      occurrence = await policyStore.getOccurrenceTx(tx, key);
      const fixedQualificationProvider = () => qualification;
      const reserved = await dispatch.reserveValveCommandTx(tx, command, writerNow, { policy: current.policy, delivery_settings: current.policy.delivery_settings, qualificationProvider: fixedQualificationProvider, qualificationContext: { device_eui: current.schedule.device_eui, identity: qualification.identity }, current_state: current.device.current_state, current_state_at: current.device.updated_at });
      if (!reserved.expectation || !reserved.occurrence) throw new WorkerError('reservation_missing', 'conditional reservation did not create its owners');
      const frame = { fPort: 2, data: Buffer.from([0x41, effectiveDuration]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder', encoder: 'strega-v1' } };
      await dispatch.captureEffectSnapshotTx(tx, { type: 'expectation', id: reserved.expectation.expectation_id }, frame, { device_eui: current.schedule.device_eui, policy: current.policy, delivery_settings: current.policy.delivery_settings, minimum_gap_minutes: Number(current.policy.min_interval_minutes), qualificationProvider: fixedQualificationProvider, qualificationContext: { device_eui: current.schedule.device_eui, identity: qualification.identity } });
      return { kind: 'reserved', occurrence: await policyStore.getOccurrenceTx(tx, key), owner: { type: 'expectation', id: reserved.expectation.expectation_id }, device_eui: current.schedule.device_eui, frame, expiresAt: bound.queue_expires_at, qualification, policy: current.policy, schedule: current.schedule };
    });

    if (prepared.kind === 'reserved' || prepared.kind === 'resume') {
      const dispatchNowMs = optionNowMs(options, writerNowMs);
      const dispatchNow = isoNow(dispatchNowMs);
      const finalClock = await clockStatus({ ...options, nowMs: dispatchNowMs }, { lastDue: prepared.occurrence && prepared.occurrence.due_at });
      if (finalClock.trusted !== true) return { kind: 'deferred', reason: 'clock_untrusted', occurrence: prepared.occurrence };
      const currentQualification = effects.qualificationResult(options.qualificationProvider, { device_eui: prepared.device_eui, qualification_context: prepared.qualification && prepared.qualification.identity ? { device_eui: prepared.device_eui, identity: prepared.qualification.identity } : {} });
      try {
        const sent = await dispatch.enqueueValveCommand({
          db, deviceEui: prepared.device_eui, owner: prepared.owner,
          item: { devEui: prepared.device_eui, fPort: prepared.frame.fPort, data: prepared.frame.data, confirmed: false, encrypted: false, provenance: prepared.frame.provenance, expiresAt: prepared.expiresAt },
          transport: options.transport || { async enqueueDownlink() { throw new WorkerError('transport_unavailable', 'transport is unavailable'); } },
          now: dispatchNow, trustedContext: { runtimeNow: () => dispatchNowMs, clockOptions: options.clockOptions || {}, currentQualification },
        });
        await db.transaction((tx) => policyStore.updateRuntimeStateTx(tx, { last_decided_due_at: prepared.occurrence.due_at, updated_at: dispatchNow }));
        return sent.accepted ? { kind: 'dispatched', result: sent, occurrence: prepared.occurrence } : { kind: 'dispatch_unknown', result: sent, occurrence: prepared.occurrence };
      } catch (error) {
        if (error && error.code === 'command_expired') {
          await db.transaction(async (tx) => {
            const row = await policyStore.getOccurrenceTx(tx, prepared.occurrence);
            if (row && row.state === 'RESERVED') await policyStore.transitionOccurrenceTx(tx, row, { state: 'EXPIRED', decision_reason: 'command_expired', updated_at: dispatchNow }, { now: dispatchNow });
          });
          await db.transaction((tx) => policyStore.updateRuntimeStateTx(tx, { last_decided_due_at: prepared.occurrence.due_at, updated_at: dispatchNow }));
          return { kind: 'skipped', reason: 'command_expired', occurrence: prepared.occurrence };
        }
        if (error && ['clock_untrusted', 'qualification_revoked'].includes(error.code)) return { kind: 'deferred', reason: error.code, occurrence: prepared.occurrence };
        throw error;
      }
    }
    return prepared;
  });
}

async function runDue(options = {}) {
  const db = options.db;
  if (!db) throw new TypeError('runDue requires db');
  const nowMs = options.now === undefined ? Date.now() : options.now instanceof Date ? options.now.getTime() : typeof options.now === 'number' ? options.now : parseInstant(options.now);
  const now = isoNow(nowMs);
  const currentNow = typeof options.currentNow === 'function'
    ? options.currentNow
    : () => (options.now === undefined ? Date.now() : nowMs);
  const runtime = await policyStore.getRuntimeState(db);
  const initialClock = await clockStatus({ ...options, nowMs }, { lastDue: runtime.last_decided_due_at });
  if (initialClock.trusted !== true) return { trusted: false, reason: initialClock.reason, processed: 0, decided: 0, dispatched: 0, skipped: 0, unknown: 0, deferred: 0, errors: [] };
  const discover = typeof options.discoverCandidates === 'function' ? options.discoverCandidates : discoverCandidates;
  const candidates = await discover(db, runtime, nowMs);
  const summary = { trusted: true, reason: 'trusted', processed: candidates.length, decided: 0, dispatched: 0, skipped: 0, unknown: 0, recovered: 0, deferred: 0, errors: [] };
  let checkpointSafe = true;
  for (const candidate of candidates) {
    try {
      const result = await prepareCandidate({ ...options, db, now, nowMs, currentNow }, candidate);
      if (result.kind === 'skipped') { summary.decided += 1; summary.skipped += 1; }
      else if (result.kind === 'dispatched') { summary.decided += 1; summary.dispatched += 1; }
      else if (result.kind === 'dispatch_unknown') { summary.decided += 1; summary.unknown += 1; }
      else if (result.kind === 'recovered') {
        summary.decided += 1;
        summary.recovered += 1;
        if (result.recovery && result.recovery.phase === 'UNKNOWN') summary.unknown += 1;
      }
      else if (result.kind === 'deferred') { summary.deferred += 1; checkpointSafe = false; }
      else if (result.kind === 'not_due') checkpointSafe = false;
      else if (result.kind === 'scope_lost' || result.kind === 'revision_conflict') {
        summary.errors.push({ schedule_uuid: candidate.schedule.schedule_uuid, reason: result.kind });
        checkpointSafe = false;
      }
    } catch (error) {
      summary.errors.push({ schedule_uuid: candidate.schedule.schedule_uuid, code: error && error.code || 'due_worker_error', message: String(error && error.message || error) });
      checkpointSafe = false;
    }
  }
  // The checkpoint advances only after the complete bounded audit has been
  // processed. Errors and deferred owners remain behind the cursor until they
  // produce a durable terminal result; durable-owner discovery also keeps
  // existing unfinished rows reachable after the moving audit window.
  if (checkpointSafe) await db.transaction((tx) => policyStore.updateRuntimeStateTx(tx, { last_trusted_tick_at: now, updated_at: now }));
  return summary;
}

module.exports = { runDue, discoverCandidates };
