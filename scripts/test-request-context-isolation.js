#!/usr/bin/env node
'use strict';

// Request isolation for the valve, zone-schedule and zone-delete mutation chains
// (osi-os #377).
//
// Concurrent HTTP requests interleave at every asynchronous boundary of a Node-RED
// chain (each sqlite node). The manual valve chain used to keep its target, action
// and duration in shared flow context (valve_cmd_*), the zone-schedule chain kept its
// validated patch there (sched_*), the zone-delete chain kept its zone, actor and
// next sync_version there (delete_zone_*), and the STREGA status ACK fell back to the
// last routed cloud command id (lastCommandId). A request resumed after another request
// had passed the same node then used the other request's values: the wrong valve,
// the wrong duration, the wrong schedule row, the wrong ACK.
//
// This harness runs the SHIPPED function bodies from the canonical flows.json and
// follows the real wiring with a small deterministic runtime:
//   - function nodes: scripts/lib/scoped-access-harness.js executeFunction (real
//     osi-scope-helper, osi-command-ledger, osi-valve-control; seed-blank.sql in memory);
//   - sqlite nodes: the node-red-node-sqlite msg.topic model (db.all(msg.topic), rows to
//     msg.payload, the same msg object sent on; an error goes to node.error, which the
//     tab's catch nodes receive);
//   - link out/in, switch (nnull/else), http response, mqtt out, debug, catch.
// Flow context is one store per tab, shared by every request, as in Node-RED. The test
// decides whose next message is delivered, so every interleaving is explicit.
//
// Run: node --test scripts/test-request-context-isolation.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  executeFunction,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const MODULES = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const FLOWS = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  'utf8'
));
const NODES = new Map(FLOWS.map((node) => [node.id, node]));
const scopeHelper = require(path.join(MODULES, 'osi-scope-helper'));
const rawValveControl = require(path.join(MODULES, 'osi-valve-control'));
// On this branch the manual open is answered after the STREGA write went through the ChirpStack
// transport (the encoder returns the deferred 202), and the actuator_log/target-state write is
// the encoder's log path. A timed open is attempted only with a trusted runtime clock, so the
// harness supplies a fixture clock marker (as test-conditional-irrigation-writer-wrappers.js).
function trustedRuntime() {
  const anchor = Date.now();
  const bootId = 'request-isolation-boot';
  const fsFixture = { readFileSync(file) {
    if (file === '/proc/sys/kernel/random/boot_id') return bootId + '\n';
    if (file === '/proc/uptime') return `${(Date.now() - anchor) / 1000} 0\n`;
    if (file === '/var/run/osi-irrigation-clock.json') return JSON.stringify({ boot_id: bootId, epoch_ms: anchor, uptime_ms: 0, stratum: 1 });
    throw Object.assign(new Error('missing test clock path'), { code: 'ENOENT' });
  } };
  return { clockOptions: { fs: fsFixture, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime',
    markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/request-isolation-rejection.json',
    fallbackPath: '/tmp/request-isolation-rejection-fallback.json' } };
}
const valveControl = { ...rawValveControl, executeValveAttempt(args) {
  return rawValveControl.executeValveAttempt({ ...args, trustedContext: trustedRuntime() });
} };

const AUTH_SECRET = 'request-isolation-test-secret';
const GATEWAY_EUI = '0016C001F1000001';
const VALVE_A = 'A840410000000001';
const VALVE_B = 'A840410000000002';
const VALVE_FOREIGN = 'A840410000000003';
const SENSOR = 'A840410000000004';
const UNKNOWN_EUI = 'A840410000000009';

const ID = {
  valveHttp: '6ba1d1d0ac7fd7db',
  valveAuth: '83bb4a452dd9ae37',
  valveUserDb: '57c88461ef4a9dcf',
  valveCheck: '9ad895844533fb35',
  valveDeviceDb: '1271278de1cdb09b',
  valveBuild: 'dde8e1ef265e96d7',
  // The manual open's actuator_log + target-state write is the encoder's log path now (the old
  // 'DB: actuator_log + devices update' node is no longer wired).
  valveWriteDb: 'e681a40093c3798d',
  toActuator: '1ef83e7d26a33d6c',
  cancelHttp: 'cancel-valve-local-http-in',
  schedHttp: 'e970d93ded4679af',
  schedUserDb: '697f8cfd92ccf539',
  schedVerify: '22cc64fa2a899cea',
  schedZoneDb: 'bda5f35469bb5fc6',
  schedSaveDb: '899ec5378779ad86',
  // The zone schedule write runs inside the conditional lifecycle service (one function node,
  // one transaction) and answers itself; 'Save to DB' is no longer reached.
  schedWrite: 'conditional-legacy-schedule-adapter',
  routeCommand: '934bf2bc19a8ce22',
  routeToActuator: '745b6db588017e56',
  actuatorLogDb: 'e681a40093c3798d',
  toStatusAck: 'a1ba5f5866ef6511',
  commandAckMqtt: '9d5e3035c3d069c4',
  statusMqtt: 'c338bc61bee49337',
  cloudUpdateDb: '78d3d38be30a8741',
  scheduleAckMqtt: 'd83e38164efbb860',
};

// Shared-context keys that carried per-request values before the fix.
const REQUEST_SCRATCH_KEY = /^(valve_cmd_|sched_|lastCommand|delete_zone_)/;

// One device queue per runtime (reset in withRuntime): what the transport accepted stays queued
// until a flush, so a cancel can prove its open unsent (W8 B-1).
const STUB_QUEUE = [];
let stubNext = 0;
const CHIRPSTACK_STUB = {
  createProvisioningClientFromEnv() {
    return {
      flushDeviceQueue: async () => { STUB_QUEUE.length = 0; return { flushed: true }; },
      getDeviceQueue: async () => STUB_QUEUE.map((item) => Object.assign({}, item)),
      enqueueDownlink: async (item) => {
        stubNext += 1;
        STUB_QUEUE.push({ id: 'isolation-q-' + stubNext, fPort: item.fPort, data: item.data, isPending: false });
        return { id: 'isolation-q-' + stubNext };
      },
    };
  },
};

function flowNode(id) {
  const node = NODES.get(id);
  if (!node) throw new Error('missing node ' + id);
  return node;
}

function cloneMessage(msg) {
  const { req, res, ...rest } = msg;
  const copy = JSON.parse(JSON.stringify(rest));
  if (req !== undefined) copy.req = req;
  if (res !== undefined) copy.res = res;
  return copy;
}

function readProperty(msg, property) {
  return String(property).split('.').reduce(
    (value, key) => (value === null || value === undefined ? undefined : value[key]),
    msg
  );
}

class FlowRuntime {
  constructor(db, { scoped = false, follow = [] } = {}) {
    this.db = db;
    this.env = {
      AUTH_TOKEN_SECRET: AUTH_SECRET,
      OSI_SCOPED_ACCESS: scoped ? '1' : '0',
      DEVICE_EUI: GATEWAY_EUI,
      CHIRPSTACK_APP_ACTUATORS: 'actuators-app',
    };
    // The manual valve chain ends at the encoder (transport, then the deferred response), so
    // the To Actuator link is always followed.
    this.follow = new Set([ID.toActuator].concat(follow));
    this.tabContext = new Map();
    this.lanes = new Map();
  }

  lane(name) {
    if (!this.lanes.has(name)) {
      this.lanes.set(name, {
        name,
        queue: [],
        responses: [],
        links: [],
        published: [],
        sql: [],
        thrown: [],
        errors: [],
        ran: [],
        failAt: new Set(),
      });
    }
    return this.lanes.get(name);
  }

  inject(name, nodeId, msg) {
    const lane = this.lane(name);
    lane.queue.push({ nodeId, msg });
    return lane;
  }

  pending(name) {
    const lane = this.lane(name);
    return lane.queue.length ? lane.queue[0].nodeId : null;
  }

  async runUntil(name, nodeId) {
    while (this.pending(name) !== null && this.pending(name) !== nodeId) await this.step(name);
    assert.equal(this.pending(name), nodeId, name + ' should be waiting at ' + nodeId);
  }

  async run(name) {
    while (this.pending(name) !== null) await this.step(name);
  }

  flowKeys() {
    const keys = [];
    for (const store of this.tabContext.values()) keys.push(...Object.keys(store));
    return keys;
  }

  send(lane, targets, msg) {
    (targets || []).forEach((target, index) => {
      lane.queue.push({ nodeId: target, msg: index === 0 ? msg : cloneMessage(msg) });
    });
  }

  route(lane, node, result) {
    if (result === null || result === undefined) return;
    const outputs = Array.isArray(result) ? result : [result];
    const wires = node.wires || [];
    for (let index = 0; index < wires.length && index < outputs.length; index += 1) {
      const out = outputs[index];
      if (out === null || out === undefined) continue;
      for (const msg of (Array.isArray(out) ? out : [out])) {
        if (msg !== null && msg !== undefined) this.send(lane, wires[index], msg);
      }
    }
  }

  raise(lane, node, msg, error) {
    lane.thrown.push({ node: node.id, message: String(error && error.message || error) });
    const caught = cloneMessage(msg);
    caught.error = {
      message: String(error && error.message || error),
      source: { id: node.id, type: node.type, name: node.name },
    };
    if (error && error.statusCode) caught.error.statusCode = error.statusCode;
    for (const handler of FLOWS) {
      if (handler.type !== 'catch' || handler.z !== node.z) continue;
      if (Array.isArray(handler.scope) && !handler.scope.includes(node.id)) continue;
      this.send(lane, handler.wires[0], cloneMessage(caught));
    }
  }

  async step(name) {
    const lane = this.lane(name);
    const { nodeId, msg } = lane.queue.shift();
    const node = flowNode(nodeId);
    switch (node.type) {
      case 'http in':
      case 'link in':
        this.send(lane, node.wires[0], msg);
        return;
      case 'function': {
        const context = this.tabContext.get(node.z) || {};
        let outcome;
        try {
          outcome = await executeFunction(node, {
            msg,
            env: this.env,
            flowState: context,
            db: this.db,
            osiLibModules: { 'osi-valve-control': valveControl },
            libOverrides: { chirpstack: CHIRPSTACK_STUB },
          });
        } catch (error) {
          this.raise(lane, node, msg, error);
          return;
        }
        this.tabContext.set(node.z, outcome.flowState);
        lane.ran.push(node.id);
        lane.errors.push(...outcome.errors.map((message) => ({ node: node.id, message })));
        this.route(lane, node, outcome.result);
        return;
      }
      case 'sqlite': {
        if (lane.failAt.has(node.id)) {
          lane.failAt.delete(node.id);
          this.raise(lane, node, msg, new Error('SQLITE_BUSY: database is locked'));
          return;
        }
        lane.sql.push({
          node: node.id,
          topic: msg.topic,
          syncAck: msg.syncAck ? JSON.parse(JSON.stringify(msg.syncAck)) : undefined,
        });
        try {
          msg.payload = this.db.prepare(msg.topic).all();
        } catch (error) {
          this.raise(lane, node, msg, error);
          return;
        }
        this.send(lane, node.wires[0], msg);
        return;
      }
      case 'link out':
        lane.links.push({ node: node.id, msg });
        if (this.follow.has(node.id)) this.send(lane, node.links, msg);
        return;
      case 'switch': {
        const value = readProperty(msg, node.property);
        let matched = false;
        node.rules.forEach((rule, index) => {
          if (matched && node.checkall !== 'true') return;
          let ok;
          if (rule.t === 'nnull') ok = value !== null && value !== undefined;
          else if (rule.t === 'else') ok = !matched;
          else throw new Error('unsupported switch rule ' + rule.t + ' in ' + node.id);
          if (ok) {
            matched = true;
            this.send(lane, node.wires[index], msg);
          }
        });
        return;
      }
      case 'http response':
        lane.responses.push({ statusCode: msg.statusCode, payload: msg.payload, res: msg.res });
        return;
      case 'mqtt out':
        lane.published.push({ node: node.id, topic: msg.topic, payload: msg.payload });
        return;
      case 'debug':
        return;
      default:
        throw new Error('unsupported node type ' + node.type + ' (' + node.id + ')');
    }
  }
}

function seedDb() {
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode)
      VALUES ('Z Three', 2, 'z-3', 'UTC', 'local');
    INSERT INTO user_zone_assignments (assignment_uuid, user_uuid, zone_uuid, created_at)
      VALUES ('g-4', 'u-res1', 'z-3', '2026-01-01');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES
      ('${VALVE_A}', 'Valve A', 'STREGA_VALVE', 2, 1, '2026-01-01', '2026-01-01'),
      ('${VALVE_B}', 'Valve B', 'STREGA_VALVE', 2, 1, '2026-01-01', '2026-01-01'),
      ('${VALVE_FOREIGN}', 'Valve C', 'STREGA_VALVE', 1, 2, '2026-01-01', '2026-01-01'),
      ('${SENSOR}', 'Sensor', 'DRAGINO_LSN50', 2, 1, '2026-01-01', '2026-01-01');
    INSERT INTO irrigation_schedules
      (irrigation_zone_id, trigger_metric, threshold_kpa, duration_minutes, enabled, response_mode, sync_version)
      VALUES (1, 'SWT_1', 30, 15, 1, 'proportional', 4);
  `);
  return db;
}

const USERS = {
  res1: { userId: 2, username: 'res1', uuid: 'u-res1' },
  admin1: { userId: 1, username: 'admin1', uuid: 'u-admin' },
};

function bearer(user) {
  return makeAuthHeader({ userId: user.userId, username: user.username, secret: AUTH_SECRET });
}

function valveMsg(lane, { user = USERS.res1, eui, action = 'OPEN_FOR_DURATION', minutes, msgid, token }) {
  const msg = {
    req: { headers: { authorization: token || bearer(user) }, params: { deveui: eui }, query: {} },
    res: { lane },
    payload: { action, duration_minutes: minutes },
  };
  if (msgid !== null) msg._msgid = msgid || 'msgid-' + lane;
  return msg;
}

function scheduleMsg(lane, { user = USERS.res1, zoneId, patch, msgid }) {
  const msg = {
    req: { headers: { authorization: bearer(user) }, params: { id: String(zoneId) }, query: {} },
    res: { lane },
    payload: patch,
  };
  if (msgid !== null) msg._msgid = msgid || 'msgid-' + lane;
  return msg;
}

async function withRuntime(options, body) {
  scopeHelper._resetForTests();
  STUB_QUEUE.length = 0;
  const db = seedDb();
  try {
    const rt = new FlowRuntime(db, options);
    await body(rt, db);
    for (const key of rt.flowKeys()) {
      assert.doesNotMatch(key, REQUEST_SCRATCH_KEY, 'per-request value left in shared flow context: ' + key);
    }
  } finally {
    db.close();
  }
}

function onlyResponse(rt, name) {
  const lane = rt.lane(name);
  assert.equal(lane.responses.length, 1, name + ' must receive exactly one HTTP response');
  assert.equal(lane.responses[0].res.lane, name, name + ' response must go to its own connection');
  return lane.responses[0];
}

function assertValveAccepted(rt, name, expected) {
  const response = onlyResponse(rt, name);
  assert.equal(response.statusCode, 202, name + ' status: ' + JSON.stringify(response.payload));
  assert.equal(response.payload.deveui, expected.eui, name + ' response target');
  assert.equal(response.payload.action, 'OPEN_FOR_DURATION', name + ' response action');
  assert.equal(response.payload.duration_minutes, expected.minutes, name + ' response duration');

  const lane = rt.lane(name);
  const commands = lane.links.filter((link) => link.node === ID.toActuator);
  assert.equal(commands.length, 1, name + ' must emit exactly one actuator command');
  const command = commands[0].msg;
  assert.equal(command.payload.device.devEui, expected.eui, name + ' downlink target');
  assert.equal(command.payload.data.action, 'OPEN_FOR_DURATION', name + ' downlink action');
  assert.equal(command.payload.data.duration_minutes, expected.minutes, name + ' downlink duration');
  assert.equal(command.payload.data.command_id, response.payload.command_id, name + ' command/response correlation');
  assert.equal(command._stregaExpectationCommand.device_eui, expected.eui, name + ' expectation target');
  assert.equal(command._stregaExpectationCommand.duration_minutes, expected.minutes, name + ' expectation duration');
  assert.equal(command._stregaExpectationCommand.command_id, response.payload.command_id, name + ' expectation correlation');
  if (expected.actorUuid) assert.equal(command._actorUserUuid, expected.actorUuid, name + ' actor');

  const writes = lane.sql.filter((entry) => entry.node === ID.valveWriteDb);
  assert.equal(writes.length, 1, name + ' must emit exactly one log/device write');
  assert.match(
    writes[0].topic,
    new RegExp("VALUES\\s*\\('" + expected.eui + "', (\\d+|NULL), 'OPEN_FOR_DURATION', " + expected.minutes + ','),
    name + ' actuator_log SQL'
  );
  assert.match(writes[0].topic, new RegExp("WHERE UPPER\\(deveui\\)=UPPER\\('" + expected.eui + "'\\)"), name + ' device update SQL');
}

function assertValveRejected(rt, name, statusCode) {
  const response = onlyResponse(rt, name);
  assert.equal(response.statusCode, statusCode, name + ' status: ' + JSON.stringify(response.payload));
  const lane = rt.lane(name);
  assert.equal(lane.links.filter((link) => link.node === ID.toActuator).length, 0, name + ' must not emit a downlink');
  assert.equal(lane.sql.filter((entry) => entry.node === ID.valveWriteDb).length, 0, name + ' must not write');
}

function actuatorLog(db) {
  return db.prepare('SELECT deveui, action, duration_minutes FROM actuator_log ORDER BY id').all()
    .map((row) => row.deveui + ':' + row.duration_minutes);
}

const VALVE_BOUNDARIES = [ID.valveUserDb, ID.valveDeviceDb, ID.valveWriteDb];

// ---------------------------------------------------------------------------
// Valve: two requests from the same user for different valves and durations.
// ---------------------------------------------------------------------------
for (const scoped of [false, true]) {
  for (const boundary of VALVE_BOUNDARIES) {
    for (const paused of ['A', 'B']) {
      const other = paused === 'A' ? 'B' : 'A';
      test(`valve open: ${paused} paused at ${boundary}, ${other} completes, ${paused} resumes (scoped ${scoped ? 'on' : 'off'})`, async () => {
        await withRuntime({ scoped }, async (rt, db) => {
          const spec = {
            A: { eui: VALVE_A, minutes: 12, actorUuid: scoped ? 'u-res1' : null },
            B: { eui: VALVE_B, minutes: 3, actorUuid: scoped ? 'u-res1' : null },
          };
          rt.inject('A', ID.valveHttp, valveMsg('A', { eui: VALVE_A, minutes: 12 }));
          rt.inject('B', ID.valveHttp, valveMsg('B', { eui: VALVE_B, minutes: 3 }));
          await rt.runUntil(paused, boundary);
          await rt.run(other);
          await rt.run(paused);
          assertValveAccepted(rt, 'A', spec.A);
          assertValveAccepted(rt, 'B', spec.B);
          assert.deepEqual(actuatorLog(db).sort(), [VALVE_A + ':12', VALVE_B + ':3'].sort());
        });
      });
    }
  }

  test(`valve open: two requests for the same valve keep their own durations (scoped ${scoped ? 'on' : 'off'})`, async () => {
    await withRuntime({ scoped }, async (rt, db) => {
      rt.inject('A', ID.valveHttp, valveMsg('A', { eui: VALVE_A, minutes: 12 }));
      rt.inject('B', ID.valveHttp, valveMsg('B', { eui: VALVE_A, minutes: 3 }));
      await rt.runUntil('A', ID.valveDeviceDb);
      await rt.run('B');
      await rt.run('A');
      // One open per valve at a time (the dispatch reservation fence): B, which reached the
      // transport first, opens for its own 3 minutes; A is refused and never borrows B's
      // duration or writes a log line. Neither request's values cross.
      assertValveAccepted(rt, 'B', { eui: VALVE_A, minutes: 3 });
      const refused = onlyResponse(rt, 'A');
      assert.equal(refused.statusCode, 503, 'A status: ' + JSON.stringify(refused.payload));
      assert.equal(refused.payload.error, 'valve_busy', 'A refused by the reservation fence');
      assert.equal(rt.lane('A').sql.filter((entry) => entry.node === ID.valveWriteDb).length, 0, 'A writes no log line');
      assert.deepEqual(actuatorLog(db), [VALVE_A + ':3'], 'only B\'s open is logged, with its own duration');
    });
  });

  // A different user tries to open the first user's valve while the owner's own
  // request is in flight. The attacker must be refused and must not borrow the
  // owner's identity; the owner must keep its own target and duration.
  for (const boundary of [ID.valveUserDb, ID.valveDeviceDb]) {
    for (const paused of ['owner', 'other']) {
      test(`valve open: foreign user against the owner's valve, ${paused} paused at ${boundary} (scoped ${scoped ? 'on' : 'off'})`, async () => {
        await withRuntime({ scoped }, async (rt) => {
          rt.inject('owner', ID.valveHttp, valveMsg('owner', { eui: VALVE_A, minutes: 12 }));
          rt.inject('other', ID.valveHttp, valveMsg('other', { user: USERS.admin1, eui: VALVE_A, minutes: 3 }));
          if (scoped && paused === 'other') {
            // Scoped access refuses the foreign user in the ingress node; it never
            // reaches a later boundary, so it runs to completion first instead.
            await rt.runUntil('owner', boundary);
            await rt.run('other');
            await rt.run('owner');
          } else {
            const resumed = paused === 'owner' ? 'other' : 'owner';
            await rt.runUntil(paused, boundary);
            await rt.run(resumed);
            await rt.run(paused);
          }
          assertValveAccepted(rt, 'owner', { eui: VALVE_A, minutes: 12 });
          assertValveRejected(rt, 'other', scoped ? 404 : 403);
        });
      });
    }
  }
}

test('valve open: two users on their own valves keep their own identity (scoped off)', async () => {
  await withRuntime({ scoped: false }, async (rt) => {
    rt.inject('A', ID.valveHttp, valveMsg('A', { eui: VALVE_A, minutes: 12 }));
    rt.inject('B', ID.valveHttp, valveMsg('B', { user: USERS.admin1, eui: VALVE_FOREIGN, minutes: 3 }));
    await rt.runUntil('A', ID.valveDeviceDb);
    await rt.runUntil('B', ID.valveDeviceDb);
    await rt.run('A');
    await rt.run('B');
    assertValveAccepted(rt, 'A', { eui: VALVE_A, minutes: 12 });
    assertValveAccepted(rt, 'B', { eui: VALVE_FOREIGN, minutes: 3 });
  });
});

// ---------------------------------------------------------------------------
// Valve: failure paths interleaved with a valid request.
// ---------------------------------------------------------------------------
for (const scoped of [false, true]) {
  const mode = scoped ? 'on' : 'off';

  test(`valve failure: unauthorized request interleaved with a valid one (scoped ${mode})`, async () => {
    await withRuntime({ scoped }, async (rt) => {
      rt.inject('B', ID.valveHttp, valveMsg('B', { eui: VALVE_B, minutes: 3 }));
      rt.inject('A', ID.valveHttp, valveMsg('A', { eui: VALVE_A, minutes: 12, token: 'Bearer e30.invalid' }));
      await rt.runUntil('B', ID.valveDeviceDb);
      await rt.run('A');
      await rt.run('B');
      assertValveRejected(rt, 'A', 401);
      assertValveAccepted(rt, 'B', { eui: VALVE_B, minutes: 3 });
    });
  });

  test(`valve failure: wrong device type interleaved with a valid one (scoped ${mode})`, async () => {
    await withRuntime({ scoped }, async (rt) => {
      rt.inject('B', ID.valveHttp, valveMsg('B', { eui: VALVE_B, minutes: 3 }));
      rt.inject('A', ID.valveHttp, valveMsg('A', { eui: SENSOR, action: 'CLOSE' }));
      await rt.runUntil('B', ID.valveDeviceDb);
      await rt.run('A');
      await rt.run('B');
      // Flag off the type check answers 409 at the final boundary; scoped access
      // refuses a non-valve device in the ingress node with its own status.
      const response = onlyResponse(rt, 'A');
      assert.ok([403, 404, 409].includes(response.statusCode), 'A status ' + response.statusCode);
      assertValveRejected(rt, 'A', response.statusCode);
      assertValveAccepted(rt, 'B', { eui: VALVE_B, minutes: 3 });
    });
  });

  test(`valve failure: unknown target interleaved with a valid one (scoped ${mode})`, async () => {
    await withRuntime({ scoped }, async (rt) => {
      rt.inject('B', ID.valveHttp, valveMsg('B', { eui: VALVE_B, minutes: 3 }));
      rt.inject('A', ID.valveHttp, valveMsg('A', { eui: UNKNOWN_EUI, minutes: 20 }));
      await rt.runUntil('B', ID.valveDeviceDb);
      await rt.run('A');
      await rt.run('B');
      assertValveRejected(rt, 'A', 404);
      assertValveAccepted(rt, 'B', { eui: VALVE_B, minutes: 3 });
    });
  });

  test(`valve failure: retry after a database error keeps the retry's own values (scoped ${mode})`, async () => {
    await withRuntime({ scoped }, async (rt) => {
      rt.lane('A').failAt.add(ID.valveDeviceDb);
      rt.inject('A', ID.valveHttp, valveMsg('A', { eui: VALVE_A, minutes: 12 }));
      rt.inject('B', ID.valveHttp, valveMsg('B', { eui: VALVE_B, minutes: 3 }));
      await rt.run('A');
      await rt.runUntil('B', ID.valveDeviceDb);
      rt.inject('A2', ID.valveHttp, valveMsg('A2', { eui: VALVE_A, minutes: 12 }));
      await rt.run('A2');
      await rt.run('B');
      assertValveRejected(rt, 'A', 500);
      assertValveAccepted(rt, 'A2', { eui: VALVE_A, minutes: 12 });
      assertValveAccepted(rt, 'B', { eui: VALVE_B, minutes: 3 });
    });
  });

  test(`valve requestId: duplicate _msgid on two requests does not cross them (scoped ${mode})`, async () => {
    await withRuntime({ scoped }, async (rt) => {
      rt.inject('A', ID.valveHttp, valveMsg('A', { eui: VALVE_A, minutes: 12, msgid: 'same-id' }));
      rt.inject('B', ID.valveHttp, valveMsg('B', { eui: VALVE_B, minutes: 3, msgid: 'same-id' }));
      await rt.runUntil('A', ID.valveDeviceDb);
      await rt.run('B');
      await rt.run('A');
      assertValveAccepted(rt, 'A', { eui: VALVE_A, minutes: 12 });
      assertValveAccepted(rt, 'B', { eui: VALVE_B, minutes: 3 });
    });
  });

  test(`valve requestId: a request without _msgid fails closed (scoped ${mode})`, async () => {
    await withRuntime({ scoped }, async (rt) => {
      rt.inject('A', ID.valveHttp, valveMsg('A', { eui: VALVE_A, minutes: 12, msgid: null }));
      await rt.run('A');
      assertValveRejected(rt, 'A', 500);
      assert.equal(rt.lane('A').sql.length, 0, 'no database step runs without a request id');
    });
  });
}

test('valve envelope: carries only approved keys and no credential material', async () => {
  await withRuntime({ scoped: true }, async (rt) => {
    const msg = valveMsg('A', { eui: VALVE_A, minutes: 12 });
    const token = msg.req.headers.authorization;
    rt.inject('A', ID.valveHttp, msg);
    await rt.runUntil('A', ID.valveDeviceDb);
    const inFlight = rt.lane('A').queue[0].msg;
    assert.ok(inFlight.osi && inFlight.osi.request, 'request envelope present on msg');
    assert.deepEqual(
      Object.keys(inFlight.osi.request).sort(),
      ['action', 'actorId', 'durationMinutes', 'kind', 'requestId', 'targetEui', 'v']
    );
    assert.deepEqual(inFlight.osi.request, {
      v: 1,
      kind: 'valve_command',
      requestId: 'msgid-A',
      actorId: 2,
      targetEui: VALVE_A,
      action: 'OPEN_FOR_DURATION',
      durationMinutes: 12,
    });
    const serialized = JSON.stringify(inFlight.osi);
    assert.doesNotMatch(serialized, /bearer|token|password|secret|authorization/i);
    assert.ok(!serialized.includes(token.slice(7)), 'bearer token must not enter the envelope');
  });
});

// Cancel is a single message-local node; this pins that a cancel on one valve,
// interleaved with an open on another, neither moves nor is moved by the open.
test('valve open and cancel interleaved on different valves', async () => {
  await withRuntime({ scoped: false, follow: [ID.toActuator] }, async (rt, db) => {
    rt.inject('B', ID.valveHttp, valveMsg('B', { eui: VALVE_B, minutes: 3 }));
    await rt.run('B');
    rt.inject('A', ID.valveHttp, valveMsg('A', { eui: VALVE_A, minutes: 12 }));
    await rt.runUntil('A', ID.valveDeviceDb);
    rt.inject('cancel', ID.cancelHttp, {
      _msgid: 'msgid-cancel',
      req: { headers: { authorization: bearer(USERS.res1) }, params: { deveui: VALVE_B }, query: {} },
      res: { lane: 'cancel' },
      payload: {},
    });
    await rt.run('cancel');
    await rt.run('A');
    assertValveAccepted(rt, 'A', { eui: VALVE_A, minutes: 12 });
    const cancel = onlyResponse(rt, 'cancel');
    // Owner decision 2026-10-24 (fail closed): B's open was handed to ChirpStack, so the cancel
    // flushes B's queue and answers handed_off; it must still answer for valve B only.
    assert.equal(cancel.statusCode, 409, JSON.stringify(cancel.payload));
    assert.equal(cancel.payload.outcome, 'handed_off');
    const bRow = db.prepare('SELECT expectation_id FROM valve_actuation_expectations WHERE device_eui=?').get(VALVE_B);
    assert.equal(String(cancel.payload.expectation_id), String(bRow.expectation_id), 'the cancel answers for valve B');
    const states = db.prepare(
      'SELECT device_eui, reconciliation_state FROM valve_actuation_expectations ORDER BY created_at, rowid'
    ).all().map((row) => row.device_eui + ':' + row.reconciliation_state);
    assert.ok(states.includes(VALVE_B + ':PENDING_OBSERVATION'), 'valve B expectation stays observed: ' + states);
    assert.ok(states.some((state) => state.startsWith(VALVE_A + ':') && !state.endsWith('CANCELLED')),
      'valve A expectation untouched: ' + states);
  });
});

// ---------------------------------------------------------------------------
// STREGA status ACK: a local (manual) open must not acknowledge a cloud command.
// ---------------------------------------------------------------------------
function cloudOpen(commandId, eui, minutes) {
  return {
    payload: {
      commandType: 'OPEN_FOR_DURATION',
      commandId,
      deviceEui: eui,
      durationMinutes: minutes,
      eventUuid: '00000000-0000-4000-8000-0000000000' + String(commandId).padStart(2, '0').slice(-2),
      aggregateType: 'DEVICE',
      aggregateKey: eui,
      appliedSyncVersion: 9,
      gatewayDeviceEui: GATEWAY_EUI,
    },
  };
}

function commandAcks(rt, name) {
  return rt.lane(name).published
    .filter((entry) => entry.node === ID.commandAckMqtt)
    .map((entry) => JSON.parse(entry.payload));
}

for (const order of ['cloud first', 'cloud paused']) {
  test(`STREGA ACK: manual open next to a cloud open (${order})`, async () => {
    const follow = [ID.toActuator, ID.routeToActuator, ID.toStatusAck];
    await withRuntime({ scoped: false, follow }, async (rt) => {
      rt.inject('cloud', ID.routeCommand, cloudOpen(501, VALVE_B, 5));
      rt.inject('manual', ID.valveHttp, valveMsg('manual', { eui: VALVE_A, minutes: 12 }));
      if (order === 'cloud first') {
        await rt.run('cloud');
        await rt.run('manual');
      } else {
        await rt.runUntil('cloud', ID.actuatorLogDb);
        await rt.run('manual');
        await rt.run('cloud');
      }
      assertValveAccepted(rt, 'manual', { eui: VALVE_A, minutes: 12 });
      const manualAcks = commandAcks(rt, 'manual');
      assert.deepEqual(
        manualAcks.filter((ack) => String(ack.commandId) === '501'),
        [],
        'a manual open must not acknowledge cloud command 501: ' + JSON.stringify(manualAcks)
      );
      const status = rt.lane('manual').published.filter((entry) => entry.node === ID.statusMqtt);
      assert.equal(status.length, 1, 'manual open still reports valve status');
      assert.equal(JSON.parse(status[0].payload).deviceEui, VALVE_A);

      const cloudAcks = commandAcks(rt, 'cloud');
      assert.equal(cloudAcks.length, 1, 'cloud open acknowledged once: ' + JSON.stringify(cloudAcks));
      assert.equal(String(cloudAcks[0].commandId), '501');
    });
  });
}

// Generic cloud ACK (Build Schedule ACK): a command routed without its own id must
// not borrow the id of another command routed after it.
test('cloud command ACK: a command without commandId does not borrow a later command id', async () => {
  await withRuntime({ scoped: false }, async (rt) => {
    const zone = (uuid, name, commandId) => ({
      payload: Object.assign({
        commandType: 'UPSERT_ZONE',
        zoneUuid: uuid,
        name,
        appliedSyncVersion: 7,
        aggregateType: 'ZONE',
        aggregateKey: uuid,
      }, commandId === undefined ? {} : { commandId }),
    });
    rt.inject('A', ID.routeCommand, zone('z-cloud-a', 'Cloud A'));
    rt.inject('B', ID.routeCommand, zone('z-cloud-b', 'Cloud B', 77));
    await rt.runUntil('A', ID.cloudUpdateDb);
    await rt.run('B');
    await rt.run('A');
    const ack = (name) => rt.lane(name).published
      .filter((entry) => entry.node === ID.scheduleAckMqtt)
      .map((entry) => JSON.parse(entry.payload));
    assert.equal(ack('B').length, 1);
    assert.equal(ack('B')[0].commandId, 77);
    assert.equal(ack('A').length, 1);
    assert.equal(ack('A')[0].commandId, null, 'A must not carry B\'s command id');
    assert.equal(ack('A')[0].aggregateKey, 'z-cloud-a');
  });
});

// ---------------------------------------------------------------------------
// Zone schedule PUT: two requests from the same user for different zones.
// ---------------------------------------------------------------------------
const SCHEDULE = {
  // Zone 1 already has a schedule at sync_version 4 (update); zone 3 has none (create).
  A: { zoneId: 1, zoneUuid: 'z-1', version: 5, patch: { trigger_metric: 'SWT_WM1', threshold_kpa: 40, duration_minutes: 12, response_mode: 'fixed', enabled: true } },
  B: { zoneId: 3, zoneUuid: 'z-3', version: 1, patch: { trigger_metric: 'SWT_2', threshold_kpa: 65, duration_minutes: 3, response_mode: 'aggressive', enabled: false } },
};

function assertScheduleApplied(rt, db, name, expected) {
  const response = onlyResponse(rt, name);
  assert.equal(response.statusCode, 200, name + ' status: ' + JSON.stringify(response.payload));
  const patch = expected.patch;
  assert.deepEqual(response.payload, {
    irrigation_zone_id: expected.zoneId,
    zone_uuid: expected.zoneUuid,
    gateway_device_eui: GATEWAY_EUI,
    trigger_metric: patch.trigger_metric,
    threshold_kpa: patch.threshold_kpa,
    duration_minutes: patch.duration_minutes,
    enabled: patch.enabled,
    response_mode: patch.response_mode,
    sync_version: expected.version,
    deleted_at: null,
    last_applied_at: null,
  }, name + ' response');

  // The write runs once, inside the lifecycle service, for this request only. The SQL text and
  // msg.syncAck are not visible any more; the response's sync_version (above) and the stored row
  // (below) are the evidence instead.
  assert.equal(rt.lane(name).ran.filter((id) => id === ID.schedWrite).length, 1, name + ' must run exactly one schedule write');
  assert.equal(rt.lane(name).sql.filter((entry) => entry.node === ID.schedSaveDb).length, 0, name + ' the retired Save to DB node is not used');

  const row = db.prepare(
    'SELECT trigger_metric, threshold_kpa, duration_minutes, enabled, response_mode, sync_version FROM irrigation_schedules WHERE irrigation_zone_id = ?'
  ).get(expected.zoneId);
  assert.deepEqual({ ...row }, {
    trigger_metric: patch.trigger_metric,
    threshold_kpa: patch.threshold_kpa,
    duration_minutes: patch.duration_minutes,
    enabled: patch.enabled ? 1 : 0,
    response_mode: patch.response_mode,
    sync_version: expected.version,
  }, name + ' stored schedule');
}

function assertScheduleRejected(rt, name, statusCode) {
  const response = onlyResponse(rt, name);
  assert.equal(response.statusCode, statusCode, name + ' status: ' + JSON.stringify(response.payload));
  assert.equal(rt.lane(name).sql.filter((entry) => entry.node === ID.schedSaveDb).length, 0, name + ' must not write');
}

const SCHEDULE_BOUNDARIES = [ID.schedUserDb, ID.schedZoneDb, ID.schedWrite];

for (const scoped of [false, true]) {
  const mode = scoped ? 'on' : 'off';
  for (const boundary of SCHEDULE_BOUNDARIES) {
    for (const paused of ['A', 'B']) {
      const other = paused === 'A' ? 'B' : 'A';
      test(`schedule PUT: ${paused} paused at ${boundary}, ${other} completes, ${paused} resumes (scoped ${mode})`, async () => {
        await withRuntime({ scoped }, async (rt, db) => {
          rt.inject('A', ID.schedHttp, scheduleMsg('A', SCHEDULE.A));
          rt.inject('B', ID.schedHttp, scheduleMsg('B', SCHEDULE.B));
          await rt.runUntil(paused, boundary);
          await rt.run(other);
          await rt.run(paused);
          assertScheduleApplied(rt, db, 'A', SCHEDULE.A);
          assertScheduleApplied(rt, db, 'B', SCHEDULE.B);
        });
      });
    }
  }

  // A different user's refused request must not leave its patch for the owner's write.
  for (const boundary of [ID.schedZoneDb, ID.schedWrite]) {
    test(`schedule PUT: foreign user against the owner's zone while the owner waits at ${boundary} (scoped ${mode})`, async () => {
      await withRuntime({ scoped }, async (rt, db) => {
        rt.inject('owner', ID.schedHttp, scheduleMsg('owner', SCHEDULE.A));
        rt.inject('other', ID.schedHttp, scheduleMsg('other', {
          user: USERS.admin1,
          zoneId: 1,
          patch: { trigger_metric: 'SWT_3', threshold_kpa: 5, duration_minutes: 240, response_mode: 'aggressive', enabled: true },
        }));
        await rt.runUntil('owner', boundary);
        await rt.run('other');
        await rt.run('owner');
        assertScheduleApplied(rt, db, 'owner', SCHEDULE.A);
        assertScheduleRejected(rt, 'other', 404);
      });
    });
  }

  test(`schedule PUT: invalid patch interleaved with a valid one (scoped ${mode})`, async () => {
    await withRuntime({ scoped }, async (rt, db) => {
      rt.inject('A', ID.schedHttp, scheduleMsg('A', SCHEDULE.A));
      rt.inject('B', ID.schedHttp, scheduleMsg('B', {
        zoneId: 3,
        patch: { trigger_metric: 'NOT_A_METRIC', threshold_kpa: 65 },
      }));
      await rt.runUntil('A', ID.schedZoneDb);
      await rt.run('B');
      await rt.run('A');
      assertScheduleApplied(rt, db, 'A', SCHEDULE.A);
      assertScheduleRejected(rt, 'B', 400);
    });
  });

  test(`schedule PUT: duplicate _msgid on two requests does not cross them (scoped ${mode})`, async () => {
    await withRuntime({ scoped }, async (rt, db) => {
      rt.inject('A', ID.schedHttp, scheduleMsg('A', { ...SCHEDULE.A, msgid: 'same-id' }));
      rt.inject('B', ID.schedHttp, scheduleMsg('B', { ...SCHEDULE.B, msgid: 'same-id' }));
      await rt.runUntil('A', ID.schedZoneDb);
      await rt.run('B');
      await rt.run('A');
      assertScheduleApplied(rt, db, 'A', SCHEDULE.A);
      assertScheduleApplied(rt, db, 'B', SCHEDULE.B);
    });
  });

  test(`schedule PUT: retry after a database error keeps the retry's own values (scoped ${mode})`, async () => {
    await withRuntime({ scoped }, async (rt, db) => {
      rt.lane('A').failAt.add(ID.schedZoneDb);
      rt.inject('A', ID.schedHttp, scheduleMsg('A', SCHEDULE.A));
      rt.inject('B', ID.schedHttp, scheduleMsg('B', SCHEDULE.B));
      await rt.run('A');
      await rt.runUntil('B', ID.schedWrite);
      rt.inject('A2', ID.schedHttp, scheduleMsg('A2', SCHEDULE.A));
      await rt.run('A2');
      await rt.run('B');
      assertScheduleRejected(rt, 'A', 500);
      assertScheduleApplied(rt, db, 'A2', SCHEDULE.A);
      assertScheduleApplied(rt, db, 'B', SCHEDULE.B);
    });
  });

  test(`schedule PUT: a request without _msgid fails closed (scoped ${mode})`, async () => {
    await withRuntime({ scoped }, async (rt) => {
      rt.inject('A', ID.schedHttp, scheduleMsg('A', { ...SCHEDULE.A, msgid: null }));
      await rt.run('A');
      assertScheduleRejected(rt, 'A', 500);
      assert.equal(rt.lane('A').sql.filter((entry) => entry.node === ID.schedZoneDb).length, 0,
        'no zone lookup runs without a request id');
    });
  });
}

test('schedule envelope: carries only approved keys and no credential material', async () => {
  await withRuntime({ scoped: true }, async (rt) => {
    const msg = scheduleMsg('A', SCHEDULE.A);
    const token = msg.req.headers.authorization;
    rt.inject('A', ID.schedHttp, msg);
    await rt.runUntil('A', ID.schedZoneDb);
    const inFlight = rt.lane('A').queue[0].msg;
    assert.ok(inFlight.osi && inFlight.osi.request, 'request envelope present on msg');
    assert.deepEqual(inFlight.osi.request, {
      v: 1,
      kind: 'zone_schedule_put',
      requestId: 'msgid-A',
      actorId: 2,
      zoneId: 1,
      validatedPatch: {
        trigger_metric: 'SWT_WM1',
        threshold_kpa: 40,
        duration_minutes: 12,
        enabled: 1,
        response_mode: 'fixed',
      },
    });
    const serialized = JSON.stringify(inFlight.osi);
    assert.doesNotMatch(serialized, /bearer|token|password|secret|authorization/i);
    assert.ok(!serialized.includes(token.slice(7)), 'bearer token must not enter the envelope');
  });
});

// ---------------------------------------------------------------------------
// Zone DELETE (flag off): DELETE /api/irrigation-zones/:id
//   Decode Token -> Lookup User -> Verify Zone Ownership -> Verify Zone ->
//   Unassign Devices -> (sqlite) -> (Soft) Delete Zone -> (sqlite) ->
//   Disable Schedule -> (sqlite) -> Format Response (+ outbox flush ping).
// The chain kept the zone id, the actor and the next zone sync_version in shared
// flow context (delete_zone_*), so a request resumed after another one deleted
// and disabled the other request's zone instead of its own.
// ---------------------------------------------------------------------------
// On this branch DELETE /api/irrigation-zones/:id is answered by the lifecycle service in the
// 'Scoped Zone Delete' node in both access modes (routes.scopedZoneDelete: auth, ownership, the
// unassign/soft-delete/disable writes and the ZONE_DELETED event in one message-local call). The
// legacy chain after it (Decode Token ... Format Response) is no longer reached from HTTP; its
// nodes still carry the zone_delete envelope and are exercised directly below (fail-closed,
// envelope), so the static guard verify-request-context-isolation keeps meaning something.
const ZD = {
  http: 'delete-zone-http',
  router: 'scoped-zone-delete-router',
  auth: 'delete-zone-auth',
  userDb: 'delete-zone-lookup',
  verify: 'delete-zone-verify',
  zoneDb: 'delete-zone-verify-db',
  unassign: 'delete-zone-unassign',
  unassignDb: 'delete-zone-unassign-db',
  softDelete: 'delete-zone-delete',
  deleteDb: 'delete-zone-delete-db',
  disable: '8180476b6ab55d6e',
  disableDb: 'd6136c769242ca50',
  flushLink: 'sync-outbox-flush-link-out-zone',
};
const ZD_WRITES = [ZD.unassignDb, ZD.deleteDb, ZD.disableDb];
const ZONE3_SENSOR = 'A840410000000005';

// Zone 1 (res1) and zone 3 (res1) and zone 2 (admin1) each have devices and an
// enabled schedule; the gateway is cloud-linked so the outbox triggers fire.
function seedZoneDelete(db) {
  db.exec(`
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
      VALUES ('${ZONE3_SENSOR}', 'Sensor Z3', 'DRAGINO_LSN50', 2, 3, '2026-01-01', '2026-01-01');
    INSERT INTO irrigation_schedules
      (irrigation_zone_id, trigger_metric, threshold_kpa, duration_minutes, enabled, response_mode, sync_version)
      VALUES (2, 'SWT_2', 50, 10, 1, 'fixed', 2), (3, 'SWT_3', 70, 8, 1, 'aggressive', 6);
    INSERT INTO sync_link_state (peer_node, linked, gateway_device_eui, updated_at)
      VALUES ('cloud', 1, '${GATEWAY_EUI}', '2026-01-01');
  `);
}

const ZONE_DELETE = {
  A: { user: USERS.res1, zoneId: 1, zoneUuid: 'z-1' },
  B: { user: USERS.admin1, zoneId: 2, zoneUuid: 'z-2' },
  A3: { user: USERS.res1, zoneId: 3, zoneUuid: 'z-3' },
};

function zoneDeleteMsg(lane, { user = USERS.res1, zoneId, msgid, token }) {
  const msg = {
    req: { headers: { authorization: token || bearer(user) }, params: { id: String(zoneId) }, query: {} },
    res: { lane },
    payload: {},
  };
  if (msgid !== null) msg._msgid = msgid || 'msgid-' + lane;
  return msg;
}

function plain(rows) {
  return rows.map((row) => ({ ...row }));
}

function zoneState(db) {
  return {
    zones: plain(db.prepare(
      'SELECT id, zone_uuid, deleted_at IS NOT NULL AS deleted, sync_version FROM irrigation_zones ORDER BY id'
    ).all()),
    devices: plain(db.prepare(
      'SELECT deveui, irrigation_zone_id, sync_version FROM devices ORDER BY deveui'
    ).all()),
    schedules: plain(db.prepare(
      'SELECT irrigation_zone_id, trigger_metric, threshold_kpa, duration_minutes, enabled, response_mode, sync_version, deleted_at IS NOT NULL AS deleted FROM irrigation_schedules ORDER BY irrigation_zone_id'
    ).all()),
    outbox: plain(db.prepare(
      'SELECT aggregate_type, aggregate_key, op, sync_version FROM sync_outbox ORDER BY rowid'
    ).all()),
  };
}

function sortedOutbox(state) {
  return state.outbox.map((row) => JSON.stringify(row)).sort();
}

// The effect of running the same requests one after another, without interleaving,
// on a fresh database: the oracle every interleaving must reproduce.
async function serialZoneState(requests) {
  scopeHelper._resetForTests();
  const db = seedDb();
  try {
    seedZoneDelete(db);
    const rt = new FlowRuntime(db, { scoped: false });
    for (const [lane, nodeId, msg] of requests) {
      rt.inject(lane, nodeId, msg);
      await rt.run(lane);
    }
    return zoneState(db);
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
}

function lanesSql(rt, name, nodeId) {
  return rt.lane(name).sql.filter((entry) => entry.node === nodeId).map((entry) => entry.topic);
}

function assertZoneDeleted(rt, db, name, spec, before) {
  const response = onlyResponse(rt, name);
  assert.equal(response.statusCode, 200, name + ' status: ' + JSON.stringify(response.payload));
  assert.equal(response.payload.message, 'Zone removed successfully', name + ' response');
  assert.equal(response.payload.zone_uuid, spec.zoneUuid, name + ' response names its own zone');
  assert.equal(rt.lane(name).links.filter((link) => link.node === ZD.flushLink).length, 1, name + ' outbox flush ping');
  // The writes run inside the lifecycle service, once, for this request: the router ran once and
  // the retired legacy write nodes were not reached. The database state below is the evidence.
  assert.equal(rt.lane(name).ran.filter((id) => id === ZD.router).length, 1, name + ' one lifecycle delete');
  for (const nodeId of ZD_WRITES) assert.equal(lanesSql(rt, name, nodeId).length, 0, name + ' legacy write node ' + nodeId + ' unused');
  const beforeZone = before.zones.find((zone) => zone.id === spec.zoneId);

  const after = zoneState(db);
  const zone = after.zones.find((row) => row.id === spec.zoneId);
  assert.equal(zone.deleted, 1, name + ' zone ' + spec.zoneId + ' soft-deleted');
  assert.equal(zone.sync_version, beforeZone.sync_version + 1, name + ' zone sync_version');
  assert.deepEqual(after.devices.filter((device) => device.irrigation_zone_id === spec.zoneId), [],
    name + ' devices of zone ' + spec.zoneId + ' unassigned');
  const schedule = after.schedules.find((row) => row.irrigation_zone_id === spec.zoneId);
  assert.equal(schedule.enabled, 0, name + ' schedule of zone ' + spec.zoneId + ' disabled');
  assert.equal(
    after.outbox.filter((row) => row.aggregate_type === 'ZONE' && row.aggregate_key === spec.zoneUuid && row.op === 'ZONE_DELETED').length,
    1,
    name + ' one ZONE_DELETED event for ' + spec.zoneUuid
  );
}

function assertZoneUntouched(db, zoneId, before, label) {
  const after = zoneState(db);
  const pick = (state) => ({
    zone: state.zones.find((row) => row.id === zoneId),
    devices: state.devices.filter((row) => row.irrigation_zone_id === zoneId),
    schedule: state.schedules.find((row) => row.irrigation_zone_id === zoneId),
  });
  assert.deepEqual(pick(after), pick(before), label + ': zone ' + zoneId + ' untouched');
}

function assertZoneDeleteRejected(rt, name, statusCode) {
  const response = onlyResponse(rt, name);
  assert.equal(response.statusCode, statusCode, name + ' status: ' + JSON.stringify(response.payload));
  for (const nodeId of ZD_WRITES) {
    assert.equal(lanesSql(rt, name, nodeId).length, 0, name + ' must not write at ' + nodeId);
  }
  // The router's single answer output is wired to the response and to the coalesced outbox flush,
  // so a refused delete pings the flush too; with no event written that ping sends nothing. The
  // callers assert the database is untouched.
}

async function withZoneDeleteRuntime(body) {
  await withRuntime({ scoped: false }, async (rt, db) => {
    seedZoneDelete(db);
    await body(rt, db, zoneState(db));
  });
}

// The lifecycle delete is one message-local async call, so the only boundary between two zone
// deletes is before the router runs (the legacy chain's sqlite boundaries are not reached).
const ZONE_DELETE_BOUNDARIES = [ZD.router];

for (const boundary of ZONE_DELETE_BOUNDARIES) {
  for (const paused of ['A', 'B']) {
    const other = paused === 'A' ? 'B' : 'A';
    test(`zone delete: two users, ${paused} paused at ${boundary}, ${other} completes, ${paused} resumes`, async () => {
      const expected = await serialZoneState([
        ['A', ZD.http, zoneDeleteMsg('A', ZONE_DELETE.A)],
        ['B', ZD.http, zoneDeleteMsg('B', ZONE_DELETE.B)],
      ]);
      await withZoneDeleteRuntime(async (rt, db, before) => {
        rt.inject('A', ZD.http, zoneDeleteMsg('A', ZONE_DELETE.A));
        rt.inject('B', ZD.http, zoneDeleteMsg('B', ZONE_DELETE.B));
        await rt.runUntil(paused, boundary);
        await rt.run(other);
        await rt.run(paused);
        assertZoneDeleted(rt, db, 'A', ZONE_DELETE.A, before);
        assertZoneDeleted(rt, db, 'B', ZONE_DELETE.B, before);
        assertZoneUntouched(db, 3, before, 'zone 3');
        const after = zoneState(db);
        assert.deepEqual({ ...after, outbox: sortedOutbox(after) }, { ...expected, outbox: sortedOutbox(expected) },
          'interleaved result equals the serial result');
      });
    });
  }
}

for (const boundary of [ZD.router]) {
  test(`zone delete: same user, two zones, A paused at ${boundary}`, async () => {
    await withZoneDeleteRuntime(async (rt, db, before) => {
      rt.inject('A', ZD.http, zoneDeleteMsg('A', ZONE_DELETE.A));
      rt.inject('A3', ZD.http, zoneDeleteMsg('A3', ZONE_DELETE.A3));
      await rt.runUntil('A', boundary);
      await rt.run('A3');
      await rt.run('A');
      assertZoneDeleted(rt, db, 'A', ZONE_DELETE.A, before);
      assertZoneDeleted(rt, db, 'A3', ZONE_DELETE.A3, before);
      assertZoneUntouched(db, 2, before, 'zone 2');
    });
  });
}

// A zone delete interleaved with a schedule PUT on another zone: the delete disables
// only its own zone's schedule, and the PUT writes only its own zone's schedule.
const SCHEDULE_Z3 = {
  zoneId: 3,
  zoneUuid: 'z-3',
  version: 7,
  patch: { trigger_metric: 'SWT_1', threshold_kpa: 35, duration_minutes: 9, response_mode: 'fixed', enabled: true },
};
const DELETE_VS_SCHEDULE = [
  ['delete', ZD.router],
  ['schedule', ID.schedZoneDb],
  ['schedule', ID.schedWrite],
];
for (const [paused, boundary] of DELETE_VS_SCHEDULE) {
  const other = paused === 'delete' ? 'schedule' : 'delete';
  test(`zone delete vs schedule PUT on another zone: ${paused} paused at ${boundary}`, async () => {
    await withZoneDeleteRuntime(async (rt, db, before) => {
      rt.inject('delete', ZD.http, zoneDeleteMsg('delete', ZONE_DELETE.A));
      rt.inject('schedule', ID.schedHttp, scheduleMsg('schedule', SCHEDULE_Z3));
      await rt.runUntil(paused, boundary);
      await rt.run(other);
      await rt.run(paused);
      assertZoneDeleted(rt, db, 'delete', ZONE_DELETE.A, before);
      assertScheduleApplied(rt, db, 'schedule', SCHEDULE_Z3);
      const zone3 = zoneState(db).zones.find((row) => row.id === 3);
      assert.equal(zone3.deleted, 0, 'zone 3 not deleted');
      assertZoneUntouched(db, 2, before, 'zone 2');
    });
  });
}

// A request refused at the ownership check (another user's zone) interleaved with
// the owner's own delete: the refused one writes nothing, the owner's completes.
for (const boundary of [ZD.router]) {
  test(`zone delete: foreign user refused while the owner waits at ${boundary}`, async () => {
    await withZoneDeleteRuntime(async (rt, db, before) => {
      rt.inject('owner', ZD.http, zoneDeleteMsg('owner', ZONE_DELETE.A3));
      rt.inject('other', ZD.http, zoneDeleteMsg('other', { user: USERS.admin1, zoneId: 1 }));
      await rt.runUntil('owner', boundary);
      await rt.run('other');
      await rt.run('owner');
      assertZoneDeleteRejected(rt, 'other', 404);
      assertZoneDeleted(rt, db, 'owner', ZONE_DELETE.A3, before);
      assertZoneUntouched(db, 1, before, 'zone 1');
      assertZoneUntouched(db, 2, before, 'zone 2');
    });
  });
}

test('zone delete: foreign user paused after its ownership check, owner completes first', async () => {
  await withZoneDeleteRuntime(async (rt, db, before) => {
    rt.inject('owner', ZD.http, zoneDeleteMsg('owner', ZONE_DELETE.A3));
    rt.inject('other', ZD.http, zoneDeleteMsg('other', { user: USERS.admin1, zoneId: 1 }));
    await rt.runUntil('other', ZD.router);
    await rt.run('owner');
    await rt.run('other');
    assertZoneDeleteRejected(rt, 'other', 404);
    assertZoneDeleted(rt, db, 'owner', ZONE_DELETE.A3, before);
    assertZoneUntouched(db, 1, before, 'zone 1');
  });
});

test('zone delete: invalid token interleaved with a valid delete', async () => {
  await withZoneDeleteRuntime(async (rt, db, before) => {
    rt.inject('A', ZD.http, zoneDeleteMsg('A', ZONE_DELETE.A));
    rt.inject('bad', ZD.http, zoneDeleteMsg('bad', { zoneId: 3, token: 'Bearer e30.invalid' }));
    await rt.runUntil('A', ZD.router);
    await rt.run('bad');
    await rt.run('A');
    assertZoneDeleteRejected(rt, 'bad', 401);
    assertZoneDeleted(rt, db, 'A', ZONE_DELETE.A, before);
    assertZoneUntouched(db, 3, before, 'zone 3');
  });
});

// Fail closed: a message that reaches a later chain node without its own request
// envelope (or with one naming another zone) answers 500 through the tab's catch
// and writes nothing. Not reachable from the HTTP entry; pins the defensive branch.
function zoneRow(zoneId) {
  return { id: zoneId, zone_uuid: 'z-' + zoneId, gateway_device_eui: null, sync_version: 1 };
}

function zoneDeleteEnvelope(zoneId, actorId, extra) {
  return Object.assign({ request: { v: 1, kind: 'zone_delete', requestId: 'msgid-X', actorId, zoneId } }, extra || {});
}

const FAIL_CLOSED = [
  ['Unassign Devices without envelope', ZD.unassign, () => ({ payload: [zoneRow(1)] })],
  ['Unassign Devices with an envelope for another zone', ZD.unassign,
    () => ({ payload: [zoneRow(1)], osi: zoneDeleteEnvelope(3, 2) })],
  ['(Soft) Delete Zone without envelope', ZD.softDelete, () => ({ payload: [] })],
  ['(Soft) Delete Zone without applied values', ZD.softDelete, () => ({ payload: [], osi: zoneDeleteEnvelope(1, 2) })],
  ['Disable Schedule without envelope', ZD.disable,
    () => ({ payload: [], topic: "UPDATE irrigation_zones SET deleted_at = '2026-01-02' WHERE id = 1 AND deleted_at IS NULL" })],
];
for (const [label, nodeId, build] of FAIL_CLOSED) {
  test(`zone delete fail-closed: ${label}`, async () => {
    await withZoneDeleteRuntime(async (rt, db, before) => {
      const msg = Object.assign({
        _msgid: 'msgid-X',
        req: { headers: { authorization: bearer(USERS.res1) }, params: { id: '1' }, query: {} },
        res: { lane: 'X' },
      }, build());
      rt.inject('X', nodeId, msg);
      await rt.run('X');
      assertZoneDeleteRejected(rt, 'X', 500);
      assert.deepEqual(rt.lane('X').thrown.map((entry) => entry.node), [nodeId], 'fails at ' + nodeId);
      assert.match(rt.lane('X').thrown[0].message, /^zone delete request context (missing|mismatch)$/);
      assert.deepEqual(zoneState(db), before, 'no database change');
    });
  });
}

// The request id only names the envelope the legacy chain carries across its sqlite nodes. On
// that chain a request without _msgid still fails closed before any zone lookup; the lifecycle
// router keeps everything in one message-local call, so it needs no id (and withRuntime still
// proves no per-request value lands in shared flow context).
test('zone delete fail-closed: a request without _msgid', async () => {
  await withZoneDeleteRuntime(async (rt, db, before) => {
    rt.inject('A', ZD.auth, zoneDeleteMsg('A', { ...ZONE_DELETE.A, msgid: null }));
    await rt.run('A');
    assertZoneDeleteRejected(rt, 'A', 500);
    assert.equal(lanesSql(rt, 'A', ZD.zoneDb).length, 0, 'no zone lookup runs without a request id');
    assert.deepEqual(zoneState(db), before, 'no database change');
  });
});

test('zone delete envelope: carries only approved keys and no credential material', async () => {
  await withZoneDeleteRuntime(async (rt) => {
    const msg = zoneDeleteMsg('A', ZONE_DELETE.A);
    const token = msg.req.headers.authorization;
    rt.inject('A', ZD.auth, msg); // the legacy chain, which carries the envelope
    await rt.runUntil('A', ZD.zoneDb);
    const inFlight = rt.lane('A').queue[0].msg;
    assert.ok(inFlight.osi && inFlight.osi.request, 'request envelope present on msg');
    assert.deepEqual(inFlight.osi.request, { v: 1, kind: 'zone_delete', requestId: 'msgid-A', actorId: 2, zoneId: 1 });
    // The next sync_version is computed inside the lifecycle service now (no osi.applied on msg).
    const serialized = JSON.stringify(inFlight.osi);
    assert.doesNotMatch(serialized, /bearer|token|password|secret|authorization/i);
    assert.ok(!serialized.includes(token.slice(7)), 'bearer token must not enter the envelope');
  });
});
