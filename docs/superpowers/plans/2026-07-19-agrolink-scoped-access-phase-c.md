# AgroLink Scoped Access — Phase C Implementation Plan (Write-Path Enforcement)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every write path enforces scope with uncached checks (spec §8): valve actuation, schedules, zone lifecycle R1–R6, provisioning, device config, journal writes, and the new admin account/grant API — with immediate revocation, audit attribution, and scheduler authority.

**Architecture:** Physical-effect and privilege paths use `assertFresh*` (no cache) per spec §8. The membership re-assertion repeats inside the same queue write step that enqueues a downlink (spec §8 TOCTOU rule). Scheduler origin is internal; schedules are zone resources disabled when the zone's in-scope enabled set empties. The behavioral harness from Phase B (`scripts/lib/scoped-access-harness.js`) is reused unchanged for the crafted-request matrix.

**Tech Stack:** Node-RED function nodes (one-shot mutation scripts only), `osi-scope-helper`, `node:test` + `node:sqlite`.

**Prerequisites:** Phase B complete and green. Load `osi-flows-json-editing` before any flow task.

**Write-endpoint families (from the verified inventory):**

| Family | Endpoints | Check |
|---|---|---|
| W1 valve actuation | `POST /api/valve/:deveui`, `POST /api/valve/:deveui/cancel`, `POST /api/v1/valves/:deveui/cancel` | assertFreshDeviceAccess + re-assert at enqueue + originator |
| W2 schedules | `PUT /api/irrigation-zones/:id/schedule`, `POST /api/irrigation-zones/schedules/disable-all` | assertFreshZoneAccess (disable-all: per-zone fresh check) |
| W3 zone lifecycle | `POST /api/irrigation-zones` (R1), `DELETE /api/irrigation-zones/:id` (R3+R4) | researcher create/delete with guards |
| W4 provisioning | `POST /api/devices` (R2 claim), `PUT /api/devices/:deveui/zone-assignments`, `PUT /api/irrigation-zones/:id/devices/:deveui`, `DELETE /api/devices/:deveui`, `DELETE /api/irrigation-zones/:id/devices/:deveui` | fresh scope on both device and target zone; R5 |
| W5 device config | 15× `PUT /api/devices/:deveui/*` (dendro, chameleon, kiwi, lsn50, strega config, flow-meter, rain-gauge, temp, soil-moisture-depths, reference-tree) + `POST .../dendro-baseline/reset`, `.../kiwi/temperature-humidity/enable`, `.../chameleon/refresh-calibration` | assertFreshDeviceAccess |
| W6 journal writes | `POST/PUT /api/journal/entries`, `POST .../entries/:uuid/void`, `POST/PUT .../plots`, `.../plot-groups`, `POST/PUT .../custom-vocab` | plot scope in osi-journal seam module |
| W7 zone config | `PUT /api/irrigation-zones/:zone_id/config`, `.../location`, `.../timezone`, `POST /api/irrigation-zones/:id/calibration` | assertFreshZoneAccess + originator |
| W8 admin account/grant API | new: `GET /api/users`, `POST /api/users`, `POST /api/users/:uuid/password-reset`, `PUT /api/users/:uuid/role`, `PUT /api/users/:uuid/disabled`, `POST /api/grants/zone`, `DELETE /api/grants/zone/:assignmentUuid`, `POST /api/grants/plot`, `DELETE /api/grants/plot/:assignmentUuid` | assertRole('admin') fresh + last-admin conditional guard |
| W9 admin system writes | `POST /api/sync/force`, `POST /api/system/reboot`, `POST /api/system/fan`, `POST /api/account-link`, `DELETE /api/account-link`, `POST /api/history/rollups/run` | assertRole('admin') fresh |

---

## Task C1: Helper additions for write enforcement

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js` (+ mirror)
- Modify: its `index.test.js` (+ mirror)

- [ ] **Step 1: Failing tests**

```js
test('assertFreshDeviceAccess: bypasses cache, honors weather exception', async () => {
  let deviceReads = 0;
  const db = fakeDb({
    get: (sql) => {
      if (sql.includes('FROM devices')) { deviceReads += 1; return { deveui: 'D1', type_id: 'DRAGINO_LSN50', zone_uuid: 'z1' }; }
      if (sql.includes('FROM users')) return { id: 7, role: 'researcher', disabled_at: null, user_uuid: 'u1' };
      return undefined;
    },
    all: (sql) => sql.includes('user_zone_assignments') ? [{ zone_uuid: 'z1' }] : [],
  });
  await scope.assertFreshDeviceAccess(db, 'u1', 'D1', { scopedMode: true });
  await scope.assertFreshDeviceAccess(db, 'u1', 'D1', { scopedMode: true });
  assert.equal(deviceReads, 2); // every call hits the db
});

test('assertFreshRole: last-admin guard SQL builder is a single conditional write', async () => {
  const db = fakeDb({ get: () => ({ id: 1, role: 'admin', disabled_at: null, user_uuid: 'u-admin' }) });
  const sql = scope.buildDisableUserGuardedSql();
  assert.ok(sql.includes("SELECT COUNT(*) FROM users WHERE role='admin' AND disabled_at IS NULL"));
  assert.ok(sql.startsWith('UPDATE users SET disabled_at'));
});
```

- [ ] **Step 2: Implement (append to `index.js`)**

```js
async function assertFreshDeviceAccess(db, userUuid, deveui, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) return { role: 'admin', wildcard: true };
  const dev = await db.get(
    `SELECT d.deveui, d.type_id, iz.zone_uuid
       FROM devices d LEFT JOIN irrigation_zones iz
         ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL
      WHERE d.deveui = ? AND d.deleted_at IS NULL`,
    [deveui]
  );
  if (!dev) throw httpError(404, 'device not found');
  const scope = await loadScope(db, userUuid); // never cached
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (WEATHER_TYPE_IDS.has(dev.type_id)) return scope;
  if (!dev.zone_uuid) throw httpError(404, 'device not found');
  if (scope.role !== 'admin' && !scope.zoneUuids.has(dev.zone_uuid)) throw httpError(404, 'device not found');
  return scope;
}

async function assertFreshRole(db, userUuid, role, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) return { role: 'admin', wildcard: true };
  const scope = await loadScope(db, userUuid);
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (scope.role !== role) throw httpError(403, 'insufficient role');
  return scope;
}

// Single conditional write (spec §10): refuses to disable the last enabled
// admin. Zero rows affected -> caller maps to 409.
function buildDisableUserGuardedSql() {
  return "UPDATE users SET disabled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
    "WHERE user_uuid = ? AND disabled_at IS NULL " +
    "AND (SELECT COUNT(*) FROM users WHERE role='admin' AND disabled_at IS NULL) > 1";
}

function buildDeriveUserGuardedSql(newRolePlaceholders) {
  return "UPDATE users SET role = ? " +
    "WHERE user_uuid = ? AND role = 'admin' " +
    "AND (SELECT COUNT(*) FROM users WHERE role='admin' AND disabled_at IS NULL) > 1";
}
```

Export the three new functions. Note: de-roling a non-admin or promoting any account needs no guard; the guard covers disable, de-role, and (Task C8) tombstone/delete with the same conditional shape.

- [ ] **Step 3: Tests pass, mirror, commit**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index*.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/
node scripts/verify-profile-parity.js
git add conf/
git commit -m "feat(scope): fresh write-path checks, atomic last-admin guard"
```

---

## Task C2: W1 — valve actuation with enqueue re-assertion and originator

**Files:**
- Modify: both `flows.json` profiles: the valve POST chain, both cancel chains, and the downlink enqueue node (identify via blast-radius: the node writing to ChirpStack queue / `command-ack` path; `write-strega-expectation` is the expectation-writer precedent)

- [ ] **Step 0: Blast-radius record**

```bash
node -e "
const flows = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
for (const n of flows) {
  if (n.type === 'http in' && /valve/.test(n.url || '')) console.log(n.method, n.url, n.id, '->', n.wires[0]);
}
"
```

- [ ] **Step 1: Fresh check at the REST boundary**

Insert after auth in all three chains (per endpoint; adjust the response node pairing to preserve exactly-one-response):

```js
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
  const load = osiLib.require('scope');
  if (!load.ok) { node.error('valve: scope module unavailable: ' + load.error, msg);
    msg.statusCode = 500; msg.payload = { message: 'scope resolver unavailable' }; return [null, msg]; }
  const dbS = new osiDb.Database('/data/db/farming.db');
  try {
    const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();
    const u = await dbS.get('SELECT user_uuid FROM users WHERE username = ?', [flow.get('status_username')]);
    const scopeRes = await load.value.assertFreshDeviceAccess(dbS, u && u.user_uuid, deveui, { scopedMode: true });
    flow.set('actor_user_uuid', u && u.user_uuid);
  } catch (e) {
    if (e && e.status) { msg.statusCode = e.status; msg.payload = { message: 'device not found' }; return [null, msg]; }
    throw e;
  } finally {
    try { await new Promise((res) => dbS.close(() => res())); } catch (e2) {
      node.warn('valve scope db close failed: ' + (e2 && e2.message ? e2.message : e2));
    }
  }
}
```

- [ ] **Step 2: Re-assert inside the enqueue write step + originator**

In the node that performs the command-enqueue write (the shared SQLite write step), inside the same function that builds `applied_commands`/queue rows:

```js
// Re-assert immediately before the physical-effect write (spec §8 TOCTOU rule).
const actorUuid = flow.get('actor_user_uuid') || null;
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1' && actorUuid) {
  const load = osiLib.require('scope');
  if (!load.ok) throw new Error('scope module unavailable at enqueue: ' + load.error);
  await load.value.assertFreshDeviceAccess(db, actorUuid, deveui, { scopedMode: true });
}
// Originator attribution (all modes, spec §9):
// - user-originated: actor uuid; scheduler-originated: existing scheduler marker.
```

`applied_commands.originator` is set to `actorUuid` when present, otherwise the existing scheduler/system marker. Scheduler-originated rows carry no `actor_user_uuid` in flow context — the marker is set only inside the REST chains above, and scheduler nodes run in their own context, so origin cannot be forged via request metadata (spec §8).

- [ ] **Step 3: Crafted-request tests**

Extend `scripts/test-scoped-access-writes.js` (new file, same harness):

```js
test('W1: researcher actuates own valve; foreign valve 404; disabled account 403; originator recorded', async () => {
  // res1 -> VALVE1 (z-1 grant): chain proceeds past scope; originator 'u-res1'
  // res1 -> foreign device: 404 before any enqueue
  // disabled res1: 403
  // scheduler path (no actor in flow context): scheduler marker, no user check
});
```

- [ ] **Step 4: Allowances + checklist + commit**

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): fresh scope checks + originator on valve actuation"
```

---

## Task C3: W2 + scheduler authority

**Files:**
- Modify: both `flows.json` profiles: schedule PUT chain, disable-all chain, the scheduler nodes (the DENDRO/threshold scheduler cluster — allowances reference `5f0d2b7e9b9b1b3a`; blast-radius first)

- [ ] **Step 1: Fresh zone check on schedule mutation**

Same insert pattern as C2 Step 1, with `resolveZoneUuidById` + `assertFreshZoneAccess` on the `:id` param. For `schedules/disable-all`: load the zone ids it would touch, fresh-check each, and restrict the UPDATE to zones in scope (admin: all).

- [ ] **Step 2: Scheduler execution-time authority check**

In each scheduler node's actuation path, before building a downlink for a zone's schedule:

```js
// Scheduler authority (spec §8): the zone must retain at least one enabled
// account in scope (owners UNION grantees), else disable + flag.
const zoneRow = await q('SELECT zone_uuid, user_id FROM irrigation_zones WHERE id = ? AND deleted_at IS NULL', [zoneId]);
const scopeHolders = await q(
  `SELECT DISTINCT u.id, u.disabled_at FROM users u
    WHERE u.disabled_at IS NULL AND (
      u.id = ?
      OR u.user_uuid IN (SELECT user_uuid FROM user_zone_assignments
                          WHERE zone_uuid = ? AND deleted_at IS NULL)
    )`,
  [zoneRow.user_id, zoneRow.zone_uuid]
);
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1' && scopeHolders.length === 0) {
  await run('UPDATE irrigation_schedules SET enabled = 0 WHERE irrigation_zone_id = ?', [zoneId]);
  node.warn('scheduler: zone ' + zoneId + ' lost all enabled scope holders; schedule disabled pending admin review');
  return null;
}
```

`enabled` clears only when the enabled-scope set is empty (spec §8 policy: collective zone infrastructure, flagged for admin re-confirmation — the GUI surfaces the disabled schedule with the warning reason in Phase D).

- [ ] **Step 3: Tests**

```js
test('C3: schedule mutation fresh-checked; execution disables schedule when scope set empties', async () => {
  // res1 PUT schedule on z-1: ok; on z-2: 404.
  // Seed schedule on z-1, revoke the only grant and de-owner the zone: scheduler run clears enabled.
  // With one enabled grantee remaining: schedule still fires.
});
```

- [ ] **Step 4: Allowances + checklist + commit**

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): scoped schedule mutation + scheduler execution authority"
```

---

## Task C4: W3 — zone lifecycle (R1 create, R3/R4 delete)

**Files:**
- Modify: both `flows.json` profiles: `POST /api/irrigation-zones` chain, `DELETE /api/irrigation-zones/:id` chain
- Modify: `scripts/test-scoped-access-writes.js`

- [ ] **Step 1: R1 — create with auto-grant in one transaction**

Replace the zone INSERT in the create chain (scoped mode only; legacy path untouched):

```js
// R1: zone creation auto-grants the creator in the same write.
const zoneUuid = lowerHexRandom(16); // use the node's existing uuid source if present
await run(
  'INSERT INTO irrigation_zones (name, user_id, zone_uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  [name, creatorId, zoneUuid, now, now]
);
await run(
  `INSERT INTO user_zone_assignments (assignment_uuid, user_uuid, zone_uuid, assigned_by_user_uuid, created_at)
   VALUES (?, ?, ?, ?, ?)`,
  [lowerHexRandom(16), creatorUuid, zoneUuid, creatorUuid, now]
);
scopeLib.invalidateScope(creatorUuid);
```

Both inserts run back-to-back on the serialized queue with no interleaving user operation between them (same node's await sequence); the grant insert must use the creator's own uuid for `assigned_by_user_uuid`. Emit no extra outbox rows — the existing zone trigger plus the Phase A grant trigger (emit-gated) cover sync.

- [ ] **Step 2: R3/R4 — guarded delete transaction**

```js
// R3: researcher deletes only when sole active grantee; admin always may.
const zone = await q('SELECT id, zone_uuid, user_id FROM irrigation_zones WHERE id = ? AND deleted_at IS NULL', [zoneId]);
if (!zone.length) { msg.statusCode = 404; msg.payload = { message: 'zone not found' }; return [null, msg]; }
const zu = zone[0].zone_uuid;
if (!isAdminScope) {
  const grantees = await q('SELECT user_uuid FROM user_zone_assignments WHERE zone_uuid = ? AND deleted_at IS NULL', [zu]);
  const sole = grantees.length === 1 && grantees[0].user_uuid === actorUuid;
  const ownsIt = zone[0].user_id === actorIntId && grantees.length === 0;
  if (!sole && !ownsIt) { msg.statusCode = 409; msg.payload = { message: 'zone has other scope holders; admin required' }; return [null, msg]; }
}
// R4 + grant tombstones + zone tombstone in one transaction:
await run('BEGIN IMMEDIATE');
try {
  await run(`UPDATE journal_plots SET zone_uuid = NULL, sync_version = sync_version + 1, updated_at = ? WHERE zone_uuid = ?`, [now, zu]);
  await run(`UPDATE user_zone_assignments SET deleted_at = ?, sync_version = sync_version + 1 WHERE zone_uuid = ? AND deleted_at IS NULL`, [now, zu]);
  await run('UPDATE irrigation_zones SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, zoneId]);
  await run('COMMIT');
} catch (e) {
  await run('ROLLBACK');
  throw e;
}
```

Plots keep their owner and entries; only the zone link nulls, with `sync_version` bumped so the journal outbox triggers (Phase A pattern) emit the correction when enabled.

- [ ] **Step 3: Tests**

R1 (creator immediately sees own zone), R3 sole-grantee delete succeeds, multi-grantee delete 409 for researcher / succeeds for admin, R4 plots survive with nulled zone_uuid, grants tombstoned.

- [ ] **Step 4: Allowances + checklist + commit**

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): scoped zone create/delete lifecycle (R1, R3, R4)"
```

---

## Task C5: W4 — provisioning (R2, R5)

**Files:**
- Modify: both `flows.json` profiles: `POST /api/devices`, `PUT /api/devices/:deveui/zone-assignments`, `PUT /api/irrigation-zones/:id/devices/:deveui`, `DELETE /api/devices/:deveui`, `DELETE /api/irrigation-zones/:id/devices/:deveui`

- [ ] **Step 1: R2 — claim terminates in scope**

In the device-claim chain (scoped mode): the request must carry a target zone; resolve it, fresh-check it, and reject without one:

```js
const targetZoneId = Number(msg.payload && msg.payload.irrigation_zone_id);
if (!Number.isInteger(targetZoneId)) { msg.statusCode = 400; msg.payload = { message: 'irrigation_zone_id is required in scoped mode' }; return [null, msg]; }
const zu = await load.value.resolveZoneUuidById(dbS, targetZoneId);
if (!zu) { msg.statusCode = 404; msg.payload = { message: 'zone not found' }; return [null, msg]; }
await load.value.assertFreshZoneAccess(dbS, actorUuid, zu, { scopedMode: true });
```

Admin may claim without a zone (matrix row "claim device without zone assignment").

- [ ] **Step 2: R5 — no foreign enumeration on claim/assign**

Before any claim or reassignment of an existing deveui: look up the device's current zone; if it belongs to a zone outside the actor's scope (and actor is not admin), return the same 404 as a nonexistent device — never 403 and never a "already claimed elsewhere" variant. Apply to both assignment endpoints; device delete and zone-device removal get `assertFreshDeviceAccess`.

- [ ] **Step 3: Tests**

Claim without zone 400 (researcher) / ok (admin); claim into foreign zone 404; re-claim of a device in a foreign zone 404 indistinguishable from unknown; assign/remove paths scoped.

- [ ] **Step 4: Allowances + checklist + commit**

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): scoped device provisioning (R2, R5)"
```

---

## Task C6: W5 — device config writes

Apply the C2 Step 1 `assertFreshDeviceAccess` insertion to the 15 `PUT /api/devices/:deveui/*` config endpoints and the 3 POST config endpoints (`dendro-baseline/reset`, `kiwi/temperature-humidity/enable`, `chameleon/refresh-calibration`), one mutation script, each node's growth measured into allowances with a single reason entry per node family (`AgroLink Phase C: fresh device-config scope checks`). Behavioral test per endpoint: in-scope researcher ok, foreign 404, viewer 404 (viewers hold no write; their scope check passes only reads — write endpoints additionally reject `role='viewer'` with 403 via `assertFreshRole(dbS, actorUuid, 'researcher')` OR-ed admin; implement as: fresh scope object, then `if (scope.role === 'viewer') 403`).

```bash
node --test scripts/test-scoped-access-writes.js
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): fresh scope checks on device config writes"
```

---

## Task C7: W6 — journal writes

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js` (+ mirror), colocated tests

Extend the principal resolution in `osi-journal`: in scoped mode, write functions (`createEntry`, `updateEntry`, `voidEntry`, `createPlot`, `updatePlot`, plot-groups, custom-vocab) resolve the target plot and assert scope via the union rule before mutation:

```js
async function assertPlotWrite(db, principal, plotUuid, opts) {
  if (!(opts && opts.scoped)) return; // legacy path unchanged
  const row = await dbAll(db,
    'SELECT 1 AS ok FROM journal_plots WHERE plot_uuid = ? AND deleted_at IS NULL AND (' +
      'owner_user_uuid = ? OR plot_uuid IN (' +
        'SELECT plot_uuid FROM user_plot_assignments WHERE user_uuid = ? AND deleted_at IS NULL))',
    [plotUuid, principal.owner_user_uuid, principal.owner_user_uuid]);
  if (!row.length) { const e = new Error('plot not found'); e.status = 404; throw e; }
}
```

`createPlot` sets `owner_user_uuid` to the creator (R6, shipped behavior) and additionally requires zone scope when a `zone_uuid` is supplied (plots attach only to zones the creator can see). Viewers cannot write: the journal router rejects `role='viewer'` on mutation endpoints with 403.

Tests: owner write ok; grantee write ok; foreign 404; viewer 403; void follows the same rule; flag off byte-identical.

```bash
git add conf/ scripts/
git commit -m "feat(journal): scoped writes under the union rule"
```

---

## Task C8: W7 + W8 — zone config writes and the admin account/grant API

**Files:**
- Modify: both `flows.json` profiles (zone config chains; **new** thin nodes for the account/grant API)
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

- [ ] **Step 1: W7 — zone config/location/timezone/calibration**

C2 Step 1 pattern with `assertFreshZoneAccess`; originator `flow.set('actor_user_uuid', ...)` recorded on the zone-config write path (§9).

- [ ] **Step 2: W8 — new admin endpoints (thin nodes, osiLib-loaded)**

New endpoints, each: `http in` → auth (copied block) → thin function → `http response`. All functions call `assertFreshRole(dbS, actorUuid, 'admin', { scopedMode: true })` first, then:

| Endpoint | Action (all single writes on the queue) |
|---|---|
| `GET /api/users` | `SELECT username, user_uuid, role, disabled_at, created_at FROM users ORDER BY username` (no hashes) |
| `POST /api/users` | insert with `role` in {researcher,viewer,admin}, bcrypt hash via the register chain's `bcryptjs` pattern; admin-created accounts never hit the public bootstrap path |
| `POST /api/users/:uuid/password-reset` | set admin-chosen temporary `password_hash`; respond `{ success: true }` (no email flow) |
| `PUT /api/users/:uuid/role` | guard: `buildDeriveUserGuardedSql()` when demoting an admin; 409 on 0 rows |
| `PUT /api/users/:uuid/disabled` | `{disabled:true}` → `buildDisableUserGuardedSql()`, 409 on 0 rows; `{disabled:false}` → plain clear |
| `POST /api/grants/zone` | validate user + zone exist; insert grant (`assignment_uuid` fresh hex), `assigned_by_user_uuid` = actor; `invalidateScope(targetUuid)` |
| `DELETE /api/grants/zone/:assignmentUuid` | tombstone (`deleted_at`, `sync_version+1`); invalidate target scope |
| `POST /api/grants/plot`, `DELETE /api/grants/plot/:assignmentUuid` | same shape for plots |

The role/disable/grant mutations also bump the scope epoch via `invalidateScope(targetUuid)`; disable additionally triggers the C3 scope-empty evaluation lazily at scheduler execution (no eager schedule walk).

- [ ] **Step 3: Tests**

Admin CRUD round-trip; non-admin 403 on every endpoint; last-admin disable 409; two-admins-disable-each-other serialized race leaves ≥1 enabled admin (run both writes through the queue and assert the guarded UPDATE's 0-row path); grant insert/tombstone visible in next `resolveScope`; user list contains no `password_hash`.

- [ ] **Step 4: Allowances + checklist + commit**

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): admin account + grant management endpoints (W8), scoped zone config (W7)"
```

---

## Task C9: W9 — admin system writes

Insert `assertFreshRole(..., 'admin', ...)` after auth in: `POST /api/sync/force`, `POST /api/system/reboot`, `POST /api/system/fan`, `POST /api/account-link`, `DELETE /api/account-link`, `POST /api/history/rollups/run`. Researcher/viewer → 403; disabled admin → 403; flag off → unchanged. One mutation script, allowances measured, checklist, commit:

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/
git commit -m "feat(api): admin-only guard on system and sync writes"
```

---

## Task C10: Phase C gate

- [ ] **Step 1: Full sweep**

```bash
node --test scripts/test-scoped-access-writes.js
node --test scripts/test-scoped-access-reads.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
node scripts/verify-scoped-access.js
node scripts/verify-sync-flow.js
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-profile-parity.js
node scripts/verify-runtime-schema-parity.js
scripts/check-mqtt-topics.sh
```
All exit 0.

- [ ] **Step 2: Acceptance against spec §15 Phase C gate**

- Crafted-request tests green across W1–W9: admin/researcher/viewer/disabled × own/foreign × flag on/off.
- `applied_commands.originator` populated on user-originated actuation and zone config (assert in W1/W7 tests).
- Revocation immediate on actuation: disable account, same-request actuation returns 403 with no cache involvement (W1 test).
- Scheduler authority: scope-empty zone's schedule disables at execution; sole remaining grantee keeps it firing (C3 test).
- Phase F fixture regeneration: rerun the producer-fixture generation from `2026-07-15-cross-repo-sync-contract-ci.md` if it has landed by then; record the delta (scoped claim graph) in the execution report.

## Notes for the executor

- Every scope-check insert preserves exactly-one-response per path; the 404 payload shape stays uniform (`{ message: 'zone not found' }` / `'device not found'`) so R5 cannot be fingerprinted.
- `actor_user_uuid` is set only inside authenticated REST chains; scheduler and sync-originated executions never set it — that is the unforgeable-origin property; do not add a request-controlled override.
- Guarded admin SQL returns row counts via the facade's statement context where available; where the facade hides `changes`, confirm via the follow-up SELECT pattern from Phase A Task 10 (same reasoning: single conditional write decides, SELECT only shapes the message).
- Deviations from this plan (node ids, auth-stash variants) go in the execution report with the blast-radius output, not in silent adaptations.
