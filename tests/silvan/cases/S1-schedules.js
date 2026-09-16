'use strict';
// S1 — valve schedules: CRUD, invalid durations, overlap, midnight, day rollover.
//
// Simulated valve only. Validation lives in
// conf/.../node-red/osi-valve-control/plan.js validateScheduleInput(): WEEKLY
// wants weekdays_mask 1..127, start_time HH:MM and duration 1..1439; ONCE wants
// an ISO instant and duration 1..255 (a one-time open is a single byte on the
// wire, so it cannot exceed 255 minutes).

exports.title = 'Schedules: CRUD, invalid duration, overlap, midnight, day rollover';

const state = { zones: [], devices: [], schedules: [] };

const uuidOf = (body) => (body && (body.schedule_uuid || (body.schedule && body.schedule.schedule_uuid))) || null;

exports.run = async (ctx) => {
  const { rest, ssh, ev, observer } = ctx;
  const tag = 's1-' + Date.now().toString(36);
  // Fresh per run: schedule rows are tombstoned, not removed, so a stable
  // DevEUI accumulates them across runs.
  const eui = ctx.freshDeveui('S1-valve');
  state.devices.push(eui);

  const zone = await rest.post('/api/irrigation-zones', { name: 'Sched Zone ' + tag, timezone: 'Europe/Zurich' });
  ctx.expectStatus('a zone for the valve is created', zone, 201);
  if (zone.body && zone.body.id) state.zones.push(zone.body.id);

  const reg = await ctx.createSimDevice({
    deveui: eui, name: 'Sim Sched Valve ' + tag, type_id: 'STREGA_VALVE',
    strega_generation: 'GEN1', zoneId: zone.body && zone.body.id,
  });
  ctx.expectStatus('the simulated valve registers', reg, [200, 201]);
  observer.setBehaviour(eui, 'ack', { delayMs: 150 });

  const empty = await rest.get('/api/valves/' + eui + '/schedules');
  ctx.expectStatus('GET schedules on a valve with none succeeds', empty, 200);

  // --- create ---------------------------------------------------------------
  const create = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 2, start_time: '06:00', duration_minutes: 15, label: 'morning ' + tag,
  });
  ctx.expectStatus('a valid weekly schedule is created', create, [200, 201]);
  const uuid = uuidOf(create.body);
  if (uuid) state.schedules.push(uuid);
  ctx.expect('the created schedule carries a schedule_uuid', !!uuid, create.body);

  const row = await ssh.sqlOne(
    "SELECT schedule_uuid, kind, weekdays_mask, start_time, duration_minutes, timezone, enabled, deleted_at " +
    "FROM valve_schedules WHERE device_eui = '" + eui + "' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"
  );
  ctx.expect('SQLite: the schedule row matches what was requested',
    !!row && row.kind === 'WEEKLY' && Number(row.weekdays_mask) === 2 && row.start_time === '06:00' && Number(row.duration_minutes) === 15,
    row);
  ctx.expect('SQLite: the schedule inherits the zone timezone rather than defaulting to UTC',
    !!row && row.timezone === 'Europe/Zurich', row && row.timezone);
  ctx.expect('SQLite: a new schedule is enabled', !!row && Number(row.enabled) === 1, row && row.enabled);

  const list = await rest.get('/api/valves/' + eui + '/schedules');
  const listed = JSON.stringify(list.body || '');
  ctx.expect('the new schedule appears in GET schedules', listed.includes(uuid), { uuid });

  // --- invalid input --------------------------------------------------------
  const badDuration = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 4, start_time: '08:00', duration_minutes: 0,
  });
  ctx.expectStatus('duration 0 is rejected with 422', badDuration, 422);
  const hugeDuration = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 4, start_time: '08:00', duration_minutes: 1440,
  });
  ctx.expectStatus('a duration of a full day (1440) is rejected with 422', hugeDuration, 422);
  const negative = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 4, start_time: '08:00', duration_minutes: -5,
  });
  ctx.expectStatus('a negative duration is rejected with 422', negative, 422);
  const badTime = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 4, start_time: '25:00', duration_minutes: 10,
  });
  ctx.expectStatus('an out-of-range start_time is rejected with 422', badTime, 422);
  const badMask = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 0, start_time: '08:00', duration_minutes: 10,
  });
  ctx.expectStatus('weekdays_mask 0 (no days selected) is rejected with 422', badMask, 422);
  const maskTooBig = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 128, start_time: '08:00', duration_minutes: 10,
  });
  ctx.expectStatus('weekdays_mask above 127 is rejected with 422', maskTooBig, 422);
  const badKind = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'FORTNIGHTLY', weekdays_mask: 4, start_time: '08:00', duration_minutes: 10,
  });
  ctx.expectStatus('an unknown schedule kind is rejected with 422', badKind, 422);

  const leaked = await ssh.sqlScalar(
    "SELECT COUNT(*) AS n FROM valve_schedules WHERE device_eui = '" + eui + "' AND deleted_at IS NULL"
  );
  ctx.expect('SQLite: no rejected schedule was persisted', Number(leaked) === 1, { rows: leaked });

  // --- overlap --------------------------------------------------------------
  // The on-valve plan is compiled from all enabled schedules; two windows that
  // collide on the same weekday cannot both be programmed, so the second must be
  // refused with a plan_conflict rather than silently winning.
  const overlap = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 2, start_time: '06:05', duration_minutes: 20, label: 'overlap ' + tag,
  });
  const overlapUuid = uuidOf(overlap.body);
  if (overlapUuid) state.schedules.push(overlapUuid);
  ctx.expectStatus('a schedule overlapping an existing window on the same weekday is refused with 422', overlap, 422);
  ctx.expect('the overlap rejection names it as a plan conflict',
    overlap.body && overlap.body.error === 'plan_conflict', overlap.body);
  ctx.expect('the overlap rejection identifies the conflicting schedule so the GUI can point at it',
    !!(overlap.body && Array.isArray(overlap.body.details) && overlap.body.details.length), overlap.body && overlap.body.details);

  const adjacent = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 2, start_time: '06:15', duration_minutes: 10, label: 'adjacent ' + tag,
  });
  const adjacentUuid = uuidOf(adjacent.body);
  if (adjacentUuid) state.schedules.push(adjacentUuid);
  ctx.expect('a window starting exactly when the previous one ends is accepted (touching is not overlapping)',
    adjacent.status < 300, { status: adjacent.status, body: adjacent.body });

  const otherDay = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 4, start_time: '06:05', duration_minutes: 20, label: 'other-day ' + tag,
  });
  const otherDayUuid = uuidOf(otherDay.body);
  if (otherDayUuid) state.schedules.push(otherDayUuid);
  ctx.expect('the same clock time on a different weekday is not an overlap',
    otherDay.status < 300, { status: otherDay.status, body: otherDay.body });

  // --- midnight and day rollover -------------------------------------------
  const midnight = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 8, start_time: '00:00', duration_minutes: 30, label: 'midnight ' + tag,
  });
  const midnightUuid = uuidOf(midnight.body);
  if (midnightUuid) state.schedules.push(midnightUuid);
  ctx.expect('a window starting exactly at midnight is accepted', midnight.status < 300,
    { status: midnight.status, body: midnight.body });

  // A window that would run past midnight: 23:50 + 30 min crosses into the next
  // weekday, which the per-weekday on-valve plan cannot express. Pin whatever the
  // product actually does so a future change is deliberate.
  const rollover = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 16, start_time: '23:50', duration_minutes: 30, label: 'rollover ' + tag,
  });
  const rolloverUuid = uuidOf(rollover.body);
  if (rolloverUuid) state.schedules.push(rolloverUuid);
  ctx.expect('a window that runs past midnight is handled without a 500',
    rollover.status !== 500, { status: rollover.status, body: rollover.body });
  ev.note('Midnight rollover (23:50 + 30 min) returned HTTP ' + rollover.status + '. The Gen1 on-valve plan is ' +
    'one window list PER WEEKDAY, so a window crossing midnight cannot be expressed as a single entry; ' +
    'this is the behaviour to review against the spec.');

  // --- enable / disable -----------------------------------------------------
  const disable = await rest.put('/api/valves/' + eui + '/schedules/' + uuid, {
    kind: 'WEEKLY', weekdays_mask: 2, start_time: '06:00', duration_minutes: 15, enabled: false,
  });
  ctx.expect('a schedule can be disabled', disable.status < 300, { status: disable.status, body: disable.body });
  const disabledRow = await ssh.sqlOne(
    "SELECT enabled, deleted_at FROM valve_schedules WHERE schedule_uuid = '" + uuid + "'"
  );
  ctx.expect('SQLite: disabling sets enabled = 0 and does not delete the row',
    !!disabledRow && Number(disabledRow.enabled) === 0 && disabledRow.deleted_at === null, disabledRow);

  const reenable = await rest.put('/api/valves/' + eui + '/schedules/' + uuid, {
    kind: 'WEEKLY', weekdays_mask: 2, start_time: '06:00', duration_minutes: 15, enabled: true,
  });
  ctx.expect('a disabled schedule can be re-enabled', reenable.status < 300, { status: reenable.status });

  // --- adjust ---------------------------------------------------------------
  const adjust = await rest.put('/api/valves/' + eui + '/schedules/' + uuid, {
    kind: 'WEEKLY', weekdays_mask: 2, start_time: '06:30', duration_minutes: 25, label: 'adjusted ' + tag,
  });
  ctx.expect('an existing schedule can be adjusted', adjust.status < 300, { status: adjust.status, body: adjust.body });
  const adjusted = await ssh.sqlOne(
    "SELECT start_time, duration_minutes, label, sync_version FROM valve_schedules WHERE schedule_uuid = '" + uuid + "'"
  );
  ctx.expect('SQLite: the adjustment is persisted',
    !!adjusted && adjusted.start_time === '06:30' && Number(adjusted.duration_minutes) === 25, adjusted);

  // --- a one-time open ------------------------------------------------------
  const fireAt = new Date(Date.now() + 3600 * 1000).toISOString();
  const once = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'ONCE', fire_at: fireAt, duration_minutes: 12, label: 'once ' + tag,
  });
  const onceUuid = uuidOf(once.body);
  if (onceUuid) state.schedules.push(onceUuid);
  ctx.expect('a one-time open can be scheduled', once.status < 300, { status: once.status, body: once.body });
  const onceRow = onceUuid ? await ssh.sqlOne(
    "SELECT kind, fire_at, once_state, duration_minutes FROM valve_schedules WHERE schedule_uuid = '" + onceUuid + "'") : null;
  ctx.expect('SQLite: the one-time open starts PENDING and is not fired early',
    !!onceRow && onceRow.kind === 'ONCE' && onceRow.once_state === 'PENDING', onceRow);

  const onceTooLong = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'ONCE', fire_at: fireAt, duration_minutes: 256,
  });
  ctx.expectStatus('a one-time open longer than the single-byte maximum (255) is rejected with 422', onceTooLong, 422);
  const onceBadTime = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'ONCE', fire_at: 'tomorrow morning', duration_minutes: 10,
  });
  ctx.expectStatus('a non-ISO fire_at is rejected with 422', onceBadTime, 422);

  // --- delete ---------------------------------------------------------------
  const del = await rest.del('/api/valves/' + eui + '/schedules/' + uuid);
  ctx.expect('a schedule can be deleted', del.status < 300, { status: del.status, body: del.body });
  const deleted = await ssh.sqlOne("SELECT deleted_at FROM valve_schedules WHERE schedule_uuid = '" + uuid + "'");
  ctx.expect('SQLite: the deleted schedule is tombstoned (deleted_at set), per the sync contract',
    !!deleted && deleted.deleted_at !== null, deleted);
  if (deleted && deleted.deleted_at !== null) state.schedules = state.schedules.filter((s) => s !== uuid);

  const delAgain = await rest.del('/api/valves/' + eui + '/schedules/' + uuid);
  ctx.expectStatus('deleting the same schedule twice returns 404 the second time', delAgain, 404);

  const delGhost = await rest.del('/api/valves/' + eui + '/schedules/00000000-0000-4000-8000-000000000000');
  ctx.expectStatus('deleting a schedule that never existed returns 404', delGhost, 404);

  // --- schedules on a valve that is not registered -------------------------
  const ghost = ctx.freshDeveui('S1-ghost');
  const ghostSched = await rest.post('/api/valves/' + ghost + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 2, start_time: '06:00', duration_minutes: 10,
  }, { timeoutMs: 8000 }).catch(() => ({ status: 0, body: 'no response (hung)' }));
  ctx.expect('scheduling an unregistered valve is refused, never accepted',
    ghostSched.status === 404 || ghostSched.status === 400, { status: ghostSched.status, body: ghostSched.body });
};

exports.cleanup = async (ctx) => {
  for (const eui of state.devices.slice()) {
    ctx.observer.setBehaviour(eui, 'observe');
    for (const uuid of state.schedules.slice()) {
      try {
        const res = await ctx.rest.del('/api/valves/' + eui + '/schedules/' + uuid);
        ctx.ev.cleanupStep('delete schedule ' + uuid, res.status < 300 || res.status === 404, { status: res.status });
      } catch (e) { ctx.ev.cleanupStep('delete schedule ' + uuid, false, e.message); }
    }
    await ctx.deleteSimDevice(eui);
  }
  for (const id of state.zones.slice()) await ctx.deleteZone(id);
  state.schedules.length = 0;
  state.devices.length = 0;
  state.zones.length = 0;
};
