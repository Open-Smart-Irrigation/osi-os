'use strict';
const crypto = require('node:crypto');
const P = require('./plan');
const store = require('./store');
const push = require('./push');
const { interpretUplink } = require('./ack');
const runtime = require('./runtime');

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

async function handleUplink({ db, deviceEui, decoded, fPort, rawBytes, receivedAt, warn }) {
  const { acks, generationHint } = interpretUplink(decoded, fPort, rawBytes || null);
  const at = receivedAt || new Date().toISOString();
  let acked = 0;
  // ValveRuntime.push_state (queued/acked/failed/weekday_states) only reflects WEEKDAY_PLAN/
  // DAYMASK_PLAN rows (store.pushSummary/weekdayPushStates both filter to those purposes) -- a
  // CLOCK_SYNC or SCHEDULER_STATUS-only uplink leaves that resource unchanged, so only an ack
  // that actually lands on one of the two plan purposes needs a runtime emission.
  let planAcked = false;
  for (const a of acks) {
    acked += await store.ackPush(db, deviceEui, a.purpose, a.fport, a.weekday, a.status, at);
    if (a.purpose === 'CLOCK_SYNC') await store.upsertSettings(db, deviceEui, { last_clock_sync_acked_at: at });
    if (a.purpose === 'WEEKDAY_PLAN' || a.purpose === 'DAYMASK_PLAN') planAcked = true;
  }
  // Best-effort: a runtime-emission failure must not turn an otherwise-successful uplink
  // handler into a reported failure (matches the flows.json seams' own try/catch shape).
  if (planAcked) {
    try { await runtime.emitRuntimeChanged(db, deviceEui, warn); }
    catch (e) { warn && warn('[valve-control] handleUplink: runtime emit failed: ' + (e && e.message ? e.message : e)); }
  }
  let generationPromoted = false;
  if (generationHint === 'GEN2') {
    const s = await store.getSettings(db, deviceEui);
    if (s.strega_generation !== 'GEN2') { await store.upsertSettings(db, deviceEui, { strega_generation: 'GEN2' }); generationPromoted = true; warn && warn('[valve-control] ' + deviceEui + ' promoted to GEN2 from uplink'); }
  }
  return { acked, generationPromoted };
}

function actuatorCommand(deviceEui, zoneId, minutes, commandId, reason) {
  return { type: 'actuator_command', device: { devEui: deviceEui, zone_id: zoneId }, data: { action: 'OPEN_FOR_DURATION', duration_minutes: minutes, reason, commandId, commandType: 'OPEN_FOR_DURATION', deviceEui, trigger: 'one_time' } };
}

async function runOnceTick({ db, now, warn }) {
  const nowMs = (now || new Date()).getTime();
  // (I3) AND d.deleted_at IS NULL: a soft-deleted device's PENDING ONCE rows must be left
  // completely untouched (not fired, not skipped) rather than logging a phantom SKIP against a
  // device that no longer exists to the operator.
  const rows = await db.all("SELECT vs.*, d.irrigation_zone_id, d.user_id FROM valve_schedules vs JOIN devices d ON d.deveui = vs.device_eui WHERE vs.kind='ONCE' AND vs.once_state='PENDING' AND vs.enabled=1 AND vs.deleted_at IS NULL AND d.deleted_at IS NULL AND vs.fire_at <= ? ORDER BY vs.fire_at", [new Date(nowMs).toISOString()]);
  const fired = []; const skipped = [];
  for (const r of rows) {
    const fireMs = Date.parse(r.fire_at);
    const nowIso = new Date(nowMs).toISOString();
    // irrigation_events: user_id and irrigation_zone_id are NOT NULL, and event_uuid must be
    // OMITTED so trg_sync_irrigation_events_uuid_ai mints the canonical 'irrig-<gwEui>-<seq>' key
    // (a hand-rolled UUID would ship a non-conforming aggregate_key to the cloud). A zone-less or
    // unclaimed valve gets no event row; the schedule row's once_state stays the source of truth.
    // created_at is likewise OMITTED (DB default datetime('now')), consistent with every other
    // scheduler-triggered irrigation_events writer in flows.json (minor b).
    const canLog = r.user_id != null && r.irrigation_zone_id != null;
    if (nowMs - fireMs > ONCE_GRACE_MS) {
      await db.transaction(async (tx) => {
        await store.updateSchedule(tx, r.schedule_uuid, { once_state: 'SKIPPED' });
        if (canLog) await tx.run("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, duration_minutes, valve_deveui, payload_json) VALUES (?,?,?,?,?,?,?)", [r.user_id, r.irrigation_zone_id, 'SKIP', 'one_time_missed', r.duration_minutes, r.device_eui, JSON.stringify({ schedule_uuid: r.schedule_uuid, fire_at: r.fire_at })]);
      });
      if (!canLog) warn && warn('[valve-control] one_time_missed not logged for ' + r.device_eui + ' (no zone/user)');
      skipped.push({ schedule_uuid: r.schedule_uuid, device_eui: r.device_eui });
      continue;
    }
    const commandId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await store.updateSchedule(tx, r.schedule_uuid, { once_state: 'FIRED', once_fired_at: nowIso });
      if (canLog) await tx.run("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, duration_minutes, valve_deveui, payload_json) VALUES (?,?,?,?,?,?,?)", [r.user_id, r.irrigation_zone_id, 'IRRIGATE', 'one_time_open', r.duration_minutes, r.device_eui, JSON.stringify({ schedule_uuid: r.schedule_uuid, command_id: commandId })]);
    });
    if (!canLog) warn && warn('[valve-control] one_time_open not logged for ' + r.device_eui + ' (no zone/user)');
    fired.push({ schedule_uuid: r.schedule_uuid, device_eui: r.device_eui, duration_minutes: r.duration_minutes, command_id: commandId, actuator_command: actuatorCommand(r.device_eui, r.irrigation_zone_id, r.duration_minutes, commandId, 'one_time_open') });
  }
  return { fired, skipped };
}

async function runObserveTick({ db, now, warn }) {
  const nowDate = now || new Date();
  // (FW-T5) Read once per tick: the gateway-level default timezone joins the fallback chain
  // between a zoneless/unassigned valve and the hard 'UTC' floor.
  const gatewayTimezone = await store.getGatewaySetting(db, 'gateway_timezone', warn);
  const open = await db.all(`SELECT d.deveui, d.irrigation_zone_id, iz.timezone AS zone_timezone,
      (SELECT MAX(recorded_at) FROM device_data dd WHERE dd.deveui = d.deveui) AS last_uplink_at,
      zic.measured_flow_rate_lpm AS zone_flow_rate_lpm, vs.flow_rate_lpm, vs.flow_rate_source
    FROM devices d
    LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id
    LEFT JOIN valve_settings vs ON vs.device_eui = d.deveui
    LEFT JOIN zone_irrigation_calibration zic ON zic.zone_id = d.irrigation_zone_id
    WHERE d.type_id='STREGA_VALVE' AND d.deleted_at IS NULL AND d.current_state='OPEN'
      AND NOT EXISTS (SELECT 1 FROM valve_actuation_expectations v WHERE v.device_eui = d.deveui AND v.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING','STALE_OPEN_OBSERVED'))`);
  // (I1) STALE_OPEN_OBSERVED (the reconciliation monitor's own next state after
  // OBSERVED_RUNNING sits stale past expected_close_at + grace) must still block a duplicate:
  // the valve is still reporting OPEN and the row hasn't been explained by a CLOSED uplink yet.
  let created = 0;
  for (const d of open) {
    if (!d.last_uplink_at) continue;
    const tz = d.zone_timezone || gatewayTimezone || 'UTC';
    const schedules = await store.listSchedules(db, d.deveui);
    const { days } = P.compileWindows(schedules);
    const lp = P.localParts(nowDate, tz);
    const minuteOfDay = lp.hour * 60 + lp.minute;
    let hit = null; let hitDay = lp.weekday;
    for (const w of days[lp.weekday]) { if (minuteOfDay >= w.startMin && minuteOfDay < w.endMin) hit = w; }
    if (!hit) { // a window that started yesterday and wraps past midnight
      const y = (lp.weekday + 6) % 7;
      for (const w of days[y]) { if (w.endMin > 1440 && minuteOfDay < w.endMin - 1440) { hit = w; hitDay = y; } }
    }
    const flowRate = d.flow_rate_lpm != null ? Number(d.flow_rate_lpm) : (d.zone_flow_rate_lpm != null ? Number(d.zone_flow_rate_lpm) : null);
    const flowSource = d.flow_rate_lpm != null ? 'valve_' + (d.flow_rate_source || 'estimated') : (d.zone_flow_rate_lpm != null ? 'zone_calibration' : null);
    const uplinkMs = Date.parse(d.last_uplink_at);
    let commandedAt, durationSec, expectedClose, trigger, volumeSource, liters = null;
    if (hit) {
      const startOffsetMin = hitDay === lp.weekday ? minuteOfDay - hit.startMin : minuteOfDay + 1440 - hit.startMin;
      commandedAt = new Date(nowDate.getTime() - startOffsetMin * 60000);
      durationSec = (hit.endMin - hit.startMin) * 60;
      expectedClose = new Date(commandedAt.getTime() + durationSec * 1000 + DOWNLINK_LATENCY_BUDGET_SEC * 1000);
      trigger = 'on_valve_schedule';
      volumeSource = flowRate != null ? 'estimated_duration_flow_rate' : 'unknown';
      if (flowRate != null) liters = Math.round(flowRate * durationSec / 60);
    } else {
      commandedAt = new Date(uplinkMs); durationSec = 0; expectedClose = new Date(uplinkMs + 86400000); volumeSource = 'unknown';
      // (Task 4b) Not inside a schedule window - before defaulting to 'unexplained', check
      // whether the last thing we told this valve to do was a partial-opening/flushing
      // service command (Task 4 makes these greppable by a stable action-column prefix
      // regardless of the percentage suffix). If so this is an explained service action,
      // not a mystery open, even though - like 'unexplained' - we still have no expected
      // close time for it (SET_PARTIAL_OPENING/SET_FLUSHING are one-shot with no auto-close,
      // E4).
      const recentServiceLog = await db.get(
        "SELECT created_at FROM actuator_log WHERE UPPER(deveui) = UPPER(?) AND (action LIKE 'SET_PARTIAL_OPENING%' OR action LIKE 'SET_FLUSHING%') AND created_at <= ? ORDER BY created_at DESC LIMIT 1",
        [d.deveui, d.last_uplink_at]
      );
      const serviceLogMs = recentServiceLog ? Date.parse(recentServiceLog.created_at) : NaN;
      trigger = (Number.isFinite(serviceLogMs) && uplinkMs - serviceLogMs <= SERVICE_ACTION_LOOKBACK_MS) ? 'service_action' : 'unexplained';
    }
    await db.run(`INSERT INTO valve_actuation_expectations(expectation_id, device_eui, zone_id, command_id, effect_key, commanded_at, commanded_duration_seconds, expected_close_at, flow_rate_lpm, flow_rate_source, estimated_gross_liters, volume_source, observed_open_at, reconciliation_state, created_at, trigger)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), d.deveui, d.irrigation_zone_id, null, null, commandedAt.toISOString(), durationSec, expectedClose.toISOString(), flowRate, flowSource, liters, volumeSource, new Date(uplinkMs).toISOString(), 'OBSERVED_RUNNING', nowDate.toISOString(), trigger]);
    // Best-effort: see handleUplink's comment above.
    try { await runtime.emitRuntimeChanged(db, d.deveui, warn); }
    catch (e) { warn && warn('[valve-control] runObserveTick: runtime emit failed: ' + (e && e.message ? e.message : e)); }
    created += 1;
  }
  return { created };
}

async function runClockTick({ db, now, appId, warn }) {
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
    try { await runtime.emitRuntimeChanged(db, eui, warn); }
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
  const messages = [];
  for (const v of valves) {
    const tz = v.schedule_timezone || v.zone_timezone || gatewayTimezone || 'UTC';
    const last = v.last_clock_sync_queued_at ? Date.parse(v.last_clock_sync_queued_at) : 0;
    const due = nowDate.getTime() - last >= CLOCK_PERIOD_MS;
    const dst = last && P.isDstTransitionWithin(tz, last, nowDate.getTime());
    if (!due && !dst) continue;
    const q = await push.queuePushes({ db, deviceEui: v.deveui, appId, pushes: [push.buildClockPush(v.strega_generation || 'GEN1', nowDate, tz)], flushQueue: null, warn });
    await store.upsertSettings(db, v.deveui, { last_clock_sync_queued_at: nowDate.toISOString() });
    messages.push(...q.messages);
  }
  return { messages };
}

// Housekeeping that rides on the clock tick (the tick itself runs every 10 minutes, not hourly):
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
let lastClockTickMs = null;
// Test-only: the clock-jump detector's "delta since the previous tick" state is deliberately
// module-scoped (production wants it to persist across ticks within one Node-RED runtime; the
// first tick after every redeploy just seeds it and never trips). Tests in the same file share
// that module instance, so each housekeeping test must reset it first to stay order-independent.
function _resetHousekeepingForTests() { lastClockTickMs = null; }
const CLOCK_JUMP_BACKWARD_MS = -60 * 1000;
const CLOCK_JUMP_FORWARD_MS = 6 * 3600 * 1000;
async function runHousekeeping({ db, now, appId, warn }) {
  const nowDate = now || new Date();
  // (FW-T5) Read once per tick, same rationale as runObserveTick above.
  const gatewayTimezone = await store.getGatewaySetting(db, 'gateway_timezone', warn);
  const out = { resets: 0, clockJump: false, decommissioned: 0, messages: [] };
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
    const pushes = push.buildPlanPushes({ generation: g.gen, days, lastHashes: {}, force: true }).concat([push.buildStatusPush('2')]);
    const q = await push.queuePushes({ db, deviceEui: g.deveui, appId, pushes, flushQueue: null, warn });
    out.messages.push(...q.messages); out.decommissioned += 1;
  }
  return out;
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
  // Bovey cloud full-parity Task P4-E1 review fix (Important 2): this loop mutates
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

module.exports = { handleUplink, runOnceTick, runObserveTick, runClockTick, runHousekeeping, runTriggerBackfill, ONCE_GRACE_MS, _resetHousekeepingForTests };
