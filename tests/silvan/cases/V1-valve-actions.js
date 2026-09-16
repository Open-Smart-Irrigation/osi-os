'use strict';
// V1 — valve actuation against a SIMULATED valve.
//
// Silvan has no valve hardware. The valve in this case is a simulated STREGA
// device this case registers itself (70B3D57ED00... only, enforced by
// assertSimulatedDevice), and the downlink observer plays the valve: it watches
// the ChirpStack command topic the edge publishes to and answers with the uplink
// a real valve would send. No real hardware is ever addressed.
//
// Command path (flows.json):
//   PUT /api/devices/:deveui/strega/timed-action
//     -> put-strega-timed-auth-fn (validate, opcode table)
//     -> Build STREGA downlink (cdbaa3891d40d7a1)
//     -> mqtt out application/<ACTUATORS>/device/<EUI>/command/down
//     -> write-strega-expectation persists the expected end state
//   valve state comes back via a periodic uplink -> Process STREGA -> devices.current_state

exports.title = 'Valve: open/close/stop, repeated clicks, state round-trip';

const state = { zones: [], devices: [] };

exports.run = async (ctx) => {
  const { rest, ssh, ev, observer } = ctx;
  const tag = 'v1-' + Date.now().toString(36);
  const valveEui = ctx.simDeveui('V1-valve', 1);
  state.devices.push(valveEui);

  const zone = await rest.post('/api/irrigation-zones', { name: 'Valve Zone ' + tag, timezone: 'Europe/Zurich' });
  ctx.expectStatus('a zone for the valve is created', zone, 201);
  if (zone.body && zone.body.id) state.zones.push(zone.body.id);

  const reg = await ctx.createSimDevice({
    deveui: valveEui, name: 'Sim Valve ' + tag, type_id: 'STREGA_VALVE',
    strega_generation: 'GEN1', zoneId: zone.body && zone.body.id,
  });
  ctx.expectStatus('the simulated STREGA valve registers', reg, [200, 201]);

  // The observer only answers for devices a case explicitly arms, so a stray
  // downlink for anything else is recorded but never answered.
  observer.setBehaviour(valveEui, 'ack', { delayMs: 200 });

  const valves = await rest.get('/api/valves');
  const listed = (valves.body && valves.body.valves || []).find((v) => v.device_eui === valveEui);
  ctx.expect('the valve appears in GET /api/valves', !!listed, listed ? { state: listed.current_state } : null);
  ctx.expect('the valve starts CLOSED', listed && listed.current_state === 'CLOSED', listed && listed.current_state);

  // --- OPEN for a duration --------------------------------------------------
  const before = observer.downlinksFor(valveEui).length;
  const open = await rest.put('/api/devices/' + valveEui + '/strega/timed-action', {
    action: 'OPEN', unit: 'minutes', amount: 3,
  });
  ctx.expectStatus('PUT strega/timed-action OPEN is accepted (202 queued)', open, 202);
  ctx.expect('the response reports the queued downlink, not a completed action',
    open.body && open.body.status === 'PENDING' && open.body.confirmation === 'downlink_queued', open.body);

  const dl = await observer.waitForDownlink(
    (d) => d.deveui === valveEui && d.decoded.kind === 'TIMED_ACTION', 10000
  );
  ctx.expect('a downlink reaches the ChirpStack command topic for this valve',
    !!dl, dl && { topic: dl.topic, hex: dl.bytesHex });
  ctx.expect('the downlink goes to the Actuators application, not Sensors',
    dl.applicationId === ctx.env.CHIRPSTACK_APP_ACTUATORS,
    { actual: dl.applicationId, expected: ctx.env.CHIRPSTACK_APP_ACTUATORS });
  // Opcode table is byte-exact in flows.json: MINUTES OPEN = 0x41, amount byte.
  ctx.expect('the downlink is byte-exact 0x41 0x03 (TIMED_ACTION OPEN, 3 minutes) on fPort 2',
    dl.bytesHex === '4103' && dl.fPort === 2, { hex: dl.bytesHex, fPort: dl.fPort });
  ctx.expect('the downlink is unconfirmed (Class A valve, no confirmed-downlink retries)',
    dl.confirmed === false, { confirmed: dl.confirmed });

  // --- the edge's own record of what it expects -----------------------------
  const expectation = await ctx.until(async () => {
    const row = await ssh.sqlOne(
      "SELECT expectation_id, commanded_duration_seconds, expected_close_at, reconciliation_state, volume_source " +
      "FROM valve_actuation_expectations WHERE device_eui = '" + valveEui + "' ORDER BY commanded_at DESC LIMIT 1"
    );
    return row || null;
  }, { timeoutMs: 12000, what: 'a valve_actuation_expectations row' }).catch(() => null);
  ctx.expect('SQLite: the edge persisted an actuation expectation', !!expectation, expectation);
  ctx.expect('SQLite: the expectation records 180 seconds (3 minutes)',
    !!expectation && Number(expectation.commanded_duration_seconds) === 180,
    expectation && expectation.commanded_duration_seconds);
  ctx.expect('SQLite: the expectation starts PENDING_OBSERVATION',
    !!expectation && expectation.reconciliation_state === 'PENDING_OBSERVATION',
    expectation && expectation.reconciliation_state);

  const logRow = await ssh.sqlOne(
    "SELECT action, duration_minutes, reason FROM actuator_log WHERE deveui = '" + valveEui + "' ORDER BY created_at DESC LIMIT 1"
  );
  ctx.expect('SQLite: the actuation is written to actuator_log', !!logRow, logRow);

  // --- the simulated valve reports back ------------------------------------
  // The observer already answered with a periodic uplink reporting OPEN.
  const openState = await ctx.until(async () => {
    const row = await ssh.sqlScalar("SELECT current_state FROM devices WHERE deveui = '" + valveEui + "'");
    return row === 'OPEN' ? row : null;
  }, { timeoutMs: 15000, what: 'devices.current_state to become OPEN' }).catch(() => null);
  ctx.expect('SQLite: the valve uplink moves devices.current_state to OPEN', openState === 'OPEN', { current_state: openState });

  const apiState = await rest.get('/api/valves');
  const v2 = (apiState.body && apiState.body.valves || []).find((v) => v.device_eui === valveEui);
  ctx.expect('GET /api/valves reports the valve as OPEN', v2 && v2.current_state === 'OPEN', v2 && v2.current_state);
  ctx.expect('GET /api/valves reports an active actuation for the open valve',
    !!(v2 && v2.active_actuation), v2 && v2.active_actuation);

  // --- repeated clicks ------------------------------------------------------
  // Two identical opens in quick succession: the product must not silently drop
  // the second, and must not double-count it as two irrigations.
  const dlBeforeRepeat = observer.downlinksFor(valveEui).length;
  const r1 = await rest.put('/api/devices/' + valveEui + '/strega/timed-action', { action: 'OPEN', unit: 'minutes', amount: 2 });
  const r2 = await rest.put('/api/devices/' + valveEui + '/strega/timed-action', { action: 'OPEN', unit: 'minutes', amount: 2 });
  ctx.expect('two rapid identical opens are both accepted', r1.status === 202 && r2.status === 202,
    { first: r1.status, second: r2.status });
  await ctx.sleep(2500);
  const repeats = observer.downlinksFor(valveEui).length - dlBeforeRepeat;
  ctx.expect('each accepted open produces exactly one downlink (no silent drop, no duplication)',
    repeats === 2, { downlinks: repeats });
  const expCount = await ssh.sqlScalar(
    "SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE device_eui = '" + valveEui + "'"
  );
  ctx.expect('SQLite: each open produced its own expectation row', Number(expCount) === 3, { rows: expCount });

  // --- cancel (the "stop" the product actually supports) --------------------
  // Per feedback_strega_valve_operation and the flow's own cancel route, an
  // irrigation is ended with a cancel, never with a bare CLOSE downlink.
  const cancel = await rest.post('/api/valve/' + valveEui + '/cancel', {});
  ctx.expect('POST /api/valve/:deveui/cancel is accepted', cancel.status === 200 || cancel.status === 202,
    { status: cancel.status, body: cancel.body });

  const cancelled = await ctx.until(async () => {
    const row = await ssh.sqlOne(
      "SELECT reconciliation_state, cancel_reason FROM valve_actuation_expectations " +
      "WHERE device_eui = '" + valveEui + "' ORDER BY commanded_at DESC LIMIT 1"
    );
    return row && row.reconciliation_state === 'CANCELLED' ? row : null;
  }, { timeoutMs: 12000, what: 'the newest expectation to become CANCELLED' }).catch(() => null);
  ctx.expect('SQLite: cancel marks the active expectation CANCELLED', !!cancelled, cancelled);

  const cancelDownlinks = observer.downlinksFor(valveEui).filter(
    (d) => d.decoded.kind === 'CLOSE' || (d.decoded.kind === 'TIMED_ACTION' && d.decoded.valveAction === 'CLOSE')
  );
  ctx.expect('cancel never emits a bare CLOSE downlink (STREGA self-closes; a bare CLOSE is not a supported command)',
    cancelDownlinks.length === 0, { closeDownlinks: cancelDownlinks.map((d) => d.bytesHex) });

  // --- invalid actuation input ---------------------------------------------
  const tooBig = await rest.put('/api/devices/' + valveEui + '/strega/timed-action', { action: 'OPEN', unit: 'minutes', amount: 256 });
  ctx.expectStatus('an amount above the single-byte maximum (255) is rejected with 400', tooBig, 400);
  const zero = await rest.put('/api/devices/' + valveEui + '/strega/timed-action', { action: 'OPEN', unit: 'minutes', amount: 0 });
  ctx.expectStatus('an amount of 0 is rejected with 400', zero, 400);
  const fractional = await rest.put('/api/devices/' + valveEui + '/strega/timed-action', { action: 'OPEN', unit: 'minutes', amount: 2.5 });
  ctx.expectStatus('a fractional amount is rejected with 400', fractional, 400);
  const badUnit = await rest.put('/api/devices/' + valveEui + '/strega/timed-action', { action: 'OPEN', unit: 'fortnights', amount: 2 });
  ctx.expectStatus('an unknown unit is rejected with 400', badUnit, 400);
  const badAction = await rest.put('/api/devices/' + valveEui + '/strega/timed-action', { action: 'WIGGLE', unit: 'minutes', amount: 2 });
  ctx.expectStatus('an unknown action is rejected with 400', badAction, 400);

  const dlAfterInvalid = observer.downlinksFor(valveEui).length;
  await ctx.sleep(1200);
  ctx.expect('no rejected command produced a downlink (nothing reached the radio)',
    observer.downlinksFor(valveEui).length === dlAfterInvalid, { downlinks: observer.downlinksFor(valveEui).length });

  // --- actuating someone else's / an unregistered valve ---------------------
  const ghost = ctx.simDeveui('V1-ghost', 9);
  const ghostCmd = await rest.put('/api/devices/' + ghost + '/strega/timed-action', { action: 'OPEN', unit: 'minutes', amount: 1 }, { timeoutMs: 8000 })
    .catch(() => ({ status: 0, body: 'no response (hung)' }));
  ctx.expect('actuating an unregistered valve is refused, never silently queued',
    ghostCmd.status === 404 || ghostCmd.status === 400, { status: ghostCmd.status, body: ghostCmd.body });
  ctx.expect('no downlink was emitted for an unregistered valve',
    observer.downlinksFor(ghost).length === 0, { downlinks: observer.downlinksFor(ghost).length });

  ev.artifact('downlinks observed', 'V1-downlinks.json');
  require('node:fs').writeFileSync(
    require('node:path').join(ctx.runDir, 'V1-downlinks.json'),
    JSON.stringify({ downlinks: observer.downlinksFor(valveEui), uplinks: observer.uplinksSent }, null, 2) + '\n'
  );
};

exports.cleanup = async (ctx) => {
  for (const eui of state.devices.slice()) {
    ctx.observer.setBehaviour(eui, 'observe');
    await ctx.deleteSimDevice(eui);
  }
  for (const id of state.zones.slice()) await ctx.deleteZone(id);
  state.devices.length = 0;
  state.zones.length = 0;
};
