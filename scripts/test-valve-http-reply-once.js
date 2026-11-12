#!/usr/bin/env node
'use strict';

// Every local STREGA command that answers its HTTP request only after the
// radio transport has decided must answer exactly once, whatever the wiring
// between its builder and the encoder looks like.
//
// The builders put the reply into the actuator message, which travels through
// link in 5974306566e99a92 "from scheduler/manual". That link in has two
// receivers, so Node-RED hands the second one a clone (Node.prototype.send),
// and a clone keeps only a top-level msg.req/msg.res by reference
// (util.cloneMessage). A reply carried anywhere else is deep-copied and can
// no longer answer: the frame went out, the caller got no answer.
//
// scripts/lib/node-red-send-emulation.js follows the wires and clones as
// Node-RED 3.1.15 does; its header names the source of each behaviour. The
// test runs the eight commands from their builders on, with the link in as
// shipped, with one more receiver on it, and with only one receiver.
// Upstream auth/validation and the sqlite lookups are not run: each builder
// gets the device row the lookup would return.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction } = require('./lib/scoped-access-harness');
const { fakeHttpRequest, walk } = require('./lib/node-red-send-emulation');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const VALVE = 'A840410000000001';
const GATEWAY = '0016C001F1000001';
const LINK_IN = '5974306566e99a92';
const LINK_IN_DEBUG = '072f29aa8760340a';
const ENV = { DEVICE_EUI: GATEWAY, CHIRPSTACK_APP_ACTUATORS: 'app-actuators' };
const ENCODER = 'cdbaa3891d40d7a1';

// The encoder's ledger read after the transport attempt sits outside its inner try, so a
// failure there reaches its .catch (the exception path that answers 503).
const failLedgerRead = {
  select: ({ method, sql }) => (method === 'get' && /SELECT result_detail FROM applied_commands/.test(sql)
    ? { kind: 'synthetic_busy' } : { kind: 'execute' }),
};

function profile(name) {
  const base = path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${name}/files/usr/share`);
  const flows = JSON.parse(fs.readFileSync(path.join(base, 'flows.json'), 'utf8'));
  const rawValveControl = require(path.join(base, 'node-red/osi-valve-control'));
  // A timed open is attempted only with a trusted runtime clock; supply a
  // fixture clock marker (as test-valve-command-safety-path.js does).
  const valveControl = { ...rawValveControl, executeValveAttempt(args) {
    return rawValveControl.executeValveAttempt({ ...args, trustedContext: trustedRuntime() });
  } };
  return { name, base, flows, valveControl };
}

function trustedRuntime() {
  const anchor = Date.now();
  const bootId = 'valve-http-reply-boot';
  const fsFixture = { readFileSync(file) {
    if (file === '/proc/sys/kernel/random/boot_id') return bootId + '\n';
    if (file === '/proc/uptime') return `${(Date.now() - anchor) / 1000} 0\n`;
    if (file === '/var/run/osi-irrigation-clock.json') return JSON.stringify({ boot_id: bootId, epoch_ms: anchor, uptime_ms: 0, stratum: 1 });
    throw Object.assign(new Error('missing test clock path'), { code: 'ENOENT' });
  } };
  return { clockOptions: { fs: fsFixture, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime',
    markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/valve-http-reply-rejection.json',
    fallbackPath: '/tmp/valve-http-reply-rejection-fallback.json' } };
}

function seedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  db.exec(`
    INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'grower', 'h', '2026-01-01');
    INSERT INTO devices (deveui, name, type_id, user_id, strega_model, created_at, updated_at)
      VALUES ('${VALVE}', 'Valve', 'STREGA_VALVE', 1, 'MOTORIZED', '2026-01-01', '2026-01-01');
  `);
  return db;
}

function fakeChirpstack(options = {}) {
  const enqueued = [];
  const client = {
    async flushDeviceQueue() { return {}; },
    async getDeviceQueue() { return []; },
    async enqueueDownlink(item) {
      if (options.reject) throw Object.assign(new Error('enqueue refused'), { code: 'enqueue_rejected' });
      enqueued.push(item);
      return { id: 'q-' + enqueued.length };
    },
  };
  return { enqueued, createProvisioningClientFromEnv: () => client };
}

const ROW = { deveui: VALVE, name: 'Valve', type_id: 'STREGA_VALVE', user_id: 1, irrigation_zone_id: null, strega_model: 'MOTORIZED' };

// The eight commands, each as its builder receives it from the device lookup.
const COMMANDS = [
  ['POST /api/valve CLOSE', 'dde8e1ef265e96d7', () => valveRequest('CLOSE')],
  ['POST /api/valve CLOSE_FOR_DURATION', 'dde8e1ef265e96d7', () => valveRequest('CLOSE_FOR_DURATION', 2)],
  ['POST /api/valve OPEN_FOR_DURATION', 'dde8e1ef265e96d7', () => valveRequest('OPEN_FOR_DURATION', 2)],
  ['PUT strega/interval', 'put-strega-interval-authorize-fn', () => ({
    _strega_closed_interval_minutes: 10, _strega_open_interval_minutes: 2, _strega_tamper_disabled: false,
    _strega_payload_hex: '000a0002', _strega_fport: 11 })],
  ['PUT strega/timed-action', 'put-strega-advanced-authorize-fn', () => ({
    _strega_local_action: 'TIMED_ACTION', _strega_timed_action: 'CLOSE', _strega_timed_unit: 'MINUTES',
    _strega_timed_amount: 2, _strega_payload_hex: '4002', _strega_fport: 2 })],
  ['PUT strega/magnet', 'put-strega-advanced-authorize-fn', () => ({
    _strega_local_action: 'MAGNET_MODE', _strega_enabled: true, _strega_payload_hex: '31', _strega_fport: 22 })],
  ['PUT strega/partial-opening', 'put-strega-advanced-authorize-fn', () => ({
    _strega_local_action: 'PARTIAL_OPENING', _strega_partial_action: 'OPEN', _strega_percentage: 50,
    _strega_payload_hex: '3032', _strega_fport: 27 })],
  ['PUT strega/flushing', 'put-strega-advanced-authorize-fn', () => ({
    _strega_local_action: 'FLUSHING', _strega_return_position: 'CLOSE', _strega_percentage: 50,
    _strega_payload_hex: '3032', _strega_fport: 28 })],
];

function valveRequest(action, durationMinutes) {
  return { osi: { request: { kind: 'valve_command', targetEui: VALVE, actorId: 1, action, durationMinutes } } };
}

async function send(p, db, startId, fields, options = {}) {
  const http = fakeHttpRequest();
  const chirpstack = options.chirpstack || fakeChirpstack();
  const msg = Object.assign({ _msgid: 'm1', payload: [Object.assign({}, ROW, options.row || {})],
    req: http.req, res: http.res, _strega_deveui: VALVE, _strega_user_id: 1 }, fields);
  const result = await walk({
    flows: p.flows,
    startId,
    msg,
    wiresOf: options.wiresOf,
    runFunction: async (node, current) => {
      const run = await executeFunction(node, {
        msg: current, env: Object.assign({}, ENV, options.env || {}), db,
        dbCallGate: node.id === ENCODER && options.encoderDbGate ? options.encoderDbGate : undefined,
        osiLibModules: { 'osi-valve-control': p.valveControl },
        libOverrides: Object.assign({ chirpstack }, options.valveControlMissing ? { osiLib: missingValveControl() } : {}),
      });
      return run.result;
    },
  });
  return { answers: http.answers, enqueued: chirpstack.enqueued, ...result };
}

// osiLib as it answers when osi-valve-control did not load: every other name
// is still unregistered here, as the nodes on this path stop at the first refusal.
function missingValveControl() {
  return { require: (name) => ({ ok: false, error: 'Cannot find module ' + name }) };
}

function wiresWithLinkIn(receivers) {
  return (node) => node.id === LINK_IN ? [receivers(node.wires[0])] : (node.wires || []);
}

const TOPOLOGIES = [
  ['as shipped', undefined],
  ['with a third receiver on the link in', wiresWithLinkIn((wires) => wires.concat(LINK_IN_DEBUG))],
  ['with the debug receiver removed', wiresWithLinkIn((wires) => wires.filter((id) => id !== LINK_IN_DEBUG))],
  // Write STREGA Expectation gets a clone even if the shipped wires are ever reordered.
  ['with a receiver put first on the link in', wiresWithLinkIn((wires) => [LINK_IN_DEBUG].concat(wires))],
];

for (const name of PROFILES) {
  const p = profile(name);

  test(`${name}: link in ${LINK_IN} as shipped has more than one receiver`, () => {
    const linkIn = p.flows.find((node) => node.id === LINK_IN);
    assert.ok(linkIn.wires[0].length > 1, 'this suite must exercise a link in with several receivers');
  });

  for (const [topology, wiresOf] of TOPOLOGIES) {
    for (const [label, builder, fields] of COMMANDS) {
      test(`${name}: ${label} ${topology} answers 202 exactly once after the frame is accepted`, async () => {
        const db = seedDb();
        try {
          const out = await send(p, db, builder, fields(), { wiresOf });
          assert.ok(out.trace.includes('cdbaa3891d40d7a1'), 'command must reach the encoder: ' + out.trace.join(' > '));
          assert.equal(out.enqueued.length, 1, 'one frame handed to the transport');
          assert.deepEqual(out.answers.map((a) => a.statusCode), [202], 'exactly one 202 answer; errors: ' + out.errors.join('; '));
        } finally { db.close(); }
      });
    }
  }

  for (const [topology, wiresOf] of TOPOLOGIES) {
    // A refusal raised by Write STREGA Expectation reaches the encoder as _stregaDispatchError.
    test(`${name}: an open refused by the scope gate ${topology} answers 403 exactly once, with no frame`, async () => {
      const db = seedDb();
      try {
        const out = await send(p, db, 'dde8e1ef265e96d7', valveRequest('OPEN_FOR_DURATION', 2),
          { wiresOf, env: { OSI_SCOPED_ACCESS: '1' } });
        assert.ok(out.trace.includes(ENCODER), 'refusal must reach the encoder: ' + out.trace.join(' > '));
        assert.equal(out.enqueued.length, 0);
        assert.equal(out.answers.length, 1, 'errors: ' + out.errors.join('; '));
        assert.equal(out.answers[0].statusCode, 403);
        assert.equal(out.answers[0].payload.error, 'scope_actor_required');
      } finally { db.close(); }
    });

    test(`${name}: an open whose encoder throws after the transport ${topology} answers 503 exactly once`, async () => {
      const db = seedDb();
      try {
        const out = await send(p, db, 'dde8e1ef265e96d7', valveRequest('OPEN_FOR_DURATION', 2),
          { wiresOf, encoderDbGate: failLedgerRead });
        assert.equal(out.answers.length, 1, 'errors: ' + out.errors.join('; '));
        // The encoder's .catch answers with the thrown error's own message.
        assert.deepEqual(out.answers[0], { statusCode: 503, payload: { error: 'SQLITE_BUSY', message: 'SQLITE_BUSY: database is locked' } });
      } finally { db.close(); }
    });
  }

  for (const [label, builder, fields] of COMMANDS) {
    test(`${name}: ${label} answers exactly once when the transport is unavailable`, async () => {
      const db = seedDb();
      try {
        const out = await send(p, db, builder, fields(), { env: { CHIRPSTACK_APP_ACTUATORS: '' } });
        assert.equal(out.enqueued.length, 0);
        assert.deepEqual(out.answers.map((a) => a.statusCode), [503], 'errors: ' + out.errors.join('; '));
      } finally { db.close(); }
    });

    test(`${name}: ${label} answers exactly once when the transport refuses the frame`, async () => {
      const db = seedDb();
      try {
        const out = await send(p, db, builder, fields(), { chirpstack: fakeChirpstack({ reject: true }) });
        assert.equal(out.answers.length, 1, 'one answer; errors: ' + out.errors.join('; '));
        assert.ok(out.answers[0].statusCode >= 400, 'a refused frame is not answered as accepted');
      } finally { db.close(); }
    });

    test(`${name}: ${label} answers exactly once when the device is not a STREGA valve`, async () => {
      const db = seedDb();
      try {
        const out = await send(p, db, builder, fields(), { row: { type_id: 'KIWI_SENSOR' } });
        assert.equal(out.enqueued.length, 0);
        assert.deepEqual(out.answers.map((a) => a.statusCode), [409], 'errors: ' + out.errors.join('; '));
      } finally { db.close(); }
    });
  }

  // Write STREGA Expectation passes the message on when the module is missing;
  // the encoder must then answer the request itself (NEW-2).
  for (const [label, builder, fields] of COMMANDS.filter(([, id]) => id === 'dde8e1ef265e96d7')) {
    test(`${name}: ${label} answers 503 exactly once when osi-valve-control did not load`, async () => {
      const db = seedDb();
      try {
        const out = await send(p, db, builder, fields(), { valveControlMissing: true });
        assert.ok(out.trace.includes('cdbaa3891d40d7a1'), 'command must reach the encoder: ' + out.trace.join(' > '));
        assert.equal(out.enqueued.length, 0);
        assert.deepEqual(out.answers, [{ statusCode: 503, payload: { error: 'valve_control_unavailable' } }],
          'errors: ' + out.errors.join('; '));
      } finally { db.close(); }
    });
  }

  // Since the return to the 0.8.1 rule an earlier ordinary open does not refuse a later one.
  test(`${name}: a second open while the first is pending is accepted, and both are answered once`, async () => {
    const db = seedDb();
    try {
      const first = await send(p, db, 'dde8e1ef265e96d7', valveRequest('OPEN_FOR_DURATION', 2));
      const second = await send(p, db, 'dde8e1ef265e96d7', valveRequest('OPEN_FOR_DURATION', 2));
      assert.deepEqual(first.answers.map((a) => a.statusCode), [202]);
      assert.equal(second.enqueued.length, 1, 'the second open is handed over as well');
      assert.deepEqual(second.answers.map((a) => a.statusCode), [202], 'errors: ' + second.errors.join('; '));
    } finally { db.close(); }
  });

  // What still refuses an ordinary open as busy: a stored conditional-irrigation occurrence.
  test(`${name}: an open for a valve held by a conditional occurrence is refused as busy and answered once`, async () => {
    const db = seedDb();
    try {
      db.prepare("INSERT INTO irrigation_occurrences(schedule_uuid, local_date, local_time, device_eui, due_at, state, command_id) VALUES ('reply-once-conditional','2026-01-01','06:00',?,'2026-01-01T06:00:00.000Z','SENT','reply-once-conditional-command')").run(VALVE);
      const refused = await send(p, db, 'dde8e1ef265e96d7', valveRequest('OPEN_FOR_DURATION', 2));
      assert.equal(refused.enqueued.length, 0, 'the busy valve gets no frame');
      assert.equal(refused.answers.length, 1, 'errors: ' + refused.errors.join('; '));
      assert.equal(refused.answers[0].statusCode, 409);
      assert.equal(refused.answers[0].payload.error, 'valve_busy');
    } finally { db.close(); }
  });
}
