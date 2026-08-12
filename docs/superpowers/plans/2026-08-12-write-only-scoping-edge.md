# Write-Only Scoping — Edge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every read on an OSI OS gateway account-wide for any enabled account, keep zone scope and role as write-only gates, and give the zone card a two-tab add-device modal that either assigns an unassigned device or registers a new one straight into the zone.

**Architecture:** The three gates (authenticated + enabled account, role, zone write scope) stay; only the read filters are deleted. Backend reads keep `verifyBearer` + `assertEnabledAccount` and drop every `assertZoneAccess`/`assertDeviceAccess`/`listScopeZoneUuids`/plot-filter predicate; `POST /api/devices` takes an optional `zone_id` that is write-scope-checked, and `PUT /api/irrigation-zones/:id/devices/:deveui` gains an `irrigation_zone_id IS NULL` precondition that returns a naming 409 on conflict. The frontend drops `visibleZones`/`visiblePlots`/`availableZones` filtering and replaces `isZoneVisible` with a write-only `zoneWritable`.

**Tech Stack:** Node-RED flows.json function nodes, osi-scope-helper / osi-journal local packages, Node.js node:test, React+TypeScript (web/react-gui), vitest + tsx --test.

## Global Constraints

- **Flag-off behavior is unchanged.** Every node edited here already branches on `String(env.get('OSI_SCOPED_ACCESS') || '') === '1'`. The legacy `d.user_id = ?` / `iz.user_id = ?` / `owner_user_uuid = ? AND user_id = ?` filters stay exactly as they are on the `else` side. Silvan, kaba100 and Uganda run flag-off; agrolink-test-01 is the only scoped gateway.
- **bcm2712 is the edit source; bcm2709 is a byte-identical mirror.** This covers `flows.json`, `osi-scope-helper/`, and `osi-journal/`. Never hand-edit the mirror.
- **flows.json edits follow the `osi-flows-json-editing` skill.** Every executor **MUST load `.claude/skills/osi-flows-json-editing`** before touching `flows.json`. One-shot Node script in the scratchpad only — never an Edit-tool string replacement. Run the roundtrip guard before and after every mutation, write both profiles, and run `node scripts/verify-sync-flow.js` (it chains profile parity and must end `All parity checks passed.`) before every commit that touches `flows.json`.
- **`assertEnabledAccount` survives on every read route (P1).** Removing a zone/device filter never means removing the disabled-account check. Where a route's only scope call was `assertDeviceAccess`/`assertZoneAccess` (which carried the disabled check implicitly), `assertEnabledAccount` replaces it explicitly. `get-zones-query` never had one and gains one.
- **Do not touch the actuation path (P4).** `write-strega-expectation`'s dual `assertFreshDeviceAccess` + `canMutate` gate, the `_systemActuation` scheduler exemption, `scope_actor_required` in the cloud-relay apply nodes, `cancel-strega-actuation-fn`, `put-strega-timed-auth-fn`, `83bb4a452dd9ae37` and `70fcbea336401bd1` are out of scope. No consolidation, no shared-helper refactor that reaches them.
- **Do not touch the shared write hubs (P6).** `scoped-device-config-guard` (23 routes) and `scoped-zone-config-guard` (4 routes) are unchanged, as are `scoped-device-delete-router`, `scoped-device-unassign-router`, `scoped-zone-create-router`, `scoped-zone-delete-router`, `scoped-weather-zone-assign-router`, `scoped-admin-account-router`, `settings-disable-schedules-fn` and every `authorizeAdminRead` guard.
- **Workspaces stay owner-only (P3/W6).** `/api/history/workspaces*` keeps its unconditional `user_id = ?` on read and write.
- **Sync triggers stay row-wise (P11).** Assignment and registration keep using single-row `UPDATE devices ... WHERE deveui = ?` / `INSERT INTO devices` so `trg_sync_devices_outbox_au` fires and `sync_version` bumps. No bulk `UPDATE ... WHERE irrigation_zone_id IN (...)` path.
- **Never run two frontend builds concurrently** — this workstation OOMs (swap is zram). Reviewers do not build. `cd web/react-gui && npm run test:unit` is the only frontend test command; never bare `npx vitest run` (it skips the `tsx --test` half).
- **Each task commits separately**, with the failing test committed in the same commit as its fix (TDD order inside the task, one commit at the end).

## Known gap carried forward (not fixed here)

W3 creates unassigned devices, but `assertFreshDeviceAccess` still 404s on any device with no `zone_uuid`. So in scoped mode an unassigned device can be listed, read and assigned — but not renamed, configured or deleted until it is assigned to a zone. Widening `assertFreshDeviceAccess` would silently widen the STREGA actuation dual-gate (P4), which this plan is forbidden to touch, so it is deliberately deferred to a follow-up. Do not "fix" it opportunistically inside these tasks.

---

## Task 1 — Device and zone list reads go account-wide

**Files**
- Modify: `scripts/test-scoped-access-reads.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (nodes `get-devices-query`, `get-zones-query`, `api-me-fn`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (mirror)

**Interfaces**
- Consumes: `scope.assertEnabledAccount(db, userUuid, { scopedMode: true })` → resolves to a scope object, throws `{statusCode: 403}` for a disabled account.
- Produces: `get-devices-query` emits `msg.topic` whose scoped `WHERE` clause is `d.deleted_at IS NULL` only (no user, zone or type predicate). `get-zones-query` emits `msg.payload` = every non-deleted zone row.

**Steps**

- [ ] **Write the failing tests.** In `scripts/test-scoped-access-reads.js`, replace the two tests `'F1: scoped lists use owned-plus-granted zones and keep weather shared'` and `'F1: admin has no scope bypass and flag-off behavior remains owner-only'` with:

```js
function seedUnassignedDevice(db) {
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
    ) VALUES
      ('UNASSIGNED1', 'Fresh LSN50', 'DRAGINO_LSN50', 1, NULL, '2026-01-01', '2026-01-01');
  `);
}

test('F1: every enabled role lists every zone and device on the gateway', async () => {
  const db = seedScopedDb();
  seedUnassignedDevice(db);
  try {
    for (const userId of [1, 2, 3]) {
      scopeHelper._resetForTests();
      assert.deepEqual(
        (await zoneList(db, userId)).map((row) => row.zone_uuid).sort(),
        ['z-1', 'z-2'],
        `user ${userId} must see every zone`
      );
      assert.deepEqual(
        (await deviceList(db, userId)).map((row) => row.deveui).sort(),
        ['DENDRO1', 'DENDRO2', 'UNASSIGNED1', 'VALVE1', 'WX1'],
        `user ${userId} must see every device, including the unassigned bucket`
      );
    }
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('F1: flag-off list behavior remains owner-only', async () => {
  const db = seedScopedDb();
  const flagOff = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' };
  try {
    assert.deepEqual(
      (await zoneList(db, 2, flagOff)).map((row) => row.zone_uuid),
      ['z-1']
    );
    assert.deepEqual(
      (await deviceList(db, 2, flagOff)).map((row) => row.deveui).sort(),
      ['DENDRO1', 'VALVE1']
    );
  } finally {
    db.close();
  }
});

test('P1: a disabled account is denied on both list reads', async () => {
  for (const [label, nodeId, pick] of [
    ['devices', 'get-devices-query', (result) => result[1]],
    ['zones', 'get-zones-query', (result) => result[1]],
  ]) {
    const db = seedScopedDb();
    db.prepare(
      "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-res1'"
    ).run();
    scopeHelper._resetForTests();
    try {
      const response = await executeFunction(loadNode(nodeId), {
        msg: { payload: [{ id: 2 }], authUserId: 2 },
        env: ENV,
        db,
      });
      const denied = pick(response.result);
      assert.ok(denied, `${label}: a disabled account must be rejected, not served an empty list`);
      assert.equal(denied.statusCode, 403, `${label}: disabled account must get 403`);
      assert.equal(response.result[0], null, `${label}: no success output for a disabled account`);
    } finally {
      db.close();
      scopeHelper._resetForTests();
    }
  }
});
```

  Also delete the now-obsolete test `'E4: a disabled account is denied before the weather-device OR-branch can be reached'` — the OR-branch it guards is being removed, and the new `P1` test above covers the same denial on both list nodes.

- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-reads.js`
  Expected failure: `F1: every enabled role lists every zone and device on the gateway` fails on the first assertion for user 1 (`['z-2'] !== ['z-1','z-2']`), and `P1: a disabled account is denied on both list reads` fails on `zones: a disabled account must be rejected` (today `get-zones-query` has no `assertEnabledAccount`, so `response.result[1]` is `null`).

- [ ] **Load the osi-flows-json-editing skill**, then create `<scratchpad>/flows-edit-t1.js` with the mandatory roundtrip guard and this MUTATE section. Every later flows task reuses this skeleton verbatim and only swaps the MUTATE block.

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd();
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}
function assertRoundtripByteIdentical(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) {
    throw new Error(`Roundtrip guard failed for ${filePath}: STOP and investigate.`);
  }
  console.log('byte-identical: true  (' + original.length + ')');
  return parsed;
}
function nodeById(flows, id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error('node not found: ' + id);
  return node;
}
function replaceOnce(node, from, to) {
  const parts = node.func.split(from);
  if (parts.length !== 2) {
    throw new Error(`expected exactly one occurrence in ${node.id}: ${JSON.stringify(from.slice(0, 60))}`);
  }
  node.func = parts.join(to);
}

const flows = assertRoundtripByteIdentical(CANONICAL);

// --- MUTATE -------------------------------------------------------------
// 1. get-devices-query: account-wide device list, disabled-account check kept.
replaceOnce(
  nodeById(flows, 'get-devices-query'),
  `      const user = await db.get('SELECT user_uuid FROM users WHERE id = ?', [userId]);
      // Deny before building the SQL: the weather-device OR-branch below is not itself
      // gated on account state, so a disabled account with an unexpired token could
      // otherwise still list every weather-station device on the gateway.
      await scopeLoad.value.assertEnabledAccount(db, user && user.user_uuid, { scopedMode: true });
      const zoneUuids = await scopeLoad.value.listScopeZoneUuids(
        db,
        user && user.user_uuid,
        { scopedMode: true }
      );
      const escaped = (zoneUuids || []).map(
        (zoneUuid) => "'" + String(zoneUuid).replace(/'/g, "''") + "'"
      );
      const zonePredicate = escaped.length
        ? 'iz.zone_uuid IN (' + escaped.join(',') + ')'
        : '0';
      whereClause = '(' + zonePredicate +
        " OR d.type_id IN ('SENSECAP_S2120','AQUASCOPE_LORAIN'))";`,
  `      const user = await db.get('SELECT user_uuid FROM users WHERE id = ?', [userId]);
      // Write-only scoping (W1): reads are account-wide, so there is no zone or
      // owner predicate left. The enabled-account check is the whole gate here --
      // without it a disabled account with an unexpired token would read the
      // gateway's entire device list.
      await scopeLoad.value.assertEnabledAccount(db, user && user.user_uuid, { scopedMode: true });
      whereClause = '1 = 1';`
);

// 2. get-zones-query: account-wide zone list + the P1 check it never had.
replaceOnce(
  nodeById(flows, 'get-zones-query'),
  `    const user = await _db.get('SELECT user_uuid FROM users WHERE id = ?', [userId]);
    scopeZoneFilter = await scopeLoad.value.listScopeZoneUuids(
      _db,
      user && user.user_uuid,
      { scopedMode: true }
    );
  }
  const escapedZoneUuids = (scopeZoneFilter || []).map(
    (zoneUuid) => "'" + String(zoneUuid).replace(/'/g, "''") + "'"
  );
  const zoneWhereClause = scopedOn
    ? (escapedZoneUuids.length ? 'iz.zone_uuid IN (' + escapedZoneUuids.join(',') + ')' : '1=0')
    : 'iz.user_id = ' + Number(userId);`,
  `    const user = await _db.get('SELECT user_uuid FROM users WHERE id = ?', [userId]);
    // Write-only scoping (W1/P1): the zone list is account-wide, so the only
    // remaining gate is the enabled-account check. This node had no such check
    // while the zone-uuid predicate carried it implicitly.
    try {
      await scopeLoad.value.assertEnabledAccount(_db, user && user.user_uuid, { scopedMode: true });
    } catch (error) {
      msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
      msg.payload = { message: msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error) };
      await new Promise((resolve) => _db.close(() => resolve()));
      return [null, msg];
    }
  }
  const zoneWhereClause = scopedOn
    ? '1=1'
    : 'iz.user_id = ' + Number(userId);`
);
// scopeZoneFilter is now unused; drop its declaration.
replaceOnce(
  nodeById(flows, 'get-zones-query'),
  `  const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  let scopeZoneFilter = null;
  if (scopedOn) {`,
  `  const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  if (scopedOn) {`
);

// 3. api-me-fn: document zone_uuids/plot_uuids as write scope (W1, spec section 6).
replaceOnce(
  nodeById(flows, 'api-me-fn'),
  `      const scope = await S.resolveScope(db, user.user_uuid, { scopedMode: true });`,
  `      // zone_uuids/plot_uuids are the caller's WRITE scope (W1). Reads are
      // account-wide; the frontend uses these lists only to gate mutations.
      const scope = await S.resolveScope(db, user.user_uuid, { scopedMode: true });`
);
// --- END MUTATE ---------------------------------------------------------

fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
assertRoundtripByteIdentical(CANONICAL);
assertRoundtripByteIdentical(MIRROR);
console.log('Wrote canonical + mirror.');
```

- [ ] **Run the edit:** `node <scratchpad>/flows-edit-t1.js`
  Expected: three `byte-identical: true` lines and `Wrote canonical + mirror.`

- [ ] **Run to see it pass:** `node --test scripts/test-scoped-access-reads.js`
  Expected: exit 0, no failing subtests.

- [ ] **Run the flows gate:** `node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js`
  Expected: `Sync flow verification passed`, then `All parity checks passed.`, then `verify-flows-fn-parse: OK`, then `verify-scoped-access: OK (ratchet only; ...)`, exit 0.

- [ ] **Commit:**
```bash
git add scripts/test-scoped-access-reads.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(scope): make device and zone list reads account-wide"
```

---

## Task 2 — Zone-path reads go account-wide

**Files**
- Modify: `scripts/test-scoped-access-reads.js`
- Modify: both `flows.json` profiles (nodes `zone-env-fn`, `dendro-zone-rec-fn`)

**Interfaces**
- Consumes: `scope.assertEnabledAccount(db, userUuid, { scopedMode: true })`.
- Produces: `GET /api/irrigation-zones/:zone_id/environment-summary` and `.../recommendations` return 200 for any enabled account on any existing zone, 404 only when the zone genuinely does not exist, 403 when the account is disabled.

**Steps**

- [ ] **Write the failing tests.** Replace the three `F2:` tests in `scripts/test-scoped-access-reads.js` with:

```js
test('F2: every enabled role reads any zone environment summary', async () => {
  const node = loadNode('zone-env-fn');
  for (const [userId, username] of [[1, 'admin1'], [2, 'res1'], [3, 'view1']]) {
    for (const zoneId of ['1', '2']) {
      scopeHelper._resetForTests();
      const db = seedScopedDb();
      try {
        const response = await executeFunction(node, {
          msg: requestFor(userId, username, { zone_id: zoneId }),
          env: ENV,
          db,
        });
        assert.equal(
          response.result && response.result.statusCode,
          200,
          `${username} must read zone ${zoneId}`
        );
      } finally {
        db.close();
      }
    }
  }
});

test('F2: recommendations are account-wide and a disabled account is refused', async () => {
  const node = loadNode('dendro-zone-rec-fn');
  const db = seedScopedDb();
  try {
    // zone 2 is owned by admin1 and holds the only recommendation fixture row.
    const viewer = await executeFunction(node, {
      msg: requestFor(3, 'view1', { zone_id: '2' }),
      env: ENV,
      db,
    });
    assert.equal(viewer.result && viewer.result.statusCode, 200);
    assert.equal(viewer.result.payload.length, 1);
  } finally {
    db.close();
  }

  scopeHelper._resetForTests();
  const disabledDb = seedScopedDb();
  disabledDb.prepare(
    "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'"
  ).run();
  try {
    const disabled = await executeFunction(node, {
      msg: requestFor(3, 'view1', { zone_id: '2' }),
      env: ENV,
      db: disabledDb,
    });
    assert.equal(disabled.result && disabled.result.statusCode, 403);
  } finally {
    disabledDb.close();
    scopeHelper._resetForTests();
  }
});

test('F2: a missing zone is still 404 for everyone', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('zone-env-fn'), {
      msg: requestFor(1, 'admin1', { zone_id: '999' }),
      env: ENV,
      db,
    });
    assert.equal(response.result && response.result.statusCode, 404);
  } finally {
    db.close();
  }
});
```

- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-reads.js`
  Expected failure: `F2: every enabled role reads any zone environment summary` fails with `404 !== 200` for `view1` on zone 2 (`assertZoneAccess` denies it today).

- [ ] **Load the osi-flows-json-editing skill**, then run `<scratchpad>/flows-edit-t2.js` — same skeleton as Task 1 with this MUTATE section:

```js
// zone-env-fn: drop the zone-scope assertion, keep the enabled-account check.
replaceOnce(
  nodeById(flows, 'zone-env-fn'),
  `    const zoneUuid = await scopeLoad.value.resolveZoneUuidById(_db, zoneId);
    if (!zoneUuid) {
      const error = new Error('zone not found');
      error.statusCode = 404;
      throw error;
    }
    await scopeLoad.value.assertZoneAccess(
      _db,
      user.user_uuid,
      zoneUuid,
      { scopedMode: true }
    );`,
  `    // Write-only scoping (W1): zone reads are account-wide. The zone-existence
    // 404 stays honest (P8) and the enabled-account check is the only gate (P1).
    const zoneUuid = await scopeLoad.value.resolveZoneUuidById(_db, zoneId);
    if (!zoneUuid) {
      const error = new Error('zone not found');
      error.statusCode = 404;
      throw error;
    }
    await scopeLoad.value.assertEnabledAccount(
      _db,
      user.user_uuid,
      { scopedMode: true }
    );`
);

// dendro-zone-rec-fn: identical shape.
replaceOnce(
  nodeById(flows, 'dendro-zone-rec-fn'),
  `  const zoneUuid = await scopeLoad.value.resolveZoneUuidById(_db, zoneId);
  if (!zoneUuid) {
    const error = new Error('zone not found');
    error.statusCode = 404;
    throw error;
  }
  await scopeLoad.value.assertZoneAccess(
    _db,
    user.user_uuid,
    zoneUuid,
    { scopedMode: true }
  );`,
  `  // Write-only scoping (W1): zone reads are account-wide; only the zone-existence
  // 404 and the enabled-account check (P1) remain.
  const zoneUuid = await scopeLoad.value.resolveZoneUuidById(_db, zoneId);
  if (!zoneUuid) {
    const error = new Error('zone not found');
    error.statusCode = 404;
    throw error;
  }
  await scopeLoad.value.assertEnabledAccount(
    _db,
    user.user_uuid,
    { scopedMode: true }
  );`
);
```

- [ ] **Run to see it pass:** `node --test scripts/test-scoped-access-reads.js` → exit 0.

- [ ] **Run the flows gate:** `node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js` → all pass, ending `All parity checks passed.` and `verify-scoped-access: OK`.

- [ ] **Commit:**
```bash
git add scripts/test-scoped-access-reads.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(scope): make zone environment and recommendation reads account-wide"
```

---

## Task 3 — Device-detail reads go account-wide (P5)

Seven nodes share one identical `assertDeviceAccess` block: `dendro-daily-fn`, `dendro-raw-fn`, `dendro-history-fn`, `rain-history-fn`, `sensor-history-fn`, `strega-today-liters-fn`, `s2120-zones-get-fn`. All seven must change together or a list-visible device 404s on click.

**Files**
- Modify: `scripts/test-scoped-access-reads.js`
- Modify: both `flows.json` profiles (the seven nodes above)

**Interfaces**
- Consumes: `scope.assertEnabledAccount(db, userUuid, { scopedMode: true })`.
- Produces: each of the five device-detail histories plus today-liters and zone-assignments returns 200 for any enabled account on any device, including a device with `irrigation_zone_id IS NULL`.

**Steps**

- [ ] **Write the failing tests.** Replace `'F3: device reads allow grants and shared weather, and hide foreign devices'` and `'F3: scoped today-liters hides a foreign valve'` in `scripts/test-scoped-access-reads.js` with:

```js
test('F3: every device-detail read is account-wide for every enabled role', async () => {
  const cases = [
    ['dendro daily', 'dendro-daily-fn', { deveui: 'DENDRO2' }],
    ['dendro raw', 'dendro-raw-fn', { deveui: 'DENDRO2' }],
    ['dendro history', 'dendro-history-fn', { deveui: 'DENDRO2' }],
    ['rain history', 'rain-history-fn', { deveui: 'DENDRO2' }],
    ['sensor history', 'sensor-history-fn', { deveui: 'DENDRO2' }],
    ['today liters', 'strega-today-liters-fn', { deveui: 'VALVE1' }],
    ['zone assignments', 's2120-zones-get-fn', { deveui: 'WX1' }],
  ];
  for (const [label, nodeId, params] of cases) {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    try {
      const response = await executeFunction(loadNode(nodeId), {
        msg: requestFor(3, 'view1', params),
        env: ENV,
        db,
      });
      assert.equal(
        responseMessage(response.result).statusCode,
        200,
        `${label}: a viewer must read a device outside its write scope`
      );
    } finally {
      db.close();
    }
  }
});

test('P5: an unassigned device is readable, not a 404', async () => {
  for (const [label, nodeId] of [
    ['sensor history', 'sensor-history-fn'],
    ['dendro daily', 'dendro-daily-fn'],
    ['rain history', 'rain-history-fn'],
  ]) {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    db.exec(`
      INSERT INTO devices (
        deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
      ) VALUES
        ('UNASSIGNED1', 'Fresh LSN50', 'DRAGINO_LSN50', 1, NULL, '2026-01-01', '2026-01-01');
    `);
    try {
      const response = await executeFunction(loadNode(nodeId), {
        msg: requestFor(2, 'res1', { deveui: 'UNASSIGNED1' }),
        env: ENV,
        db,
      });
      assert.equal(
        responseMessage(response.result).statusCode,
        200,
        `${label}: a device with no zone must not 404 (P5)`
      );
    } finally {
      db.close();
    }
  }
  scopeHelper._resetForTests();
});

test('P1: device-detail reads still refuse a request with no bearer token', async () => {
  const db = seedScopedDb();
  try {
    for (const [label, nodeId, params] of [
      ['sensor history', 'sensor-history-fn', { deveui: 'DENDRO1' }],
      ['dendro daily', 'dendro-daily-fn', { deveui: 'DENDRO1' }],
      ['today liters', 'strega-today-liters-fn', { deveui: 'VALVE1' }],
      ['zone assignments', 's2120-zones-get-fn', { deveui: 'WX1' }],
    ]) {
      const response = await executeFunction(loadNode(nodeId), {
        msg: { req: { headers: {}, params, query: {} } },
        env: ENV,
        db,
      });
      assert.equal(
        responseMessage(response.result).statusCode,
        401,
        `${label}: an unauthenticated read must still be 401`
      );
    }
  } finally {
    db.close();
  }
});

test('P1: device-detail reads still refuse a disabled account', async () => {
  const db = seedScopedDb();
  db.prepare(
    "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'"
  ).run();
  scopeHelper._resetForTests();
  try {
    for (const [label, nodeId, params] of [
      ['sensor history', 'sensor-history-fn', { deveui: 'DENDRO1' }],
      ['today liters', 'strega-today-liters-fn', { deveui: 'VALVE1' }],
      ['zone assignments', 's2120-zones-get-fn', { deveui: 'WX1' }],
    ]) {
      const response = await executeFunction(loadNode(nodeId), {
        msg: requestFor(3, 'view1', params),
        env: ENV,
        db,
      });
      assert.equal(
        responseMessage(response.result).statusCode,
        403,
        `${label}: a disabled account must be refused`
      );
    }
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});
```

- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-reads.js`
  Expected failure: `F3: every device-detail read is account-wide for every enabled role` fails on `dendro daily: a viewer must read a device outside its write scope` with `404 !== 200`.

- [ ] **Load the osi-flows-json-editing skill**, then run `<scratchpad>/flows-edit-t3.js` — same skeleton, this MUTATE section:

```js
const P5_COMMENT_2 = `  // Write-only scoping (W1/P5): device reads are account-wide, including devices
  // with no zone. The enabled-account check is the only remaining gate (P1).
`;
const P5_COMMENT_6 = `      // Write-only scoping (W1/P5): device reads are account-wide, including
      // devices with no zone. The enabled-account check is the only gate (P1).
`;

// Two-space bodies: dendro-daily-fn, dendro-raw-fn (db var `_db`, user `scopeUser`).
for (const nodeId of ['dendro-daily-fn', 'dendro-raw-fn']) {
  replaceOnce(
    nodeById(flows, nodeId),
    `  await scopeLoad.value.assertDeviceAccess(
    _db,
    scopeUser.user_uuid,
    deveui,
    { scopedMode: true }
  );`,
    P5_COMMENT_2 + `  await scopeLoad.value.assertEnabledAccount(
    _db,
    scopeUser.user_uuid,
    { scopedMode: true }
  );`
  );
}

// Six-space bodies: dendro-history-fn, rain-history-fn, sensor-history-fn.
for (const nodeId of ['dendro-history-fn', 'rain-history-fn', 'sensor-history-fn']) {
  replaceOnce(
    nodeById(flows, nodeId),
    `      await scopeLoad.value.assertDeviceAccess(
        db,
        scopeUser.user_uuid,
        deveui,
        { scopedMode: true }
      );`,
    P5_COMMENT_6 + `      await scopeLoad.value.assertEnabledAccount(
        db,
        scopeUser.user_uuid,
        { scopedMode: true }
      );`
  );
}

// strega-today-liters-fn: same indentation, user row is named `user`.
replaceOnce(
  nodeById(flows, 'strega-today-liters-fn'),
  `      await scopeLoad.value.assertDeviceAccess(
        db,
        user.user_uuid,
        deveui,
        { scopedMode: true }
      );`,
  P5_COMMENT_6 + `      await scopeLoad.value.assertEnabledAccount(
        db,
        user.user_uuid,
        { scopedMode: true }
      );`
);

// s2120-zones-get-fn: four-space body, user row may be undefined.
replaceOnce(
  nodeById(flows, 's2120-zones-get-fn'),
  `    await scopeLoad.value.assertDeviceAccess(
      db,
      scopeUser && scopeUser.user_uuid,
      deveui,
      { scopedMode: true }
    );`,
  `    // Write-only scoping (W1/P5): weather zone-assignment reads are account-wide.
    await scopeLoad.value.assertEnabledAccount(
      db,
      scopeUser && scopeUser.user_uuid,
      { scopedMode: true }
    );`
);
```

  **Executor note:** `replaceOnce` throws if a literal does not match exactly once, so a drifted indentation fails loudly rather than silently skipping a node. If one throws, dump that node's exact text with
  `node -e "const f=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'); process.stdout.write(f.find(n=>n.id==='dendro-daily-fn').func)" | grep -n -A6 assertDeviceAccess`
  and fix the literal. The semantic change per node is exactly `assertDeviceAccess(db, uuid, deveui, opts)` → `assertEnabledAccount(db, uuid, opts)` plus the comment. Nothing else moves; the `scopedOn ? '' : ' AND d.user_id=' + auth.userId` flag-off predicates stay.

- [ ] **Run to see it pass:** `node --test scripts/test-scoped-access-reads.js` → exit 0.

- [ ] **Run the flows gate:** `node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js` → all pass.

- [ ] **Commit:**
```bash
git add scripts/test-scoped-access-reads.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(scope): make all device-detail reads account-wide, including unassigned devices"
```

---

## Task 4 — History router reads go account-wide, admin and workspace gates preserved

`history-api-router-fn` has four scope surfaces: `scopeCheckForRoute`, `scopeRouteForRequest`, `visibleZoneIdsForExport`, and the `scopedReadZoneAccess`/`scopedGatewayReadAccess` constants that today are `scopedOn && requestMethod === 'GET'` — so card-preference writes still run through the owner-only SQL and, worse, through **no** enabled-account check at all (route resolves to `null`, and `scopeCheckForRoute` returns early). This task closes that P1 hole while widening the reads.

**Files**
- Modify: `scripts/test-scoped-access-reads.js`
- Modify: `scripts/verify-history-api-contract.js`
- Modify: both `flows.json` profiles (node `history-api-router-fn`)

**Interfaces**
- Consumes: `scope.assertRole(db, userUuid, 'admin', { scopedMode: true })` (P2, gateway routes only).
- Produces: `scopeCheckForRoute(db, scope, principal, route)` runs the disabled-account check on **every** `/api/history/*` request in scoped mode, and the admin role check only for `route.kind === 'gateway'`. `visibleZoneIdsForExport(q, scope, auth)` returns every non-deleted zone id in scoped mode.

**Steps**

- [ ] **Write the failing tests.** In `scripts/test-scoped-access-reads.js` replace `'F4: history zone reads allow owned and granted zones but hide foreign zones'` and `'F4: account-wide history export contains only visible zones'` with the following, and leave `'F4b: gateway history is admin-only while scoped access is enabled'`, `'F4b: workspace rows remain owner-only in scoped mode'` and `'F4: flag-off history behavior remains owner-only'` untouched — they are the P2/P3 negative controls:

```js
test('F4: history zone reads are account-wide for every enabled role', async () => {
  for (const [userId, username] of [[1, 'admin1'], [2, 'res1'], [3, 'view1']]) {
    for (const zoneId of ['1', '2']) {
      scopeHelper._resetForTests();
      const db = seedScopedDb();
      try {
        const response = await executeFunction(loadNode('history-api-router-fn'), {
          msg: historyRequest(userId, username, 'GET', `/api/history/zones/${zoneId}/cards`, { zoneId }),
          env: ENV,
          db,
        });
        assert.equal(
          response.result && response.result.statusCode,
          200,
          `${username} must read zone ${zoneId} history`
        );
      } finally {
        db.close();
      }
    }
  }
  scopeHelper._resetForTests();
});

test('F4: the account-wide export covers every zone on the gateway', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
    ) VALUES
      ('AA00000000000001', 'Zone one sensor', 'KIWI_SENSOR', 2, 1, '2026-01-01', '2026-01-01'),
      ('AA00000000000002', 'Zone two sensor', 'KIWI_SENSOR', 1, 2, '2026-01-01', '2026-01-01');
    INSERT INTO device_data(deveui, recorded_at, swt_1) VALUES
      ('AA00000000000001', '2026-01-02T08:00:00.000Z', 20),
      ('AA00000000000002', '2026-01-02T09:00:00.000Z', 40);
  `);
  try {
    const msg = historyRequest(3, 'view1', 'GET', '/api/history/export.csv');
    msg.req.query = { scope: 'allZones', from: '2026-01-02', to: '2026-01-02', granularity: 'raw' };
    const response = await executeFunction(loadNode('history-api-router-fn'), { msg, env: ENV, db });

    assert.equal(response.result && response.result.statusCode, 200);
    assert.match(response.result.payload, /Z One/);
    assert.match(response.result.payload, /Z Two/);
  } finally {
    db.close();
  }
});

test('P1: history routes refuse a disabled account, reads and preference writes alike', async () => {
  for (const [label, msgFactory] of [
    ['zone cards', () => historyRequest(3, 'view1', 'GET', '/api/history/zones/1/cards', { zoneId: '1' })],
    ['card opened', () => historyRequest(
      3,
      'view1',
      'POST',
      '/api/history/zones/1/cards/some-card/opened',
      { zoneId: '1', cardId: 'some-card' },
      {}
    )],
  ]) {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    db.prepare(
      "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'"
    ).run();
    try {
      const response = await executeFunction(loadNode('history-api-router-fn'), {
        msg: msgFactory(),
        env: ENV,
        db,
      });
      assert.equal(
        response.result && response.result.statusCode,
        403,
        `${label}: a disabled account must be refused`
      );
    } finally {
      db.close();
    }
  }
  scopeHelper._resetForTests();
});
```

- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-reads.js`
  Expected failure: `F4: history zone reads are account-wide for every enabled role` fails with `404 !== 200` for `view1` on zone 2; `P1: history routes refuse a disabled account...` fails on `card opened` (today it returns 404/200, never 403).

- [ ] **Load the osi-flows-json-editing skill**, then run `<scratchpad>/flows-edit-t4.js` — same skeleton, this MUTATE section:

```js
const router = nodeById(flows, 'history-api-router-fn');

// 1. scopeCheckForRoute: always run the disabled check; admin gate only for gateways.
replaceOnce(
  router,
  `async function scopeCheckForRoute(db, scope, principal, route) {
  if (!principal || !principal.scoped || !route) return;
  const user = await db.get(
    'SELECT user_uuid, disabled_at FROM users WHERE id = ? AND username = ?',
    [principal.userId, principal.username]
  );
  if (!user || user.disabled_at) HR.httpError(403, 'forbidden');
  if (route.kind === 'zone') {
    const zoneUuid = await scope.resolveZoneUuidById(db, route.zoneId);
    if (!zoneUuid) HR.httpError(404, 'zone not found');
    await scope.assertZoneAccess(db, user.user_uuid, zoneUuid, { scopedMode: true });
    return;
  }
  if (route.kind === 'gateway') {
    await scope.assertRole(db, user.user_uuid, 'admin', { scopedMode: true });
  }
  // Workspaces remain owner-only through their unconditional user_id filters.
  // Resolving the user above adds only the disabled-account check in scoped mode.
}`,
  `async function scopeCheckForRoute(db, scope, principal, route) {
  // Write-only scoping (W1): the enabled-account check (P1) runs on EVERY history
  // request, not only the ones with a resolvable route kind -- card-preference
  // writes previously resolved to route=null and skipped this check entirely.
  if (!principal || !principal.scoped) return;
  const user = await db.get(
    'SELECT user_uuid, disabled_at FROM users WHERE id = ? AND username = ?',
    [principal.userId, principal.username]
  );
  if (!user || user.disabled_at) HR.httpError(403, 'forbidden');
  if (route && route.kind === 'gateway') {
    // P2: gateway-wide history stays admin-only.
    await scope.assertRole(db, user.user_uuid, 'admin', { scopedMode: true });
  }
  // Zone history is account-wide (W1). Workspaces remain owner-only (P3/W6)
  // through their unconditional user_id filters.
}`
);

// 2. scopeRouteForRequest: the zone branch has no consumer left.
replaceOnce(
  router,
  `  if (method === 'GET' && /^\\/api\\/history\\/zones\\/[^/]+\\//.test(requestPath)) {
    return { kind: 'zone', zoneId: HR.parseZoneId(params && params.zoneId) };
  }
  if (method === 'GET' && /^\\/api\\/history\\/gateways\\/[^/]+\\//.test(requestPath)) {`,
  `  if (method === 'GET' && /^\\/api\\/history\\/gateways\\/[^/]+\\//.test(requestPath)) {`
);

// 3. visibleZoneIdsForExport: every gateway zone in scoped mode.
replaceOnce(
  router,
  `  const zoneUuids = await scope.listScopeZoneUuids(
    db,
    user.user_uuid,
    { scopedMode: true }
  );
  const allowed = new Set((zoneUuids || []).map(String));
  const zones = await q(
    'SELECT id, zone_uuid FROM irrigation_zones WHERE deleted_at IS NULL ORDER BY id ASC',
    []
  );
  return zones
    .filter(function(zone) { return allowed.has(String(zone.zone_uuid || '')); })
    .map(function(zone) { return Number(zone.id); });`,
  `  // Write-only scoping (W1): the account-wide export covers every zone on the
  // gateway; the disabled-account check above is the only remaining gate (P1).
  const zones = await q(
    'SELECT id FROM irrigation_zones WHERE deleted_at IS NULL ORDER BY id ASC',
    []
  );
  return zones.map(function(zone) { return Number(zone.id); });`
);

// 4. Zone/gateway context reads no longer depend on the HTTP method.
replaceOnce(
  router,
  `const scopedReadZoneAccess = scopedOn && requestMethod === 'GET';
const scopedGatewayReadAccess = scopedOn && requestMethod === 'GET';`,
  `// Write-only scoping (W1): zone/gateway context resolution is account-wide for
// every method. Card-preference rows stay per-user through their own user_id
// filters in getPreferenceRowsForScope/upsertPreference.
const scopedReadZoneAccess = scopedOn;
const scopedGatewayReadAccess = scopedOn;`
);
```

- [ ] **Update the contract verifier.** In `scripts/verify-history-api-contract.js` replace the adapter assertion

```js
  assertContains(failures, adapterSource, 'listScopeZoneUuids', 'account-wide CSV export zone-scope resolver');
```

  with

```js
  assertContains(failures, adapterSource, "assertRole(db, user.user_uuid, 'admin', { scopedMode: true })", 'gateway history stays admin-only (P2)');
  assertContains(failures, adapterSource, 'SELECT id FROM irrigation_zones WHERE deleted_at IS NULL ORDER BY id ASC', 'account-wide CSV export covers every gateway zone (W1)');
```

- [ ] **Run to see it pass:**
```bash
node --test scripts/test-scoped-access-reads.js
node scripts/verify-history-api-contract.js
node --test scripts/verify-history-api-contract.test.js
```
  Expected: all exit 0.

- [ ] **Run the flows gate:** `node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js` → all pass.

- [ ] **Commit:**
```bash
git add scripts/test-scoped-access-reads.js scripts/verify-history-api-contract.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(scope): make history zone reads account-wide, keep gateway and workspace gates"
```

---

## Task 5 — Sensor export, recent actuations and analysis reads go account-wide

**Files**
- Modify: `scripts/test-scoped-access-reads.js`
- Modify: `scripts/verify-history-api-contract.js`
- Modify: both `flows.json` profiles (nodes `fn_build_sensor_sql_params`, `get-actuations-query`, `analysis-api-router-fn`)

**Interfaces**
- Consumes: `scope.assertEnabledAccount(db, userUuid, { scopedMode: true })`.
- Produces: `fn_build_sensor_sql_params` emits `msg.topic` with no zone predicate and `msg.params` carrying only the from/to/deveui/zone query filters; `get-actuations-query` emits a `WHERE 1 = 1` scoped branch; `analysis-api-router-fn` keeps the local `scopeZoneUuids` variable but leaves it `null` (the helper treats `null` as "no zone filter"), so `buildAnalysisCatalog`/`resolveAnalysisSeries`/`listAnalysisViews` call sites are unchanged.

**Steps**

- [ ] **Write the failing tests.** Replace `'F3: sensor export filters scoped rows and keeps flag-off behavior'`, `'F7: analysis channels include grants and exclude foreign zones'`, `'F7: analysis series cannot resolve a selector from a foreign zone'` and `'F7: recent actuations use owned-plus-granted zone visibility'` with:

```js
test('F3: the sensor export is account-wide and keeps its flag-off behavior', async () => {
  const scopedDb = seedScopedDb();
  try {
    const scoped = await executeFunction(loadNode('fn_build_sensor_sql_params'), {
      msg: requestFor(3, 'view1'),
      env: ENV,
      db: scopedDb,
    });
    const output = scoped.result && scoped.result[0];
    assert.doesNotMatch(output.topic, /iz\.zone_uuid IN/);
    assert.doesNotMatch(output.topic, /SENSECAP_S2120/);
    assert.deepEqual(output.params, []);
  } finally {
    scopedDb.close();
  }

  scopeHelper._resetForTests();
  const disabledDb = seedScopedDb();
  disabledDb.prepare(
    "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'"
  ).run();
  try {
    const disabled = await executeFunction(loadNode('fn_build_sensor_sql_params'), {
      msg: requestFor(3, 'view1'),
      env: ENV,
      db: disabledDb,
    });
    assert.equal(disabled.result && disabled.result[1] && disabled.result[1].statusCode, 403);
  } finally {
    disabledDb.close();
    scopeHelper._resetForTests();
  }

  const unscopedDb = seedScopedDb();
  try {
    const unscoped = await executeFunction(loadNode('fn_build_sensor_sql_params'), {
      msg: { req: { headers: {}, params: {}, query: {} } },
      env: { OSI_SCOPED_ACCESS: '0' },
      db: unscopedDb,
    });
    const output = unscoped.result && unscoped.result[0];
    assert.doesNotMatch(output.topic, /iz\.zone_uuid IN/);
    assert.deepEqual(output.params, []);
  } finally {
    unscopedDb.close();
  }
});

test('F7: analysis channels cover every zone for every enabled role', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  seedAnalysisDevices(db);
  try {
    const response = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(3, 'view1', 'GET', '/api/analysis/channels'),
      env: ENV,
      db,
    });
    assert.equal(response.result && response.result.statusCode, 200);
    const zoneIds = new Set(
      (response.result.payload.channels || []).map((channel) => String(channel.zoneId ?? ''))
    );
    assert.ok(zoneIds.has('1'), 'zone 1 channels must be present');
    assert.ok(zoneIds.has('2'), 'zone 2 channels must be present for a viewer (W1)');
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('P1: analysis reads still refuse a disabled account', async () => {
  const db = seedScopedDb();
  db.prepare(
    "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'"
  ).run();
  scopeHelper._resetForTests();
  try {
    const response = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(3, 'view1', 'GET', '/api/analysis/channels'),
      env: ENV,
      db,
    });
    assert.equal(response.result && response.result.statusCode, 403);
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('F7: recent actuations are account-wide', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO valve_actuation_expectations (
      expectation_id, device_eui, zone_id, command_id, commanded_at,
      commanded_duration_seconds, expected_close_at, flow_rate_lpm,
      estimated_gross_liters, volume_source, reconciliation_state
    ) VALUES
      ('e-1', 'VALVE1', 1, 'c-1', '2026-01-02T08:00:00.000Z', 60,
       '2026-01-02T08:01:00.000Z', 10, 10, 'calibrated', 'PENDING_OBSERVATION');
  `);
  try {
    const response = await executeFunction(loadNode('get-actuations-query'), {
      msg: { payload: [{ id: 1 }], authUserId: 1, authUsername: 'admin1' },
      env: ENV,
      db,
    });
    const message = responseMessage(response.result);
    assert.equal(message.statusCode || 200, 200);
    const actuations = (message.payload && message.payload.actuations) || message.payload;
    assert.equal(
      actuations.length,
      1,
      'admin1 owns no zone-1 device but must still see its actuation (W1)'
    );
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});
```

  **Executor note:** confirm the exact `get-actuations-query` success payload shape by reading the node's tail before writing the last assertion (`node -e "..."` as in Task 3); adjust `actuations` extraction to match, but do not weaken the count assertion.

- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-reads.js`
  Expected failure: `F3: the sensor export is account-wide...` fails on `assert.doesNotMatch(output.topic, /iz\.zone_uuid IN/)`; `F7: recent actuations are account-wide` fails with `0 !== 1`.

- [ ] **Load the osi-flows-json-editing skill**, then run `<scratchpad>/flows-edit-t5.js` — same skeleton, this MUTATE section:

```js
// 1. fn_build_sensor_sql_params: keep the enabled-account gate BEFORE the query
//    (the node comment warns about disabled accounts), drop the predicate.
replaceOnce(
  nodeById(flows, 'fn_build_sensor_sql_params'),
  `    const scope = await scopeLoad.value.resolveScope(
      db,
      user.user_uuid,
      { scopedMode: true }
    );
    if (scope.disabled) {
      const error = new Error('account disabled');
      error.statusCode = 403;
      throw error;
    }
    const zoneUuids = Array.from(scope.zoneUuids || []);
    const placeholders = zoneUuids.map(() => '?').join(',');
    sql += placeholders
      ? " AND (iz.zone_uuid IN (" + placeholders +
        ") OR d.type_id IN ('SENSECAP_S2120','AQUASCOPE_LORAIN'))"
      : " AND d.type_id IN ('SENSECAP_S2120','AQUASCOPE_LORAIN')";
    params.push(...zoneUuids);`,
  `    // Write-only scoping (W1): the export is account-wide. The enabled-account
    // check still runs BEFORE the query is built (P1) -- a disabled account with
    // an unexpired token must not reach the SQL at all.
    await scopeLoad.value.assertEnabledAccount(
      db,
      user.user_uuid,
      { scopedMode: true }
    );`
);

// 2. get-actuations-query: no zone filter in scoped mode.
replaceOnce(
  nodeById(flows, 'get-actuations-query'),
  `      zoneUuids = await scopeLoad.value.listScopeZoneUuids(
        _db,
        users[0].user_uuid,
        { scopedMode: true }
      );`,
  `      // Write-only scoping (W1): recent actuations are account-wide; the
      // enabled-account check above is the only gate (P1).
      zoneUuids = [];`
);
replaceOnce(
  nodeById(flows, 'get-actuations-query'),
  `    if (zoneUuids !== null) {
      where = zoneUuids.length
        ? \`WHERE iz.zone_uuid IN (\${zoneUuids.map(() => '?').join(',')})\`
        : 'WHERE 1 = 0';
      params = zoneUuids;
    } else {`,
  `    if (zoneUuids !== null) {
      where = 'WHERE 1 = 1';
      params = [];
    } else {`
);

// 3. analysis-api-router-fn: keep scopeZoneUuids = null (helper treats null as
//    "no zone filter"), so every downstream call site stays byte-identical.
replaceOnce(
  nodeById(flows, 'analysis-api-router-fn'),
  `    await scopeLoad.value.assertEnabledAccount(db, ownerUuid, { scopedMode: true });
    scopeZoneUuids = await scopeLoad.value.listScopeZoneUuids(
      db,
      ownerUuid,
      { scopedMode: true }
    );`,
  `    // Write-only scoping (W1): analysis channels and series are account-wide.
    // scopeZoneUuids stays null, which osi-history-helper reads as "no zone
    // filter". Saved views remain per-user through their own user_id filters.
    await scopeLoad.value.assertEnabledAccount(db, ownerUuid, { scopedMode: true });`
);
```

- [ ] **Update the contract verifier.** In `scripts/verify-history-api-contract.js` replace

```js
  assertContains(failures, source, 'scopeZoneUuids = await scopeLoad.value.listScopeZoneUuids', 'analysis reads resolve owned-plus-granted zone scope');
```

  with

```js
  assertContains(failures, source, 'assertEnabledAccount(db, ownerUuid, { scopedMode: true })', 'analysis reads gate on an enabled account (P1)');
```

- [ ] **Run to see it pass:**
```bash
node --test scripts/test-scoped-access-reads.js
node scripts/verify-history-api-contract.js
node --test scripts/verify-history-api-contract.test.js
```
  Expected: all exit 0.

- [ ] **Run the flows gate:** `node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js` → all pass.

- [ ] **Commit:**
```bash
git add scripts/test-scoped-access-reads.js scripts/verify-history-api-contract.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(scope): make sensor export, actuations and analysis reads account-wide"
```

---

## Task 6 — Journal reads and exports go account-wide (W2)

Three call sites of `resolvedReadScope` carry the plot filter: `buildEntryWhere` (entries + all exports, which route through it), `listPlots`, and `listPlotGroupsInSnapshot`. Journal **write** gates (`assertJournalWriteRole`, `assertZoneWrite`, `assertPlotWrite`, `assertPlotSetWrite`, `assertEntryWrite`) are untouched.

**Files**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js` (byte-identical mirror)
- Modify: `scripts/test-journal-api.js`
- Modify: `scripts/test-scoped-access-reads.js`

**Interfaces**
- Consumes: `resolvedReadScope(db, principal)` → `null` when `principal.scoped` is falsy, otherwise the resolved scope after a 403 on a disabled account. Its return value is now used only as a mode flag, never for `plotUuids`.
- Produces: in scoped mode `buildEntryWhere` yields `clauses = ['e.gateway_device_eui=?', 'e.deleted_at IS NULL', ...]` with no owner/plot clause; `listPlots` and `listPlotGroupsInSnapshot` return every non-deleted row on the gateway.

**Steps**

- [ ] **Write the failing tests.** In `scripts/test-journal-api.js`, replace the test `'scoped journal reads use owned-plus-granted plots while flag-off stays owner-only'` with the version below, and replace `'E5: scoped journal entry list surfaces the owner\'s plot-less entries, not just plot_uuid IN (...)'` with the second one (E5's mechanism is gone, but the NULL-plot_uuid entry must still be listed):

```js
test('W2: scoped journal reads are account-wide while flag-off stays owner-only', async () => {
  const db = new TestDb('scoped-resource-lists');
  seedIdentity(db);
  const ownedPlotUuid = '22100000-0000-4000-8000-000000000001';
  const foreignPlotUuid = '22100000-0000-4000-8000-000000000002';
  const foreignGroupUuid = '22100000-0000-4000-8000-000000000003';
  const ownedEntryUuid = '22100000-0000-4000-8000-000000000004';
  const foreignEntryUuid = '22100000-0000-4000-8000-000000000005';
  const owner = principal();
  const other = principal({
    user_id: 2,
    owner_user_uuid: OTHER_OWNER_UUID,
    author_principal_uuid: OTHER_OWNER_UUID,
    author_label: 'other-user',
  });
  await journal.upsertPlot(db, plotInput(ownedPlotUuid, 'scoped-owned'), owner);
  await journal.upsertPlot(db, plotInput(foreignPlotUuid, 'scoped-foreign'), other);
  await journal.upsertPlotGroup(db, {
    group_uuid: foreignGroupUuid,
    base_sync_version: 0,
    label: 'Foreign cohort',
    resolved: false,
    members: [foreignPlotUuid],
  }, other);
  await journal.saveEntry(
    db,
    entryInput(ownedEntryUuid, ownedPlotUuid, '2026-07-13T08:00:00', { season_crop: 'barley' }),
    owner,
    { mode: 'create' }
  );
  await journal.saveEntry(
    db,
    entryInput(foreignEntryUuid, foreignPlotUuid, '2026-07-13T09:00:00', { season_crop: 'barley' }),
    other,
    { mode: 'create' }
  );

  // Flag-off is unchanged: owner-only.
  const legacy = await journal.listPlots(db, owner);
  assert.deepEqual(legacy.plots.map((plot) => plot.plot_uuid), [ownedPlotUuid]);
  assert.deepEqual(
    (await journal.listEntries(db, { status: 'final' }, owner)).entries
      .map((entry) => entry.entry_uuid),
    [ownedEntryUuid]
  );

  // Scoped mode: account-wide, with no plot grant of any kind (W2).
  const scoped = Object.assign({}, owner, { scope: scopeHelper, scoped: true });
  scopeHelper.invalidateScope(OWNER_UUID);
  assert.deepEqual(
    (await journal.listPlots(db, scoped)).plots.map((plot) => plot.plot_uuid).sort(),
    [foreignPlotUuid, ownedPlotUuid].sort()
  );
  assert.deepEqual(
    (await journal.listEntries(db, { status: 'final' }, scoped)).entries
      .map((entry) => entry.entry_uuid).sort(),
    [foreignEntryUuid, ownedEntryUuid].sort()
  );
  assert.deepEqual(
    (await journal.listPlotGroups(db, scoped)).plot_groups.map((group) => group.group_uuid),
    [foreignGroupUuid]
  );
  assert.deepEqual(
    (await journal.listPlotGroups(db, scoped)).plot_groups[0].members,
    [foreignPlotUuid]
  );
});

test('W2: a plot-less entry is still listed in scoped mode', async () => {
  const db = new TestDb('scoped-plotless-entry');
  seedIdentity(db);
  const plotlessEntryUuid = '22120000-0000-4000-8000-000000000001';
  const owner = principal();
  await journal.saveEntry(
    db,
    entryInput(plotlessEntryUuid, null, '2026-07-13T08:00:00', { season_crop: 'barley' }),
    owner,
    { mode: 'create' }
  );
  assert.equal(
    db.prepare('SELECT plot_uuid FROM journal_entries WHERE entry_uuid=?').get(plotlessEntryUuid)
      .plot_uuid,
    null,
    'test setup: the entry must genuinely persist with a NULL plot_uuid'
  );

  const scoped = Object.assign({}, owner, { scope: scopeHelper, scoped: true });
  scopeHelper.invalidateScope(OWNER_UUID);
  assert.deepEqual(
    (await journal.listEntries(db, { status: 'final' }, scoped)).entries
      .map((entry) => entry.entry_uuid),
    [plotlessEntryUuid]
  );

  // W2: a different account on the same gateway reads it too.
  const other = Object.assign({}, principal({
    user_id: 2,
    owner_user_uuid: OTHER_OWNER_UUID,
    author_principal_uuid: OTHER_OWNER_UUID,
  }), { scope: scopeHelper, scoped: true });
  scopeHelper.invalidateScope(OTHER_OWNER_UUID);
  assert.deepEqual(
    (await journal.listEntries(db, { status: 'final' }, other)).entries
      .map((entry) => entry.entry_uuid),
    [plotlessEntryUuid]
  );
});
```

  **Executor note:** the remainder of the old E5 test asserted that a foreign user could NOT see the plot-less entry. That assertion is inverted above — it is the W2 decision, not an accident. Delete the old tail rather than keeping both.

- [ ] **Add the account-wide journal assertion to the scoped-access read matrix.** Append to `scripts/test-scoped-access-reads.js`:

```js
const journalApi = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal'
);

test('W2: journal entries and plots are account-wide on the scoped-access matrix', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  const gatewayEui = '0016C001F1000001';
  db.exec(`
    UPDATE journal_plots SET gateway_device_eui = '${gatewayEui}';
    INSERT INTO journal_plot_settings (plot_uuid, layout_code, context_json, updated_at, updated_by_principal_uuid, sync_version)
      SELECT plot_uuid, 'default', '{}', '2026-01-01T00:00:00.000Z', owner_user_uuid, 1 FROM journal_plots;
  `);
  const viewerPrincipal = {
    user_id: 3,
    owner_user_uuid: 'u-view1',
    author_principal_uuid: 'u-view1',
    author_label: 'view1',
    gateway_device_eui: gatewayEui,
    origin: 'edge-ui',
    scope: scopeHelper,
    scoped: true,
  };
  try {
    const { plots } = await journalApi.listPlots(facadeDb(db), viewerPrincipal);
    assert.deepEqual(
      plots.map((plot) => plot.plot_uuid).sort(),
      ['p-1', 'p-2'],
      'a viewer with no plot grant must read every plot on the gateway (W2)'
    );
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});
```

  and extend the harness import at the top of the file to `const { executeFunction, facadeDb, loadNode, makeAuthHeader, seedScopedDb } = require('./lib/scoped-access-harness');`.

  **Executor note:** `journal_plot_settings` is required by `listPlots`' inner JOIN; confirm its column list against `database/seed-blank.sql` before running and adjust the INSERT if the schema differs.

- [ ] **Run to see it fail:**
```bash
node --test scripts/test-journal-api.js
node --test scripts/test-scoped-access-reads.js
```
  Expected failure: `W2: scoped journal reads are account-wide while flag-off stays owner-only` fails on the `listPlots` scoped assertion (`['22100000-...-0001'] !== ['22100000-...-0001','22100000-...-0002']`), and the new matrix test fails with `['p-1'] !== ['p-1','p-2']`.

- [ ] **Implement in `osi-journal/api.js` (bcm2712).** Three edits:

```js
// buildEntryWhere (~line 495): drop the owner/plot OR-branch.
  const readScope = await resolvedReadScope(db, principal);
  const clauses = readScope
    ? ['e.gateway_device_eui=?', 'e.deleted_at IS NULL']
    : ['e.owner_user_uuid=?', 'e.user_id=?', 'e.gateway_device_eui=?', 'e.deleted_at IS NULL'];
  const params = readScope
    ? [principal.gateway_device_eui]
    : [principal.owner_user_uuid, principal.user_id, principal.gateway_device_eui];
  // Write-only scoping (W2): every enabled account on the gateway reads every
  // journal entry, including plot-less (zone-only) entries. resolvedReadScope is
  // kept for its disabled-account 403 (P1); its plotUuids are no longer read.
```

  (delete the whole `if (readScope) { ... }` block that pushed `e.owner_user_uuid=?` / `plot_uuid IN (...)`.)

```js
// listPlots (~line 1368): every non-deleted plot on the gateway.
async function listPlots(db, principal) {
  const scope = await resolvedReadScope(db, principal);
  if (!scope) return listPlotsLegacy(db, principal);
  // Write-only scoping (W2): account-wide plot list.
  const rows = await dbAll(
    db,
    'SELECT p.*,s.layout_code,s.context_json,s.updated_at AS settings_updated_at,' +
      's.updated_by_principal_uuid,s.sync_version AS settings_sync_version ' +
    'FROM journal_plots AS p JOIN journal_plot_settings AS s ON s.plot_uuid=p.plot_uuid ' +
    'WHERE p.gateway_device_eui=? AND p.deleted_at IS NULL ' +
    'ORDER BY p.plot_code,p.plot_uuid',
    [principal.gateway_device_eui]
  );
  return aggregatePlotRows(db, rows, principal);
}
```

```js
// listPlotGroupsInSnapshot (~line 2157): account-wide groups and memberships.
async function listPlotGroupsInSnapshot(db, principal) {
  const scope = await resolvedReadScope(db, principal);
  // Write-only scoping (W2): account-wide plot-group list.
  const rows = scope
    ? await dbAll(
      db,
      'SELECT * FROM journal_plot_groups WHERE gateway_device_eui=? AND deleted_at IS NULL ' +
        'ORDER BY resolved_at IS NOT NULL,label,group_uuid',
      [principal.gateway_device_eui]
    )
    : await dbAll(
      db,
      'SELECT * FROM journal_plot_groups WHERE owner_user_uuid=? AND gateway_device_eui=? AND deleted_at IS NULL ' +
        'ORDER BY resolved_at IS NOT NULL,label,group_uuid',
      [principal.owner_user_uuid, principal.gateway_device_eui]
    );
  if (!rows.length) return { plot_groups: [] };
  const ids = rows.map(function(row) { return row.group_uuid; });
  const memberships = scope
    ? await dbAll(
      db,
      'SELECT m.group_uuid,m.plot_uuid FROM journal_plot_group_members AS m ' +
        'JOIN journal_plot_groups AS g ON g.group_uuid=m.group_uuid ' +
        'JOIN journal_plots AS p ON p.plot_uuid=m.plot_uuid ' +
        'WHERE m.group_uuid IN (' + ids.map(function() { return '?'; }).join(',') + ') ' +
        'AND g.gateway_device_eui=? AND g.deleted_at IS NULL ' +
        'AND p.gateway_device_eui=? AND p.deleted_at IS NULL ' +
        'ORDER BY m.group_uuid,m.plot_uuid',
      ids.concat([principal.gateway_device_eui, principal.gateway_device_eui])
    )
    : await dbAll(
      db,
        'SELECT m.group_uuid,m.plot_uuid FROM journal_plot_group_members AS m ' +
        'JOIN journal_plot_groups AS g ON g.group_uuid=m.group_uuid ' +
        'JOIN journal_plots AS p ON p.plot_uuid=m.plot_uuid ' +
        'WHERE m.group_uuid IN (' + ids.map(function() { return '?'; }).join(',') + ') ' +
        'AND g.owner_user_uuid=? AND g.gateway_device_eui=? ' +
        'AND p.owner_user_uuid=? AND p.gateway_device_eui=? ' +
        'ORDER BY m.group_uuid,m.plot_uuid',
      ids.concat([principal.owner_user_uuid, principal.gateway_device_eui,
        principal.owner_user_uuid, principal.gateway_device_eui])
    );
```

  (the `plotUuids` local and the `plotUuids.length ? ... : []` branches go away; the rest of the function below `const byGroup = new Map();` is unchanged.)

- [ ] **Mirror to bcm2709:**
```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js
```

- [ ] **Run to see it pass:**
```bash
node --test scripts/test-journal-api.js
node --test scripts/test-scoped-access-reads.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/index.test.js
node --test scripts/test-journal-lifecycle.js scripts/test-journal-command-path.js scripts/test-journal-v2-contract.js
```
  Expected: all exit 0. If a journal export test asserts a filtered row set, it is asserting the old read filter — update it to the account-wide expectation and say so in the commit message.

- [ ] **Run the parity gate:** `node scripts/verify-sync-flow.js`
  Expected: ends `All parity checks passed.` (this is what catches an un-mirrored `api.js`).

- [ ] **Commit:**
```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js scripts/test-journal-api.js scripts/test-scoped-access-reads.js
git commit -m "feat(scope): make journal entry, plot, group and export reads account-wide"
```

---

## Task 7 — `POST /api/devices` takes an explicit optional `zone_id` (W3, W5)

**Files**
- Modify: `scripts/test-scoped-access-writes.js`
- Modify: both `flows.json` profiles (nodes `scoped-device-claim-router`, `post-devices-insert`)

**Interfaces**
- Consumes: request body `{ deveui, name, type_id, appkey, zone_id? }` where `zone_id` is an integer `irrigation_zones.id`.
- Produces: `msg._deviceZoneId` — `number` when a zone was requested and authorized, `null` otherwise. Consumed only by `post-devices-insert`, which writes it into `devices.irrigation_zone_id`. The old `msg._scopedTargetZoneId` name is retired.
- Errors: `400` for a non-integer `zone_id`, `404` for an unknown zone, `403` for a zone outside the caller's write scope or a non-mutating role.

**Steps**

- [ ] **Write the failing tests.** In `scripts/test-scoped-access-writes.js` replace `'W4: scoped claims require an accessible target zone except for admins'` with:

```js
test('W5: registration accepts an optional in-scope zone_id, unassigned for any writer', async () => {
  const db = seedScopedDb();
  try {
    // W3: no zone_id is legal for every mutation-capable role, researcher included.
    const researcherUnassigned = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(2, 'res1', 'POST', '/api/devices', {}, {
        deveui: 'NEW1',
        name: 'New sensor',
        type_id: 'DRAGINO_LSN50',
      }),
      env: ENV,
      db,
    });
    assert.ok(researcherUnassigned.result[0], 'a researcher may register without a zone (W3)');
    assert.equal(researcherUnassigned.result[0]._deviceZoneId, null);

    scopeHelper._resetForTests();
    const adminUnassigned = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(1, 'admin1', 'POST', '/api/devices', {}, {
        deveui: 'NEW2',
        name: 'New sensor',
        type_id: 'DRAGINO_LSN50',
      }),
      env: ENV,
      db,
    });
    assert.equal(adminUnassigned.result[0]._deviceZoneId, null);

    scopeHelper._resetForTests();
    const inScope = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(2, 'res1', 'POST', '/api/devices', {}, {
        deveui: 'NEW3',
        name: 'Scoped sensor',
        type_id: 'DRAGINO_LSN50',
        zone_id: 1,
      }),
      env: ENV,
      db,
    });
    assert.equal(inScope.result[0]._deviceZoneId, 1);

    scopeHelper._resetForTests();
    const outOfScope = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(1, 'admin1', 'POST', '/api/devices', {}, {
        deveui: 'NEW4',
        name: 'Foreign sensor',
        type_id: 'DRAGINO_LSN50',
        zone_id: 1,
      }),
      env: ENV,
      db,
    });
    assert.equal(outOfScope.result[1].statusCode, 404);

    scopeHelper._resetForTests();
    const unknownZone = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(2, 'res1', 'POST', '/api/devices', {}, {
        deveui: 'NEW5',
        name: 'Ghost zone',
        type_id: 'DRAGINO_LSN50',
        zone_id: 999,
      }),
      env: ENV,
      db,
    });
    assert.equal(unknownZone.result[1].statusCode, 404);

    scopeHelper._resetForTests();
    const badZone = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(2, 'res1', 'POST', '/api/devices', {}, {
        deveui: 'NEW6',
        name: 'Bad zone',
        type_id: 'DRAGINO_LSN50',
        zone_id: 'not-a-number',
      }),
      env: ENV,
      db,
    });
    assert.equal(badZone.result[1].statusCode, 400);

    scopeHelper._resetForTests();
    const viewer = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(3, 'view1', 'POST', '/api/devices', {}, {
        deveui: 'NEW7',
        name: 'Viewer sensor',
        type_id: 'DRAGINO_LSN50',
        zone_id: 1,
      }),
      env: ENV,
      db,
    });
    assert.equal(viewer.result[1].statusCode, 403);
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('W5: flag-off registration ignores the scoped claim router', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(2, 'res1', 'POST', '/api/devices', {}, {
        deveui: 'NEW8',
        name: 'Flag-off sensor',
        type_id: 'DRAGINO_LSN50',
        zone_id: 1,
      }),
      env: { AUTH_TOKEN_SECRET: ENV.AUTH_TOKEN_SECRET, OSI_SCOPED_ACCESS: '0' },
      db,
    });
    assert.ok(response.result[0], 'flag-off must pass the message through untouched');
    assert.equal(response.result[0]._deviceZoneId, undefined);
  } finally {
    db.close();
  }
});
```

  In the same file, update the surviving reference in `'W4: a foreign existing device is hidden before claim or reassignment'`: its POST body key `irrigation_zone_id: 2` becomes `zone_id: 2`. The expected 404 is unchanged — claiming a device already assigned to a foreign zone is still a write on that device and keeps `assertFreshDeviceAccess`.

- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-writes.js`
  Expected failure: `W5: registration accepts an optional in-scope zone_id...` fails on the first assertion — today a researcher with no zone gets `400 irrigation_zone_id is required in scoped mode`, so `result[0]` is `null`.

- [ ] **Load the osi-flows-json-editing skill**, then run `<scratchpad>/flows-edit-t7.js` — same skeleton, this MUTATE section:

```js
// 1. scoped-device-claim-router: explicit optional zone_id (W5), no
//    researcher-must-have-a-zone rule (W3).
replaceOnce(
  nodeById(flows, 'scoped-device-claim-router'),
  `  const targetZoneId = Number(body.irrigation_zone_id);
  if (!Number.isInteger(targetZoneId)) {
    if (actorScope.role !== 'admin') {
      throw Object.assign(new Error('irrigation_zone_id is required in scoped mode'), { statusCode: 400 });
    }
    msg._scopedTargetZoneId = null;
  } else {
    const targetZoneUuid = await scope.resolveZoneUuidById(db, targetZoneId);
    if (!targetZoneUuid) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
    await scope.assertFreshZoneAccess(
      db,
      actor.user_uuid,
      targetZoneUuid,
      { scopedMode: true }
    );
    msg._scopedTargetZoneId = targetZoneId;
  }`,
  `  // W5: zone_id is an explicit, optional integer irrigation_zones.id. W3: any
  // mutation-capable role may register without one; the device lands in the
  // unassigned bucket that every account can now see.
  const rawZoneId = body.zone_id;
  if (rawZoneId === undefined || rawZoneId === null || rawZoneId === '') {
    msg._deviceZoneId = null;
  } else {
    const targetZoneId = Number(rawZoneId);
    if (!Number.isInteger(targetZoneId)) {
      throw Object.assign(new Error('zone_id must be an integer zone id'), { statusCode: 400 });
    }
    const targetZoneUuid = await scope.resolveZoneUuidById(db, targetZoneId);
    if (!targetZoneUuid) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
    await scope.assertFreshZoneAccess(
      db,
      actor.user_uuid,
      targetZoneUuid,
      { scopedMode: true }
    );
    msg._deviceZoneId = targetZoneId;
  }`
);

// 2. post-devices-insert: consume the renamed field (two occurrences).
const insert = nodeById(flows, 'post-devices-insert');
const zoneExprFrom = `(Number.isInteger(msg._scopedTargetZoneId) ? msg._scopedTargetZoneId : 'NULL')`;
const zoneExprTo = `(Number.isInteger(msg._deviceZoneId) ? msg._deviceZoneId : 'NULL')`;
if (insert.func.split(zoneExprFrom).length !== 3) {
  throw new Error('expected exactly two _scopedTargetZoneId occurrences in post-devices-insert');
}
insert.func = insert.func.split(zoneExprFrom).join(zoneExprTo);
```

- [ ] **Run to see it pass:** `node --test scripts/test-scoped-access-writes.js` → exit 0.

- [ ] **Verify no stale references:**
```bash
grep -rn "_scopedTargetZoneId" conf/ scripts/ web/ | grep -v node_modules
```
  Expected: no output.

- [ ] **Run the flows gate:** `node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js && node scripts/test-flows-wiring.js` → all pass; the wiring guard ends `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`.

- [ ] **Commit:**
```bash
git add scripts/test-scoped-access-writes.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(scope): accept an explicit optional zone_id on device registration"
```

---

## Task 8 — Assignment operates only on unassigned devices, 409 names the current zone (P7, P8, W4)

**Files**
- Modify: `scripts/test-scoped-access-writes.js`
- Modify: both `flows.json` profiles (node `scoped-device-assign-router`)

**Interfaces**
- Consumes: `PUT /api/irrigation-zones/:id/devices/:deveui`.
- Produces: `200` with the existing payload on success; `409` with `{ message, current_zone_id, current_zone_name }` when the device is already assigned; `404` when the device does not exist or is deleted; `403` for a non-mutating role; `404` when the target zone is outside the caller's write scope (unchanged `assertFreshZoneAccess`).
- Removed: `assertFreshDeviceAccess` on this route only. `DELETE …/devices/:deveui` (`scoped-device-unassign-router`) keeps both checks.

**Steps**

- [ ] **Write the failing tests.** In `scripts/test-scoped-access-writes.js` replace `'W4: assignment and removal fresh-check both the device and zone'` with:

```js
test('P7: assignment only takes unassigned devices and names the conflict', async () => {
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
    ) VALUES
      ('UNASSIGNED1', 'Fresh LSN50', 'DRAGINO_LSN50', 1, NULL, '2026-01-01', '2026-01-01');
  `);
  try {
    // DENDRO1 already lives in zone 1: assigning it to zone 2 is a 409, not a move.
    const conflict = await executeFunction(loadNode('scoped-device-assign-router'), {
      msg: scopedRequest(
        2,
        'res1',
        'PUT',
        '/api/irrigation-zones/2/devices/DENDRO1',
        { id: '2', deveui: 'DENDRO1' }
      ),
      env: ENV,
      db,
    });
    assert.equal(conflict.result[1].statusCode, 409);
    assert.equal(conflict.result[1].payload.current_zone_id, 1);
    assert.equal(conflict.result[1].payload.current_zone_name, 'Z One');
    assert.equal(
      db.prepare("SELECT irrigation_zone_id FROM devices WHERE deveui='DENDRO1'").get()
        .irrigation_zone_id,
      1,
      'a conflicting assign must not move the device'
    );

    // An unassigned device assigns cleanly and bumps sync_version (P11).
    scopeHelper._resetForTests();
    const assigned = await executeFunction(loadNode('scoped-device-assign-router'), {
      msg: scopedRequest(
        2,
        'res1',
        'PUT',
        '/api/irrigation-zones/2/devices/UNASSIGNED1',
        { id: '2', deveui: 'UNASSIGNED1' }
      ),
      env: ENV,
      db,
    });
    assert.equal(assigned.result[1].statusCode, 200);
    assert.equal(
      db.prepare("SELECT irrigation_zone_id FROM devices WHERE deveui='UNASSIGNED1'").get()
        .irrigation_zone_id,
      2
    );
    assert.equal(
      db.prepare("SELECT sync_version FROM devices WHERE deveui='UNASSIGNED1'").get().sync_version,
      1
    );

    // W4: unassign, then assign — the explicit move.
    scopeHelper._resetForTests();
    const removed = await executeFunction(loadNode('scoped-device-unassign-router'), {
      msg: scopedRequest(
        2,
        'res1',
        'DELETE',
        '/api/irrigation-zones/1/devices/DENDRO1',
        { id: '1', deveui: 'DENDRO1' }
      ),
      env: ENV,
      db,
    });
    assert.equal(removed.result[1].statusCode, 200);

    scopeHelper._resetForTests();
    const reassigned = await executeFunction(loadNode('scoped-device-assign-router'), {
      msg: scopedRequest(
        2,
        'res1',
        'PUT',
        '/api/irrigation-zones/2/devices/DENDRO1',
        { id: '2', deveui: 'DENDRO1' }
      ),
      env: ENV,
      db,
    });
    assert.equal(reassigned.result[1].statusCode, 200);
    assert.equal(
      db.prepare("SELECT irrigation_zone_id FROM devices WHERE deveui='DENDRO1'").get()
        .irrigation_zone_id,
      2
    );
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('P7: assignment keeps its role and target-zone write gates', async () => {
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
    ) VALUES
      ('UNASSIGNED1', 'Fresh LSN50', 'DRAGINO_LSN50', 1, NULL, '2026-01-01', '2026-01-01');
  `);
  try {
    const viewer = await executeFunction(loadNode('scoped-device-assign-router'), {
      msg: scopedRequest(
        3,
        'view1',
        'PUT',
        '/api/irrigation-zones/1/devices/UNASSIGNED1',
        { id: '1', deveui: 'UNASSIGNED1' }
      ),
      env: ENV,
      db,
    });
    assert.equal(viewer.result[1].statusCode, 403);

    scopeHelper._resetForTests();
    const foreignZone = await executeFunction(loadNode('scoped-device-assign-router'), {
      msg: scopedRequest(
        1,
        'admin1',
        'PUT',
        '/api/irrigation-zones/1/devices/UNASSIGNED1',
        { id: '1', deveui: 'UNASSIGNED1' }
      ),
      env: ENV,
      db,
    });
    assert.equal(foreignZone.result[1].statusCode, 404, 'admin1 has no write scope on zone 1');

    scopeHelper._resetForTests();
    const missingDevice = await executeFunction(loadNode('scoped-device-assign-router'), {
      msg: scopedRequest(
        2,
        'res1',
        'PUT',
        '/api/irrigation-zones/1/devices/NOPE',
        { id: '1', deveui: 'NOPE' }
      ),
      env: ENV,
      db,
    });
    assert.equal(missingDevice.result[1].statusCode, 404);
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});
```

  Also update `'W4: a foreign existing device is hidden before claim or reassignment'`: the assignment half (admin1 assigning DENDRO1 to zone 2) now expects `409` with `current_zone_id === 1`, not `404` — the device is no longer hidden from the caller's read scope, so P8 requires an honest conflict.

- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-writes.js`
  Expected failure: `P7: assignment only takes unassigned devices and names the conflict` fails on `assert.equal(conflict.result[1].statusCode, 409)` with `200 !== 409` — today the UPDATE has no `irrigation_zone_id IS NULL` precondition.

- [ ] **Load the osi-flows-json-editing skill**, then run `<scratchpad>/flows-edit-t8.js` — same skeleton, this MUTATE section:

```js
replaceOnce(
  nodeById(flows, 'scoped-device-assign-router'),
  `  await scope.assertFreshZoneAccess(db, actor.user_uuid, zoneUuid, { scopedMode: true });
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
  const changed = await run(
    'UPDATE devices SET irrigation_zone_id = ?, sync_version = COALESCE(sync_version, 0) + 1, ' +
    'updated_at = ? WHERE deveui = ? AND deleted_at IS NULL',
    [zoneId, new Date().toISOString(), deveui]
  );
  if (!changed.changes) throw Object.assign(new Error('device not found'), { statusCode: 404 });`,
  `  await scope.assertFreshZoneAccess(db, actor.user_uuid, zoneUuid, { scopedMode: true });
  // W4/P7: assignment operates only on UNASSIGNED devices. The device no longer
  // has to be in the caller's write scope -- it has to be free. The IS NULL
  // predicate is the race-safe precondition; a lost race lands in the 409 below.
  // P11: still a row-wise UPDATE, so trg_sync_devices_outbox_au fires.
  const changed = await run(
    'UPDATE devices SET irrigation_zone_id = ?, sync_version = COALESCE(sync_version, 0) + 1, ' +
    'updated_at = ? WHERE deveui = ? AND deleted_at IS NULL AND irrigation_zone_id IS NULL',
    [zoneId, new Date().toISOString(), deveui]
  );
  if (!changed.changes) {
    // P8: with enumeration hiding gone, name the real reason.
    const current = await db.get(
      'SELECT d.irrigation_zone_id, iz.name AS zone_name FROM devices d ' +
      'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL ' +
      'WHERE d.deveui = ? AND d.deleted_at IS NULL',
      [deveui]
    );
    if (!current) throw Object.assign(new Error('device not found'), { statusCode: 404 });
    throw Object.assign(new Error('Device is already assigned to a zone'), {
      statusCode: 409,
      conflict: {
        current_zone_id: Number(current.irrigation_zone_id) || null,
        current_zone_name: current.zone_name || null,
      },
    });
  }`
);

// Surface the conflict detail in the catch-all responder.
replaceOnce(
  nodeById(flows, 'scoped-device-assign-router'),
  `} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    message: msg.statusCode === 404 ? 'Device not found' :
      (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))
  };
  return [null, msg];
} finally {`,
  `} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    message: msg.statusCode === 404 ? 'Device not found' :
      (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))
  };
  if (error && error.conflict) {
    msg.payload.current_zone_id = error.conflict.current_zone_id;
    msg.payload.current_zone_name = error.conflict.current_zone_name;
  }
  return [null, msg];
} finally {`
);
```

- [ ] **Run to see it pass:** `node --test scripts/test-scoped-access-writes.js` → exit 0.

- [ ] **Run the flows gate:** `node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js && node scripts/test-flows-wiring.js` → all pass.

- [ ] **Commit:**
```bash
git add scripts/test-scoped-access-writes.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(scope): assign only unassigned devices and return a naming 409 on conflict"
```

---

## Task 9 — `ScopeContext.zoneWritable` replaces the read-visibility helpers

**Files**
- Modify: `web/react-gui/src/contexts/ScopeContext.tsx`
- Modify: `web/react-gui/src/components/CanWrite.tsx`
- Modify: `web/react-gui/src/contexts/__tests__/ScopeContext.test.tsx`
- Modify: `web/react-gui/src/components/__tests__/CanWrite.test.tsx`

**Interfaces**
- Produces: `ScopeValue` gains `zoneWritable(zoneUuid: string): boolean` and loses `isZoneVisible` / `isPlotVisible`. `zoneWritable` returns `resolved && (!isScoped || zoneUuids === null || zoneUuids.includes(zoneUuid))`. `loading`, `isScoped`, `role`, `canWrite`, `isAdmin`, `profile`, `error`, `retry` are unchanged.
- Consumes (CanWrite): `{ loading, canWrite, zoneWritable }`. `isScoped` is no longer read — `zoneWritable` already answers `true` in flag-off mode.

**Steps**

- [ ] **Write the failing tests.** In `web/react-gui/src/contexts/__tests__/ScopeContext.test.tsx` replace every `isZoneVisible`/`isPlotVisible` expectation with `zoneWritable`, and add the plot-scope removal check:

```tsx
  it('fails closed without a provider', () => {
    const { result } = renderHook(() => useScope());

    expect(result.current.canWrite).toBe(false);
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.zoneWritable('any-zone')).toBe(false);
    expect('isZoneVisible' in result.current).toBe(false);
    expect('isPlotVisible' in result.current).toBe(false);
  });
```

  and in the resolved-researcher test:

```tsx
    expect(result.current.zoneWritable('z-1')).toBe(false);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('researcher');
    expect(result.current.canWrite).toBe(true);
    expect(result.current.zoneWritable('z-1')).toBe(true);
    expect(result.current.zoneWritable('z-foreign')).toBe(false);
```

  Rewrite `web/react-gui/src/components/__tests__/CanWrite.test.tsx` as:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanWrite } from '../CanWrite';

const scopeState = vi.hoisted(() => ({
  loading: false,
  canWrite: true,
  isScoped: true,
  zoneWritable: vi.fn<(zoneUuid: string) => boolean>(() => true),
}));

vi.mock('../../contexts/ScopeContext', () => ({
  useScope: () => scopeState,
}));

describe('CanWrite', () => {
  beforeEach(() => {
    scopeState.loading = false;
    scopeState.canWrite = true;
    scopeState.isScoped = true;
    scopeState.zoneWritable.mockReturnValue(true);
  });

  it('does not flash mutation controls while scope is loading', () => {
    scopeState.loading = true;
    render(<CanWrite><button type="button">Save</button></CanWrite>);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('hides writes from viewers and from zones outside the write scope', () => {
    scopeState.canWrite = false;
    const { rerender } = render(
      <CanWrite zoneUuid="zone-1"><button type="button">Save</button></CanWrite>,
    );
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    scopeState.canWrite = true;
    scopeState.zoneWritable.mockReturnValue(false);
    rerender(<CanWrite zoneUuid="zone-1"><button type="button">Save</button></CanWrite>);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('renders writable zones and stays open when the write scope is a wildcard', () => {
    const { rerender } = render(
      <CanWrite zoneUuid="zone-1"><button type="button">Save</button></CanWrite>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();

    scopeState.isScoped = false;
    scopeState.zoneWritable.mockReturnValue(true);
    rerender(<CanWrite zoneUuid="zone-foreign"><button type="button">Save</button></CanWrite>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('renders unscoped children when no zone is named', () => {
    scopeState.zoneWritable.mockReturnValue(false);
    render(<CanWrite><button type="button">Save</button></CanWrite>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(scopeState.zoneWritable).not.toHaveBeenCalled();
  });
});
```

- [ ] **Run to see it fail:** `cd web/react-gui && npm run test:unit`
  Expected failure: `ScopeContext > fails closed without a provider` — `result.current.zoneWritable is not a function`; `CanWrite > renders unscoped children when no zone is named` also fails because `CanWrite` still destructures `isZoneVisible`.

- [ ] **Implement `ScopeContext.tsx`.** Replace the two visibility members:

```tsx
interface ScopeValue {
  loading: boolean;
  isScoped: boolean;
  role: ScopeProfile['role'];
  canWrite: boolean;
  isAdmin: boolean;
  /**
   * Write-only scoping (W1): zone_uuids from /api/me is the caller's WRITE
   * scope. Reads are account-wide, so there is no read-visibility predicate.
   */
  zoneWritable: (zoneUuid: string) => boolean;
  profile: ScopeProfile | null;
  error: string | null;
  retry: () => void;
}

const CLOSED_SCOPE: ScopeValue = {
  loading: false,
  isScoped: false,
  role: 'viewer',
  canWrite: false,
  isAdmin: false,
  zoneWritable: () => false,
  profile: null,
  error: null,
  retry: () => {},
};
```

  and in the `useMemo` body drop the `plotUuids` local and return:

```tsx
    return {
      loading,
      isScoped,
      role,
      canWrite: resolved && role !== 'viewer',
      isAdmin: resolved && role === 'admin',
      zoneWritable: (zoneUuid) =>
        resolved && (!isScoped || zoneUuids === null || zoneUuids.includes(zoneUuid)),
      profile,
      error,
      retry,
    };
```

- [ ] **Implement `CanWrite.tsx`:**

```tsx
import React from 'react';
import { useScope } from '../contexts/ScopeContext';

interface CanWriteProps {
  zoneUuid?: string;
  children: React.ReactNode;
}

export function CanWrite({ zoneUuid, children }: CanWriteProps) {
  const { loading, canWrite, zoneWritable } = useScope();
  if (loading || !canWrite) return null;
  // Write-only scoping (W1): the zone check is a WRITE-scope check, not a
  // read-visibility check. zoneWritable already returns true when the flag is off.
  if (zoneUuid && !zoneWritable(zoneUuid)) return null;
  return <>{children}</>;
}
```

- [ ] **Run to see it pass:** `cd web/react-gui && npm run test:unit && npm run typecheck`
  Expected: `test:unit` exits 0. `typecheck` will still fail with `Property 'isZoneVisible' does not exist` in `FarmingDashboard.tsx`, `JournalPage.tsx` and `HistoryDashboard.tsx` — those are Tasks 10–12. Record the three expected errors and move on; do not patch them here.

- [ ] **Commit:**
```bash
git add web/react-gui/src/contexts/ScopeContext.tsx web/react-gui/src/components/CanWrite.tsx web/react-gui/src/contexts/__tests__/ScopeContext.test.tsx web/react-gui/src/components/__tests__/CanWrite.test.tsx
git commit -m "feat(gui): replace scope read-visibility helpers with a write-only zoneWritable"
```

---

## Task 10 — FarmingDashboard renders every zone and device

**Files**
- Modify: `web/react-gui/src/pages/FarmingDashboard.tsx`
- Modify: `web/react-gui/src/pages/__tests__/FarmingDashboardHeaderWiring.test.tsx`

**Interfaces**
- Consumes: `useScope()` → `{ canWrite, isAdmin, loading: scopeLoading }`. `isScoped` and `isZoneVisible` are no longer read.
- Produces: `zones` renders unfiltered; `devicesByZone` keys off the real `zones` list; `showAdmin={isAdmin && !scopeLoading}`.

**Steps**

- [ ] **Write the failing tests.** In `web/react-gui/src/pages/__tests__/FarmingDashboardHeaderWiring.test.tsx` replace the `it.each` block `'renders only permitted zones for a %s when scoped=%s'` with:

```tsx
  it.each([
    ['researcher', true],
    ['viewer', true],
    ['admin', false],
  ])('renders every zone for a %s when scoped=%s', async (role, isScoped) => {
    scopeState.role = role;
    scopeState.isScoped = isScoped;
    getZones.mockResolvedValue([
      {
        id: 1,
        name: 'Owned zone',
        zone_uuid: 'zone-visible',
        device_count: 0,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        schedule: null,
      },
      {
        id: 2,
        name: 'Colleague zone',
        zone_uuid: 'zone-foreign',
        device_count: 0,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        schedule: null,
      },
    ]);

    renderDashboard();

    await waitFor(() => expect(screen.getByText('Owned zone')).toBeInTheDocument());
    expect(screen.getByText('Colleague zone')).toBeInTheDocument();
  });

  it('shows the admin menu for a scoped admin', async () => {
    scopeState.role = 'admin';
    scopeState.isAdmin = true;
    scopeState.isScoped = true;

    renderDashboard();

    await screen.findByTestId('dashboard-header-marker');
    expect(headerProps[headerProps.length - 1]?.showAdmin).toBe(true);
  });
```

  Then delete `isZoneVisible` from the hoisted `scopeState` mock object and add `zoneWritable: vi.fn(() => true)` in its place (the mock must match the new `ScopeValue` surface).

  **Executor note:** read the file's `scopeState` / `headerProps` definitions before editing so the new assertions use the existing spies rather than new ones.

- [ ] **Run to see it fail:** `cd web/react-gui && npm run test:unit`
  Expected failure: `renders every zone for a researcher when scoped=true` fails with `Unable to find an element with the text: Colleague zone`; `shows the admin menu for a scoped admin` may pass today (the `&& isScoped` conjunct is true here) but will guard the change.

- [ ] **Implement `FarmingDashboard.tsx`:**
  1. Line 32 → `const { canWrite, isAdmin, loading: scopeLoading } = useScope();`
  2. Delete the `visibleZones` (71–77) and `visibleZoneIds` (78–81) `useMemo` blocks.
  3. Replace every `visibleZones` reference with `zones ?? []`. The three sites are: the empty-state condition, the zone map, and the two `useMemo`s building `zoneTimezones` / `irrigationOutcomeZoneContexts` — declare `const allZones = useMemo(() => zones ?? [], [zones]);` once at the top of the render body and use that, so the memo dependency arrays stay stable.
  4. In the `devicesByZone` memo, replace `visibleZoneIds.has(device.irrigation_zone_id)` with a set built from the real zone list, and simplify the weather branch:

```tsx
  const { devicesByZone, unassignedDevices } = useMemo(() => {
    if (!devices || !zones) {
      return { devicesByZone: new Map(), unassignedDevices: [] };
    }

    const zoneIds = new Set(zones.map((zone) => zone.id));
    const byZone = new Map<number, Device[]>();
    const unassigned: Device[] = [];

    devices.forEach((device) => {
      // Weather stations render in their own multi-zone section even when they
      // are zone-assigned -- that is the multi-zone table design, not a scope
      // carve-out. The scope carve-out (visible-zone membership) is gone (W1).
      const weatherDevice =
        device.type_id === 'SENSECAP_S2120' || device.type_id === 'AQUASCOPE_LORAIN';
      if (device.irrigation_zone_id && zoneIds.has(device.irrigation_zone_id) && !weatherDevice) {
        const zoneDevices = byZone.get(device.irrigation_zone_id) || [];
        zoneDevices.push(device);
        byZone.set(device.irrigation_zone_id, zoneDevices);
      } else {
        unassigned.push(device);
      }
    });

    return { devicesByZone: byZone, unassignedDevices: unassigned };
  }, [devices, zones]);
```

  5. Line 154 → `showAdmin={isAdmin && !scopeLoading}`.
  6. Spec §7: `scopeLoading` gates write affordances only, never the lists. Drop it from the two render gates — `const isLoading = !devices && !devicesError && !zones && !zonesError;` and `{devices && zones && (` for the dashboard-content block. `canWrite && !scopeLoading` on the header, the `{!scopeLoading && !canWrite && <ReadOnlyNotice .../>}` banner and the `canWrite` empty-state buttons stay exactly as they are — a failed `/api/me` must degrade to read-only, not to a blank page.

  **Executor note:** step 4 changes one behavior deliberately — a zone-assigned weather station previously landed in `byZone` when its zone was visible. The multi-zone weather section is the intended presentation (spec §7), so weather devices now always go to the weather section. Verify against `IrrigationZoneCard`'s device rendering before committing; if the card is expected to show its own weather station, keep the old ordering (`|| weatherDevice` on the unassigned branch) and drop only the `visibleZoneIds` term.

- [ ] **Run to see it pass:** `cd web/react-gui && npm run test:unit` → exit 0.

- [ ] **Commit:**
```bash
git add web/react-gui/src/pages/FarmingDashboard.tsx web/react-gui/src/pages/__tests__/FarmingDashboardHeaderWiring.test.tsx
git commit -m "feat(gui): render every zone and device on the farming dashboard"
```

---

## Task 11 — JournalPage renders every plot and zone

**Files**
- Modify: `web/react-gui/src/pages/JournalPage.tsx`
- Modify: `web/react-gui/src/pages/__tests__/JournalPage.test.tsx`

**Interfaces**
- Consumes: `useScope()` → `{ loading: scopeLoading, canWrite, isAdmin }`. `isScoped`, `isZoneVisible`, `isPlotVisible` are no longer read.
- Produces: `allZones = zonesState.data ?? []` and `allPlots = plotState.plots` feed every downstream memo; `scopedPlotState` is deleted and `plotState` is passed through directly.

**Steps**

- [ ] **Write the failing test.** In `web/react-gui/src/pages/__tests__/JournalPage.test.tsx` replace the `it.each` block `'filters journal plot choices for a %s when scoped=%s'` with:

```tsx
  it.each([
    ['researcher', true],
    ['viewer', true],
    ['admin', false],
  ])('offers every plot to a %s when scoped=%s', (role, isScoped) => {
    mocks.isDesktopBrowser.mockReturnValue(false);
    mocks.scopeState.role = role;
    mocks.scopeState.isScoped = isScoped;
    mocks.useJournalPlots.mockReturnValue({
      plots: [
        plots[0],
        {
          ...plots[0],
          plot_uuid: ROUTE_FIXTURE_IDS.secondaryPlot,
          plot_code: 'S-2',
          name: 'Colleague field',
        },
      ],
      loading: false,
      error: undefined,
      retry: mocks.retryPlots,
      revalidate: mocks.retryPlots,
      createPlot: vi.fn(),
      updatePlot: vi.fn(),
    });

    renderPage();

    expect(
      screen.getByRole('option', { name: plots[0].name ?? plots[0].plot_code }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Colleague field' })).toBeInTheDocument();
  });
```

  Remove `isPlotVisible` and `isZoneVisible` from the hoisted `mocks.scopeState` and add `zoneWritable: vi.fn(() => true)`.

- [ ] **Run to see it fail:** `cd web/react-gui && npm run test:unit`
  Expected failure: `offers every plot to a researcher when scoped=true` fails with `Unable to find an accessible element with the role "option" and name "Colleague field"`.

- [ ] **Implement `JournalPage.tsx`:**
  1. Lines 50–57 → `const { loading: scopeLoading, canWrite, isAdmin } = useScope();`
  2. Replace the `visibleZones` (93–99) and `visiblePlots` (100–103) memos with:

```tsx
  // Write-only scoping (W1/W2): journal reads are account-wide. Every enabled
  // account sees every plot, zone and entry on the gateway; canWrite still gates
  // capture and edit affordances below.
  const allZones = useMemo(() => zonesState.data ?? [], [zonesState.data]);
  const allPlots = plotState.plots;
```

  3. Delete the `scopedPlotState` memo (104–107) and pass `plotState` wherever `scopedPlotState` was used.
  4. Rename every remaining `visibleZones` → `allZones` and `visiblePlots` → `allPlots` (sites at 109, 112, 113, 118, 120, 125, 127, 132, 138, 139, 277, 279, 306, 349).

- [ ] **Run to see it pass:** `cd web/react-gui && npm run test:unit` → exit 0.

- [ ] **Commit:**
```bash
git add web/react-gui/src/pages/JournalPage.tsx web/react-gui/src/pages/__tests__/JournalPage.test.tsx
git commit -m "feat(gui): render every journal plot and zone for enabled accounts"
```

---

## Task 12 — HistoryDashboard renders every zone and stops gating the shell on scope

**Files**
- Modify: `web/react-gui/src/pages/HistoryDashboard.tsx`
- Modify: `web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx`

**Interfaces**
- Consumes: `useScope()` → `{ isAdmin, loading: scopeLoading }`.
- Produces: `availableZones = zones ?? []`; `shellReady = featureFlags.historyEnabled && availableZones.length > 0 && !zonesError` — `scopeLoading` no longer blocks the list (spec §7: a failed `/api/me` degrades to read-only, not a blank page); `showAdmin={isAdmin && !scopeLoading}`.

**Steps**

- [ ] **Write the failing tests.** In `web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx` replace the `it.each` block `'filters history zone selectors for a %s when scoped=%s'` with:

```tsx
  it.each([
    ['researcher', true],
    ['viewer', true],
    ['admin', false],
  ])('offers every history zone to a %s when scoped=%s', async (role, isScoped) => {
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: false,
      historyWorkspacesEnabled: false,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
    });
    scopeState.role = role;
    scopeState.isScoped = isScoped;
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValue([
      {
        id: 1,
        name: 'North Block',
        zone_uuid: 'zone-north',
        device_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        schedule: null,
      },
      {
        id: 2,
        name: 'South Block',
        zone_uuid: 'zone-south',
        device_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        schedule: null,
      },
    ]);

    render(<HistoryDashboard />);

    await waitFor(() => expect(screen.getByText('North Block')).toBeInTheDocument());
    expect(screen.getByText('South Block')).toBeInTheDocument();
  });

  it('renders the zone list even when the scope profile never resolves', async () => {
    vi.mocked(systemAPI.getFeatures).mockResolvedValue({
      historyUxEnabled: true,
      historyComparisonEnabled: false,
      historyWorkspacesEnabled: false,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
    });
    scopeState.loading = true;
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValue([
      {
        id: 1,
        name: 'North Block',
        zone_uuid: 'zone-north',
        device_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        schedule: null,
      },
    ]);

    render(<HistoryDashboard />);

    await waitFor(() => expect(screen.getByText('North Block')).toBeInTheDocument());
  });
```

  Replace `isZoneVisible` in the hoisted `scopeState` with `zoneWritable: vi.fn(() => true)`, and make sure `beforeEach` resets `scopeState.loading = false`.

  **Executor note:** match the file's existing render helper (it may render through a wrapper rather than `render(<HistoryDashboard />)`); reuse whatever the neighbouring tests use.

- [ ] **Run to see it fail:** `cd web/react-gui && npm run test:unit`
  Expected failure: `offers every history zone to a researcher when scoped=true` fails on `South Block`; `renders the zone list even when the scope profile never resolves` fails because `shellReady` is false while `scopeLoading` is true.

- [ ] **Implement `HistoryDashboard.tsx`:**
  1. Line 74 → `const { isAdmin, loading: scopeLoading } = useScope();`
  2. Replace the `availableZones` memo (110–116) with:

```tsx
  // Write-only scoping (W1): history reads are account-wide.
  const availableZones = useMemo(() => zones ?? [], [zones]);
```

  3. Line 400–401 → `const shellReady = featureFlags.historyEnabled && availableZones.length > 0 && !zonesError;`
  4. Line 413 → `showAdmin={isAdmin && !scopeLoading}`
  5. Line 453: drop the `&& !scopeLoading` conjunct from the empty-state condition so the "no zones" message no longer waits on `/api/me`.

- [ ] **Run to see it pass:** `cd web/react-gui && npm run test:unit && npm run typecheck`
  Expected: both exit 0 — this is the task where `typecheck` goes green again after Task 9.

- [ ] **Commit:**
```bash
git add web/react-gui/src/pages/HistoryDashboard.tsx web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx
git commit -m "feat(gui): render every history zone and stop gating the shell on scope"
```

---

## Task 13 — Two-tab zone device modal, on ui-core

The zone card's two affordances collapse into one modal with an "Assign existing" tab (today's picker plus 409 handling) and a "New device" tab (the registration form with the zone fixed, posting `zone_id`). `AddDeviceModal` (header flow) migrates to ui-core in the same pass and keeps registering unassigned.

**Files**
- Create: `web/react-gui/src/components/farming/ZoneDeviceModal.tsx`
- Create: `web/react-gui/src/components/farming/__tests__/ZoneDeviceModal.test.tsx`
- Modify: `web/react-gui/src/components/farming/AddDeviceModal.tsx`
- Modify: `web/react-gui/src/components/farming/IrrigationZoneCard.tsx`
- Modify: `web/react-gui/src/services/api.ts`
- Modify: `web/react-gui/src/types/farming.ts`
- Modify: `web/react-gui/public/locales/{en,de-CH,es,fr,it,lg,pt}/devices.json`
- Create: `web/react-gui/tests/zoneDeviceModalI18n.test.ts`
- Delete: `web/react-gui/src/components/farming/AssignDeviceModal.tsx`

**Interfaces**
- Produces: `ZoneDeviceModal({ isOpen, onClose, onChanged, zoneId, zoneName, availableDevices }: ZoneDeviceModalProps)`.
- Consumes: `irrigationZonesAPI.assignDevice(zoneId: number, deveui: string): Promise<void>` (unchanged; a 409 surfaces as `err.response.status === 409` with `err.response.data.current_zone_name`), and `devicesAPI.add(device: AddDeviceRequest): Promise<Device>` where `AddDeviceRequest` gains `zone_id?: number`.
- Consumes: `{ Button, FormField, INPUT_CLASS, Modal } from '../../ui-core'` — `CreateZoneModal.tsx` is the exemplar.

**Steps**

- [ ] **Add the translation keys first.** In `web/react-gui/public/locales/en/devices.json` add a `zoneDeviceModal` block next to `assignModal`:

```json
  "zoneDeviceModal": {
    "title": "Add a device to {{zoneName}}",
    "tabAssign": "Assign existing",
    "tabRegister": "New device",
    "assignConflict": "That device is now in zone \"{{zoneName}}\". Unassign it there first.",
    "registerZoneNotice": "This device will be registered directly into {{zoneName}}.",
    "registerSubmit": "Register into zone",
    "registering": "Registering..."
  },
```

  and add the same block, translated, to `de-CH`, `es`, `fr`, `it`, `lg`, `pt`. Keep `assignModal.*` — the new modal reuses `assignModal.selectDevice`, `selectPlaceholder`, `noDevicesTitle`, `noDevicesSubtitle`, `assigning`, `submit`, `pleaseSelect`, `failed`, and `addModal.*` for the registration fields.

- [ ] **Write the failing i18n test** at `web/react-gui/tests/zoneDeviceModalI18n.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const localeRoot = path.resolve(process.cwd(), 'public/locales');

function getPath(obj: Record<string, any>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}

test('every locale carries the two-tab zone device modal keys', () => {
  const requiredKeys = [
    'zoneDeviceModal.title',
    'zoneDeviceModal.tabAssign',
    'zoneDeviceModal.tabRegister',
    'zoneDeviceModal.assignConflict',
    'zoneDeviceModal.registerZoneNotice',
    'zoneDeviceModal.registerSubmit',
    'zoneDeviceModal.registering',
  ];

  for (const locale of ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt']) {
    const devices = JSON.parse(
      fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8'),
    );
    for (const key of requiredKeys) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} missing ${key}`);
    }
  }
});
```

- [ ] **Write the failing component test** at `web/react-gui/src/components/farming/__tests__/ZoneDeviceModal.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZoneDeviceModal } from '../ZoneDeviceModal';
import { devicesAPI, irrigationZonesAPI } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  devicesAPI: { add: vi.fn(), getCatalog: vi.fn() },
  irrigationZonesAPI: { assignDevice: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && options.zoneName ? `${key}:${options.zoneName}` : key,
  }),
}));

const devices = [
  {
    deveui: 'AAAA000000000001',
    name: 'Spare sensor',
    type_id: 'DRAGINO_LSN50',
    irrigation_zone_id: null,
  },
] as never[];

describe('ZoneDeviceModal', () => {
  beforeEach(() => {
    vi.mocked(devicesAPI.getCatalog).mockResolvedValue([
      { id: 'DRAGINO_LSN50', name: 'Dragino LSN50' },
    ] as never);
    vi.mocked(devicesAPI.add).mockResolvedValue({} as never);
    vi.mocked(irrigationZonesAPI.assignDevice).mockResolvedValue(undefined);
  });

  const renderModal = (onChanged = vi.fn()) => {
    render(
      <ZoneDeviceModal
        isOpen
        onClose={vi.fn()}
        onChanged={onChanged}
        zoneId={7}
        zoneName="North Block"
        availableDevices={devices}
      />,
    );
    return onChanged;
  };

  it('assigns an existing device from the first tab', async () => {
    const onChanged = renderModal();

    fireEvent.change(screen.getByLabelText('assignModal.selectDevice'), {
      target: { value: 'AAAA000000000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'assignModal.submit' }));

    await waitFor(() =>
      expect(irrigationZonesAPI.assignDevice).toHaveBeenCalledWith(7, 'AAAA000000000001'),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('names the current zone when the assign conflicts and refreshes the list', async () => {
    const onChanged = renderModal();
    vi.mocked(irrigationZonesAPI.assignDevice).mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          message: 'Device is already assigned to a zone',
          current_zone_id: 3,
          current_zone_name: 'South Block',
        },
      },
    });

    fireEvent.change(screen.getByLabelText('assignModal.selectDevice'), {
      target: { value: 'AAAA000000000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'assignModal.submit' }));

    await screen.findByText('zoneDeviceModal.assignConflict:South Block');
    expect(onChanged).toHaveBeenCalled();
  });

  it('registers a new device into the fixed zone from the second tab', async () => {
    const onChanged = renderModal();

    fireEvent.click(screen.getByRole('tab', { name: 'zoneDeviceModal.tabRegister' }));
    fireEvent.change(screen.getByLabelText('addModal.deviceName'), {
      target: { value: 'New tree' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deveui'), {
      target: { value: 'BBBB000000000002' },
    });
    fireEvent.change(screen.getByLabelText('addModal.appkey'), {
      target: { value: 'AABBCCDDEEFF00112233445566778899' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'zoneDeviceModal.registerSubmit' }));

    await waitFor(() =>
      expect(devicesAPI.add).toHaveBeenCalledWith({
        deveui: 'BBBB000000000002',
        name: 'New tree',
        type_id: 'DRAGINO_LSN50',
        appkey: 'AABBCCDDEEFF00112233445566778899',
        zone_id: 7,
      }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('surfaces a bounded ChirpStack error inside the modal', async () => {
    renderModal();
    vi.mocked(devicesAPI.add).mockRejectedValueOnce({
      response: { status: 503, data: { message: 'ChirpStack unreachable' } },
    });

    fireEvent.click(screen.getByRole('tab', { name: 'zoneDeviceModal.tabRegister' }));
    fireEvent.change(screen.getByLabelText('addModal.deviceName'), {
      target: { value: 'New tree' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deveui'), {
      target: { value: 'BBBB000000000002' },
    });
    fireEvent.change(screen.getByLabelText('addModal.appkey'), {
      target: { value: 'AABBCCDDEEFF00112233445566778899' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'zoneDeviceModal.registerSubmit' }));

    await screen.findByText('ChirpStack unreachable');
  });
});
```

- [ ] **Run to see it fail:** `cd web/react-gui && npm run test:unit`
  Expected failure: `zoneDeviceModalI18n` fails with `en missing zoneDeviceModal.title` if the locale step was skipped, and the component suite fails at import with `Failed to resolve import "../ZoneDeviceModal"`.

- [ ] **Extend the API surface.** In `web/react-gui/src/types/farming.ts`:

```ts
export interface AddDeviceRequest {
  deveui: string;
  name: string;
  type_id: DeviceType;
  appkey?: string;
  /** Optional target zone (W5). Absent means the device lands unassigned. */
  zone_id?: number;
}
```

  `devicesAPI.add` already forwards the whole body, so `services/api.ts` needs no change beyond a comment above `add` noting that `zone_id` is write-scope-checked server-side. Verify the request body is not stripped by an interceptor before relying on this.

- [ ] **Create `ZoneDeviceModal.tsx`.** Build it on `Modal`, `FormField`, `INPUT_CLASS` and `Button` from `../../ui-core`, following `CreateZoneModal.tsx`. Shape:
  - `useState<'assign' | 'register'>('assign')` for the tab, rendered as `role="tablist"` with two `role="tab"` buttons (`aria-selected`), so the test can click by role.
  - **Assign tab:** the existing `AssignDeviceModal` body, except the catch block:

```tsx
    } catch (err: any) {
      if (err?.response?.status === 409) {
        setError(t('zoneDeviceModal.assignConflict', {
          zoneName: err.response.data?.current_zone_name ?? '',
        }));
        // The device moved under us; refresh the caller's lists so the picker
        // stops offering it.
        onChanged();
      } else {
        setError(err?.response?.data?.message || t('assignModal.failed'));
      }
    } finally {
```

  - **Register tab:** the `AddDeviceModal` form fields (catalog select, name, DevEUI, AppKey) with the same client-side validation, a `zoneDeviceModal.registerZoneNotice` line instead of a zone picker, and `devicesAPI.add({ deveui, name, type_id: selectedType, appkey: appkey || undefined, zone_id: zoneId })`. Errors from ChirpStack surface via `setError(err?.response?.data?.message || t('addModal.failed'))` and stay inside the modal.
  - Both tabs call `onChanged()` on success and then `onClose()`.

- [ ] **Migrate `AddDeviceModal.tsx` to ui-core** — same fields and behavior, `Modal`/`FormField`/`INPUT_CLASS`/`Button` replacing the hand-rolled overlay and inputs. It keeps registering unassigned: no `zone_id` in its `devicesAPI.add` call.

- [ ] **Wire `IrrigationZoneCard.tsx`:** replace the `AssignDeviceModal` import and its render block (585–592) with

```tsx
      <ZoneDeviceModal
        isOpen={canWrite && showAssignModal}
        onClose={() => setShowAssignModal(false)}
        onChanged={onUpdate}
        zoneId={zone.id}
        zoneName={zone.name}
        availableDevices={unassignedDevices}
      />
```

  and delete `web/react-gui/src/components/farming/AssignDeviceModal.tsx` once no import remains (`grep -rn AssignDeviceModal web/react-gui/src` must return nothing).

- [ ] **Run to see it pass:** `cd web/react-gui && npm run test:unit && npm run typecheck` → both exit 0.

- [ ] **Commit:**
```bash
git add web/react-gui/src/components/farming web/react-gui/src/services/api.ts web/react-gui/src/types/farming.ts web/react-gui/public/locales web/react-gui/tests/zoneDeviceModalI18n.test.ts
git rm web/react-gui/src/components/farming/AssignDeviceModal.tsx
git commit -m "feat(gui): one two-tab zone device modal for assign-existing and register-new"
```

---

## Task 14 — Retire the read-filter API and re-point the structural ratchet

Five `osi-scope-helper` exports exist only to filter reads and now have zero callers: `assertZoneAccess`, `assertPlotAccess`, `assertDeviceAccess`, `listScopeZoneUuids`, `filterZoneUuids`. Deleting them is what makes "no read filter can come back" structural rather than a convention. `resolveZoneUuidById`, `assertFreshDeviceAccess` (writes, P4) and every `assertFresh*`/`assertRole`/`assertEnabledAccount`/`authorizeAdminRead` export stay. **`WEATHER_TYPE_IDS` stays too** — `assertFreshDeviceAccess` reads it at line 232 for the write-path weather bypass, and that path is untouched (P4).

**Files**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js`
- Modify: both bcm2709 mirrors of the two files above
- Modify: `scripts/verify-scoped-access.js`

**Interfaces**
- Removed exports: `assertZoneAccess`, `assertPlotAccess`, `assertDeviceAccess`, `listScopeZoneUuids`, `filterZoneUuids`.
- Produces: `verify-scoped-access.js` gains `findReadFilterRegressions(flows, profileLabel)` → `string[]`, exported alongside the existing `findFailures`, and `verifyProfiles()` returns both sets of failures.

**Steps**

- [ ] **Prove the call sites are gone first:**
```bash
grep -rn "assertZoneAccess\|assertPlotAccess\|assertDeviceAccess\|listScopeZoneUuids\|filterZoneUuids" conf/*/files/usr/share/flows.json conf/*/files/usr/share/node-red/osi-journal/
```
  Expected: no output. Any hit is a missed call site from Tasks 1–6 — go back and fix it there, not here.

- [ ] **Write the failing ratchet test.** Add to `scripts/verify-scoped-access.js`:

```js
// Write-only scoping (W1): the read-filter API is retired. A route that
// reintroduces one of these calls is reintroducing read scoping, which the
// behavioral matrix would catch only if someone wrote the matching test.
const RETIRED_READ_FILTERS = [
  'assertZoneAccess',
  'assertPlotAccess',
  'assertDeviceAccess',
  'listScopeZoneUuids',
  'filterZoneUuids',
];

function findReadFilterRegressions(flows, profileLabel) {
  const failures = [];
  for (const node of flows) {
    const text = String(node.func || '');
    for (const name of RETIRED_READ_FILTERS) {
      if (text.includes(name + '(')) {
        failures.push(
          `${profileLabel}: node ${node.id} (${node.name || 'unnamed'}) calls retired read filter ${name}()`
        );
      }
    }
  }
  return failures;
}
```

  and chain it in `verifyProfiles`:

```js
function verifyProfiles(profiles = PROFILES) {
  const failures = [];
  for (const relativePath of profiles) {
    const flows = JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
    failures.push(...findFailures(flows, relativePath));
    failures.push(...findReadFilterRegressions(flows, relativePath));
  }
  return failures;
}
```

  Export `findReadFilterRegressions` and `RETIRED_READ_FILTERS` from `module.exports`.

- [ ] **Rewrite the helper's own tests.** In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js` delete the tests covering the five retired functions (the `assertZoneAccess` case at ~line 87, both `assertDeviceAccess` cases at ~155 and ~195, and the `listScopeZoneUuids` case at ~203) and add:

```js
test('the read-filter API is retired: write-only scoping exports no read predicate', () => {
  for (const name of [
    'assertZoneAccess',
    'assertPlotAccess',
    'assertDeviceAccess',
    'listScopeZoneUuids',
    'filterZoneUuids',
  ]) {
    assert.equal(scope[name], undefined, `${name} must not be exported (W1)`);
  }
  // Write gates and the enabled-account gate survive.
  for (const name of [
    'assertEnabledAccount',
    'assertFreshZoneAccess',
    'assertFreshPlotAccess',
    'assertFreshDeviceAccess',
    'assertFreshRole',
    'assertRole',
    'authorizeAdminRead',
    'canMutate',
    'resolveZoneUuidById',
  ]) {
    assert.equal(typeof scope[name], 'function', `${name} must survive`);
  }
});
```

  **Executor note:** match the file's existing import alias for the module (`scope` above) before writing this.

- [ ] **Run to see it fail:** `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js`
  Expected failure: `the read-filter API is retired...` fails on `assertZoneAccess must not be exported (W1)`.

- [ ] **Delete the five functions** from `osi-scope-helper/index.js` — `assertZoneAccess`/`assertPlotAccess` (lines 185–195 pre-change), `filterZoneUuids` (321–326), `assertDeviceAccess` (336–352), `listScopeZoneUuids` (354–358) — and remove them from `module.exports`. Keep `scopeAllows` (`assertFreshZoneAccess`/`assertFreshPlotAccess` still use it), `WEATHER_TYPE_IDS` (line 6, still read by `assertFreshDeviceAccess` at line 232), `resolveZoneUuidById` and `assertFreshDeviceAccess`.

- [ ] **Mirror to bcm2709:**
```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.test.js
```

- [ ] **Run the full verifier sweep:**
```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
node --test scripts/test-scoped-access-reads.js
node --test scripts/test-scoped-access-writes.js
node --test scripts/test-journal-api.js
node scripts/verify-scoped-access.js
node scripts/verify-history-api-contract.js
node --test scripts/verify-history-api-contract.test.js
node scripts/verify-flows-fn-parse.js
node scripts/flows-bare-require-scan.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-flows-size-ratchet.js
bash scripts/check-mqtt-topics.sh
node scripts/test-flows-wiring.js
node scripts/verify-sync-flow.js
cd web/react-gui && npm run test:unit && npm run typecheck
```
  Expected: every command exits 0. `verify-scoped-access.js` prints `verify-scoped-access: OK (ratchet only; behavioral matrix is the correctness gate)`; `verify-sync-flow.js` ends `All parity checks passed.`; `test-flows-wiring.js` ends `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`.

- [ ] **Commit:**
```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper scripts/verify-scoped-access.js
git commit -m "refactor(scope): retire the read-filter API and ratchet against its return"
```

---

## Rollout notes (spec §10, edge half)

The cloud half lands in its own plan and the two merge together (W8). Nothing in this plan changes flag-off behavior, so Silvan, kaba100 and Uganda are unaffected; agrolink-test-01 is the only scoped gateway and is the manual verification target. After the paired deploy, walk both GUIs with a granted researcher account and a viewer account: the device list including the unassigned bucket, both modal tabs (including a deliberate 409), a foreign zone's history, a journal entry authored by another account, and one denied write per role. The cloud-side vendored-contract CI has never run for AgroLink branches, so this walkthrough is the gate, not CI.
