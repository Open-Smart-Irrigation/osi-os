'use strict';
// All functions accept either the osi-db-helper Database facade or a transaction scope (tx) — both expose get/all/run returning promises.

const VALVE_LIST_SQL = `
SELECT d.deveui, d.name, d.type_id, d.irrigation_zone_id, d.current_state, d.target_state, d.user_id,
       iz.name AS zone_name, iz.zone_uuid, iz.timezone AS zone_timezone,
       COALESCE(vs.strega_generation,'GEN1') AS strega_generation, vs.flow_rate_lpm, vs.flow_rate_source, vs.default_open_minutes,
       COALESCE(vs.scheduler_status,'ACTIVE') AS scheduler_status, vs.skip_today_date, vs.last_clock_sync_queued_at, vs.last_clock_sync_acked_at,
       zic.measured_flow_rate_lpm AS zone_flow_rate_lpm,
       (SELECT MAX(dd.recorded_at) FROM device_data dd WHERE dd.deveui = d.deveui) AS last_uplink_at,
       -- Bounded to a 7-day lookback (review R1, MAJOR-1): a valve whose columns are always
       -- NULL (every GEN2 unit — no such sensor; a GEN1 unit pinned on the 125/100
       -- "no sensor fitted" sentinel; anything on pre-feature firmware) has no stopping point
       -- for the unbounded "ORDER BY recorded_at DESC LIMIT 1" scan and walks its entire
       -- device_data partition on every request, forever (device_data has no retention
       -- anywhere in the repo). The range predicate is served by the existing
       -- (deveui, recorded_at) index, so this is a plan change, not a schema change: a
       -- never-reporting valve's cost goes from linear in the partition's total row count to
       -- flat, independent of it (review R2 measured this holding constant across a 16x table
       -- growth; the absolute ms figure is fixture-dependent — how the rows are spread across
       -- the cutoff — so it isn't quoted here). Behavioural side effect, intentional: a reading
       -- older than 7 days now reports as absent rather than being shown as current, which is
       -- the honest answer for a diagnostic value.
       (SELECT dd.ambient_temperature FROM device_data dd WHERE dd.deveui = d.deveui AND dd.ambient_temperature IS NOT NULL AND dd.recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 day') ORDER BY dd.recorded_at DESC LIMIT 1) AS enclosure_temperature_c,
       (SELECT dd.relative_humidity FROM device_data dd WHERE dd.deveui = d.deveui AND dd.relative_humidity IS NOT NULL AND dd.recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 day') ORDER BY dd.recorded_at DESC LIMIT 1) AS enclosure_humidity_pct,
       -- (review R1, §2) MAX(recorded_at) over rows carrying EITHER value: this timestamps the
       -- newest enclosure reading, not either number individually. When temperature and
       -- humidity come from two different rows (subqueries above are independent on purpose),
       -- this label can be newer than the row the older of the two numbers actually came from.
       -- Do not build a per-value staleness gate on this field without per-column timestamps.
       (SELECT MAX(dd.recorded_at) FROM device_data dd WHERE dd.deveui = d.deveui AND (dd.ambient_temperature IS NOT NULL OR dd.relative_humidity IS NOT NULL) AND dd.recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 day')) AS enclosure_measured_at,
       (SELECT vae.expectation_id FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_expectation_id,
       (SELECT vae.reconciliation_state FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_reconciliation_state,
       (SELECT vae.commanded_at FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_commanded_at,
       (SELECT vae.expected_close_at FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_expected_close_at,
       (SELECT vae.commanded_duration_seconds FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_duration_seconds,
       (SELECT vae.trigger FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_trigger,
       (SELECT vae.reconciliation_state FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state LIKE 'STALE_%' AND datetime(vae.commanded_at) > datetime('now','-1 day') ORDER BY vae.commanded_at DESC LIMIT 1) AS recent_stale_state
  FROM devices d
  LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL
  LEFT JOIN valve_settings vs ON vs.device_eui = d.deveui
  LEFT JOIN zone_irrigation_calibration zic ON zic.zone_id = d.irrigation_zone_id
 WHERE d.type_id = 'STREGA_VALVE' AND d.deleted_at IS NULL AND d.user_id = ?
 ORDER BY COALESCE(iz.name,'~'), d.name`;

async function listValvesForUser(db, userId) { return db.all(VALVE_LIST_SQL, [userId]); }

async function listSchedules(db, deviceEui) {
  return db.all('SELECT vs.*, i.state AS dispatch_state, i.command_id AS dispatch_command_id, i.created_at AS dispatch_created_at, i.attempted_at AS dispatch_attempted_at FROM valve_schedules vs LEFT JOIN valve_once_dispatch_intents i ON i.schedule_uuid=vs.schedule_uuid WHERE UPPER(vs.device_eui)=UPPER(?) AND vs.deleted_at IS NULL ORDER BY vs.kind, vs.start_time, vs.fire_at', [deviceEui]);
}

const SETTINGS_DEFAULTS = { strega_generation: 'GEN1', flow_rate_lpm: null, flow_rate_source: null, default_open_minutes: null, scheduler_status: 'ACTIVE', skip_today_date: null, last_clock_sync_queued_at: null, last_clock_sync_acked_at: null };

async function getSettings(db, deviceEui) {
  const row = await db.get('SELECT * FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [deviceEui]);
  return Object.assign({}, SETTINGS_DEFAULTS, row || {}, { device_eui: String(deviceEui).toUpperCase() });
}

const SETTINGS_COLUMNS = ['strega_generation', 'flow_rate_lpm', 'flow_rate_source', 'flow_rate_updated_at', 'default_open_minutes', 'scheduler_status', 'skip_today_date', 'last_clock_sync_queued_at', 'last_clock_sync_acked_at'];

// Subset of SETTINGS_COLUMNS that is part of the synced ValveSettings resource (
// cloud full-parity Task P2-E1, migration 0025's trigger pair). last_clock_sync_queued_at/
// acked_at are edge-local push-tracking bookkeeping written on nearly every scheduler tick
// for a GEN2 valve (push.js/workers.js), and flow_rate_updated_at is a companion timestamp
// for flow_rate_lpm/flow_rate_source, not itself a resource field. sync_version is only
// bumped -- and the trg_sync_valve_settings_outbox_ai/_au triggers only fire -- when a
// write actually touches one of these; otherwise a routine 10-minute clock-sync push would
// flood sync_outbox with events the cloud contract does not even model.
const SYNCED_SETTINGS_COLUMNS = ['strega_generation', 'flow_rate_lpm', 'flow_rate_source', 'default_open_minutes', 'scheduler_status', 'skip_today_date'];

async function upsertSettings(db, deviceEui, patch) {
  const cols = SETTINGS_COLUMNS.filter((c) => Object.prototype.hasOwnProperty.call(patch || {}, c));
  if (!cols.length) return;
  const eui = String(deviceEui).toUpperCase();
  await db.run('INSERT OR IGNORE INTO valve_settings(device_eui) VALUES (?)', [eui]);
  const bumpSyncVersion = cols.some((c) => SYNCED_SETTINGS_COLUMNS.includes(c));
  // datetime('now') (space-separated), not a hand-rolled ISO strftime: this matches the
  // column's own DEFAULT (datetime('now')) so every write to valve_settings.updated_at is the
  // same format, regardless of whether the row was just INSERTed or is being UPDATEd here.
  const setClause = cols.map((c) => c + '=?').join(', ')
    + (bumpSyncVersion ? ', sync_version = COALESCE(sync_version,0)+1' : '')
    + ", updated_at=datetime('now')";
  await db.run('UPDATE valve_settings SET ' + setClause + ' WHERE device_eui=?', cols.map((c) => patch[c]).concat([eui]));
}

// node:sqlite's DatabaseSync/StatementSync rejects `undefined` bind params (must be `null`);
// optional columns (label, weekdays_mask, start_time, fire_at) are legitimately absent for
// the WEEKLY/ONCE variant that doesn't use them, so normalize undefined -> null here.
function n(v) { return v === undefined ? null : v; }

async function insertSchedule(db, r) {
  await db.run(
    'INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, fire_at, duration_minutes, timezone, enabled, once_state) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [r.schedule_uuid, String(r.device_eui).toUpperCase(), r.kind, n(r.label), n(r.weekdays_mask), n(r.start_time), n(r.fire_at), r.duration_minutes, r.timezone, r.enabled, r.kind === 'ONCE' ? 'PENDING' : null]
  );
}

const SCHEDULE_COLUMNS = ['label', 'weekdays_mask', 'start_time', 'fire_at', 'duration_minutes', 'timezone', 'enabled', 'once_state', 'once_fired_at'];

// (F144) Every valve on a gateway shares ONE valve_schedules table and schedule_uuid is
// globally UNIQUE in it, so a write that matches on schedule_uuid alone can land on another
// valve's row. The owning device_eui is therefore part of the key for every schedule write,
// not a caller-side convention: a scope that names the wrong valve matches nothing (0 rows,
// no sync_version bump), and a missing scope is a programming error that throws rather than
// silently degrading to uuid-only matching. Callers that hold the row already (api.js's
// routes, workers.js's ONCE tick) pass the EUI they looked it up with; cloud-commands.js
// passes the EUI the command addressed.
const EUI_SCOPE_RE = /^[0-9A-F]{16}$/;

function onceFireAtImmutableError() {
  const error = new Error('A live terminal ONCE schedule cannot change fire_at; delete and revive it with the new time.');
  error.code = 'once_fire_at_immutable';
  error.statusCode = 409;
  return error;
}

function scheduleScope(deviceEui, fnName) {
  const eui = String(deviceEui == null ? '' : deviceEui).trim().toUpperCase();
  if (!EUI_SCOPE_RE.test(eui)) throw new Error(fnName + ': a 16-hex deviceEui scope is required');
  return eui;
}

// Callers cannot rely on a change count here: the live osi-db-helper facade's run() resolves
// undefined, so these deliberately return nothing. Whether the row existed/was updated is the
// caller's job to check (e.g. re-SELECT), not something this function can report.
async function updateSchedule(db, scheduleUuid, patch, deviceEui) {
  const eui = scheduleScope(deviceEui, 'updateSchedule');
  const cols = SCHEDULE_COLUMNS.filter((c) => Object.prototype.hasOwnProperty.call(patch || {}, c));
  if (!cols.length) return;
  const hasFireAt = Object.prototype.hasOwnProperty.call(patch || {}, 'fire_at');
  const fireAt = hasFireAt ? n(patch.fire_at) : null;
  const terminalFence = hasFireAt
    ? " AND (kind <> 'ONCE' OR once_state IS NULL OR once_state NOT IN ('FIRED','SKIPPED') OR fire_at=?)"
    : '';
  const params = cols.map((c) => patch[c]).concat(hasFireAt ? [scheduleUuid, eui, fireAt] : [scheduleUuid, eui]);
  // datetime('now'), matching valve_schedules.updated_at/created_at's own DEFAULT (datetime('now')).
  await db.run('UPDATE valve_schedules SET ' + cols.map((c) => c + '=?').join(', ') + ", sync_version = COALESCE(sync_version,0)+1, updated_at=datetime('now') WHERE schedule_uuid=? AND UPPER(device_eui)=? AND deleted_at IS NULL" + terminalFence, params);
  if (hasFireAt) {
    const after = await db.get('SELECT kind, fire_at, once_state FROM valve_schedules WHERE schedule_uuid=? AND UPPER(device_eui)=? AND deleted_at IS NULL', [scheduleUuid, eui]);
    if (after && after.kind === 'ONCE' && ['FIRED', 'SKIPPED'].includes(after.once_state) && after.fire_at !== fireAt) throw onceFireAtImmutableError();
  }
}

// A cloud upsert without deleted_at means the desired state is live. Tombstones retain their
// globally unique UUID and owner, so revival must clear deleted_at in the same scoped write as
// the validated schedule fields. The live osi-db-helper facade's run() resolves undefined;
// re-read the row so callers can distinguish a row that actually became live from a missed
// update (the test facade also exposes changes, which is checked when available).
async function reviveSchedule(db, scheduleUuid, patch, deviceEui) {
  const eui = scheduleScope(deviceEui, 'reviveSchedule');
  const cols = ['kind'].concat(SCHEDULE_COLUMNS).filter((c) => Object.prototype.hasOwnProperty.call(patch || {}, c));
  const result = await db.run(
    'UPDATE valve_schedules SET ' + cols.map((c) => c + '=?').concat(['deleted_at=NULL', 'sync_version=COALESCE(sync_version,0)+1', "updated_at=datetime('now')"]).join(', ') +
      ' WHERE schedule_uuid=? AND UPPER(device_eui)=? AND deleted_at IS NOT NULL',
    cols.map((c) => patch[c]).concat([scheduleUuid, eui])
  );
  if (result && Object.prototype.hasOwnProperty.call(result, 'changes') && Number(result.changes) !== 1) return false;
  const row = await db.get('SELECT kind, label, weekdays_mask, start_time, fire_at, duration_minutes, timezone, enabled, once_state, once_fired_at, deleted_at FROM valve_schedules WHERE schedule_uuid=? AND UPPER(device_eui)=?', [scheduleUuid, eui]);
  if (!row || row.deleted_at !== null) return false;
  return cols.every((c) => row[c] === (patch[c] === undefined ? null : patch[c]));
}

async function softDeleteSchedule(db, scheduleUuid, deviceEui) {
  const eui = scheduleScope(deviceEui, 'softDeleteSchedule');
  await db.run("UPDATE valve_schedules SET deleted_at=datetime('now'), sync_version=COALESCE(sync_version,0)+1, updated_at=datetime('now') WHERE schedule_uuid=? AND UPPER(device_eui)=? AND deleted_at IS NULL", [scheduleUuid, eui]);
}

// CMD-04 PR0 (owner decision Q02 = (c)): a LOST push is a row of the latest snapshot that the
// 24 h sweep found unacknowledged -- the valve may not hold that plan. 0022's CHECK on
// valve_schedule_pushes.state admits only QUEUED/ACKED/FAILED/SUPERSEDED, and widening it is a
// table rebuild, so LOST is stored as state FAILED with one of these errors and read back as
// LOST (isLostRow, weekdayPushStates). 'stale_unconfirmed' is what failStalePushes writes;
// 'not_resent_q02c' is the flush-loss reason markFlushedSnapshotLost writes when a cancel or
// unclaim flush drops a snapshot that was already on the air (R5 H1). Same strings as the conditional-scheduling branch.
const LOST_STALE = 'stale_unconfirmed';
const LOST_NOT_RESENT = 'not_resent_q02c';
const LOST_REASONS = [LOST_STALE, LOST_NOT_RESENT];
function isLostRow(r) { return !!r && r.state === 'FAILED' && LOST_REASONS.includes(r.error); }

// A DAYMASK_PLAN row's mask, decoded from its payload's first hex byte, with the 0x80
// "all-days" sentinel normalized to the literal 7-bit mask (0x7F) it represents.
function daymaskOf(payloadHex) {
  const raw = parseInt(String(payloadHex).slice(0, 2), 16);
  return raw === 0x80 ? 0x7F : raw;
}

// (CMD-04 PR0) lastPushHashes, the per-weekday diff basis, is gone: every compile is now a full
// snapshot (push.compileAndQueue), so nothing decides "already pushed" any more.

async function insertPushes(db, rows) {
  for (const r of rows) {
    await db.run('INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, weekday, fport, payload_hex, plan_hash) VALUES (?,?,?,?,?,?,?)', [r.push_id, String(r.device_eui).toUpperCase(), r.purpose, r.weekday, r.fport, r.payload_hex, r.plan_hash]);
  }
}

// CRITICAL 1 (review round 1): SQLite's CAST does not parse hex text — CAST(('0x'||'80') AS
// INTEGER) is 0, not 128 — so the old SQL-side mask-equality WHERE clause here never matched
// and the DAYMASK_PLAN branch was dead code: a forced GEN2 re-push left two QUEUED rows for
// the same plan, which failStalePushes later turned into a spurious FAILED entry. Separately,
// exact-mask equality would have been the wrong comparison anyway (CRITICAL 2): regrouping
// means a new push's mask can legitimately differ from an old QUEUED row's mask while still
// covering some of the same weekdays, so a row must be superseded whenever its mask
// *intersects* the new push's mask, not only when it matches exactly. Both are fixed by
// decoding masks and intersecting them in JS, then superseding by push_id.
async function supersedeQueuedGen2(db, deviceEui, daymask) {
  const rows = await db.all("SELECT push_id, payload_hex FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose='DAYMASK_PLAN' AND state='QUEUED'", [deviceEui]);
  const newMask = daymask === 0x80 ? 0x7F : daymask;
  for (const r of rows) {
    if ((daymaskOf(r.payload_hex) & newMask) !== 0) {
      await db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE push_id=?", [r.push_id]);
    }
  }
}

async function supersedeQueued(db, deviceEui, purpose, weekdayOrMask) {
  if (purpose === 'WEEKDAY_PLAN') {
    return db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE UPPER(device_eui)=UPPER(?) AND purpose='WEEKDAY_PLAN' AND weekday=? AND state='QUEUED'", [deviceEui, weekdayOrMask]);
  }
  if (purpose === 'DAYMASK_PLAN') {
    return supersedeQueuedGen2(db, deviceEui, weekdayOrMask);
  }
  return db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE UPPER(device_eui)=UPPER(?) AND purpose=? AND state='QUEUED'", [deviceEui, purpose]);
}

// The live osi-db-helper facade's run() resolves undefined (no change count), so ackPush
// counts via SELECT-then-UPDATE instead of trusting run()'s return value.
async function ackPush(db, deviceEui, purpose, fport, weekdayOrNull, status, atIso) {
  const where = weekdayOrNull == null ? '' : ' AND weekday=?';
  const selParams = [deviceEui, purpose, fport].concat(weekdayOrNull == null ? [] : [weekdayOrNull]);
  const row = await db.get("SELECT push_id FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose=? AND fport=? AND state='QUEUED'" + where + ' ORDER BY rowid DESC LIMIT 1', selParams);
  if (!row) return 0;
  // CMD-04 PR0: a snapshot still waiting out the debounce window has not been sent, so an ACK
  // arriving now answers an earlier (superseded) push and must not confirm the new row.
  // SUPERSEDED and LOST rows are never matched (state='QUEUED' above). The remaining weak spot,
  // recorded for CMD-04 proper: once the new snapshot is on the air, an earlier push's late ACK
  // on the same port/purpose/weekday still credits the new row.
  const pendingSnap = await getSnapshotPending(db, deviceEui);
  if (pendingSnap && pendingSnap.push_ids.includes(row.push_id)) return 0;
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', ack_status=?, acked_at=? WHERE push_id=?", [status, atIso, row.push_id]);
  return 1;
}

async function failStalePushes(db, olderThanIso) {
  // (C2) queued_at is the DB's own datetime('now') default (space-separated); olderThanIso is
  // an ISO instant built by the caller. A raw string comparison mixes formats: at the
  // date/time separator, ' ' (0x20) always sorts below 'T' (0x54) — below every digit, in fact
  // — so on any day the two values happen to share, a genuinely-fresh space-form queued_at
  // reads as "less than" the ISO cutoff regardless of the actual clock time, failing healthy
  // pushes early. Wrapping both sides in datetime() normalizes them to the same canonical form
  // before comparing.
  // CMD-04 PR0: a plan or scheduler-status row still QUEUED here belongs to the latest snapshot
  // (every compile supersedes the older ones), so it becomes LOST ('stale_unconfirmed') and is
  // surfaced; nothing re-sends it. A CLOCK_SYNC keeps the plain 'no_ack_24h' failure.
  return db.run("UPDATE valve_schedule_pushes SET state='FAILED', error=CASE WHEN purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN','SCHEDULER_STATUS') THEN ? ELSE 'no_ack_24h' END WHERE state='QUEUED' AND datetime(queued_at) < datetime(?)", [LOST_STALE, olderThanIso]);
}

// P3-E1 review fix (IMPORTANT 1): devices with a QUEUED WEEKDAY_PLAN/DAYMASK_PLAN row past
// olderThanIso -- i.e. the set failStalePushes(olderThanIso) is about to flip to FAILED. Only
// those two purposes feed ValveRuntime.push_state (pushSummary/weekdayPushStates both filter to
// them), so this is deliberately narrower than failStalePushes' own fleet-wide, all-purposes
// UPDATE. Callers must SELECT this BEFORE calling failStalePushes (the UPDATE would otherwise
// have already erased the QUEUED state this query keys on), then emit once per returned
// device_eui afterward -- otherwise a valve whose plan push aged out with no ack shows "queued"
// in the cloud forever, since nothing else touches push_state until the next unrelated seam fires.
async function staleQueuedPlanDeviceEuis(db, olderThanIso) {
  const rows = await db.all(
    "SELECT DISTINCT device_eui FROM valve_schedule_pushes WHERE state='QUEUED' AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN','SCHEDULER_STATUS') AND datetime(queued_at) < datetime(?)",
    [olderThanIso]
  );
  return rows.map((r) => r.device_eui);
}

// (final-fix-wave IMPORTANT 1) The naive SUM(...)-over-30-days form counted every ACKED/QUEUED
// row across every purpose, so a plan re-edit within the window left the OLD (now-superseded-
// by-newer-row, but not state-SUPERSEDED because it was already ACKED) rows in the tally
// alongside the new ones, inflating "{{acked}} of {{total}}" (e.g. 7 acked + 7 queued = "7 of
// 14" instead of "0 of 7"), and mixed in CLOCK_SYNC/SCHEDULER_STATUS pushes that have nothing
// to do with the weekday plan. Fixed to latest-per-slot semantics, matching how the schedule
// dialog's own per-weekday badges are derived (latestPush() in ValveScheduleDialog.tsx): group
// rows by weekday slot (GEN1: the row's own `weekday`; GEN2: every weekday bit set in the
// row's decoded daymask, via daymaskOf()), keep only the
// newest row per slot, and count states from that reduced set. last_plan_queued_at/
// last_plan_acked_at are unrelated to the per-slot ratio and keep their prior semantics.
// PR-H: the 30-day lookback below used to be SQLite's own wall clock (bare `datetime('now',
// '-30 day')`), ignoring any clock a caller had injected for test determinism (runClockTick /
// runHousekeeping thread a `now` through workers.js precisely so a fixed test date produces
// deterministic results). A caller that fixes `now` in the past (or the future) got a filter
// window computed against the *real* current wall-clock time instead of its own `now`, so a
// row backdated relative to the injected clock could silently fall outside (or inside) the
// window depending only on how far the real clock has since moved from the fixture's date --
// workers.test.js's P3-E1 runClockTick regression is exactly this: a push backdated 3 days
// before a 2026-08-19 fixture `now` looks correctly within-window against that fixture, but
// drifts out of a *real* 30-day-ago cutoff as soon as the actual calendar date moves far enough
// past 2026-08-19. `now` is optional (ISO string or Date, default `new Date()`) so callers with
// no clock of their own keep exactly the previous (real-wall-clock) behaviour.
// Newest per slot means LAST INSERTED: every newest-per-slot read of valve_schedule_pushes
// (ackPush, pushSummary, weekdayPushStates, and queuedPushesById's
// oldest-first listing) orders by rowid alone. The ledger is append-only (no DELETE, no INSERT OR REPLACE;
// state changes are UPDATEs, which keep the rowid) and the table has no AUTOINCREMENT, so a
// new row always gets a rowid above every existing one: rowid order is insertion order, which
// is the order ChirpStack delivers downlinks in and therefore what the valve holds last.
// queued_at is the wrong key for two reasons. (F135) It is written only by the column default
// datetime('now'), whole seconds, so two recompiles inside one second tie and SQLite's sort
// does not promise an order for ties; the customer test gateway's harness hit that (a NACKed
// and a dropped-ACK recompile 0.4 s apart, GET /api/valves reporting queued 0 / acked 7 while
// three plan pushes sat QUEUED). And it is the gateway's wall clock, which can step backwards
// (see runHousekeeping's clock-jump detector): a push queued after the step carries an earlier
// timestamp than the push before it, and a queued_at-first order would keep treating the
// earlier push as current -- the old per-weekday diff (since replaced by full snapshots) would then skip re-pushing a weekday reverted to
// that earlier plan, leaving the valve on the plan it actually holds. queued_at still bounds
// the 30-day window below; it no longer decides which row is newest.
async function pushSummary(db, deviceEui, now) {
  const nowIso = now instanceof Date ? now.toISOString() : (now || new Date().toISOString());
  // CMD-04 PR0: the newest row per slot is picked over the whole ledger, not only the 30-day
  // window, so a LOST slot stays surfaced however old it is (Q02 (c): a lost plan is never
  // silently expired). The window still bounds QUEUED/ACKED/FAILED counting exactly as before:
  // a slot whose newest row is older than 30 days is counted only when that row is LOST.
  const rows = await db.all(
    "SELECT purpose, weekday, payload_hex, state, error, queued_at, (queued_at > datetime(?,'-30 day')) AS in_window FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state IN ('QUEUED','ACKED','FAILED') ORDER BY rowid DESC",
    [nowIso, deviceEui]
  );
  const latestBySlot = {};
  for (const r of rows) {
    if (r.purpose === 'WEEKDAY_PLAN') {
      const key = 'WEEKDAY_PLAN:' + r.weekday;
      if (!(key in latestBySlot)) latestBySlot[key] = r;
      continue;
    }
    // Per-weekday expansion: a DAYMASK_PLAN row covers every weekday
    // bit set in its decoded mask, and the newest row wins each of those slots individually.
    const mask = daymaskOf(r.payload_hex);
    for (let d = 0; d < 7; d += 1) {
      if (!((mask >> d) & 1)) continue;
      const key = 'GEN2DAY:' + d;
      if (!(key in latestBySlot)) latestBySlot[key] = r;
    }
  }
  // `failed` keeps its old meaning for every consumer that predates LOST (an old cloud renders
  // "not yet confirmed -- resend the plan" from it): LOST slots are counted in it, and `lost` is
  // the subset whose device may not hold the plan because a flush dropped it unsent.
  let queued = 0, acked = 0, failed = 0, lost = 0;
  for (const r of Object.values(latestBySlot)) {
    if (isLostRow(r)) { failed += 1; lost += 1; continue; }
    if (!Number(r.in_window)) continue;
    if (r.state === 'QUEUED') queued += 1;
    else if (r.state === 'ACKED') acked += 1;
    else if (r.state === 'FAILED') failed += 1;
  }
  const meta = await db.get(`SELECT
      MAX(CASE WHEN purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') THEN queued_at END) AS last_plan_queued_at,
      MAX(CASE WHEN purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state='ACKED' THEN acked_at END) AS last_plan_acked_at
    FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND queued_at > datetime(?,'-30 day')`, [deviceEui, nowIso]);
  // A SCHEDULER_STATUS push (pause / skip today / resume) is configuration too: when the newest
  // one was dropped by a flush, the valve may still run a state the operator changed.
  const status = await db.get(
    "SELECT state, error FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose='SCHEDULER_STATUS' AND state IN ('QUEUED','ACKED','FAILED') ORDER BY rowid DESC LIMIT 1",
    [deviceEui]
  );
  return {
    queued, acked, failed, lost,
    scheduler_status_lost: !!(status && isLostRow(status)),
    last_plan_queued_at: (meta && meta.last_plan_queued_at) || null,
    last_plan_acked_at: (meta && meta.last_plan_acked_at) || null,
  };
}

// CMD-04 PR0: mark every QUEUED row of these purposes SUPERSEDED (a snapshot replaces them all)
// and return how many there were. SELECT first: the live osi-db-helper facade's run() returns
// no change count.
async function supersedeOutstanding(db, deviceEui, purposes) {
  const marks = purposes.map(() => '?').join(',');
  const where = "UPPER(device_eui)=UPPER(?) AND state='QUEUED' AND purpose IN (" + marks + ')';
  const rows = await db.all('SELECT push_id FROM valve_schedule_pushes WHERE ' + where, [deviceEui].concat(purposes));
  if (rows.length) await db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE " + where, [deviceEui].concat(purposes));
  return rows.length;
}

// (R5 L1) Has the valve ever had a WEEKLY schedule here, tombstones included? (Bluetooth
// guard in push.compileAndQueue, together with hasPlanHistory.)
async function hasWeeklyEver(db, deviceEui) {
  const row = await db.get("SELECT 1 AS x FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND kind='WEEKLY' LIMIT 1", [deviceEui]);
  return !!row;
}

// (R5 H1) A whole-queue flush outside a snapshot compile (cancel, unclaim's cancel, the cloud
// cancel) removes whatever was on the air. The latest snapshot's rows still QUEUED there are
// LOST: marked FAILED 'not_resent_q02c' at once so "device may not hold this plan" shows now,
// not after the 24 h sweep. Nothing re-sends them (Q02 c). A snapshot still waiting out the
// debounce window was never in the radio queue, so its rows are left alone and still sent. A
// flushed, unconfirmed CLOCK_SYNC is SUPERSEDED and the valve made due for a fresh one.
async function markFlushedSnapshotLost(db, deviceEui) {
  const pending = await getSnapshotPending(db, deviceEui);
  const keep = new Set(pending ? pending.push_ids : []);
  const rows = await db.all("SELECT push_id FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND state='QUEUED' AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN','SCHEDULER_STATUS')", [deviceEui]);
  const lost = rows.filter((r) => !keep.has(r.push_id));
  for (const r of lost) await db.run("UPDATE valve_schedule_pushes SET state='FAILED', error=? WHERE push_id=? AND state='QUEUED'", [LOST_NOT_RESENT, r.push_id]);
  const clocks = await supersedeOutstanding(db, deviceEui, ['CLOCK_SYNC']);
  if (clocks) await upsertSettings(db, deviceEui, { last_clock_sync_queued_at: null });
  return { lost: lost.length, clocksSuperseded: clocks };
}

// Has this gateway ever queued a plan for the valve? (Bluetooth guard in push.compileAndQueue.)
async function hasPlanHistory(db, deviceEui) {
  const row = await db.get("SELECT 1 AS x FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') LIMIT 1", [deviceEui]);
  return !!row;
}

// The snapshot waiting for the debounced emitter (push.emitPendingSnapshots), one per valve, in
// the gateway key/value store app_settings (no trigger, not synced): key
// 'valve_snapshot_pending:<EUI>', value JSON { edited_at, push_ids }.
const SNAPSHOT_PENDING_PREFIX = 'valve_snapshot_pending:';

function parsePending(key, raw) {
  try {
    const v = JSON.parse(raw);
    return { device_eui: key.slice(SNAPSHOT_PENDING_PREFIX.length), edited_at: v.edited_at || null, first_edited_at: v.first_edited_at || null, push_ids: Array.isArray(v.push_ids) ? v.push_ids : [], raw };
  } catch (_) {
    return { device_eui: key.slice(SNAPSHOT_PENDING_PREFIX.length), edited_at: null, first_edited_at: null, push_ids: [], raw };
  }
}

async function setSnapshotPending(db, deviceEui, value) {
  await db.run(
    "INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    [SNAPSHOT_PENDING_PREFIX + String(deviceEui).toUpperCase(), JSON.stringify(value)]
  );
}

async function clearSnapshotPending(db, deviceEui) {
  await db.run('DELETE FROM app_settings WHERE key = ?', [SNAPSHOT_PENDING_PREFIX + String(deviceEui).toUpperCase()]);
}

// Reads tolerate a DB that predates app_settings (migration 0023): nothing can be pending there.
function isMissingAppSettings(error) {
  return /no such table:\s*app_settings\b/i.test(String(error && error.message ? error.message : error));
}

async function getSnapshotPending(db, deviceEui) {
  const key = SNAPSHOT_PENDING_PREFIX + String(deviceEui).toUpperCase();
  let row = null;
  try { row = await db.get('SELECT value FROM app_settings WHERE key = ?', [key]); }
  catch (error) { if (isMissingAppSettings(error)) return null; throw error; }
  return row ? parsePending(key, row.value) : null;
}

async function listSnapshotPending(db) {
  let rows = [];
  try { rows = await db.all("SELECT key, value FROM app_settings WHERE key LIKE 'valve_snapshot_pending:%' ORDER BY key"); }
  catch (error) { if (isMissingAppSettings(error)) return []; throw error; }
  return rows.map((r) => parsePending(r.key, r.value));
}

// The still-QUEUED rows among push_ids, in insertion order (ChirpStack delivers FIFO).
async function queuedPushesById(db, deviceEui, pushIds) {
  if (!pushIds || !pushIds.length) return [];
  const rows = await db.all(
    "SELECT push_id, purpose, weekday, fport, payload_hex FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND state='QUEUED' AND push_id IN (" + pushIds.map(() => '?').join(',') + ') ORDER BY rowid',
    [deviceEui].concat(pushIds)
  );
  return rows;
}

// Single-device counterpart of VALVE_LIST_SQL's active_expectation_id/active_reconciliation_state/
// active_commanded_at/active_expected_close_at/active_duration_seconds/active_trigger subqueries
// above -- same predicate (newest PENDING_OBSERVATION/OBSERVED_RUNNING row), parameterized on
// device_eui instead of correlated on d.deveui. Used by runtime.js's buildRuntimePayload(), which
// needs this per-device rather than batched across every valve a user owns.
async function activeActuation(db, deviceEui) {
  return db.get(
    'SELECT expectation_id, reconciliation_state, commanded_at, expected_close_at, ' +
    'commanded_duration_seconds AS duration_seconds, trigger ' +
    'FROM valve_actuation_expectations ' +
    "WHERE UPPER(device_eui) = UPPER(?) AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') " +
    'ORDER BY commanded_at DESC LIMIT 1',
    [deviceEui]
  );
}

// Single-device counterpart of VALVE_LIST_SQL's recent_stale_state subquery above.
async function recentStaleState(db, deviceEui) {
  const row = await db.get(
    'SELECT reconciliation_state FROM valve_actuation_expectations ' +
    "WHERE UPPER(device_eui) = UPPER(?) AND reconciliation_state LIKE 'STALE_%' " +
    "AND datetime(commanded_at) > datetime('now','-1 day') " +
    'ORDER BY commanded_at DESC LIMIT 1',
    [deviceEui]
  );
  return row ? row.reconciliation_state : null;
}

async function hasPendingObservation(db, deviceEui) {
  const row = await db.get("SELECT 1 AS x FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?) AND reconciliation_state='PENDING_OBSERVATION' LIMIT 1", [deviceEui]);
  return !!row;
}

async function weekdayPushStates(db, deviceEui) {
  // CMD-04 PR0: a LOST row (stored FAILED + a LOST_REASONS error, see isLostRow) is reported as
  // state 'LOST' to the edge API/GUI. runtime.js maps it back to FAILED + lost:true for the
  // synced ValveRuntime, whose contract enum an older cloud still renders.
  const rows = await db.all("SELECT purpose, weekday, payload_hex, state, queued_at, acked_at, error FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state IN ('QUEUED','ACKED','FAILED') ORDER BY rowid DESC", [deviceEui]);
  return rows.map((r) => (isLostRow(r) ? Object.assign({}, r, { state: 'LOST' }) : r));
}

// Gateway-level default timezone (FW-T5), read from app_settings(key='gateway_timezone').
// Swallow-with-default everywhere (FW-T5 review R1, m6): this is called once per scheduled
// worker tick (runObserveTick/runClockTick/runHousekeeping), none of which touched
// app_settings before FW-T5 and none of which has any enclosing try/catch around this one
// call — a rethrown error would abort the entire tick over a single non-critical setting
// read, not just this lookup. No caller anywhere discriminates on the specific error (the
// generic 500-catch in an HTTP handler is not "genuine handling" of this read failing), so
// every failure mode — missing table, transient read error, anything else — resolves to
// null (never throws), exactly like an absent row, letting every caller fall back to 'UTC'
// the same way it always has. Matches osi-system-settings/api.js's readGatewayTimezone,
// which uses the same policy.
async function getGatewaySetting(db, key, warn) {
  try {
    const row = await db.get('SELECT value FROM app_settings WHERE key = ?', [key]);
    return row ? row.value : null;
  } catch (error) {
    const detail = String(error && error.message ? error.message : error);
    if (!/no such table:\s*app_settings\b/i.test(detail) && typeof warn === 'function') {
      warn('[valve-control] gateway_timezone read failed: ' + detail);
    }
    return null;
  }
}

module.exports = { supersedeOutstanding, hasPlanHistory, hasWeeklyEver, markFlushedSnapshotLost, setSnapshotPending, clearSnapshotPending, getSnapshotPending, listSnapshotPending, queuedPushesById, isLostRow, daymaskOf, LOST_STALE, LOST_NOT_RESENT, LOST_REASONS, SNAPSHOT_PENDING_PREFIX, listValvesForUser, listSchedules, getSettings, upsertSettings, insertSchedule, updateSchedule, reviveSchedule, softDeleteSchedule, insertPushes, supersedeQueued, ackPush, failStalePushes, staleQueuedPlanDeviceEuis, pushSummary, activeActuation, recentStaleState, hasPendingObservation, weekdayPushStates, getGatewaySetting, SETTINGS_DEFAULTS };
