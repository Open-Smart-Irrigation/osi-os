'use strict';

// Decode and execute the shipped Function node with the real osi-lib, scope,
// policy, valve-control, and SQLite helpers.  ChirpStack remains the accepted
// construction seam: this harness replaces only its client factory with a
// transport recorder so the route's post-commit sends/cancellation are real.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

async function main() {
const root = path.resolve(__dirname, '..');
const profile = process.argv[2] || 'bcm2712';
assert.ok(['bcm2712', 'bcm2709'].includes(profile), `unsupported profile ${profile}`);
const runtimeRoot = path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/node-red`);
const seed = path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/db/farming.db`);
const flowPath = path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const route = flow.find((node) => node.id === 'conditional-policy-route-fn');
assert.ok(route, `${profile}: route function node is installed`);
assert.deepEqual(route.libs, [
  { var: 'osiDb', module: 'osi-db-helper' },
  { var: 'osiLib', module: 'osi-lib' },
  { var: 'chirpstack', module: 'osi-chirpstack-helper' },
]);

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `conditional-route-${profile}-`)), 'farming.db');
fs.copyFileSync(seed, file);
const setup = new DatabaseSync(file);
setup.exec('PRAGMA foreign_keys=ON');
const now = '2026-10-18T10:00:00.000Z';
setup.prepare("INSERT INTO users(id,username,password_hash,created_at,updated_at,role,user_uuid) VALUES (1,'owner','hash',?,?, 'researcher','user-owner'),(2,'scoped','hash',?,?, 'researcher','user-scoped')").run(now, now, now, now);
setup.prepare("INSERT INTO irrigation_zones(id,name,user_id,created_at,updated_at,timezone,zone_uuid) VALUES (1,'Granted zone',1,?,?, 'UTC','zone-route-granted'),(2,'Same owner denied zone',1,?,?, 'UTC','zone-route-denied')").run(now, now, now, now);
const valveA = '0011223344556677';
const valveB = '0011223344556688';
setup.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id) VALUES (?,?,?,?,?,?,?),(?,?,?,?,?,?,?)").run(
  valveA, 'Granted valve', 'STREGA_VALVE', 1, now, now, 1,
  valveB, 'Denied valve', 'STREGA_VALVE', 1, now, now, 2,
);
setup.prepare("INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at,updated_at,sync_version) VALUES (?,?,?,?,?,1)").run('assignment-route-granted', 'user-scoped', 'zone-route-granted', now, now);
setup.close();

// osi-lib resolves all extracted modules from the selected profile's runtime
// tree.  The profile payloads are expected to be byte-identical, but loading
// the selected tree here catches a missing mirrored module too.
process.env.OSI_LIB_BASE = runtimeRoot;
process.env.OSI_SCOPED_ACCESS = '1';
process.env.OSI_LIB_COOLDOWN_MS = '1';
process.env.NODE_PATH = path.join(path.resolve(root, '../..'), 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules');
require('node:module').Module._initPaths();
// Outside a gateway image (CI) neither the native sqlite3 binding nor the
// ChirpStack gRPC packages are installed. The database helper then runs over
// node:sqlite, and the ChirpStack helper is replaced by its only member the
// route uses, createProvisioningClientFromEnv, which this harness overrides.
require('./lib/sqlite3-node-adapter').installSqlite3Fallback();
const osiDbReal = require(path.join(runtimeRoot, 'osi-db-helper'));
const osiLib = require(path.join(runtimeRoot, 'osi-lib'));
let chirpstackReal = {};
try {
  chirpstackReal = require(path.join(runtimeRoot, 'osi-chirpstack-helper'));
} catch (error) {
  if (!error || error.code !== 'MODULE_NOT_FOUND') throw error;
}
class TestDatabase extends osiDbReal.Database {
  constructor() { super(file); }
}
const osiDb = { ...osiDbReal, Database: TestDatabase };
const transport = {
  calls: [],
  async flushDeviceQueue(deviceEui) {
    this.calls.push({ method: 'flush', device_eui: String(deviceEui).toUpperCase() });
    return { statusCode: 204 };
  },
  async getDeviceQueue(deviceEui) {
    this.calls.push({ method: 'read', device_eui: String(deviceEui).toUpperCase() });
    return [];
  },
  async enqueueDownlink(item) {
    this.calls.push({ method: 'enqueue', device_eui: String(item.devEui || item.device_eui).toUpperCase(), fPort: item.fPort });
    return { id: `queue-${this.calls.length}` };
  },
};
const chirpstack = { ...chirpstackReal, createProvisioningClientFromEnv: () => transport };
const secret = 'conditional-route-test-secret';
const tokenPayload = Buffer.from(JSON.stringify({ userId: 2, username: 'scoped' })).toString('base64url');
const token = `Bearer ${tokenPayload}.${crypto.createHmac('sha256', secret).update(tokenPayload).digest('base64url')}`;
const envValues = {
  OSI_SCOPED_ACCESS: '1',
  AUTH_TOKEN_SECRET: secret,
  CHIRPSTACK_APP_ACTUATORS: 'route-test-actuators',
};
const env = { get(name) { return envValues[name] || ''; } };
const node = {
  warnings: [],
  errors: [],
  warn(value) { this.warnings.push(String(value && value.message || value)); },
  error(value) { this.errors.push(String(value && value.message || value)); },
};
const globalObject = { get(name) { return name === 'fs' ? fs : undefined; } };
const invoke = new Function('msg', 'osiDb', 'osiLib', 'chirpstack', 'env', 'global', 'node', route.func);
function request(method, zoneId, body, pathSuffix = '') {
  const requestPath = `/api/irrigation-zones/${zoneId}/irrigation-policy${pathSuffix}`;
  return {
    req: {
      method,
      path: requestPath,
      url: requestPath,
      originalUrl: requestPath,
      params: { id: String(zoneId) },
      headers: { authorization: token, 'content-length': String(Buffer.byteLength(JSON.stringify(body || {}))) },
      body,
    },
    payload: body,
  };
}
async function call(method, zoneId, body, pathSuffix = '') {
  const msg = request(method, zoneId, body, pathSuffix);
  return invoke(msg, osiDb, osiLib, chirpstack, env, globalObject, node);
}

const scheduleBody = {
  expected_policy_version: null,
  condition: { kind: 'DENDRO', minimum_stress: 'moderate', response_mode: 'fixed' },
  timezone: 'UTC',
  enabled: false,
  observation_window_minutes: 60,
  min_interval_minutes: 60,
  max_daily_minutes: 240,
  schedules: [{
    device_eui: valveA,
    weekdays_mask: 127,
    start_time: '06:00',
    duration_minutes: 10,
    enabled: true,
    execution: 'conditional',
    expected_sync_version: null,
  }],
};
const put = await call('PUT', 1, { ...scheduleBody, zone_uuid: 'zone-route-granted' });
assert.equal(put.statusCode, 202, `${profile}: scoped granted PUT should commit`);
assert.equal(put.payload.policy.zone_uuid, 'zone-route-granted');
assert.ok(Array.isArray(put.payload.revision_results) && put.payload.revision_results.length === 1, `${profile}: PUT sends prepared revision`);
assert.ok(transport.calls.some((entry) => entry.method === 'flush'), `${profile}: PUT uses real valve flush seam`);
assert.ok(transport.calls.some((entry) => entry.method === 'enqueue'), `${profile}: PUT uses real valve enqueue seam`);

const beforeDenied = new DatabaseSync(file).prepare("SELECT COUNT(*) AS n FROM irrigation_policies WHERE zone_uuid='zone-route-denied'").get().n;
const conflict = await call('PUT', 1, { ...scheduleBody, zone_uuid: 'zone-route-denied' });
assert.equal(conflict.statusCode, 409, `${profile}: body zone override is rejected`);
assert.equal(conflict.payload.error, 'zone_identity_conflict');
const afterDenied = new DatabaseSync(file).prepare("SELECT COUNT(*) AS n FROM irrigation_policies WHERE zone_uuid='zone-route-denied'").get().n;
assert.equal(afterDenied, beforeDenied, `${profile}: conflicting body did not mutate same-owner denied zone`);

const denied = await call('GET', 2, {});
assert.equal(denied.statusCode, 404, `${profile}: scoped editor cannot read ungranted same-owner zone`);
assert.equal(denied.payload.error, 'policy_route_error', `${profile}: scope rejection stays fail-closed`);

const policyRow = new DatabaseSync(file).prepare("SELECT sync_version FROM irrigation_policies WHERE zone_uuid='zone-route-granted'").get();
const retry = await call('POST', 1, { device_eui: valveA }, '/retry-valve');
assert.equal(retry.statusCode, 202, `${profile}: retry route sends after preparation`);
assert.equal(retry.payload.device_eui, valveA);
assert.ok(retry.payload.send, `${profile}: retry returns sender result`);
assert.ok(transport.calls.filter((entry) => entry.method === 'enqueue').length >= 2, `${profile}: retry reached enqueue seam`);

const activeExpectation = new DatabaseSync(file);
activeExpectation.prepare("INSERT INTO valve_actuation_expectations(expectation_id,device_eui,zone_id,command_id,commanded_at,commanded_duration_seconds,expected_close_at,volume_source,reconciliation_state,created_at,trigger) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
  'route-active-expectation', valveA, 1, 'route-command', now, 600, '2026-10-18T10:10:00.000Z', 'unknown', 'PENDING_OBSERVATION', now, 'conditional',
);
activeExpectation.close();
const pause = await call('POST', 1, { expected_policy_version: Number(policyRow.sync_version) }, '/pause');
assert.equal(pause.statusCode, 202, `${profile}: pause preserves transport uncertainty as pending`);
assert.ok(pause.payload.cancellations.length === 1, `${profile}: pause invokes cancellation seam`);
assert.ok(transport.calls.filter((entry) => entry.method === 'flush').length >= 2, `${profile}: pause reaches ChirpStack cancellation flush`);
const afterPause = new DatabaseSync(file).prepare("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='route-active-expectation'").get();
assert.equal(afterPause.reconciliation_state, 'PENDING_OBSERVATION', `${profile}: uncertain cancellation preserves owner history`);

console.log(`OK (decoded conditional policy route, ${profile}; ${transport.calls.length} transport calls)`);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
