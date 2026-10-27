'use strict';

// Execute the shipped Node-RED function bodies with the real valve-control
// dispatch module and a controlled provisioning adapter. This deliberately
// tests the wrapper seam (DB open, reservation owner, delayed RPC and output
// array), not a copy of the encoder logic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tempDb } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers');
const root = path.resolve(__dirname, '..');
const flowPath = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const runtimePath = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const encoder = flow.find((node) => node.id === 'cdbaa3891d40d7a1');
const ackQueue = flow.find((node) => node.id === 'command-ack-queue-rest');
const VC = require(path.join(runtimePath, 'osi-valve-control'));
const EUI = '0016C001F1000001';

function runtimeControl() {
  const anchor = Date.now();
  const bootId = 'writer-wrapper-test-boot';
  const fsFixture = { readFileSync(file) {
    if (file === '/proc/sys/kernel/random/boot_id') return bootId + '\n';
    if (file === '/proc/uptime') return `${(Date.now() - anchor) / 1000} 0\n`;
    if (file === '/var/run/osi-irrigation-clock.json') return JSON.stringify({ boot_id: bootId, epoch_ms: anchor, uptime_ms: 0, stratum: 1 });
    throw Object.assign(new Error('missing test clock path'), { code: 'ENOENT' });
  } };
  return { ...VC, executeValveAttempt(args) {
    return VC.executeValveAttempt({ ...args, trustedContext: { clockOptions: { fs: fsFixture, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/writer-wrapper-rejection.json', fallbackPath: '/tmp/writer-wrapper-rejection-fallback.json' } } });
  } };
}

function wrapperContext(db, transport, events, valveControl = VC, envOverrides = {}) {
  const runtimeDb = {
    get: db.get.bind(db), all: db.all.bind(db), run: db.run.bind(db), transaction: db.transaction.bind(db),
    close(callback) { if (callback) callback(); },
  };
  class Database {
    constructor() { return runtimeDb; }
  }
  const env = { get(key) {
    if (Object.prototype.hasOwnProperty.call(envOverrides, key)) return envOverrides[key];
    return key === 'CHIRPSTACK_APP_ACTUATORS' ? 'actuators' : (key === 'DEVICE_EUI' ? '0016C001F1000002' : '');
  } };
  const node = {
    warn(value) { events.push(['warn', value]); },
    error(value) { events.push(['error', value]); },
    status(value) { events.push(['status', value]); },
    log(value) { events.push(['log', value]); },
  };
  return {
    Buffer, Date, msg: null, env, node, flow: { get() { return undefined; } }, osiDb: { Database },
    osiLib: { require(name) {
      if (name === 'osi-db-helper') return { ok: true, value: { Database } };
      if (name === 'osi-valve-control') return { ok: true, value: valveControl };
      if (name === 'osi-command-ledger') return { ok: true, value: require(path.join(runtimePath, 'osi-command-ledger')) };
      if (name === 'scope') return { ok: true, value: { async assertFreshDeviceAccess() { return { role: 'admin' }; }, canMutate() { return true; } } };
      return { ok: false, error: 'unsupported test module ' + name };
    } },
    chirpstack: { createProvisioningClientFromEnv() { return transport; } },
    crypto: require('node:crypto'),
    setTimeout,
  };
}

async function invokeNode(node, db, transport, msg, events, valveControl = VC, envOverrides = {}) {
  const context = wrapperContext(db, transport, events, valveControl, envOverrides);
  context.msg = msg;
  return vm.runInNewContext('(function(){\n' + node.func + '\n})()', context, { timeout: 5000 });
}

async function invoke(db, transport, msg, events, valveControl = VC) {
  return invokeNode(encoder, db, transport, msg, events, valveControl);
}

async function invokeChain(db, transport, events, input, valveControl = runtimeControl()) {
  const builder = flow.find((node) => node.id === 'dde8e1ef265e96d7');
  const writer = flow.find((node) => node.id === 'write-strega-expectation');
  const built = await invokeNode(builder, db, transport, input, events);
  assert.ok(built && built[0] && built[0].payload, 'real local builder must create actuator_command');
  const written = await invokeNode(writer, db, transport, built[0], events);
  assert.ok(written && written.payload && !written._stregaReservation, 'expectation writer must not preclaim the valve');
  assert.ok(written._stregaDispatchCommand, 'manual OPEN must pass normalized authorization to encoder');
  return invoke(db, transport, written, events, valveControl);
}

async function main() {
  const fixture = await tempDb();
  const events = [];
  const calls = [];
  const transport = {
    async enqueueDownlink(item) {
      calls.push(['start', item]);
      await new Promise((resolve) => setTimeout(resolve, 15));
      calls.push(['end']);
      return { id: 'wrapper-q-1' };
    },
  };
  const msg = { payload: { type: 'actuator_command', device: { devEui: EUI }, data: {
    action: 'OPEN_FOR_DURATION', duration_minutes: 2, commandId: 'wrapper-command', commandType: 'VALVE_COMMAND',
  } }, _stregaHttpResponse: { res: {}, statusCode: 202, payload: { status: 'queued' } } };
  const out = await invoke(fixture.db, transport, msg, events, runtimeControl());
  if (calls.length !== 2) console.error('wrapper debug', { calls, out, events });
  assert.equal(calls.length, 2, 'delayed enqueue must complete before wrapper returns');
  assert.equal(out[0], null, 'STREGA must never use the MQTT output');
  assert.ok(out[1] && out[1]._log_ctx, 'accepted wrapper must emit the accepted actuator log');
  assert.equal(out[1]._log_ctx.action, 'OPEN_FOR_DURATION');
  assert.equal(JSON.parse(out[2].payload).result, 'SUCCESS');
  assert.equal(JSON.parse(out[2].payload).transportPhase, 'ACCEPTED');
  assert.equal(out[3].statusCode, 202, 'manual HTTP response waits for accepted transport');
  assert.equal((await fixture.db.get('SELECT COUNT(*) AS count FROM applied_commands WHERE command_id=?', ['wrapper-command'])).count, 0, 'internal safety CLOSE has no cloud ledger row');

  const logCount = events.filter((entry) => entry[0] === 'log').length;
  const replay = await invoke(fixture.db, { async enqueueDownlink() { throw new Error('accepted replay must not enqueue'); } }, msg, events, runtimeControl());
  assert.equal(replay[0], null);
  assert.equal(replay[1], null, 'accepted replay must not emit another actuator log');
  assert.equal(JSON.parse(replay[2].payload).result, 'SUCCESS');
  assert.equal(JSON.parse(replay[2].payload).transportPhase, 'ACCEPTED');
  assert.equal(events.filter((entry) => entry[0] === 'log').length, logCount);
  assert.equal((await fixture.db.get('SELECT COUNT(*) AS count FROM applied_commands WHERE command_id=?', ['wrapper-command'])).count, 0, 'replay must not synthesize a cloud ledger row');
  const busy = await invoke(fixture.db, { async enqueueDownlink() { throw new Error('busy must not enqueue'); } }, {
    payload: { type: 'actuator_command', device: { devEui: EUI }, data: { action: 'OPEN_FOR_DURATION', duration_minutes: 7, commandId: 192, commandType: 'VALVE_COMMAND' } },
    _stregaDispatchError: { code: 'valve_busy', message: 'valve has an active command' },
    _stregaHttpResponse: { res: {}, statusCode: 202, payload: { status: 'queued' } },
  }, events);
  assert.equal(busy[1], null, 'busy must not emit a local actuator log');
  assert.equal(busy[2], null, 'local busy must not emit a command ACK');
  assert.equal(busy[3].statusCode, 409, 'local busy must reach HTTP after the writer gate');
  const busyAck = await invoke(fixture.db, { async enqueueDownlink() { throw new Error('busy must not enqueue'); } }, {
    payload: { type: 'actuator_command', device: { devEui: EUI }, data: { action: 'OPEN_FOR_DURATION', duration_minutes: 7, commandId: 193, commandType: 'VALVE_COMMAND' } },
    _stregaDispatchError: { code: 'valve_busy', message: 'valve has an active command' },
  }, events);
  assert.equal(JSON.parse(busyAck[2].payload).result, 'REJECTED_PERMANENT', 'cloud valve_busy must be terminal');
  const queuedBusy = await invokeNode(ackQueue, fixture.db, { async enqueueDownlink() { throw new Error('busy must not enqueue'); } }, {
    payload: busyAck[2].payload,
  }, events);
  const queuedBusyAck = JSON.parse(queuedBusy.payload);
  assert.equal(queuedBusyAck.commandId, 193, 'actual encoder output must carry the numeric cloud command ID');
  assert.equal(queuedBusyAck.result, 'REJECTED_PERMANENT', 'actual ACK queue must preserve terminal cloud busy');
  const replayBusy = await invokeNode(ackQueue, fixture.db, { async enqueueDownlink() { throw new Error('busy replay must not enqueue'); } }, {
    payload: JSON.stringify({ commandId: 193, commandType: 'VALVE_COMMAND', deviceEui: EUI, result: 'SUCCESS' }),
  }, events);
  assert.equal(JSON.parse(replayBusy.payload).result, 'REJECTED_PERMANENT', 'actual ACK queue must exact-replay terminal cloud busy');

  const ledger = require(path.join(runtimePath, 'osi-command-ledger'));
  // The writer no longer creates a pending ledger/expectation. This regression
  // proves the authorization wrapper leaves the sole claim to the final encoder.
  const crash = await tempDb();
  const crashWriter = flow.find((node) => node.id === 'write-strega-expectation');
  const crashInput = { payload: { type: 'actuator_command', device: { devEui: EUI }, data: {
    action: 'OPEN_FOR_DURATION', duration_minutes: 6, commandId: 194, commandType: 'VALVE_COMMAND'
  } }, actor_user_uuid: 'crash-replay-actor' };
  const crashWritten = await invokeNode(crashWriter, crash.db, {}, crashInput, events);
  assert.equal(crashWritten._stregaDispatchError, undefined, 'actual writer must complete authorization');
  assert.ok(crashWritten && crashWritten._stregaDispatchCommand, 'actual writer must pass normalized command to encoder');
  assert.equal(crashWritten._stregaReservation, undefined, 'authorization must not preclaim before enqueue');
  assert.equal((await crash.db.get('SELECT COUNT(*) AS count FROM applied_commands')).count, 0, 'writer must not create a ledger row before final composition');
  assert.equal((await crash.db.get('SELECT COUNT(*) AS count FROM valve_actuation_expectations')).count, 0, 'writer must not create an expectation before final composition');
  crash.cleanup();

  const phaseCases = [
    { name: 'absent', transport: null, result: 'FAILED_RETRYABLE', phase: 'UNKNOWN' },
    { name: 'INTENT', transport: { phase: 'INTENT' }, result: 'FAILED_RETRYABLE', phase: 'UNKNOWN' },
    { name: 'ATTEMPTED', transport: { phase: 'ATTEMPTED' }, result: 'FAILED_RETRYABLE', phase: 'UNKNOWN' },
    { name: 'UNKNOWN', transport: { phase: 'UNKNOWN' }, result: 'FAILED_RETRYABLE', phase: 'UNKNOWN' },
    { name: 'enqueue_rejected', transport: { phase: 'enqueue_rejected' }, result: 'REJECTED_PERMANENT', phase: 'enqueue_rejected' },
    { name: 'enqueue_failed_before_acceptance', transport: { phase: 'enqueue_failed_before_acceptance' }, result: 'REJECTED_PERMANENT', phase: 'enqueue_failed_before_acceptance' },
    { name: 'ACCEPTED', transport: { phase: 'ACCEPTED' }, result: 'FAILED_RETRYABLE', phase: 'UNKNOWN' },
    { name: 'rejection with acceptance marker', transport: { phase: 'enqueue_rejected', queue_id: 'conflicting-queue' }, result: 'FAILED_RETRYABLE', phase: 'UNKNOWN' },
  ];
  for (const [index, fixture] of phaseCases.entries()) {
    const phaseDb = await tempDb();
    const commandId = String(2100 + index);
    await phaseDb.db.run('INSERT INTO applied_commands(command_id,device_eui,command_type,applied_at,result,result_detail,originator) VALUES (?,?,?,?,?,?,?)', [
      commandId, EUI, 'VALVE_COMMAND', '2026-10-17T10:00:00.000Z', 'IN_PROGRESS',
      JSON.stringify({ commandId: Number(commandId), commandType: 'VALVE_COMMAND', status: 'PENDING', result: 'IN_PROGRESS', duplicate: false }), 'wrapper-phase-matrix',
    ]);
    await phaseDb.db.run('INSERT INTO valve_actuation_expectations(expectation_id,device_eui,command_id,commanded_at,commanded_duration_seconds,expected_close_at,volume_source,reconciliation_state,created_at,transport_json) VALUES (?,?,?,?,?,?,?,?,?,?)', [
      'wrapper-phase-' + commandId, EUI, commandId, '2026-10-17T10:00:00.000Z', 300, '2026-10-17T10:05:00.000Z', 'unknown', 'PENDING_OBSERVATION', '2026-10-17T10:00:00.000Z', fixture.transport && JSON.stringify(fixture.transport),
    ]);
    let rpcCalls = 0;
    const noRpcTransport = { async enqueueDownlink() { rpcCalls += 1; throw new Error(fixture.name + ' replay must not enqueue'); } };
    const envelope = { commandId: Number(commandId), commandType: 'VALVE_COMMAND', payload: { device_eui: EUI } };
    const first = await ledger.deduplicatePendingCommand(phaseDb.db, envelope, { transport: noRpcTransport });
    assert.equal(first.ack.result, fixture.result, fixture.name + ' result');
    assert.equal(first.ack.transportPhase, fixture.phase, fixture.name + ' phase');
    const second = await ledger.deduplicatePendingCommand(phaseDb.db, envelope, { transport: noRpcTransport });
    assert.deepEqual(second.ack, first.ack, fixture.name + ' exact replay must be immutable');
    assert.equal(rpcCalls, 0, fixture.name + ' recovery must not make an RPC');
    assert.equal((await phaseDb.db.get('SELECT result FROM applied_commands WHERE command_id=?', [commandId])).result, fixture.result, fixture.name + ' durable result');
    phaseDb.cleanup();
  }

  const chain = await tempDb();
  const chainCalls = [];
  const chainOut = await invokeChain(chain.db, { async enqueueDownlink(item) { chainCalls.push(item); return { id: 'chain-q-1' }; } }, events, {
    payload: [{ deveui: EUI, type_id: 'STREGA_VALVE', user_id: 1, irrigation_zone_id: null }],
    osi: { request: { kind: 'valve_command', targetEui: EUI, actorId: 1, action: 'OPEN_FOR_DURATION', durationMinutes: 6 } },
    actor_user_uuid: 'wrapper-actor',
  });
  assert.equal(chainCalls.length, 1, 'builder -> writer -> encoder must use the real delayed transport');
  assert.equal(chainOut[0], null);
  assert.equal(chainOut[3].statusCode, 202);

  const cloud = await tempDb();
  const cloudRoute = flow.find((node) => node.id === '934bf2bc19a8ce22');
  const cloudInput = {
    payload: {
      commandType: 'VALVE_COMMAND', commandId: 205, deviceEui: EUI,
      action: 'OPEN_FOR_DURATION', duration_seconds: 420,
      actor_user_uuid: 'cloud-wrapper-actor', gateway_device_eui: EUI,
    },
  };
  const routedCloud = (await invokeNode(cloudRoute, cloud.db, {}, cloudInput, events))[0];
  assert.ok(routedCloud && routedCloud.payload && routedCloud._actorUserUuid === 'cloud-wrapper-actor', 'cloud route must preserve the authorized actor');
  const cloudWritten = await invokeNode(flow.find((node) => node.id === 'write-strega-expectation'), cloud.db, {}, routedCloud, events);
  assert.ok(cloudWritten && cloudWritten._stregaDispatchCommand, 'cloud VALVE_COMMAND must reach the normalized writer seam');
  const cloudCalls = [];
  const cloudOut = await invoke(cloud.db, { async enqueueDownlink(item) { cloudCalls.push(item); return { id: 'cloud-q-1' }; } }, cloudWritten, events, runtimeControl());
  assert.equal(cloudCalls.length, 1, 'cloud route -> writer -> encoder must enqueue exactly once');
  assert.deepEqual([...Buffer.from(cloudCalls[0].data, 'base64')], [0x41, 7], 'cloud OPEN must use the final STREGA encoder');
  assert.equal(cloudOut[1]._log_ctx.commandId, 205);
  cloud.cleanup();

  const race = await tempDb();
  let enqueueStarted;
  const enqueueReady = new Promise((resolve) => { enqueueStarted = resolve; });
  let activeTransport = 0; let maxTransport = 0;
  const raceTransport = {
    async enqueueDownlink(item) {
      activeTransport += 1; maxTransport = Math.max(maxTransport, activeTransport); enqueueStarted();
      await new Promise((resolve) => setTimeout(resolve, 15)); activeTransport -= 1;
      return { id: 'race-q-1' };
    },
    async getDeviceQueue() {
      activeTransport += 1; maxTransport = Math.max(maxTransport, activeTransport);
      await new Promise((resolve) => setTimeout(resolve, 5)); activeTransport -= 1; return [];
    },
    async flushDeviceQueue() {
      activeTransport += 1; maxTransport = Math.max(maxTransport, activeTransport);
      await new Promise((resolve) => setTimeout(resolve, 5)); activeTransport -= 1; return { statusCode: 204 };
    }
  };
  const raceBuilder = flow.find((node) => node.id === 'dde8e1ef265e96d7');
  const raceBuilt = (await invokeNode(raceBuilder, race.db, {}, {
    payload: [{ deveui: EUI, type_id: 'STREGA_VALVE', user_id: 1, irrigation_zone_id: null }],
    osi: { request: { kind: 'valve_command', targetEui: EUI, actorId: 1, action: 'OPEN_FOR_DURATION', durationMinutes: 6 } },
    actor_user_uuid: 'race-actor'
  }, events))[0];
  const raceWritten = await invokeNode(flow.find((node) => node.id === 'write-strega-expectation'), race.db, raceTransport, raceBuilt, events);
  const raceEncode = invoke(race.db, raceTransport, raceWritten, events, runtimeControl());
  await enqueueReady;
  const raceFlush = VC.flushValveQueue({ db: race.db, deviceEui: EUI, reason: 'wrapper-race', now: new Date('2026-10-17T10:00:00.000Z'), transport: raceTransport });
  const [raceOut] = await Promise.all([raceEncode, raceFlush]);
  assert.equal(maxTransport, 1, 'actual encoder enqueue and flush must share the device gate');
  assert.ok(raceOut[1] && raceOut[1]._log_ctx, 'actual enqueue race must preserve accepted log output');
  race.cleanup();

  const outer = await tempDb();
  const originalGet = outer.db.get.bind(outer.db);
  outer.db.get = async function (sql, params) {
    if (String(sql).includes('applied_commands')) throw new Error('post-transport ledger read failed');
    return originalGet(sql, params);
  };
  const outerOut = await invoke(outer.db, { async enqueueDownlink() { return { id: 'outer-q-1' }; } }, {
    payload: { type: 'actuator_command', device: { devEui: EUI }, data: {
      action: 'CLOSE', commandId: 'outer-ledger-failure', commandType: 'VALVE_COMMAND'
    } }
  }, events);
  assert.equal(outerOut[0], null);
  assert.equal(outerOut[1], null);
  assert.equal(JSON.parse(outerOut[2].payload).result, 'FAILED', 'cloud outer failure must return retryable ACK');
  assert.equal(outerOut[3], null);
  outer.cleanup();
  const changed = await tempDb();
  const changedEvents = [];
  const changedBuilder = flow.find((node) => node.id === 'dde8e1ef265e96d7');
  const changedWriterInput = (await invokeNode(changedBuilder, changed.db, {}, {
    payload: [{ deveui: EUI, type_id: 'STREGA_VALVE', user_id: 1, irrigation_zone_id: null }],
    osi: { request: { kind: 'valve_command', targetEui: EUI, actorId: 1, action: 'OPEN_FOR_DURATION', durationMinutes: 6 } }, actor_user_uuid: 'wrapper-actor',
  }, changedEvents))[0];
  const changedWritten = await invokeNode(flow.find((node) => node.id === 'write-strega-expectation'), changed.db, {}, changedWriterInput, changedEvents);
  changedWritten.payload.data.duration_minutes = 9;
  const changedOut = await invoke(changed.db, { async enqueueDownlink() { throw new Error('mutable draft must not enqueue'); } }, changedWritten, changedEvents, runtimeControl());
  assert.equal(changedOut[0], null); assert.equal(changedOut[1], null); assert.equal(changedOut[3].statusCode, 503, 'mutable draft mismatch must complete local HTTP');
  changed.cleanup(); chain.cleanup();

  const simulation = flow.find((node) => node.id === '3301d5ea9863f66b');
  const simulationDb = await tempDb();
  const simOne = await invokeNode(simulation, simulationDb.db, {}, {}, events);
  const simTwo = await invokeNode(simulation, simulationDb.db, {}, {}, events);
  assert.notEqual(simOne.payload.data.commandId, simTwo.payload.data.commandId, 'simulation injections must get fresh command IDs');
  simOne.payload.device.devEui = EUI; simTwo.payload.device.devEui = EUI;
  const scopedSimOne = await invokeNode(flow.find((node) => node.id === 'write-strega-expectation'), simulationDb.db, {}, simOne, events, VC, { OSI_SCOPED_ACCESS: '1' });
  assert.ok(scopedSimOne._stregaDispatchCommand, 'simulation must carry explicit trusted internal authorization in scoped mode');
  assert.equal(scopedSimOne._stregaReservation, undefined, 'simulation authorization must not preclaim before final composition');
  const scopedSimTwo = await invokeNode(flow.find((node) => node.id === 'write-strega-expectation'), simulationDb.db, {}, simTwo, events, VC, { OSI_SCOPED_ACCESS: '1' });
  assert.notEqual(scopedSimTwo._stregaDispatchCommand.command_id, scopedSimOne._stregaDispatchCommand.command_id, 'second simulation must be a fresh command, not an exact replay');
  assert.equal(scopedSimTwo._stregaDispatchError, undefined, 'second simulation authorization must remain independent before final composition');
  const simulationCalls = [];
  const simulationOut = await invoke(simulationDb.db, { async enqueueDownlink(item) { simulationCalls.push(item); return { id: 'simulation-q-1' }; } }, scopedSimOne, events, runtimeControl());
  assert.equal(simulationCalls.length, 1, 'simulation OPEN must reach the real final encoder');
  assert.deepEqual([...Buffer.from(simulationCalls[0].data, 'base64')], [0x41, Number(scopedSimOne._stregaDispatchCommand.duration_minutes)]);
  assert.equal(simulationOut[1]._log_ctx.action, 'OPEN_FOR_DURATION');
  simulationDb.cleanup();

  const early = await invokeNode(encoder, fixture.db, { async enqueueDownlink() { throw new Error('early validation must not enqueue'); } }, { payload: { type: 'actuator_command', device: { devEui: EUI }, data: { action: 'OPEN_FOR_DURATION', duration_minutes: 7 } }, _stregaHttpResponse: { res: {}, statusCode: 202, payload: {} } }, events, VC, { CHIRPSTACK_APP_ACTUATORS: '' });
  assert.equal(early.length, 4); assert.equal(early[3].statusCode, 503, 'missing app id must complete local HTTP');
  for (const spec of [{ unit: 'SECONDS', amount: 30, opcode: 0x21 }, { unit: 'HOURS', amount: 2, opcode: 0x81 }]) {
    const advanced = await tempDb();
    const advancedCalls = [];
    const advancedInput = { payload: [{ deveui: EUI, type_id: 'STREGA_VALVE', user_id: 1, irrigation_zone_id: null }], _strega_local_action: 'TIMED_ACTION', _strega_timed_action: 'OPEN', _strega_timed_unit: spec.unit, _strega_timed_amount: spec.amount, actor_user_uuid: 'advanced-wrapper-actor' };
    const advancedAuthorized = (await invokeNode(flow.find((node) => node.id === 'put-strega-advanced-authorize-fn'), advanced.db, {}, advancedInput, []))[1];
    const advancedWritten = await invokeNode(flow.find((node) => node.id === 'write-strega-expectation'), advanced.db, {}, advancedAuthorized, []);
    const advancedOut = await invoke(advanced.db, { async enqueueDownlink(item) { advancedCalls.push(item); return { id: 'advanced-' + spec.unit }; } }, advancedWritten, [], runtimeControl());
    assert.deepEqual([...Buffer.from(advancedCalls[0].data, 'base64')], [spec.opcode, spec.amount]);
    assert.equal(advancedOut[0], null);
    advanced.cleanup();
  }
  const unclaimNode = flow.find((node) => node.id === 'delete-device-valve-cleanup-fn');
  const unclaimEvents = [];
  const unclaim = await tempDb();
  const unclaimControl = {
    async liveDeleteValveCleanup({ msg }) { return [Object.assign(msg, { statusCode: 503, payload: { error: 'transport_uncertain' } }), null]; },
  };
  const unclaimOut = await invokeNode(unclaimNode, unclaim.db, { async flushDeviceQueue() {} }, { statusCode: 200, payload: { device_eui: EUI } }, unclaimEvents, unclaimControl);
  assert.equal(unclaimOut[0].statusCode, 503);
  assert.equal(unclaimOut[0].payload.error, 'transport_uncertain');
  assert.equal(unclaimOut[1], null);
  unclaim.cleanup();
  fixture.cleanup();
  console.log('writer wrappers: scenarios passed (builder -> writer -> encoder, delayed enqueue, FAILED_RETRYABLE replay, mutable draft, simulation IDs, TIMED_ACTION seconds/hours, unclaim failure); STREGA MQTT output remained null');
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
