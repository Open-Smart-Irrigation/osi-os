#!/usr/bin/env node
'use strict';

// Request isolation for the valve and zone-schedule mutation chains (osi-os #377).
//
// Concurrent HTTP requests interleave at every asynchronous boundary of a Node-RED
// chain (each sqlite node). The manual valve chain used to keep its target, action
// and duration in shared flow context (valve_cmd_*), the zone-schedule chain kept its
// validated patch there (sched_*), and the STREGA status ACK fell back to the last
// routed cloud command id (lastCommandId). A request resumed after another request
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
const valveControl = require(path.join(MODULES, 'osi-valve-control'));

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
  valveWriteDb: '01c763e52594b6ae',
  toActuator: '1ef83e7d26a33d6c',
  cancelHttp: 'cancel-valve-local-http-in',
  schedHttp: 'e970d93ded4679af',
  schedUserDb: '697f8cfd92ccf539',
  schedVerify: '22cc64fa2a899cea',
  schedZoneDb: 'bda5f35469bb5fc6',
  schedSaveDb: '899ec5378779ad86',
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
const REQUEST_SCRATCH_KEY = /^(valve_cmd_|sched_|lastCommand)/;

const CHIRPSTACK_STUB = {
  createProvisioningClientFromEnv() {
    return { flushDeviceQueue: async () => ({ flushed: true }) };
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
    this.follow = new Set(follow);
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
    new RegExp("VALUES\\s*\\('" + expected.eui + "', 'OPEN_FOR_DURATION', " + expected.minutes + ','),
    name + ' actuator_log SQL'
  );
  assert.match(writes[0].topic, new RegExp("WHERE deveui = '" + expected.eui + "'"), name + ' device update SQL');
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
    await withRuntime({ scoped }, async (rt) => {
      rt.inject('A', ID.valveHttp, valveMsg('A', { eui: VALVE_A, minutes: 12 }));
      rt.inject('B', ID.valveHttp, valveMsg('B', { eui: VALVE_A, minutes: 3 }));
      await rt.runUntil('A', ID.valveDeviceDb);
      await rt.run('B');
      await rt.run('A');
      assertValveAccepted(rt, 'A', { eui: VALVE_A, minutes: 12 });
      assertValveAccepted(rt, 'B', { eui: VALVE_A, minutes: 3 });
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
    assert.equal(cancel.statusCode, 200, JSON.stringify(cancel.payload));
    assert.equal(cancel.payload.deveui, VALVE_B);
    const states = db.prepare(
      'SELECT device_eui, reconciliation_state FROM valve_actuation_expectations ORDER BY created_at, rowid'
    ).all().map((row) => row.device_eui + ':' + row.reconciliation_state);
    assert.ok(states.includes(VALVE_B + ':CANCELLED'), 'valve B expectation cancelled: ' + states);
    assert.ok(states.some((state) => state.startsWith(VALVE_A + ':') && !state.endsWith('CANCELLED')),
      'valve A expectation untouched: ' + states);
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

  const saves = rt.lane(name).sql.filter((entry) => entry.node === ID.schedSaveDb);
  assert.equal(saves.length, 1, name + ' must emit exactly one schedule write');
  assert.match(
    saves[0].topic,
    new RegExp('\\(' + expected.zoneId + ", '" + patch.trigger_metric + "', " + patch.threshold_kpa + ', ' +
      patch.duration_minutes + ', ' + (patch.enabled ? 1 : 0) + ", '" + patch.response_mode + "', " + expected.version + ','),
    name + ' schedule SQL'
  );
  assert.equal(saves[0].syncAck.aggregateKey, expected.zoneUuid, name + ' sync ACK zone');
  assert.equal(saves[0].syncAck.appliedSyncVersion, expected.version, name + ' sync ACK version');

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

const SCHEDULE_BOUNDARIES = [ID.schedUserDb, ID.schedZoneDb, ID.schedSaveDb];

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
  for (const boundary of [ID.schedZoneDb, ID.schedSaveDb]) {
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
      await rt.runUntil('B', ID.schedSaveDb);
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
