#!/usr/bin/env node
'use strict';

/**
 * Golden-vector capture & verify harness for the History API Router node.
 *
 * Usage:
 *   node scripts/capture-history-router-vectors.js --capture
 *     Reads the CURRENT history-api-router-fn node from flows.json, runs it
 *     against a seeded node:sqlite fixture DB with a pinned clock and the REAL
 *     osi-history-helper, captures responses for representative routes as JSON
 *     fixtures in docs/contracts/history-router/cases/.
 *
 *   node scripts/capture-history-router-vectors.js --verify
 *     Runs the same routes against the current-on-disk node and asserts deep
 *     equality with committed fixtures.
 *
 * Follows the rehearse-devices-rebuild.js facade-shim pattern.
 * Requires Node >= 22.5 (node:sqlite).
 *
 * Refactor-program 4.2, spec section D.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { deepStrictEqual } = require('node:assert');

// ───────────────────────────── paths ──────────────────────────────

const REPO = path.resolve(__dirname, '..');
const FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const SEED_SQL = path.join(REPO, 'database/seed-blank.sql');
const HELPER_PATH = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js');
const ROUTER_PATH = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/index.js');
const CASES_DIR = path.join(REPO, 'docs/contracts/history-router/cases');

// ───────────────────────────── fixed clock ─────────────────────────

const PINNED_NOW_MS = Date.parse('2026-07-10T12:00:00.000Z');
const PINNED_NOW_ISO = '2026-07-10T12:00:00.000Z';

let clockFrozen = false;
const _origDateNow = Date.now;
const _OrigDate = Date;

function freezeClock() {
  if (clockFrozen) return;
  clockFrozen = true;
  Date.now = () => PINNED_NOW_MS;
  // Override the Date constructor so `new Date()` returns the pinned time.
  // new Date(arg) still uses the real constructor.
  const PinnedDate = function (...args) {
    if (args.length === 0) {
      return new _OrigDate(PINNED_NOW_MS);
    }
    return new _OrigDate(...args);
  };
  PinnedDate.now = () => PINNED_NOW_MS;
  PinnedDate.parse = _OrigDate.parse;
  PinnedDate.UTC = _OrigDate.UTC;
  PinnedDate.prototype = _OrigDate.prototype;
  // eslint-disable-next-line no-global-assign
  Date = PinnedDate;
}

function restoreClock() {
  if (!clockFrozen) return;
  clockFrozen = false;
  Date.now = _origDateNow;
  // eslint-disable-next-line no-global-assign
  Date = _OrigDate;
}

// ───────────────────────── test JWT token ──────────────────────────

const TEST_JWT_SECRET = 'test-jwt-secret-for-golden-vectors-only';

function toBase64Url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function makeTestToken(userId, username) {
  const payloadB64 = toBase64Url(JSON.stringify({
    userId, username,
    exp: PINNED_NOW_MS + 3600000 // 1h after pinned time
  }));
  const sig = toBase64Url(
    crypto.createHmac('sha256', TEST_JWT_SECRET).update(payloadB64).digest()
  );
  return payloadB64 + '.' + sig;
}

// ──────────────────── database facade shim ────────────────────────

/**
 * Facade-compatible shim over node:sqlite's DatabaseSync.
 * Mirrors the osi-db-helper DatabaseFacade API the node uses:
 *   db.all(sql, params, cb) — callback(error, rows)
 *   db.run(sql, params, cb) — callback.call({changes}, error)
 *   db.close(cb)
 *
 * The osi-history-helper's dbAll/dbRun also uses this callback-style interface
 * (it checks db.all.length >= 3).
 */
function makeFacadeShim(dbPath) {
  const db = new DatabaseSync(dbPath);

  // Helper to prepare & run, normalizing params
  function execQuery(sql, params) {
    const p = Array.isArray(params) ? params : [];
    // Simple statements without params
    if (p.length === 0 && !/\?/.test(sql)) {
      // For DDL / simple queries
      try {
        const stmt = db.prepare(sql);
        const rows = stmt.all();
        return { rows };
      } catch (e) {
        // exec-style (CREATE TABLE etc)
        db.exec(sql);
        return { rows: [] };
      }
    }
    const stmt = db.prepare(sql);
    return { rows: stmt.all(...p) };
  }

  function execRun(sql, params) {
    const p = Array.isArray(params) ? params : [];
    if (p.length === 0 && !/\?/.test(sql)) {
      db.exec(sql);
      return 0;
    }
    const stmt = db.prepare(sql);
    const result = stmt.run(...p);
    return result.changes;
  }

  const facade = {
    // 3-arg callback style (what the node's q/run wrappers + helper's dbAll use)
    all(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      try {
        const { rows } = execQuery(sql, params);
        if (typeof cb === 'function') {
          process.nextTick(() => cb(null, rows || []));
          return;
        }
        return Promise.resolve(rows || []);
      } catch (e) {
        if (typeof cb === 'function') {
          process.nextTick(() => cb(e));
          return;
        }
        return Promise.reject(e);
      }
    },

    get(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      try {
        const { rows } = execQuery(sql, params);
        const row = (rows && rows[0]) || undefined;
        if (typeof cb === 'function') {
          process.nextTick(() => cb(null, row));
          return;
        }
        return Promise.resolve(row);
      } catch (e) {
        if (typeof cb === 'function') {
          process.nextTick(() => cb(e));
          return;
        }
        return Promise.reject(e);
      }
    },

    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      try {
        const changes = execRun(sql, params);
        if (typeof cb === 'function') {
          process.nextTick(() => cb.call({ changes }, null));
          return;
        }
        return Promise.resolve(undefined);
      } catch (e) {
        if (typeof cb === 'function') {
          process.nextTick(() => cb.call(null, e));
          return;
        }
        return Promise.reject(e);
      }
    },

    exec(sql, cb) {
      try {
        db.exec(sql);
        if (typeof cb === 'function') process.nextTick(() => cb(null));
      } catch (e) {
        if (typeof cb === 'function') process.nextTick(() => cb(e));
        else throw e;
      }
    },

    close(cb) {
      try { db.close(); } catch (_) {}
      if (typeof cb === 'function') process.nextTick(() => cb());
    },

    serialize(cb) { if (typeof cb === 'function') cb(); return facade; },
    parallelize(cb) { if (typeof cb === 'function') cb(); return facade; },
    configure() { return facade; },
  };

  return facade;
}

// ───────────────────── seed fixture database ──────────────────────

function seedFixtureDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  // Apply the blank schema
  const seedSql = fs.readFileSync(SEED_SQL, 'utf8');
  db.exec(seedSql);

  // Insert fixture data
  const now = PINNED_NOW_ISO;
  const h1 = '2026-07-10T11:00:00.000Z';
  const h2 = '2026-07-10T10:00:00.000Z';
  const h3 = '2026-07-10T09:00:00.000Z';
  const h4 = '2026-07-10T08:00:00.000Z';
  const h5 = '2026-07-10T07:00:00.000Z';
  const h6 = '2026-07-10T06:00:00.000Z';

  // User
  db.exec(`INSERT INTO users (id, username, password_hash, created_at, updated_at, user_uuid)
           VALUES (1, 'testuser', 'hash123', '${now}', '${now}', 'test-user-uuid-1')`);

  // Irrigation zone
  db.exec(`INSERT INTO irrigation_zones (id, name, user_id, created_at, updated_at, timezone, zone_uuid, gateway_device_eui)
           VALUES (1, 'Test Zone Alpha', 1, '${now}', '${now}', 'Europe/Zurich', 'test-zone-uuid-1', '0016C001F1000001')`);

  // Devices: soil sensor, dendro, environment (weather station), irrigation valve
  db.exec(`INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id, dendro_enabled, temp_enabled, chameleon_enabled, chameleon_swt1_depth_cm, chameleon_swt2_depth_cm, chameleon_swt3_depth_cm, gateway_device_eui)
           VALUES ('AAAA000000000001', 'Soil Sensor 1', 'KIWI_SENSOR', 1, '${now}', '${now}', 1, 0, 0, 0, 30.0, 60.0, 90.0, '0016C001F1000001')`);

  db.exec(`INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id, dendro_enabled, temp_enabled, gateway_device_eui)
           VALUES ('AAAA000000000002', 'Dendro Tree 1', 'DRAGINO_LSN50', 1, '${now}', '${now}', 1, 1, 0, '0016C001F1000001')`);

  db.exec(`INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id, dendro_enabled, temp_enabled, gateway_device_eui)
           VALUES ('AAAA000000000003', 'Weather Station', 'SENSECAP_S2120', 1, '${now}', '${now}', 1, 0, 0, '0016C001F1000001')`);

  db.exec(`INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id, dendro_enabled, temp_enabled, gateway_device_eui)
           VALUES ('AAAA000000000004', 'Valve 1', 'STREGA_VALVE', 1, '${now}', '${now}', 1, 0, 0, '0016C001F1000001')`);

  // device_data rows — soil sensor data at several timestamps
  const soilRows = [
    [h1, 42.5, 38.0, 45.0, 22.1, 65.0, null, 3.6, null],
    [h2, 40.0, 36.5, 43.0, 21.8, 63.0, null, 3.6, null],
    [h3, 38.5, 35.0, 41.0, 21.5, 61.0, null, 3.5, null],
    [h4, 37.0, 34.0, 40.0, 21.0, 60.0, null, 3.5, null],
    [h5, 44.0, 39.5, 46.0, 20.5, 58.0, null, 3.4, null],
    [h6, 43.0, 38.5, 45.0, 20.0, 56.0, null, 3.4, null],
  ];
  for (const [ts, swt1, swt2, swt3, temp, rh, lux, batV, batPct] of soilRows) {
    db.exec(`INSERT INTO device_data (deveui, swt_1, swt_2, swt_3, ambient_temperature, relative_humidity, light_lux, bat_v, bat_pct, recorded_at)
             VALUES ('AAAA000000000001', ${swt1}, ${swt2}, ${swt3}, ${temp}, ${rh}, ${lux === null ? 'NULL' : lux}, ${batV}, ${batPct === null ? 'NULL' : batPct}, '${ts}')`);
  }

  // device_data for dendro
  const dendroRows = [
    [h1, 0.512, 0.510, 0.002, 2.0, 0.95, 3.2],
    [h2, 0.511, 0.509, 0.002, 2.0, 0.94, 3.2],
    [h3, 0.510, 0.508, 0.002, 2.0, 0.93, 3.1],
    [h4, 0.509, 0.507, 0.002, 2.0, 0.92, 3.1],
  ];
  for (const [ts, posMm, posRawMm, deltaMm, stemUm, ratio, batV] of dendroRows) {
    db.exec(`INSERT INTO device_data (deveui, dendro_position_mm, dendro_position_raw_mm, dendro_delta_mm, dendro_stem_change_um, dendro_ratio, bat_v, recorded_at)
             VALUES ('AAAA000000000002', ${posMm}, ${posRawMm}, ${deltaMm}, ${stemUm}, ${ratio}, ${batV}, '${ts}')`);
  }

  // device_data for weather station
  const envRows = [
    [h1, 23.5, 62.0, 450.0, 0.0, 3.8],
    [h2, 22.8, 64.0, 380.0, 0.0, 3.8],
    [h3, 22.0, 66.0, 300.0, 0.0, 3.7],
    [h4, 21.2, 68.0, 200.0, 1.2, 3.7],
  ];
  for (const [ts, temp, rh, lux, rain, batV] of envRows) {
    db.exec(`INSERT INTO device_data (deveui, ambient_temperature, relative_humidity, light_lux, rain_mm_per_hour, bat_v, recorded_at)
             VALUES ('AAAA000000000003', ${temp}, ${rh}, ${lux}, ${rain}, ${batV}, '${ts}')`);
  }

  // dendrometer_readings
  for (const [ts, posMm, posRawMm, deltaMm, stemUm, ratio, batV] of dendroRows) {
    db.exec(`INSERT INTO dendrometer_readings (deveui, position_um, adc_v, bat_v, is_valid, recorded_at, dendro_ratio, position_raw_um)
             VALUES ('AAAA000000000002', ${posMm * 1000}, NULL, ${batV}, 1, '${ts}', ${ratio}, ${posRawMm * 1000})`);
  }

  // Gateway location
  db.exec(`INSERT INTO gateway_locations (gateway_device_eui, latitude, longitude, altitude_m, status, source, updated_at)
           VALUES ('0016C001F1000001', 47.3769, 8.5417, 408.0, 'fix_3d', 'gpsd', '${h1}')`);

  // Zone season
  db.exec(`INSERT INTO zone_seasons (id, zone_id, season_uuid, name, starts_on, ends_on, is_active, is_default, created_at, updated_at)
           VALUES (1, 1, 'season-uuid-1', 'Summer 2026', '2026-04-01', '2026-10-31', 1, 1, '${now}', '${now}')`);

  // History workspace
  db.exec(`INSERT INTO history_workspaces (id, user_id, owner_user_uuid, zone_id, name, workspace_json, is_default, created_at, updated_at)
           VALUES (1, 1, 'test-user-uuid-1', 1, 'Default Workspace', '${JSON.stringify({ layout: 'grid', panels: [] }).replace(/'/g, "''")}', 1, '${now}', '${now}')`);

  // History card preferences
  db.exec(`INSERT INTO history_card_preferences (user_id, owner_user_uuid, scope_type, zone_id, card_id, pinned, open_count, last_opened_at, updated_at)
           VALUES (1, 'test-user-uuid-1', 'zone', 1, 'test-zone-uuid-1:soil:root-zone', 1, 5, '${h1}', '${now}')`);

  db.exec(`INSERT INTO history_card_preferences (user_id, owner_user_uuid, scope_type, zone_id, card_id, pinned, open_count, last_opened_at, updated_at)
           VALUES (1, 'test-user-uuid-1', 'zone', 1, 'test-zone-uuid-1:environment:microclimate', 0, 2, '${h3}', '${now}')`);

  // Irrigation event for the zone
  // Disable the trigger first since we don't have sync_link_state set up properly
  db.exec(`INSERT INTO irrigation_events (id, user_id, irrigation_zone_id, action, reason, duration_minutes, valve_deveui, created_at, event_uuid)
           VALUES (1, 1, 1, 'OPEN_FOR_DURATION', 'scheduled', 30, 'AAAA000000000004', '${h2}', 'irrig-test-001')`);

  db.close();
}

// ──────────────────── read the node func text ─────────────────────

function readNodeFunc() {
  const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
  const node = flows.find((n) => n.id === 'history-api-router-fn');
  if (!node) throw new Error('Node history-api-router-fn not found in flows.json');
  if (node.name !== 'History API Router') {
    throw new Error(`Expected node name "History API Router", got "${node.name}"`);
  }
  return node.func;
}

// ──────────────── run the node for a single route ─────────────────

async function runNodeForRoute(funcText, dbPath, route) {
  const testToken = makeTestToken(1, 'testuser');
  const facade = makeFacadeShim(dbPath);

  // Build the osiDb stub that returns our facade
  const osiDb = {
    Database: function () { return facade; },
    verbose() { return osiDb; }
  };

  // Load the REAL osi-history-helper (NOT stubbed)
  // Clear require cache to ensure fresh load
  delete require.cache[require.resolve(HELPER_PATH)];
  const osiHistory = require(HELPER_PATH);
  delete require.cache[require.resolve(ROUTER_PATH)];
  const HR = require(ROUTER_PATH);

  // env stub
  const env = {
    get(key) {
      if (key === 'AUTH_TOKEN_SECRET' || key === 'JWT_SECRET') return TEST_JWT_SECRET;
      if (key === 'TZ') return 'Europe/Zurich';
      if (key === 'DEVICE_EUI' || key === 'GATEWAY_DEVICE_EUI') return '0016C001F1000001';
      return '';
    }
  };

  // global stub (historySchemaGuardVersion tracking + fs)
  const globalStore = {};
  const globalObj = {
    get(key) {
      if (key === 'fs') return fs;
      return globalStore[key];
    },
    set(key, value) {
      globalStore[key] = value;
    }
  };

  // node stub
  const nodeLog = [];
  const nodeErrors = [];
  const node = {
    log(m) { nodeLog.push(String(m)); },
    error(m) { nodeErrors.push(String(m)); },
    warn() {},
    status() {}
  };

  // Build msg from the route spec
  const msg = {
    req: {
      method: route.method,
      path: route.path,
      originalUrl: route.path + (route.queryString || ''),
      params: route.params || {},
      query: route.query || {},
      headers: {
        authorization: 'Bearer ' + testToken
      },
      body: route.body || {}
    },
    payload: route.body || {},
    statusCode: null,
    headers: null
  };

  // Execute the node func
  freezeClock();
  try {
    // The func body is wrapped in `return (async () => { ... })()` — it's an
    // async IIFE that returns the modified msg. We wrap it in a function that
    // has the required globals in scope.
    const wrappedFunc = new Function(
      'osiDb', 'osiHistory', 'crypto', 'env', 'global', 'node', 'msg', 'Buffer', 'HR',
      funcText
    );
    const result = await wrappedFunc(osiDb, osiHistory, crypto, env, globalObj, node, msg, Buffer, HR);

    return {
      statusCode: msg.statusCode,
      headers: msg.headers,
      payload: msg.payload,
      log: nodeLog,
      errors: nodeErrors
    };
  } finally {
    restoreClock();
    facade.close();
  }
}

// ───────────────────── route definitions ──────────────────────────

function getRoutes() {
  return [
    {
      name: 'card-summary',
      description: 'GET zone card summaries',
      method: 'GET',
      path: '/api/history/zones/1/cards',
      params: { zoneId: '1' },
      query: {},
    },
    {
      name: 'series-aggregate',
      description: 'GET series/aggregate data for soil card (24h, hourly)',
      method: 'GET',
      path: '/api/history/zones/1/cards/test-zone-uuid-1:soil:root-zone/data',
      params: { zoneId: '1', cardId: 'test-zone-uuid-1:soil:root-zone' },
      query: { range: '24h', view: 'line-chart', aggregation: 'hourly' },
    },
    {
      name: 'workspace-create',
      description: 'POST create a new workspace',
      method: 'POST',
      path: '/api/history/workspaces',
      params: {},
      query: {},
      body: {
        name: 'Golden Vector Workspace',
        zoneId: 1,
        isDefault: false,
        workspace: { layout: 'grid', panels: [{ id: 'p1', type: 'soil' }] }
      },
    },
    {
      name: 'csv-export',
      description: 'GET CSV export for zone',
      method: 'GET',
      path: '/api/history/zones/1/export.csv',
      params: { zoneId: '1' },
      query: {
        granularity: 'raw',
        from: '2026-07-10',
        to: '2026-07-10',
      },
    },
  ];
}

// ─────────────────── normalize for comparison ─────────────────────

/**
 * Normalize the captured output for deterministic comparison.
 * Some fields like `generatedAt` are set by `nowIso()` which we've pinned,
 * but IDs from auto-increment may vary. We normalize those.
 */
function normalizePayload(payload, routeName) {
  if (payload === null || payload === undefined) return payload;

  // Deep clone
  const out = JSON.parse(JSON.stringify(payload));

  // For workspace-create: the auto-increment ID may differ; normalize it
  if (routeName === 'workspace-create' && out && typeof out.id === 'number') {
    out.id = '<<AUTO_ID>>';
  }

  return out;
}

// ─────────────────────── capture mode ─────────────────────────────

async function captureAll() {
  const tmpDir = path.join(REPO, '.capture-tmp-' + process.pid);
  const dbPath = path.join(tmpDir, 'fixture.db');
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const funcText = readNodeFunc();
    const routes = getRoutes();

    console.log('[capture] Seeding fixture database...');
    seedFixtureDb(dbPath);

    console.log('[capture] Running %d routes against the current node...', routes.length);
    for (const route of routes) {
      console.log('  [%s] %s %s', route.name, route.method, route.path);

      // Each route gets a fresh DB copy (workspace-create mutates the DB)
      const routeDbPath = path.join(tmpDir, `fixture-${route.name}.db`);
      fs.copyFileSync(dbPath, routeDbPath);

      const result = await runNodeForRoute(funcText, routeDbPath, route);

      if (result.statusCode !== 200) {
        console.error('  WARN: %s returned status %d: %s',
          route.name, result.statusCode, JSON.stringify(result.payload));
      }

      const normalizedPayload = normalizePayload(result.payload, route.name);

      // Write input.json
      const inputPath = path.join(CASES_DIR, `${route.name}.input.json`);
      fs.writeFileSync(inputPath, JSON.stringify({
        route: {
          name: route.name,
          description: route.description,
          method: route.method,
          path: route.path,
          params: route.params,
          query: route.query,
          body: route.body || null,
        },
        seed: {
          note: 'Seeded from database/seed-blank.sql plus fixture rows (see capture-history-router-vectors.js seedFixtureDb)',
          pinnedClockMs: PINNED_NOW_MS,
          pinnedClockIso: PINNED_NOW_ISO,
          jwtSecret: TEST_JWT_SECRET,
        },
      }, null, 2) + '\n');

      // Write expected.json
      const expectedPath = path.join(CASES_DIR, `${route.name}.expected.json`);
      const expectedContent = {
        statusCode: result.statusCode,
        payload: normalizedPayload,
      };

      // For CSV export, also capture the raw CSV string separately
      if (route.name === 'csv-export') {
        expectedContent.isCsv = true;
        expectedContent.csvContentType = result.headers && result.headers['Content-Type'] || null;
      }

      fs.writeFileSync(expectedPath, JSON.stringify(expectedContent, null, 2) + '\n');

      console.log('    -> status=%d, wrote %s.{input,expected}.json', result.statusCode, route.name);

      // Clean up route DB
      try { fs.unlinkSync(routeDbPath); } catch (_) {}
    }

    console.log('[capture] Done. %d fixtures written to %s', routes.length, CASES_DIR);
  } finally {
    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ──────────────────────── verify mode ─────────────────────────────

async function verifyAll() {
  const tmpDir = path.join(REPO, '.verify-tmp-' + process.pid);
  const dbPath = path.join(tmpDir, 'fixture.db');
  fs.mkdirSync(tmpDir, { recursive: true });

  let failures = 0;

  try {
    const funcText = readNodeFunc();
    const routes = getRoutes();

    console.log('[verify] Seeding fixture database...');
    seedFixtureDb(dbPath);

    console.log('[verify] Running %d routes against the current node...', routes.length);
    for (const route of routes) {
      const expectedPath = path.join(CASES_DIR, `${route.name}.expected.json`);
      if (!fs.existsSync(expectedPath)) {
        console.error('  FAIL [%s]: fixture %s not found. Run --capture first.', route.name, expectedPath);
        failures++;
        continue;
      }

      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
      console.log('  [%s] %s %s', route.name, route.method, route.path);

      // Each route gets a fresh DB copy
      const routeDbPath = path.join(tmpDir, `fixture-${route.name}.db`);
      fs.copyFileSync(dbPath, routeDbPath);

      const result = await runNodeForRoute(funcText, routeDbPath, route);
      const normalizedPayload = normalizePayload(result.payload, route.name);

      // Compare status code
      if (result.statusCode !== expected.statusCode) {
        console.error('    FAIL: statusCode mismatch: got %d, expected %d', result.statusCode, expected.statusCode);
        console.error('    Payload: %s', JSON.stringify(result.payload).substring(0, 500));
        failures++;
        try { fs.unlinkSync(routeDbPath); } catch (_) {}
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(expected, 'csvContentType')) {
        const actualContentType = result.headers?.['Content-Type'] ?? null;
        if (actualContentType !== expected.csvContentType) {
          console.error('    FAIL: CSV Content-Type mismatch: got %j, expected %j',
            actualContentType, expected.csvContentType);
          failures++;
          try { fs.unlinkSync(routeDbPath); } catch (_) {}
          continue;
        }
      }

      // Deep compare payload
      try {
        deepStrictEqual(normalizedPayload, expected.payload);
        console.log('    PASS');
      } catch (e) {
        console.error('    FAIL: payload mismatch');
        // Show the diff in a useful way
        const actualStr = JSON.stringify(normalizedPayload, null, 2);
        const expectedStr = JSON.stringify(expected.payload, null, 2);
        const actualLines = actualStr.split('\n');
        const expectedLines = expectedStr.split('\n');
        // Find first differing line
        for (let i = 0; i < Math.max(actualLines.length, expectedLines.length); i++) {
          if (actualLines[i] !== expectedLines[i]) {
            console.error('    First diff at line %d:', i + 1);
            console.error('      got:      %s', actualLines[i]);
            console.error('      expected: %s', expectedLines[i]);
            break;
          }
        }
        failures++;
      }

      // Clean up route DB
      try { fs.unlinkSync(routeDbPath); } catch (_) {}
    }

    console.log('[verify] %d/%d routes passed.',
      routes.length - failures, routes.length);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  if (failures > 0) {
    console.error('[verify] FAILED: %d route(s) did not match fixtures.', failures);
    process.exit(1);
  }
}

// ───────────────────────────── main ───────────────────────────────

async function main() {
  const mode = process.argv[2];
  if (mode === '--capture') {
    await captureAll();
  } else if (mode === '--verify') {
    await verifyAll();
  } else {
    console.error('Usage: node scripts/capture-history-router-vectors.js --capture|--verify');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
