# Issue 470: reference-tree ownership and valve-router client lifetime

Resolve both current findings in [osi-os #470](https://github.com/Open-Smart-Irrigation/osi-os/issues/470): reject flag-off reference-tree writes by other accounts, and allocate a valve-router ChirpStack client only for an authenticated queue flush, then close it after that work settles.

Status: amended after the first independent review rejected execution; a fresh adversarial review is required. This commit contains the plan only. The campaign coordinator assigns a separate reviewer, executor and verifier. This plan's author does not approve its implementation.

## Scope and verified base

Base: `63c7a70f8f3b373f162b33b0669b0df89b3763fa`, fetched from `origin/main` on 2026-10-25. The design worktree was clean on `t3/issue-470-plan` before fast-forwarding from the stale local commit. The root checkout was not switched or edited.

Read the current `AGENTS.md`, `docs/engineering-playbook.md`, and the `osi-flows-json-editing`, `osi-common-pitfalls`, `osi-verification-commands`, `osi-sync-contract-awareness`, `osi-config-and-flags` and `anti-slop-writing` skills before execution. Use subscription capacity only. No children, SSH, live access, deployments, merges or release publication. The campaign ends 2026-11-01 at 23:59 Europe/Zurich. The coordinator may publish a reviewed draft PR after independent verification; this design stage does not push or create a PR.

At initial design, both issues were open with zero comments. At amendment, #470 has one triage comment and `priority:P1`; that comment confirms the two primary defects but does not settle the sibling claims. The GitHub connector also confirms #451 is open with zero comments. The flag-off open-registration rationale is stale: `auth-db-insert` already permits only first-account bootstrap. Existing additional accounts still expose the missing ownership predicate.

[Issue #465](https://github.com/Open-Smart-Irrigation/osi-os/issues/465) lists ten client-lifetime callers. This plan resolves its overlapping `valve-api-router-fn` instance only. Leave #465 open for its remaining callers; a later PR must say “partially addresses #465”, never “fixes #465”. The sibling claims in #470 have the explicit current-base dispositions below; their grant-parity work stays outside the two-node implementation. No cloud companion or schema migration is required: neither fix changes a sync resource, payload or command.

### Sibling-claim dispositions at the reviewed base

The original #470 body also names Chameleon refresh/depth and WATERMARK calibration. Each claim has a disposition; none warrants another flag-off ownership patch.

- `POST /api/devices/:deveui/chameleon/refresh-calibration`: flag-off ownership is already enforced by the `chameleon-refresh-query` node in canonical `flows.json`. Its latest-array SELECT joins `devices`, binds `d.user_id = ?` to `msg._authUser.userId` and excludes deleted devices. The owner reaches the array-ID continuation. A foreign account gets 404 `no_array_id_seen`, even with an actual array reading in the fixture.
- `PUT /api/devices/:deveui/chameleon/depth`: flag-off ownership is already enforced by `chameleon-depth-save`. Its transaction binds `user_id = ?`, checks the affected-row count and returns 404 `Device not found` on refusal. A foreign request changes neither depth nor `sync_version`; the owner saves successfully and increments once.
- WATERMARK calibration: the flag-off owner filter is already present in `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/calibration.js`. `assertAccessibleLsn50` adds a bound `user_id` predicate only when `scoped` is false; `saveCalibrationTx` and `deleteCalibrationTx` recheck it inside the transaction. `watermark-cal-fn` supplies the authenticated identity and flag. The existing `scripts/test-watermark-calibration-routes.js` tests foreign flag-off PUT/DELETE/GET refusals without mutation and scoped granted-user write success. Its 28 cases pass on this base. No new filter is needed.

A separate Chameleon grant defect remains current. Both refresh and depth handlers apply their owner predicates in scoped mode too: a researcher granted the foreign device's zone passes `scoped-device-config-guard` and auth, then gets 404 downstream. An owner succeeds in either flag state; an out-of-scope admin gets 404 at the scoped guard. An independent amendment probe exercised 24 actual guard → auth → handler scenarios across both maintained profiles, with a real array-reading fixture and depth/version assertions. Refresh probing ended at the array-ID continuation and never entered its network-fetch stage. This is route evidence, rather than a SQL-only demonstration or guard-only coverage.

Associate these refresh/depth instances with existing [#451](https://github.com/Open-Smart-Irrigation/osi-os/issues/451), “Scoped access: valve open, STREGA timed actions and Chameleon refuse a granted member on the gateway's own screens”. Its current body names the Chameleon enable handler alongside valve/STREGA handlers; refresh/depth are additional verified instances of that same owner-only downstream handler class. Keep their owner/granted/denied route tests in both flag states with that existing grant-parity work. Do not create a duplicate follow-up or widen this plan's two-node patch. This amendment records the association; it does not claim a GitHub comment or issue edit was posted.

The reference-tree defect and valve-router leak remain the only runtime edits here. #470 stays open pending final issue-wide acceptance review, including the retained Chameleon grant behavior. The proposed PR wording is exactly “Partially addresses #470; partially addresses #465; related #451”. Use no auto-closing wording for any of these issues.

### Route evidence

The PUT HTTP node `dendro-ref-tree-http` feeds `scoped-device-config-guard`; guard output index 2 feeds `dendro-ref-tree-fn`, which feeds `dendro-http-resp`. Flag off, the guard forwards without loading the scope helper. The handler verifies the bearer but discards its return value; both its SELECT and UPDATE filter only by EUI.

An in-process probe executed those actual guard and handler bodies, using the shipped seed, the scoped-access harness and a synthetic signed token. Caller 1 changed `DENDRO1`, owned by user 2: status 200, `is_reference_tree=1`, `sync_version=2`. This establishes the full function-node route behavior beyond the finder's SQL reproduction. It does not exercise an HTTP listener.

All eight `/api/valves*` HTTP nodes feed `valve-api-router-fn`. A second probe executed that actual router and the real `osi-valve-control` API helper with a fake ChirpStack factory. With no bearer, the response was 401, the factory ran once and close ran zero times. Bind `'osi-valve-control': VC` explicitly in this harness: its generic module resolver otherwise looks for a nonexistent doubled prefix and answers 503 before authentication.

The helper's `api.js` verifies the session before opening its DB or reaching `push.compileAndQueue`. `push.js` awaits `flushQueue` inside `queueSnapshot`; a rejected flush warns and continues its existing best-effort snapshot behavior. The router promise therefore covers the last flush. `ChirpStackClient.close()` is already shipped (PR #473); it synchronously closes five services and returns an array of close errors. No helper API change is needed.

Scoped access uses fresh role and device scope from the existing guard. It allows a researcher assigned to a zone even when that researcher does not own the device. An admin also needs zone ownership or a grant on this route; admin role alone is not a device-scope wildcard. Preserve these rules, including the denial of an unassigned reference-tree device. Do not add the soil-route `allowUnassignedOwner` exception here.

## Execution order

Run from the executor's isolated worktree root, retaining the plan commit. Inspect `pwd`, `git status --short --branch`, `git worktree list --porcelain`, `git rev-parse HEAD` and `git rev-parse origin/main`. Stop on unexpected modifications, divergence, changes to either target node since the reviewed base, or a moving base that requires replanning. Do not use the root checkout. Re-read the two current issue discussions before implementing and stop if another PR now owns this work.

Before each test or build inspect the campaign `pressure.json`, `/proc/meminfo` and swap usage. Start only at 8 GiB available or higher; after a memory hold resume at 10 GiB. Every test and verifier below goes through the campaign wrapper. Define this shell function once:

```bash
heavy() { python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py "$@"; }
export OSI_FLOWS_SIZE_BASE_REF=63c7a70f8f3b373f162b33b0669b0df89b3763fa
export OSI_DDL_BASE_REF=63c7a70f8f3b373f162b33b0669b0df89b3763fa
export OSI_MIGRATIONS_BASE_REF=63c7a70f8f3b373f162b33b0669b0df89b3763fa
export OSI_IDENTITY_BASE_REF=63c7a70f8f3b373f162b33b0669b0df89b3763fa
mkdir -p /tmp/osi-470-design
```

Keep the four base variables together until rebasing and re-review. Stop and report any unexpected gate failure, including red-on-base. Expected regression failures in step 1 are the explicit exception.

### 1. Commit the failing behavioral tests

Create `scripts/test-reference-tree-and-valve-router.js` with the complete source below. The tests run shipped flow text through real auth and SQLite. They exercise the guard before the reference-tree handler, check response wiring, and run the real valve API for route cases. The cleanup fault-injection cases and the synchronous-API/mapping/repeated-flush cases substitute that API to force router-only branches. The synchronous flush failure still runs the real API. ChirpStack is always fake; configured test secrets prevent credential-file reads.

The mirror's function bodies run separately. The unchanged helper bindings use canonical modules; profile parity proves the helper copies agree. These tests do not measure network channel counts or prove the issue's claimed 30-minute idle duration.

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = process.cwd();
const H = require(path.join(ROOT, 'scripts/lib/scoped-access-harness'));
const MODULES = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const scope = require(path.join(MODULES, 'osi-scope-helper'));
const VC = require(path.join(MODULES, 'osi-valve-control'));
const SECRET = 'scoped-access-test-secret';
const EUI = 'A840410000000001';
const UUID = '00000000-0000-4000-8000-000000000001';
const profiles = ['bcm2712', 'bcm2709'];
function bearer(userId = 2, username = 'res1', extra = {}) {
  return H.makeAuthHeader({ userId, username, secret: SECRET, ...extra });
}
function request(method, url, authorization = bearer(), body = {}) {
  return { req: { method, path: url, params: { deveui: url.split('/')[3] },
    headers: authorization ? { authorization } : {}, body }, payload: body };
}
function row(db, eui = 'DENDRO1') {
  return { ...db.prepare('SELECT user_id, is_reference_tree, sync_version FROM devices WHERE deveui=?').get(eui) };
}
for (const profile of profiles) {
  const flowsPath = path.join(process.env.OSI_470_FLOWS_ROOT || ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
  const load = id => H.loadNode(id, flowsPath);
  async function reference(db, { flag = '0', eui = 'DENDRO1', userId = 2, username = 'res1', auth = bearer(userId, username), value = 1, libOverrides = {} } = {}) {
    scope._resetForTests();
    assert.deepEqual(load('dendro-ref-tree-http').wires, [['scoped-device-config-guard']]);
    const guard = load('scoped-device-config-guard');
    assert.deepEqual(guard.wires[2], ['dendro-ref-tree-fn']);
    assert.deepEqual(load('dendro-ref-tree-fn').wires, [['dendro-http-resp']]);
    assert.equal(load('dendro-http-resp').type, 'http response');
    const msg = request('PUT', `/api/devices/${eui}/reference-tree`, auth, { is_reference_tree: value });
    const env = { OSI_SCOPED_ACCESS: flag, AUTH_TOKEN_SECRET: SECRET };
    const guarded = await H.executeFunction(guard, { db, msg, env });
    assert.equal(guarded.result.filter(Boolean).length, 1, 'one routed response or continuation');
    if (!guarded.result[2]) return guarded.result[guard.wires.length - 1];
    return (await H.executeFunction(load('dendro-ref-tree-fn'), { db, msg: guarded.result[2], env, libOverrides })).result;
  }
  test(`${profile}: flag-off owner toggles reference tree and increments version once per write`, async () => {
    const db = H.seedScopedDb();
    try {
      const before = row(db);
      for (const [value, increment] of [[1, 1], [0, 2]]) {
        const out = await reference(db, { eui: 'dendro1', value });
        assert.equal(out.statusCode, 200);
        assert.deepEqual(out.payload, { success: true, deveui: 'DENDRO1', is_reference_tree: value });
        assert.deepEqual(row(db), { ...before, is_reference_tree: value, sync_version: before.sync_version + increment });
      }
    } finally { db.close(); }
  });
  test(`${profile}: flag-off foreign, unclaimed and missing device return identical 404 without mutation`, async () => {
    const db = H.seedScopedDb();
    try {
      const before = row(db);
      const foreign = await reference(db, { userId: 1, username: 'admin1' });
      assert.equal(foreign.statusCode, 404);
      assert.deepEqual(row(db), before);
      const absent = await reference(db, { eui: 'ABSENT', userId: 1, username: 'admin1' });
      assert.deepEqual([foreign.statusCode, foreign.payload, foreign.headers], [absent.statusCode, absent.payload, absent.headers]);
      assert.deepEqual(foreign.payload, { error: 'Device not found' });
      db.exec("UPDATE devices SET user_id=NULL WHERE deveui='DENDRO1'");
      const unclaimedBefore = row(db);
      const unclaimed = await reference(db);
      assert.equal(unclaimed.statusCode, 404);
      assert.deepEqual(unclaimed.payload, absent.payload);
      assert.deepEqual(row(db), unclaimedBefore);
    } finally { db.close(); }
  });
  for (const [name, auth] of [['missing', null], ['malformed', 'Bearer x'],
    ['expired', bearer(2, 'res1', { expiresAt: Date.now() - 10000 })],
    ['wrong signature', bearer(2, 'res1', { secret: 'wrong-test-secret' })]]) {
    for (const flag of ['0', '1']) test(`${profile}: reference flag=${flag} rejects ${name} session`, async () => {
      const db = H.seedScopedDb();
      try { const before = row(db); assert.equal((await reference(db, { flag, auth })).statusCode, 401); assert.deepEqual(row(db), before); }
      finally { db.close(); }
    });
  }
  test(`${profile}: scoped assigned non-owner and admin retain access`, async () => {
    const db = H.seedScopedDb();
    try {
      const before = row(db, 'DENDRO2');
      assert.equal((await reference(db, { flag: '1', eui: 'DENDRO2' })).statusCode, 200);
      assert.deepEqual(row(db, 'DENDRO2'), { ...before, is_reference_tree: 1, sync_version: before.sync_version + 1 });
      assert.equal((await reference(db, { flag: '1', eui: 'DENDRO2', userId: 1, username: 'admin1' })).statusCode, 200);
    } finally { db.close(); }
  });
  for (const [name, setup, options, status] of [
    ['out-of-scope admin', () => {}, { userId: 1, username: 'admin1' }, 404],
    ['viewer', () => {}, { userId: 3, username: 'view1' }, 403],
    ['disabled', db => db.exec("UPDATE users SET disabled_at='2026-01-02' WHERE id=2"), {}, 403],
    ['revoked assignment', db => db.exec("DELETE FROM user_zone_assignments WHERE user_uuid='u-res1' AND zone_uuid='z-2'"), { eui: 'DENDRO2' }, 404],
    ['unassigned owner', db => db.exec("UPDATE devices SET irrigation_zone_id=NULL WHERE deveui='DENDRO1'"), {}, 404],
  ]) test(`${profile}: scoped ${name} is denied`, async () => {
    const db = H.seedScopedDb();
    try { setup(db); const before = row(db, options.eui); assert.equal((await reference(db, { flag: '1', ...options })).statusCode, status); assert.deepEqual(row(db, options.eui), before); }
    finally { db.close(); }
  });
  test(`${profile}: flag-off write rechecks ownership after the read`, async () => {
    const db = H.seedScopedDb();
    let closes = 0;
    try {
      const before = row(db);
      const facade = H.facadeDb(db);
      const run = facade.run;
      facade.run = (sql, params, callback) => {
        if (/UPDATE devices SET is_reference_tree/.test(sql)) db.exec("UPDATE devices SET user_id=1 WHERE deveui='DENDRO1'");
        return run(sql, params, callback);
      };
      facade.close = callback => { closes++; callback(); };
      const out = await reference(db, { libOverrides: { osiDb: { Database: function () { return facade; } } } });
      assert.equal(out.statusCode, 404);
      assert.deepEqual(row(db), { ...before, user_id: 1 });
      assert.equal(closes, 1);
    } finally { db.close(); }
  });
  test(`${profile}: flag-off reference route never loads the scope helper`, async () => {
    const db = H.seedScopedDb();
    try {
      const out = await reference(db, { libOverrides: { osiLib: { require() { throw new Error('flag-off scope dependency'); } } } });
      assert.equal(out.statusCode, 200);
    } finally { db.close(); }
  });
  async function valve(db, msg, chirpstack, vc = VC) {
    assert.deepEqual(load('valve-api-router-fn').wires, [['valve-api-response'], ['valve-push-mqtt-out']]);
    return H.executeFunction(load('valve-api-router-fn'), { db, msg,
      env: { AUTH_TOKEN_SECRET: SECRET, CHIRPSTACK_APP_ACTUATORS: 'fixture-app' },
      osiLibModules: { 'osi-valve-control': vc }, libOverrides: { chirpstack } });
  }
  const routes = [['GET', '/api/valves'], ['GET', `/api/valves/${EUI}/schedules`],
    ['POST', `/api/valves/${EUI}/schedules`], ['PUT', `/api/valves/${EUI}/schedules/${UUID}`],
    ['DELETE', `/api/valves/${EUI}/schedules/${UUID}`], ['POST', `/api/valves/${EUI}/plan/resend`],
    ['POST', `/api/valves/${EUI}/scheduler-status`], ['PUT', `/api/valves/${EUI}/settings`]];
  test(`${profile}: all eight valve routes reject invalid sessions without allocating a client or DB`, async () => {
    const db = H.seedScopedDb();
    try {
      const incoming = JSON.parse(require('node:fs').readFileSync(flowsPath, 'utf8')).filter(n => n.type === 'http in' && n.wires.flat().includes('valve-api-router-fn'));
      assert.equal(incoming.length, 8);
      const actualRoutes = incoming.map(n => [n.method.toUpperCase(), n.url.replace(':deveui', EUI).replace(':uuid', UUID)]);
      assert.deepEqual(actualRoutes.map(pair => JSON.stringify(pair)).sort(), routes.map(pair => JSON.stringify(pair)).sort());
      let creates = 0, opens = 0;
      const dbHelper = { Database: function () { opens++; throw new Error('unauthorized DB open'); } };
      for (const [method, url] of routes) for (const auth of [null, 'Bearer x', bearer(2, 'res1', { expiresAt: Date.now() - 10000 }), bearer(2, 'res1', { secret: 'wrong-test-secret' })]) {
        const out = await H.executeFunction(load('valve-api-router-fn'), { db, msg: request(method, url, auth), env: { AUTH_TOKEN_SECRET: SECRET },
          osiLibModules: { 'osi-db-helper': dbHelper, 'osi-valve-control': VC },
          libOverrides: { chirpstack: { createProvisioningClientFromEnv() { creates++; return { close: () => [] }; } } } });
        assert.equal(out.result[0].statusCode, 401);
        assert.deepEqual(out.result[1], []);
      }
      assert.equal(opens, 0); assert.equal(creates, 0);
    } finally { db.close(); }
  });
  test(`${profile}: authenticated valve read and ownership rejection need no client`, async () => {
    const db = H.seedScopedDb();
    try {
      db.prepare("UPDATE devices SET deveui=? WHERE deveui='VALVE1'").run(EUI);
      let creates = 0;
      const cs = { createProvisioningClientFromEnv() { creates++; throw new Error('must remain lazy'); } };
      assert.equal((await valve(db, request('GET', '/api/valves'), cs)).result[0].statusCode, 200);
      assert.equal((await valve(db, request('POST', `/api/valves/${EUI}/plan/resend`, bearer(1, 'admin1')), cs)).result[0].statusCode, 403);
      assert.equal(creates, 0);
    } finally { db.close(); }
  });
  for (const rejectFlush of [false, true]) test(`${profile}: close waits for actual async queue flush (reject=${rejectFlush})`, async () => {
    const db = H.seedScopedDb();
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    const pending = new Promise((resolve, reject) => { release = () => rejectFlush ? reject(new Error('fixture flush failed')) : resolve(); });
    const events = [];
    let creates = 0, closes = 0;
    try {
      db.prepare("UPDATE devices SET deveui=? WHERE deveui='VALVE1'").run(EUI);
      const cs = { createProvisioningClientFromEnv() { creates++; events.push('create'); return {
        async flushDeviceQueue(eui) { assert.equal(eui, EUI); events.push('flush-start'); started(); try { await pending; } finally { events.push('flush-settled'); } },
        close() { closes++; events.push('close'); return []; }
      }; } };
      const operation = valve(db, request('POST', `/api/valves/${EUI}/plan/resend`), cs);
      await Promise.race([entered, operation.then(() => { throw new Error('API settled before entering flush'); })]);
      assert.equal(closes, 0, 'do not close a pending RPC');
      release();
      const out = await operation;
      assert.equal(out.result[0].statusCode, 202, 'flush failure keeps existing best-effort API behavior');
      assert.equal(creates, 1); assert.equal(closes, 1);
      assert.deepEqual(events, ['create', 'flush-start', 'flush-settled', 'close']);
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n > 0);
      if (rejectFlush) assert.ok(out.warnings.some(w => w.includes('queue flush failed')));
    } finally { release(); db.close(); }
  });
  test(`${profile}: factory failure preserves best-effort pushes and warns`, async () => {
    const db = H.seedScopedDb();
    try {
      db.prepare("UPDATE devices SET deveui=? WHERE deveui='VALVE1'").run(EUI);
      let creates = 0;
      const out = await valve(db, request('POST', `/api/valves/${EUI}/plan/resend`), { createProvisioningClientFromEnv() { creates++; throw new Error('fixture unavailable'); } });
      assert.equal(out.result[0].statusCode, 202); assert.equal(creates, 1);
      assert.ok(out.warnings.some(w => w.includes('client unavailable')));
    } finally { db.close(); }
  });
  for (const mode of ['returned-errors', 'throw', 'api-rejection']) test(`${profile}: cleanup handles ${mode} without replacing the response`, async () => {
    const db = H.seedScopedDb();
    let closes = 0;
    try {
      // Only this fault-injection test substitutes the API; all route tests above use VC.
      const vc = { async handleHttpRequest(options) {
        await options.flushQueue(EUI);
        if (mode === 'api-rejection') throw new Error('fixture API rejection');
        return Object.assign(options.msg, { statusCode: 202, payload: { ok: true }, valvePushMessages: [{ topic: 'fixture/topic', payload: { fPort: 21 } }] });
      } };
      const out = await valve(db, request('POST', `/api/valves/${EUI}/plan/resend`), { createProvisioningClientFromEnv() { return {
        flushDeviceQueue: async () => {}, close() { closes++; if (mode === 'throw') throw new Error('fixture close error'); return mode === 'returned-errors' ? [new Error('fixture close error')] : []; }
      }; } }, vc);
      assert.equal(closes, 1);
      assert.equal(out.result[0].statusCode, mode === 'api-rejection' ? 500 : 202);
      if (mode === 'api-rejection') assert.equal(out.result[1], null);
      else { assert.deepEqual(out.result[1], [{ topic: 'fixture/topic', payload: { fPort: 21 } }]); assert.ok(out.warnings.some(w => w.includes('client close failed'))); }
    } finally { db.close(); }
  });
  for (const fault of ['SELECT', 'UPDATE', 'close']) test(`${profile}: reference ${fault} exception closes once and preserves response semantics`, async () => {
    const db = H.seedScopedDb();
    let closes = 0;
    try {
      const before = row(db);
      const facade = H.facadeDb(db);
      if (fault === 'SELECT') facade.all = (...args) => args.at(-1)(new Error('fixture SELECT failure'));
      if (fault === 'UPDATE') facade.run = (...args) => args.at(-1)(new Error('fixture UPDATE failure'));
      facade.close = callback => { closes++; if (fault === 'close') throw new Error('fixture close failure'); callback(); };
      const out = await reference(db, { libOverrides: { osiDb: { Database: function () { return facade; } } } });
      assert.equal(out.statusCode, fault === 'close' ? 200 : 500);
      assert.equal(closes, 1);
      if (fault === 'close') assert.deepEqual(row(db), { ...before, is_reference_tree: 1, sync_version: before.sync_version + 1 });
      else { assert.deepEqual(row(db), before); assert.equal(out.payload.error, `fixture ${fault} failure`); }
    } finally { db.close(); }
  });
  test(`${profile}: real valve API catches synchronous flush failure and still closes`, async () => {
    const db = H.seedScopedDb();
    let creates = 0, closes = 0, flushes = 0;
    try {
      db.prepare("UPDATE devices SET deveui=? WHERE deveui='VALVE1'").run(EUI);
      const out = await valve(db, request('POST', `/api/valves/${EUI}/plan/resend`), { createProvisioningClientFromEnv() {
        creates++;
        return { flushDeviceQueue() { flushes++; throw new Error('fixture synchronous flush failure'); }, close() { closes++; return []; } };
      } });
      assert.equal(out.result[0].statusCode, 202);
      assert.deepEqual([creates, flushes, closes], [1, 1, 1]);
      assert.ok(out.warnings.some(w => w.includes('queue flush failed')));
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM valve_schedule_pushes').get().n > 0);
    } finally { db.close(); }
  });
  for (const fault of ['synchronous API throw', 'mapping failure', 'two flushes']) test(`${profile}: router handles ${fault}`, async () => {
    const db = H.seedScopedDb();
    const events = [];
    let creates = 0, closes = 0, flushes = 0;
    try {
      // These three cases deliberately substitute the API to reach router-only branches.
      const vc = { handleHttpRequest(options) {
        if (fault === 'synchronous API throw') throw new Error('fixture synchronous API failure');
        return (async () => {
          await options.flushQueue(EUI);
          if (fault === 'two flushes') await options.flushQueue(EUI);
          const out = Object.assign(options.msg, { statusCode: 202, payload: { ok: true } });
          if (fault === 'mapping failure') Object.defineProperty(out, 'valvePushMessages', { get() { throw new Error('fixture mapping failure'); } });
          return out;
        })();
      } };
      const out = await valve(db, request('POST', `/api/valves/${EUI}/plan/resend`), { createProvisioningClientFromEnv() {
        creates++; events.push('create');
        return { async flushDeviceQueue() { flushes++; events.push('flush'); }, close() { closes++; events.push('close'); return []; } };
      } }, vc);
      assert.equal(out.result[0].statusCode, fault === 'two flushes' ? 202 : 500);
      if (fault === 'synchronous API throw') assert.deepEqual([creates, flushes, closes], [0, 0, 0]);
      else {
        assert.deepEqual([creates, flushes, closes], [1, fault === 'two flushes' ? 2 : 1, 1]);
        assert.deepEqual(events, fault === 'two flushes' ? ['create', 'flush', 'flush', 'close'] : ['create', 'flush', 'close']);
      }
      if (fault !== 'two flushes') { assert.equal(out.result[1], null); assert.equal(out.result[0].payload.error, 'internal_error'); assert.equal(out.errors.length, 1); }
    } finally { db.close(); }
  });
}
```

Add this exact step immediately before `- name: Scoped-access endpoint ratchet` in `.github/workflows/verify-sync-flow.yml`:

```yaml
      - name: Reference-tree ownership and valve-router client lifetime
        run: node --test scripts/test-reference-tree-and-valve-router.js
```

Run:

```bash
heavy node --test scripts/test-reference-tree-and-valve-router.js
```

Expected regression result on the reviewed base: 66 tests, 38 pass, 28 fail, zero cancelled/skipped. Per profile, the foreign flag-off write and ownership-change cases return 200 instead of 404; the eight-route session matrix creates 32 clients instead of zero; the authenticated read/ownership rejection creates two instead of zero; the two deferred-flush cases and three cleanup fault cases close zero clients instead of one. The added reference close failure, synchronous API throw, synchronous flush failure, mapping failure and repeated-flush cases fail once per profile too. The SELECT/UPDATE exception cases pass on base. Every scoped-role/grant control and the exact HTTP method/URL-set assertion passes. This is the expected RED result; record its exit 1 before staging. A different failure is harness divergence: report it before changing production code.

```bash
git diff --check
git add scripts/test-reference-tree-and-valve-router.js .github/workflows/verify-sync-flow.yml
heavy node scripts/verify-test-inventory.js
git diff --cached --check
git commit -m "test: cover reference-tree ownership and valve client lifetime"
```

The staging order is required. `verify-test-inventory.js` builds its file set with `git ls-files -z`; an untracked test named in the workflow is rejected as `not a tracked file`. After the `git add` above, the inventory gate must exit 0 with 817 test files accounted for. Commit only after it and the staged diff check pass. Do not weaken the inventory verifier or treat a pre-staging failure as baseline divergence.

### 2. Apply the two reviewed function bodies

Save the following complete reference-tree tail to `/tmp/osi-470-design/reference-tail.js.txt`. It replaces the code starting at the existing session-required comment. The HMAC verifier and secret resolver above that comment stay in place. Retain the verified identity; use bound EUI and user parameters for SELECT and UPDATE when the flag is off. A foreign/unclaimed/missing device, or ownership lost between read and write, receives the same `{error:'Device not found'}` 404. The write keeps `COALESCE(sync_version, 0) + 1`; rejected writes do not increment it. Scoped mode deliberately omits this owner predicate after the existing guard has authorized the route.

```javascript
// A signed-in session is required in both flag states. Scoped access was
// checked by scoped-device-config-guard; flag-off writes require ownership.
let auth;
try {
  auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);
} catch (authError) {
  msg.statusCode = Number(authError && authError.statusCode) || 500;
  msg.payload = { error: msg.statusCode >= 500 ? 'Internal error' : String(authError && authError.message ? authError.message : 'Unauthorized') };
  msg.headers = { 'Access-Control-Allow-Origin': '*' }; return msg;
}
const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
const _db = new osiDb.Database('/data/db/farming.db');
const q = (sql, params) => new Promise((resolve, reject) => _db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
const exec = (sql, params) => new Promise((resolve, reject) => _db.run(sql, params, function(error) { if (error) reject(error); else resolve(Number(this.changes)); }));
const close = () => new Promise(resolve => _db.close(() => resolve()));
function respond(data, code) {
  msg.statusCode = code || 200; msg.payload = data;
  msg.headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  return msg;
}
try {
  const deveui = (msg.req.params.deveui || '').toUpperCase();
  const isRef = (msg.req.body || {}).is_reference_tree ? 1 : 0;
  const predicate = 'deveui = ?' + (scopedOn ? '' : ' AND user_id = ?');
  const params = scopedOn ? [deveui] : [deveui, auth.userId];
  const dev = await q('SELECT deveui FROM devices WHERE ' + predicate, params);
  if (!dev.length) return respond({ error: 'Device not found' }, 404);
  const changes = await exec('UPDATE devices SET is_reference_tree = ?, sync_version = COALESCE(sync_version, 0) + 1 WHERE ' + predicate, [isRef].concat(params));
  if (!changes) return respond({ error: 'Device not found' }, 404);
  return respond({ success: true, deveui, is_reference_tree: isRef });
} catch (error) {
  return respond({ error: error.message }, 500);
} finally {
  try { await close(); }
  catch (error) { node.warn('dendro-ref-tree-fn db close failed: ' + (error && error.message ? error.message : error)); }
}
})();
```

Save this entire valve-router body to `/tmp/osi-470-design/valve-router.js.txt`:

```javascript
const dbLoad = osiLib.require('osi-db-helper');
const vcLoad = osiLib.require('osi-valve-control');
if (!dbLoad.ok || !vcLoad.ok) {
  const detail = [dbLoad, vcLoad].filter(function(l) { return !l.ok; }).map(function(l) { return l.error; }).join('; ');
  node.error('Valve control helpers unavailable: ' + detail, msg);
  msg.statusCode = 503; msg.payload = { error: 'valve_control_unavailable', message: detail };
  return [msg, null];
}
const dbHelper = dbLoad.value; const VC = vcLoad.value;
const appId = String(env.get('CHIRPSTACK_APP_ACTUATORS') || '').trim();
let client = null;
const flushQueue = function(eui) {
  if (!client) {
    try { client = chirpstack.createProvisioningClientFromEnv(env); }
    catch (e) {
      if (!context.get('csWarned')) {
        node.warn('valve-api: chirpstack client unavailable, plan pushes will not flush the queue: ' + (e && e.message ? e.message : e));
        context.set('csWarned', true);
      }
      throw e;
    }
  }
  return client.flushDeviceQueue(eui);
};
return Promise.resolve().then(function() {
  return VC.handleHttpRequest({
    msg: msg, Database: dbHelper.Database, appId: appId, flushQueue: flushQueue,
    environment: { authTokenSecret: env.get('AUTH_TOKEN_SECRET'), jwtSecret: env.get('JWT_SECRET'), deviceEui: env.get('DEVICE_EUI') },
    warn: function(m) { node.warn(m); }
  });
}).then(function(out) {
  const pushes = Array.isArray(out.valvePushMessages) ? out.valvePushMessages : [];
  delete out.valvePushMessages;
  if (!appId && pushes.length) node.warn('valve-api: CHIRPSTACK_APP_ACTUATORS missing; ' + pushes.length + ' downlink(s) not sent');
  const downlinks = appId ? pushes.map(function(p) { return { topic: p.topic, payload: p.payload }; }) : [];
  return [out, downlinks];
}).catch(function(e) {
  node.error('valve-api: ' + (e && e.message ? e.message : e), msg);
  return [Object.assign(msg, { statusCode: 500, payload: { error: 'internal_error', message: 'Valve request failed' } }), null];
}).finally(function() {
  if (!client) return;
  try {
    const errors = client.close();
    for (const error of (Array.isArray(errors) ? errors : [])) node.warn('valve-api: chirpstack client close failed: ' + (error && error.message ? error.message : error));
  } catch (error) {
    node.warn('valve-api: chirpstack client close failed: ' + (error && error.message ? error.message : error));
  }
});
```

The lazy closure is first invoked after both authentication and valve authorization in the real API. Authenticated reads, malformed requests and ownership failures need no client. Successful creation is cached per request. If creation fails, rethrow into `queueSnapshot`'s existing best-effort catch; returning normally would incorrectly mark the queue as flushed. Keep the existing once-per-node availability warning and report returned close errors. Cleanup exceptions must not replace an HTTP result or the router's 500 response.

`Promise.resolve().then(...)` also brings a synchronous API throw into the existing error-response path. The finalizer runs after the fulfilled/rejected API, including its awaited flush, and after the response/downlink mapping. It closes only a successfully returned client. Partially allocated service clients inside a constructor that throws remain a helper-level concern outside this request-local fix.

Save the following one-shot editor to `/tmp/osi-470-design/apply-470.cjs`. Run it only in the implementation stage, after observing the expected RED result. It parses and serializes JSON, verifies both no-op roundtrips, changes only the two target bodies, then writes identical maintained profiles. Node IDs, libraries and wires remain unchanged. The JSON-parse rejection catch in the touched reference node gains a fixed warning without logging token data. It was already a nonempty catch; no silent-catch baseline update is needed.

The size allowances are measured against the reviewed base using the ratchet's own character-count functions. Replace the consumed reference-node allowance rather than adding to it. Preserve unrelated entries and the documentation baseline file; raise the total allowance only to the exact required maximum if the standing value cannot cover the measured total. Print measurements for review, then run the actual ratchet.

```javascript
'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { nodeSizes, totalChars } = require(process.cwd() + '/scripts/flows-size-scan');
const base = '63c7a70f8f3b373f162b33b0669b0df89b3763fa';
const paths = ['bcm2712', 'bcm2709'].map(p => `conf/full_raspberrypi_bcm27xx_${p}/files/usr/share/flows.json`);
const originals = paths.map(p => fs.readFileSync(p, 'utf8'));
originals.forEach((raw, index) => {
  assert.equal(JSON.stringify(JSON.parse(raw), null, 2) + '\n', raw);
  console.log(paths[index] + ' before byte-identical: true');
});
assert.equal(originals[0], originals[1]);
const flows = JSON.parse(originals[0]);
const reference = flows.find(n => n.id === 'dendro-ref-tree-fn');
const marker = '// A signed-in session is required in both flag states:';
assert.equal(reference.func.split(marker).length, 2);
const authPrefix = reference.func.slice(0, reference.func.indexOf(marker));
// The JSON parse catch already rejects the token; add a warning with no token contents.
const oldCatch = "} catch (_) {\n    const err = new Error('Invalid token');";
assert.equal(authPrefix.split(oldCatch).length, 2);
reference.func = authPrefix.replace(oldCatch, "} catch (error) {\n    node.warn('dendro-ref-tree-fn invalid token payload');\n    const err = new Error('Invalid token');") + fs.readFileSync('/tmp/osi-470-design/reference-tail.js.txt', 'utf8');
flows.find(n => n.id === 'valve-api-router-fn').func = fs.readFileSync('/tmp/osi-470-design/valve-router.js.txt', 'utf8');
const rendered = JSON.stringify(flows, null, 2) + '\n';
assert.equal(JSON.stringify(JSON.parse(rendered), null, 2) + '\n', rendered);
// Only the two reviewed function bodies may change.
const diffIds = flows.filter((n, i) => JSON.stringify(n) !== JSON.stringify(JSON.parse(originals[0])[i])).map(n => n.id);
assert.deepEqual(diffIds.sort(), ['dendro-ref-tree-fn', 'valve-api-router-fn']);
paths.forEach(p => { fs.writeFileSync(p, rendered); console.log(p + ' after byte-identical: true'); });
const allowancesPath = 'scripts/verify-flows-size-ratchet-allowances.json';
const allowances = JSON.parse(fs.readFileSync(allowancesPath, 'utf8'));
const baseFlows = JSON.parse(execFileSync('git', ['show', base + ':' + paths[0]], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const sizes = nodeSizes(flows), baseSizes = nodeSizes(baseFlows);
for (const id of diffIds) {
  const before = baseSizes.get(id).chars, after = sizes.get(id).chars;
  allowances.node_allowances[id] = { delta: Math.max(0, after - before), reason: `osi-os #470, measured against ${base}: ${id} ${before} -> ${after} = ${after - before} chars in each byte-identical maintained profile. Reference-tree ownership is bound in flag-off read and write; valve client creation is lazy and its close follows the settled API/flush promise. Supersedes any consumed allowance for this node.` };
  console.log(id + ': ' + before + ' -> ' + after + ' delta=' + (after - before));
}
const baseline = JSON.parse(fs.readFileSync('scripts/verify-flows-size-ratchet-baseline.json', 'utf8'));
const total = totalChars(flows), oldTotal = totalChars(baseFlows);
const required = Math.max(0, total - oldTotal, ...paths.map(p => total - baseline.files[p].total));
if (required > allowances.total_allowance.delta) {
  allowances.total_allowance.delta = required;
  allowances.total_allowance.reason += ` #470: per profile ${oldTotal} -> ${total}; exact required allowance ${required}, including the committed documentation baseline.`;
}
fs.writeFileSync(allowancesPath, JSON.stringify(allowances, null, 2) + '\n');
console.log('per-profile total: ' + oldTotal + ' -> ' + total + '; required allowance=' + required + '; standing allowance=' + allowances.total_allowance.delta);
```

Run the editor, then the focused tests:

```bash
node /tmp/osi-470-design/apply-470.cjs
heavy node --test scripts/test-reference-tree-and-valve-router.js
```

Expected: two before/after `byte-identical: true` pairs; the changed-node assertion names only `dendro-ref-tree-fn` and `valve-api-router-fn`; the editor prints reference-tree 6700 → 7054 (+354), valve router 1866 → 2385 (+519), and total growth +873 characters per profile. The route suite exits 0 with 66 passed and no failures, cancellations or skips. Inspect both profile diffs and the allowance provenance; do not accept unexplained formatting or wiring changes.

### 3. Run the existing gates and commit the fix

Run each command directly, retaining exit codes and logs. They are sequential because the wrapper holds the campaign's single heavy-work lock.

```bash
heavy node --test scripts/test-export-routes-require-session.js scripts/test-scoped-access-writes.js
heavy node scripts/test-watermark-calibration-routes.js
heavy node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/api.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/push.test.js
heavy node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
heavy node scripts/verify-flows-fn-parse.js
heavy node scripts/verify-flows-output-arity.js
heavy node scripts/flows-bare-require-scan.js
heavy node scripts/verify-no-new-silent-catch.js
heavy node scripts/verify-no-stray-ddl.js
heavy node scripts/verify-flows-size-ratchet.js
heavy node scripts/verify-auth-flag-off-hermetic.js
heavy node scripts/verify-scoped-access.js
heavy node scripts/test-flows-wiring.js
heavy node scripts/verify-profile-parity.js
heavy node scripts/verify-test-inventory.js
heavy bash scripts/check-mqtt-topics.sh
heavy node scripts/verify-sync-flow.js
heavy node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-10-25-issue-470-reference-tree-and-valve-client.md
heavy node scripts/verify-doc-hygiene.js
git diff --check
```

Every command must exit 0. The WATERMARK route gate reports 28 passing cases. Parse prints `verify-flows-fn-parse: OK`; wiring ends with its existing STREGA/DB-close guard PASS; size and DDL ratchets print OK; auth hermeticity reports zero flag-off scope loads. Full sync prints `Sync flow verification passed` in its section and ends `All parity checks passed.` A private documentation-name list may be absent; report that limitation rather than claiming that check ran. Do not read or print credential environment values.

No GUI, schema, seed or cloud file changes are planned, so their separate build/migration suites are unnecessary. The full sync verifier still runs its normal chained contract/schema/helper checks. No change to `sync-init-fn`, the scope helper, the valve helper, or ChirpStack helper is authorized by this plan.

Expected changed files after implementation:

- `scripts/test-reference-tree-and-valve-router.js`
- `.github/workflows/verify-sync-flow.yml`
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- `scripts/verify-flows-size-ratchet-allowances.json`
- This committed plan, plus a separately reviewed plan-review/execution record if the coordinator requests one.

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-flows-size-ratchet-allowances.json
git commit -m "fix: scope reference-tree writes and close lazy valve clients"
git status --short --branch
```

Stop if any runtime file outside the listed two function bodies changes. Return the test commit and fix commit SHAs, reviewed base, complete gate results and any warnings to the coordinator. Do not push or open a PR from the executor stage.

## Independent verification and delivery

A fresh verifier must inspect each hunk and rerun the focused suite and step 3 gates on the final commit. Confirm that a scoped assigned non-owner still succeeds, an out-of-scope admin remains denied, and foreign flag-off requests cannot distinguish existence. Check that denied writes preserve the full selected row, including its version, and that an allowed write increments once. Check the pending-flush handshake, rejection path and cleanup warnings; a string search for `.close()` alone is insufficient.

Prove the regression suite detects the old defect after the fix without modifying the current worktree. Save the two base flow files to a temporary tree, then point only the test's flow loader there:

```bash
python3 - <<'PYBASE'
from pathlib import Path
import subprocess
for profile in ('bcm2712', 'bcm2709'):
    rel = f'conf/full_raspberrypi_bcm27xx_{profile}/files/usr/share/flows.json'
    target = Path('/tmp/osi-470-base') / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(subprocess.check_output(['git', 'show', '63c7a70f8f3b373f162b33b0669b0df89b3763fa:' + rel]))
PYBASE
OSI_470_FLOWS_ROOT=/tmp/osi-470-base heavy node --test scripts/test-reference-tree-and-valve-router.js
```

Expected: the same 28 failures from step 1, exit 1. Remove the override and rerun the focused suite for 66/66 green. The actual auth/helper code remains real in both runs; the only substituted production artifact is the loaded flow source. These are offline function-node tests, so the final report must not claim an HTTP-listener smoke check, live hardware verification or measured gRPC idle time.

After independent GREEN the coordinator prepares the draft PR with exactly “Partially addresses #470; partially addresses #465; related #451”. Keep #470 and #465 open; use no auto-closing wording until a separate final issue-wide acceptance review permits it. State that no server companion or sync-contract mirror is needed. Link the draft PR with T3 immediately after creation. No merge or deployment belongs to this campaign.

## Response to the first plan review

The review at plan commit `4c3fcd227dc5a6f9aea4d5adf5647e6d0009c0a9` rejected execution. R1 is addressed by observing RED first, staging the new test and workflow, then running inventory and the staged diff check before commit. An amendment probe of the actual verifier confirms the unstaged-file rejection and a clean result when the new file is supplied in the tracked-file set; it substitutes verifier inputs without changing the repository index or runtime files.

R2 is addressed by independently inspecting and probing all sibling claims, recording the already-shipped flag-off filters, and associating the retained Chameleon grant failure with existing #451. Delivery wording now partially addresses #470 and #465 and relates #451. Issue closure awaits final acceptance review.

Both optional findings are adopted. The suite compares the actual eight HTTP `(method, url)` pairs against the exercised route set. Seven additional exception scenarios run per profile: reference SELECT, UPDATE and close failures; a synchronous API throw; synchronous flush failure through the real API; mapping failure after a flush; and two flushes sharing one request-local client. These additions bring the suite to 66 cases.

## Design-stage verification record

Before writing this plan, actual shipped-route probes reproduced both findings. A prospective copy of the complete test suite above was run from `/tmp` against both untouched flow profiles; it was corrected to preserve the shipped zone-scope rule for admins. Its expected failures identify the production defects, while its existing auth/grant controls pass. No repository runtime source was modified to obtain a green result. After amendment the same 66-case source returned 38 pass / 28 expected fail on untouched base flows and 66 pass / zero fail on the independent reviewer's existing scratch-proposed flow artifacts. A file-based check proved that those artifacts match exactly the unchanged two proposed function bodies and all other nodes match the base. Scratch GREEN is evidence for the revised plan, not final-SHA implementation verification. All amendment probes used file arguments through `run-heavy.py`; none depended on stdin forwarding.

The design base passed function-node parse, bare-require scan, silent-catch, stray-DDL and size ratchets, auth flag-off hermeticity, scoped-access ratchet, flow wiring, test inventory and the full sync verifier. Full sync ended `All parity checks passed.` Gate output and the route reproduction are recorded in the campaign handoff. Post-fix GREEN and independent plan review remain pending.

There is no unresolved product decision. The next stage is adversarial plan review, particularly the owner predicate's write-time race and the promise boundary that keeps the client open through a rejected async flush. Broader #465 callers, the Chameleon grant-parity instances associated with #451, and any partially constructed helper-client cleanup remain outside this change.
