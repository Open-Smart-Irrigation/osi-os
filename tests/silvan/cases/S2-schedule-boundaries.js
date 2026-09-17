'use strict';
// S2 -- schedules at day boundaries, WITHOUT ever changing the gateway clock.
//
// Two independent halves:
//
// (1) OFFLINE, pure math, runs even with no gateway reachable: the on-valve
//     plan compiler's next_run calculation (osi-valve-control/plan.js,
//     required directly via lib/planRef.js) exercised across the REAL 2026
//     Europe/Zurich DST transitions (spring-forward gap 2026-03-29 02:00-03:00,
//     fall-back repeat 2026-10-25 02:00-03:00). This is the part of the
//     README's "No DST or clock manipulation" limitation that is pure
//     computation and needs no clock control at all -- only the ON-VALVE
//     firing and the FPort 12/13 clock-sync push across a live transition
//     still need a soak run or an injectable clock (unchanged limitation).
//
// (2) LIVE, against Silvan: a zone's timezone is set (via the now-owner-scoped,
//     now IANA-validated timezone route -- osi-os#265/F53, osi-os#... F31) to
//     two FIXED-OFFSET, no-DST zones on opposite sides of UTC --
//     Pacific/Kiritimati (UTC+14) and Pacific/Pago_Pago (UTC-11) -- chosen
//     specifically because a naive UTC-based calculation is most likely to
//     land on the WRONG calendar day at these extremes. WEEKLY schedules are
//     created at 23:59 and 00:00; GET /api/valves' `next_run` field
//     (osi-valve-control/api.js shapeValve(), `P.nextRun(schedules, now,
//     row.zone_timezone)`) is cross-checked against the SAME plan.js function
//     called directly with the schedule row(s) read back from SQLite, so the
//     assertion is "the live API agrees with the real compiler", not "the
//     live API agrees with a hand-derived expectation".
//
//     A second, orthogonal fact is pinned here too: the on-valve WEEKDAY_PLAN
//     downlink's fPort (14 + weekday) does NOT shift with the zone's UTC
//     offset. The valve's own onboard clock is synced to LOCAL wall-clock
//     digits in the schedule's timezone (FPort 12/13), so weekday/start_time
//     are pushed as literal local values -- there is no UTC conversion in the
//     plan compiler for the weekday encoding itself, only in next_run's
//     "what UTC instant is that" question and in the clock-sync push.
//
// Never changes the gateway's own clock or timezone. Restores nothing gateway-
// level (only this case's own zone, deleted in cleanup, is affected).

exports.title = 'Schedules at day boundaries: extreme-offset + DST-transition timezones';

const P = require('../lib/planRef');

const state = { zones: [], devices: [], schedules: [] };

function assertDstOffline(ctx) {
  const { ev } = ctx;

  // --- spring-forward gap: 2026-03-29, Europe/Zurich local 02:00 -> 03:00 ----
  const beforeGap = new Date('2026-03-27T00:00:00Z');
  const gapOcc = P.nextLocalOccurrence(beforeGap, 'Europe/Zurich', 0 /* Sun */, 2, 30);
  ctx.expect('[offline] nextLocalOccurrence resolves a target time inside the spring-forward gap ' +
    '(2026-03-29 02:30 Europe/Zurich does not exist) to SOME real instant, not null',
    !!gapOcc, gapOcc && gapOcc.toISOString());
  if (gapOcc) {
    const before = P.offsetMinutes(new Date(gapOcc.getTime() - 3600000), 'Europe/Zurich');
    const after = P.offsetMinutes(new Date(gapOcc.getTime() + 3600000), 'Europe/Zurich');
    ctx.expect('[offline] a DST transition (CET +60 -> CEST +120) is detected either side of the resolved instant',
      P.isDstTransitionWithin('Europe/Zurich', gapOcc.getTime() - 3600000, gapOcc.getTime() + 3600000),
      { before, after });
    const parts = P.localParts(gapOcc, 'Europe/Zurich');
    ctx.expect('[offline] the resolved instant lands on the CORRECT calendar day (2026-03-29), not a day the ' +
      'gap silently pushed it into', parts.year === 2026 && parts.month === 3 && parts.day === 29, parts);
    ctx.expect('[offline] the resolved instant is at or after the requested 02:30 wall-clock time ' +
      '(the gap resolution rule: snap forward to the first valid minute, never backward)',
      (parts.hour * 60 + parts.minute) >= (2 * 60 + 30) || parts.day !== 29, parts);
  }

  // --- fall-back repeat: 2026-10-25, Europe/Zurich local 02:00-03:00 twice ---
  const beforeRepeat = new Date('2026-10-23T00:00:00Z');
  const repeatOcc = P.nextLocalOccurrence(beforeRepeat, 'Europe/Zurich', 0 /* Sun */, 2, 30);
  ctx.expect('[offline] nextLocalOccurrence resolves a target time inside the fall-back repeat ' +
    '(2026-10-25 02:30 Europe/Zurich happens twice) to SOME real instant, deterministically',
    !!repeatOcc, repeatOcc && repeatOcc.toISOString());
  if (repeatOcc) {
    const parts = P.localParts(repeatOcc, 'Europe/Zurich');
    ctx.expect('[offline] the resolved instant lands on the correct calendar day (2026-10-25)',
      parts.year === 2026 && parts.month === 10 && parts.day === 25, parts);
    ctx.expect('[offline] a DST transition (CEST +120 -> CET +60) is detected across that day',
      P.isDstTransitionWithin('Europe/Zurich', Date.UTC(2026, 9, 25, 0, 0), Date.UTC(2026, 9, 25, 23, 0)), null);
  }

  // --- determinism: the same inputs always resolve the same output ----------
  const again = P.nextLocalOccurrence(beforeGap, 'Europe/Zurich', 0, 2, 30);
  ctx.expect('[offline] nextLocalOccurrence is deterministic (pure function, no hidden clock read)',
    !!gapOcc && !!again && gapOcc.getTime() === again.getTime(), { first: gapOcc, second: again });

  ev.note('DST coverage here is pure computation over plan.js\'s real nextLocalOccurrence/isDstTransitionWithin, ' +
    'run entirely offline against the fixed 2026 Europe/Zurich transition dates. The on-valve firmware actually ' +
    'FIRING across a live transition, and the FPort 12/13 clock-sync push crossing one, still need a soak run or ' +
    'an injectable gateway clock -- unchanged from the README\'s "No DST or clock manipulation" limitation.');
}

async function extremeZoneCase(ctx, { timezone, offsetHours, label }) {
  const { rest, ssh, ev, observer } = ctx;
  const tag = 's2-' + label + '-' + Date.now().toString(36);

  const zone = await rest.post('/api/irrigation-zones', { name: 'S2 ' + label + ' ' + tag, timezone: 'UTC' });
  ctx.expectStatus('[' + label + '] a zone is created', zone, 201);
  const zoneId = zone.body && zone.body.id;
  if (zoneId) state.zones.push(zoneId);

  const tzPut = await rest.put('/api/irrigation-zones/' + zoneId + '/timezone', { timezone });
  ctx.expect('[' + label + '] the zone timezone is set to ' + timezone, tzPut.status < 300,
    { status: tzPut.status, body: tzPut.body });
  const tzRow = await ssh.sqlScalar('SELECT timezone FROM irrigation_zones WHERE id = ' + zoneId);
  ctx.expect('[' + label + '] SQLite: the extreme-offset timezone persisted exactly',
    tzRow === timezone, { timezone: tzRow });

  const eui = ctx.freshDeveui('S2-' + label);
  state.devices.push(eui);
  const dev = await ctx.createSimDevice({
    deveui: eui, name: 'S2 ' + label + ' Valve ' + tag, type_id: 'STREGA_VALVE',
    strega_generation: 'GEN1', zoneId,
  });
  ctx.expectStatus('[' + label + '] the simulated valve registers', dev, [200, 201]);
  observer.setBehaviour(eui, 'ack', { delayMs: 150 });

  // Fixed, deliberately unambiguous weekday choice -- see file header: the
  // exact "which weekday" is irrelevant to correctness (next_run is a
  // deterministic function of the schedule + timezone + now, and both
  // schedules are always at least a few days from firing this same week).
  const WEEKDAY_A = 3; // Wed, start_time 23:59
  const WEEKDAY_B = 6; // Sat, start_time 00:00 -- 3 days clear of A's spillover

  // --- 23:59 WEEKLY schedule --------------------------------------------------
  const schedA = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 1 << WEEKDAY_A, start_time: '23:59', duration_minutes: 5, label: 'a ' + tag,
  });
  ctx.expectStatus('[' + label + '] the 23:59 weekly schedule is created', schedA, [200, 201]);
  const uuidA = schedA.body && (schedA.body.schedule_uuid || (schedA.body.schedule && schedA.body.schedule.schedule_uuid));
  if (uuidA) state.schedules.push(uuidA);

  const rowA = await ssh.sqlOne(
    "SELECT schedule_uuid, kind, weekdays_mask, start_time, duration_minutes, timezone, enabled, deleted_at " +
    "FROM valve_schedules WHERE schedule_uuid = '" + uuidA + "'"
  );
  ctx.expect('[' + label + '] SQLite: the 23:59 schedule stored weekdays_mask/start_time/timezone exactly as submitted',
    !!rowA && Number(rowA.weekdays_mask) === (1 << WEEKDAY_A) && rowA.start_time === '23:59' && rowA.timezone === timezone,
    rowA);

  const nowForRefA = new Date();
  const valvesAfterA = await rest.get('/api/valves');
  const shapedA = (valvesAfterA.body && valvesAfterA.body.valves || []).find((v) => v.device_eui === eui);
  ctx.expect('[' + label + '] GET /api/valves reports a next_run for the 23:59 schedule', !!(shapedA && shapedA.next_run), shapedA && shapedA.next_run);
  const referenceA = P.nextRun([rowA], nowForRefA, timezone);
  ctx.expect('[' + label + '] the API\'s next_run for the 23:59 schedule matches the reference plan.js ' +
    'computed directly from the same stored row',
    !!(shapedA && shapedA.next_run) && !!referenceA && shapedA.next_run.at === referenceA.at,
    { api: shapedA && shapedA.next_run, reference: referenceA });
  if (referenceA) {
    const localA = P.localParts(new Date(referenceA.at), timezone);
    ctx.expect('[' + label + '] next_run lands on the requested weekday (' + WEEKDAY_A + ') at 23:59 local time, ' +
      'not shifted by the ' + offsetHours + 'h offset',
      localA.weekday === WEEKDAY_A && localA.hour === 23 && localA.minute === 59, localA);
  }

  // --- 00:00 WEEKLY schedule ---------------------------------------------------
  const schedB = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 1 << WEEKDAY_B, start_time: '00:00', duration_minutes: 5, label: 'b ' + tag,
  });
  ctx.expectStatus('[' + label + '] the 00:00 weekly schedule is created (no spillover clash with the 23:59 one)',
    schedB, [200, 201]);
  const uuidB = schedB.body && (schedB.body.schedule_uuid || (schedB.body.schedule && schedB.body.schedule.schedule_uuid));
  if (uuidB) state.schedules.push(uuidB);

  const rowB = await ssh.sqlOne(
    "SELECT schedule_uuid, kind, weekdays_mask, start_time, duration_minutes, timezone, enabled, deleted_at " +
    "FROM valve_schedules WHERE schedule_uuid = '" + uuidB + "'"
  );
  ctx.expect('[' + label + '] SQLite: the 00:00 schedule stored its weekday/start_time/timezone exactly',
    !!rowB && Number(rowB.weekdays_mask) === (1 << WEEKDAY_B) && rowB.start_time === '00:00' && rowB.timezone === timezone,
    rowB);

  const nowForRefB = new Date();
  const valvesAfterB = await rest.get('/api/valves');
  const shapedB = (valvesAfterB.body && valvesAfterB.body.valves || []).find((v) => v.device_eui === eui);
  const referenceBoth = P.nextRun([rowA, rowB], nowForRefB, timezone);
  ctx.expect('[' + label + '] with both schedules enabled, next_run is the SOONER of the two and matches the ' +
    'reference computation over both stored rows',
    !!(shapedB && shapedB.next_run) && !!referenceBoth && shapedB.next_run.at === referenceBoth.at,
    { api: shapedB && shapedB.next_run, reference: referenceBoth });

  // --- weekday-invariant downlink encoding ------------------------------------
  const planDownlinks = await ctx.until(async () => {
    const d = observer.downlinksFor(eui).filter((x) => x.decoded.kind === 'WEEKDAY_PLAN');
    return d.length >= 2 ? d : null;
  }, { timeoutMs: 15000, what: 'both weekday plan downlinks' }).catch(() => observer.downlinksFor(eui).filter((x) => x.decoded.kind === 'WEEKDAY_PLAN'));
  const fports = planDownlinks.map((d) => d.fPort).sort((a, b) => a - b);
  ctx.expect('[' + label + '] the compiled plan pushes land on fPort 14+weekday exactly as submitted, ' +
    'UNSHIFTED by the ' + offsetHours + 'h zone offset (14+' + WEEKDAY_A + '=' + (14 + WEEKDAY_A) +
    ', 14+' + WEEKDAY_B + '=' + (14 + WEEKDAY_B) + ')',
    fports.includes(14 + WEEKDAY_A) && fports.includes(14 + WEEKDAY_B), { fports });

  // --- ONCE schedule: fixed-offset (no-DST) local wall-clock round trip ------
  const offsetMin = P.offsetMinutes(new Date(), timezone);
  ctx.expect('[' + label + '] ' + timezone + ' has the expected fixed UTC offset (no DST at this time of year)',
    offsetMin === offsetHours * 60, { offsetMin, expectedMin: offsetHours * 60 });
  const future = new Date(Date.now() + 5 * 86400000);
  const y = future.getUTCFullYear(); const mo = future.getUTCMonth(); const d = future.getUTCDate();
  // Local 23:59 on that calendar day, converted to UTC using the zone's own
  // (constant, no-DST) offset -- deliberately hand-computed rather than reusing
  // plan.js's resolveLocalInstant (not exported), so this is an independent
  // check of the same UTC instant, not the same code path asserting on itself.
  const fireAtUtcMs = Date.UTC(y, mo, d, 23, 59) - offsetMin * 60000;
  const fireAtIso = new Date(fireAtUtcMs).toISOString();
  const once = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'ONCE', fire_at: fireAtIso, duration_minutes: 5, label: 'once ' + tag,
  });
  ctx.expectStatus('[' + label + '] a ONCE schedule at local 23:59, ' + offsetHours + 'h offset, is accepted', once, [200, 201]);
  const uuidOnce = once.body && (once.body.schedule_uuid || (once.body.schedule && once.body.schedule.schedule_uuid));
  if (uuidOnce) state.schedules.push(uuidOnce);
  const onceRow = uuidOnce ? await ssh.sqlOne(
    "SELECT fire_at, once_state FROM valve_schedules WHERE schedule_uuid = '" + uuidOnce + "'") : null;
  ctx.expect('[' + label + '] SQLite: fire_at round-trips byte-exact (no server-side timezone mangling)',
    !!onceRow && new Date(onceRow.fire_at).getTime() === fireAtUtcMs, { stored: onceRow && onceRow.fire_at, expected: fireAtIso });
  if (onceRow) {
    const localOnce = P.localParts(new Date(onceRow.fire_at), timezone);
    ctx.expect('[' + label + '] the stored fire_at converts back to 23:59 local on the intended calendar day',
      localOnce.year === y && localOnce.month === mo + 1 && localOnce.day === d && localOnce.hour === 23 && localOnce.minute === 59,
      localOnce);
  }
}

exports.run = async (ctx) => {
  assertDstOffline(ctx);
  await extremeZoneCase(ctx, { timezone: 'Pacific/Kiritimati', offsetHours: 14, label: 'kiritimati' });
  await extremeZoneCase(ctx, { timezone: 'Pacific/Pago_Pago', offsetHours: -11, label: 'pago-pago' });
};

exports.cleanup = async (ctx) => {
  for (let i = 0; i < state.devices.length; i++) {
    const eui = state.devices[i];
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
