'use strict';
// Differential harness for STREGA valve control: one scripted sequence of commands, valve
// uplinks, reboots and clock changes is run against the valve code of a released tag (the
// oracle, v0.8.1) and against the code in this checkout, and the two traces are compared.
//
// What runs is the function-node code from each tree's flows.json (command builders, expectation
// writer, encoder, uplink persistence, the two tick nodes) on that tree's osi-valve-control
// module and on that tree's bundled database. Only the outer edges are simulated, and they are
// the same for both sides:
//   - World: true time, the gateway's wall clock (true time plus an offset that can step), the
//     boot id and uptime, and the NTP marker file. Wall time and uptime move apart on a step.
//   - ChirpStackSim: a per-device downlink queue. It holds frames, hands one frame to the valve
//     per uplink (Class A), and discards a frame whose expiry is before the wall clock at that
//     moment, as ChirpStack 4.12.1 does when it selects the next item.
//   - ValveSim: a valve that follows the vendor manuals: a timed open on a closed valve opens it
//     and closes it after the encoded time; a timed open on an open valve is ignored.
//
// No Node-RED runtime, no radio and no real valve are involved. Used by
// scripts/test-valve-v081-equivalence.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SHARE = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share';
const EUI = '0016C001F1000001';
const GATEWAY_EUI = '0016C001F1000002';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const UPTIME_PATH = '/proc/uptime';
const MARKER_PATH = '/var/run/osi-irrigation-clock.json';

const NODE = {
  manualBuilder: 'dde8e1ef265e96d7',
  routeCommand: '934bf2bc19a8ce22',
  writeExpectation: 'write-strega-expectation',
  encoder: 'cdbaa3891d40d7a1',
  actuatorLog: '5c45136f382d501c',
  persistUplink: 'strega-sql-fn',
  reconciliation: 'strega-reconciliation-monitor',
  observe: 'valve-observe-fn',
  oneTime: 'valve-once-fn',
  scheduleUpsert: 'd7e5c762c820aa16',
  cancelRoute: 'cancel-strega-actuation-fn',
};
const AUTH_SECRET = 'equivalence-harness-secret';
// Only from 0.8.2 on: the node behind "Build UPSERT" that saves the zone schedule in the module.
const OPTIONAL_NODE = { scheduleAdapter: 'conditional-legacy-schedule-adapter' };

// ------------------------------------------------------------------ release trees

const extracted = new Map();
const tempDirs = new Set();
process.on('exit', () => { for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

// The tree of a released tag, taken from the git objects of this repository. A clone without the
// tag fails here with the command that fetches it; the comparison never runs without its oracle.
function releaseTree(tag) {
  if (extracted.has(tag)) return extracted.get(tag);
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', '--quiet', tag + '^{commit}'], { stdio: 'pipe' });
  } catch (_) {
    throw new Error('valve equivalence: tag ' + tag + ' is not in this clone; run: git fetch origin tag ' + tag + ' --no-tags');
  }
  const dir = tempDir('valve-eq-' + tag.replace(/[^A-Za-z0-9.]/g, '_') + '-');
  const tar = execFileSync('git', ['-C', REPO_ROOT, 'archive', '--format=tar', tag,
    SHARE + '/flows.json', SHARE + '/db/farming.db', SHARE + '/node-red'], { maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir, '--exclude=node_modules'], { input: tar });
  extracted.set(tag, dir);
  return dir;
}

function systemDefinition(label, root) {
  const flows = JSON.parse(fs.readFileSync(path.join(root, SHARE, 'flows.json'), 'utf8'));
  const nodes = {};
  for (const [name, id] of Object.entries(NODE)) {
    const found = flows.find((entry) => entry.id === id);
    if (!found || typeof found.func !== 'string') throw new Error(label + ': flow node ' + id + ' (' + name + ') not found');
    nodes[name] = found;
  }
  for (const [name, id] of Object.entries(OPTIONAL_NODE)) {
    const found = flows.find((entry) => entry.id === id);
    if (found && typeof found.func === 'string') nodes[name] = found;
  }
  // From 0.8.2 on the encoder hands frames to ChirpStack itself (gRPC helper in its libs); before
  // that it returns an MQTT downlink message for the "MQTT to ChirpStack" node.
  const transport = (nodes.encoder.libs || []).some((lib) => lib.var === 'chirpstack') ? 'grpc' : 'mqtt';
  return { label, root, nodes, transport, moduleDir: path.join(root, SHARE, 'node-red'), seedDb: path.join(root, SHARE, 'db/farming.db') };
}

const candidate = () => systemDefinition('candidate', REPO_ROOT);
const release = (tag) => systemDefinition(tag, releaseTree(tag));

// ------------------------------------------------------------------ the simulated world

function missing(file) { return Object.assign(new Error('ENOENT: no such file or directory, open ' + file), { code: 'ENOENT' }); }

// Date and the three clock files are mocked once per test; they follow whichever world was
// created last, so two gateways can be run one after the other in one test.
let currentWorld = null;
const attached = new WeakSet();
function attach(t) {
  if (attached.has(t)) return;
  attached.add(t);
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...rest) {
    const world = currentWorld;
    if (file === BOOT_ID_PATH) return world.bootId() + '\n';
    if (file === UPTIME_PATH) return (world.uptime() / SECOND).toFixed(3) + ' 0.00\n';
    if (file === MARKER_PATH) { if (!world.marker) throw missing(file); return JSON.stringify(world.marker); }
    if (typeof file === 'string' && file.startsWith(MARKER_PATH.replace(/\.json$/, ''))) throw missing(file);
    return readFileSync.call(this, file, ...rest);
  });
}

class World {
  // offsetMs: how far the gateway's wall clock is from true time at the start. ntp: whether an NTP
  // reply has been received in this boot (the marker file exists).
  constructor(t, { start = '2026-11-02T06:00:00.000Z', offsetMs = 0, ntp = true } = {}) {
    this.real = Date.parse(start);
    this.realStart = this.real;
    this.offsetMs = offsetMs;
    this.bootCount = 1;
    this.bootedAtReal = this.real - 10 * MINUTE;
    this.marker = null;
    this.queue = [];
    this.queueSeq = 0;
    this.enqueued = [];
    this.valve = { open: false, closeAt: null, reopenAt: null, runs: [], openedAt: null };
    this.held = new Map();
    this.t = t;
    attach(t);
    currentWorld = this;
    this.sync();
    if (ntp) this.ntpReply();
  }

  wall() { return this.real + this.offsetMs; }
  uptime() { return this.real - this.bootedAtReal; }
  bootId() { return 'equivalence-boot-' + this.bootCount; }
  minutes() { return Math.round((this.real - this.realStart) / MINUTE * 100) / 100; }
  sync() { this.t.mock.timers.setTime(this.wall()); }

  advance(ms) { this.real += ms; this.sync(); }
  // The wall clock jumps; true time and uptime do not.
  stepClock(ms) { this.offsetMs += ms; this.sync(); }
  // An NTP reply: the hotplug hook writes the marker for this boot at the current wall time.
  ntpReply() { this.marker = { boot_id: this.bootId(), epoch_ms: this.wall(), uptime_ms: this.uptime(), stratum: 2 }; }
  reboot() { this.bootCount += 1; this.bootedAtReal = this.real; this.marker = null; }

  // ---- ChirpStack: queue in creation order, one frame per uplink, expiry checked at selection
  enqueue(item) {
    this.queueSeq += 1;
    const entry = {
      id: 'eq-' + String(this.queueSeq).padStart(4, '0'), seq: this.queueSeq, createdAt: this.wall(),
      fPort: Number(item.fPort), data: String(item.data), confirmed: Boolean(item.confirmed),
      expiresAt: item.expiresAt == null ? null : new Date(item.expiresAt).getTime(),
    };
    this.queue.push(entry);
    this.enqueued.push(entry);
    return { id: entry.id };
  }
  flush() { const removed = this.queue.splice(0, this.queue.length); return removed; }
  readQueue() {
    return this.orderedQueue().map((entry) => ({ id: entry.id, fPort: entry.fPort, data: entry.data, confirmed: entry.confirmed, isPending: false, isEncrypted: false,
      ...(entry.expiresAt == null ? {} : { expiresAt: new Date(entry.expiresAt).toISOString() }) }));
  }
  orderedQueue() { return [...this.queue].sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq); }
  // What ChirpStack hands to the valve after an uplink. Expired frames are discarded on the way.
  selectNext() {
    const discarded = [];
    for (const entry of this.orderedQueue()) {
      this.queue.splice(this.queue.indexOf(entry), 1);
      if (entry.expiresAt != null && entry.expiresAt < this.wall()) { discarded.push(entry); continue; }
      return { frame: entry, discarded };
    }
    return { frame: null, discarded };
  }

  // ---- the valve
  valveSettle() {
    const valve = this.valve;
    for (;;) {
      const next = [valve.closeAt, valve.reopenAt].filter((at) => at != null && at <= this.real).sort((a, b) => a - b)[0];
      if (next == null) return;
      if (valve.closeAt === next) { valve.closeAt = null; this.valveSet(false, next); }
      else { valve.reopenAt = null; this.valveSet(true, next); }
    }
  }
  valveSet(open, at) {
    const valve = this.valve;
    if (open === valve.open) return;
    valve.open = open;
    if (open) valve.openedAt = at;
    else { valve.runs.push([valve.openedAt, at]); valve.openedAt = null; }
  }
  valveApply(frame) {
    const valve = this.valve;
    const bytes = Buffer.from(frame.data, 'base64');
    if (frame.fPort === 1 && bytes[0] === 0x30) { valve.closeAt = null; valve.reopenAt = null; this.valveSet(false, this.real); return 'closed'; }
    if (frame.fPort === 1 && bytes[0] === 0x31) { valve.closeAt = null; this.valveSet(true, this.real); return 'opened, no timer'; }
    if (frame.fPort === 2 && bytes.length === 2) {
      const unit = { 0x20: SECOND, 0x40: MINUTE, 0x80: HOUR }[bytes[0] & 0xFE];
      if (!unit) return 'no effect';
      const duration = bytes[1] * unit;
      if (bytes[0] & 1) {
        if (valve.open) return 'ignored, valve already open';
        valve.closeAt = this.real + duration; this.valveSet(true, this.real); return 'opened for ' + duration / MINUTE + ' min';
      }
      if (!valve.open) return 'ignored, valve already closed';
      valve.closeAt = null; valve.reopenAt = this.real + duration; this.valveSet(false, this.real); return 'closed for ' + duration / MINUTE + ' min, then open with no timer';
    }
    if (frame.fPort === 27) { valve.closeAt = null; this.valveSet(true, this.real); return 'partly open, no timer'; }
    if (frame.fPort === 28) {
      if (bytes[0] === 0x31) { valve.closeAt = null; this.valveSet(true, this.real); return 'flushed, left open with no timer'; }
      valve.reopenAt = null; valve.closeAt = this.real + 5 * SECOND; this.valveSet(true, this.real); return 'flushed, closes after 5 s';
    }
    return 'no effect';
  }
  valveState() { this.valveSettle(); return this.valve.open ? 'OPEN' : 'CLOSED'; }
  valveRuns() {
    this.valveSettle();
    const rel = (at) => Math.round((at - this.realStart) / MINUTE * 100) / 100;
    const runs = this.valve.runs.map(([from, to]) => [rel(from), rel(to)]);
    if (this.valve.open) runs.push([rel(this.valve.openedAt), 'still open']);
    return runs;
  }
}

// ------------------------------------------------------------------ one gateway software

function facade(raw) {
  return {
    get: (sql, params) => Promise.resolve(raw.prepare(sql).get(...(params || []))),
    all: (sql, params) => Promise.resolve(raw.prepare(sql).all(...(params || []))),
    run: (sql, params) => { raw.prepare(sql).run(...(params || [])); return Promise.resolve(undefined); },
    async transaction(executor) {
      raw.exec('BEGIN IMMEDIATE');
      try { const out = await executor(facade(raw)); raw.exec('COMMIT'); return out; }
      catch (error) { try { raw.exec('ROLLBACK'); } catch (_) { /* already rolled back */ } throw error; }
    },
    close: (callback) => { if (callback) callback(); return Promise.resolve(); },
  };
}

function frameText(entry) { return entry.fPort + ':' + Buffer.from(entry.data, 'base64').toString('hex').toUpperCase(); }

class Gateway {
  // definition: which tree's code runs. database: an already open { raw, db } to continue on
  // (an upgrade), else a fresh copy of the tree's bundled database with one valve.
  constructor(definition, world, database) {
    this.definition = definition;
    this.world = world;
    this.log = [];
    this.flowContext = new Map();
    this.reservationHook = null;
    if (database) { this.raw = database.raw; this.db = database.db; }
    else {
      const file = path.join(tempDir('valve-eq-db-'), 'farming.db');
      fs.copyFileSync(definition.seedDb, file);
      this.raw = new DatabaseSync(file);
      this.db = facade(this.raw);
      const at = new Date(world.wall() - HOUR).toISOString();
      this.raw.prepare("INSERT INTO users(id, username, password_hash, user_uuid, created_at) VALUES (1,'equivalence','x','00000000-0000-4000-8000-000000000001',?)").run(at);
      this.raw.prepare("INSERT INTO irrigation_zones(id, name, user_id, timezone, zone_uuid, created_at, updated_at) VALUES (1,'Zone A',1,'UTC','11111111-1111-4111-8111-111111111111',?,?)").run(at, at);
      this.raw.prepare("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, current_state) VALUES (?,'Valve A','STREGA_VALVE',1,?,?,'CLOSED')").run(EUI, at, at);
    }
    // The moment between a command's reservation and the hand-over of its frame. From 0.8.2 on it
    // is the commit of the reservation transaction inside the encoder; in 0.8.1 the expectation
    // writer ran before the encoder node, so it is the step between those two nodes.
    const self = this;
    const transaction = this.db.transaction;
    this.db = { ...this.db, async transaction(executor) {
      const result = await transaction(executor);
      if (self.definition.transport === 'grpc' && result && result.transport && result.transport.effect_snapshot && !result.transport.phase) await self.fireReservationHook();
      return result;
    } };
    this.load();
  }

  async fireReservationHook() {
    const hook = this.reservationHook;
    this.reservationHook = null;
    if (hook) await hook();
  }

  // A process start: module state is gone, the database and ChirpStack's queue are not.
  load() {
    const prefix = this.definition.moduleDir + path.sep;
    for (const key of Object.keys(require.cache)) if (key.startsWith(prefix)) delete require.cache[key];
    this.valveControl = require(path.join(this.definition.moduleDir, 'osi-valve-control'));
    this.commandLedger = require(path.join(this.definition.moduleDir, 'osi-command-ledger'));
    const policyDir = path.join(this.definition.moduleDir, 'osi-irrigation-policy');
    this.irrigationPolicy = fs.existsSync(policyDir) ? require(policyDir) : null;
    this.flowContext = new Map();
  }

  client() {
    const world = this.world;
    return {
      async enqueueDownlink(item) { return world.enqueue(item); },
      async getDeviceQueue() { return world.readQueue(); },
      async flushDeviceQueue() { world.flush(); return { statusCode: 200 }; },
    };
  }

  async runNode(name, msg) {
    const self = this;
    const sent = [];
    const db = this.db;
    class Database { constructor() { return db; } }
    const record = (level) => (value) => self.log.push([level, name, typeof value === 'string' ? value : JSON.stringify(value)]);
    const context = {
      msg, Buffer, Date, setTimeout, console, crypto: nodeCrypto,
      env: { get(key) { return { CHIRPSTACK_APP_ACTUATORS: 'actuators-app', DEVICE_EUI: GATEWAY_EUI, AUTH_TOKEN_SECRET: AUTH_SECRET }[key] || ''; } },
      flow: { get: (key) => self.flowContext.get(key), set: (key, value) => { self.flowContext.set(key, value); } },
      global: { get() { return undefined; }, set() {} },
      context: { get() { return undefined; }, set() {} },
      node: { warn: record('warn'), error: record('error'), log: record('log'), status() {}, send(value) { sent.push(value); } },
      osiDb: { Database },
      osiLib: { require(module) {
        if (module === 'osi-db-helper') return { ok: true, value: { Database } };
        if (module === 'osi-valve-control') return { ok: true, value: self.valveControl };
        if (module === 'osi-command-ledger') return { ok: true, value: self.commandLedger };
        if (module === 'osi-irrigation-policy' && self.irrigationPolicy) return { ok: true, value: self.irrigationPolicy };
        return { ok: false, error: 'not available in the equivalence harness: ' + module };
      } },
      chirpstack: { createProvisioningClientFromEnv() { return self.client(); } },
    };
    const result = await vm.runInNewContext('(function(){\n' + this.definition.nodes[name].func + '\n})()', context, { timeout: 5000 });
    return { result, sent };
  }

  // write-strega-expectation, then the encoder, then the actuator_log builder, as wired.
  async dispatch(msg, toldEarlier) {
    const before = this.world.enqueued.length;
    const outcome = { answer: null };
    const written = (await this.runNode('writeExpectation', msg)).result;
    if (written) {
      if (this.definition.transport === 'mqtt') await this.fireReservationHook();
      const out = (await this.runNode('encoder', written)).result;
      if (Array.isArray(out)) {
        if (this.definition.transport === 'mqtt' && out[0] && out[0].payload) this.world.enqueue(out[0].payload);
        if (out[1] && out[1]._log_ctx) {
          const log = (await this.runNode('actuatorLog', out[1])).result;
          if (log && log.topic) await this.db.run(log.topic);
        }
        if (out[3]) outcome.answer = { status: out[3].statusCode, error: out[3].payload && out[3].payload.error ? out[3].payload.error : null, body: out[3].payload };
        if (out[2] && out[2].payload) { try { outcome.ack = JSON.parse(out[2].payload); } catch (_) { outcome.ack = null; } }
      }
    }
    outcome.frames = this.world.enqueued.slice(before);
    // What the caller is told, whatever the status number: 0.8.1 answered a local request before
    // it sent (the caller passes that answer in), later releases answer after the hand-over, a
    // cloud command is answered by its ACK, and the scheduler has no caller. Where this release
    // gives no answer of its own, the hand-over is the decision.
    const told = outcome.answer ? outcome.answer.status : (toldEarlier != null ? toldEarlier : null);
    if (told != null) outcome.decision = told >= 200 && told < 300 ? 'accepted' : 'refused';
    else if (this.definition.transport === 'grpc' && outcome.ack && outcome.ack.result) outcome.decision = outcome.ack.result === 'SUCCESS' ? 'accepted' : 'refused';
    else outcome.decision = outcome.frames.length ? 'accepted' : 'refused';
    return outcome;
  }

  async manual(action, minutes) {
    const row = await this.db.get('SELECT * FROM devices WHERE deveui=?', [EUI]);
    const out = (await this.runNode('manualBuilder', {
      payload: [row], actor_user_uuid: null,
      osi: { request: { kind: 'valve_command', targetEui: EUI, actorId: 1, action, durationMinutes: minutes == null ? undefined : minutes } },
    })).result;
    // 0.8.1 writes actuator_log from the builder's second output through a sqlite node.
    if (out[1] && out[1].topic) await this.db.run(out[1].topic);
    return this.dispatch(out[0], out[2] && out[2].statusCode != null ? out[2].statusCode : null);
  }

  async scheduler(minutes) {
    const now = new Date().toISOString();
    const msg = { payload: { type: 'actuator_command', device: { devEui: EUI, zone_id: null },
      data: { action: 'OPEN_FOR_DURATION', duration_minutes: minutes, reason: 'scheduler_threshold', mean_kpa_last_hour: 60, threshold_kpa: 30, trigger_metric: 'SWT', n_points_last_hour: 6, window: { min_recorded_at: null, max_recorded_at: null }, timestamp: now } },
    _systemActuation: true };
    if (this.definition.transport === 'grpc') msg._stregaInternalSource = 'scheduler';
    return this.dispatch(msg);
  }

  async cloud(command) {
    const out = (await this.runNode('routeCommand', { payload: JSON.stringify({ deviceEui: EUI, gatewayDeviceEui: GATEWAY_EUI, ...command }) })).result;
    if (!out || !out[0]) return { frames: [], answer: null, routed: false, decision: 'refused' };
    return this.dispatch(out[0]);
  }

  async service(data) {
    const msg = { payload: { type: 'actuator_command', device: { devEui: EUI }, data }, actor_user_uuid: null, _actorUserUuid: null };
    if (this.definition.transport === 'grpc') msg._stregaHttpResponse = { statusCode: 202, payload: { status: 'PENDING', confirmation: 'downlink_queued' } };
    return this.dispatch(msg);
  }

  // A one-time schedule that is due now, and the 60 s node that fires it. 0.8.1 emits the open
  // as a message into the same chain as a manual open; later releases send it from the module.
  async oneTime(minutes) {
    this.onceCount = (this.onceCount || 0) + 1;
    const before = this.world.enqueued.length;
    const now = new Date().toISOString();
    await this.db.run("INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, fire_at, duration_minutes, timezone, enabled, once_state, created_at, updated_at) VALUES (?,?,'ONCE',?,?,'UTC',1,'PENDING',?,?)",
      ['equivalence-once-' + this.onceCount, EUI, now, minutes, now, now]);
    const { sent } = await this.runNode('oneTime', { payload: Date.now() });
    for (const emitted of sent) await this.dispatch(emitted);
    const frames = this.world.enqueued.slice(before);
    return { frames, answer: null, decision: frames.length ? 'accepted' : 'refused' };
  }

  // PUT /api/irrigation-zones/1/schedule from "Build UPSERT" on. The zone row is what "Verify Zone
  // Ownership" selects in every release: the zone joined to its schedule row, deleted or not.
  async saveSchedule(patch) {
    const zone = await this.db.get('SELECT iz.id, iz.zone_uuid, iz.gateway_device_eui, s.sync_version AS schedule_sync_version, s.last_applied_at, s.deleted_at AS schedule_deleted_at ' +
      'FROM irrigation_zones iz LEFT JOIN irrigation_schedules s ON s.irrigation_zone_id = iz.id WHERE iz.id = 1 AND iz.user_id = 1 AND iz.deleted_at IS NULL LIMIT 1');
    const msg = { payload: [zone], osi: { request: { v: 1, kind: 'zone_schedule_put', requestId: 'equivalence', actorId: 1, zoneId: 1, validatedPatch: patch } } };
    const built = (await this.runNode('scheduleUpsert', msg)).result;
    let saved = false; let error = null;
    if (this.definition.nodes.scheduleAdapter) {
      const out = (await this.runNode('scheduleAdapter', built[0])).result;
      const answer = out && out[1];
      saved = Boolean(answer && answer.statusCode === 200);
      if (!saved) error = answer && answer.payload ? answer.payload.message : 'no answer';
    } else {
      // 0.8.1: the sqlite node behind "Build UPSERT" runs the statement.
      try { await this.db.run(built[0].topic); saved = true; } catch (failure) { error = failure.message; }
    }
    return { saved, error };
  }
  async scheduleRow() {
    const row = await this.db.get('SELECT trigger_metric, threshold_kpa, duration_minutes, enabled, response_mode, sync_version, deleted_at FROM irrigation_schedules WHERE irrigation_zone_id = 1');
    return row ? { trigger_metric: row.trigger_metric, threshold_kpa: row.threshold_kpa, duration_minutes: row.duration_minutes, enabled: row.enabled, response_mode: row.response_mode, sync_version: row.sync_version, deleted: row.deleted_at != null } : null;
  }

  async report(state, at) {
    this.reportCount = (this.reportCount || 0) + 1;
    await this.runNode('persistUplink', { formattedData: { devEui: EUI, timestamp: at, arrivalTimestamp: new Date().toISOString(), rawTimestamp: at, currentState: state, batPct: 90,
      eventIdentity: { deduplicationId: 'equivalence-' + at + '-' + state, fCnt: this.reportCount, fPort: 4 } } });
  }

  async ticks() {
    await this.runNode('reconciliation', { payload: Date.now() });
    await this.runNode('observe', { payload: Date.now() });
  }

  // POST /api/valves/:deveui/cancel-actuation as the operator's browser sends it: the route node
  // of this tree, with a token of the valve's owner.
  async cancel(which) {
    const before = this.world.enqueued.length;
    // which: { open: n } names the n-th timed open of this run, by its row in this tree's records.
    const named = which && Number.isInteger(which.open) ? (await this.rows()).filter((row) => Number(row.commanded_duration_seconds) > 0)[which.open] : null;
    const url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const claims = url(Buffer.from(JSON.stringify({ userId: 1, username: 'equivalence' })));
    const token = claims + '.' + url(nodeCrypto.createHmac('sha256', AUTH_SECRET).update(claims).digest());
    const out = (await this.runNode('cancelRoute', { req: { headers: { authorization: 'Bearer ' + token }, params: { deveui: EUI } }, payload: named ? { expectation_id: named.expectation_id } : {} })).result;
    return { status: out ? out.statusCode : null, body: (out && out.payload) || {}, frames: this.world.enqueued.slice(before) };
  }

  async shownState() { return (await this.db.get('SELECT current_state FROM devices WHERE deveui=?', [EUI])).current_state; }
  rows() { return this.db.all('SELECT * FROM valve_actuation_expectations WHERE device_eui=? ORDER BY rowid', [EUI]); }
  errors() { return this.log.filter((entry) => entry[0] === 'error'); }
}

// Rows a 0.8.0 or 0.8.1 gateway leaves behind, carried into a database of this checkout the way
// the ordered migrations keep them: same values, new columns empty.
async function carryOver(from, to) {
  const columns = ['expectation_id', 'device_eui', 'zone_id', 'command_id', 'effect_key', 'commanded_at', 'commanded_duration_seconds', 'expected_close_at',
    'flow_rate_lpm', 'flow_rate_source', 'estimated_gross_liters', 'volume_source', 'observed_open_at', 'observed_close_at', 'reconciliation_state', 'cancel_reason', 'created_at', 'trigger'];
  for (const row of await from.db.all('SELECT * FROM valve_actuation_expectations ORDER BY rowid')) {
    await to.db.run('INSERT INTO valve_actuation_expectations(' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')', columns.map((column) => row[column] === undefined ? null : row[column]));
  }
  for (const row of await from.db.all('SELECT deveui, irrigation_zone_id, action, duration_minutes, reason, created_at FROM actuator_log ORDER BY rowid')) {
    await to.db.run('INSERT INTO actuator_log(deveui, irrigation_zone_id, action, duration_minutes, reason, created_at) VALUES (?,?,?,?,?,?)', [row.deveui, row.irrigation_zone_id, row.action, row.duration_minutes, row.reason, row.created_at]);
  }
  const device = await from.db.get('SELECT current_state, target_state, updated_at FROM devices WHERE deveui=?', [EUI]);
  await to.db.run('UPDATE devices SET current_state=?, target_state=?, updated_at=? WHERE deveui=?', [device.current_state, device.target_state, device.updated_at, EUI]);
}

// ------------------------------------------------------------------ running a sequence

// script(api) drives one gateway through a sequence. Every api call that the valve or the
// operator could notice appends one trace entry.
// run: { start: definition, upgradeTo?: definition, databaseOf?: definition }.
async function runSequence(t, run, worldOptions, script) {
  const world = new World(t, worldOptions);
  // A 0.8.2 gateway is started on this checkout's database: its own bundled database is one
  // additive migration older, and the upgrade keeps the file.
  let gateway = new Gateway(run.start, world);
  if (run.databaseOf) {
    const fresh = new Gateway(run.databaseOf, world);
    gateway = new Gateway(run.start, world, { raw: fresh.raw, db: fresh.db });
  }
  const trace = [];
  let comparedFrom = 0;
  let recordsFrom = 0;
  const note = async (entry) => {
    entry.shown = await gateway.shownState();
    entry.at = world.minutes();
    trace.push(entry);
    return entry;
  };
  const command = async (label, outcome) => note({
    op: label,
    decision: outcome.decision,
    sent: outcome.frames.length > 0,
    frames: outcome.frames.map(frameText),
    expiry: outcome.frames.map((frame) => frame.expiresAt == null ? null : Math.round((frame.expiresAt - frame.createdAt) / MINUTE * 100) / 100),
    answer: outcome.answer ? { status: outcome.answer.status, error: outcome.answer.error } : null,
    body: outcome.answer ? outcome.answer.body : null,
  });
  const api = {
    world,
    gateway: () => gateway,
    wait(ms) { world.advance(ms); },
    open: async (minutes = 2) => command('manual open ' + minutes + ' min', await gateway.manual('OPEN_FOR_DURATION', minutes)),
    close: async () => command('manual CLOSE', await gateway.manual('CLOSE')),
    closeFor: async (minutes) => command('manual close for ' + minutes + ' min', await gateway.manual('CLOSE_FOR_DURATION', minutes)),
    scheduler: async (minutes = 15) => command('scheduler open ' + minutes + ' min', await gateway.scheduler(minutes)),
    oneTime: async (minutes = 15) => command('one-time schedule fires, ' + minutes + ' min', await gateway.oneTime(minutes)),
    cloud: async (label, cmd) => command('cloud ' + label, await gateway.cloud(cmd)),
    service: async (label, data) => command('service ' + label, await gateway.service(data)),
    // The operator's cancel. What the caller is told is compared field by field with v0.8.1's
    // answer (cancelAnswer, with the status number: the route is the same in both). What this
    // release's answer says beyond that is kept apart (cancelAdded) for the test to pin.
    async cancel(which) {
      const out = await gateway.cancel(which);
      const body = out.body;
      const accepted = out.status >= 200 && out.status < 300;
      const cancelAnswer = { http: out.status };
      for (const key of CANCEL_ANSWER) cancelAnswer[key] = body[key] === undefined ? null : (key === 'dropped_opens' && body[key] ? body[key].count : body[key]);
      const cancelAdded = {};
      for (const key of Object.keys(body).sort()) if (!CANCEL_ANSWER.includes(key) && !CANCEL_VOLATILE.includes(key)) cancelAdded[key] = body[key];
      return note({ op: which ? 'cancel of open ' + which.open : 'cancel', decision: accepted ? 'accepted' : 'refused', outcome: accepted ? body.status : 'not cancelled', cancelAnswer, cancelAdded,
        sent: out.frames.length > 0, frames: out.frames.map(frameText), expiry: out.frames.map((frame) => frame.expiresAt == null ? null : Math.round((frame.expiresAt - frame.createdAt) / MINUTE * 100) / 100), queue: world.orderedQueue().map(frameText) });
    },
    // The valve calls in. report: 'deliver' hands its state report to the gateway now; 'lost' is an
    // uplink no gateway received, so ChirpStack gets no chance to send a frame either; any other
    // string is a report ChirpStack received and the gateway software gets later, by deliverHeld().
    // After a received uplink ChirpStack hands the valve at most one frame (Class A).
    async uplink({ report = 'deliver' } = {}) {
      const state = world.valveState();
      const stamped = new Date(world.wall()).toISOString();
      if (report === 'deliver') await gateway.report(state, stamped);
      else if (report !== 'lost') world.held.set(report, { state, at: stamped });
      let delivered = null; let effect = null; let discarded = [];
      if (report !== 'lost') {
        const next = world.selectNext();
        discarded = next.discarded.map(frameText);
        if (next.frame) { delivered = frameText(next.frame); effect = world.valveApply(next.frame); }
      }
      return note({ op: 'valve uplink', reported: report === 'deliver' ? state : (report === 'lost' ? 'not received' : 'delayed'), delivered, effect, discarded, valve: world.valveState() });
    },
    async deliverHeld(name) {
      const held = world.held.get(name);
      await gateway.report(held.state, held.at);
      return note({ op: 'late report ' + held.state + ' arrives', valve: world.valveState() });
    },
    // fn runs once, between the next command's reservation and the hand-over of its frame.
    atReservation(fn) { gateway.reservationHook = fn; },
    async saveSchedule(patch) {
      const out = await gateway.saveSchedule(patch);
      return note({ op: 'save zone schedule', saved: out.saved, error: out.error, schedule: await gateway.scheduleRow() });
    },
    // What a zone delete writes to the schedule row, on a zone that stays: the state #631's
    // council injected. No product path was found that leaves it.
    async softDeleteSchedule() {
      const now = new Date().toISOString();
      await gateway.db.run('UPDATE irrigation_schedules SET enabled = 0, deleted_at = ?, updated_at = ?, sync_version = COALESCE(sync_version, 0) + 1 WHERE irrigation_zone_id = 1 AND deleted_at IS NULL', [now, now]);
      return note({ op: 'schedule row soft-deleted, zone kept', schedule: await gateway.scheduleRow() });
    },
    // Someone opens the valve at the valve (magnet, Bluetooth, its own weekly plan): open, no timer
    // the gateway knows of.
    async openedAtValve() { world.valveSettle(); world.valve.closeAt = null; world.valveSet(true, world.real); return note({ op: 'valve opened at the valve', valve: world.valveState() }); },
    async ticks() { await gateway.ticks(); },
    async reboot() { world.reboot(); gateway.load(); return note({ op: 'gateway reboot' }); },
    async ntp() { world.ntpReply(); return note({ op: 'NTP reply' }); },
    async stepClock(ms) { world.stepClock(ms); return note({ op: 'clock steps ' + (ms > 0 ? '+' : '') + ms / MINUTE + ' min' }); },
    // The software is replaced. Before this point both sides of a comparison ran the old release.
    async upgrade() {
      if (run.upgradeTo) {
        if (run.upgradeTo.transport === gateway.definition.transport) gateway = new Gateway(run.upgradeTo, world, { raw: gateway.raw, db: gateway.db });
        else { const next = new Gateway(run.upgradeTo, world); await carryOver(gateway, next); gateway = next; }
      }
      comparedFrom = trace.length;
      recordsFrom = (await gateway.rows()).length;
      return note({ op: 'upgrade' });
    },
    rows: () => gateway.rows(),
  };
  await script(api);
  await gateway.ticks();
  const rows = await gateway.rows();
  const opens = rows.filter((row) => Number(row.commanded_duration_seconds) > 0);
  trace.push({ op: 'end', at: world.minutes(), runs: world.valveRuns(), queue: world.orderedQueue().map(frameText), labels: opens.map((row) => row.trigger || null),
    history: opens.map((row) => row.reconciliation_state), shown: await gateway.shownState() });
  // The records this release kept, for the rows written after an upgrade point: one per commanded
  // open with its duration, and every record that belongs to no command.
  const transportOf = (row) => { try { return JSON.parse(row.transport_json || '{}') || {}; } catch (_) { return {}; } };
  const untrusted = (row) => { const seen = transportOf(row).untrusted_report; return seen ? Object.keys(seen).sort().join('+') : null; };
  const why = (row) => (transportOf(row).observation || {}).unattributed || null;
  const kept = rows.slice(recordsFrom);
  const records = {
    commanded: kept.filter((row) => row.command_id != null && Number(row.commanded_duration_seconds) > 0)
      .map((row) => ({ seconds: Number(row.commanded_duration_seconds), state: row.reconciliation_state, untrusted_report: untrusted(row) })),
    reportOnly: kept.filter((row) => row.command_id == null).map((row) => ({ trigger: row.trigger || null, why: why(row), state: row.reconciliation_state })),
  };
  // The opens this run handed to the radio side after that point, in seconds, from the frames.
  const unit = { 21: 1, 41: 60, 81: 3600 };
  const handedOver = trace.slice(comparedFrom).filter((entry) => !entry.op.startsWith('cancel')).flatMap((entry) => entry.frames || [])
    .map((frame) => /^2:(21|41|81)([0-9A-F]{2})$/.exec(frame)).filter(Boolean).map((match) => unit[match[1]] * parseInt(match[2], 16));
  return { trace, comparedFrom, errors: gateway.errors(), log: gateway.log, gateway, world, records, handedOver };
}

// The fields the caller, the valve or an operator at the valve panel could tell apart: what the
// caller is told (decision, and the whole answer to a cancel), the frames, what the valve does,
// the state shown. For a command the status number and the text of the answer are recorded and
// not compared: 0.8.1 answered a local request before it sent, this release answers after. The
// run history (the reconciliation state of each open, field 'history') is compared only where a
// sequence asks for it: v0.8.1 is the oracle for what the gateway decides and sends, not for
// what it records. The records of this checkout are returned by runSequence and asserted by the
// test against what was commanded.
const COMPARED = ['decision', 'sent', 'frames', 'expiry', 'outcome', 'cancelAnswer', 'reported', 'delivered', 'discarded', 'valve', 'shown', 'queue', 'runs', 'labels', 'saved', 'schedule'];
// The fields of v0.8.1's answer to a cancel, and those that differ from run to run.
const CANCEL_ANSWER = ['status', 'confirmation', 'cancelled', 'previous_state', 'reason', 'chirpstack_queue_status', 'queue_scope', 'dropped_opens', 'message'];
const CANCEL_VOLATILE = ['deveui', 'expectation_id', 'timestamp'];

function differences(oracle, other, alsoCompare = []) {
  const out = [];
  const from = Math.max(oracle.comparedFrom, other.comparedFrom);
  const length = Math.max(oracle.trace.length, other.trace.length);
  for (let index = from; index < length; index += 1) {
    const a = oracle.trace[index] || {}; const b = other.trace[index] || {};
    if (a.op !== b.op) { out.push({ step: index, op: a.op || b.op, field: 'op', oracle: a.op, candidate: b.op }); continue; }
    for (const field of COMPARED.concat(alsoCompare)) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) out.push({ step: index, op: a.op, field, oracle: a[field], candidate: b[field] });
    }
  }
  return out;
}

function describe(result) {
  return result.trace.map((entry, index) => {
    const parts = [];
    for (const field of ['decision', 'sent', 'frames', 'expiry', 'outcome', 'cancelAnswer', 'cancelAdded', 'reported', 'delivered', 'effect', 'discarded', 'valve', 'shown', 'queue', 'runs', 'labels', 'history', 'saved', 'error', 'schedule']) {
      if (entry[field] !== undefined && entry[field] !== null && !(Array.isArray(entry[field]) && !entry[field].length && field !== 'runs' && field !== 'queue')) parts.push(field + '=' + JSON.stringify(entry[field]));
    }
    if (entry.answer) parts.push('answer=' + entry.answer.status + (entry.answer.error ? ' ' + entry.answer.error : '') + (entry.body && entry.body.warning ? ' warning=' + entry.body.warning : ''));
    return String(index).padStart(2) + ' +' + String(entry.at).padStart(7) + ' min  ' + entry.op + '  ' + parts.join(' ');
  }).join('\n');
}

module.exports = { EUI, GATEWAY_EUI, SECOND, MINUTE, HOUR, DAY, REPO_ROOT, SHARE, candidate, release, runSequence, differences, describe, World, Gateway, frameText };
