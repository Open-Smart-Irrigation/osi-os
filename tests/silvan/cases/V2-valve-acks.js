'use strict';
// V2 — the valve ACK ledger under adverse ACK behaviour.
//
// Simulated valve only. The valve's on-board weekly scheduler is pushed by the
// gateway as one downlink per weekday (Gen1 fPort 14+weekday) and each push is
// tracked in valve_schedule_pushes as QUEUED -> ACKED/FAILED. The valve NEVER
// reports its stored plan back over LoRaWAN (there is no read-back FPort), so
// the ACK is the only evidence the gateway ever gets -- which is exactly why a
// dropped, late, refused, duplicated or out-of-order ACK has to be handled
// correctly rather than assumed away.
//
// Behaviours exercised: ack, nack, delay, duplicate, drop, out-of-order.

exports.title = 'Valve ACKs: delayed, refused, duplicated, out-of-order, dropped';

const state = { zones: [], devices: [] };
const sched = [];

async function pushRows(ssh, eui) {
  return ssh.sql(
    "SELECT push_id, purpose, weekday, fport, state, ack_status, queued_at, acked_at, error " +
    "FROM valve_schedule_pushes WHERE device_eui = '" + eui + "' ORDER BY queued_at"
  );
}

exports.run = async (ctx) => {
  const { rest, ssh, ev, observer } = ctx;
  const tag = 'v2-' + Date.now().toString(36);
  // Fresh per run: the ACK ledger assertions count valve_schedule_pushes rows,
  // which survive a device delete (DELETE only unclaims).
  const eui = ctx.freshDeveui('V2-valve');
  state.devices.push(eui);

  const zone = await rest.post('/api/irrigation-zones', { name: 'ACK Zone ' + tag, timezone: 'Europe/Zurich' });
  ctx.expectStatus('a zone for the valve is created', zone, 201);
  if (zone.body && zone.body.id) state.zones.push(zone.body.id);

  const reg = await ctx.createSimDevice({
    deveui: eui, name: 'Sim ACK Valve ' + tag, type_id: 'STREGA_VALVE',
    strega_generation: 'GEN1', zoneId: zone.body && zone.body.id,
  });
  ctx.expectStatus('the simulated valve registers', reg, [200, 201]);

  // ---------- 1. happy path: every push is ACKed ---------------------------
  observer.setBehaviour(eui, 'ack', { delayMs: 150 });
  const s1 = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 1 | 2, start_time: '06:00', duration_minutes: 10, label: 'ack-ok ' + tag,
  });
  ctx.expectStatus('creating a weekly schedule is accepted', s1, [200, 201]);
  if (s1.body && s1.body.schedule_uuid) sched.push(s1.body.schedule_uuid);
  else if (s1.body && s1.body.schedule && s1.body.schedule.schedule_uuid) sched.push(s1.body.schedule.schedule_uuid);

  const planDownlinks = await ctx.until(async () => {
    const d = observer.downlinksFor(eui).filter((x) => x.decoded.kind === 'WEEKDAY_PLAN');
    return d.length >= 1 ? d : null;
  }, { timeoutMs: 15000, what: 'the on-valve weekday plan downlinks' }).catch(() => []);
  ctx.expect('creating a weekly schedule pushes the plan to the valve',
    planDownlinks.length >= 1, { downlinks: planDownlinks.length, fports: planDownlinks.map((d) => d.fPort) });
  ctx.expect('plan downlinks use the Gen1 weekday fPorts (14 + weekday)',
    planDownlinks.every((d) => d.fPort >= 14 && d.fPort <= 20), planDownlinks.map((d) => d.fPort));

  const acked = await ctx.until(async () => {
    const rows = await pushRows(ssh, eui);
    return rows.length && rows.every((r) => r.state === 'ACKED') ? rows : null;
  }, { timeoutMs: 20000, what: 'every queued push to reach ACKED' }).catch(() => null);
  ctx.expect('SQLite: a successful ACK moves every push QUEUED -> ACKED',
    !!acked, acked ? acked.map((r) => [r.fport, r.state]) : await pushRows(ssh, eui));
  ctx.expect('SQLite: an ACKED push records acked_at and ack_status 0 (vendor "00")',
    !!acked && acked.every((r) => r.acked_at && Number(r.ack_status) === 0),
    acked && acked.map((r) => [r.fport, r.ack_status, r.acked_at]));

  const apiAfterAck = await rest.get('/api/valves');
  const vAck = (apiAfterAck.body && apiAfterAck.body.valves || []).find((v) => v.device_eui === eui);
  ctx.expect('GET /api/valves reports the acked plan in push_state',
    !!vAck && Number(vAck.push_state.acked) >= 1 && Number(vAck.push_state.queued) === 0,
    vAck && vAck.push_state);

  // ---------- 2. duplicate ACK is idempotent -------------------------------
  const lastPlan = planDownlinks[planDownlinks.length - 1];
  const beforeDup = await pushRows(ssh, eui);
  observer.answer(lastPlan, { status: '00' });
  observer.answer(lastPlan, { status: '00' });
  await ctx.sleep(2500);
  const afterDup = await pushRows(ssh, eui);
  ctx.expect('a duplicate ACK creates no extra push rows (idempotent ledger)',
    afterDup.length === beforeDup.length, { before: beforeDup.length, after: afterDup.length });
  ctx.expect('a duplicate ACK does not flip an ACKED push back to QUEUED or FAILED',
    afterDup.every((r) => r.state === 'ACKED'), afterDup.map((r) => [r.fport, r.state]));

  // ---------- 3. an out-of-order / unsolicited ACK -------------------------
  // An ACK for a weekday the gateway never pushed must be ignored, not invent a
  // ledger row and not corrupt an existing one.
  const unusedFport = 14 + 5;
  const beforeStray = await pushRows(ssh, eui);
  ctx.publishActuatorUplink(ctx.U.stregaGen1WeekdayAck(ctx.profiles, { deveui: eui, weekdayFport: unusedFport, status: '00' }));
  await ctx.sleep(2500);
  const afterStray = await pushRows(ssh, eui);
  ctx.expect('an ACK for a weekday that was never pushed creates no ledger row',
    afterStray.length === beforeStray.length, { before: beforeStray.length, after: afterStray.length, fport: unusedFport });
  ctx.expect('a stray ACK leaves existing pushes untouched',
    JSON.stringify(afterStray.map((r) => [r.fport, r.state])) === JSON.stringify(beforeStray.map((r) => [r.fport, r.state])),
    { after: afterStray.map((r) => [r.fport, r.state]) });

  // ---------- 4. refused (NACK) -------------------------------------------
  observer.setBehaviour(eui, 'nack', { delayMs: 150, status: '01' });
  const s2 = await rest.put('/api/valves/' + eui + '/schedules/' + (sched[0] || ''), {
    kind: 'WEEKLY', weekdays_mask: 1 | 2 | 4, start_time: '07:30', duration_minutes: 12, label: 'nack ' + tag,
  });
  ctx.expect('editing the schedule is accepted even though the valve will refuse the push',
    s2.status < 300, { status: s2.status, body: s2.body });
  const nacked = await ctx.until(async () => {
    const rows = await pushRows(ssh, eui);
    const bad = rows.filter((r) => Number(r.ack_status) !== 0 || r.state === 'FAILED');
    return bad.length ? bad : null;
  }, { timeoutMs: 20000, what: 'a refused push to be recorded' }).catch(() => null);
  ctx.expect('SQLite: a non-zero ACK status is recorded rather than treated as success',
    !!nacked, nacked ? nacked.map((r) => [r.fport, r.state, r.ack_status]) : await pushRows(ssh, eui));
  if (nacked) {
    ev.note('A refused plan write is visible in valve_schedule_pushes (state/ack_status), so an operator can ' +
      'tell "the valve refused the plan" from "the valve never answered".');
  }

  // ---------- 5. dropped ACK (valve never answers) -------------------------
  observer.setBehaviour(eui, 'drop');
  const beforeDrop = await pushRows(ssh, eui);
  const s3 = await rest.put('/api/valves/' + eui + '/schedules/' + (sched[0] || ''), {
    kind: 'WEEKLY', weekdays_mask: 1, start_time: '05:15', duration_minutes: 8, label: 'drop ' + tag,
  });
  ctx.expect('editing the schedule is accepted when the valve will never answer', s3.status < 300, { status: s3.status });
  const dropDownlink = await observer.waitForDownlink(
    (d) => d.deveui === eui && d.decoded.kind === 'WEEKDAY_PLAN' && d.at > beforeDrop[beforeDrop.length - 1].queued_at, 15000
  ).catch(() => null);
  ctx.expect('a plan downlink is still emitted when the valve is silent', !!dropDownlink,
    dropDownlink && { fPort: dropDownlink.fPort, hex: dropDownlink.bytesHex });
  await ctx.sleep(4000);
  const afterDrop = await pushRows(ssh, eui);
  const stillQueued = afterDrop.filter((r) => r.state === 'QUEUED');
  ctx.expect('SQLite: an unanswered push stays QUEUED and is never auto-promoted to ACKED',
    stillQueued.length >= 1, afterDrop.map((r) => [r.fport, r.state]));

  const apiAfterDrop = await rest.get('/api/valves');
  const vDrop = (apiAfterDrop.body && apiAfterDrop.body.valves || []).find((v) => v.device_eui === eui);
  ctx.expect('GET /api/valves surfaces the unacknowledged push to the operator',
    !!vDrop && Number(vDrop.push_state.queued) >= 1, vDrop && vDrop.push_state);

  // ---------- 6. a very late ACK still lands ------------------------------
  observer.setBehaviour(eui, 'observe');
  const lateTarget = observer.downlinksFor(eui).filter((d) => d.decoded.kind === 'WEEKDAY_PLAN').pop();
  await ctx.sleep(6000);
  observer.answer(lateTarget, { status: '00' });
  const lateAcked = await ctx.until(async () => {
    const rows = await pushRows(ssh, eui);
    return rows.some((r) => Number(r.fport) === Number(lateTarget.fPort) && r.state === 'ACKED') ? rows : null;
  }, { timeoutMs: 20000, what: 'the late ACK to be applied' }).catch(() => null);
  ctx.expect('an ACK that arrives long after the push is still applied (no ACK window that silently expires)',
    !!lateAcked, lateAcked ? lateAcked.map((r) => [r.fport, r.state]) : await pushRows(ssh, eui));

  // ---------- 7. reconciliation of a timed open ---------------------------
  observer.setBehaviour(eui, 'ack', { delayMs: 200 });
  const open = await rest.put('/api/devices/' + eui + '/strega/timed-action', { action: 'OPEN', unit: 'minutes', amount: 2 });
  ctx.expectStatus('a timed open is accepted', open, 202);
  const running = await ctx.until(async () => {
    const row = await ssh.sqlOne(
      "SELECT reconciliation_state, observed_open_at FROM valve_actuation_expectations " +
      "WHERE device_eui = '" + eui + "' ORDER BY commanded_at DESC LIMIT 1"
    );
    return row && row.reconciliation_state === 'OBSERVED_RUNNING' ? row : null;
  }, { timeoutMs: 90000, intervalMs: 3000, what: 'the reconciliation monitor to observe the open' }).catch(() => null);
  ctx.expect('SQLite: the 60s reconciliation monitor advances the expectation to OBSERVED_RUNNING once the valve reports OPEN',
    !!running, running || await ssh.sqlOne(
      "SELECT reconciliation_state, observed_open_at FROM valve_actuation_expectations WHERE device_eui = '" + eui + "' ORDER BY commanded_at DESC LIMIT 1"));
  ev.note('STALE_OPEN_OBSERVED needs RECONCILIATION_GRACE_SEC = 1800s past expected_close_at, so the ' +
    'stale-open path is out of reach of a single short run; it needs a soak run or an injected clock.');

  require('node:fs').writeFileSync(
    require('node:path').join(ctx.runDir, 'V2-ack-ledger.json'),
    JSON.stringify({ pushes: await pushRows(ssh, eui), downlinks: observer.downlinksFor(eui), uplinks: observer.uplinksSent }, null, 2) + '\n'
  );
  ev.artifact('ack ledger + downlinks', 'V2-ack-ledger.json');
};

exports.cleanup = async (ctx) => {
  for (const eui of state.devices.slice()) {
    ctx.observer.setBehaviour(eui, 'observe');
    for (const uuid of sched.slice()) {
      try {
        const res = await ctx.rest.del('/api/valves/' + eui + '/schedules/' + uuid);
        ctx.ev.cleanupStep('delete schedule ' + uuid, res.status === 200 || res.status === 404, { status: res.status });
      } catch (e) { ctx.ev.cleanupStep('delete schedule ' + uuid, false, e.message); }
    }
    await ctx.deleteSimDevice(eui);
  }
  for (const id of state.zones.slice()) await ctx.deleteZone(id);
  sched.length = 0;
  state.devices.length = 0;
  state.zones.length = 0;
};
