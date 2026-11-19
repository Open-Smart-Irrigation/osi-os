'use strict';
// Exercise shipped transaction callers with the real helper FIFO and a file DB.
// Inject failure after the caller's SQL, with foreign work already queued; a
// foreign plain write must survive and a second transaction must begin once.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSqlite3Adapter } = require('./lib/sqlite3-node-adapter');
const { maskNonCode } = require('./verify-flows-output-arity');
const ROOT = path.resolve(__dirname, '..');
const SHARE = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share');
const MODS = path.join(SHARE, 'node-red');
const helperPath = path.join(MODS, 'osi-db-helper/index.js');
const flows = JSON.parse(fs.readFileSync(path.join(SHARE, 'flows.json')));
const replication = require(process.env.OSI_PEER_REPLICATION_UNDER_TEST || path.join(MODS, 'osi-irrigation-policy/replication'));
const { facadeDb: queuedFixtureDb } = require('./lib/queued-db-fixture');
const EUI = 'A840410000000001';
const GATEWAY = '0016C001F1000001';
const PRIOR = EUI;
const ARRAY = 'AABBCCDDEEFF0011';
const USER = 'transaction-owner';
const ZONE = 'transaction-zone';
const calibration = { array_id: ARRAY, sensor_id: 'test', sensor1_a: 0, sensor1_b: 1, sensor1_c: 0, sensor2_a: 0, sensor2_b: 1, sensor2_c: 0, sensor3_a: 0, sensor3_b: 1, sensor3_c: 0 };

test('SQLite fixture uses the shipped helper API and keeps foreign writes outside rollback', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-queued-fixture-'));
  const raw = new DatabaseSync(path.join(dir, 'fixture.db'));
  t.after(() => { raw.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  raw.exec('CREATE TABLE probe(value TEXT)');
  const db = queuedFixtureDb(raw);
  assert.equal(queuedFixtureDb(raw), db, 'one shared queue for the fixture connection');
  for (const name of ['get', 'all', 'run', 'transaction']) assert.equal(typeof db[name], 'function', name);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const failure = new Error('fixture rollback');
  const owner = db.transaction(async (tx) => {
    await tx.run("INSERT INTO probe VALUES ('owner')");
    entered();
    await held;
    throw failure;
  });
  await started;
  const plain = db.run("INSERT INTO probe VALUES ('plain')");
  const other = db.transaction((tx) => tx.run("INSERT INTO probe VALUES ('transaction')"));
  assert.deepEqual(raw.prepare('SELECT value FROM probe').all().map((row) => row.value), ['owner']);
  const rejected = assert.rejects(owner, (error) => error === failure);
  release();
  await rejected;
  await Promise.all([plain, other]);
  assert.deepEqual((await db.all('SELECT value FROM probe')).map((row) => row.value), ['plain', 'transaction']);
  assert.equal((await db.get('SELECT count(*) AS count FROM probe')).count, 2);
  await new Promise((resolve, reject) => db.get('SELECT count(*) AS count FROM probe', (error, row) => {
    if (error) return reject(error);
    try { assert.equal(row.count, 2); resolve(); } catch (failure) { reject(failure); }
  }));
});

function declaration(source, name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const masked = maskNonCode(source);
  const brace = masked.indexOf('{', start);
  let depth = 1, end = brace + 1;
  while (depth && end < masked.length) { if (masked[end] === '{') depth++; if (masked[end] === '}') depth--; end++; }
  assert.equal(depth, 0);
  return source.slice(start, end);
}

function fixture(t, rollback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-manual-callers-'));
  const filename = path.join(dir, 'farm.db');
  const native = new DatabaseSync(filename);
  native.exec('PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;');
  native.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  native.exec(`CREATE TABLE isolation_probe(value TEXT);
    INSERT INTO users(id,username,password_hash,user_uuid,role,created_at) VALUES(101,'owner','hash','${USER}','researcher','2026-11-19');
    INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,created_at,updated_at) VALUES(101,'Zone',101,'${ZONE}','${PRIOR}','2026-11-19','2026-11-19');
    INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,chameleon_enabled,created_at,updated_at) VALUES('${EUI}','Sensor','DRAGINO_LSN50',101,101,'${PRIOR}',1,'2026-11-19','2026-11-19');`);
  native.close();
  const adapter = createSqlite3Adapter(), handles = [];
  const Base = adapter.Database;
  adapter.Database = class extends Base { constructor(...args) { super(...args); handles.push(this); } };
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === helperPath) return adapter;
    return original.call(this, request, parent, isMain);
  };
  let helper;
  try { delete require.cache[helperPath]; helper = require(helperPath); }
  finally { Module._load = original; }
  const other = new helper.Database(filename);
  let entered = 0, foreignExecutions = 0;
  const foreign = [], warnings = [];
  const failure = new Error('injected owner rollback');
  const owner = new helper.Database(filename);
  const transaction = owner.transaction.bind(owner);
  owner.transaction = (fn) => transaction(async (tx) => {
    entered++;
    const run = tx.run.bind(tx);
    let queued = false;
    tx.run = async (...args) => {
      const result = await run(...args);
      if (!queued) {
        queued = true;
        foreign.push(other.transaction(async (outside) => {
          foreignExecutions++;
          await outside.run("INSERT INTO isolation_probe VALUES ('transaction')");
        }));
        foreign.push(other.run("INSERT INTO isolation_probe VALUES ('plain')"));
      }
      return result;
    };
    const result = await fn(tx);
    assert.ok(queued, 'caller executed a write');
    if (rollback) throw failure;
    return result;
  });
  const scope = {
    verifyBearer: () => ({ userId: 101, username: 'owner' }),
    assertFreshRole: async () => ({ role: 'researcher', zoneUuids: new Set([ZONE]) }),
    canMutate: () => true,
    invalidateScope() {},
    assertFreshDeviceAccess: async () => {},
    resolveZoneUuidById: async () => ZONE,
    assertFreshZoneAccess: async () => {},
  };
  const chameleon = require(path.join(MODS, 'osi-chameleon-helper'));
  const libraries = { scope, 'entity-name': { normalizeEntityName: (value) => value }, 'osi-irrigation-policy': replication };
  const node = { warn: (text) => warnings.push(text), error: (text) => warnings.push(text) };
  const env = { get: (key) => ({ OSI_SCOPED_ACCESS: '1', DEVICE_EUI: GATEWAY })[key] };
  const osiLib = { require: (key) => libraries[key] ? { ok: true, value: libraries[key] } : { ok: false, error: key } };
  const osiDb = { Database: function() { return owner; } };
  const flow = { get: () => ({}), set() {} };
  async function verify() {
    assert.equal(entered, 1, 'exactly one queued owner transaction');
    await Promise.all(foreign);
    assert.equal(foreignExecutions, 1, 'foreign transaction executed exactly once');
    assert.deepEqual((await other.all('SELECT value FROM isolation_probe ORDER BY rowid')).map((row) => row.value), ['transaction', 'plain']);
    assert.equal((await other.get('PRAGMA integrity_check')).integrity_check, 'ok');
  }
  t.after(() => { for (const h of handles) h.native.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { owner, other, node, env, osiLib, osiDb, flow, chameleon, verify, failure, warnings };
}

async function execute(id, f, msg) {
  const node = flows.find((n) => n.id === id);
  assert.ok(node);
  return new Function('msg', 'node', 'env', 'osiLib', 'osiDb', 'chameleon', 'crypto', 'global', 'flow', node.func)(msg, f.node, f.env, f.osiLib, f.osiDb, f.chameleon, crypto, { get() {} }, f.flow);
}

for (const rollback of [false, true]) {
  for (const id of ['sync-outbox-build', 'sync-bootstrap-build', 'sync-pending-build', 'sync-force-build']) {
    test(`${id}: gateway rewrite ${rollback ? 'rollback' : 'commit'} excludes concurrent callers`, { timeout: 3000 }, async (t) => {
      const f = fixture(t, rollback);
      const source = flows.find((n) => n.id === id).func;
      const names = ['normalizeGatewayDeviceEui', 'normalizeGatewayList', 'applyGatewayIdentityPatch', 'parseJsonValue', 'rewriteGatewayReferences', 'runGatewayMigrationPreflight'];
      const text = names.map((name) => declaration(source, name)).join('\n');
      const run = new Function('flow', 'node', text + '\nreturn runGatewayMigrationPreflight;')(f.flow, f.node);
      const args = [f.owner, f.owner.all.bind(f.owner)];
      if (id !== 'sync-pending-build') args.push(f.owner.run.bind(f.owner));
      args.push(() => {}, { deviceEui: GATEWAY }, 'test');
      if (rollback) await assert.rejects(run(...args), (e) => e === f.failure);
      else assert.equal((await run(...args)).migrated, true);
      await f.verify();
      assert.equal((await f.other.get('SELECT gateway_device_eui FROM devices WHERE deveui=?', [EUI])).gateway_device_eui, rollback ? PRIOR : GATEWAY);
    });
  }

  // Each shipped inline peer adapter, including both response branches. Call
  // its actual initializer, then drive its scope on the helper's real queue.
  for (const id of ['sync-outbox-build', 'sync-outbox-mark', 'sync-bootstrap-build', 'sync-bootstrap-mark', 'sync-force-build']) {
    const source = flows.find((n) => n.id === id).func;
    const initializers = [...source.matchAll(/(?:conditionalReplication|load\.value)\.flowPeerDb\([^;]+\)/g)].map((m) => m[0]);
    assert.ok(initializers.length, id + ' peer adapters');
    for (const [index, initializer] of initializers.entries()) {
      test(`${id}: peer adapter ${index + 1} ${rollback ? 'rollback' : 'commit'} excludes concurrent callers`, { timeout: 3000 }, async (t) => {
        const f = fixture(t, rollback);
        const peer = new Function('conditionalReplication', 'load', 'db', '_db', 'node', 'return ' + initializer)(replication, { value: replication }, f.owner, f.owner, f.node);
        const pending = peer.transaction(async (tx) => { await tx.run("UPDATE devices SET name='Owner' WHERE deveui=?", [EUI]); return 'result'; });
        if (rollback) await assert.rejects(pending, (e) => e === f.failure);
        else assert.equal(await pending, 'result');
        await f.verify();
        assert.equal((await f.other.get('SELECT name FROM devices WHERE deveui=?', [EUI])).name, rollback ? 'Sensor' : 'Owner');
      });
    }
  }

  for (const [id, msg, check] of [
    ['51c0ae3799c97131', { payload: { calibrations: [calibration], not_found: [] } }, (f) => f.other.get('SELECT * FROM chameleon_calibrations WHERE array_id=?', [ARRAY])],
    ['bcae891b14ec4604', { _refreshResult: { statusCode: 200, payload: calibration } }, (f) => f.other.get('SELECT * FROM chameleon_calibrations WHERE array_id=?', [ARRAY])],
    ['bf93cd55db0eb57f', { req: { params: { deveui: EUI } }, _authUser: { userId: 101 }, payload: { chameleonSwt1DepthCm: 20 } }, async (f) => (await f.other.get('SELECT chameleon_swt1_depth_cm AS depth FROM devices WHERE deveui=?', [EUI])).depth],
    ['scoped-zone-create-router', { req: { headers: {}, body: { name: 'Created' } } }, (f) => f.other.get("SELECT * FROM irrigation_zones WHERE name='Created'")],
    ['scoped-weather-zone-assign-router', { req: { headers: {}, params: { deveui: EUI } }, payload: { zone_ids: [101] } }, (f) => f.other.get('SELECT * FROM weather_station_zones WHERE deveui=?', [EUI])],
  ]) {
    test(`${id}: ${rollback ? 'rollback' : 'commit'} excludes concurrent callers`, { timeout: 3000 }, async (t) => {
      const f = fixture(t, rollback);
      const message = structuredClone(msg);
      const result = await execute(id, f, message);
      await f.verify();
      assert.equal(Boolean(await check(f)), !rollback);
      if (rollback) { assert.ok(result === null || message.statusCode === 500, JSON.stringify(message)); }
      else if (id === 'scoped-zone-create-router') { assert.equal(message.payload.id, (await check(f)).id); assert.equal(message.statusCode, 201); }
      else if (id === 'bf93cd55db0eb57f') assert.equal(message.statusCode, 200);
    });
  }

  test(`SDI-12 config: ${rollback ? 'rollback' : 'commit'} excludes concurrent callers`, { timeout: 3000 }, async (t) => {
    const f = fixture(t, rollback);
    const normalize = require(path.join(MODS, 'osi-sdi12-normalize'));
    const commissioning = require(path.join(MODS, 'osi-sdi12-commissioning/config-handler'));
    const msg = { req: { body: { probe_profile: 'SENTEK_ENVIROSCAN', value_count: 2 } }, deviceRow: { deveui: EUI } };
    const result = await commissioning.handleConfig({ msg, node: f.node, osiDb: f.osiDb, osiLib: { require: () => ({ ok: true, value: normalize }) } });
    await f.verify();
    assert.equal(result.statusCode || 200, rollback ? 500 : 200);
    assert.equal((await f.other.get('SELECT sdi12_probe_profile FROM devices WHERE deveui=?', [EUI])).sdi12_probe_profile, rollback ? null : 'SENTEK_ENVIROSCAN');
  });
}

// Native-only transaction implementations remain: helper internals, the
// synchronous evidence database and explicit DatabaseSync fallbacks. These
// exclusions are path-specific; a new facade caller anywhere else fails.
function manualCalls(source) { return [...source.matchAll(/\b(?:run|exec)\s*\(\s*(['"`])\s*BEGIN\b/gi)]; }
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? (entry.name === 'node_modules' ? [] : walk(path.join(dir, entry.name))) : [path.join(dir, entry.name)]); }
test('grep guard rejects manual BEGIN on every maintained shared facade', () => {
  assert.equal(manualCalls("await db.run('BEGIN IMMEDIATE')").length, 1);
  assert.equal(manualCalls('await db.exec("BEGIN")').length, 1);
  for (const profile of ['bcm2712', 'bcm2709']) {
    const share = SHARE.replace('bcm2712', profile);
    for (const n of JSON.parse(fs.readFileSync(path.join(share, 'flows.json')))) {
      for (const key of ['func', 'initialize', 'finalize']) assert.equal(manualCalls(n[key] || '').length, 0, n.id + ' ' + key);
    }
    for (const file of walk(path.join(share, 'node-red')).filter((p) => /\/osi-[^/]+\//.test(p) && p.endsWith('.js') && !/\.test\.js$|\/test-helpers\.js$/.test(p))) {
      const source = fs.readFileSync(file, 'utf8');
      if (!manualCalls(source).length) continue;
      const rel = path.relative(path.join(share, 'node-red'), file);
      if (rel === 'osi-db-helper/index.js' || /^osi-sync-protocol-state\/(activity-append|activity-db)\.js$/.test(rel)) continue;
      if (['osi-journal/api.js', 'osi-journal-replication/index.js'].includes(rel)) {
        assert.ok(source.includes("if (db && typeof db.transaction === 'function') return db.transaction("));
        assert.ok(source.includes("typeof db.prepare !== 'function' || typeof db.exec !== 'function'"));
        assert.equal(manualCalls(source).length, 1, 'only the native fallback: ' + rel);
        continue;
      }
      assert.fail('manual facade BEGIN in ' + rel);
    }
  }
});

test('calibration refresh keeps its upstream-not-found result and durable miss', async (t) => {
  const f = fixture(t, false);
  const msg = { _refreshResult: { statusCode: 404 }, _refreshArrayId: ARRAY };
  const result = await execute('bcae891b14ec4604', f, msg);
  assert.strictEqual(result[1], msg);
  assert.equal(msg.statusCode, 200);
  assert.deepEqual(msg.payload, { status: 'unknown' });
  assert.equal((await f.other.get('SELECT reason FROM chameleon_calibration_misses WHERE array_id=?', [ARRAY])).reason, 'not_found');
});

test('saving depth for a missing device keeps the 404 result', async (t) => {
  const f = fixture(t, false);
  const msg = { req: { params: { deveui: GATEWAY } }, _authUser: { userId: 101 }, payload: { chameleonSwt1DepthCm: 20 } };
  await execute('bf93cd55db0eb57f', f, msg);
  assert.equal(msg.statusCode, 404);
  assert.deepEqual(msg.payload, { error: 'Device not found' });
  await f.verify();
});

for (const id of ['scoped-zone-create-router', 'scoped-weather-zone-assign-router']) {
  test(`${id}: a primitive auth failure keeps its HTTP error result`, async (t) => {
    const f = fixture(t, false);
    f.osiLib.require = () => ({ ok: true, value: { verifyBearer() { throw null; } } });
    const msg = { req: { headers: {} } };
    const result = await execute(id, f, msg);
    assert.strictEqual(result[1], msg);
    assert.equal(msg.statusCode, 500);
  });
}

async function sharedWeatherFixture(f) {
  await f.other.exec(`
    INSERT INTO users(id,username,password_hash,user_uuid,role,created_at)
      VALUES(102,'other','hash','weather-other','researcher','2026-11-19');
    INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,created_at,updated_at)
      VALUES(102,'Other zone',102,'weather-other-zone','2026-11-19','2026-11-19');
    UPDATE devices SET type_id='SENSECAP_S2120' WHERE deveui='${EUI}';
    INSERT INTO weather_station_zones(deveui,zone_id) VALUES('${EUI}',101),('${EUI}',102);
    INSERT INTO weather_station_zone_state(deveui,sync_version,updated_at)
      VALUES('${EUI}',1,'2026-11-19');
  `);
}

function realWeatherScope(f) {
  const scope = require(path.join(MODS, 'osi-scope-helper'));
  scope._resetForTests();
  const secret = 'weather-scope-transaction-test';
  const tokenBody = Buffer.from(JSON.stringify({ userId: 101, username: 'owner', exp: Date.now() + 60000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(tokenBody).digest('base64url');
  const get = f.env.get;
  f.env.get = (key) => key === 'AUTH_TOKEN_SECRET' ? secret : get(key);
  const load = f.osiLib.require;
  let activeTx = null;
  const checked = [];
  const observedScope = { ...scope };
  for (const method of ['assertFreshRole', 'assertFreshDeviceAccess', 'resolveZoneUuidById', 'assertFreshZoneAccess']) {
    observedScope[method] = async (db, ...args) => {
      assert.ok(activeTx, method + ' executes inside the writer transaction');
      assert.strictEqual(db, activeTx, method + ' reads the same transaction used by DELETE');
      checked.push(method);
      return scope[method](db, ...args);
    };
  }
  f.osiLib.require = (name) => name === 'scope' ? { ok: true, value: observedScope } : load(name);
  const transaction = f.owner.transaction.bind(f.owner);
  f.owner.transaction = (fn) => transaction(async (tx) => {
    activeTx = tx;
    const run = tx.run.bind(tx);
    tx.run = async (sql, params) => {
      if (/^DELETE FROM weather_station_zones/.test(sql)) {
        assert.ok(checked.includes('assertFreshRole'), 'fresh scope was resolved before DELETE');
        assert.ok(checked.includes('assertFreshDeviceAccess'), 'device authorization preceded DELETE');
        assert.strictEqual(activeTx, tx);
      }
      return run(sql, params);
    };
    try { return await fn(tx); } finally { activeTx = null; }
  });
  return {
    scope, checked,
    message: (zoneIds) => ({
      req: { params: { deveui: EUI }, headers: { authorization: `Bearer ${tokenBody}.${signature}` } },
      payload: { zone_ids: zoneIds },
    }),
  };
}

for (const deleted of [false, true]) {
  test(`weather zone set keeps a ${deleted ? 'deleted' : 'live'} outside-scope assignment and checks access in its writer transaction`, async (t) => {
    const f = fixture(t, false);
    await sharedWeatherFixture(f);
    if (deleted) await f.other.run("UPDATE irrigation_zones SET deleted_at='2026-11-19' WHERE id=102");
    const runtime = realWeatherScope(f);
    const msg = runtime.message([101]);
    await execute('scoped-weather-zone-assign-router', f, msg);
    assert.equal(msg.statusCode, 200, JSON.stringify({ payload: msg.payload, warnings: f.warnings }));
    assert.deepEqual(runtime.checked, ['assertFreshRole', 'assertFreshDeviceAccess', 'resolveZoneUuidById', 'assertFreshZoneAccess']);
    assert.deepEqual((await f.other.all('SELECT zone_id FROM weather_station_zones WHERE deveui=? ORDER BY zone_id', [EUI])).map((r) => r.zone_id), [101, 102]);
    await f.verify();
  });
}

test('weather zone set rechecks a grant revoked before BEGIN and preserves both assignments', async (t) => {
  const f = fixture(t, false);
  await sharedWeatherFixture(f);
  await f.other.run('UPDATE irrigation_zones SET user_id=102 WHERE id=101');
  await f.other.run('INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at) VALUES(?,?,?,?)', ['weather-grant', USER, ZONE, '2026-11-19']);
  const runtime = realWeatherScope(f);
  // A cached pre-request scope must not authorize the later DELETE.
  assert.ok((await runtime.scope.resolveScope(f.other, USER, { scopedMode: true })).zoneUuids.has(ZONE));
  const transaction = f.owner.transaction.bind(f.owner);
  f.owner.transaction = async (fn) => {
    await f.other.run("UPDATE user_zone_assignments SET deleted_at='2026-11-19' WHERE assignment_uuid='weather-grant'");
    return transaction(fn);
  };
  const msg = runtime.message([]);
  await execute('scoped-weather-zone-assign-router', f, msg);
  assert.equal(msg.statusCode, 200, JSON.stringify({ payload: msg.payload, warnings: f.warnings }));
  assert.deepEqual((await f.other.all('SELECT zone_id FROM weather_station_zones WHERE deveui=? ORDER BY zone_id', [EUI])).map((r) => r.zone_id), [101, 102]);
  await f.verify();
});

for (const id of ['sync-bootstrap-mark', 'sync-outbox-mark']) {
  for (const statusCode of [404, 503]) {
    test(`${id}: peer capability capture and ${statusCode} invalidation persist after queued commits`, async (t) => {
      const f = fixture(t, false);
      // Use the helper's real FIFO without the earlier isolation fault hook.
      f.owner.transaction = f.other.transaction.bind(f.other);
      const installation = '11111111-1111-4111-8111-111111111111';
      const context = { server_url: 'https://cloud.invalid', cloud_user_id: USER, gateway_device_eui: GATEWAY, installation_uuid: installation };
      await f.other.run(`INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,previous_gateway_device_euis_json,recovery_state,created_at,updated_at)
        VALUES(1,?,?, '[]','ACTIVE','2026-11-19','2026-11-19')`, [installation, GATEWAY]);
      await f.other.run(`INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,peer_capabilities_json,peer_capabilities_context_json,updated_at)
        VALUES('cloud',1,?,?,?,?, '[]',?,'2026-11-19')`, [context.server_url, USER, GATEWAY, installation, JSON.stringify(context)]);
      await f.other.run(`INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,occurred_at)
        VALUES('peer-event','DEVICE',?,'DEVICE_FLAGS_UPDATED','{}','2026-11-19')`, [EUI]);
      const committedPeer = () => {
        // A different connection observes committed state only.
        const observer = new DatabaseSync(f.owner.filename, { readOnly: true });
        try { return observer.prepare("SELECT * FROM sync_link_state WHERE peer_node='cloud'").get(); }
        finally { observer.close(); }
      };
      const peer = replication.flowPeerDb(f.owner, f.node.warn, 'Peer persistence regression');
      const capture = await replication.beginPeerRequest(peer, { context, requestId: 'peer-capture' });
      assert.equal(capture.captured, true);
      assert.equal(committedPeer().peer_capabilities_request_id, 'peer-capture');
      assert.deepEqual(JSON.parse(committedPeer().peer_capabilities_context_json), context);
      const metadata = { _syncConditionalRequestId: 'peer-capture', _syncConditionalPeerContext: context, _syncConditionalGuarded: true, _syncLinkedUserId: null };
      const payload = { success: true, supportedSyncCapabilities: ['conditional_irrigation_v1'], results: [{ eventUuid: 'peer-event', status: 'APPLIED' }] };
      await execute(id, f, { ...metadata, _syncEventIds: ['peer-event'], statusCode: 200, payload });
      assert.deepEqual(JSON.parse(committedPeer().peer_capabilities_json), ['conditional_irrigation_v1'], 'capability acceptance committed before the mark returned');
      await execute(id, f, { ...metadata, _syncEventIds: ['peer-event'], statusCode, payload: { code: 'CONDITIONAL_IRRIGATION_UNSUPPORTED' } });
      const invalidated = committedPeer();
      assert.equal(invalidated.peer_capabilities_json, null, 'guarded failure committed capability removal');
      assert.equal(invalidated.peer_capabilities_context_json, null);
      assert.equal(invalidated.peer_capabilities_request_id, null);
      assert.deepEqual(f.warnings, []);
    });
  }
}
