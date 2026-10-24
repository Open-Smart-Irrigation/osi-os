'use strict';
const crypto = require('node:crypto');
const P = require('./plan');
const store = require('./store');
const push = require('./push');
const { interpretUplink } = require('./ack');
const runtime = require('./runtime');
const dispatch = require('./dispatch');

const ONCE_GRACE_MS = 10 * 60 * 1000;
const STALE_PUSH_MS = 24 * 3600 * 1000;
const CLOCK_PERIOD_MS = 7 * 86400000;
const DOWNLINK_LATENCY_BUDGET_SEC = 120;
// (Valve advanced controls consolidation, Task 4b) a SET_PARTIAL_OPENING/SET_FLUSHING
// command is one-shot with no auto-close (E4) and write-strega-expectation deliberately
// does not write an expectation for it (actuator: false, config-class command) - so an
// OPEN uplink that follows one looks identical, at the observe tick, to a Bluetooth-opened
// valve. runObserveTick disambiguates by consulting actuator_log (Task 4 now carries the
// percentage there) for a recent service command on the same deveui before crediting
// 'unexplained'. 24h matches the same watch horizon already used for a genuinely
// unexplained open (see expectedClose below) - a service command older than that is
// treated as stale and no longer explains a fresh open.
const SERVICE_ACTION_LOOKBACK_MS = 24 * 3600 * 1000;
const onceClaimQueues = new WeakMap();

function verifiedConditionalClearAck({ row, status, generation } = {}) {
  const gen = String(generation || 'GEN1').toUpperCase();
  const payload = String(row && row.payload_hex || '').replace(/^0x/i, '').toUpperCase();
  if (gen === 'GEN2') return row && row.purpose === 'DAYMASK_PLAN' && status === 1 && payload === '80';
  const emptyGen1 = Buffer.from(P.encodeGen1Day([])).toString('hex').toUpperCase();
  return row && row.purpose === 'WEEKDAY_PLAN' && status === 0 && payload === emptyGen1;
}

function observationInstant(value) {
  const ms = store.parseAckInstant(value);
  return Number.isFinite(ms) ? ms : null;
}

function observationIdentity(value) {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch (_) { return null; }
}

function observationProof(checked) {
  return {
    checked_at: Number.isFinite(checked && checked.now) ? new Date(checked.now).toISOString() : null,
    boot_id: checked && checked.receipt ? checked.receipt.boot_id : null,
    uptime_ms: checked && checked.receipt ? checked.receipt.uptime_ms : null,
  };
}

function canonicalUtcInstant(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  return new Date(milliseconds).toISOString().slice(0, 19) === match[1];
}

function legacyV1CompatibilityForRow(row) {
  if (!row || row.command_id != null || row.trigger !== 'on_valve_schedule') return null;
  if (!Number.isSafeInteger(row.commanded_duration_seconds) || row.commanded_duration_seconds <= 0
      || !canonicalUtcInstant(row.commanded_at) || !canonicalUtcInstant(row.expected_close_at)) return null;
  const physicalRun = dispatch.parsePhysicalRun(row);
  if (physicalRun.report_only || physicalRun.malformed || physicalRun.marker) return null;
  let transport;
  try {
    transport = row.transport_json == null || row.transport_json === ''
      ? {}
      : (typeof row.transport_json === 'string' ? JSON.parse(row.transport_json) : row.transport_json);
  } catch (_) {
    return null;
  }
  if (!transport || typeof transport !== 'object' || Array.isArray(transport) || transport.physical_run != null) return null;
  return {
    version: 1,
    source: 'preexisting_on_valve_schedule',
    expectation_id: row.expectation_id,
    commanded_at: row.commanded_at,
    commanded_duration_seconds: row.commanded_duration_seconds,
    expected_close_at: row.expected_close_at,
  };
}

function legacyPhysicalRunMarker(compatibility) {
  return {
    version: 1,
    source: 'explicit_report',
    earliest_possible_start_at: null,
    latest_possible_end_at: null,
    ...(compatibility ? { legacy_v1_compatibility: compatibility } : {}),
  };
}

function persistedTransport(row) {
  if (!row || row.transport_json == null || row.transport_json === '') return {};
  try {
    const transport = typeof row.transport_json === 'string' ? JSON.parse(row.transport_json) : row.transport_json;
    return transport && typeof transport === 'object' && !Array.isArray(transport) ? transport : null;
  } catch (_) {
    return null;
  }
}

function isV1ReplicableLegacyCandidate(row) {
  if (!row || row.command_id != null || row.trigger !== 'on_valve_schedule') return false;
  if ((row.commanded_duration_seconds === -1 || row.commanded_duration_seconds === '-1') && row.expected_close_at === '') return false;
  const transport = persistedTransport(row);
  return Boolean(transport && transport.physical_run == null);
}

async function selectLegacyObservationTx(tx, deviceEui, row) {
  const rows = await tx.all("SELECT * FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?) AND command_id IS NULL AND trigger='on_valve_schedule' AND observed_close_at IS NULL AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING','STALE_OPEN_OBSERVED')", [deviceEui]);
  const candidates = rows.filter(isV1ReplicableLegacyCandidate);
  if (candidates.length > 1) return { blocked: true, reason: 'ambiguous_legacy_recovery' };
  if (row && isV1ReplicableLegacyCandidate(row)) {
    if (candidates.length !== 1 || candidates[0].expectation_id !== row.expectation_id) return { blocked: true, reason: 'ambiguous_legacy_recovery' };
    if (!legacyV1CompatibilityForRow(row)) return { blocked: true, reason: 'unsupported_legacy_recovery' };
    return { row };
  }
  if (!row && candidates.length === 1) {
    if (!legacyV1CompatibilityForRow(candidates[0])) return { blocked: true, reason: 'unsupported_legacy_recovery' };
    return { row: candidates[0] };
  }
  return { row: row || null };
}

function observationState(control) {
  const value = control && control.observation;
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function appendUntrustedObservation(state, report) {
  const rows = Array.isArray(state.untrusted_reports) ? state.untrusted_reports.slice(-31) : [];
  rows.push(report);
  state.untrusted_reports = rows;
}

async function writeObservationControlTx(tx, deviceEui, control, observation) {
  await store.writeConditionalControl(tx, deviceEui, { ...control, observation });
}

async function ensureObservationIncidentTx(tx, deviceEui, control, physicalRunId, at, conditionalConfigured = false) {
  if (control.mode !== 'CONDITIONAL' && !conditionalConfigured) return control.incident || null;
  const current = control.incident && store.parseIncident(control.incident);
  if (current && current.state !== 'RECONCILED' && current.physical_run_reference === physicalRunId) return current;
  return store.updateConditionalIncidentTx(tx, deviceEui, {
    incident_id: crypto.randomUUID(), physical_run_reference: physicalRunId,
    ended: false, ended_at: null, reconciled_at: null, state: 'OPEN', retry_revision: null, created_at: at,
  });
}

async function syntheticObservationTx(tx, deviceEui, reportAt, proof, control, { trusted, reason, conditionalConfigured = false, anchorAt } = {}) {
  const storedAt = anchorAt || reportAt;
  const observation = observationState(control);
  let physicalRunId = observation.physical_run_id || null;
  let row = physicalRunId ? await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=? AND UPPER(device_eui)=UPPER(?)', [physicalRunId, deviceEui]) : null;
  let fallbackRows = [];
  if (!row) fallbackRows = await tx.all("SELECT * FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?) AND command_id IS NULL AND trigger IN ('unexplained','on_valve_schedule','service_action') AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING','STALE_OPEN_OBSERVED') ORDER BY created_at DESC", [deviceEui]);
  const selected = await selectLegacyObservationTx(tx, deviceEui, row);
  if (selected.blocked) return { blocked: true, reason: selected.reason, physicalRunId: null, incident: null };
  if (selected.row) row = selected.row;
  else if (!row) row = fallbackRows[0] || null;
  if (!row) {
    physicalRunId = crypto.randomUUID();
    row = { expectation_id: physicalRunId };
    const transport = {
      physical_run: { version: 1, source: 'explicit_report', earliest_possible_start_at: null, latest_possible_end_at: null },
      observation: { source: 'explicit_report', proof: trusted ? proof : null, untrusted: trusted ? null : reason },
    };
    await tx.run("INSERT INTO valve_actuation_expectations(expectation_id,device_eui,zone_id,command_id,effect_key,commanded_at,commanded_duration_seconds,expected_close_at,volume_source,observed_open_at,reconciliation_state,created_at,trigger,transport_json) SELECT ?,UPPER(d.deveui),d.irrigation_zone_id,NULL,NULL,?,?,?,'unknown',?,?,?,'unexplained',? FROM devices d WHERE UPPER(d.deveui)=UPPER(?)", [physicalRunId, storedAt, -1, '', trusted ? reportAt : null, 'OBSERVED_RUNNING', storedAt, JSON.stringify(transport), deviceEui]);
    row = await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [physicalRunId]);
  } else if (!row.command_id) {
    let transport;
    try { transport = row.transport_json ? JSON.parse(row.transport_json) : {}; }
    catch (_) { transport = {}; }
    const marker = dispatch.parsePhysicalRun(row);
    if (!marker.marker || marker.malformed) {
      transport.physical_run = legacyPhysicalRunMarker(legacyV1CompatibilityForRow(row));
    }
    if (trusted && row.observed_open_at == null) {
      transport.physical_run = { ...(transport.physical_run || legacyPhysicalRunMarker(null)), latest_possible_end_at: null };
      transport.observation = { ...(transport.observation || {}), source: 'explicit_report', proof, untrusted: null };
      await tx.run("UPDATE valve_actuation_expectations SET observed_open_at=?, reconciliation_state='OBSERVED_RUNNING', transport_json=? WHERE expectation_id=?", [reportAt, JSON.stringify(transport), row.expectation_id]);
    } else if (marker.malformed || !marker.marker) {
      await tx.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify(transport), row.expectation_id]);
    }
  }
  const incident = await ensureObservationIncidentTx(tx, deviceEui, control, row.expectation_id, storedAt, conditionalConfigured);
  return { row, physicalRunId: row.expectation_id, incident };
}

async function finalizeEndedIncidentTx(tx, deviceEui, control, physicalRunId, reconciledAt) {
  const incident = control.incident && store.parseIncident(control.incident);
  if (!incident || incident.physical_run_reference !== physicalRunId || incident.ended !== true || incident.state !== 'ENDED') return incident;
  if (!control.desired_revision || incident.retry_revision !== control.desired_revision) return incident;
  try {
    return await push.finalizeConditionalIncidentTx(tx, deviceEui, {
      revision: control.desired_revision,
      physical_run_reference: physicalRunId,
      reconciled_at: reconciledAt,
    });
  } catch (error) {
    // ACK arrival and observation arrival are independent.  The incident stays
    // durably ENDED until the later ACK/retry path supplies the missing proof.
    if (['conditional_clear_not_ready', 'conditional_revision_changed', 'conditional_incident_retry_required', 'conditional_incident_reference_mismatch', 'conditional_incident_evidence_required'].includes(error && error.code)) return incident;
    throw error;
  }
}

async function updateLinkedOpenTx(tx, linked, reportAt, proof) {
  const transport = linked.transport_json ? JSON.parse(linked.transport_json) : {};
  transport.observation = { ...(transport.observation || {}), source: 'explicit_report', report_only: !linked.command_id, proof, observed_at: reportAt };
  await tx.run("UPDATE valve_actuation_expectations SET observed_open_at=COALESCE(observed_open_at,?), reconciliation_state='OBSERVED_RUNNING', transport_json=? WHERE expectation_id=?", [reportAt, JSON.stringify(transport), linked.expectation_id]);
  if (linked.command_id) await tx.run('UPDATE irrigation_occurrences SET observed_open_at=COALESCE(observed_open_at,?), updated_at=? WHERE command_id=?', [reportAt, reportAt, linked.command_id]);
}

async function updateAuthoritativeStateTx(tx, deviceEui, state, reportedAt) {
  await tx.run(
    "UPDATE devices SET current_state=?, updated_at=?, sync_version=COALESCE(sync_version, 0) + 1 WHERE UPPER(deveui)=UPPER(?) AND COALESCE(UPPER(current_state), '') <> ?",
    [state, reportedAt, deviceEui, state]
  );
}

async function ensurePhysicalRunEventTx(tx, row, observedCloseAt, warn) {
  if (!row || row.command_id != null || !row.expectation_id) return false;
  if (!['on_valve_schedule', 'unexplained'].includes(String(row.trigger || ''))) return false;
  const owner = await tx.get('SELECT d.user_id, d.irrigation_zone_id FROM devices d WHERE UPPER(d.deveui)=UPPER(?) AND d.deleted_at IS NULL', [row.device_eui]);
  if (!owner || owner.user_id == null || owner.irrigation_zone_id == null) {
    if (typeof warn === 'function') warn('[valve-control] observed run not logged for ' + row.device_eui + ' (no zone/user), expectation ' + row.expectation_id);
    return false;
  }
  const marker = '%' + String(row.expectation_id).replace(/[%_]/g, (value) => '\\' + value) + '%';
  const existing = await tx.get("SELECT id FROM irrigation_events WHERE action='IRRIGATE' AND payload_json LIKE ? ESCAPE '\\' LIMIT 1", [marker]);
  if (existing) return false;
  const reason = row.trigger === 'on_valve_schedule' ? 'on_valve_schedule_run' : 'unexplained_on_valve_run';
  await tx.run(
    'INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, duration_minutes, valve_deveui, payload_json) VALUES (?,?,?,?,?,?,?)',
    [owner.user_id, owner.irrigation_zone_id, 'IRRIGATE', reason, null, row.device_eui,
      JSON.stringify({ expectation_id: row.expectation_id, trigger: row.trigger || 'unexplained', observed_open_at: row.observed_open_at || null, observed_close_at: observedCloseAt || null, duration_minutes: null })]
  );
  return true;
}

async function emitObservationRuntimeTx(tx, deviceEui, expectationId, warn) {
  try { await runtime.emitRuntimeChanged(tx, deviceEui, warn); }
  catch (error) { if (typeof warn === 'function') warn('[valve-control] observation runtime emit failed: ' + String(error && error.message ? error.message : error)); }
  try { await runtime.emitActuationArchived(tx, deviceEui, expectationId, warn); }
  catch (error) { if (typeof warn === 'function') warn('[valve-control] observation archive emit failed: ' + String(error && error.message ? error.message : error)); }
}

async function recordValveObservationTx(tx, deviceEui, { observedState, observedAt, event_identity, checked, warn } = {}) {
  const state = String(observedState || '').trim().toUpperCase();
  const reportMs = observationInstant(observedAt);
  if (!['OPEN', 'CLOSED'].includes(state)) throw Object.assign(new Error('observation_invalid'), { code: 'observation_invalid' });
  const row = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [deviceEui]);
  const control = store.parseControl(row && row.conditional_control_json);
  const observation = observationState(control);
  const identity = observationIdentity(event_identity);
  const proof = observationProof(checked);
  const anchorAt = Number.isFinite(checked && checked.now) ? new Date(checked.now).toISOString() : new Date().toISOString();
  const reportAt = Number.isFinite(reportMs) ? new Date(reportMs).toISOString() : null;
  const trusted = Boolean(reportAt && checked && checked.clock && checked.clock.trusted === true && Number.isFinite(checked.now) && reportMs <= checked.now);
  const conditionalSchedule = await tx.get("SELECT 1 AS present FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND enabled=1 AND condition_policy_uuid IS NOT NULL LIMIT 1", [deviceEui]);
  const conditionalConfigured = control.mode === 'CONDITIONAL' || Boolean(conditionalSchedule);
  const reason = reportAt ? (checked && checked.clock ? checked.clock.reason : 'clock_untrusted') : 'observation_time_invalid';
  const raw = { state, reported_at: reportAt, event_identity: event_identity || null, trusted, proof, reason };
  const watermarkMs = observationInstant(observation.last_reported_at);
  if (!trusted) {
    appendUntrustedObservation(observation, raw);
    if (state === 'OPEN') {
      const synthetic = await syntheticObservationTx(tx, deviceEui, reportAt || anchorAt, proof, control, { trusted: false, reason, conditionalConfigured, anchorAt });
      if (synthetic.blocked) {
        observation.uncertain = true;
        observation.blocked_reason = synthetic.reason;
        await writeObservationControlTx(tx, deviceEui, control, observation);
        return { kind: 'blocked', reason: synthetic.reason, physical_run_id: null };
      }
      observation.physical_run_id = synthetic.physicalRunId;
      // The explicit OPEN has been classified as untrusted, so expose the
      // conservative physical state at the local arrival anchor.  The run
      // remains report-only and carries no timing or owner credit.
      await updateAuthoritativeStateTx(tx, deviceEui, state, anchorAt);
      await writeObservationControlTx(tx, deviceEui, synthetic.incident ? { ...control, incident: synthetic.incident } : control, observation);
      return { kind: 'untrusted', physical_run_id: synthetic.physicalRunId, incident: synthetic.incident };
    }
    await writeObservationControlTx(tx, deviceEui, control, observation);
    return { kind: 'untrusted', state };
  }
  if (watermarkMs != null && reportMs < watermarkMs) {
    appendUntrustedObservation(observation, { ...raw, reason: 'stale_report' });
    await writeObservationControlTx(tx, deviceEui, control, observation);
    return { kind: 'stale', state, physical_run_id: observation.physical_run_id || null };
  }
  if (watermarkMs != null && reportMs === watermarkMs) {
    const same = observation.state === state && observation.event_identity === identity;
    if (!same) {
      observation.uncertain = true;
      appendUntrustedObservation(observation, { ...raw, reason: 'equal_time_conflict' });
      await writeObservationControlTx(tx, deviceEui, control, observation);
      return { kind: 'ambiguous', state, physical_run_id: observation.physical_run_id || null };
    }
    if (state === 'CLOSED' && observation.physical_run_id) {
      const linked = await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=? AND UPPER(device_eui)=UPPER(?)', [observation.physical_run_id, deviceEui]);
      if (linked && linked.observed_close_at == null) await tx.run("UPDATE valve_actuation_expectations SET observed_close_at=?, reconciliation_state='OBSERVED_COMPLETE' WHERE expectation_id=?", [reportAt, linked.expectation_id]);
    }
    return { kind: 'duplicate', state, physical_run_id: observation.physical_run_id || null };
  }
  observation.last_reported_at = reportAt;
  observation.state = state;
  observation.event_identity = identity;
  observation.uncertain = false;
  if (state === 'OPEN') {
    // Once an explicit report has a durable open link, later reports update
    // that same run.  Matching the current owner set again could turn an
    // already observed report-only run into a timed command owner.
    if (observation.physical_run_id) {
      const linked = await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=? AND UPPER(device_eui)=UPPER(?)', [observation.physical_run_id, deviceEui]);
      if (linked && linked.observed_close_at == null && ['PENDING_OBSERVATION', 'OBSERVED_RUNNING', 'STALE_OPEN_OBSERVED'].includes(linked.reconciliation_state)) {
        if (linked.command_id) {
          await updateLinkedOpenTx(tx, linked, reportAt, proof);
          await updateAuthoritativeStateTx(tx, deviceEui, state, reportAt);
          await writeObservationControlTx(tx, deviceEui, control, observation);
          return { kind: 'linked', owner_id: linked.expectation_id, physical_run_id: linked.expectation_id };
        }
        const synthetic = await syntheticObservationTx(tx, deviceEui, reportAt, proof, control, { trusted: true, reason: 'linked_report_only', conditionalConfigured });
        if (synthetic.blocked) {
          observation.uncertain = true;
          observation.blocked_reason = synthetic.reason;
          await writeObservationControlTx(tx, deviceEui, control, observation);
          return { kind: 'blocked', reason: synthetic.reason, physical_run_id: null };
        }
        observation.physical_run_id = synthetic.physicalRunId;
        await updateAuthoritativeStateTx(tx, deviceEui, state, reportAt);
        await writeObservationControlTx(tx, deviceEui, synthetic.incident ? { ...control, incident: synthetic.incident } : control, observation);
        return { kind: 'linked', physical_run_id: synthetic.physicalRunId, incident: synthetic.incident };
      }
      observation.physical_run_id = null;
    }
    const owners = await tx.all('SELECT * FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?) ORDER BY rowid', [deviceEui]);
    const occurrences = await tx.all('SELECT * FROM irrigation_occurrences WHERE UPPER(device_eui)=UPPER(?) AND command_id IS NOT NULL', [deviceEui]);
    const occurrenceByCommand = new Map(occurrences.map((item) => [item.command_id, item]));
    const eligible = owners.map((owner) => ({ owner, result: dispatch.observationOwnerEligibility(owner, occurrenceByCommand.get(owner.command_id), deviceEui, reportAt) })).filter((item) => item.result.eligible);
    if (eligible.length === 1) {
      const owner = eligible[0].owner;
      const transport = owner.transport_json ? JSON.parse(owner.transport_json) : {};
      transport.observation = { source: 'explicit_report', report_only: false, proof, observed_at: reportAt };
      await tx.run("UPDATE valve_actuation_expectations SET observed_open_at=?, reconciliation_state='OBSERVED_RUNNING', transport_json=? WHERE expectation_id=?", [reportAt, JSON.stringify(transport), owner.expectation_id]);
      if (owner.command_id && occurrenceByCommand.has(owner.command_id)) await tx.run('UPDATE irrigation_occurrences SET observed_open_at=?, updated_at=? WHERE command_id=?', [reportAt, reportAt, owner.command_id]);
      observation.physical_run_id = owner.expectation_id;
      await updateAuthoritativeStateTx(tx, deviceEui, state, reportAt);
      await writeObservationControlTx(tx, deviceEui, control, observation);
      return { kind: 'owner', owner_id: owner.expectation_id, physical_run_id: owner.expectation_id };
    }
    const synthetic = await syntheticObservationTx(tx, deviceEui, reportAt, proof, control, { trusted: true, reason: eligible.length ? 'ambiguous_owner' : 'no_owner', conditionalConfigured });
    if (synthetic.blocked) {
      observation.uncertain = true;
      observation.blocked_reason = synthetic.reason;
      await writeObservationControlTx(tx, deviceEui, control, observation);
      return { kind: 'blocked', reason: synthetic.reason, physical_run_id: null };
    }
    observation.physical_run_id = synthetic.physicalRunId;
    await updateAuthoritativeStateTx(tx, deviceEui, state, reportAt);
    await writeObservationControlTx(tx, deviceEui, synthetic.incident ? { ...control, incident: synthetic.incident } : control, observation);
    return { kind: eligible.length ? 'ambiguous' : 'synthetic', physical_run_id: synthetic.physicalRunId, incident: synthetic.incident };
  }
  const physicalRunId = observation.physical_run_id || null;
  let controlToWrite = control;
  if (physicalRunId) {
    const linked = await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=? AND UPPER(device_eui)=UPPER(?)', [physicalRunId, deviceEui]);
    if (linked && linked.observed_close_at == null) {
      const transport = linked.transport_json ? JSON.parse(linked.transport_json) : {};
      if (!linked.command_id) {
        const physicalRun = transport.physical_run && typeof transport.physical_run === 'object'
          ? transport.physical_run
          : legacyPhysicalRunMarker(legacyV1CompatibilityForRow(linked));
        transport.physical_run = { ...physicalRun, latest_possible_end_at: reportAt };
        transport.observation = { ...(transport.observation || {}), source: 'explicit_report', observed_at: reportAt, proof, untrusted: null };
      } else {
        transport.observation = { ...(transport.observation || {}), observed_at: reportAt, proof };
      }
      await tx.run("UPDATE valve_actuation_expectations SET observed_close_at=?, reconciliation_state='OBSERVED_COMPLETE', transport_json=? WHERE expectation_id=?", [reportAt, JSON.stringify(transport), linked.expectation_id]);
      if (linked.command_id) await tx.run('UPDATE irrigation_occurrences SET observed_close_at=?, updated_at=? WHERE command_id=?', [reportAt, reportAt, linked.command_id]);
      else await ensurePhysicalRunEventTx(tx, { ...linked, observed_open_at: linked.observed_open_at }, reportAt, warn);
      await emitObservationRuntimeTx(tx, deviceEui, linked.expectation_id, warn);
      if (control.incident && control.incident.physical_run_reference === physicalRunId) {
        const incident = await store.updateConditionalIncidentTx(tx, deviceEui, { ended: true, ended_at: reportAt, state: 'ENDED' });
        const finalized = await finalizeEndedIncidentTx(tx, deviceEui, { ...control, incident }, physicalRunId, reportAt);
        controlToWrite = { ...control, incident: finalized };
      }
    }
    observation.last_physical_run_id = physicalRunId;
    observation.physical_run_id = null;
  }
  await updateAuthoritativeStateTx(tx, deviceEui, state, reportAt);
  await writeObservationControlTx(tx, deviceEui, controlToWrite, observation);
  return { kind: 'closed', physical_run_id: physicalRunId };
}

async function recordValveObservation({ db, deviceEui, observedState, observedAt, event_identity, runtimeContext, persistRawTx, warn } = {}) {
  const device = String(deviceEui || '').trim().toUpperCase();
  return dispatch.withValveWriter(device, async () => {
    const checked = dispatch.runtimeAttemptContext(runtimeContext, observedAt);
    return db.transaction(async (tx) => {
      if (typeof persistRawTx === 'function') {
        await persistRawTx(tx, { device_eui: device, observed_state: String(observedState || '').trim().toUpperCase(), observed_at: observedAt, event_identity: event_identity || null });
      }
      return recordValveObservationTx(tx, device, { observedState, observedAt, event_identity, checked, warn });
    });
  });
}

// Recovery reads only the durable explicit-report watermark/link.  It never
// treats devices.current_state or updated_at as a transition and therefore
// cannot manufacture an endpoint after restart.
async function recoverValveObservation({ db, deviceEui, now } = {}) {
  const device = String(deviceEui || '').trim().toUpperCase();
  return dispatch.withValveWriter(device, () => db.transaction(async (tx) => {
    const control = await store.conditionalControl(tx, device);
    const observation = observationState(control);
    if (!observation.last_reported_at) {
      const candidates = await tx.all("SELECT * FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?) AND command_id IS NULL AND trigger='on_valve_schedule' AND observed_open_at IS NOT NULL AND observed_close_at IS NULL AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING','STALE_OPEN_OBSERVED') ORDER BY observed_open_at DESC", [device]);
      const legacyCandidates = candidates.filter(isV1ReplicableLegacyCandidate);
      if (legacyCandidates.length > 1) return { uncertain: true, reason: 'ambiguous_legacy_recovery', physical_run_id: null };
      const adopted = legacyCandidates.length === 1 && legacyV1CompatibilityForRow(legacyCandidates[0]) ? legacyCandidates[0] : null;
      if (adopted) {
        let transport = {};
        try { transport = adopted.transport_json ? JSON.parse(adopted.transport_json) : {}; } catch (_) { transport = {}; }
        transport.physical_run = legacyPhysicalRunMarker(legacyV1CompatibilityForRow(adopted));
        await tx.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify(transport), adopted.expectation_id]);
        const adoptedObservation = { ...observation, state: 'OPEN', physical_run_id: adopted.expectation_id, uncertain: false };
        if (canonicalUtcInstant(adopted.observed_open_at)) adoptedObservation.last_reported_at = adopted.observed_open_at;
        await writeObservationControlTx(tx, device, control, adoptedObservation);
        return { recovered: true, adopted: true, state: 'OPEN', physical_run_id: adopted.expectation_id,
          reconciliation_state: adopted.reconciliation_state, observed_open_at: adopted.observed_open_at, observed_close_at: null, blocking: true };
      }
      if (legacyCandidates.length) return { uncertain: true, reason: 'unsupported_legacy_recovery', physical_run_id: null };
      return { uncertain: true, reason: 'missing_observation_watermark', physical_run_id: null };
    }
    if (!observation.physical_run_id) return { uncertain: Boolean(observation.uncertain), state: observation.state || null, physical_run_id: null };
    const row = await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=? AND UPPER(device_eui)=UPPER(?)', [observation.physical_run_id, device]);
    if (!row) return { uncertain: true, reason: 'missing_physical_run', physical_run_id: observation.physical_run_id };
    return { uncertain: Boolean(observation.uncertain), state: observation.state || null, physical_run_id: row.expectation_id,
      reconciliation_state: row.reconciliation_state, observed_open_at: row.observed_open_at || null, observed_close_at: row.observed_close_at || null,
      blocking: row.observed_close_at == null };
  }));
}

async function handleUplink({ db, deviceEui, decoded, fPort, rawBytes, receivedAt, warn }) {
  const { acks, generationHint } = interpretUplink(decoded, fPort, rawBytes || null);
  const at = receivedAt || new Date().toISOString();
  let outcome;
  try {
    outcome = await db.transaction(async (tx) => {
      let generationPromoted = false;
      if (generationHint === 'GEN2') {
        const s = await store.getSettings(tx, deviceEui);
        if (s.strega_generation !== 'GEN2') {
          const previousGeneration = String(s.strega_generation || 'GEN1').toUpperCase();
          await store.upsertSettings(tx, deviceEui, { strega_generation: 'GEN2' });
          const control = await store.conditionalControl(tx, deviceEui);
          await store.writeConditionalControl(tx, deviceEui, {
            ...control,
            fixed_generation_transition: {
              transition_id: crypto.randomUUID(),
              from: previousGeneration,
              to: 'GEN2',
              state: 'PENDING',
              promoted_at: at,
            },
          });
          generationPromoted = true;
        }
      }
      let acked = 0;
      let planAcked = false;
      const ackControl = await store.conditionalControl(tx, deviceEui);
      const ackSettings = await store.getSettings(tx, deviceEui);
      const ackGeneration = ackControl.generation || ackSettings.strega_generation || 'GEN1';
      for (const a of acks) {
        const isPlan = a.purpose === 'WEEKDAY_PLAN' || a.purpose === 'DAYMASK_PLAN';
        const ackOptions = isPlan ? {
          verifiedRule: (candidate) => verifiedConditionalClearAck({ ...candidate, generation: ackGeneration }),
          generation: ackGeneration,
          generationIdentity: ackGeneration,
        } : undefined;
        const matched = await store.ackPushTx(tx, deviceEui, a.purpose, a.fport, a.weekday, a.status, at, ackOptions);
        acked += matched;
        if (matched && a.purpose === 'CLOCK_SYNC') await store.upsertSettings(tx, deviceEui, { last_clock_sync_acked_at: at });
        if (matched && (a.purpose === 'WEEKDAY_PLAN' || a.purpose === 'DAYMASK_PLAN')) planAcked = true;
      }
      let readiness = null;
      let incidentFinalized = false;
      if (acks.some((a) => a.purpose === 'WEEKDAY_PLAN' || a.purpose === 'DAYMASK_PLAN')) {
        readiness = await push.conditionalReadinessTx(tx, deviceEui);
        if (readiness.persisted === false) throw Object.assign(new Error('conditional_readiness_cas_lost'), { code: 'conditional_readiness_cas_lost', readiness });
        if (readiness.ready === true) {
          const control = await store.conditionalControl(tx, deviceEui);
          const incident = control.incident && store.parseIncident(control.incident);
          if (incident && incident.ended === true && incident.state === 'ENDED' && incident.physical_run_reference) {
            const finalized = await finalizeEndedIncidentTx(tx, deviceEui, { ...control, incident }, incident.physical_run_reference, at);
            incidentFinalized = Boolean(finalized && finalized.state === 'RECONCILED');
          }
        }
      }
      return { acked, generationPromoted, planAcked, readiness, incidentFinalized };
    });
  } catch (error) {
    if (error && error.code === 'conditional_readiness_cas_lost') {
      warn && warn('[valve-control] handleUplink: readiness CAS lost; ACK transaction rolled back');
      return { acked: 0, generationPromoted: false, readiness: error.readiness, readinessPersisted: false, rolledBack: true };
    }
    throw error;
  }
  // Runtime emission is outside the ACK/readiness transaction and remains best effort.
  if (outcome.planAcked) {
    try { await runtime.emitRuntimeChanged(db, deviceEui, warn); }
    catch (e) { warn && warn('[valve-control] handleUplink: runtime emit failed: ' + (e && e.message ? e.message : e)); }
  }
  if (outcome.generationPromoted) warn && warn('[valve-control] ' + deviceEui + ' promoted to GEN2 from uplink');
  return { acked: outcome.acked, generationPromoted: outcome.generationPromoted, readiness: outcome.readiness, readinessPersisted: outcome.readiness ? outcome.readiness.persisted !== false : null };
}

function actuatorCommand(deviceEui, zoneId, minutes, commandId, reason) {
  return { type: 'actuator_command', device: { devEui: deviceEui, zone_id: zoneId }, data: { action: 'OPEN_FOR_DURATION', duration_minutes: minutes, reason, commandId, commandType: 'OPEN_FOR_DURATION', deviceEui, trigger: 'one_time' } };
}

function onceDispatchMarker(scheduleUuid, fireAt) {
  return 'one_time_open:' + scheduleUuid + ':' + fireAt;
}

async function finalizeOnceAccepted(db, row, nowDate) {
  const marker = onceDispatchMarker(row.schedule_uuid, row.fire_at);
  return db.transaction(async (tx) => {
    const schedule = await tx.get('SELECT once_state FROM valve_schedules WHERE schedule_uuid=? AND UPPER(device_eui)=? AND deleted_at IS NULL', [row.schedule_uuid, row.device_eui]);
    const existingLog = await tx.get('SELECT id FROM actuator_log WHERE reason=? LIMIT 1', [marker]);
    let existingEvent = null;
    if (row.user_id != null && row.irrigation_zone_id != null) {
      const eventMarker = `%${row.schedule_uuid}%`;
      existingEvent = await tx.get("SELECT id FROM irrigation_events WHERE action='IRRIGATE' AND reason='one_time_open' AND payload_json LIKE ? LIMIT 1", [eventMarker]);
    }
    // A second live facade may have completed the accepted replay after the
    // first facade released the device writer. Report only the invocation
    // that completed the durable schedule/log/event transition. This is a
    // result fence, not a network lock: the transport is always outside this
    // short transaction.
    const complete = schedule && schedule.once_state === 'FIRED' && existingLog
      && (row.user_id == null || row.irrigation_zone_id == null || existingEvent);
    await tx.run("UPDATE valve_once_dispatch_intents SET state='SENT', updated_at=datetime('now') WHERE schedule_uuid=? AND state IN ('PENDING','ATTEMPTED','UNKNOWN','SENT')", [row.schedule_uuid]);
    if (!schedule || schedule.once_state !== 'FIRED') {
      await store.updateSchedule(tx, row.schedule_uuid, { once_state: 'FIRED', once_fired_at: row.fire_at }, row.device_eui);
    }
    if (!existingLog) {
      await tx.run("INSERT INTO actuator_log(deveui, irrigation_zone_id, action, duration_minutes, reason, created_at) VALUES (?,?,?,?,?,?)", [row.device_eui, row.irrigation_zone_id, 'OPEN_FOR_DURATION', row.duration_minutes, marker, nowDate.toISOString()]);
    }
    if (row.user_id != null && row.irrigation_zone_id != null) {
      const eventMarker = `%${row.schedule_uuid}%`;
      if (!existingEvent) {
        await tx.run("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, duration_minutes, valve_deveui, payload_json) VALUES (?,?,?,?,?,?,?)", [row.user_id, row.irrigation_zone_id, 'IRRIGATE', 'one_time_open', row.duration_minutes, row.device_eui, JSON.stringify({ schedule_uuid: row.schedule_uuid, command_id: row.command_id, fire_at: row.fire_at })]);
      }
    }
    return { newlyFinalized: !complete };
  });
}

function withOnceClaimWriter(db, fn) {
  const previous = onceClaimQueues.get(db) || Promise.resolve();
  const scheduled = previous.then(fn);
  const settled = scheduled.then(() => undefined, () => undefined);
  onceClaimQueues.set(db, settled);
  settled.then(() => { if (onceClaimQueues.get(db) === settled) onceClaimQueues.delete(db); });
  return scheduled;
}

async function runOnceTick({ db, now, warn, beforeAttempt, afterAttempt, emit, transport, onError, trustedContext }) {
  const nowDate = now || new Date();
  const nowMs = nowDate.getTime();
  // An ATTEMPTED marker means the process reached the QoS0 handoff boundary. A successful emit
  // advances it to SENT; a later tick marks only an interrupted ATTEMPTED handoff UNKNOWN.
  await db.run("UPDATE valve_once_dispatch_intents SET state='UNKNOWN', updated_at=datetime('now') WHERE state='ATTEMPTED' AND attempted_at IS NOT NULL AND julianday(attempted_at) < julianday('now','-1 second')");
  // (I3) AND d.deleted_at IS NULL: a soft-deleted device's PENDING ONCE rows must be left
  // completely untouched (not fired, not skipped) rather than logging a phantom SKIP against a
  // device that no longer exists to the operator.
  const rows = await db.all("SELECT vs.*, d.irrigation_zone_id, d.user_id FROM valve_schedules vs JOIN devices d ON d.deveui = vs.device_eui WHERE vs.kind='ONCE' AND vs.once_state='PENDING' AND vs.enabled=1 AND vs.deleted_at IS NULL AND d.deleted_at IS NULL AND vs.fire_at <= ? AND NOT EXISTS (SELECT 1 FROM valve_once_dispatch_intents i WHERE i.schedule_uuid=vs.schedule_uuid) ORDER BY vs.fire_at", [new Date(nowMs).toISOString()]);
  const fired = []; const skipped = []; const transportFailures = [];
  for (const r of rows) {
    await db.run("INSERT INTO valve_once_dispatch_intents(schedule_uuid,device_eui,command_id,state) VALUES (?,?,?,'PENDING') ON CONFLICT(schedule_uuid) DO NOTHING", [r.schedule_uuid, r.device_eui, crypto.randomUUID()]);
  }
  const intents = await db.all("SELECT schedule_uuid FROM valve_once_dispatch_intents WHERE state IN ('PENDING','UNKNOWN','ATTEMPTED','SENT') ORDER BY created_at, schedule_uuid");
  for (const i of intents) {
    try {
      if (typeof beforeAttempt === 'function') await beforeAttempt(i);
      const outcome = await withOnceClaimWriter(db, () => db.transaction(async (tx) => {
        const claimNowMs = now ? new Date(now).getTime() : Date.now();
        const claimNowIso = new Date(claimNowMs).toISOString();
        const current = await tx.get("SELECT i.state, i.command_id, i.attempted_at, vs.schedule_uuid, vs.device_eui, vs.duration_minutes, vs.fire_at, d.irrigation_zone_id, d.user_id, vae.transport_json FROM valve_once_dispatch_intents i JOIN valve_schedules vs ON vs.schedule_uuid=i.schedule_uuid JOIN devices d ON d.deveui=vs.device_eui LEFT JOIN valve_actuation_expectations vae ON vae.command_id=i.command_id WHERE i.schedule_uuid=? AND i.state IN ('PENDING','UNKNOWN','ATTEMPTED','SENT') AND vs.kind='ONCE' AND vs.once_state='PENDING' AND vs.enabled=1 AND vs.deleted_at IS NULL AND d.deleted_at IS NULL AND vs.fire_at <= ?", [i.schedule_uuid, claimNowIso]);
        if (!current) return null;
        const historical = await tx.get("SELECT created_at FROM actuator_log WHERE action='OPEN_FOR_DURATION' AND reason=? ORDER BY id LIMIT 1", [onceDispatchMarker(current.schedule_uuid, current.fire_at)]);
        if (historical) {
          // A stale re-arm can only dispatch once the scheduler reaches this
          // claim path, so guard the durable marker here as well as the applier.
          await tx.run('DELETE FROM valve_once_dispatch_intents WHERE schedule_uuid=? AND state=\'PENDING\'', [current.schedule_uuid]);
          await store.updateSchedule(tx, current.schedule_uuid, { once_state: 'FIRED', once_fired_at: historical.created_at }, current.device_eui);
          return null;
        }
        let transportState = null;
        if (current.transport_json) {
          try { transportState = JSON.parse(current.transport_json); } catch (_) { throw Object.assign(new Error('one-time transport state is malformed'), { code: 'transport_state_malformed' }); }
        }
        const actualAttempt = transportState && (transportState.phase === 'ATTEMPTED' || transportState.phase === 'UNKNOWN'
          || transportState.attempted_at != null || transportState.attempt_receipt != null)
          || (!transport && current.attempted_at != null);
        if (transportState && transportState.phase === 'ACCEPTED' && transportState.queue_id) {
          return { kind: 'accepted_replay', row: current };
        }
        if (actualAttempt) return { kind: 'uncertain', row: current };
        const fireMs = Date.parse(current.fire_at);
        const snapshotCutoff = transportState && transportState.effect_snapshot && transportState.effect_snapshot.queue_expires_at
          ? Date.parse(transportState.effect_snapshot.queue_expires_at) : null;
        if (claimNowMs - fireMs > ONCE_GRACE_MS || (snapshotCutoff != null && claimNowMs >= snapshotCutoff)) {
          await tx.run("UPDATE valve_once_dispatch_intents SET state='SKIPPED', updated_at=datetime('now') WHERE schedule_uuid=? AND state IN ('PENDING','UNKNOWN','ATTEMPTED','SENT')", [current.schedule_uuid]);
          const afterSkip = await tx.get("SELECT state FROM valve_once_dispatch_intents WHERE schedule_uuid=?", [current.schedule_uuid]);
          if (!afterSkip || afterSkip.state !== 'SKIPPED') return null;
          await store.updateSchedule(tx, current.schedule_uuid, { once_state: 'SKIPPED' }, current.device_eui);
          if (current.user_id != null && current.irrigation_zone_id != null) await tx.run("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, duration_minutes, valve_deveui, payload_json) VALUES (?,?,?,?,?,?,?)", [current.user_id, current.irrigation_zone_id, 'SKIP', 'one_time_missed', current.duration_minutes, current.device_eui, JSON.stringify({ schedule_uuid: current.schedule_uuid, fire_at: current.fire_at })]);
          return { kind: 'skipped', row: current };
        }
        // The shared composition claims this intent under the device writer,
        // after it has persisted the immutable effect snapshot. Keep the
        // schedule pending until the physical enqueue is durably accepted.
        return { kind: 'fired', row: current };
      }));
      if (!outcome) continue;
      if (outcome.kind === 'skipped') { skipped.push({ schedule_uuid: outcome.row.schedule_uuid, device_eui: outcome.row.device_eui }); continue; }
      if (outcome.kind === 'uncertain') continue;
      const row = outcome.row;
      if (row.user_id == null || row.irrigation_zone_id == null) warn && warn('[valve-control] one_time_open not logged for ' + row.device_eui + ' (no zone/user)');
      const command = { schedule_uuid: row.schedule_uuid, device_eui: row.device_eui, duration_minutes: row.duration_minutes, command_id: row.command_id, actuator_command: actuatorCommand(row.device_eui, row.irrigation_zone_id, row.duration_minutes, row.command_id, 'one_time_open') };
      let reportFired = true;
      if (transport) {
        const frame = { fPort: 2, data: Buffer.from([0x41, Number(row.duration_minutes)]).toString('base64'), confirmed: false, encrypted: false,
          provenance: { source: 'local_encoder', encoder: 'strega-v1' } };
        try {
          command.transportResult = await dispatch.executeValveAttempt({
            db, deviceEui: row.device_eui,
            command: { device_eui: row.device_eui, command_id: row.command_id, action: 'OPEN_FOR_DURATION', duration_minutes: Number(row.duration_minutes), zone_id: row.irrigation_zone_id, trigger: 'one_time', commanded_at: row.fire_at },
            frame, transport, now: nowDate, trustedContext, onceScheduleUuid: row.schedule_uuid,
          });
        } catch (error) {
          command.transportResult = { accepted: false, phase: error && error.code === 'clock_untrusted' ? 'UNKNOWN' : (error && error.code || 'UNKNOWN'), error };
        }
        if (command.transportResult.accepted) {
          const finalization = await finalizeOnceAccepted(db, row, nowDate);
          reportFired = finalization.newlyFinalized;
        } else {
          await db.run("UPDATE valve_once_dispatch_intents SET state='UNKNOWN', updated_at=datetime('now') WHERE schedule_uuid=? AND state IN ('PENDING','ATTEMPTED','UNKNOWN')", [row.schedule_uuid]);
        }
      } else if (typeof emit === 'function') {
        await db.run("UPDATE valve_once_dispatch_intents SET state='ATTEMPTED', attempted_at=?, updated_at=datetime('now') WHERE schedule_uuid=? AND command_id=? AND state='PENDING'", [nowDate.toISOString(), row.schedule_uuid, row.command_id]);
        await emit(command);
        await db.transaction(async (tx) => {
          await tx.run("UPDATE valve_once_dispatch_intents SET state='SENT', updated_at=datetime('now') WHERE schedule_uuid=? AND command_id=? AND state IN ('PENDING','ATTEMPTED','UNKNOWN')", [row.schedule_uuid, row.command_id]);
          await store.updateSchedule(tx, row.schedule_uuid, { once_state: 'FIRED', once_fired_at: row.fire_at }, row.device_eui);
          await tx.run("INSERT INTO actuator_log(deveui, irrigation_zone_id, action, duration_minutes, reason, created_at) VALUES (?,?,?,?,?,?)", [row.device_eui, row.irrigation_zone_id, 'OPEN_FOR_DURATION', row.duration_minutes, onceDispatchMarker(row.schedule_uuid, row.fire_at), nowDate.toISOString()]);
        });
      } else {
        await db.transaction(async (tx) => {
          await tx.run("UPDATE valve_once_dispatch_intents SET state='ATTEMPTED', attempted_at=?, updated_at=datetime('now') WHERE schedule_uuid=? AND command_id=? AND state='PENDING'", [nowDate.toISOString(), row.schedule_uuid, row.command_id]);
        });
      }
      if (transport && (!command.transportResult || command.transportResult.phase !== 'ACCEPTED')) {
        const failure = Object.assign(new Error('one-time STREGA transport was not accepted'), {
          code: command.transportResult && command.transportResult.phase || 'UNKNOWN',
          phase: command.transportResult && command.transportResult.phase || 'UNKNOWN',
          transportResult: command.transportResult,
        });
        transportFailures.push({ schedule_uuid: row.schedule_uuid, device_eui: row.device_eui, phase: failure.phase, error: failure });
        warn && warn('[valve-control] one-time transport result ' + failure.phase + ' for ' + row.device_eui);
        if (typeof onError === 'function') onError(failure, row.schedule_uuid);
        continue;
      }
      if (typeof afterAttempt === 'function') await afterAttempt(row);
      if (!transport && typeof emit !== 'function') {
        await db.transaction(async (tx) => {
          await tx.run("UPDATE valve_once_dispatch_intents SET state='SENT', updated_at=datetime('now') WHERE schedule_uuid=? AND command_id=? AND state IN ('PENDING','ATTEMPTED','UNKNOWN')", [row.schedule_uuid, row.command_id]);
          await store.updateSchedule(tx, row.schedule_uuid, { once_state: 'FIRED', once_fired_at: row.fire_at }, row.device_eui);
          await tx.run("INSERT INTO actuator_log(deveui, irrigation_zone_id, action, duration_minutes, reason, created_at) VALUES (?,?,?,?,?,?)", [row.device_eui, row.irrigation_zone_id, 'OPEN_FOR_DURATION', row.duration_minutes, onceDispatchMarker(row.schedule_uuid, row.fire_at), nowDate.toISOString()]);
        });
      }
      if (reportFired) fired.push(command);
    } catch (e) {
      const detail = e && e.message ? e.message : e;
      warn && warn('[valve-control] one-time dispatch failed for ' + i.schedule_uuid + ': ' + detail);
      if (typeof onError === 'function') {
        onError(e, i.schedule_uuid);
      } else {
        throw e;
      }
    }
  }
  return { fired, skipped, transportFailures };
}

async function runObserveTick({ db, now, warn }) {
  const nowDate = now || new Date();
  const valves = await db.all("SELECT deveui FROM devices WHERE type_id='STREGA_VALVE' AND deleted_at IS NULL ORDER BY deveui");
  let recovered = 0;
  for (const valve of valves) {
    const result = await recoverValveObservation({ db, deviceEui: valve.deveui, now: nowDate });
    if (result && (result.physical_run_id || result.reason === 'missing_observation_watermark')) recovered += 1;
  }
  return { created: 0, recovered };
}

const RECONCILIATION_GRACE_SEC = 1800;

function commandObservationDeadline(row) {
  if (!row || dispatch.isReportOnlyExpectation(row)) return null;
  let transport;
  try { transport = row.transport_json ? JSON.parse(row.transport_json) : null; } catch (_) { return null; }
  const snapshot = transport && transport.effect_snapshot;
  const deadline = snapshot && observationInstant(snapshot.future_effect_end);
  return Number.isFinite(deadline) ? deadline : null;
}

async function runReconciliationTick({ db, now, warn }) {
  const nowMs = (now instanceof Date ? now.getTime() : observationInstant(now)) || Date.now();
  const active = await db.all(
    "SELECT vae.*, d.user_id AS device_user_id, d.irrigation_zone_id AS device_irrigation_zone_id FROM valve_actuation_expectations vae LEFT JOIN devices d ON d.deveui=vae.device_eui WHERE vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.rowid"
  );
  let advanced = 0;
  for (const row of active) {
    const deadline = commandObservationDeadline(row);
    if (!Number.isFinite(deadline) || nowMs <= deadline + RECONCILIATION_GRACE_SEC * 1000) continue;
    const next = row.reconciliation_state === 'OBSERVED_RUNNING' ? 'STALE_OPEN_OBSERVED' : 'STALE_NO_OBSERVATION';
    await db.transaction(async (tx) => {
      const current = await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [row.expectation_id]);
      if (!current || current.reconciliation_state !== row.reconciliation_state) return;
      await tx.run('UPDATE valve_actuation_expectations SET reconciliation_state=? WHERE expectation_id=?', [next, row.expectation_id]);
      if (runtime && typeof runtime.emitRuntimeChanged === 'function') {
        try { await runtime.emitRuntimeChanged(tx, row.device_eui, warn); }
        catch (error) { warn && warn('[valve-control] reconciliation runtime emit failed: ' + String(error && error.message ? error.message : error)); }
      }
      if (runtime && typeof runtime.emitActuationArchived === 'function') {
        try { await runtime.emitActuationArchived(tx, row.device_eui, row.expectation_id, warn); }
        catch (error) { warn && warn('[valve-control] reconciliation archive emit failed: ' + String(error && error.message ? error.message : error)); }
      }
    });
    advanced += 1;
  }
  return { reconciled: active.length, advanced };
}

async function runClockTick({ db, now, appId, transport, warn }) {
  const nowDate = now || new Date();
  // (FW-T5) Read once per tick, same rationale as runObserveTick above.
  const gatewayTimezone = await store.getGatewaySetting(db, 'gateway_timezone', warn);
  // P3-E1 review fix (IMPORTANT 1): failStalePushes flips QUEUED -> FAILED fleet-wide with no
  // emission of its own -- without this, the cloud shows "queued" forever for a valve whose plan
  // push aged out unacknowledged, since nothing else touches push_state until some unrelated
  // seam next fires for that device. Pre-SELECT (state is still QUEUED) before the UPDATE runs.
  const staleCutoffIso = new Date(nowDate.getTime() - STALE_PUSH_MS).toISOString();
  const staleDeviceEuis = await store.staleQueuedPlanDeviceEuis(db, staleCutoffIso);
  await store.failStalePushes(db, staleCutoffIso);
  for (const eui of staleDeviceEuis) {
    // PR-H: pass nowDate through so buildRuntimePayload's store.pushSummary() 30-day window is
    // computed against this tick's own clock, not SQLite's independent wall clock (see
    // runtime.js's emitRuntimeChanged/buildRuntimePayload comments and store.js's pushSummary
    // comment for the full history).
    try { await runtime.emitRuntimeChanged(db, eui, warn, nowDate); }
    catch (e) { warn && warn('[valve-control] runClockTick: stale-push runtime emit failed for ' + eui + ': ' + (e && e.message ? e.message : e)); }
  }
  // (I2, spec §5.4): FPort 12 must encode local wall-clock digits in the SCHEDULE's timezone,
  // not the zone's. schedule_timezone picks, per valve, the first enabled WEEKLY schedule's
  // timezone (an enabled WEEKLY row sorts first), falling back to any other schedule's
  // timezone if none is enabled-WEEKLY. The JS fallback chain below then falls further back to
  // the zone timezone, then 'UTC' — never the gateway process's own Intl timezone, which has no
  // relationship to the valve at all and was silently wrong for the common case of a gateway
  // running in a different tz than every zone it serves.
  // (M6) AND iz.deleted_at IS NULL: don't inherit a timezone from a soft-deleted zone.
  const valves = await db.all(`SELECT d.deveui, iz.timezone AS zone_timezone, vs.strega_generation, vs.last_clock_sync_queued_at,
      (SELECT s.timezone FROM valve_schedules s
         WHERE s.device_eui = d.deveui AND s.deleted_at IS NULL AND s.timezone IS NOT NULL
         ORDER BY (s.kind='WEEKLY' AND s.enabled=1) DESC, s.kind='WEEKLY' DESC, s.id ASC
         LIMIT 1) AS schedule_timezone
    FROM devices d
    LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL
    LEFT JOIN valve_settings vs ON vs.device_eui = d.deveui
    WHERE d.type_id='STREGA_VALVE' AND d.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM valve_schedules s WHERE s.device_eui = d.deveui AND s.deleted_at IS NULL)`);
  const messages = []; const transportFailures = [];
  for (const v of valves) {
    const tz = v.schedule_timezone || v.zone_timezone || gatewayTimezone || 'UTC';
    const last = v.last_clock_sync_queued_at ? Date.parse(v.last_clock_sync_queued_at) : 0;
    const due = nowDate.getTime() - last >= CLOCK_PERIOD_MS;
    const dst = last && P.isDstTransitionWithin(tz, last, nowDate.getTime());
    if (!due && !dst) continue;
    // A clock push is an append-only transport attempt.  If the previous
    // attempt reached INTENT/ATTEMPTED/UNKNOWN, or was accepted without a
    // device ACK yet, retain that durable owner and surface its phase rather
    // than creating a fresh push ID on every tick.  Only the ACK handler
    // settling the row makes a later clock sync eligible again.
    const previous = await db.get("SELECT push_id, state, transport_json FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose='CLOCK_SYNC' ORDER BY rowid DESC LIMIT 1", [v.deveui]);
    // Design C (PR0, R3-M2): a flush that removed a queued clock marks it SUPERSEDED and clears
    // last_clock_sync_queued_at, so a SUPERSEDED previous row is settled and a fresh clock is due.
    // B-4: a FAILED row (the 24 h sweep's no_ack_24h, or a negative ACK) is terminal too, so a
    // fresh clock sync becomes a new intent 24 h after an unacknowledged one, never within them.
    if (previous && !['ACKED', 'SUPERSEDED', 'FAILED'].includes(previous.state)) {
      let priorTransport = {};
      try { priorTransport = previous.transport_json ? JSON.parse(previous.transport_json) : {}; } catch (_) { priorTransport = {}; }
      if (priorTransport.phase || previous.state === 'QUEUED') {
        const phase = priorTransport.phase || 'UNKNOWN';
        transportFailures.push({ device_eui: v.deveui, error: phase === 'UNKNOWN' ? 'transport_uncertain' : phase, phase, push_id: previous.push_id, replayed: true });
        continue;
      }
    }
    const q = await push.queuePushes({ db, deviceEui: v.deveui, appId, pushes: [push.buildClockPush(v.strega_generation || 'GEN1', nowDate, tz)], flushQueue: null, transport, now: nowDate, warn });
    const failure = push.transportFailure(q);
    if (failure) {
      warn && warn('[valve-control] clock transport result ' + failure.phase + ' for ' + v.deveui);
      transportFailures.push({ device_eui: v.deveui, ...failure });
    } else {
      await store.upsertSettings(db, v.deveui, { last_clock_sync_queued_at: nowDate.toISOString() });
    }
    messages.push(...q.messages);
  }
  return { messages, transportFailures };
}

// Housekeeping that rides on the clock tick (the tick runs every 60 seconds since CMD-04 PR0, so
// a debounced plan snapshot leaves within a minute of its window; it ran every 10 minutes before):
//  (a) SKIP_TODAY resets to ACTIVE once the valve's local date has moved past skip_today_date;
//  (b) (C1) a gateway clock jump forces a GEN1 clock re-sync for every scheduled valve. The
//      clock tick actually runs every 10 minutes (not hourly, despite the name/original 1h
//      assumption below), so the detector must tolerate that real cadence: it now trips only on
//      a genuine anomaly — the clock moving BACKWARD at all (delta < -60s, allowing a little
//      slack for tick-to-tick jitter) or a FORWARD gap too large for any normal tick delay or
//      brief restart to explain (> 6h). A naive "must be ~1h since last tick" comparison tripped
//      on every single real 10-minute tick, nulling last_clock_sync_queued_at and re-queuing a
//      clock push per valve every 10 minutes instead of the intended weekly cadence.
//  (c) (C4) decommission sweep: a STREGA device soft-deleted (deleted_at set) that still has an
//      ACKED non-empty plan gets seven empty weekday pushes (GEN1) / an all-days empty FPort 25
//      (GEN2) plus FPort 21 '2'. The "already swept" guard compares p2.queued_at (DB default
//      datetime('now'), space-separated) against d.deleted_at (written as an ISO instant
//      everywhere in production) — wrapped in datetime() so the comparison is apples-to-apples;
//      unwrapped, the sweep could silently repeat on every tick for the rest of the day (see
//      failStalePushes above for the same class of bug in detail).
//  (d) CMD-04 PR0 (C): push.emitPendingSnapshots sends the plan snapshots whose debounce window
//      has passed (push.js, SNAPSHOT_DEBOUNCE_MS).
let lastClockTickMs = null;
// Test-only: the clock-jump detector's "delta since the previous tick" state is deliberately
// module-scoped (production wants it to persist across ticks within one Node-RED runtime; the
// first tick after every redeploy just seeds it and never trips). Tests in the same file share
// that module instance, so each housekeeping test must reset it first to stay order-independent.
function _resetHousekeepingForTests() { lastClockTickMs = null; }
const CLOCK_JUMP_BACKWARD_MS = -60 * 1000;
const CLOCK_JUMP_FORWARD_MS = 6 * 3600 * 1000;
async function runHousekeeping({ db, now, appId, transport, warn }) {
  const nowDate = now || new Date();
  // (FW-T5) Read once per tick, same rationale as runObserveTick above.
  const gatewayTimezone = await store.getGatewaySetting(db, 'gateway_timezone', warn);
  const out = { resets: 0, clockJump: false, decommissioned: 0, snapshotsEmitted: 0, messages: [], transportFailures: [] };
  // (d) CMD-04 PR0 (C): send the plan snapshots whose debounce window has passed, through the
  // transport (dispatch owners) when one is supplied. Run before runClockTick, so a clock sync
  // queued in the same tick lands behind the snapshot. A clock re-queued on an earlier tick
  // (after the compile's flush superseded the old one) lands ahead of it; either order is
  // harmless (R5 L2).
  const snaps = await push.emitPendingSnapshots({ db, now: nowDate, appId, warn, transport });
  out.snapshotsEmitted = snaps.emitted;
  out.messages.push(...snaps.messages);
  out.transportFailures.push(...snaps.transportFailures);
  const skips = await db.all("SELECT vs.device_eui, vs.skip_today_date, iz.timezone AS zone_timezone FROM valve_settings vs JOIN devices d ON d.deveui = vs.device_eui LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id WHERE vs.scheduler_status='SKIP_TODAY'");
  for (const s of skips) {
    const lp = P.localParts(nowDate, s.zone_timezone || gatewayTimezone || 'UTC');
    const today = `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}`;
    if (!s.skip_today_date || today > s.skip_today_date) { await store.upsertSettings(db, s.device_eui, { scheduler_status: 'ACTIVE', skip_today_date: null }); out.resets += 1; }
  }
  const tickDeltaMs = lastClockTickMs != null ? nowDate.getTime() - lastClockTickMs : null;
  if (tickDeltaMs != null && (tickDeltaMs < CLOCK_JUMP_BACKWARD_MS || tickDeltaMs > CLOCK_JUMP_FORWARD_MS)) {
    out.clockJump = true;
    await db.run("UPDATE valve_settings SET last_clock_sync_queued_at = NULL WHERE device_eui IN (SELECT device_eui FROM valve_schedules WHERE deleted_at IS NULL)");
    warn && warn('[valve-control] gateway clock jump detected; forcing valve clock re-sync');
  }
  lastClockTickMs = nowDate.getTime();
  const gone = await db.all("SELECT d.deveui, COALESCE(vs.strega_generation,'GEN1') AS gen FROM devices d LEFT JOIN valve_settings vs ON vs.device_eui = d.deveui WHERE d.type_id='STREGA_VALVE' AND d.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM valve_schedule_pushes p WHERE p.device_eui = d.deveui AND p.purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND p.state='ACKED' AND p.plan_hash <> ?) AND NOT EXISTS (SELECT 1 FROM valve_schedule_pushes p2 WHERE p2.device_eui = d.deveui AND p2.purpose='SCHEDULER_STATUS' AND p2.payload_hex='32' AND datetime(p2.queued_at) > datetime(d.deleted_at))", [P.planHash([])]);
  for (const g of gone) {
    const days = Array.from({ length: 7 }, () => []);
    // A snapshot of the cleared plan + deactivate, sent at once (this already is the tick); no
    // flush, so an open still queued for the valve is not dropped.
    const pushes = push.buildSnapshotPushes({ generation: g.gen, days, schedulerStatus: 'DEACTIVATED', includePlan: true });
    const q = await push.queueSnapshot({ db, deviceEui: g.deveui, appId, pushes, flushQueue: null, transport, warn, now: nowDate, emitNow: true });
    out.messages.push(...q.messages);
    const failure = push.transportFailure(q);
    if (failure) out.transportFailures.push({ device_eui: g.deveui, ...failure });
    else out.decommissioned += 1;
  }
  return out;
}

// (W29 F1) The ONCE inject (flows node valve-once-fn via live-transport liveValveOnce, every
// 60 s): runOnceTick with a ChirpStack client built lazily -- only when a one-time open is
// actually dispatched -- and closed in `finally`, also after a failure. A client that cannot be
// built fails the STREGA write closed (warned once per runtime), as before.
async function runOnceTickLazy(options = {}) {
  const { transportFactory, warn } = options;
  const owned = !options.transport && typeof transportFactory === 'function' ? push.lazyTransport(transportFactory, warn) : null;
  try {
    return await runOnceTick(Object.assign({}, options, { transport: options.transport || owned || undefined }));
  } finally {
    if (owned) owned.close();
  }
}

// The valve tick (flows node valve-clock-fn, every 60 s, via live-transport liveValveClock):
// housekeeping (snapshots first), then the clock tick. (PR0 2758ca709 T1) With
// `transportFactory` the ChirpStack client is built lazily -- only when a snapshot, a clock sync
// or a decommission sweep is about to be sent -- shared by both steps and closed in `finally`.
// (T2) A tick that starts while the previous one is still running (a ChirpStack call waiting out
// its deadline) is skipped, so two ticks never queue the same clock sync or decommission sweep
// twice. Per runtime (module state); the flag is released in `finally`, also when a tick throws.
let valveTickRunning = false;
async function runValveTick({ db, now, appId, warn, transport, transportFactory }) {
  if (valveTickRunning) return { skipped: true, messages: [], transportFailures: [], housekeeping: null, clock: null };
  valveTickRunning = true;
  const owned = !transport && typeof transportFactory === 'function' ? push.lazyTransport(transportFactory, warn) : null;
  const via = transport || owned || null;
  try {
    const housekeeping = await runHousekeeping({ db, now: now || new Date(), appId, warn, transport: via });
    const clock = await runClockTick({ db, now: now || new Date(), appId, warn, transport: via });
    return { skipped: false, messages: housekeeping.messages.concat(clock.messages),
      transportFailures: (housekeeping.transportFailures || []).concat(clock.transportFailures || []), housekeeping, clock };
  } finally {
    if (owned) owned.close();
    valveTickRunning = false;
  }
}

// Fill trigger on expectation rows written by the legacy writer (which does not know the column).
// Also backfills volume for rows the observe tick left as volume_source='unknown' once a
// per-valve or zone-calibration flow rate becomes available after the row was written (keeps
// "Recent irrigations" consistent with the dialogs without touching write-strega-expectation).
async function runTriggerBackfill({ db, warn }) {
  const rows = await db.all("SELECT expectation_id, device_eui, command_id, commanded_at FROM valve_actuation_expectations WHERE trigger IS NULL ORDER BY commanded_at DESC LIMIT 200");
  let updated = 0;
  for (const r of rows) {
    let trigger = 'manual';
    if (r.command_id) {
      const once = await db.get("SELECT 1 AS x FROM irrigation_events WHERE reason='one_time_open' AND payload_json LIKE ? LIMIT 1", ['%' + r.command_id + '%']);
      if (once) trigger = 'one_time';
      else if (await db.get('SELECT 1 AS x FROM applied_commands WHERE command_id=? LIMIT 1', [r.command_id])) trigger = 'cloud_command';
    }
    if (trigger === 'manual') {
      // (C3) actuator_log.created_at is always written as an ISO instant in production (every
      // writer in flows.json uses `new Date().toISOString()`); wrap it in datetime() too so it
      // compares on equal footing with the datetime(...)-computed window bounds — an
      // unwrapped ISO created_at never falls inside a bound built from SQLite's own
      // space-separated datetime() output, so this lookup silently never matched.
      const log = await db.get("SELECT reason FROM actuator_log WHERE UPPER(deveui)=UPPER(?) AND datetime(created_at) BETWEEN datetime(?, '-2 minutes') AND datetime(?, '+2 minutes') ORDER BY created_at DESC LIMIT 1", [r.device_eui, r.commanded_at, r.commanded_at]);
      if (log && /^scheduler_/.test(String(log.reason || ''))) trigger = 'trigger_based';
    }
    await db.run('UPDATE valve_actuation_expectations SET trigger=? WHERE expectation_id=? AND trigger IS NULL', [trigger, r.expectation_id]);
    updated += 1;
  }

  // P3-E1 review fix (rider 5): a backfilled row's trigger is part of ValveRuntime.active_actuation
  // (when that row happens to still be the active one) -- emit once per affected device, best-effort.
  for (const eui of new Set(rows.map((r) => r.device_eui))) {
    try { await runtime.emitRuntimeChanged(db, eui, warn); }
    catch (e) { warn && warn('[valve-control] runTriggerBackfill: runtime emit failed for ' + eui + ': ' + (e && e.message ? e.message : e)); }
  }

  const unknownVolume = await db.all(`SELECT vae.expectation_id, vae.device_eui, vae.zone_id, vae.commanded_duration_seconds,
      vs.flow_rate_lpm AS valve_flow_rate_lpm, vs.flow_rate_source AS valve_flow_rate_source,
      zic.measured_flow_rate_lpm AS zone_flow_rate_lpm
    FROM valve_actuation_expectations vae
    LEFT JOIN valve_settings vs ON vs.device_eui = vae.device_eui
    LEFT JOIN zone_irrigation_calibration zic ON zic.zone_id = vae.zone_id
    WHERE vae.volume_source='unknown' AND vae.commanded_duration_seconds > 0`);
  // cloud full-parity Task P4-E1 review fix (Important 2): this loop mutates
  // flow_rate_lpm/estimated_gross_liters/volume_source with NO reconciliation_state filter --
  // it fires routinely well after a row has already archived (e.g. an operator entering a
  // valve's flow rate in Settings any time after the run finished), so an already-shipped
  // VALVE_ACTUATION_ARCHIVED payload can be carrying a stale/unknown liters figure. Track which
  // expectation_ids this loop actually UPDATEs (not the full query result -- `rate == null`
  // below skips the write) and re-archive each, alongside the trigger-backfill rows above (same
  // "corrects data a shipped archive already carries" rationale, since `trigger` is also part of
  // the ValveActuation payload). emitActuationArchived self-guards on terminality, so calling it
  // for a still-active row (trigger somehow null on a live PENDING_OBSERVATION/OBSERVED_RUNNING
  // expectation) is a harmless no-op -- no filter needed here either.
  const touchedExpectationDeviceEuis = new Map(rows.map((r) => [r.expectation_id, r.device_eui]));
  for (const r of unknownVolume) {
    let rate = null; let source = null;
    if (r.valve_flow_rate_lpm != null) { rate = Number(r.valve_flow_rate_lpm); source = 'valve_' + (r.valve_flow_rate_source || 'estimated'); }
    else if (r.zone_flow_rate_lpm != null) { rate = Number(r.zone_flow_rate_lpm); source = 'zone_calibration'; }
    if (rate == null) continue;
    const liters = Math.round(rate * r.commanded_duration_seconds / 60);
    await db.run("UPDATE valve_actuation_expectations SET flow_rate_lpm=?, flow_rate_source=?, estimated_gross_liters=?, volume_source='estimated_duration_flow_rate' WHERE expectation_id=?", [rate, source, liters, r.expectation_id]);
    touchedExpectationDeviceEuis.set(r.expectation_id, r.device_eui);
  }

  for (const [expectationId, deviceEui] of touchedExpectationDeviceEuis) {
    try { await runtime.emitActuationArchived(db, deviceEui, expectationId, warn); }
    catch (e) { warn && warn('[valve-control] runTriggerBackfill: actuation-archive emit failed for ' + expectationId + ': ' + (e && e.message ? e.message : e)); }
  }

  return { updated };
}

module.exports = { runValveTick, runOnceTickLazy, handleUplink, recordValveObservation, recoverValveObservation, runOnceTick, runObserveTick, runReconciliationTick, runClockTick, runHousekeeping, runTriggerBackfill, ONCE_GRACE_MS, _resetHousekeepingForTests, isLegacyV1CompatibilityCandidate: (row) => Boolean(legacyV1CompatibilityForRow(row)) };
