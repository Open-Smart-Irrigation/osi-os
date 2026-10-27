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
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  captureDbOutcome,
  executeFunction,
  makeAuthHeader,
  profilePaths,
  seedScopedDb,
} = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const MODULES = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const FLOWS = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  'utf8'
));
const NODES = new Map(FLOWS.map((node) => [node.id, node]));
function uniqueNodeIdByName(name) {
  const matches = FLOWS.filter((node) => node.name === name);
  if (matches.length !== 1) throw new Error('expected one canonical node named ' + name + ', found ' + matches.length);
  return matches[0].id;
}
function canonicalNodeNameForId(nodeId) {
  const node = NODES.get(nodeId);
  assert.ok(node, 'gate selector resolves canonical node id ' + nodeId);
  assert.equal(node.id, nodeId, 'gate selector retains the canonical node id');
  assert.ok(['function', 'sqlite'].includes(node.type),
    'gate selector resolves a canonical Function or SQLite node');
  return node.name;
}
const ACK_QUEUE_NODE = uniqueNodeIdByName('Queue REST Command ACK');
const ACK_STATUS_NODE = uniqueNodeIdByName('Build Status + ACK');

test('direct loader selects tagged helper modules from both profiles and restores loader state', async () => {
  const moduleNames = ['osi-valve-control', 'osi-irrigation-policy'];
  const cacheBefore = new Map();
  const pathsByProfile = new Map(['bcm2712', 'bcm2709'].map((profile) => [profile, profilePaths(profile)]));
  const modulePath = (profile, name) => path.join(pathsByProfile.get(profile).nodeRedModules, name, 'index.js');
  for (const profile of pathsByProfile.keys()) for (const name of moduleNames) {
    const filename = modulePath(profile, name);
    cacheBefore.set(filename, require.cache[filename]);
  }
  const previousExistsSync = fs.existsSync;
  const probe = {
    type: 'function', name: 'Profile loader probe', libs: [{ var: 'osiLib', module: 'osi-lib' }],
    func: "const v=osiLib.require('osi-valve-control'); const p=osiLib.require('osi-irrigation-policy'); const m=osiLib.require('osi-missing-module'); return {valve:v.ok&&v.value.__profileTag,policy:p.ok&&p.value.__profileTag,missing:m};",
  };
  try {
    for (const profile of pathsByProfile.keys()) for (const name of moduleNames) {
      const filename = modulePath(profile, name);
      require.cache[filename] = { id: filename, filename, loaded: true,
        exports: { __profileTag: `${profile}-${name === 'osi-valve-control' ? 'valve' : 'policy'}` } };
    }
    for (const profile of pathsByProfile.keys()) {
      const db = seedScopedDb();
      try {
        const outcome = await executeFunction(probe, { msg: {}, db, flowState: {}, osiLibModules: {},
          libOverrides: {}, nodeRedModules: pathsByProfile.get(profile).nodeRedModules });
        assert.deepEqual(outcome.result, {
          valve: `${profile}-valve`, policy: `${profile}-policy`,
          missing: { ok: false, error: 'unregistered in harness: osi-missing-module' },
        });
      } finally { db.close(); }
    }
    const missingPath = modulePath('bcm2709', 'osi-irrigation-policy');
    fs.existsSync = (filename) => filename === missingPath ? false : previousExistsSync(filename);
    const db = seedScopedDb();
    try {
      const missingProbe = { ...probe, func: "return osiLib.require('osi-irrigation-policy');" };
      const outcome = await executeFunction(missingProbe, { msg: {}, db, flowState: {}, osiLibModules: {},
        libOverrides: {}, nodeRedModules: pathsByProfile.get('bcm2709').nodeRedModules });
      assert.deepEqual(outcome.result, { ok: false, error: 'unregistered in harness: osi-irrigation-policy' });
    } finally { db.close(); }
  } finally {
    fs.existsSync = previousExistsSync;
    for (const [filename, entry] of cacheBefore) {
      if (entry) require.cache[filename] = entry;
      else delete require.cache[filename];
    }
  }
});
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
  schedWrite: uniqueNodeIdByName('Conditional legacy lifecycle'),
  routeCommand: '934bf2bc19a8ce22',
  routeToActuator: '745b6db588017e56',
  actuatorLogDb: 'e681a40093c3798d',
  toStatusAck: 'a1ba5f5866ef6511',
  toDirectCommandAck: 'strega-interval-ack-link-out',
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
const STUB_ACCEPTED = [];
const STUB_POSSIBLE = [];
let stubNext = 0;
let stubTransportMode = 'accepted';
const CHIRPSTACK_STUB = {
  createProvisioningClientFromEnv() {
    return {
      flushDeviceQueue: async () => { STUB_QUEUE.length = 0; return { flushed: true }; },
      getDeviceQueue: async () => STUB_QUEUE.map((item) => Object.assign({}, item)),
      enqueueDownlink: async (item) => {
        if (stubTransportMode === 'rejected') {
          throw Object.assign(new Error('invalid enqueue request rejected by fixture'), {
            provenance: 'chirpstack_enqueue_preacceptance', grpcCode: 3, step: 'enqueueDownlink',
          });
        }
        if (stubTransportMode === 'preacceptance') {
          throw Object.assign(new Error('local preflight failed by fixture'), {
            code: 'enqueue_failed_before_acceptance', provenance: 'local_preflight', step: 'enqueueDownlink',
          });
        }
        if (stubTransportMode === 'unknown') {
          const possible = { devEui: String(item.devEui).toUpperCase(), fPort: item.fPort,
            data: item.data, isPending: false, certainty: 'possible_remote' };
          STUB_QUEUE.push({ ...possible });
          STUB_POSSIBLE.push({ ...possible });
          throw new Error('reply lost after possible remote enqueue');
        }
        const queueId = 'isolation-q-' + (++stubNext);
        const entry = { id: queueId, devEui: String(item.devEui).toUpperCase(), fPort: item.fPort,
          data: item.data, isPending: false };
        STUB_QUEUE.push({ ...entry });
        STUB_ACCEPTED.push({ ...entry });
        return { id: queueId };
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

function summarizeFunctionOutput(result) {
  const summarizeMessage = (msg) => msg == null ? null : ({
    statusCode: msg.statusCode,
    payload: msg.payload === undefined ? undefined : structuredClone(msg.payload),
  });
  if (result === null || result === undefined) return result;
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.map((output) => Array.isArray(output)
    ? output.map(summarizeMessage)
    : summarizeMessage(output));
}

class TestHarnessFault extends Error {
  constructor(message) {
    super(message);
    this.name = 'TestHarnessFault';
  }
}

class FlowRuntime {
  constructor(db, { scoped = false, follow = [], directAckLanes = null, dbCallGate = null, functionOverrides = new Map() } = {}) {
    this.db = db;
    this.logBaseline = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM actuator_log').get().id;
    this.scoped = scoped;
    this.directAckLanes = directAckLanes || new Set(['A', 'B', 'manual', 'owner', 'other', 'A2', 'A3']);
    this.ackVisit = 0;
    this.observationOrder = 0;
    this.env = {
      AUTH_TOKEN_SECRET: AUTH_SECRET,
      OSI_SCOPED_ACCESS: scoped ? '1' : '0',
      DEVICE_EUI: GATEWAY_EUI,
      CHIRPSTACK_APP_ACTUATORS: 'actuators-app',
    };
    // The manual valve chain ends at the encoder (transport, then the deferred response), so
    // the To Actuator link is always followed.
    this.follow = new Set([ID.toActuator, ID.toDirectCommandAck, ID.toStatusAck].concat(follow));
    this.tabContext = new Map();
    this.lanes = new Map();
    this.dbCallGate = dbCallGate;
    this.functionOverrides = functionOverrides;
    this.inFlight = new Map();
    this.nextStepKey = 1;
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
        trace: [],
        logRows: [],
        ackIngress: [],
        queueAcks: [],
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
    const inFlight = [...this.inFlight.values()].filter((entry) => entry.name === name);
    if (inFlight.length) throw new Error(name + ' lane incomplete with in-flight step ' + inFlight[0].key);
    if (this.dbCallGate && this.dbCallGate.laneComplete) this.dbCallGate.laneComplete(name);
  }

  async runReady(name) {
    while (this.pending(name) !== null) {
      const { key } = this.startStep(name);
      await this.settleStep(key);
    }
  }

  flowKeys() {
    const keys = [];
    for (const store of this.tabContext.values()) {
      if (store instanceof Map) keys.push(...store.keys());
      else if (store && Object.getPrototypeOf(store) === Object.prototype) keys.push(...Object.keys(store));
      else throw new TypeError('unexpected tab context store');
    }
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
        if (msg === null || msg === undefined) continue;
        if (node.id === ACK_STATUS_NODE && index === 1) this.captureAck(lane, 'postlog', msg, true);
        this.send(lane, wires[index], msg);
      }
    }
  }

  captureAck(lane, source, msg, followed) {
    const raw = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : structuredClone(msg.payload || {});
    const visit = 'ack-' + (++this.ackVisit);
    const commandId = raw.commandId === undefined ? null : raw.commandId;
    const record = { lane: lane.name, source, visit, commandId, raw: structuredClone(raw),
      followed: Boolean(followed), order: ++this.observationOrder };
    lane.ackIngress.push(record);
    msg._fixtureAckVisit = { lane: lane.name, source, visit, commandId };
    return record;
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

  startStep(name) {
    const lane = this.lane(name);
    if (!lane.queue.length) throw new Error(name + ' lane has no queued step');
    const { nodeId, msg } = lane.queue.shift();
    const node = this.functionOverrides.get(nodeId) || flowNode(nodeId);
    const key = 'step-' + this.nextStepKey++;
    const entry = { key, name, nodeId, msg, node, promise: null };
    this.inFlight.set(key, entry);
    entry.promise = Promise.resolve().then(() => this.performStep(entry)).then(
      (result) => ({ result }),
      (error) => ({ error })
    );
    return { key, promise: entry.promise };
  }

  async performStep(entry) {
    const { name, msg, node } = entry;
    const lane = this.lane(name);
    switch (node.type) {
      case 'http in':
      case 'link in':
        return { kind: 'route', node, result: msg };
      case 'function': {
        let flowStore = this.tabContext.get(node.z);
        if (!flowStore) {
          flowStore = new Map();
          this.tabContext.set(node.z, flowStore);
        }
        const dbCallGate = this.dbCallGate && this.dbCallGate.forLane
          ? this.dbCallGate.forLane(name, node.id, entry.key)
          : this.dbCallGate;
        let ackQueueEntry = null;
        if (node.id === ACK_QUEUE_NODE) {
          const visit = msg._fixtureAckVisit;
          const input = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : structuredClone(msg.payload || {});
          const commandId = input.commandId === undefined ? null : input.commandId;
          const ownerId = commandId == null ? null : String(commandId);
          const ownerRow = this.db.prepare(
            'SELECT command_id, command_type, result, result_detail, last_error FROM applied_commands WHERE command_id = ?'
          ).get(ownerId);
          if (ownerRow) assert.equal(ownerRow.command_id, ownerId,
            'ACK prequeue owner lookup returns the exact normalized command id');
          ackQueueEntry = {
            lane: name, source: visit && visit.source, visit: visit && visit.visit, commandId,
            ownerId,
            input: structuredClone(input),
            ledgerBeforeQueue: ownerRow ? {
              ...ownerRow,
              result_detail: ownerRow.result_detail ? JSON.parse(ownerRow.result_detail) : null,
            } : null,
          };
          lane.queueAcks.push(ackQueueEntry);
        }
        const outcome = await executeFunction(node, {
          msg,
          env: this.env,
          flowState: Object.fromEntries(flowStore),
          flowStore,
          dbCallGate,
          db: this.db,
          osiLibModules: { 'osi-valve-control': valveControl },
          libOverrides: { chirpstack: CHIRPSTACK_STUB },
          nodeRedModules: MODULES,
        });
        if (ackQueueEntry && outcome.result && outcome.result.payload) {
          ackQueueEntry.branchResult = typeof outcome.result.payload === 'string'
            ? JSON.parse(outcome.result.payload)
            : structuredClone(outcome.result.payload);
        }
        return { kind: 'function', node, outcome };
      }
      case 'sqlite': {
        if (lane.failAt.has(node.id)) {
          lane.failAt.delete(node.id);
          return { kind: 'raise', node, msg, error: new Error('SQLITE_BUSY: database is locked') };
        }
        const sqlEntry = {
          node: node.id,
          topic: msg.topic,
          syncAck: msg.syncAck ? JSON.parse(JSON.stringify(msg.syncAck)) : undefined,
          request: msg.osi && msg.osi.request ? { ...msg.osi.request } : undefined,
          authUserId: msg.authUserId,
          reqParamsId: msg.req && msg.req.params ? msg.req.params.id : undefined,
          reqBody: msg.req_body === undefined ? undefined : JSON.parse(JSON.stringify(msg.req_body)),
          actorUserUuid: msg.actor_user_uuid,
        };
        lane.sql.push(sqlEntry);
        lane.trace.push({ kind: 'sql_topic', lane: name, node: node.id, topic: msg.topic });
        const gate = this.dbCallGate && this.dbCallGate.forLane
          ? this.dbCallGate.forLane(name, node.id, entry.key)
          : this.dbCallGate;
        const decision = gate
          ? gate.select({ method: 'all', sql: msg.topic, params: [] })
          : { kind: 'execute', hold: false };
        sqlEntry.callId = decision.callId || null;
        if (gate && gate.rawStart) gate.rawStart(decision);
        const capture = () => captureDbOutcome(this.db, 'all', msg.topic, [], decision);
        const outcome = gate && gate.withCallScope
          ? gate.withCallScope(decision.callId, capture)
          : capture();
        sqlEntry.gateKind = decision.kind;
        sqlEntry.operationCount = outcome.operationCount;
        sqlEntry.operationError = outcome.error ? String(outcome.error.message || outcome.error) : null;
        if (node.id === ID.valveWriteDb && outcome.operationCount === 1 && !outcome.error) {
          sqlEntry.logRowId = this.db.prepare('SELECT last_insert_rowid() AS id').get().id;
          lane.logRows.push({ node: node.id, id: sqlEntry.logRowId, order: ++this.observationOrder });
        }
        lane.trace.push({ kind: 'sql_operation', lane: name, node: node.id, gateKind: decision.kind,
          operationCount: outcome.operationCount, error: sqlEntry.operationError });
        const delivered = gate && gate.deliver
          ? await gate.deliver(decision, outcome, { method: 'all', sql: msg.topic, params: [] })
          : outcome;
        if (delivered.error) {
          if (gate && gate.errorDelivered) gate.errorDelivered(decision, delivered.error, 'sqlite_delivered_error');
          return { kind: 'raise', node, msg, error: delivered.error, callId: decision.callId, stepKey: entry.key };
        }
        msg.payload = delivered.value;
        lane.trace.push({ kind: 'sql_delivery', lane: name, node: node.id, operationCount: outcome.operationCount });
        return { kind: 'route', node, result: msg };
      }
      case 'link out':
        return { kind: 'link', node, msg };
      case 'switch': {
        const value = readProperty(msg, node.property);
        let matched = false;
        const targets = [];
        node.rules.forEach((rule, index) => {
          if (matched && node.checkall !== 'true') return;
          let ok;
          if (rule.t === 'nnull') ok = value !== null && value !== undefined;
          else if (rule.t === 'else') ok = !matched;
          else throw new TestHarnessFault('unsupported switch rule ' + rule.t + ' in ' + node.id);
          if (ok) {
            matched = true;
            targets.push(node.wires[index]);
          }
        });
        return { kind: 'switch', node, msg, targets };
      }
      case 'http response':
        return { kind: 'response', msg };
      case 'mqtt out':
        return { kind: 'publish', node, msg };
      case 'debug':
        return null;
      default:
        throw new TestHarnessFault('unsupported node type ' + node.type + ' (' + node.id + ')');
    }
  }

  async settleStep(key) {
    const entry = this.inFlight.get(key);
    if (!entry) throw new Error('unknown in-flight step ' + key);
    const captured = await entry.promise;
    this.inFlight.delete(key);
    const lane = this.lane(entry.name);
    if (captured.error) {
      if (captured.error instanceof TestHarnessFault) throw captured.error;
      if (this.dbCallGate && this.dbCallGate.functionComplete) {
        this.dbCallGate.functionComplete(entry.name, entry.node.id, entry.key,
          captured.error.message || captured.error, null);
      }
      this.raise(lane, entry.node, entry.msg, captured.error);
      return;
    }
    const action = captured.result;
    if (!action) return;
    if (action.kind === 'function') {
      if (this.dbCallGate && this.dbCallGate.functionComplete) {
        this.dbCallGate.functionComplete(entry.name, action.node.id, entry.key,
          action.outcome.errors.join('; ') || null, summarizeFunctionOutput(action.outcome.result));
      }
      lane.ran.push(action.node.id);
      lane.errors.push(...action.outcome.errors.map((message) => ({ node: action.node.id, message })));
      this.route(lane, action.node, action.outcome.result);
    } else if (action.kind === 'route') this.route(lane, action.node, action.result);
    else if (action.kind === 'raise') {
      if (this.dbCallGate && this.dbCallGate.raiseObserved) {
        this.dbCallGate.raiseObserved({ lane: entry.name, nodeId: action.node.id,
          stepKey: action.stepKey || entry.key, callId: action.callId || null, error: action.error });
      }
      this.raise(lane, action.node, action.msg, action.error);
    }
    else if (action.kind === 'link') {
      lane.links.push({ node: action.node.id, msg: action.msg });
      const directAllowed = action.node.id !== ID.toDirectCommandAck || this.directAckLanes.has(entry.name);
      if (action.node.id === ID.toDirectCommandAck) this.captureAck(lane, 'direct', action.msg,
        this.follow.has(action.node.id) && directAllowed);
      if (this.follow.has(action.node.id) && directAllowed) this.send(lane, action.node.links, action.msg);
    } else if (action.kind === 'switch') {
      for (const targets of action.targets) this.send(lane, targets, action.msg);
    } else if (action.kind === 'response') {
      lane.responses.push({ statusCode: action.msg.statusCode, payload: action.msg.payload, res: action.msg.res });
    } else if (action.kind === 'publish') {
      lane.published.push({ node: action.node.id, topic: action.msg.topic, payload: action.msg.payload,
        fixtureAckVisit: action.msg._fixtureAckVisit ? { ...action.msg._fixtureAckVisit } : undefined });
    } else throw new TestHarnessFault('unsupported step result ' + action.kind);
  }

  async step(name) {
    const { key } = this.startStep(name);
    await this.settleStep(key);
  }
}

function seedDb() {
  const db = seedScopedDb();
  db.prepare(`INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at)
    VALUES ('cloud',1,?,'2026-01-01')
    ON CONFLICT(peer_node) DO UPDATE SET linked=1,gateway_device_eui=excluded.gateway_device_eui,updated_at=excluded.updated_at`)
    .run(GATEWAY_EUI);
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

function scheduleMsg(lane, { user, zoneId, patch, msgid }) {
  user = user || (zoneId === 2 ? USERS.admin1 : USERS.res1);
  const msg = {
    req: { headers: { authorization: bearer(user) }, params: { id: String(zoneId) }, query: {} },
    res: { lane },
    payload: patch,
  };
  if (msgid !== null) msg._msgid = msgid || 'msgid-' + lane;
  return msg;
}

function makeDbCallGate(selectDecision) {
  const events = [];
  const held = new Map();
  const counters = new Map();
  const sqlObservations = [];
  const observationByCallId = new Map();
  let nextCallId = 0;
  let activeCallId = null;
  const waiters = [];
  let diagnosticsForLane = () => null;
  function observationFor(callId) {
    if (!callId) return null;
    if (!observationByCallId.has(callId)) {
      const selected = events.find((event) => event.phase === 'selected' && event.callId === callId);
      const observation = {
        callId, lane: selected && selected.lane, nodeName: selected && selected.nodeName,
        method: selected && selected.method, sql: selected && selected.sqlRole,
        prepareCount: 0, executeCount: 0,
      };
      observationByCallId.set(callId, observation);
      sqlObservations.push(observation);
    }
    return observationByCallId.get(callId);
  }
  function withCallScope(callId, callback) {
    const prior = activeCallId;
    activeCallId = callId;
    observationFor(callId);
    try { return callback(); }
    finally { activeCallId = prior; }
  }
  function observeDatabase(db) {
    return new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') return (sql, ...args) => {
          const observation = observationFor(activeCallId);
          if (observation) observation.prepareCount += 1;
          const statement = Reflect.apply(target.prepare, target, [sql, ...args]);
          return new Proxy(statement, {
            get(statementTarget, method) {
              const value = Reflect.get(statementTarget, method, statementTarget);
              if (['all', 'get', 'run'].includes(String(method)) && typeof value === 'function') {
                return (...params) => {
                  const scoped = observationFor(activeCallId);
                  if (scoped) scoped.executeCount += 1;
                  return Reflect.apply(value, statementTarget, params);
                };
              }
              return typeof value === 'function' ? value.bind(statementTarget) : value;
            },
          });
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  function removeWaiter(waiter) {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    clearTimeout(waiter.timer);
  }
  function waiterError(waiter, reason) {
    let firstQueued;
    try { firstQueued = diagnosticsForLane(waiter.target.lane); }
    catch (error) { firstQueued = { diagnosticObserverError: String(error && error.message || error) }; }
    let trace;
    try { trace = JSON.stringify(events); }
    catch (error) { trace = JSON.stringify({ traceSerializationError: String(error && error.message || error) }); }
    return new Error(`${reason}; target=${JSON.stringify(waiter.target)}; trace=${trace}; firstQueued=${JSON.stringify(firstQueued)}`);
  }
  function notify() {
    for (const waiter of [...waiters]) {
      for (const event of events) {
        if (event.phase !== 'selected' || event.state !== 'held_after_operation' || !held.has(event)) continue;
        try {
          if (!waiter.predicate(event)) continue;
          removeWaiter(waiter);
          waiter.resolve(event);
          break;
        } catch (error) {
          events.push({ callId: event.callId, phase: 'observer_fault', lane: waiter.target.lane,
            error: String(error && error.message || error) });
          removeWaiter(waiter);
          waiter.reject(waiterError(waiter, 'DB gate observer predicate failed: ' + String(error && error.message || error)));
          break;
        }
      }
    }
  }
  function forLane(lane, nodeId, stepKey) {
    return {
      withCallScope,
      errorDelivered(decision, error, stage) {
        const event = decision.event;
        events.push({ callId: event.callId, phase: 'error_delivered', stage, lane, nodeId,
          nodeName: event.nodeName, stepKey, errorCode: error && error.code || null,
          errorMessage: String(error && error.message || error), deliveryCount: event.deliveries });
      },
      rawStart(decision) {
        const event = decision.event;
        events.push({ callId: event.callId, phase: 'raw_started', lane, nodeId, nodeName: event.nodeName,
          method: event.method, sqlRole: event.sqlRole, params: [...event.params],
          methodOrdinal: event.methodOrdinal, siteOccurrence: event.siteOccurrence,
          decisionKind: event.decisionKind, operationCount: null, error: null });
      },
      transactionEvent(phase, error) {
        events.push({ phase: 'transaction_' + phase, lane, nodeId, nodeName: canonicalNodeNameForId(nodeId),
          error: error ? String(error.message || error) : null });
      },
      select({ method, sql, params }) {
        const counterKey = [lane, nodeId, method].join('|');
        const methodOrdinal = (counters.get(counterKey) || 0) + 1;
        counters.set(counterKey, methodOrdinal);
        const callId = 'db-call-' + (++nextCallId);
        const nodeName = canonicalNodeNameForId(nodeId);
        const sqlRole = sql;
        const selected = selectDecision({ lane, nodeId, nodeName, method, sql, sqlRole, params, methodOrdinal });
        const decision = selected || { kind: 'execute', hold: false };
        const event = {
          callId, phase: 'selected', lane, nodeId, nodeName, method, sqlRole, methodOrdinal,
          siteOccurrence: selected && selected.siteOccurrence || null,
          params: [...params], decisionKind: decision.kind, hold: Boolean(decision.hold),
          operationCount: null, result: undefined, error: null,
          state: 'selected', released: false, deliveries: 0,
        };
        events.push(event);
        notify();
        return { ...decision, callId, event };
      },
      deliver(decision, outcome, metadata = {}) {
        const event = decision.event;
        const method = event.method;
        const sqlRole = event.sqlRole;
        const params = event.params;
        event.deliveryMetadataMatchesSelection =
          (!Object.hasOwn(metadata, 'method') || metadata.method === event.method) &&
          (!Object.hasOwn(metadata, 'sql') || metadata.sql === event.sqlRole) &&
          (!Object.hasOwn(metadata, 'params') || JSON.stringify(metadata.params) === JSON.stringify(event.params));
        event.operationCount = outcome.operationCount;
        event.result = outcome.value;
        event.error = outcome.error ? String(outcome.error.message || outcome.error) : null;
        event.state = decision.hold ? 'held_after_operation' : 'ready';
        events.push({ callId: event.callId, phase: 'raw_finished', lane, nodeId, nodeName: event.nodeName, method, sqlRole,
          params: [...params], methodOrdinal: event.methodOrdinal, siteOccurrence: event.siteOccurrence,
          decisionKind: event.decisionKind, operationCount: outcome.operationCount,
          result: outcome.value, error: event.error, state: event.state,
          deliveryMetadataMatchesSelection: event.deliveryMetadataMatchesSelection });
        if (!decision.hold) {
          event.deliveries += 1;
          event.state = 'delivered';
          notify();
          return Promise.resolve(outcome);
        }
        return new Promise((resolve, reject) => {
          held.set(event, { outcome, resolve, reject });
          events.push({ callId: event.callId, phase: 'delivery_held', lane, nodeId, nodeName: event.nodeName, method, sqlRole,
            params: [...params], methodOrdinal: event.methodOrdinal, siteOccurrence: event.siteOccurrence,
            decisionKind: event.decisionKind, operationCount: outcome.operationCount,
            result: outcome.value, error: event.error, state: event.state,
            deliveryMetadataMatchesSelection: event.deliveryMetadataMatchesSelection });
          notify();
        });
      },
    };
  }
  function release(event) {
    const pending = held.get(event);
    if (!pending || event.released) throw new Error('delivery gate released more than once or was not held');
    event.released = true;
    event.releaseOrder = events.push({ callId: event.callId, phase: 'delivery_released', lane: event.lane,
      nodeId: event.nodeId, nodeName: event.nodeName, method: event.method, sqlRole: event.sqlRole, params: [...event.params],
      methodOrdinal: event.methodOrdinal, siteOccurrence: event.siteOccurrence,
      decisionKind: event.decisionKind, operationCount: event.operationCount, error: event.error,
      deliveryMetadataMatchesSelection: event.deliveryMetadataMatchesSelection });
    event.deliveries += 1;
    event.state = 'delivered';
    held.delete(event);
    pending.resolve(pending.outcome);
  }
  return {
    events,
    sqlObservations,
    observeDatabase,
    withCallScope,
    forLane,
    setDiagnosticsForLane(fn) { diagnosticsForLane = fn || (() => null); },
    rawStart(decision) {
      const event = decision.event;
      events.push({ callId: event.callId, phase: 'raw_started', lane: event.lane, nodeId: event.nodeId, nodeName: event.nodeName,
        method: event.method, sqlRole: event.sqlRole, params: [...event.params],
        methodOrdinal: event.methodOrdinal, siteOccurrence: event.siteOccurrence,
        decisionKind: event.decisionKind });
    },
    transactionEvent(phase, error) {
      events.push({ phase: 'transaction_' + phase, nodeName: null, error: error ? String(error.message || error) : null });
    },
    errorDelivered(decision, error, stage) {
      const event = decision.event;
      events.push({ callId: event.callId, phase: 'error_delivered', stage, lane: event.lane,
        nodeId: event.nodeId, nodeName: event.nodeName, stepKey: null,
        errorCode: error && error.code || null, errorMessage: String(error && error.message || error),
        deliveryCount: event.deliveries });
    },
    raiseObserved({ lane, nodeId, stepKey, callId, error }) {
      const event = events.find((candidate) => candidate.phase === 'selected' && candidate.callId === callId);
      events.push({ callId, phase: 'raise_observed', lane, nodeId, nodeName: canonicalNodeNameForId(nodeId),
        stepKey, errorCode: error && error.code || null,
        errorMessage: String(error && error.message || error), deliveryCount: event ? event.deliveries : null });
    },
    functionComplete(lane, nodeId, stepKey, error, returnedOutput) {
      const errorCalls = events.filter((event) => event.phase === 'error_delivered' &&
        event.lane === lane && event.stepKey === stepKey).map((event) => event.callId);
      events.push({ phase: 'function_complete', lane, nodeId, nodeName: canonicalNodeNameForId(nodeId),
        stepKey, callId: errorCalls.length === 1 ? errorCalls[0] : null,
        error: error ? String(error) : null, returnedOutput });
    },
    laneComplete(lane) { events.push({ phase: 'b_completed', lane }); },
    release,
    releaseAll() {
      for (const event of [...held.keys()]) release(event);
    },
    waitForEvent(predicate, target = {}) {
      const waiter = { predicate, target: { ...target,
        ...(target.nodeId ? { nodeName: canonicalNodeNameForId(target.nodeId) } : {}) } };
      for (const event of events) {
        if (event.phase !== 'selected' || event.state !== 'held_after_operation' || !held.has(event)) continue;
        try { if (predicate(event)) return Promise.resolve(event); }
        catch (error) {
          events.push({ callId: event.callId, phase: 'observer_fault', lane: target.lane,
            error: String(error && error.message || error) });
          return Promise.reject(waiterError(waiter, 'DB gate observer predicate failed: ' + String(error && error.message || error)));
        }
      }
      return new Promise((resolve, reject) => {
        waiter.resolve = resolve;
        waiter.reject = reject;
        waiter.timer = setTimeout(() => {
          removeWaiter(waiter);
          reject(waiterError(waiter, 'timed out waiting for DB gate event'));
        }, 1000);
        waiters.push(waiter);
      });
    },
    get pendingCount() { return held.size; },
  };
}

function matchingGate({ lane = 'A', nodeId, method, sqlIncludes, params, occurrence = 1, kind = 'execute' }) {
  const nodeName = canonicalNodeNameForId(nodeId);
  let matched = 0;
  return (call) => {
    if (call.lane !== lane || call.nodeId !== nodeId || call.nodeName !== nodeName || call.method !== method ||
        (sqlIncludes && (typeof call.sqlRole !== 'string' || !call.sqlRole.includes(sqlIncludes))) ||
        (params && JSON.stringify(call.params) !== JSON.stringify(params))) return null;
    matched += 1;
    if (matched !== occurrence) return null;
    return { kind, hold: true, siteOccurrence: matched };
  };
}

function assertOneHeldCallTrace(gate, held, operationCount) {
  const linked = gate.events.filter((event) => event.callId === held.callId);
  for (const phase of ['selected', 'raw_started', 'raw_finished', 'delivery_held', 'delivery_released']) {
    assert.equal(linked.filter((event) => event.phase === phase).length, 1,
      `${phase} is present exactly once for ${held.callId}`);
  }
  for (const event of linked) {
    if (['selected', 'raw_started', 'raw_finished', 'delivery_held', 'delivery_released'].includes(event.phase)) {
      assert.equal(event.method, held.method);
      assert.equal(event.nodeName, held.nodeName, 'trace retains canonical Function name');
      assert.equal(event.sqlRole, held.sqlRole);
      assert.equal(event.methodOrdinal, held.methodOrdinal);
      assert.equal(event.siteOccurrence, held.siteOccurrence);
      assert.equal(event.decisionKind, held.decisionKind);
      if (event.phase !== 'selected' && event.phase !== 'raw_started') {
        assert.equal(event.deliveryMetadataMatchesSelection, true, 'delivery method, SQL and params match the selected call');
      }
    }
  }
  assert.equal(held.operationCount, operationCount);
  assert.equal(held.deliveries, 1);
  if (held.method !== 'close') {
    const observations = gate.sqlObservations.filter((entry) => entry.callId === held.callId);
    assert.equal(observations.length, 1, `one independent SQLite observer record exists for ${held.callId}`);
    const observed = observations[0];
    assert.deepEqual({ lane: observed.lane, nodeName: observed.nodeName, method: observed.method, sql: observed.sql },
      { lane: held.lane, nodeName: held.nodeName, method: held.method, sql: held.sqlRole },
      'SQLite observation is bound to the selected call identity and exact source site');
    const expectedRawCount = held.decisionKind === 'synthetic_busy' ? 0 : 1;
    assert.equal(observed.prepareCount, expectedRawCount, 'independent observer counts prepare calls');
    assert.equal(observed.executeCount, expectedRawCount, 'independent observer counts statement execution calls');
  }
}

function assertBusyErrorAttribution(gate, rt, held, laneName, nodeId, { downstreamAccepted = false } = {}) {
  assert.equal(held.decisionKind, 'synthetic_busy');
  assert.equal(held.nodeId, nodeId, 'busy attribution retains the selected node identity');
  const delivery = gate.events.filter((event) => event.phase === 'error_delivered' && event.callId === held.callId);
  assert.equal(delivery.length, 1, `${held.callId} delivers its selected busy error exactly once`);
  assert.equal(delivery[0].lane, laneName);
  assert.equal(delivery[0].nodeName, held.nodeName);
  assert.equal(delivery[0].errorCode, 'SQLITE_BUSY');
  assert.equal(delivery[0].errorMessage, 'SQLITE_BUSY: database is locked');
  assert.equal(delivery[0].deliveryCount, 1);
  const assertSqliteRaise = () => {
    const raised = gate.events.filter((event) => event.phase === 'raise_observed' && event.callId === held.callId);
    assert.equal(raised.length, 1, `${held.callId} SQLite error reaches the existing raise route once`);
    assert.equal(raised[0].stepKey, delivery[0].stepKey);
    assert.equal(raised[0].errorCode, 'SQLITE_BUSY');
    assert.equal(raised[0].errorMessage, delivery[0].errorMessage);
    const thrown = rt.lane(laneName).thrown;
    assert.equal(thrown.length, 1, 'SQLite error creates one observed raise origin');
    assert.equal(thrown[0].node, nodeId);
    assert.equal(thrown[0].message, delivery[0].errorMessage);
  };
  if (downstreamAccepted) {
    assertSqliteRaise();
    assert.equal(onlyResponse(rt, laneName).statusCode, 202);
    return;
  }
  if (delivery[0].stage === 'sqlite_delivered_error') {
    assertSqliteRaise();
  } else {
    const completed = gate.events.filter((event) => event.phase === 'function_complete' &&
      event.lane === laneName && event.nodeName === held.nodeName && event.stepKey === delivery[0].stepKey);
    assert.equal(completed.length, 1, `${held.callId} busy error reaches its Function completion once`);
    assert.equal(completed[0].callId, held.callId, `${held.callId} stays bound through Function completion`);
    assert.ok(completed[0].returnedOutput, `${held.callId} Function completion records its returned route output`);
    assert.equal(JSON.stringify(completed[0].returnedOutput).includes('500'), true,
      `${held.callId} Function output retains its 500 failure result`);
    assert.equal(rt.lane(laneName).thrown.length, 0, 'no harness throw supplies the busy response');
  }
  const unrelatedErrors = rt.lane(laneName).errors.filter((entry) =>
    entry.node !== held.nodeId || !String(entry.message).includes('SQLITE_BUSY'));
  assert.deepEqual(unrelatedErrors, [], 'no unrelated lane error supplies the selected busy response');
  assert.ok(rt.lane(laneName).errors.length <= 1, 'selected busy produces at most one Function error origin');
  assert.equal(rt.lane(laneName).responses.length, 1, 'selected busy path produces the sole lane response');
  assert.equal(rt.lane(laneName).responses[0].statusCode, 500);
}

function heldAtSite(event, { lane = 'A', nodeId, method, sqlIncludes }) {
  return event.phase === 'selected' && event.lane === lane && event.nodeId === nodeId &&
    event.nodeName === canonicalNodeNameForId(nodeId) &&
    event.method === method && typeof event.sqlRole === 'string' &&
    (!sqlIncludes || event.sqlRole.includes(sqlIncludes)) && event.siteOccurrence === 1 &&
    event.state === 'held_after_operation';
}

async function withRuntime(options, body) {
  scopeHelper._resetForTests();
  STUB_QUEUE.length = 0;
  STUB_ACCEPTED.length = 0;
  STUB_POSSIBLE.length = 0;
  stubNext = 0;
  stubTransportMode = options.stubMode || 'accepted';
  const db = seedDb();
  let rt;
  try {
    const runtimeDb = options.dbCallGate && options.dbCallGate.observeDatabase
      ? options.dbCallGate.observeDatabase(db)
      : db;
    rt = new FlowRuntime(runtimeDb, options);
    if (rt.dbCallGate && rt.dbCallGate.setDiagnosticsForLane) {
      rt.dbCallGate.setDiagnosticsForLane((laneName) => {
        if (!laneName || !rt.lanes.has(laneName)) return null;
        const lane = rt.lane(laneName);
        const queued = lane.queue.find((item) => NODES.get(item.nodeId)?.type === 'http response');
        if (queued) return { node: queued.nodeId, payload: queued.msg.payload, statusCode: queued.msg.statusCode };
        return lane.responses[0] || lane.errors[0] || lane.thrown[0] || null;
      });
    }
    await body(rt, db);
    for (const key of rt.flowKeys()) {
      assert.doesNotMatch(key, REQUEST_SCRATCH_KEY, 'per-request value left in shared flow context: ' + key);
    }
  } finally {
    stubTransportMode = 'accepted';
    if (rt) {
      if (rt.dbCallGate && rt.dbCallGate.releaseAll) rt.dbCallGate.releaseAll();
      const pending = [...rt.inFlight.keys()];
      await Promise.allSettled(pending.map((key) => rt.settleStep(key)));
      assert.equal(rt.inFlight.size, 0, 'all in-flight steps settle before the seed database closes');
    }
    db.close();
    scopeHelper._resetForTests();
  }
}

function onlyResponse(rt, name) {
  const lane = rt.lane(name);
  assert.equal(lane.responses.length, 1, name + ' must receive exactly one HTTP response');
  assert.equal(lane.responses[0].res.lane, name, name + ' response must go to its own connection');
  return lane.responses[0];
}

const ACK_NEW_ENVELOPE_METADATA = [
  'eventUuid', 'aggregateType', 'aggregateKey', 'appliedAt', 'requestedSyncVersion', 'appliedSyncVersion',
];

function ackTupleKey(tuple) {
  return JSON.stringify([tuple.lane, tuple.source, tuple.visit, tuple.commandId]);
}

function assertAckPublicationBijection(rt, name) {
  const lane = rt.lane(name);
  const followed = lane.ackIngress.filter((visit) => visit.followed);
  const expected = new Map(followed.map((visit) => [ackTupleKey(visit), visit]));
  assert.equal(expected.size, followed.length, `${name} followed raw ACK visits have unique tuples`);
  const queueCounts = new Map();
  for (const queue of lane.queueAcks) {
    const key = ackTupleKey(queue);
    assert.ok(expected.has(key), `${name} queue invocation has a followed raw source tuple: ${key}`);
    queueCounts.set(key, (queueCounts.get(key) || 0) + 1);
  }
  const publications = lane.published.filter((entry) => entry.node === ID.commandAckMqtt);
  const publicationCounts = new Map();
  for (const publication of publications) {
    assert.ok(publication.fixtureAckVisit,
      `${name} every command-ACK publication carries a visit tag before any filtered assertion`);
    const key = ackTupleKey(publication.fixtureAckVisit);
    assert.ok(expected.has(key), `${name} publication belongs to a followed raw visit: ${key}`);
    publicationCounts.set(key, (publicationCounts.get(key) || 0) + 1);
  }
  for (const [key, visit] of expected) {
    assert.equal(queueCounts.get(key), 1, `${name} followed ${visit.source} visit queues exactly once`);
    assert.equal(publicationCounts.get(key), 1, `${name} followed ${visit.source} visit publishes exactly once`);
  }
}

function expectedInitialCloudAck(raw) {
  const appliedSyncVersionCandidate = raw.appliedSyncVersion == null ? null : Number(raw.appliedSyncVersion);
  const appliedSyncVersion = Number.isSafeInteger(appliedSyncVersionCandidate) && appliedSyncVersionCandidate >= 0
    ? appliedSyncVersionCandidate : null;
  const requestedSyncVersionCandidate = raw.requestedSyncVersion == null
    ? raw.requested_sync_version : raw.requestedSyncVersion;
  const requestedSyncVersionNumber = Number(requestedSyncVersionCandidate);
  const requestedSyncVersion = Number.isSafeInteger(requestedSyncVersionNumber) && requestedSyncVersionNumber >= 0
    ? requestedSyncVersionNumber : appliedSyncVersion;
  return {
    commandId: raw.commandId,
    eventUuid: raw.eventUuid == null ? null : raw.eventUuid,
    aggregateType: raw.aggregateType == null ? null : raw.aggregateType,
    aggregateKey: raw.aggregateKey == null ? null : raw.aggregateKey,
    commandType: String(raw.commandType || '').trim().toUpperCase() || null,
    status: 'ACKED',
    result: 'APPLIED',
    appliedAt: String(raw.timestamp || raw.appliedAt),
    requestedSyncVersion,
    appliedSyncVersion,
    duplicate: raw.duplicate === true || String(raw.duplicate || '').toLowerCase() === 'true',
    reason: raw.error == null ? (raw.reason || null) : String(raw.error),
    detail: raw.error == null ? (raw.reason || null) : String(raw.error),
  };
}

function assertManualAcceptedAckEvidence(rt, name, commandId, queueId, attributedLogOrder) {
  const lane = rt.lane(name);
  assertAckPublicationBijection(rt, name);
  const rawVisits = lane.ackIngress.filter((visit) => String(visit.commandId) === String(commandId));
  const direct = rawVisits.filter((visit) => visit.source === 'direct');
  const postlog = rawVisits.filter((visit) => visit.source === 'postlog');
  assert.equal(direct.length, 1, name + ' raw direct ACK visit');
  assert.equal(postlog.length, 1, name + ' raw post-log ACK visit');
  assert.ok(direct[0].order < postlog[0].order,
    name + ' raw direct ACK visit precedes the post-log ACK visit');
  assert.equal(direct[0].raw.result, 'SUCCESS');
  assert.equal(direct[0].raw.transportPhase, 'ACCEPTED');
  assert.equal(postlog[0].raw.result, 'SUCCESS');
  assert.equal(postlog[0].raw.state, 'OPEN');
  assert.ok(postlog[0].order > attributedLogOrder, name + ' post-log raw visit follows the attributed actuator INSERT');
  assert.equal(Object.hasOwn(postlog[0].raw, 'transportPhase'), false);

  const published = lane.published.filter((entry) => entry.node === ID.commandAckMqtt &&
    entry.fixtureAckVisit && String(entry.fixtureAckVisit.commandId) === String(commandId));
  assert.equal(published.length, 2, name + ' one published ACK per raw source visit');
  const byVisit = new Map(published.map((entry) => [entry.fixtureAckVisit.visit, JSON.parse(entry.payload)]));
  for (const source of [direct[0], postlog[0]]) {
    const sourcePublication = published.filter((entry) => entry.fixtureAckVisit.lane === name &&
      entry.fixtureAckVisit.source === source.source && entry.fixtureAckVisit.visit === source.visit &&
      String(entry.fixtureAckVisit.commandId) === String(source.commandId));
    assert.equal(sourcePublication.length, 1, name + ' publication retains exact lane/source/visit/command tuple');
    assert.deepEqual(sourcePublication[0].fixtureAckVisit, {
      lane: name, source: source.source, visit: source.visit, commandId: source.commandId,
    });
    const queue = lane.queueAcks.filter((entry) => entry.visit === source.visit && String(entry.commandId) === String(commandId));
    assert.equal(queue.length, 1, name + ' one queue call for ' + source.source + ' visit');
    assert.deepEqual(queue[0].input, source.raw, name + ' queue input matches raw ' + source.source);
    assert.deepEqual(byVisit.get(source.visit), queue[0].branchResult,
      name + ' publication equals its own queue-function branch result');
    assert.ok(byVisit.has(source.visit), name + ' publication retains ' + source.source + ' visit');
  }

  const directQueue = lane.queueAcks.find((entry) => entry.visit === direct[0].visit);
  const postlogQueue = lane.queueAcks.find((entry) => entry.visit === postlog[0].visit);
  const directQueueOrder = lane.queueAcks.findIndex((entry) => entry.visit === direct[0].visit);
  const postlogQueueOrder = lane.queueAcks.findIndex((entry) => entry.visit === postlog[0].visit);
  assert.ok(directQueueOrder >= 0 && directQueueOrder < postlogQueueOrder,
    name + ' direct queue invocation precedes the post-log queue invocation');
  const directPublished = byVisit.get(direct[0].visit);
  const postlogPublished = byVisit.get(postlog[0].visit);
  assert.equal(direct[0].raw.queueId, queueId, name + ' raw direct queueId equals HTTP response queue_id');
  if (rt.scoped) {
    for (const [queue, envelope] of [[directQueue, directPublished], [postlogQueue, postlogPublished]]) {
      const owner = queue.ledgerBeforeQueue;
      assert.ok(owner, name + ' scoped ACK observes its prior ledger owner');
      assert.equal(owner.command_type, 'OPEN_FOR_DURATION');
      assert.equal(owner.result, 'APPLIED');
      assert.equal(owner.result_detail.result, 'APPLIED');
      assert.equal(owner.result_detail.status, 'ACKED');
      assert.equal(owner.result_detail.duplicate, false);
      assert.equal(owner.result_detail.reason, 'transport_pending');
      assert.equal(owner.result_detail.transportPhase, 'ACCEPTED');
      assert.equal(owner.result_detail.error, null);
      assert.equal(Object.hasOwn(owner.result_detail, 'detail'), false);
      for (const field of ACK_NEW_ENVELOPE_METADATA) {
        assert.equal(Object.hasOwn(owner.result_detail, field), false, name + ' scoped stored terminal replay omits ' + field);
        assert.equal(Object.hasOwn(envelope, field), false, name + ' scoped published terminal replay omits ' + field);
      }
      assert.deepEqual(envelope, owner.result_detail, name + ' scoped terminal ACK replays exact owner detail');
      const persisted = rt.db.prepare('SELECT command_type, result, result_detail FROM applied_commands WHERE command_id=?')
        .get(commandId);
      assert.equal(persisted.command_type, owner.command_type);
      assert.equal(persisted.result, owner.result);
      assert.deepEqual(JSON.parse(persisted.result_detail), owner.result_detail,
        name + ' terminal queue leaves the scoped owner unchanged');
    }
  } else {
    assert.equal(directQueue.ledgerBeforeQueue, null, name + ' first flag-off visit has no prior owner');
    const expected = {
      commandId,
      commandType: 'SET_STREGA_INTERVAL',
      status: 'ACKED',
      result: 'APPLIED',
      duplicate: false,
      reason: null,
      detail: null,
      eventUuid: null,
      aggregateType: null,
      aggregateKey: null,
      appliedAt: direct[0].raw.timestamp,
      requestedSyncVersion: null,
      appliedSyncVersion: null,
    };
    assertIsoTimestamp(direct[0].raw.timestamp, name + ' direct raw visit timestamp');
    assert.deepEqual(directPublished, expected, name + ' full exact first terminal envelope');
    assert.equal(Object.hasOwn(directPublished, 'transportPhase'), false);
    assert.equal(Object.hasOwn(directPublished, 'error'), false);
    assert.ok(postlogQueue.ledgerBeforeQueue, name + ' post-log visit sees first terminal owner');
    assert.deepEqual(postlogQueue.ledgerBeforeQueue.result_detail, directPublished);
    assert.deepEqual(postlogPublished, directPublished, name + ' post-log terminal replay preserves first timestamp');
  }
  assert.equal(rt.db.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id = ?').get(commandId).n, 0,
    name + ' local valve ACK does not create a cloud ACK outbox row');
}

function assertManualFailureAckEvidence(rt, name, scenario) {
  const lane = rt.lane(name);
  assertAckPublicationBijection(rt, name);
  const direct = lane.ackIngress.filter((visit) => visit.source === 'direct');
  assert.equal(direct.length, 1, `${name} ${scenario} has one raw direct ACK`);
  const rawVisit = direct[0];
  const raw = rawVisit.raw;
  assert.equal(raw.result, 'FAILED');
  assert.equal(raw.transportPhase, scenario === 'rejected' ? 'enqueue_rejected' :
    scenario === 'preacceptance' ? 'enqueue_failed_before_acceptance' :
      scenario === 'unknown' ? 'UNKNOWN' : 'valve_busy');
  assert.equal(lane.ackIngress.filter((visit) => visit.source === 'postlog').length, 0,
    `${name} ${scenario} has no post-log ACK visit`);
  assert.equal(lane.published.filter((entry) => entry.node === ID.statusMqtt).length, 0,
    `${name} ${scenario} has no post-log valve status`);
  const queue = lane.queueAcks.filter((entry) => entry.visit === rawVisit.visit &&
    String(entry.commandId) === String(raw.commandId));
  assert.equal(queue.length, 1, `${name} direct failure is queued once by its visit`);
  assert.deepEqual(queue[0].input, raw, `${name} failure queue input is the raw ACK`);
  assert.equal(rawVisit.lane, name);
  assert.equal(rawVisit.commandId, raw.commandId);
  const published = lane.published.filter((entry) => entry.node === ID.commandAckMqtt &&
    entry.fixtureAckVisit && entry.fixtureAckVisit.visit === rawVisit.visit);
  assert.equal(published.length, 1, `${name} direct failure publishes once`);
  assert.deepEqual(published[0].fixtureAckVisit, {
    lane: name, source: 'direct', visit: rawVisit.visit, commandId: raw.commandId,
  }, `${name} publication retains its exact raw source binding`);
  const actual = JSON.parse(published[0].payload);
  assert.deepEqual(actual, queue[0].branchResult, `${name} failure publication equals its own queue-function branch result`);
  const message = scenario === 'rejected' ? 'invalid enqueue request rejected by fixture' :
    scenario === 'preacceptance' ? 'local preflight failed by fixture' :
      scenario === 'unknown' ? 'reply lost after possible remote enqueue' : 'valve has an active or unresolved command';
  assert.equal(raw.error, message, `${name} raw error text is the classified fixture outcome`);
  const terminal = scenario === 'rejected';
  const expected = {
    commandId: raw.commandId,
    commandType: rt.scoped && terminal ? 'OPEN_FOR_DURATION' : 'SET_STREGA_INTERVAL',
    status: terminal ? 'NACKED' : 'FAILED_RETRYABLE',
    result: terminal ? 'REJECTED_PERMANENT' : 'FAILED_RETRYABLE',
    duplicate: false,
    reason: rt.scoped && terminal ? 'transport_pending' : message,
    ...(rt.scoped && terminal ? {} : { detail: message }),
    ...(rt.scoped && terminal ? { transportPhase: 'enqueue_rejected', error: message } : {}),
  };
  if (!(rt.scoped && terminal)) Object.assign(expected, {
    eventUuid: null, aggregateType: null, aggregateKey: null,
    appliedAt: raw.timestamp, requestedSyncVersion: null, appliedSyncVersion: null,
  });
  assertIsoTimestamp(raw.timestamp, `${name} ${scenario} raw visit timestamp`);
  assert.deepEqual(actual, expected, `${name} exact ${rt.scoped ? 'scoped owner replay' : 'new'} ${scenario} envelope`);
  if (scenario === 'busy') {
    assert.equal(queue[0].ledgerBeforeQueue, null, `${name} busy request has no stored command owner`);
    assert.equal(rt.db.prepare('SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE command_id=?').get(raw.commandId).n,
      0, `${name} busy request creates no expectation owner`);
    assert.equal(rt.db.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?').get(raw.commandId).n,
      0, `${name} busy request creates no command ledger owner`);
  } else if (rt.scoped) {
    const owner = queue[0].ledgerBeforeQueue;
    assert.ok(owner, `${name} scoped failure sees its prequeue owner`);
    const phase = scenario === 'rejected' ? 'enqueue_rejected' :
      scenario === 'preacceptance' ? 'enqueue_failed_before_acceptance' : 'UNKNOWN';
    const ownerResult = scenario === 'unknown' ? 'UNKNOWN' : 'REJECTED_PERMANENT';
    assert.equal(owner.command_type, 'OPEN_FOR_DURATION');
    assert.equal(owner.result, ownerResult);
    assert.equal(owner.last_error, message);
    assert.equal(owner.result_detail.result, ownerResult);
    assert.equal(owner.result_detail.status, scenario === 'unknown' ? 'UNKNOWN' : 'NACKED');
    assert.equal(owner.result_detail.reason, 'transport_pending');
    assert.equal(owner.result_detail.transportPhase, phase);
    assert.equal(owner.result_detail.error, message);
    assert.equal(Object.hasOwn(owner.result_detail, 'detail'), false);
    if (scenario === 'rejected') assert.deepEqual(actual, owner.result_detail, `${name} terminal replay returns stored detail`);
    else assert.notDeepEqual(actual, owner.result_detail, `${name} retry envelope does not replay the nonterminal owner`);
    const persisted = rt.db.prepare('SELECT command_type, result, result_detail, last_error FROM applied_commands WHERE command_id=?')
      .get(raw.commandId);
    assert.equal(persisted.command_type, owner.command_type);
    assert.equal(persisted.result, owner.result);
    assert.equal(persisted.last_error, owner.last_error);
    assert.deepEqual(JSON.parse(persisted.result_detail), owner.result_detail,
      `${name} ACK retry does not mutate the scoped owner`);
    const expectation = rt.db.prepare(
      'SELECT transport_json FROM valve_actuation_expectations WHERE command_id=? AND UPPER(device_eui)=UPPER(?)'
    ).get(raw.commandId, raw.deviceEui);
    assert.ok(expectation, `${name} scoped transport has an expectation row`);
    assert.equal(JSON.parse(expectation.transport_json).phase, phase);
    if (scenario === 'unknown') {
      assert.equal(JSON.parse(expectation.transport_json).queue_id, undefined);
      assert.equal(STUB_ACCEPTED.some((item) => item.devEui === String(raw.deviceEui).toUpperCase()), false,
        `${name} UNKNOWN is not accepted queue evidence`);
      assert.equal(STUB_POSSIBLE.filter((item) => item.devEui === String(raw.deviceEui).toUpperCase()).length, 1,
        `${name} possible remote enqueue remains separately represented`);
      assert.equal(STUB_QUEUE.filter((item) => item.devEui === String(raw.deviceEui).toUpperCase() &&
        item.certainty === 'possible_remote').length, 1,
      `${name} possible remote record remains visible in the live device queue`);
    }
  } else {
    assert.equal(queue[0].ledgerBeforeQueue, null, `${name} flag-off visit has no prequeue owner`);
    const stored = rt.db.prepare('SELECT command_type, result, result_detail FROM applied_commands WHERE command_id=?')
      .get(raw.commandId);
    if (terminal) {
      assert.ok(stored, `${name} flag-off terminal rejection stores its first owner`);
      assert.equal(stored.command_type, 'SET_STREGA_INTERVAL');
      assert.equal(stored.result, 'REJECTED_PERMANENT');
      assert.deepEqual(JSON.parse(stored.result_detail), expected,
        `${name} stored rejection retains full new-envelope metadata`);
    } else assert.equal(stored, undefined, `${name} retryable flag-off result does not create a terminal owner`);
  }
  assert.equal(rt.db.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?').get(raw.commandId).n,
    0, `${name} local command UUID is not sent through the cloud ACK outbox`);
}

function assertValveAccepted(rt, name, expected) {
  const userId = expected.userId === undefined ? USERS.res1.userId : expected.userId;
  const response = onlyResponse(rt, name);
  assert.equal(response.statusCode, 202, name + ' status: ' + JSON.stringify(response.payload));
  assert.equal(response.payload.deveui, expected.eui, name + ' response target');
  assert.equal(response.payload.action, 'OPEN_FOR_DURATION', name + ' response action');
  assert.equal(response.payload.duration_minutes, expected.minutes, name + ' response duration');
  assert.ok(response.payload.command_id, name + ' command id');

  const lane = rt.lane(name);
  const userLookups = lane.sql.filter((entry) => entry.node === ID.valveUserDb);
  assert.equal(userLookups.length, 1, name + ' own user lookup');
  assert.equal(userLookups[0].request.actorId, userId, name + ' lookup actor');
  assert.match(userLookups[0].topic, new RegExp('WHERE id = ' + userId + '\\b'), name + ' user SQL');
  const deviceLookups = lane.sql.filter((entry) => entry.node === ID.valveDeviceDb);
  assert.equal(deviceLookups.length, 1, name + ' own target lookup');
  assert.equal(deviceLookups[0].request.actorId, userId, name + ' target lookup actor');
  assert.equal(deviceLookups[0].request.targetEui, expected.eui, name + ' target lookup envelope');
  assert.match(deviceLookups[0].topic, new RegExp("WHERE deveui = '" + expected.eui + "'"), name + ' target SQL');
  if (expected.actorUuid) assert.equal(deviceLookups[0].actorUserUuid, expected.actorUuid, name + ' actor UUID');
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
  const logEntry = lane.logRows.find((entry) => entry.node === ID.valveWriteDb);
  assert.ok(logEntry, name + ' captures the request-scoped actuator_log row id');
  assert.ok(logEntry.id > rt.logBaseline, name + ' log row follows the seed baseline');
  const storedLog = rt.db.prepare(
    'SELECT id, deveui, action, duration_minutes, reason, irrigation_zone_id FROM actuator_log WHERE id = ?'
  ).get(logEntry.id);
  const fixtureZoneId = expected.zoneId === undefined
    ? (expected.eui === VALVE_FOREIGN ? 2 : 1)
    : expected.zoneId;
  assert.deepEqual({ ...storedLog }, {
    id: logEntry.id, deveui: expected.eui, action: 'OPEN_FOR_DURATION', duration_minutes: expected.minutes,
    reason: 'manual_gui', irrigation_zone_id: fixtureZoneId,
  }, name + ' request-owned actuator_log row');
  const expectation = rt.db.prepare(
    'SELECT expectation_id, device_eui, command_id, transport_json FROM valve_actuation_expectations WHERE command_id = ? AND UPPER(device_eui) = UPPER(?)'
  ).all(response.payload.command_id, expected.eui);
  assert.equal(expectation.length, 1, name + ' command and target own one expectation');
  const transport = JSON.parse(expectation[0].transport_json);
  assert.equal(transport.phase, 'ACCEPTED', name + ' accepted transport phase');
  assert.equal(transport.queue_id, response.payload.queue_id, name + ' response queue id matches persisted expectation');
  const acceptedQueue = STUB_ACCEPTED.filter((entry) => entry.id === transport.queue_id &&
    entry.devEui === String(expectation[0].device_eui).toUpperCase());
  assert.equal(acceptedQueue.length, 1, name + ' persisted queue id matches one accepted transport entry');
  assertManualAcceptedAckEvidence(rt, name, response.payload.command_id, response.payload.queue_id, logEntry.order);
  const laneA = rt.lane('A');
  const laneB = rt.lane('B');
  if (laneA.responses.some((item) => item.statusCode === 202) && laneB.responses.some((item) => item.statusCode === 202)) {
    const a = laneA.responses.find((item) => item.statusCode === 202).payload;
    const b = laneB.responses.find((item) => item.statusCode === 202).payload;
    assert.notEqual(a.command_id, b.command_id, 'A/B command ids are distinct');
    assert.notEqual(a.queue_id, b.queue_id, 'A/B accepted queue ids are distinct');
    assert.notDeepEqual([a.deveui, a.command_id, a.queue_id], [b.deveui, b.command_id, b.queue_id],
      'A/B accepted target-command-queue triples are distinct');
    const ids = STUB_ACCEPTED.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, 'accepted queue entry ids are unique');
  }
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
            A: { eui: VALVE_A, minutes: 12, userId: USERS.res1.userId, actorUuid: scoped ? 'u-res1' : null },
            B: { eui: VALVE_B, minutes: 3, userId: USERS.res1.userId, actorUuid: scoped ? 'u-res1' : null },
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
    assertValveAccepted(rt, 'B', { eui: VALVE_FOREIGN, minutes: 3, userId: USERS.admin1.userId });
  });
});

for (const scoped of [false, true]) {
  for (const boundary of VALVE_BOUNDARIES) {
    for (const paused of ['A', 'B']) {
      const other = paused === 'A' ? 'B' : 'A';
      test(`valve open: distinct owners keep own target at ${boundary}, ${paused} held (scoped ${scoped ? 'on' : 'off'})`, async () => {
        await withRuntime({ scoped }, async (rt) => {
          rt.inject('A', ID.valveHttp, valveMsg('A', { user: USERS.res1, eui: VALVE_A, minutes: 12 }));
          rt.inject('B', ID.valveHttp, valveMsg('B', { user: USERS.admin1, eui: VALVE_FOREIGN, minutes: 3 }));
          await rt.runUntil(paused, boundary);
          await rt.run(other);
          await rt.run(paused);
          assertValveAccepted(rt, 'A', {
            eui: VALVE_A, minutes: 12, userId: USERS.res1.userId,
            actorUuid: scoped ? USERS.res1.uuid : null,
          });
          assertValveAccepted(rt, 'B', {
            eui: VALVE_FOREIGN, minutes: 3, userId: USERS.admin1.userId,
            actorUuid: scoped ? USERS.admin1.uuid : null,
          });
        });
      });
    }
  }
}

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
      const response = onlyResponse(rt, 'A');
      assert.equal(response.statusCode, 409, 'owned sensor has the builder’s exact wrong-device-type status');
      assert.deepEqual(response.payload, { message: 'Device A840410000000004 is not a STREGA_VALVE' },
        'owned sensor has the literal wrong-device-type message');
      assertValveRejected(rt, 'A', 409);
      assert.equal(STUB_ACCEPTED.filter((entry) => entry.devEui === SENSOR).length, 0,
        'owned sensor creates no accepted transport queue entry');
      assert.equal(rt.db.prepare('SELECT COUNT(*) AS n FROM actuator_log WHERE UPPER(deveui)=UPPER(?)').get(SENSOR).n, 0,
        'owned sensor creates no actuator log row');
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
      assertValveAccepted(rt, 'A', { eui: VALVE_A, minutes: 12, userId: USERS.res1.userId });
      assertValveAccepted(rt, 'B', { eui: VALVE_B, minutes: 3, userId: USERS.res1.userId });
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

for (const scoped of [false, true]) {
  const mode = scoped ? 'on' : 'off';
  for (const scenario of ['rejected', 'preacceptance', 'unknown']) {
    test(`manual STREGA ${scenario} ACK binds raw visit, prequeue owner and publication (scoped ${mode})`, async () => {
      await withRuntime({ scoped, stubMode: scenario }, async (rt) => {
        rt.inject('A', ID.valveHttp, valveMsg('A', { eui: VALVE_A, minutes: 12 }));
        await rt.run('A');
        const response = onlyResponse(rt, 'A');
        assert.equal(response.statusCode, scenario === 'rejected' ? 422 : 503);
        assert.equal(response.payload.error, scenario === 'rejected' ? 'enqueue_rejected' :
          scenario === 'preacceptance' ? 'enqueue_failed_before_acceptance' : 'UNKNOWN');
        assertManualFailureAckEvidence(rt, 'A', scenario);
        assert.equal(STUB_ACCEPTED.length, 0, `${scenario} adds no accepted queue record`);
        assert.equal(rt.lane('A').links.filter((link) => link.node === ID.toActuator).length, 1,
          'transport result came through the real actuator encoder path');
      });
    });
  }
  test(`manual STREGA busy ACK has no A owner and preserves accepted B (scoped ${mode})`, async () => {
    await withRuntime({ scoped, directAckLanes: new Set(['A', 'B']) }, async (rt) => {
      rt.inject('A', ID.valveHttp, valveMsg('A', { eui: VALVE_A, minutes: 12 }));
      rt.inject('B', ID.valveHttp, valveMsg('B', { eui: VALVE_A, minutes: 3 }));
      await rt.runUntil('A', ID.valveDeviceDb);
      await rt.run('B');
      await rt.run('A');
      assert.equal(onlyResponse(rt, 'A').statusCode, 503);
      assert.equal(onlyResponse(rt, 'A').payload.error, 'valve_busy');
      assertManualFailureAckEvidence(rt, 'A', 'busy');
      assertValveAccepted(rt, 'B', { eui: VALVE_A, minutes: 3, actorUuid: scoped ? USERS.res1.uuid : null });
      assert.equal(rt.lane('A').sql.filter((entry) => entry.node === ID.valveWriteDb).length, 0,
        'busy A emits no log write');
    });
  });
}

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
    await withRuntime({ scoped: false, follow, directAckLanes: new Set(['manual']) }, async (rt) => {
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
      assertAckPublicationBijection(rt, 'manual');
      assertAckPublicationBijection(rt, 'cloud');
      const manualAcks = commandAcks(rt, 'manual');
      assert.equal(rt.lane('manual').ackIngress.filter((visit) => String(visit.commandId) === '501').length, 0,
        'manual raw ACK visits never acquire the adjacent cloud command id');
      assert.equal(rt.lane('manual').queueAcks.some((visit) => String(visit.commandId) === '501'), false,
        'manual queue visits never acquire the adjacent cloud command id');
      assert.deepEqual(
        manualAcks.filter((ack) => String(ack.commandId) === '501'),
        [],
        'a manual open must not acknowledge cloud command 501: ' + JSON.stringify(manualAcks)
      );
      const status = rt.lane('manual').published.filter((entry) => entry.node === ID.statusMqtt);
      assert.equal(status.length, 1, 'manual open still reports valve status');
      assert.equal(JSON.parse(status[0].payload).deviceEui, VALVE_A);

      const cloudRaw = rt.lane('cloud').ackIngress.filter((visit) => visit.source === 'postlog' && String(visit.commandId) === '501');
      assert.equal(cloudRaw.length, 1, 'cloud keeps its own raw post-log source visit');
      const cloudVisit = cloudRaw[0];
      assert.equal(cloudVisit.lane, 'cloud');
      assert.equal(cloudVisit.source, 'postlog');
      assert.equal(cloudVisit.commandId, 501);
      assert.equal(cloudVisit.raw.commandId, 501);
      assert.equal(cloudVisit.raw.result, 'SUCCESS');
      assert.equal(cloudVisit.raw.state, 'OPEN');
      assert.equal(cloudVisit.raw.commandType, 'OPEN_FOR_DURATION');
      assert.equal(cloudVisit.raw.eventUuid, '00000000-0000-4000-8000-000000000001');
      assert.equal(cloudVisit.raw.aggregateType, 'DEVICE');
      assert.equal(cloudVisit.raw.aggregateKey, VALVE_B);
      assert.equal(cloudVisit.raw.deviceEui, VALVE_B);
      assert.equal(cloudVisit.raw.gatewayDeviceEui, GATEWAY_EUI);
      assert.equal(cloudVisit.raw.appliedSyncVersion, 9);
      for (const field of ['error', 'reason', 'duplicate', 'requestedSyncVersion', 'requested_sync_version']) {
        assert.equal(Object.hasOwn(cloudVisit.raw, field), false,
          'cloud 501 raw post-log ACK omits ' + field + ' under the pinned source contract');
      }
      assertIsoTimestamp(cloudVisit.raw.timestamp, 'cloud 501 post-log raw visit timestamp');
      const expectedCloudEnvelope = expectedInitialCloudAck(cloudVisit.raw);
      const cloudPostlogQueue = rt.lane('cloud').queueAcks.filter((visit) => visit.lane === cloudVisit.lane &&
        visit.source === cloudVisit.source && visit.visit === cloudVisit.visit &&
        String(visit.commandId) === String(cloudVisit.commandId));
      assert.equal(cloudPostlogQueue.length, 1, 'cloud post-log visit queues once');
      assert.equal(cloudPostlogQueue[0].ownerId, '501', 'cloud owner lookup normalizes the numeric raw command ID');
      assert.equal(cloudPostlogQueue[0].ledgerBeforeQueue, null,
        'cloud post-log raw visit has no prequeue command owner');
      const cloudQueue = rt.lane('cloud').queueAcks.filter((visit) => String(visit.commandId) === String(cloudVisit.commandId));
      assert.equal(cloudQueue.length, 1, 'manual-only direct-link fixture follows one cloud queue visit');
      assert.deepEqual(cloudPostlogQueue[0].input, cloudVisit.raw,
        'cloud queue input matches its own lane/source/visit/command raw ACK');
      assert.deepEqual(cloudPostlogQueue[0].branchResult, expectedCloudEnvelope,
        'cloud queue branch constructs the complete initial ACK from its own raw visit and ledger recipe');
      const cloudPublication = rt.lane('cloud').published.filter((entry) => entry.node === ID.commandAckMqtt &&
        entry.fixtureAckVisit && entry.fixtureAckVisit.lane === cloudVisit.lane &&
        entry.fixtureAckVisit.source === cloudVisit.source && entry.fixtureAckVisit.visit === cloudVisit.visit &&
        String(entry.fixtureAckVisit.commandId) === String(cloudVisit.commandId));
      assert.equal(cloudPublication.length, 1, 'cloud publication is bound to its own post-log raw visit');
      assert.deepEqual(cloudPublication[0].fixtureAckVisit, {
        lane: cloudVisit.lane, source: cloudVisit.source, visit: cloudVisit.visit, commandId: cloudVisit.commandId,
      });
      assert.deepEqual(JSON.parse(cloudPublication[0].payload), expectedCloudEnvelope,
        'cloud full ACK envelope is pinned to the independently expected raw-visit recipe');
      assert.deepEqual(JSON.parse(cloudPublication[0].payload), cloudPostlogQueue[0].branchResult,
        'cloud publication equals its own lane/source/visit/command queue branch result');
      const persistedRows = rt.db.prepare(
        'SELECT command_id, command_type, result, applied_at, result_detail, originator, last_error ' +
        'FROM applied_commands WHERE command_id=?'
      ).all(String(cloudVisit.commandId));
      assert.equal(persistedRows.length, 1, 'cloud ACK persists exactly one command owner for its visit');
      const persisted = persistedRows.map((row) => ({
        command_id: row.command_id,
        command_type: row.command_type,
        result: row.result,
        applied_at: row.applied_at,
        result_detail: JSON.parse(row.result_detail),
        originator: row.originator,
        last_error: row.last_error,
      }));
      assert.deepEqual(persisted, [{
        command_id: String(cloudVisit.commandId),
        command_type: 'OPEN_FOR_DURATION',
        result: 'APPLIED',
        applied_at: expectedCloudEnvelope.appliedAt,
        result_detail: expectedCloudEnvelope,
        originator: 'edge',
        last_error: null,
      }], 'cloud post-queue persisted owner matches the exact own-visit ACK envelope');
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
  // Zone 1 is an update; zone 3 is a same-user create used by the historical cases.
  A: { zoneId: 1, zoneUuid: 'z-1', version: 5, patch: { trigger_metric: 'SWT_WM1', threshold_kpa: 40, duration_minutes: 12, response_mode: 'fixed', enabled: true } },
  B: { zoneId: 3, zoneUuid: 'z-3', version: 1, patch: { trigger_metric: 'SWT_2', threshold_kpa: 65, duration_minutes: 3, response_mode: 'aggressive', enabled: false } },
};
const SCHEDULE_OWNERS = {
  A: SCHEDULE.A,
  B: { zoneId: 2, zoneUuid: 'z-2', version: 1,
    patch: { trigger_metric: 'SWT_2', threshold_kpa: 65, duration_minutes: 3, response_mode: 'aggressive', enabled: false } },
};

for (const scoped of [false, true]) {
  for (const boundary of [ID.schedUserDb, ID.schedZoneDb, ID.schedWrite]) {
    for (const paused of ['A', 'B']) {
      const other = paused === 'A' ? 'B' : 'A';
      test(`schedule PUT: distinct owners keep own zone at ${boundary}, ${paused} held (scoped ${scoped ? 'on' : 'off'})`, async () => {
        await withRuntime({ scoped }, async (rt, db) => {
          rt.inject('A', ID.schedHttp, scheduleMsg('A', SCHEDULE.A));
          rt.inject('B', ID.schedHttp, scheduleMsg('B', SCHEDULE_OWNERS.B));
          await rt.runUntil(paused, boundary);
          await rt.run(other);
          await rt.run(paused);
          assertScheduleApplied(rt, db, 'A', { ...SCHEDULE.A, userId: USERS.res1.userId });
          assertScheduleApplied(rt, db, 'B', { ...SCHEDULE_OWNERS.B, userId: USERS.admin1.userId });
        });
      });
    }
  }
}

function assertScheduleApplied(rt, db, name, expected) {
  const userId = expected.userId === undefined
    ? (expected.zoneId === 2 ? USERS.admin1.userId : USERS.res1.userId)
    : expected.userId;
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

  // The write runs once, inside the lifecycle service, for this request only. The retired
  // Save to DB node is not reached by the HTTP route.
  assert.equal(rt.lane(name).ran.filter((id) => id === ID.schedWrite).length, 1, name + ' must run exactly one schedule write');
  assert.equal(rt.lane(name).sql.filter((entry) => entry.node === ID.schedSaveDb).length, 0, name + ' retired Save to DB node is unused');
  const userLookups = rt.lane(name).sql.filter((entry) => entry.node === ID.schedUserDb);
  assert.equal(userLookups.length, 1, name + ' user lookup');
  assert.equal(userLookups[0].authUserId, userId, name + ' pre-envelope auth actor');
  assert.equal(String(userLookups[0].reqParamsId), String(expected.zoneId), name + ' route zone id');
  assert.deepEqual(userLookups[0].reqBody, patch, name + ' pre-envelope request body');
  const zoneLookups = rt.lane(name).sql.filter((entry) => entry.node === ID.schedZoneDb);
  assert.equal(zoneLookups.length, 1, name + ' zone lookup');
  assert.equal(zoneLookups[0].request.actorId, userId, name + ' normalized actor');
  assert.equal(zoneLookups[0].request.zoneId, expected.zoneId, name + ' normalized zone');

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
  const scheduleEvents = db.prepare(
    "SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='SCHEDULE' AND aggregate_key=? AND op='SCHEDULE_UPSERTED'"
  ).get(expected.zoneUuid).n;
  assert.equal(scheduleEvents, expected.zoneId === 1 ? 1 : 0,
    name + ' source trigger emits one event for UPDATE and none for INSERT');
}

function assertScheduleRejected(rt, name, statusCode) {
  const response = onlyResponse(rt, name);
  assert.equal(response.statusCode, statusCode, name + ' status: ' + JSON.stringify(response.payload));
  assert.equal(rt.lane(name).sql.filter((entry) => entry.node === ID.schedSaveDb).length, 0, name + ' must not write');
}

const SCHEDULE_BOUNDARIES = [ID.schedUserDb, ID.schedZoneDb];

const HELPER_SUCCESS_SITES = [
  {
    chain: 'valve', nodeId: ID.valveAuth, method: 'get',
    sqlIncludes: 'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1',
  },
  {
    chain: 'valve', nodeId: ID.valveAuth, method: 'get',
    sqlIncludes: 'FROM devices d LEFT JOIN irrigation_zones iz',
  },
  {
    chain: 'valve', nodeId: ID.valveAuth, method: 'get',
    sqlIncludes: 'SELECT id, username, role, disabled_at, user_uuid FROM users WHERE user_uuid = ?',
  },
  { chain: 'valve', nodeId: ID.valveAuth, method: 'all', sqlIncludes: 'FROM irrigation_zones' },
  { chain: 'valve', nodeId: ID.valveAuth, method: 'all', sqlIncludes: 'FROM user_zone_assignments' },
  { chain: 'valve', nodeId: ID.valveAuth, method: 'all', sqlIncludes: 'FROM journal_plots' },
  { chain: 'valve', nodeId: ID.valveAuth, method: 'all', sqlIncludes: 'FROM user_plot_assignments' },
  { chain: 'valve', nodeId: ID.valveAuth, method: 'close', sqlIncludes: '' },
  {
    chain: 'schedule', nodeId: '70fcbea336401bd1', method: 'get',
    sqlIncludes: 'SELECT user_uuid, role FROM users WHERE id = ? AND username = ? LIMIT 1',
  },
  {
    chain: 'schedule', nodeId: '70fcbea336401bd1', method: 'get',
    sqlIncludes: 'SELECT zone_uuid FROM irrigation_zones WHERE id = ? AND deleted_at IS NULL',
  },
  {
    chain: 'schedule', nodeId: '70fcbea336401bd1', method: 'get',
    sqlIncludes: 'SELECT id, username, role, disabled_at, user_uuid FROM users WHERE user_uuid = ?',
  },
  { chain: 'schedule', nodeId: '70fcbea336401bd1', method: 'all', sqlIncludes: 'FROM irrigation_zones' },
  { chain: 'schedule', nodeId: '70fcbea336401bd1', method: 'all', sqlIncludes: 'FROM user_zone_assignments' },
  { chain: 'schedule', nodeId: '70fcbea336401bd1', method: 'all', sqlIncludes: 'FROM journal_plots' },
  { chain: 'schedule', nodeId: '70fcbea336401bd1', method: 'all', sqlIncludes: 'FROM user_plot_assignments' },
  { chain: 'schedule', nodeId: '70fcbea336401bd1', method: 'close', sqlIncludes: '' },
];

for (const site of HELPER_SUCCESS_SITES) {
  test(`${site.chain} scoped ingress: A holds completed ${site.method} result at ${site.sqlIncludes || 'close callback'}`, async () => {
    const gate = makeDbCallGate(matchingGate({
      nodeId: site.nodeId, method: site.method, sqlIncludes: site.sqlIncludes,
    }));
    await withRuntime({ scoped: true, dbCallGate: gate }, async (rt, db) => {
      if (site.chain === 'valve') {
        rt.inject('A', ID.valveHttp, valveMsg('A', { user: USERS.res1, eui: VALVE_A, minutes: 12 }));
        rt.inject('B', ID.valveHttp, valveMsg('B', { user: USERS.admin1, eui: VALVE_FOREIGN, minutes: 3 }));
      } else {
        rt.inject('A', ID.schedHttp, scheduleMsg('A', SCHEDULE.A));
        rt.inject('B', ID.schedHttp, scheduleMsg('B', SCHEDULE_OWNERS.B));
      }
      await rt.runUntil('A', site.nodeId);
      const { key } = rt.startStep('A');
      const held = await gate.waitForEvent((event) => heldAtSite(event, {
        lane: 'A', nodeId: site.nodeId, method: site.method, sqlIncludes: site.sqlIncludes,
      }), { lane: 'A', nodeId: site.nodeId, method: site.method, sqlIncludes: site.sqlIncludes, siteOccurrence: 1 });
      assert.equal(held.decisionKind, 'execute', 'the selector must match the source SQL/method site');
      assert.equal(held.siteOccurrence, 1, 'first SQL-site occurrence is independent of method ordinal');
      assert.equal(held.operationCount, site.method === 'close' ? 0 : 1,
        'helper SQL executes once; close holds callback delivery without SQL');
      assert.equal(held.error, null, 'successful helper operation has no captured error');
      await assert.rejects(rt.run('A'), /lane incomplete with in-flight step/,
        'an empty lane queue cannot hide the suspended Function');
      await rt.run('B');
      gate.events.push({ kind: 'b_completed', lane: 'B', beforeRelease: true });
      assert.equal(rt.lane('B').responses.length, 1, 'B completes before held A delivery');
      gate.release(held);
      await rt.settleStep(key);
      await rt.run('A');
      if (site.chain === 'valve') {
        assertValveAccepted(rt, 'A', { eui: VALVE_A, minutes: 12, userId: USERS.res1.userId, actorUuid: 'u-res1' });
        assertValveAccepted(rt, 'B', { eui: VALVE_FOREIGN, minutes: 3, userId: USERS.admin1.userId, actorUuid: 'u-admin' });
      } else {
        assertScheduleApplied(rt, db, 'A', { ...SCHEDULE.A, userId: USERS.res1.userId });
        assertScheduleApplied(rt, db, 'B', { ...SCHEDULE_OWNERS.B, userId: USERS.admin1.userId });
      }
      assert.equal(held.deliveries, 1, 'held result delivered exactly once');
      assertOneHeldCallTrace(gate, held, site.method === 'close' ? 0 : 1);
      assert.throws(() => gate.release(held), /released more than once/,
        'a held helper result cannot be delivered twice');
      assert.ok(gate.events.findIndex((event) => event.kind === 'b_completed') <
        gate.events.findIndex((event) => event.phase === 'delivery_released'),
        'B completion is recorded before release');
      assert.equal(gate.pendingCount, 0);
    });
  });
}

const HELPER_BUSY_CASES = [
  { chain: 'valve', nodeId: ID.valveAuth, method: 'get', sqlIncludes: 'SELECT user_uuid FROM users WHERE id = ?' },
  { chain: 'valve', nodeId: ID.valveAuth, method: 'get', sqlIncludes: 'FROM devices d LEFT JOIN irrigation_zones iz' },
  { chain: 'schedule', nodeId: '70fcbea336401bd1', method: 'get', sqlIncludes: 'SELECT user_uuid, role FROM users WHERE id = ?' },
  { chain: 'schedule', nodeId: '70fcbea336401bd1', method: 'get', sqlIncludes: 'SELECT zone_uuid FROM irrigation_zones WHERE id = ?' },
];

for (const site of HELPER_BUSY_CASES) {
  test(`${site.chain} scoped ingress: synthetic busy at ${site.sqlIncludes}`, async () => {
    const gate = makeDbCallGate(matchingGate({
      nodeId: site.nodeId, method: site.method, sqlIncludes: site.sqlIncludes, kind: 'synthetic_busy',
    }));
    await withRuntime({ scoped: true, dbCallGate: gate }, async (rt, db) => {
      if (site.chain === 'valve') {
        rt.inject('A', ID.valveHttp, valveMsg('A', { user: USERS.res1, eui: VALVE_A, minutes: 12 }));
        rt.inject('B', ID.valveHttp, valveMsg('B', { user: USERS.admin1, eui: VALVE_FOREIGN, minutes: 3 }));
      } else {
        rt.inject('A', ID.schedHttp, scheduleMsg('A', SCHEDULE.A));
        rt.inject('B', ID.schedHttp, scheduleMsg('B', SCHEDULE_OWNERS.B));
      }
      await rt.runUntil('A', site.nodeId);
      const { key } = rt.startStep('A');
      const held = await gate.waitForEvent((event) => heldAtSite(event, {
        lane: 'A', nodeId: site.nodeId, method: site.method, sqlIncludes: site.sqlIncludes,
      }), { lane: 'A', nodeId: site.nodeId, method: site.method, sqlIncludes: site.sqlIncludes, siteOccurrence: 1 });
      assert.equal(held.decisionKind, 'synthetic_busy');
      assert.equal(held.siteOccurrence, 1);
      assert.equal(held.operationCount, 0, 'synthetic busy is selected before db.prepare');
      assert.match(held.error, /SQLITE_BUSY/);
      await rt.run('B');
      gate.events.push({ kind: 'b_completed', lane: 'B', beforeRelease: true });
      gate.release(held);
      await rt.settleStep(key);
      await rt.run('A');
      if (site.chain === 'valve') {
        assertValveRejected(rt, 'A', 500);
        assertValveAccepted(rt, 'B', { eui: VALVE_FOREIGN, minutes: 3, userId: USERS.admin1.userId, actorUuid: 'u-admin' });
        assert.equal(rt.lane('A').sql.length, 0, 'helper failure occurs before Node-RED SQL or command');
        assert.equal(rt.lane('A').links.filter((link) => link.node === ID.toActuator).length, 0);
      } else {
        assertScheduleRejected(rt, 'A', 500);
        assertScheduleApplied(rt, db, 'B', { ...SCHEDULE_OWNERS.B, userId: USERS.admin1.userId });
        assert.equal(rt.lane('A').sql.length, 0, 'helper failure occurs before Node-RED SQL');
      }
      assertBusyErrorAttribution(gate, rt, held, 'A', site.nodeId);
      assert.equal(held.deliveries, 1);
      assertOneHeldCallTrace(gate, held, 0);
      assert.equal(gate.events.filter((event) => event === held).length, 1, 'selector matched one helper call');
    });
  });
}

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

const DELAYED_SQLITE_CASES = [
  { chain: 'valve', boundary: ID.valveUserDb, sql: 'SELECT id FROM users' },
  { chain: 'valve', boundary: ID.valveDeviceDb, sql: 'SELECT deveui, type_id' },
  { chain: 'valve', boundary: ID.valveWriteDb, sql: 'INSERT INTO actuator_log' },
  { chain: 'schedule', boundary: ID.schedUserDb, sql: 'SELECT id FROM users' },
  { chain: 'schedule', boundary: ID.schedZoneDb, sql: 'SELECT iz.id, iz.zone_uuid' },
];

for (const scoped of [false, true]) {
  for (const site of DELAYED_SQLITE_CASES) {
    for (const kind of ['execute', 'synthetic_busy']) {
      test(`${site.chain} SQLite ${site.boundary}: ${kind} operation held after completion (scoped ${scoped ? 'on' : 'off'})`, async () => {
        const gate = makeDbCallGate(matchingGate({
          nodeId: site.boundary,
          method: 'all',
          sqlIncludes: site.sql,
          kind,
        }));
        await withRuntime({ scoped, dbCallGate: gate }, async (rt, db) => {
          if (site.chain === 'valve') {
            rt.inject('A', ID.valveHttp, valveMsg('A', { user: USERS.res1, eui: VALVE_A, minutes: 12 }));
            rt.inject('B', ID.valveHttp, valveMsg('B', { user: USERS.admin1, eui: VALVE_FOREIGN, minutes: 3 }));
          } else {
            rt.inject('A', ID.schedHttp, scheduleMsg('A', SCHEDULE.A));
            rt.inject('B', ID.schedHttp, scheduleMsg('B', SCHEDULE_OWNERS.B));
          }
          await rt.runUntil('A', site.boundary);
          const { key } = rt.startStep('A');
          const held = await gate.waitForEvent((event) => heldAtSite(event, {
            lane: 'A', nodeId: site.boundary, method: 'all', sqlIncludes: site.sql,
          }), { lane: 'A', nodeId: site.boundary, method: 'all', sqlIncludes: site.sql, siteOccurrence: 1 });
          assert.equal(held.decisionKind, kind);
          assert.equal(held.siteOccurrence, 1, 'first matching SQL site has its own occurrence ordinal');
          assert.equal(held.operationCount, kind === 'execute' ? 1 : 0,
            'real operations execute once; synthetic busy skips prepare and execution');
          if (kind === 'synthetic_busy') assert.match(held.error, /SQLITE_BUSY/);
          else assert.equal(held.error, null, 'successful operation result is captured before delivery');
          assert.equal(rt.inFlight.has(key), true, 'held step remains in flight');

          if (site.chain === 'valve' && site.boundary === ID.valveWriteDb) {
            await rt.runReady('A');
            assert.equal(rt.lane('A').links.filter((link) => link.node === ID.toActuator).length, 1,
              'actuator link is already emitted while write delivery waits');
            assert.equal(rt.lane('A').responses.length, 1, 'HTTP 202 is already delivered while write waits');
            assert.equal(rt.lane('A').responses[0].statusCode, 202);
          }
          await assert.rejects(rt.run('A'), /lane incomplete with in-flight step/,
            'an empty queue with a held SQLite callback is incomplete');

          await rt.run('B');
          gate.events.push({ kind: 'b_completed', lane: 'B', beforeRelease: true });
          assert.equal(rt.lane('B').responses.length, 1, 'B completes before A receives its result');
          gate.release(held);
          await rt.settleStep(key);
          await rt.run('A');

          if (kind === 'synthetic_busy' && site.chain === 'valve' && site.boundary === ID.valveWriteDb) {
            assert.equal(rt.lane('A').responses.length, 1, 'write error does not create a second response');
            assert.equal(rt.lane('A').responses[0].statusCode, 202,
              'HTTP 202 from the independent builder output remains delivered');
            assert.equal(rt.lane('A').links.filter((link) => link.node === ID.toActuator).length, 1,
              'write error does not undo the already emitted actuator command');
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM actuator_log WHERE deveui = ?').get(VALVE_A).n, 0,
              'synthetic busy executed no A write');
            assert.notEqual(db.prepare('SELECT target_state FROM devices WHERE deveui = ?').get(VALVE_A).target_state,
              'OPEN', 'synthetic busy creates no device-row effect');
          } else if (kind === 'synthetic_busy') {
            if (site.chain === 'valve') assertValveRejected(rt, 'A', 500);
            else assertScheduleRejected(rt, 'A', 500);
            if (site.boundary !== ID.valveWriteDb) {
              const expectedPrefix = site.boundary === ID.valveDeviceDb
                ? [ID.valveUserDb, ID.valveDeviceDb]
                : site.boundary === ID.schedZoneDb
                  ? [ID.schedUserDb, ID.schedZoneDb]
                  : [site.boundary];
              assert.deepEqual(rt.lane('A').sql.map((entry) => entry.node), expectedPrefix,
                'read error has no SQL step after the failed node');
            }
          } else if (site.chain === 'valve') {
            assertValveAccepted(rt, 'A', { eui: VALVE_A, minutes: 12, userId: USERS.res1.userId,
              actorUuid: scoped ? USERS.res1.uuid : null });
            assertValveAccepted(rt, 'B', { eui: VALVE_FOREIGN, minutes: 3, userId: USERS.admin1.userId,
              actorUuid: scoped ? USERS.admin1.uuid : null });
            if (site.boundary === ID.valveWriteDb && kind === 'execute') {
              const target = db.prepare('SELECT target_state FROM devices WHERE deveui = ?').get(VALVE_A);
              assert.notEqual(target.target_state, 'OPEN',
                'known source-faithful discrepancy: one msg.topic all() call inserts the log but not appended target UPDATE');
              assert.equal(db.prepare('SELECT COUNT(*) AS n FROM actuator_log WHERE deveui = ?').get(VALVE_A).n, 1,
                'first statement inserted the actuator log row');
            }
          } else {
            if (kind === 'execute') assertScheduleApplied(rt, db, 'A', { ...SCHEDULE.A, userId: USERS.res1.userId });
            assertScheduleApplied(rt, db, 'B', { ...SCHEDULE_OWNERS.B, userId: USERS.admin1.userId });
          }

          if (kind === 'synthetic_busy') {
            assertBusyErrorAttribution(gate, rt, held, 'A', site.boundary, {
              downstreamAccepted: site.chain === 'valve' && site.boundary === ID.valveWriteDb,
            });
          }

          const sqlEntry = rt.lane('A').sql.find((entry) => entry.node === site.boundary);
          assert.equal(sqlEntry.gateKind, kind);
          assert.equal(sqlEntry.operationCount, kind === 'execute' ? 1 : 0);
          assert.equal(held.deliveries, 1, 'one captured result/error delivery, no retry');
          assertOneHeldCallTrace(gate, held, kind === 'execute' ? 1 : 0);
          assert.throws(() => gate.release(held), /released more than once/,
            'a released SQLite result cannot be delivered twice');
          assert.equal(gate.pendingCount, 0);
          assert.ok(gate.events.findIndex((event) => event.kind === 'b_completed') <
            gate.events.findIndex((event) => event.phase === 'delivery_released'), 'B completes before release');
        });
      });
    }
  }
}

test('valve ingress negative control: resumed A detects shared-key target overwrite before SQLite', async () => {
  const original = flowNode(ID.valveAuth);
  let func = original.func;
  func = func.replace(
    "const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();",
    "const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();\nflow.set('valve_cmd_target', deveui);"
  );
  func = func.replace(
    '    const actor = await scopeDb.get(\n      \'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1\',\n      [auth.userId, auth.username]\n    );',
    '    const actor = await scopeDb.get(\n      \'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1\',\n      [auth.userId, auth.username]\n    );\n    const resumedTargetEui = flow.get(\'valve_cmd_target\');\n    if (auth.userId === 2 && resumedTargetEui !== deveui) {\n      throw new Error(\'target isolation control expected actorId=2 targetEui=\' + deveui + \' but resumed actorId=\' + auth.userId + \' targetEui=\' + resumedTargetEui);\n    }'
  );
  assert.notEqual(func, original.func, 'test-local clone must patch the shipped ingress body');
  const gate = makeDbCallGate(matchingGate({
    nodeId: ID.valveAuth, method: 'get', sqlIncludes: 'SELECT user_uuid FROM users WHERE id = ?',
  }));
  const clone = { ...original, func };
  await withRuntime({ scoped: true, dbCallGate: gate, functionOverrides: new Map([[ID.valveAuth, clone]]) }, async (rt) => {
    rt.inject('A', ID.valveHttp, valveMsg('A', { user: USERS.res1, eui: VALVE_A, minutes: 12 }));
    rt.inject('B', ID.valveHttp, valveMsg('B', { user: USERS.res1, eui: VALVE_B, minutes: 3 }));
    await rt.runUntil('A', ID.valveAuth);
    const { key } = rt.startStep('A');
    const held = await gate.waitForEvent((event) => heldAtSite(event, {
      lane: 'A', nodeId: ID.valveAuth, method: 'get', sqlIncludes: 'SELECT user_uuid FROM users WHERE id = ?',
    }), { lane: 'A', nodeId: ID.valveAuth, method: 'get', sqlIncludes: 'SELECT user_uuid FROM users WHERE id = ?', siteOccurrence: 1 });
    assert.equal(held.operationCount, 1);
    await rt.run('B');
    gate.events.push({ kind: 'b_completed', lane: 'B', beforeRelease: true });
    gate.release(held);
    assertOneHeldCallTrace(gate, held, 1);
    await rt.settleStep(key);
    await rt.run('A');
    const response = onlyResponse(rt, 'A');
    assert.equal(response.statusCode, 500);
    assert.equal(response.payload.message,
      'target isolation control expected actorId=2 targetEui=' + VALVE_A + ' but resumed actorId=2 targetEui=' + VALVE_B);
    assert.equal(rt.lane('A').sql.length, 0, 'intended mismatch occurs before downstream SQLite');
    assert.equal(rt.lane('A').links.filter((link) => link.node === ID.toActuator).length, 0);
    assertValveAccepted(rt, 'B', { eui: VALVE_B, minutes: 3, userId: USERS.res1.userId, actorUuid: 'u-res1' });
    rt.tabContext.get('device-api-tab').delete('valve_cmd_target');
  });
});

test('cloned ingress mutant: removing the shared-key read changes the discriminator to 202', async () => {
  const original = flowNode(ID.valveAuth);
  const func = original.func.replace(
    "const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();",
    "const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();\nflow.set('valve_cmd_target', deveui);"
  );
  assert.notEqual(func, original.func, 'test-local mutant retains only the shared write');
  const gate = makeDbCallGate(matchingGate({
    nodeId: ID.valveAuth, method: 'get', sqlIncludes: 'SELECT user_uuid FROM users WHERE id = ?',
  }));
  await withRuntime({ scoped: true, dbCallGate: gate, functionOverrides: new Map([[ID.valveAuth, { ...original, func }]]) }, async (rt) => {
    rt.inject('A', ID.valveHttp, valveMsg('A', { user: USERS.res1, eui: VALVE_A, minutes: 12 }));
    rt.inject('B', ID.valveHttp, valveMsg('B', { user: USERS.res1, eui: VALVE_B, minutes: 3 }));
    await rt.runUntil('A', ID.valveAuth);
    const { key } = rt.startStep('A');
    const held = await gate.waitForEvent((event) => heldAtSite(event, {
      lane: 'A', nodeId: ID.valveAuth, method: 'get', sqlIncludes: 'SELECT user_uuid FROM users WHERE id = ?',
    }), { lane: 'A', nodeId: ID.valveAuth, method: 'get', sqlIncludes: 'SELECT user_uuid FROM users WHERE id = ?', siteOccurrence: 1 });
    await rt.run('B');
    gate.release(held);
    assertOneHeldCallTrace(gate, held, 1);
    await rt.settleStep(key);
    await rt.run('A');
    const response = onlyResponse(rt, 'A');
    assert.equal(response.statusCode, 202, 'without the shared-key read the cloned request succeeds');
    assert.throws(() => assert.equal(response.statusCode, 500), /202 !== 500/,
      'the guard control fails with the specific 202-versus-500 discriminator');
    rt.tabContext.get('device-api-tab').delete('valve_cmd_target');
    assertValveAccepted(rt, 'A', { eui: VALVE_A, minutes: 12, actorUuid: USERS.res1.uuid });
    assertValveAccepted(rt, 'B', { eui: VALVE_B, minutes: 3, actorUuid: USERS.res1.uuid });
  });
});

test('schedule lifecycle route stores the updated row and source-triggered sync event', async () => {
  await withRuntime({ scoped: false }, async (rt, db) => {
    rt.inject('A', ID.schedHttp, scheduleMsg('A', SCHEDULE.A));
    await rt.run('A');
    assertScheduleApplied(rt, db, 'A', { ...SCHEDULE.A, userId: USERS.res1.userId });
    assert.equal(rt.lane('A').ran.filter((id) => id === ID.schedWrite).length, 1,
      'reachable lifecycle Function executes once');
    assert.equal(rt.lane('A').sql.filter((entry) => entry.node === ID.schedSaveDb).length, 0,
      'retired Save to DB is not a route boundary');
  });
});

test('schedule lifecycle zoneByRef read holds before transaction; disjoint B commits before A release', async () => {
  const sql = 'SELECT * FROM irrigation_zones WHERE id=? AND deleted_at IS NULL LIMIT 1';
  const gate = makeDbCallGate(matchingGate({ nodeId: ID.schedWrite, method: 'get', sqlIncludes: sql, params: [1] }));
  await withRuntime({ scoped: false, dbCallGate: gate }, async (rt, db) => {
    rt.inject('A', ID.schedHttp, scheduleMsg('A', SCHEDULE.A));
    rt.inject('B', ID.schedHttp, scheduleMsg('B', SCHEDULE.B));
    await rt.runUntil('A', ID.schedWrite);
    const { key } = rt.startStep('A');
    const held = await gate.waitForEvent((event) => heldAtSite(event, {
      lane: 'A', nodeId: ID.schedWrite, method: 'get', sqlIncludes: sql,
    }), { lane: 'A', nodeId: ID.schedWrite, method: 'get', sqlIncludes: sql, siteOccurrence: 1 });
    assert.equal(held.decisionKind, 'execute');
    assert.equal(held.operationCount, 1);
    assert.equal(gate.events.some((event) => event.phase === 'transaction_begin' && event.lane === 'A'), false,
      'zoneByRef is delivered before A opens its writer transaction');
    await rt.run('B');
    assertScheduleApplied(rt, db, 'B', { ...SCHEDULE.B, userId: USERS.res1.userId });
    gate.release(held);
    await rt.settleStep(key);
    await rt.run('A');
    assertScheduleApplied(rt, db, 'A', { ...SCHEDULE.A, userId: USERS.res1.userId });
    assertOneHeldCallTrace(gate, held, 1);
    const bCommit = gate.events.findIndex((event) => event.phase === 'transaction_commit' && event.lane === 'B');
    const bDone = gate.events.findIndex((event) => event.phase === 'b_completed' && event.lane === 'B');
    const aRelease = gate.events.findIndex((event) => event.phase === 'delivery_released' && event.callId === held.callId);
    const aBegin = gate.events.findIndex((event) => event.phase === 'transaction_begin' && event.lane === 'A');
    assert.ok(bCommit >= 0 && bCommit < bDone && bDone < aRelease && aRelease < aBegin,
      'B commits and completes before A receives its selected zoneByRef result');
  });
});

test('known valve product discrepancy: combined topic logs open but target_state remains unchanged', async () => {
  await withRuntime({ scoped: false }, async (rt, db) => {
    rt.inject('A', ID.valveHttp, valveMsg('A', { user: USERS.res1, eui: VALVE_A, minutes: 12 }));
    await rt.run('A');
    assertValveAccepted(rt, 'A', { eui: VALVE_A, minutes: 12, userId: USERS.res1.userId });
    const topic = rt.lane('A').sql.find((entry) => entry.node === ID.valveWriteDb).topic;
    assert.match(topic, /^INSERT INTO actuator_log[\s\S]*;\s*UPDATE devices\s+SET target_state/);
    const row = db.prepare('SELECT target_state FROM devices WHERE deveui = ?').get(VALVE_A);
    assert.notEqual(row.target_state, 'OPEN',
      'source-faithful single prepare/all executes the first statement; this is not both-effect acceptance');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM actuator_log WHERE deveui = ?').get(VALVE_A).n, 1);
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
function seedZoneDelete(db, { includeZone3Schedule = true } = {}) {
  const zone3Schedule = includeZone3Schedule
    ? "(3, 'SWT_3', 70, 8, 1, 'aggressive', 6)"
    : null;
  db.exec(`
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
      VALUES ('${ZONE3_SENSOR}', 'Sensor Z3', 'DRAGINO_LSN50', 2, 3, '2026-01-01', '2026-01-01');
    INSERT INTO journal_plots (plot_uuid, plot_code, name, zone_uuid, owner_user_uuid)
      VALUES ('p-3', 'P3', 'Plot 3', 'z-3', 'u-res1');
    INSERT INTO irrigation_schedules
      (irrigation_zone_id, trigger_metric, threshold_kpa, duration_minutes, enabled, response_mode, sync_version)
      VALUES (2, 'SWT_2', 50, 10, 1, 'fixed', 2)${zone3Schedule ? ', ' + zone3Schedule : ''};
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
    zones: plain(db.prepare('SELECT *, deleted_at IS NOT NULL AS deleted FROM irrigation_zones ORDER BY id').all()),
    devices: plain(db.prepare('SELECT * FROM devices ORDER BY deveui').all()),
    schedules: plain(db.prepare('SELECT * FROM irrigation_schedules ORDER BY irrigation_zone_id').all()),
    userZoneAssignments: plain(db.prepare('SELECT * FROM user_zone_assignments ORDER BY assignment_uuid').all()),
    journalPlots: plain(db.prepare('SELECT * FROM journal_plots ORDER BY plot_uuid').all()),
    outbox: plain(db.prepare('SELECT * FROM sync_outbox ORDER BY rowid').all()),
  };
}

function isCanonicalIsoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isCanonicalSqliteTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)) return false;
  const iso = value.replace(' ', 'T') + '.000Z';
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString() === iso;
}

function isCanonicalFixtureDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const iso = value + 'T00:00:00.000Z';
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === value;
}

function assertIsoTimestamp(value, label) {
  assert.equal(isCanonicalIsoTimestamp(value), true, label + ' is a canonical ISO timestamp');
}

function assertTimestampValue(value, label) {
  if (value == null) return;
  if (typeof value !== 'string') {
    assert.fail(label + ' must be a timestamp string or null');
  }
  if (/^\d{4}-\d\d-\d\dT/.test(value)) assertIsoTimestamp(value, label);
  else if (isCanonicalSqliteTimestamp(value)) return;
  else assert.equal(isCanonicalFixtureDate(value), true, label + ' is a fixture date, SQLite timestamp, or canonical ISO timestamp');
}

function assertPayloadTimestamps(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPayloadTimestamps(item, label + '[' + index + ']'));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const field = label + '.' + key;
    if (/(?:_at|At)$/.test(key)) {
      assertTimestampValue(item, field);
    } else assertPayloadTimestamps(item, field);
  }
}

function assertZoneGeneratedEvidence(state, label) {
  for (const [table, rows] of Object.entries({
    zones: state.zones,
    devices: state.devices,
    schedules: state.schedules,
    grants: state.userZoneAssignments,
    plots: state.journalPlots,
  })) {
    for (const row of rows) for (const [key, value] of Object.entries(row)) {
      if (/(?:_at|At)$/.test(key)) assertTimestampValue(value, label + ' ' + table + '.' + key);
    }
  }
  const deletedZones = state.zones.filter((row) => row.deleted_at != null);
  const tombstones = new Set(deletedZones.map((row) => row.updated_at));
  for (const zone of deletedZones) {
    assertIsoTimestamp(zone.deleted_at, label + ' zone ' + zone.zone_uuid + ' deleted_at');
    assertIsoTimestamp(zone.updated_at, label + ' zone ' + zone.zone_uuid + ' updated_at');
    assert.equal(zone.updated_at, zone.deleted_at, label + ' zone tombstone and update timestamps agree');
  }
  for (const row of state.devices.filter((item) => tombstones.has(item.updated_at))) {
    assertIsoTimestamp(row.updated_at, label + ' device ' + row.deveui + ' updated_at');
  }
  for (const row of state.userZoneAssignments.filter((item) => item.deleted_at != null)) {
    assertIsoTimestamp(row.deleted_at, label + ' grant ' + row.assignment_uuid + ' deleted_at');
    assertIsoTimestamp(row.updated_at, label + ' grant ' + row.assignment_uuid + ' updated_at');
    assert.equal(row.updated_at, row.deleted_at, label + ' grant tombstone and update timestamps agree');
  }
  for (const row of state.journalPlots.filter((item) => tombstones.has(item.updated_at))) {
    assertIsoTimestamp(row.updated_at, label + ' plot ' + row.plot_uuid + ' updated_at');
  }
  for (const row of state.schedules.filter((item) => item.deleted_at != null)) {
    assertIsoTimestamp(row.deleted_at, label + ' schedule ' + row.id + ' deleted_at');
    assertIsoTimestamp(row.updated_at, label + ' schedule ' + row.id + ' updated_at');
    assert.equal(row.updated_at, row.deleted_at, label + ' schedule tombstone and update timestamps agree');
  }

  const eventUuids = new Set();
  for (const event of state.outbox) {
    assert.match(event.event_uuid, /^[0-9a-f]{32}$/, label + ' outbox event UUID format');
    assert.equal(eventUuids.has(event.event_uuid), false, label + ' outbox event UUID uniqueness');
    eventUuids.add(event.event_uuid);
    assertIsoTimestamp(event.occurred_at, label + ' outbox ' + event.op + ' occurred_at');
    const payload = JSON.parse(event.payload_json);
    assertPayloadTimestamps(payload, label + ' outbox ' + event.op + ' payload');
    if (event.op === 'ZONE_DELETED') {
      const zone = deletedZones.find((row) => row.zone_uuid === event.aggregate_key);
      assert.ok(zone, label + ' ZONE_DELETED event has a tombstoned zone');
      assert.equal(payload.zone_uuid, zone.zone_uuid);
      assert.equal(payload.deleted_at, zone.deleted_at,
        label + ' ZONE_DELETED payload timestamp equals its zone tombstone');
      assert.equal(payload.sync_version, zone.sync_version);
      assert.equal(event.sync_version, zone.sync_version);
    }
    if (event.aggregate_type === 'SCHEDULE' && payload.deleted_at != null) {
      assertIsoTimestamp(payload.deleted_at, label + ' schedule payload.deleted_at');
      const schedule = state.schedules.find((row) => row.deleted_at === payload.deleted_at &&
        row.sync_version === payload.sync_version &&
        state.zones.some((zone) => zone.id === row.irrigation_zone_id && zone.zone_uuid === event.aggregate_key));
      assert.ok(schedule, label + ' schedule tombstone payload matches a deleted schedule row');
    }
  }
}

function stableZoneState(state) {
  const normalizeTimes = (value) => {
    if (Array.isArray(value)) return value.map(normalizeTimes);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = /(?:_at|At)$/.test(key) &&
        (isCanonicalIsoTimestamp(item) || isCanonicalSqliteTimestamp(item))
        ? '<generated-timestamp>' : normalizeTimes(item);
    }
    return result;
  };
  const semanticOutbox = state.outbox.map((row) => ({
    ...row,
    event_uuid: '<generated-event-uuid>',
    occurred_at: '<generated-timestamp>',
    payload_json: JSON.stringify(normalizeTimes(JSON.parse(row.payload_json))),
  }));
  // Serial and interleaved runs commit the two zone deletes in different orders. Compare their
  // event multiset by semantic identity; each interleaved transaction's order is asserted below.
  semanticOutbox.sort((left, right) => JSON.stringify([
    left.aggregate_type, left.aggregate_key, left.op, left.sync_version, left.payload_json,
    left.delivered_at, left.retry_count, left.gateway_device_eui, left.rejected_at,
    left.rejection_reason, left.last_retryable_failure_at, left.rejection_code,
    left.rejection_class, left.recovery_generation,
  ]).localeCompare(JSON.stringify([
    right.aggregate_type, right.aggregate_key, right.op, right.sync_version, right.payload_json,
    right.delivered_at, right.retry_count, right.gateway_device_eui, right.rejected_at,
    right.rejection_reason, right.last_retryable_failure_at, right.rejection_code,
    right.rejection_class, right.recovery_generation,
  ])));
  return {
    ...state,
    zones: state.zones.map(normalizeTimes),
    devices: state.devices.map(normalizeTimes),
    schedules: state.schedules.map(normalizeTimes),
    userZoneAssignments: state.userZoneAssignments.map(normalizeTimes),
    journalPlots: state.journalPlots.map(normalizeTimes),
    // Event UUID/timestamps are normalized only after per-run validation. Semantic fields,
    // payload versions and row multiplicity remain; transaction order is checked separately.
    outbox: semanticOutbox,
  };
}

// The effect of running the same requests one after another, without interleaving,
// on a fresh database: the oracle every interleaving must reproduce.
async function serialZoneState(requests) {
  scopeHelper._resetForTests();
  const db = seedDb();
  try {
    seedZoneDelete(db);
    const rt = new FlowRuntime(db, { scoped: false });
    let checkpoint = zoneState(db);
    for (const [lane, nodeId, msg] of requests) {
      rt.inject(lane, nodeId, msg);
      await rt.run(lane);
      if (nodeId === ZD.http) {
        const zoneId = Number(msg.req.params.id);
        const spec = Object.values(ZONE_DELETE).find((item) => item.zoneId === zoneId);
        assert.ok(spec, 'independent serial request names a seeded zone');
        assertZoneDeleted(rt, db, lane, spec, checkpoint);
        checkpoint = zoneState(db);
      }
    }
    const state = zoneState(db);
    assertZoneGeneratedEvidence(state, 'independent serial run');
    return state;
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
}

function lanesSql(rt, name, nodeId) {
  return rt.lane(name).sql.filter((entry) => entry.node === nodeId).map((entry) => entry.topic);
}

function expectedFixtureOwner(db, userId) {
  const fixture = Object.values(USERS).find((user) => user.userId === Number(userId));
  assert.ok(fixture, 'outbox owner is one of the independently seeded fixture users');
  const row = db.prepare(
    'SELECT user_uuid, username, server_username, cloud_user_id FROM users WHERE id=?'
  ).get(userId);
  assert.ok(row, 'fixture owner row exists in the seeded database');
  const actual = {
    user_uuid: row.user_uuid,
    username: row.username,
    server_username: row.server_username,
    cloud_user_id: row.cloud_user_id,
  };
  const expected = {
    user_uuid: fixture.uuid,
    username: fixture.username,
    server_username: null,
    cloud_user_id: null,
  };
  assert.deepEqual(actual, expected, 'fixture owner identity remains at its independently seeded values');
  return expected;
}

function expectedDeviceUnassignedPayload(db, device) {
  const user = device.user_id == null ? null : expectedFixtureOwner(db, device.user_id);
  return {
    contract_version: 1,
    device_eui: device.deveui,
    name: device.name,
    type: device.type_id,
    claimed_user_uuid: user ? user.user_uuid : null,
    claimed_by_username: user ? (user.server_username == null ? user.username : user.server_username) : null,
    zone_uuid: null,
    dendro_enabled: device.dendro_enabled,
    temp_enabled: device.temp_enabled,
    rain_gauge_enabled: device.rain_gauge_enabled,
    flow_meter_enabled: device.flow_meter_enabled,
    is_reference_tree: device.is_reference_tree,
    current_state: device.current_state,
    target_state: device.target_state,
    strega_model: device.strega_model,
    sdi12_probe_profile: device.sdi12_probe_profile,
    sdi12_value_count: device.sdi12_value_count,
    sdi12_channel_layout_json: device.sdi12_channel_layout_json == null
      ? null
      : JSON.parse(device.sdi12_channel_layout_json),
    soil_moisture_probe_depths_json: JSON.parse(device.soil_moisture_probe_depths_json || '{}'),
    soil_moisture_probe_depths_configured: device.soil_moisture_probe_depths_configured || 0,
    chameleon_enabled: device.chameleon_enabled,
    chameleon_swt1_depth_cm: device.chameleon_swt1_depth_cm,
    chameleon_swt2_depth_cm: device.chameleon_swt2_depth_cm,
    chameleon_swt3_depth_cm: device.chameleon_swt3_depth_cm,
    gateway_device_eui: device.gateway_device_eui == null ? GATEWAY_EUI : device.gateway_device_eui,
    sync_version: device.sync_version,
    deleted_at: device.deleted_at,
  };
}

function expectedScheduleDeletedPayload(schedule, zoneUuid) {
  return {
    contract_version: 1,
    zone_uuid: zoneUuid,
    trigger_metric: schedule.trigger_metric,
    threshold_kpa: schedule.threshold_kpa,
    enabled: schedule.enabled,
    duration_minutes: schedule.duration_minutes,
    response_mode: schedule.response_mode,
    sync_version: schedule.sync_version,
    deleted_at: schedule.deleted_at,
    last_applied_at: schedule.last_applied_at,
  };
}

function expectedZoneDeletedPayload(db, zone, originalZone) {
  const user = expectedFixtureOwner(db, zone.user_id);
  const expected = {
    contract_version: 1,
    zone_uuid: zone.zone_uuid,
    name: zone.name,
    gateway_device_eui: zone.gateway_device_eui == null ? GATEWAY_EUI : zone.gateway_device_eui,
    timezone: zone.timezone,
    latitude: zone.latitude,
    longitude: zone.longitude,
    phenological_stage: zone.phenological_stage,
    stage_started_on: zone.stage_started_on,
    calibration_key: zone.calibration_key,
    crop_type: zone.crop_type,
    variety: zone.variety,
    soil_type: zone.soil_type,
    irrigation_method: zone.irrigation_method,
    area_m2: zone.area_m2,
    irrigation_efficiency_pct: zone.irrigation_efficiency_pct,
    scheduling_mode: zone.scheduling_mode == null ? 'local' : zone.scheduling_mode,
    prediction_card_enabled: zone.prediction_card_enabled || 0,
    notes: zone.notes,
    sync_version: zone.sync_version,
    deleted_at: zone.deleted_at,
    user: {
      user_uuid: user.user_uuid,
      username: user.username,
      cloudUserId: user.cloud_user_id,
    },
  };
  const weatherSource = zone.weather_source == null ? 'auto' : zone.weather_source;
  if (weatherSource !== 'auto' || originalZone.weather_source !== zone.weather_source) {
    expected.weather_source = weatherSource;
  }
  return expected;
}

function assertZoneDeleted(rt, db, name, spec, before) {
  const response = onlyResponse(rt, name);
  assert.equal(response.statusCode, 200, name + ' status: ' + JSON.stringify(response.payload));
  assert.deepEqual(response.payload, {
    message: 'Zone removed successfully', zone_uuid: spec.zoneUuid, disabledSchedules: 0, clear_results: [],
  }, name + ' exact four-field delete response');
  assert.equal(rt.lane(name).links.filter((link) => link.node === ZD.flushLink).length, 1, name + ' outbox flush ping');
  // The writes run inside the lifecycle service, once, for this request: the router ran once and
  // the retired legacy write nodes were not reached. The database state below is the evidence.
  assert.equal(rt.lane(name).ran.filter((id) => id === ZD.router).length, 1, name + ' one lifecycle delete');
  for (const nodeId of ZD_WRITES) assert.equal(lanesSql(rt, name, nodeId).length, 0, name + ' legacy write node ' + nodeId + ' unused');
  const beforeZone = before.zones.find((zone) => zone.id === spec.zoneId);
  assert.ok(before.devices.some((row) => row.irrigation_zone_id === spec.zoneId),
    name + ' fixture has a device assigned to target zone ' + spec.zoneId);
  assert.ok(before.userZoneAssignments.some((row) => row.zone_uuid === spec.zoneUuid && row.deleted_at == null),
    name + ' fixture has an active user-zone grant for ' + spec.zoneUuid);
  assert.ok(before.journalPlots.some((row) => row.zone_uuid === spec.zoneUuid && row.deleted_at == null),
    name + ' fixture has an active journal plot for ' + spec.zoneUuid);

  const after = zoneState(db);
  const zone = after.zones.find((row) => row.id === spec.zoneId);
  assert.equal(zone.deleted, 1, name + ' zone ' + spec.zoneId + ' soft-deleted');
  assert.equal(zone.sync_version, beforeZone.sync_version + 1, name + ' zone sync_version');
  assert.ok(zone.deleted_at, name + ' zone stores the tombstone timestamp');
  assertIsoTimestamp(zone.deleted_at, name + ' zone deleted_at');
  assertIsoTimestamp(zone.updated_at, name + ' zone updated_at');
  assert.equal(zone.updated_at, zone.deleted_at, name + ' zone tombstone and update use the same lifecycle instant');
  const expectedZones = before.zones.map((row) => row.id === spec.zoneId
    ? { ...row, deleted_at: zone.deleted_at, updated_at: zone.updated_at, sync_version: Number(row.sync_version || 0) + 1, deleted: 1 }
    : row);
  assert.deepEqual(after.zones, expectedZones, name + ' exact target zone mutation and unchanged other zones');
  const expectedZone = expectedZones.find((row) => row.id === spec.zoneId);

  const expectedDevices = before.devices.map((row) => row.irrigation_zone_id === spec.zoneId
    ? { ...row, irrigation_zone_id: null, updated_at: zone.updated_at, sync_version: Number(row.sync_version || 0) + 1 }
    : row);
  assert.deepEqual(after.devices, expectedDevices,
    name + ' exact original device EUI rows become unassigned with lifecycle version/timestamp');
  for (const row of before.devices.filter((item) => item.irrigation_zone_id === spec.zoneId)) {
    assertIsoTimestamp(after.devices.find((item) => item.deveui === row.deveui).updated_at,
      name + ' device ' + row.deveui + ' lifecycle updated_at');
  }

  const expectedAssignments = before.userZoneAssignments.map((row) => row.zone_uuid === spec.zoneUuid && row.deleted_at == null
    ? { ...row, deleted_at: zone.deleted_at, updated_at: zone.updated_at, sync_version: Number(row.sync_version || 0) + 1 }
    : row);
  assert.deepEqual(after.userZoneAssignments, expectedAssignments,
    name + ' target zone grants are tombstoned and non-target grants remain unchanged');
  for (const row of before.userZoneAssignments.filter((item) => item.zone_uuid === spec.zoneUuid && item.deleted_at == null)) {
    const updated = after.userZoneAssignments.find((item) => item.assignment_uuid === row.assignment_uuid);
    assertIsoTimestamp(updated.deleted_at, name + ' grant ' + row.assignment_uuid + ' deleted_at');
    assertIsoTimestamp(updated.updated_at, name + ' grant ' + row.assignment_uuid + ' updated_at');
  }

  const expectedPlots = before.journalPlots.map((row) => row.zone_uuid === spec.zoneUuid && row.deleted_at == null
    ? { ...row, zone_uuid: null, updated_at: zone.updated_at, sync_version: Number(row.sync_version || 0) + 1 }
    : row);
  assert.deepEqual(after.journalPlots, expectedPlots,
    name + ' target journal plots are detached and non-target plots remain unchanged');
  for (const row of before.journalPlots.filter((item) => item.zone_uuid === spec.zoneUuid && item.deleted_at == null)) {
    assertIsoTimestamp(after.journalPlots.find((item) => item.plot_uuid === row.plot_uuid).updated_at,
      name + ' plot ' + row.plot_uuid + ' lifecycle updated_at');
  }

  const expectedSchedules = before.schedules.map((row) => row.irrigation_zone_id === spec.zoneId && row.deleted_at == null
    ? { ...row, enabled: 0, deleted_at: zone.deleted_at, updated_at: zone.updated_at, sync_version: Number(row.sync_version || 0) + 1 }
    : row);
  assert.deepEqual(after.schedules, expectedSchedules,
    name + ' target schedules are disabled/tombstoned and non-target schedules remain unchanged');
  for (const row of before.schedules.filter((item) => item.irrigation_zone_id === spec.zoneId && item.deleted_at == null)) {
    const updated = after.schedules.find((item) => item.id === row.id);
    assertIsoTimestamp(updated.deleted_at, name + ' schedule ' + row.id + ' deleted_at');
    assertIsoTimestamp(updated.updated_at, name + ' schedule ' + row.id + ' updated_at');
  }

  assert.deepEqual(after.outbox.slice(0, before.outbox.length), before.outbox,
    name + ' preserves every checkpoint outbox row by identity, order, and all fields');
  const appended = after.outbox.slice(before.outbox.length);
  const previousTargetEvents = before.outbox.filter((row) => row.aggregate_type === 'ZONE' &&
    row.aggregate_key === spec.zoneUuid && row.op === 'ZONE_DELETED').length;
  const currentTargetEvents = after.outbox.filter((row) => row.aggregate_type === 'ZONE' &&
    row.aggregate_key === spec.zoneUuid && row.op === 'ZONE_DELETED').length;
  assert.equal(currentTargetEvents, previousTargetEvents + 1,
    name + ' adds exactly one target ZONE_DELETED event');
  const newTargetEvents = appended.filter((row) => row.aggregate_type === 'ZONE' &&
    row.aggregate_key === spec.zoneUuid && row.op === 'ZONE_DELETED');
  assert.equal(newTargetEvents.length, 1, name + ' appends one target ZONE_DELETED event');
  const targetPayload = JSON.parse(newTargetEvents[0].payload_json);
  assert.equal(newTargetEvents[0].sync_version, expectedZone.sync_version);
  assert.equal(targetPayload.sync_version, expectedZone.sync_version);
  assert.equal(targetPayload.deleted_at, expectedZone.deleted_at);
  assert.deepEqual(targetPayload, expectedZoneDeletedPayload(db, expectedZone, beforeZone),
    name + ' full ZONE_DELETED payload matches the expected post-delete zone and trigger contract');
  assert.equal(newTargetEvents[0].gateway_device_eui,
    expectedZone.gateway_device_eui == null ? GATEWAY_EUI : expectedZone.gateway_device_eui,
    name + ' ZONE_DELETED row gateway identity');
  const expectedDeviceKeys = before.devices.filter((row) => row.irrigation_zone_id === spec.zoneId)
    .map((row) => row.deveui).sort();
  const addedDeviceEvents = appended.filter((row) => row.aggregate_type === 'DEVICE' && row.op === 'DEVICE_UNASSIGNED');
  assert.deepEqual(addedDeviceEvents.map((row) => row.aggregate_key).sort(), expectedDeviceKeys,
    name + ' appends one DEVICE_UNASSIGNED event per target device');
  for (const event of addedDeviceEvents) {
    const payload = JSON.parse(event.payload_json);
    const device = expectedDevices.find((row) => row.deveui === event.aggregate_key);
    assert.ok(device, name + ' device event belongs to an expected target row');
    assert.deepEqual(payload, expectedDeviceUnassignedPayload(db, device),
      name + ' full DEVICE_UNASSIGNED payload matches expected post-delete row and trigger contract');
    assert.equal(event.sync_version, device.sync_version);
    assert.equal(event.gateway_device_eui,
      device.gateway_device_eui == null ? GATEWAY_EUI : device.gateway_device_eui);
  }
  const expectedScheduleVersions = before.schedules
    .filter((row) => row.irrigation_zone_id === spec.zoneId && row.deleted_at == null)
    .map((row) => Number(row.sync_version || 0) + 1).sort((a, b) => a - b);
  const addedScheduleEvents = appended.filter((row) => row.aggregate_type === 'SCHEDULE' &&
    row.aggregate_key === spec.zoneUuid && row.op === 'SCHEDULE_UPSERTED');
  assert.deepEqual(addedScheduleEvents.map((row) => row.sync_version).sort((a, b) => a - b), expectedScheduleVersions,
    name + ' appends one SCHEDULE_UPSERTED event per target schedule');
  assert.equal(appended.length, expectedDeviceKeys.length + expectedScheduleVersions.length + 1,
    name + ' appends only the target device, schedule, and zone lifecycle events');
  const targetEventPosition = appended.indexOf(newTargetEvents[0]);
  const deviceEventPositions = addedDeviceEvents.map((row) => appended.indexOf(row));
  const scheduleEventPositions = addedScheduleEvents.map((row) => appended.indexOf(row));
  assert.ok(deviceEventPositions.every((position) => position >= 0 && position < targetEventPosition),
    name + ' device outbox events precede the zone tombstone event');
  assert.ok(scheduleEventPositions.every((position) => position >= 0 && position < targetEventPosition),
    name + ' schedule outbox events precede the zone tombstone event');
  if (deviceEventPositions.length && scheduleEventPositions.length) {
    assert.ok(Math.max(...deviceEventPositions) < Math.min(...scheduleEventPositions),
      name + ' device events precede schedule events in the lifecycle transaction');
  }
  for (const event of addedScheduleEvents) {
    const payload = JSON.parse(event.payload_json);
    const schedule = expectedSchedules.find((row) => row.sync_version === event.sync_version &&
      row.irrigation_zone_id === spec.zoneId && row.deleted_at === zone.deleted_at);
    assert.ok(schedule, name + ' schedule event belongs to an expected target row');
    assert.deepEqual(payload, expectedScheduleDeletedPayload(schedule, spec.zoneUuid),
      name + ' full SCHEDULE_UPSERTED payload matches expected post-delete row and trigger contract');
    assert.equal(event.gateway_device_eui, beforeZone.gateway_device_eui,
      name + ' SCHEDULE_UPSERTED row gateway identity equals the independently seeded zone column');
  }
  assertZoneGeneratedEvidence(after, name + ' interleaved run');
}

function assertZoneUntouched(db, zoneId, before, label) {
  const after = zoneState(db);
  const zoneUuid = before.zones.find((row) => row.id === zoneId).zone_uuid;
  const originalDeviceEuis = new Set(before.devices.filter((row) => row.irrigation_zone_id === zoneId).map((row) => row.deveui));
  assert.ok(originalDeviceEuis.size > 0, label + ' fixture has target-zone devices');
  assert.ok(before.userZoneAssignments.some((row) => row.zone_uuid === zoneUuid && row.deleted_at == null),
    label + ' fixture has an active target-zone grant');
  assert.ok(before.journalPlots.some((row) => row.zone_uuid === zoneUuid && row.deleted_at == null),
    label + ' fixture has an active target-zone journal plot');
  const pick = (state) => ({
    zone: state.zones.find((row) => row.id === zoneId),
    devices: state.devices.filter((row) => originalDeviceEuis.has(row.deveui) || row.irrigation_zone_id === zoneId),
    schedule: state.schedules.find((row) => row.irrigation_zone_id === zoneId),
    userZoneAssignments: state.userZoneAssignments.filter((row) => row.zone_uuid === zoneUuid),
    journalPlots: state.journalPlots.filter((row) => row.zone_uuid === zoneUuid),
    outbox: state.outbox.filter((row) => row.aggregate_key === zoneUuid),
  });
  assert.deepEqual(pick(after), pick(before), label + ': zone ' + zoneId + ' untouched');
}

function assertOutboxUnchanged(db, checkpoint, label) {
  assert.deepEqual(zoneState(db).outbox, checkpoint.outbox,
    label + ' preserves the complete outbox by UUID, payload, version, and row order');
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

test('zone delete DEVICE_UNASSIGNED payload preserves non-null SDI-12 layout and exact-key controls', async () => {
  const expectedLayout = {
    version: 1,
    address: 'L',
    sensors: [{ channel: 1, response_position: 1, depth_cm: 20, type: 'ENVIROSCAN' }],
  };
  await withRuntime({ scoped: false }, async (rt, db) => {
    seedZoneDelete(db);
    const beforeNullLayoutDelete = zoneState(db);
    rt.inject('null-layout', ZD.http, zoneDeleteMsg('null-layout', ZONE_DELETE.B));
    await rt.run('null-layout');
    assertZoneDeleted(rt, db, 'null-layout', ZONE_DELETE.B, beforeNullLayoutDelete);
    const afterNullLayoutDelete = zoneState(db);
    const nullLayoutEvent = afterNullLayoutDelete.outbox.slice(beforeNullLayoutDelete.outbox.length).find((row) =>
      row.aggregate_type === 'DEVICE' && row.aggregate_key === 'WX1' && row.op === 'DEVICE_UNASSIGNED');
    assert.ok(nullLayoutEvent, 'null-layout fixture appends the seeded WX1 unassignment event');
    const nullSeededDevice = beforeNullLayoutDelete.devices.find((row) => row.deveui === 'WX1');
    const nullExpectedDevice = {
      ...nullSeededDevice,
      irrigation_zone_id: null,
      sync_version: Number(nullSeededDevice.sync_version || 0) + 1,
    };
    const nullExpectedPayload = expectedDeviceUnassignedPayload(db, nullExpectedDevice);
    assert.equal(nullExpectedPayload.sdi12_channel_layout_json, null,
      'null fixture expectation retains JSON null for the independently seeded column');
    const nullPayload = JSON.parse(nullLayoutEvent.payload_json);
    assert.deepEqual(nullPayload, nullExpectedPayload, 'complete null-layout payload includes the required key');
    const missingNullLayout = { ...nullPayload };
    delete missingNullLayout.sdi12_channel_layout_json;
    assert.throws(() => assert.deepEqual(missingNullLayout, nullExpectedPayload), assert.AssertionError,
      'the full payload oracle rejects a missing layout key when its expected value is null');

    db.prepare('UPDATE devices SET sdi12_channel_layout_json=? WHERE deveui=?')
      .run(JSON.stringify(expectedLayout), ZONE3_SENSOR);
    const before = zoneState(db);
    assert.deepEqual(JSON.parse(before.devices.find((row) => row.deveui === ZONE3_SENSOR).sdi12_channel_layout_json),
      expectedLayout, 'non-null layout is independently seeded on the target device');
    rt.inject('A', ZD.http, zoneDeleteMsg('A', ZONE_DELETE.A3));
    await rt.run('A');
    assertZoneDeleted(rt, db, 'A', ZONE_DELETE.A3, before);

    const after = zoneState(db);
    const event = after.outbox.slice(before.outbox.length).find((row) => row.aggregate_type === 'DEVICE' &&
      row.aggregate_key === ZONE3_SENSOR && row.op === 'DEVICE_UNASSIGNED');
    assert.ok(event, 'target device has its appended unassignment event');
    const payload = JSON.parse(event.payload_json);
    const seededDevice = before.devices.find((row) => row.deveui === ZONE3_SENSOR);
    const expectedDevice = {
      ...seededDevice,
      irrigation_zone_id: null,
      sync_version: Number(seededDevice.sync_version || 0) + 1,
    };
    const expectedPayload = expectedDeviceUnassignedPayload(db, expectedDevice);
    assert.deepEqual(payload, expectedPayload, 'full payload includes the independently expected parsed layout');
    assert.deepEqual(expectedPayload.sdi12_channel_layout_json, expectedLayout,
      'fixture expectation parses the stored layout as JSON');

    const withoutLayout = { ...payload };
    delete withoutLayout.sdi12_channel_layout_json;
    assert.throws(() => assert.deepEqual(withoutLayout, expectedPayload), assert.AssertionError,
      'the full payload oracle rejects a missing layout key');
    const changedLayout = structuredClone(payload);
    changedLayout.sdi12_channel_layout_json = { ...expectedLayout, version: 2 };
    assert.throws(() => assert.deepEqual(changedLayout, expectedPayload), assert.AssertionError,
      'the full payload oracle rejects a changed layout value');
  });
});

test('zone delete lifecycle zoneByRef read holds before transaction; disjoint B commits before A release', async () => {
  const sql = 'SELECT * FROM irrigation_zones WHERE id=? LIMIT 1';
  const gate = makeDbCallGate(matchingGate({ nodeId: ZD.router, method: 'get', sqlIncludes: sql, params: [1] }));
  await withRuntime({ scoped: false, dbCallGate: gate }, async (rt, db) => {
    seedZoneDelete(db);
    const before = zoneState(db);
    rt.inject('A', ZD.http, zoneDeleteMsg('A', ZONE_DELETE.A));
    rt.inject('B', ZD.http, zoneDeleteMsg('B', ZONE_DELETE.B));
    await rt.runUntil('A', ZD.router);
    const { key } = rt.startStep('A');
    const held = await gate.waitForEvent((event) => heldAtSite(event, {
      lane: 'A', nodeId: ZD.router, method: 'get', sqlIncludes: sql,
    }), { lane: 'A', nodeId: ZD.router, method: 'get', sqlIncludes: sql, siteOccurrence: 1 });
    assert.equal(held.decisionKind, 'execute');
    assert.equal(held.operationCount, 1);
    assert.equal(gate.events.some((event) => event.phase === 'transaction_begin' && event.lane === 'A'), false,
      'zoneByRef is delivered before A opens its writer transaction');
    await rt.run('B');
    assertZoneDeleted(rt, db, 'B', ZONE_DELETE.B, before);
    const afterBCommit = zoneState(db);
    gate.release(held);
    await rt.settleStep(key);
    await rt.run('A');
    assertZoneDeleted(rt, db, 'A', ZONE_DELETE.A, afterBCommit);
    assertOneHeldCallTrace(gate, held, 1);
    const bCommit = gate.events.findIndex((event) => event.phase === 'transaction_commit' && event.lane === 'B');
    const bDone = gate.events.findIndex((event) => event.phase === 'b_completed' && event.lane === 'B');
    const aRelease = gate.events.findIndex((event) => event.phase === 'delivery_released' && event.callId === held.callId);
    const aBegin = gate.events.findIndex((event) => event.phase === 'transaction_begin' && event.lane === 'A');
    assert.ok(bCommit >= 0 && bCommit < bDone && bDone < aRelease && aRelease < aBegin,
      'B commits and completes before A receives its selected zoneByRef result');
  });
});

test('schedule UPDATE synthetic busy rolls back A unchanged before B begins', async () => {
  const sql = 'UPDATE irrigation_schedules SET trigger_metric=?, threshold_kpa=?, duration_minutes=?, enabled=?, response_mode=?, deleted_at=NULL, sync_version=?, updated_at=? WHERE id=? AND deleted_at IS NULL';
  const gate = makeDbCallGate(matchingGate({ nodeId: ID.schedWrite, method: 'run', sqlIncludes: sql, kind: 'synthetic_busy' }));
  await withRuntime({ scoped: false, dbCallGate: gate }, async (rt, db) => {
    const before = db.prepare('SELECT * FROM irrigation_schedules WHERE irrigation_zone_id=1').get();
    const beforeOutbox = db.prepare("SELECT * FROM sync_outbox WHERE aggregate_type='SCHEDULE' AND aggregate_key='z-1' ORDER BY rowid").all();
    rt.inject('A', ID.schedHttp, scheduleMsg('A', SCHEDULE.A));
    rt.inject('B', ID.schedHttp, scheduleMsg('B', SCHEDULE.B));
    await rt.runUntil('A', ID.schedWrite);
    const priorSql = structuredClone(rt.lane('A').sql);
    const normalizeSql = (topic) => topic.replace(/\s+/g, ' ').trim();
    assert.deepEqual(priorSql.map((entry) => ({
      node: entry.node,
      role: entry.node === ID.schedUserDb ? 'request-user lookup' :
        (entry.node === ID.schedZoneDb ? 'request-zone lookup' : 'unexpected node'),
      topic: normalizeSql(entry.topic),
    })), [
      {
        node: ID.schedUserDb,
        role: 'request-user lookup',
        topic: `SELECT id FROM users WHERE id = ${USERS.res1.userId} AND username = '${USERS.res1.username}'`,
      },
      {
        node: ID.schedZoneDb,
        role: 'request-zone lookup',
        topic: `SELECT iz.id, iz.zone_uuid, iz.gateway_device_eui, s.sync_version AS schedule_sync_version, s.last_applied_at, s.deleted_at AS schedule_deleted_at FROM irrigation_zones iz LEFT JOIN irrigation_schedules s ON s.irrigation_zone_id = iz.id WHERE iz.id = ${SCHEDULE.A.zoneId} AND iz.user_id = ${USERS.res1.userId} AND iz.deleted_at IS NULL LIMIT 1`,
      },
    ], 'pre-lifecycle checkpoint is exactly the request-user and request-zone SQLite lookups');
    const { key } = rt.startStep('A');
    const held = await gate.waitForEvent((event) => heldAtSite(event, {
      lane: 'A', nodeId: ID.schedWrite, method: 'run', sqlIncludes: sql,
    }), { lane: 'A', nodeId: ID.schedWrite, method: 'run', sqlIncludes: sql, siteOccurrence: 1 });
    const assertZeroSelectedOperation = (operationCount) => assert.equal(operationCount, 0,
      'selected schedule UPDATE busy performs zero SQLite operations');
    assert.equal(held.decisionKind, 'synthetic_busy');
    assert.match(held.error, /SQLITE_BUSY/);
    assertZeroSelectedOperation(held.operationCount);
    assert.throws(() => assertZeroSelectedOperation(1), assert.AssertionError,
      'assertion-unit example rejects an operation count of one');
    const selectedSite = { lane: 'A', nodeId: ID.schedWrite, method: 'run', sqlIncludes: sql };
    assert.equal(heldAtSite(held, selectedSite), true,
      'the held selected busy matches the exact first lifecycle UPDATE site before release');
    assert.equal(heldAtSite({ ...held, siteOccurrence: 2 }, selectedSite), false,
      'changing only the site occurrence to a later site fails the held-site selector');
    assert.ok(gate.events.some((event) => event.phase === 'transaction_begin' && event.lane === 'A'));
    gate.release(held);
    await rt.settleStep(key);
    await rt.run('A');
    assertBusyErrorAttribution(gate, rt, held, 'A', ID.schedWrite);
    assert.equal(onlyResponse(rt, 'A').statusCode, 500);
    const assertNoPostCheckpointSql = (entries) => assert.deepEqual(entries, priorSql,
      'failed lifecycle call adds no Node-RED SQLite visits beyond the exact request lookup checkpoint');
    assertNoPostCheckpointSql(rt.lane('A').sql);
    assert.throws(() => assertNoPostCheckpointSql([...priorSql, {
      node: ID.schedWrite,
      topic: sql,
    }]), assert.AssertionError, 'an extra SQLite visit after the checkpoint is rejected');
    assertOneHeldCallTrace(gate, held, 0);
    assert.deepEqual({ ...db.prepare('SELECT * FROM irrigation_schedules WHERE irrigation_zone_id=1').get() }, { ...before },
      'A schedule row and version are rolled back');
    assert.deepEqual(db.prepare("SELECT * FROM sync_outbox WHERE aggregate_type='SCHEDULE' AND aggregate_key='z-1' ORDER BY rowid").all(), beforeOutbox,
      'A schedule outbox remains unchanged');
    await rt.run('B');
    assertScheduleApplied(rt, db, 'B', { ...SCHEDULE.B, userId: USERS.res1.userId });
    const assertRollbackBeforeB = (events) => {
      const exactlyOne = (predicate, label) => {
        const indices = events.map((event, index) => predicate(event) ? index : -1).filter((index) => index >= 0);
        assert.equal(indices.length, 1, label + ' appears exactly once');
        return indices[0];
      };
      const aBegin = exactlyOne((event) => event.phase === 'transaction_begin' && event.lane === 'A', 'A transaction begin');
      const selected = exactlyOne((event) => event.phase === 'selected' && event.callId === held.callId, 'selected call');
      const released = exactlyOne((event) => event.phase === 'delivery_released' && event.callId === held.callId, 'selected delivery release');
      const aRollback = exactlyOne((event) => event.phase === 'transaction_rollback' && event.lane === 'A', 'A transaction rollback');
      const bBegin = exactlyOne((event) => event.phase === 'transaction_begin' && event.lane === 'B', 'B transaction begin');
      const bCommit = exactlyOne((event) => event.phase === 'transaction_commit' && event.lane === 'B', 'B transaction commit');
      const bCompleted = exactlyOne((event) => event.phase === 'b_completed' && event.lane === 'B', 'B completion');
      assert.ok(aBegin < selected && selected < released && released < aRollback && aRollback < bBegin &&
        bBegin < bCommit && bCommit < bCompleted,
      'A begins, selects and releases zero-operation busy, rolls back, then B begins, commits, and completes');
    };
    assertRollbackBeforeB(gate.events);
    assert.throws(() => assertRollbackBeforeB(gate.events.filter((event) =>
      !(event.phase === 'delivery_released' && event.callId === held.callId))), assert.AssertionError,
    'missing release is rejected');
    assert.throws(() => assertRollbackBeforeB(gate.events.filter((event) =>
      !(event.phase === 'transaction_rollback' && event.lane === 'A'))), assert.AssertionError,
    'missing rollback is rejected');
    assert.throws(() => assertRollbackBeforeB(gate.events.filter((event) =>
      !(event.phase === 'transaction_commit' && event.lane === 'B'))), assert.AssertionError,
    'missing B commit is rejected');
    const earlyB = [...gate.events];
    const rollbackIndex = earlyB.findIndex((event) => event.phase === 'transaction_rollback' && event.lane === 'A');
    const bBeginIndex = earlyB.findIndex((event) => event.phase === 'transaction_begin' && event.lane === 'B');
    const [bBeginEvent] = earlyB.splice(bBeginIndex, 1);
    earlyB.splice(rollbackIndex, 0, bBeginEvent);
    assert.throws(() => assertRollbackBeforeB(earlyB), assert.AssertionError,
      'B starting before A rollback is rejected');
  });
});

test('zone soft-delete synthetic busy rolls back earlier A writes and outbox before B begins', async () => {
  const sql = 'UPDATE irrigation_zones SET deleted_at=?, updated_at=?, sync_version=? WHERE id=? AND deleted_at IS NULL';
  const gate = makeDbCallGate(matchingGate({ nodeId: ZD.router, method: 'run', sqlIncludes: sql, kind: 'synthetic_busy' }));
  await withRuntime({ scoped: false, dbCallGate: gate }, async (rt, db) => {
    seedZoneDelete(db);
    const before = zoneState(db);
    rt.inject('A', ZD.http, zoneDeleteMsg('A', ZONE_DELETE.A));
    rt.inject('B', ZD.http, zoneDeleteMsg('B', ZONE_DELETE.B));
    await rt.runUntil('A', ZD.router);
    const { key } = rt.startStep('A');
    const held = await gate.waitForEvent((event) => heldAtSite(event, {
      lane: 'A', nodeId: ZD.router, method: 'run', sqlIncludes: sql,
    }), { lane: 'A', nodeId: ZD.router, method: 'run', sqlIncludes: sql, siteOccurrence: 1 });
    assert.equal(held.decisionKind, 'synthetic_busy');
    assert.match(held.error, /SQLITE_BUSY/);
    assert.equal(held.operationCount, 0);
    assert.equal(held.methodOrdinal, 5, 'exact zone soft-delete site follows four earlier run calls on this Function');
    assert.ok(gate.events.some((event) => event.phase === 'transaction_begin' && event.lane === 'A'));
    gate.release(held);
    await rt.settleStep(key);
    await rt.run('A');
    assertBusyErrorAttribution(gate, rt, held, 'A', ZD.router);
    assert.equal(onlyResponse(rt, 'A').statusCode, 500);
    assert.equal(rt.lane('A').sql.length, 0, 'zone lifecycle UPDATE fails in its helper transaction with zero node-red SQL');
    assertOneHeldCallTrace(gate, held, 0);
    assert.deepEqual(zoneState(db), before,
      'A unassign, soft-delete, schedule-disable, versions and outbox all roll back');
    await rt.run('B');
    assertZoneDeleted(rt, db, 'B', ZONE_DELETE.B, before);
    const exactlyOne = (predicate, label) => {
      const indices = gate.events.map((event, index) => predicate(event) ? index : -1).filter((index) => index >= 0);
      assert.equal(indices.length, 1, label + ' appears exactly once');
      return indices[0];
    };
    const aBegin = exactlyOne((event) => event.phase === 'transaction_begin' && event.lane === 'A', 'A transaction begin');
    const selected = exactlyOne((event) => event.phase === 'selected' && event.callId === held.callId, 'selected zone update');
    const released = exactlyOne((event) => event.phase === 'delivery_released' && event.callId === held.callId, 'selected zone update release');
    const aRollback = exactlyOne((event) => event.phase === 'transaction_rollback' && event.lane === 'A', 'A transaction rollback');
    const bBegin = exactlyOne((event) => event.phase === 'transaction_begin' && event.lane === 'B', 'B transaction begin');
    const bCommit = exactlyOne((event) => event.phase === 'transaction_commit' && event.lane === 'B', 'B transaction commit');
    const bCompleted = exactlyOne((event) => event.phase === 'b_completed' && event.lane === 'B', 'B completion');
    assert.ok(aBegin < selected && selected < released && released < aRollback && aRollback < bBegin &&
      bBegin < bCommit && bCommit < bCompleted,
    'A begins, selects and releases zero-SQL busy, rolls back, then B begins, commits, and completes');
  });
});

// Router-entry interleaving is a coarse control. The separate held-zoneByRef test below is the
// transaction-aware evidence boundary; these tests do not claim to pause inside the lifecycle.
const ZONE_DELETE_BOUNDARIES = [ZD.router];

for (const boundary of ZONE_DELETE_BOUNDARIES) {
  for (const paused of ['A', 'B']) {
    const other = paused === 'A' ? 'B' : 'A';
    test(`zone delete router-entry control: two users, ${paused} paused before ${boundary}, ${other} completes`, async () => {
      const expected = await serialZoneState([
        ['A', ZD.http, zoneDeleteMsg('A', ZONE_DELETE.A)],
        ['B', ZD.http, zoneDeleteMsg('B', ZONE_DELETE.B)],
      ]);
      await withZoneDeleteRuntime(async (rt, db, before) => {
        rt.inject('A', ZD.http, zoneDeleteMsg('A', ZONE_DELETE.A));
        rt.inject('B', ZD.http, zoneDeleteMsg('B', ZONE_DELETE.B));
        await rt.runUntil(paused, boundary);
        await rt.run(other);
        const afterOtherCommit = zoneState(db);
        const otherSpec = other === 'A' ? ZONE_DELETE.A : ZONE_DELETE.B;
        assertZoneDeleted(rt, db, other, otherSpec, before);
        await rt.run(paused);
        const pausedSpec = paused === 'A' ? ZONE_DELETE.A : ZONE_DELETE.B;
        assertZoneDeleted(rt, db, paused, pausedSpec, afterOtherCommit);
        assertZoneUntouched(db, 3, before, 'zone 3');
        const after = zoneState(db);
        assertZoneGeneratedEvidence(after, 'router-entry interleaved run');
        assert.deepEqual(stableZoneState(after), stableZoneState(expected),
          'interleaved semantic effects and outbox contents and multiplicity equal the independent serial run');
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
      const afterA3Commit = zoneState(db);
      assertZoneDeleted(rt, db, 'A3', ZONE_DELETE.A3, before);
      await rt.run('A');
      assertZoneDeleted(rt, db, 'A', ZONE_DELETE.A, afterA3Commit);
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
test('zone delete A holds exact pretx zoneByRef; schedule B on zone 3 commits first', async () => {
  const sql = 'SELECT * FROM irrigation_zones WHERE id=? LIMIT 1';
  const gate = makeDbCallGate(matchingGate({ nodeId: ZD.router, method: 'get', sqlIncludes: sql, params: [1] }));
  await withRuntime({ scoped: false, dbCallGate: gate }, async (rt, db) => {
    seedZoneDelete(db, { includeZone3Schedule: false });
    const before = zoneState(db);
    rt.inject('A', ZD.http, zoneDeleteMsg('A', ZONE_DELETE.A));
    rt.inject('B', ID.schedHttp, scheduleMsg('B', SCHEDULE.B));
    await rt.runUntil('A', ZD.router);
    const { key } = rt.startStep('A');
    const held = await gate.waitForEvent((event) => heldAtSite(event, {
      lane: 'A', nodeId: ZD.router, method: 'get', sqlIncludes: sql,
    }), { lane: 'A', nodeId: ZD.router, method: 'get', sqlIncludes: sql, siteOccurrence: 1 });
    assert.equal(held.operationCount, 1);
    assert.equal(gate.events.some((event) => event.phase === 'transaction_begin' && event.lane === 'A'), false,
      'delete zoneByRef is selected before the lifecycle transaction');
    await rt.run('B');
    assertScheduleApplied(rt, db, 'B', SCHEDULE.B);
    assertOutboxUnchanged(db, before, 'zone-3 schedule INSERT B');
    const afterScheduleCommit = zoneState(db);
    gate.release(held);
    await rt.settleStep(key);
    await rt.run('A');
    assertZoneDeleted(rt, db, 'A', ZONE_DELETE.A, afterScheduleCommit);
    assertZoneUntouched(db, 2, before, 'zone 2');
    assertOneHeldCallTrace(gate, held, 1);
    const commit = gate.events.findIndex((event) => event.phase === 'transaction_commit' && event.lane === 'B');
    const done = gate.events.findIndex((event) => event.phase === 'b_completed' && event.lane === 'B');
    const release = gate.events.findIndex((event) => event.phase === 'delivery_released' && event.callId === held.callId);
    assert.ok(commit >= 0 && commit < done && done < release, 'schedule B commits and completes before delete A resumes');
  });
});

test('schedule A holds exact pretx zoneByRef; zone delete B commits first', async () => {
  const sql = 'SELECT * FROM irrigation_zones WHERE id=? AND deleted_at IS NULL LIMIT 1';
  const gate = makeDbCallGate(matchingGate({ nodeId: ID.schedWrite, method: 'get', sqlIncludes: sql, params: [3] }));
  await withRuntime({ scoped: false, dbCallGate: gate }, async (rt, db) => {
    seedZoneDelete(db, { includeZone3Schedule: false });
    const before = zoneState(db);
    rt.inject('A', ID.schedHttp, scheduleMsg('A', SCHEDULE.B));
    rt.inject('B', ZD.http, zoneDeleteMsg('B', ZONE_DELETE.A));
    await rt.runUntil('A', ID.schedWrite);
    const { key } = rt.startStep('A');
    const held = await gate.waitForEvent((event) => heldAtSite(event, {
      lane: 'A', nodeId: ID.schedWrite, method: 'get', sqlIncludes: sql,
    }), { lane: 'A', nodeId: ID.schedWrite, method: 'get', sqlIncludes: sql, siteOccurrence: 1 });
    assert.equal(held.operationCount, 1);
    assert.equal(gate.events.some((event) => event.phase === 'transaction_begin' && event.lane === 'A'), false,
      'schedule zoneByRef is selected before the lifecycle transaction');
    await rt.run('B');
    assertZoneDeleted(rt, db, 'B', ZONE_DELETE.A, before);
    const afterDeleteCommit = zoneState(db);
    gate.release(held);
    await rt.settleStep(key);
    await rt.run('A');
    assertScheduleApplied(rt, db, 'A', SCHEDULE.B);
    assertOutboxUnchanged(db, afterDeleteCommit, 'zone-3 schedule INSERT A after delete B');
    assertZoneUntouched(db, 2, before, 'zone 2');
    assertOneHeldCallTrace(gate, held, 1);
    const commit = gate.events.findIndex((event) => event.phase === 'transaction_commit' && event.lane === 'B');
    const done = gate.events.findIndex((event) => event.phase === 'b_completed' && event.lane === 'B');
    const release = gate.events.findIndex((event) => event.phase === 'delivery_released' && event.callId === held.callId);
    assert.ok(commit >= 0 && commit < done && done < release, 'delete B commits and completes before schedule A resumes');
  });
});

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

test('context oracle: residual per-request Map key fails after body returns', async () => {
  await assert.rejects(
    withRuntime({ scoped: false }, async (rt) => {
      rt.tabContext.set('device-api-tab', new Map([['valve_cmd_probe', 'A']]));
    }),
    /per-request value left in shared flow context: valve_cmd_probe/
  );
});

test('context oracle: deleting per-request Map key before return passes', async () => {
  await withRuntime({ scoped: false }, async (rt) => {
    rt.tabContext.set('device-api-tab', new Map([['valve_cmd_probe', 'A']]));
    rt.tabContext.get('device-api-tab').delete('valve_cmd_probe');
  });
});

test('context oracle mutant: Object.keys(Map) loses the residual-key discriminator', async () => {
  const original = FlowRuntime.prototype.flowKeys;
  FlowRuntime.prototype.flowKeys = function flowKeysWithObjectKeysMutant() {
    const keys = [];
    for (const store of this.tabContext.values()) keys.push(...Object.keys(store));
    return keys;
  };
  try {
    await assert.rejects(
      assert.rejects(withRuntime({ scoped: false }, async (rt) => {
        rt.tabContext.set('device-api-tab', new Map([['valve_cmd_probe', 'A']]));
      }), /per-request value left in shared flow context/),
      /Missing expected rejection/,
      'the Object.keys(Map) mutant specifically misses the residual key'
    );
  } finally { FlowRuntime.prototype.flowKeys = original; }
});

test('dotted guard mutant: maintained-profile checker rejects test-only mutation and restored copies pass', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'request-context-maintained-guard-mutant-'));
  const profileFiles = ['bcm2712', 'bcm2709'].map((profile) => ({
    source: profilePaths(profile).flowsPath,
    copy: path.join(tempRoot, profile + '-flows.json'),
  }));
  const pristine = new Map();
  const checker = path.join(ROOT, 'scripts/verify-request-context-isolation.js');
  const runChecker = () => spawnSync(process.execPath,
    [checker, ...profileFiles.flatMap(({ copy }) => ['--flows', copy])], { encoding: 'utf8' });
  try {
    for (const { source, copy } of profileFiles) {
      const text = fs.readFileSync(source, 'utf8');
      pristine.set(copy, text);
      const flows = JSON.parse(text);
      const auth = flows.find((node) => node.id === '83bb4a452dd9ae37');
      assert.ok(auth, 'maintained profile contains canonical Auth + Validate + Normalize');
      auth.func += "\nflow.set('valve_cmd_probe', 'A');";
      fs.writeFileSync(copy, JSON.stringify(flows));
    }
    const mutant = runChecker();
    assert.equal(mutant.status, 1, 'actual maintained-profile checker exits 1 for dotted guard mutation');
    assert.match(mutant.stderr, /keeps per-request state in shared context: flow\.set\('valve_cmd_probe'/);
    for (const { copy } of profileFiles) fs.writeFileSync(copy, pristine.get(copy));
    const restored = runChecker();
    assert.equal(restored.status, 0, 'actual checker exits 0 after restoring both test-only profile copies');
    assert.match(restored.stdout, /verify-request-context-isolation: OK/);
  } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
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
