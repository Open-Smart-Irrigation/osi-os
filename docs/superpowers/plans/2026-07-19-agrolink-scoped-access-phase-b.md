# AgroLink Scoped Access — Phase B Implementation Plan (Read-Path Enforcement)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every read endpoint returns only what the authenticated principal may see: zone/device/history reads filtered to owned∪granted scope, weather-class devices readable by all (D4), gateway/admin reads restricted to admins, journal reads extended from owner-only to the union rule.

**Architecture:** Per spec §4 (union rule), §7 lifecycle, §8 enforcement (cached reads). All scope logic lives in `osi-scope-helper` (Phase A module, extended here); flow-node edits are thin call-outs that satisfy the size ratchet. Journal filtering changes live in the `osi-journal` seam module (outside flows.json). A behavioral harness executes shipped function text against a seeded DB — the same harness Phase C reuses for write paths.

**Write-path requirement carried forward to Phase C (spec §11 writer-bumped contract):** every mutation of `role`, `disabled_at`, or `username` on `users` must set `sync_version = COALESCE(sync_version,0)+1` in the same `UPDATE` statement that changes those columns — same-statement is load-bearing for the `trg_dp_users_outbox_role_au` arm, which only reads `NEW.sync_version` and never bumps it itself. Account-creation `INSERT`s set `sync_version = 1`. Grant tombstones bump `sync_version` in the same statement as the tombstone write (`deleted_at`), not in a follow-up statement.

**Tech Stack:** Node-RED function nodes (one-shot mutation scripts only), `node:test` + `node:sqlite`, `osi-scope-helper`.

**Prerequisites:** Phase A complete (migrations 0022–0023 applied, `osi-scope-helper` registered, `/api/me` live, flag exists). Load `osi-flows-json-editing` before any flow task.

**Endpoint families (from the verified 118-endpoint inventory):**

| Family | Endpoints | Rule |
|---|---|---|
| F1 zone/device lists | `GET /api/irrigation-zones`, `GET /api/devices` | Filter to scope; weather devices always included |
| F2 zone-path reads | `GET /api/irrigation-zones/:zone_id/environment-summary`, `.../recommendations`, `GET /api/gateway/location` (admin), `GET /api/gateways/:gatewayEui/location` (admin) | assertZoneAccess on the zone |
| F3 device-path reads | `GET /api/dendrometer/:deveui/daily`, `.../readings`, `GET /api/devices/:deveui/sensor-history`, `.../dendro-history`, `.../rain-history`, `.../zone-assignments`, `GET /api/v1/devices/:deveui/today-liters`, `GET /download-sensordata` | Weather-class pass; else zone of device must be in scope |
| F4 history API | `GET /api/history/zones/:zoneId/**` (cards, advanced, data, export.csv) | assertZoneAccess |
| F4b gateway history | `GET /api/history/gateways/:gatewayEui/**`, `GET /api/history/workspaces**` | gateways: admin; workspaces: owner-only (per-user rows) |
| F5 journal reads | `GET /api/journal/plots`, `.../plot-groups`, `.../entries`, `.../export.csv/.json/.adapt.json/.package` | Union rule in osi-journal (owner ∪ granted) |
| F6 admin reads | `GET /download/database`, `GET /api/sync/state`, `GET /api/system/stats`, `GET /api/account-link/status`, `GET /api/improvement-requests**`, `GET /download-fieldtest` | assertRole('admin') |
| F7 shared/reads-all | `GET /api/catalog`, `GET /api/system/features`, `GET /api/analysis/channels`, `.../views`, `POST /api/analysis/series` | Authenticated; zone-scoped rows filtered where present |
| Public | `/auth/*`, `OPTIONS *`, `GET /api/me` (Phase A) | No change |

---

## Task B1: Helper additions for read enforcement

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js` (+ bcm2709 mirror copy)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js` (+ mirror)

- [ ] **Step 1: Write failing tests**

Append to `index.test.js`:

```js
test('resolveZoneUuidById maps numeric id to uuid; null when missing', async () => {
  const db = fakeDb({ get: (sql) => sql.includes('irrigation_zones') ? { zone_uuid: 'z1' } : undefined });
  assert.equal(await scope.resolveZoneUuidById(db, 3), 'z1');
  const db2 = fakeDb({ get: () => undefined });
  assert.equal(await scope.resolveZoneUuidById(db2, 99), null);
});

test('assertDeviceAccess: weather-class passes any enabled user; zone device needs scope', async () => {
  const mk = (dev) => fakeDb({
    get: (sql) => {
      if (sql.includes('FROM devices')) return dev;
      if (sql.includes('FROM users')) return { id: 7, role: 'researcher', disabled_at: null, user_uuid: 'u1' };
      return undefined;
    },
    all: () => [],
  });
  await scope.assertDeviceAccess(mk({ deveui: 'W1', type_id: 'SENSECAP_S2120', zone_uuid: 'z-foreign' }), 'u1', 'W1', { scopedMode: true });
  await scope.assertDeviceAccess(mk({ deveui: 'W2', type_id: 'AQUASCOPE_LORAIN', zone_uuid: null }), 'u1', 'W2', { scopedMode: true });
  await assert.rejects(
    () => scope.assertDeviceAccess(mk({ deveui: 'D1', type_id: 'DRAGINO_LSN50', zone_uuid: 'z-foreign' }), 'u1', 'D1', { scopedMode: true }),
    (e) => e.status === 404);
});

test('assertDeviceAccess: unknown device is 404, not 403', async () => {
  const db = fakeDb({ get: () => undefined });
  await assert.rejects(
    () => scope.assertDeviceAccess(db, 'u1', 'NOPE', { scopedMode: true }),
    (e) => e.status === 404);
});

test('listScopeZoneUuids: wildcard returns null (no filter), scoped returns array', async () => {
  const dbOff = fakeDb({});
  assert.equal(await scope.listScopeZoneUuids(dbOff, 'u1', { scopedMode: false }), null);
  const db = fakeDb({
    get: () => ({ id: 7, role: 'researcher', disabled_at: null, user_uuid: 'u1' }),
    all: (sql) => sql.includes('user_zone_assignments') ? [{ zone_uuid: 'z1' }] : [{ zone_uuid: 'z0' }],
  });
  assert.deepEqual((await scope.listScopeZoneUuids(db, 'u1', { scopedMode: true })).sort(), ['z0', 'z1']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js`
Expected: FAIL — `scope.resolveZoneUuidById is not a function`.

- [ ] **Step 3: Implement (append to `index.js`)**

```js
const WEATHER_TYPE_IDS = new Set(['SENSECAP_S2120', 'AQUASCOPE_LORAIN']);

async function resolveZoneUuidById(db, zoneId) {
  const row = await db.get(
    'SELECT zone_uuid FROM irrigation_zones WHERE id = ? AND deleted_at IS NULL',
    [zoneId]
  );
  return row && row.zone_uuid ? row.zone_uuid : null;
}

async function assertDeviceAccess(db, userUuid, deveui, opts) {
  const dev = await db.get(
    `SELECT d.deveui, d.type_id, iz.zone_uuid
       FROM devices d LEFT JOIN irrigation_zones iz
         ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL
      WHERE d.deveui = ? AND d.deleted_at IS NULL`,
    [deveui]
  );
  if (!dev) throw httpError(404, 'device not found');
  if (WEATHER_TYPE_IDS.has(dev.type_id)) {
    const scope = await resolveScope(db, userUuid, opts);
    if (scope.disabled) throw httpError(403, 'account disabled');
    return scope; // D4: weather-class readable by every enabled account
  }
  if (!dev.zone_uuid) throw httpError(404, 'device not found'); // unassigned hardware is admin-only
  return assertZoneAccess(db, userUuid, dev.zone_uuid, opts);
}

async function listScopeZoneUuids(db, userUuid, opts) {
  const scope = await resolveScope(db, userUuid, opts);
  if (scope.wildcard) return null; // null = no filter
  return [...scope.zoneUuids];
}
```

Add `WEATHER_TYPE_IDS`, `resolveZoneUuidById`, `assertDeviceAccess`, `listScopeZoneUuids` to `module.exports`.

- [ ] **Step 4: Run tests**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js`
Expected: 11/11 PASS. Copy both changed files over the bcm2709 mirror and run `node scripts/verify-profile-parity.js` → `All parity checks passed.`

- [ ] **Step 5: Commit**

```bash
git add conf/
git commit -m "feat(scope): read-enforcement helpers (device access, weather exception, zone list)"
```

---

## Task B2: Behavioral harness + seeded fixture

**Files:**
- Create: `scripts/lib/scoped-access-harness.js`
- Create: `scripts/test-scoped-access-reads.js`

The harness executes shipped function-node text against a seeded in-memory DB, the same proven pattern as `scripts/test-sync-delivery-fail-closed.js` (read that file first for the loader shape). Phase C reuses this harness unchanged.

- [ ] **Step 1: Write the harness**

```js
'use strict';
// Executes a shipped function node's text with a fake msg/db/context.
// Pattern mirrors scripts/test-sync-delivery-fail-closed.js: new Function over
// the exact func string, facade-compatible db over node:sqlite.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');

function loadNode(nodeId, flowsPath) {
  const flows = JSON.parse(fs.readFileSync(
    flowsPath || path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8'));
  const node = flows.find((n) => n.id === nodeId);
  if (!node) throw new Error('node not found: ' + nodeId);
  return node;
}

// Facade-compatible async wrapper over DatabaseSync (all/get/run + close).
function facadeDb(db) {
  return {
    all: (sql, params, cb) => {
      try { cb && cb(null, db.prepare(sql).all(...(params || []))); }
      catch (e) { cb ? cb(e) : Promise.reject(e); }
      return Promise.resolve().then(() => db.prepare(sql).all(...(params || [])));
    },
    get: (sql, params, cb) => {
      const run = () => db.prepare(sql).get(...(params || []));
      try { const r = run(); cb && cb(null, r); return Promise.resolve(r); }
      catch (e) { cb && cb(e); return Promise.reject(e); }
    },
    run: (sql, params, cb) => {
      try { const r = db.prepare(sql).run(...(params || [])); cb && cb(null); return Promise.resolve(r); }
      catch (e) { cb && cb(e); return Promise.reject(e); }
    },
    close: (cb) => { db.close(); if (cb) cb(); return Promise.resolve(); },
  };
}

async function executeFunction(node, { msg, env, flowState, db, osiLibModules }) {
  const errors = [];
  const warnings = [];
  const flowStore = new Map(Object.entries(flowState || {}));
  const sandbox = {
    msg,
    env: { get: (k) => (env || {})[k] },
    flow: { get: (k) => flowStore.get(k), set: (k, v) => flowStore.set(k, v) },
    global: { get: (k) => ({ fs: require('node:fs') })[k] },
    node: {
      error: (m, mm) => errors.push(String(m)),
      warn: (m) => warnings.push(String(m)),
      status: () => {},
    },
    osiDb: { Database: function () { return facadeDb(db); } },
    osiLib: { require: (name) => {
      const loader = (osiLibModules || {})[name];
      return loader ? { ok: true, value: loader } : { ok: false, error: 'unregistered in harness: ' + name };
    } },
  };
  const fn = new Function(
    ...Object.keys(sandbox),
    node.func
  );
  const result = await fn(...Object.values(sandbox));
  return { result, errors, warnings, flowStore };
}

function seedScopedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'database/migrations/ordered/0022__scoped_access_schema.sql'), 'utf8'));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE,
      password_hash TEXT, created_at TEXT, user_uuid TEXT, role TEXT NOT NULL DEFAULT 'researcher',
      disabled_at TEXT);
    CREATE TABLE irrigation_zones (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT,
      user_id INTEGER, zone_uuid TEXT, deleted_at TEXT);
    CREATE TABLE devices (deveui TEXT PRIMARY KEY, name TEXT, type_id TEXT, user_id INTEGER,
      irrigation_zone_id INTEGER, deleted_at TEXT);
    CREATE TABLE journal_plots (plot_uuid TEXT PRIMARY KEY, plot_code TEXT, name TEXT,
      zone_uuid TEXT, owner_user_uuid TEXT, deleted_at TEXT);
    CREATE TABLE user_plot_assignments (assignment_uuid TEXT PRIMARY KEY, user_uuid TEXT,
      plot_uuid TEXT, assigned_by_user_uuid TEXT, gateway_device_eui TEXT,
      sync_version INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    INSERT INTO users (username, password_hash, created_at, user_uuid, role) VALUES
      ('admin1','h','2026-01-01','u-admin','admin'),
      ('res1','h','2026-01-01','u-res1','researcher'),
      ('view1','h','2026-01-01','u-view1','viewer');
    INSERT INTO irrigation_zones (name, user_id, zone_uuid) VALUES
      ('Z One', 2, 'z-1'), ('Z Two', 1, 'z-2');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id) VALUES
      ('DENDRO1', 'Tree 1', 'DRAGINO_LSN50', 2, 1),
      ('WX1', 'Weather', 'SENSECAP_S2120', 1, 2),
      ('VALVE1', 'Valve', 'STREGA_VALVE', 2, 1);
    INSERT INTO journal_plots (plot_uuid, plot_code, name, zone_uuid, owner_user_uuid) VALUES
      ('p-1','P1','Plot 1','z-1','u-res1'), ('p-2','P2','Plot 2','z-2','u-admin');
    INSERT INTO user_zone_assignments (assignment_uuid, user_uuid, zone_uuid, created_at) VALUES
      ('g-1','u-res1','z-1','2026-01-01'),
      ('g-2','u-view1','z-1','2026-01-01');
  `);
  return db;
}

module.exports = { loadNode, executeFunction, facadeDb, seedScopedDb };
```

- [ ] **Step 2: Smoke-test the harness (red: enforcement not yet wired)**

Create `scripts/test-scoped-access-reads.js`:

```js
#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode, executeFunction, seedScopedDb } = require('./lib/scoped-access-harness');
const S = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js');

const ENV = { OSI_SCOPED_ACCESS: '1' };
const mods = { scope: S };

function asUser(username) {
  // Mirrors the shipped auth nodes: the token decode leaves the username here.
  return { flowState: { status_username: username }, env: ENV };
}

test('F2: researcher reads own zone environment-summary; foreign zone is 404', async () => {
  const node = loadNode('s2120-zones-get-env-summary-auth-fn'); // adjust to shipped id
  const db = seedScopedDb();
  const own = await executeFunction(node, {
    msg: { req: { params: { zone_id: '1' }, headers: {} }, payload: {} },
    ...asUser('res1'), db, osiLibModules: mods,
  });
  assert.notEqual(own.result && own.result.statusCode, 404);
  const foreign = await executeFunction(node, {
    msg: { req: { params: { zone_id: '2' }, headers: {} }, payload: {} },
    ...asUser('res1'), db, osiLibModules: mods,
  });
  assert.equal(foreign.result && foreign.result.statusCode, 404);
  db.close();
});
```

Note for the executor: the node id `s2120-zones-get-env-summary-auth-fn` is illustrative. Task B4 Step 0 records the shipped id for every family endpoint with a blast-radius script; if the id differs, use the shipped one and keep the test honest against it.

- [ ] **Step 3: Run to verify failure**

Run: `node --test scripts/test-scoped-access-reads.js`
Expected: FAIL — the shipped node does not 404 the foreign zone yet (or node id unknown; record which and fix the id, not the assertion).

---

## Task B3: F1 — zone and device list filtering

**Files:**
- Modify: both `flows.json` profiles (list-endpoint function nodes; via one-shot mutation script)
- Modify: `scripts/verify-flows-size-ratchet-allowances.json` (measured deltas)

- [ ] **Step 0: Blast-radius record**

```bash
node -e "
const flows = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
for (const n of flows) {
  if (n.type === 'http in' && ['/api/irrigation-zones','/api/devices'].includes(n.url) && n.method === 'get')
    console.log(n.url, '->', n.wires[0]);
}
"
```
Record the auth/function node ids for both lists; paste the output into the execution report.

- [ ] **Step 1: Insert scope filtering into the zones-list response builder**

After the existing auth step (the `Decode Token`-family node leaves `flow.get('status_username')`), in the node that builds the zone list response, insert before the final SELECT/response:

```js
const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
let scopeZoneFilter = null; // null = no filter
if (scopedOn) {
  const load = osiLib.require('scope');
  if (!load.ok) {
    node.error('zones-list: scope module unavailable: ' + load.error, msg);
    msg.statusCode = 500; msg.payload = { message: 'scope resolver unavailable' };
    return [null, msg];
  }
  const dbS = new osiDb.Database('/data/db/farming.db');
  try {
    const u = await dbS.get('SELECT user_uuid FROM users WHERE username = ?', [flow.get('status_username')]);
    scopeZoneFilter = await load.value.listScopeZoneUuids(dbS, u && u.user_uuid, { scopedMode: true });
  } finally {
    try { await new Promise((res) => dbS.close(() => res())); } catch (e) {
      node.warn('zones-list scope db close failed: ' + (e && e.message ? e.message : e));
    }
  }
}
```

Then apply the filter where the SQL/rows are produced: when `scopeZoneFilter !== null`, append `AND zone_uuid IN (${scopeZoneFilter.map(() => '?').join(',')})` with the uuids bound (or post-filter the row array on `row.zone_uuid` when the query is not parameterized). Keep the node's existing response shape untouched otherwise.

- [ ] **Step 2: Devices list — zone filter plus weather inclusion**

Same insertion, but the device query keeps weather-class rows regardless of zone filter:

```sql
AND ( iz.zone_uuid IN (/* scoped uuids */) OR d.type_id IN ('SENSECAP_S2120','AQUASCOPE_LORAIN') )
```

Devices with no zone (unassigned) appear only when `scopeZoneFilter === null` (admin/flag-off).

- [ ] **Step 3: Green tests for both lists**

Extend `test-scoped-access-reads.js`:

```js
test('F1: researcher sees own zone + weather device only; admin sees all; flag off unchanged', async () => {
  // execute both list chains as res1, admin1, and with OSI_SCOPED_ACCESS unset
  // res1 zones: exactly ['z-1']; res1 devices: DENDRO1? no (zone z-1) yes + WX1 (weather) yes, VALVE1 yes (zone z-1)
  // admin1: all; flag off: all for res1 too
});
```

Assert exact membership, not counts. Run: `node --test scripts/test-scoped-access-reads.js` → PASS.

- [ ] **Step 4: Allowances + checklist + commit**

Measure both nodes' growth, add `node_allowances` entries with reason `AgroLink Phase B: scoped list filtering`, run the full `osi-flows-json-editing` pre-commit checklist, and:

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): scope-filter zone and device lists"
```

---

## Task B4: F2 — zone-path reads

**Endpoints:** `GET /api/irrigation-zones/:zone_id/environment-summary`, `GET /api/irrigation-zones/:zone_id/recommendations`. (`GET /api/gateway/location`, `GET /api/gateways/:gatewayEui/location` move to F6 admin in Task B8.)

- [ ] **Step 1: Insert assertZoneAccess after auth**

In each chain's post-auth function, before any data SELECT:

```js
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
  const load = osiLib.require('scope');
  if (!load.ok) { node.error('env-summary: scope module unavailable: ' + load.error, msg);
    msg.statusCode = 500; msg.payload = { message: 'scope resolver unavailable' }; return [null, msg]; }
  const dbS = new osiDb.Database('/data/db/farming.db');
  try {
    const zoneId = parseInt(msg.req.params.zone_id, 10);
    const u = await dbS.get('SELECT user_uuid FROM users WHERE username = ?', [flow.get('status_username')]);
    const zoneUuid = await load.value.resolveZoneUuidById(dbS, zoneId);
    if (!zoneUuid) { msg.statusCode = 404; msg.payload = { message: 'zone not found' }; return [null, msg]; }
    await load.value.assertZoneAccess(dbS, u && u.user_uuid, zoneUuid, { scopedMode: true });
  } catch (e) {
    if (e && e.status) { msg.statusCode = e.status; msg.payload = { message: 'zone not found' }; return [null, msg]; }
    throw e;
  } finally {
    try { await new Promise((res) => dbS.close(() => res())); } catch (e2) {
      node.warn('env-summary scope db close failed: ' + (e2 && e2.message ? e2.message : e2));
    }
  }
}
```

The B2 test from Task B2 Step 2 now passes against the environment-summary chain; add the recommendations twin.

- [ ] **Step 2: Green + allowances + checklist + commit**

```bash
node --test scripts/test-scoped-access-reads.js
node scripts/verify-flows-fn-parse.js && node scripts/test-flows-wiring.js && node scripts/verify-profile-parity.js
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): assert zone scope on zone-path reads"
```

---

## Task B5: F3 — device-path reads with weather exception

**Endpoints:** `GET /api/dendrometer/:deveui/daily`, `GET /api/dendrometer/:deveui/readings`, `GET /api/devices/:deveui/sensor-history`, `.../dendro-history`, `.../rain-history`, `.../zone-assignments`, `GET /api/v1/devices/:deveui/today-liters`, `GET /download-sensordata`.

- [ ] **Step 1: Insert assertDeviceAccess after auth in each chain**

```js
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
  const load = osiLib.require('scope');
  if (!load.ok) { node.error('device-read: scope module unavailable: ' + load.error, msg);
    msg.statusCode = 500; msg.payload = { message: 'scope resolver unavailable' }; return [null, msg]; }
  const dbS = new osiDb.Database('/data/db/farming.db');
  try {
    const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();
    const u = await dbS.get('SELECT user_uuid FROM users WHERE username = ?', [flow.get('status_username')]);
    await load.value.assertDeviceAccess(dbS, u && u.user_uuid, deveui, { scopedMode: true });
  } catch (e) {
    if (e && e.status) { msg.statusCode = e.status; msg.payload = { message: 'device not found' }; return [null, msg]; }
    throw e;
  } finally {
    try { await new Promise((res) => dbS.close(() => res())); } catch (e2) {
      node.warn('device-read scope db close failed: ' + (e2 && e2.message ? e2.message : e2));
    }
  }
}
```

`/download-sensordata` accepts query filters rather than a path deveui; apply `listScopeZoneUuids` to its WHERE clause and always-allow weather rows, mirroring Task B3 Step 2.

- [ ] **Step 2: Behavioral tests**

```js
test('F3: weather readable by viewer; dendro device 404 outside scope; in-scope ok', async () => {
  // view1 (grant on z-1): WX1 -> allowed (weather, no grant needed);
  //   DENDRO1 -> allowed via z-1 grant; res1 foreign device -> 404
});
```

- [ ] **Step 3: Allowances + checklist + commit**

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): device-scope reads with weather-class exception"
```

---

## Task B6: F4 — history API scoping

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/` (whichever module resolves card/data/export queries; inspect `history-api-router-fn`'s `osiLib.require` targets first) (+ mirror)
- Modify: both `flows.json` profiles (thin call-out in `history-api-router-fn` passing the principal through)

- [ ] **Step 1: Principal passthrough**

`history-api-router-fn` already routes every `/api/history/**` call. Pass the authenticated identity into the router call (one added field on the message it builds): `msg.principal = { username: flow.get('status_username'), scoped: String(env.get('OSI_SCOPED_ACCESS') || '') === '1' }`. Add its allowance delta with reason `AgroLink Phase B: history principal passthrough`.

- [ ] **Step 2: Scope resolution inside the history router module**

In the seam module, before dispatch:

```js
async function scopeCheckForRoute(db, S, principal, route) {
  if (!principal || !principal.scoped) return;
  const u = await db.get('SELECT user_uuid, disabled_at FROM users WHERE username = ?', [principal.username]);
  if (!u || u.disabled_at) { const e = new Error('forbidden'); e.status = 403; throw e; }
  if (route.kind === 'zone') {
    const zoneUuid = await S.resolveZoneUuidById(db, route.zoneId);
    if (!zoneUuid) { const e = new Error('zone not found'); e.status = 404; throw e; }
    await S.assertZoneAccess(db, u.user_uuid, zoneUuid, { scopedMode: true });
  } else if (route.kind === 'gateway') {
    await S.assertRole(db, u.user_uuid, 'admin', { scopedMode: true });
  } else if (route.kind === 'workspace') {
    // workspaces are per-user rows: the existing queries already key user_id;
    // resolve the integer id here and reject cross-user workspace ids with 404.
  }
}
```

`GET /api/history/zones/:zoneId/**` → kind `zone`; `GET /api/history/gateways/:gatewayEui/**` → kind `gateway`; `GET/POST/PUT/DELETE /api/history/workspaces**` → kind `workspace`. Export.csv inherits the zone rule. Map `e.status` to the HTTP response in the router's error path.

- [ ] **Step 3: Tests**

Zone cards as researcher (own 200 / foreign 404), gateway cards as researcher (403), gateway cards as admin (200), workspace of another user (404), flag off (unchanged).

- [ ] **Step 4: Mirror, checklist, commit**

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): scope history API (zone scope, gateway admin, workspace owner)"
```

---

## Task B7: F5 — journal reads under the union rule

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js` (+ mirror)
- Modify: its colocated tests (`scripts/test-journal-api.js` or the module's own test file — confirm which exists and extend it)

- [ ] **Step 1: Extend `listPlots` to the union rule**

The shipped query filters `p.owner_user_uuid=?` plus a zone-owner join. In scoped mode the plot set becomes `owner ∪ granted`, and the zone join constraint drops in favor of scope (zone ownership no longer limits plot visibility — grants decide):

```js
async function listPlots(db, principal, opts) {
  const scoped = opts && opts.scoped === true;
  if (!scoped) return listPlotsLegacy(db, principal); // current query, byte-preserved
  const rows = await dbAll(db,
    'SELECT p.*,s.layout_code,s.updated_at AS settings_updated_at,' +
      's.updated_by_principal_uuid,s.sync_version AS settings_sync_version ' +
    'FROM journal_plots AS p JOIN journal_plot_settings AS s ON s.plot_uuid=p.plot_uuid ' +
    'WHERE p.gateway_device_eui=? AND p.deleted_at IS NULL AND (' +
      'p.owner_user_uuid=? OR p.plot_uuid IN (' +
        'SELECT plot_uuid FROM user_plot_assignments WHERE user_uuid=? AND deleted_at IS NULL)) ' +
    'ORDER BY p.plot_code,p.plot_uuid',
    [principal.gateway_device_eui, principal.owner_user_uuid, principal.owner_user_uuid]
  );
  return { plots: rows.map((row) => plotAggregate(row, {
    layout_code: row.layout_code, updated_at: row.settings_updated_at,
    updated_by_principal_uuid: row.updated_by_principal_uuid,
    sync_version: row.settings_sync_version,
  })) };
}
```

Rename the current body to `listPlotsLegacy` (verbatim move). The caller passes `scoped` from `OSI_SCOPED_ACCESS`. Apply the same union shape to `listPlotGroups`, `listEntries` (entries follow their plot's scope: entry visible when its plot is owned∪granted), and the four export endpoints (they must call the same scoped list functions, never a parallel unfiltered query).

- [ ] **Step 2: Tests**

```js
// res1 owns p-1, holds no grant on p-2: sees p-1 only.
// After INSERT a user_plot_assignments row (u-res1, p-2): sees both.
// Flag off: legacy owner-only result byte-identical to before.
```

- [ ] **Step 3: Mirror, journal test suite, commit**

```bash
node --test scripts/test-journal-api.js 2>/dev/null || node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/
node scripts/verify-profile-parity.js
git add conf/ scripts/
git commit -m "feat(journal): union-rule reads (owner ∪ granted) behind the flag"
```

---

## Task B8: F6 — admin-only reads

**Endpoints:** `GET /download/database`, `GET /api/sync/state`, `GET /api/system/stats`, `GET /api/account-link/status`, `GET /api/improvement-requests`, `.../diagnostics-preview`, `GET /download-fieldtest`, `GET /api/gateway/location`, `GET /api/gateways/:gatewayEui/location`.

- [ ] **Step 1: Insert assertRole('admin') after auth in each chain**

```js
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
  const load = osiLib.require('scope');
  if (!load.ok) { node.error('admin-read: scope module unavailable: ' + load.error, msg);
    msg.statusCode = 500; msg.payload = { message: 'scope resolver unavailable' }; return [null, msg]; }
  const dbS = new osiDb.Database('/data/db/farming.db');
  try {
    const u = await dbS.get('SELECT user_uuid FROM users WHERE username = ?', [flow.get('status_username')]);
    await load.value.assertRole(dbS, u && u.user_uuid, 'admin', { scopedMode: true });
  } catch (e) {
    if (e && e.status) { msg.statusCode = e.status; msg.payload = { message: 'Forbidden' }; return [null, msg]; }
    throw e;
  } finally {
    try { await new Promise((res) => dbS.close(() => res())); } catch (e2) {
      node.warn('admin-read scope db close failed: ' + (e2 && e2.message ? e2.message : e2));
    }
  }
}
```

- [ ] **Step 2: Behavioral tests per endpoint**: researcher → 403; viewer → 403; admin → 200; disabled admin → 403; flag off → unchanged.

- [ ] **Step 3: Allowances + checklist + commit**

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): admin-only guard on gateway/system/diagnostic reads"
```

---

## Task B9: Ratchet verifier `verify-scoped-access.js`

**Files:**
- Create: `scripts/verify-scoped-access.js`
- Modify: `scripts/test-ci-guard-wiring.js` (pin the new command)
- Modify: `.github/workflows/verify-sync-flow.yml` (name it)

- [ ] **Step 1: Write the verifier**

```js
#!/usr/bin/env node
'use strict';
// Scoped-access ratchet (spec §5.4): every HTTP-handler function chain in the
// maintained profiles must reference the scope module (osiLib.require('scope'))
// or be explicitly allowlisted. Necessary-not-sufficient: the behavioral
// matrix (test-scoped-access-*.js) is the correctness gate; this stops
// newly-added endpoints shipping with no scope call at all.
const fs = require('node:fs');

const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
// Endpoints with no scoped data or Phase-A/public semantics (exact http-in ids).
const ALLOWLIST = new Set([
  'auth-register-http', 'auth-login-http', 'api-me-http',
  'history-system-features-http',
]);
const failures = [];

for (const rel of PROFILES) {
  const flows = JSON.parse(fs.readFileSync(rel, 'utf8'));
  const byId = new Map(flows.map((n) => [n.id, n]));
  for (const n of flows) {
    if (n.type !== 'http in' || n.method === 'options') continue;
    if (ALLOWLIST.has(n.id)) continue;
    const seen = new Set();
    let text = '';
    const walk = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const node = byId.get(id);
      if (!node) return;
      text += String(node.func || '') + '\n' + JSON.stringify(node.libs || []);
      for (const w of node.wires || []) for (const t of w) walk(t);
    };
    for (const w of n.wires || []) for (const t of w) walk(t);
    if (!text.includes("require('scope')")) {
      failures.push(`${rel}: ${n.method.toUpperCase()} ${n.url} (${n.id}) has no scope call`);
    }
  }
}

if (failures.length) {
  console.error('FAIL: scoped-access ratchet:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('verify-scoped-access: OK (ratchet only; behavioral matrix is the correctness gate)');
```

- [ ] **Step 2: Expect red until B3–B8 land, then green**

The verifier fails on this branch until all family tasks are committed (that is the ratchet working). Run it after each family task to watch the list shrink; it must be green at Phase B completion. Add allowlist entries only with a code-comment justification reviewed in the PR.

- [ ] **Step 3: Wire CI**

Pin `node scripts/verify-scoped-access.js` in `scripts/test-ci-guard-wiring.js` with a remove-one control, and name it in `.github/workflows/verify-sync-flow.yml`.

```bash
git add scripts/ .github/
git commit -m "test: scoped-access endpoint ratchet (necessary-not-sufficient guard)"
```

---

## Task B10: Phase B gate

- [ ] **Step 1: Full sweep**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
node --test scripts/test-scoped-access-reads.js
node scripts/verify-scoped-access.js
node scripts/verify-sync-flow.js
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-profile-parity.js
scripts/check-mqtt-topics.sh
```
All exit 0.

- [ ] **Step 2: Acceptance against spec §15 Phase B gate**

Behavioral matrix green for read endpoints: admin/researcher/viewer × own/foreign scope × flag on/off is covered by `test-scoped-access-reads.js` across F1–F6. Foreign-scope reads return 404 (zone/device paths) or filtered lists; admin-only reads return 403 for non-admins; weather reads pass any enabled account.

## Notes for the executor

- One DB handle per scope check, opened and closed in the same node (`test-flows-wiring.js` audits this).
- New `try` blocks follow the let-before-try scoping rule; every catch is visible (`node.warn`), never empty.
- If a chain's auth precedent differs from `status_username` (some chains stash the user differently), record the variant in the execution report and adapt the username lookup — do not silently assume.
- `/api/analysis/*` (F7): series/view reads accept zone filters in their request bodies; filter those through `listScopeZoneUuids` when present, and treat saved views as per-user rows. No endpoint in F7 leaks foreign zone data; verify with one test per endpoint before closing the family.
