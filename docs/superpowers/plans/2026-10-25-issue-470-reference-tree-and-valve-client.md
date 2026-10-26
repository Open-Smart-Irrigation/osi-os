# Issue 470: reference-tree ownership and valve-router client lifetime

Resolve both current findings in [osi-os #470](https://github.com/Open-Smart-Irrigation/osi-os/issues/470): reject flag-off reference-tree writes by other accounts, and allocate a valve-router ChirpStack client only for an authenticated queue flush, then close it after that work settles.

Status: amended after the first independent review rejected execution; a fresh adversarial review is required. This commit contains the plan only. A separate reviewer, executor and verifier carry out the later stages. This plan's author does not approve its implementation.

## Scope and verified base

Base: `63c7a70f8f3b373f162b33b0669b0df89b3763fa`, fetched from `origin/main` on 2026-10-25. The design worktree was clean on `t3/issue-470-plan` before fast-forwarding from the stale local commit. The root checkout was not switched or edited.

Read the current `AGENTS.md`, `docs/engineering-playbook.md`, and the `osi-flows-json-editing`, `osi-common-pitfalls`, `osi-verification-commands`, `osi-sync-contract-awareness`, `osi-config-and-flags` and `anti-slop-writing` skills before execution. The work needs no SSH, live gateway access, deployment, merge or release publication. A reviewed draft PR follows independent verification; this design stage does not push or create a PR.

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

Set the base references once in the shell that runs the tests and verifiers below:

```bash
export OSI_FLOWS_SIZE_BASE_REF=63c7a70f8f3b373f162b33b0669b0df89b3763fa
export OSI_DDL_BASE_REF=63c7a70f8f3b373f162b33b0669b0df89b3763fa
export OSI_MIGRATIONS_BASE_REF=63c7a70f8f3b373f162b33b0669b0df89b3763fa
export OSI_IDENTITY_BASE_REF=63c7a70f8f3b373f162b33b0669b0df89b3763fa
mkdir -p /tmp/osi-470-design
```

Keep the four base variables together until rebasing and re-review. Stop and report any unexpected gate failure, including red-on-base. Expected regression failures in step 1 are the explicit exception.

### 1. Commit the failing behavioral tests

Create `scripts/test-reference-tree-and-valve-router.js`; the test commit holds its exact source. The tests run shipped flow text through real auth and SQLite using `scripts/lib/scoped-access-harness`, loading each maintained profile's `flows.json` in turn: 33 cases per profile, 66 in all. `OSI_470_FLOWS_ROOT` redirects only the flow loader, which the base-detection run under independent verification uses. ChirpStack is always a fake factory; configured test secrets prevent credential-file reads.

The reference-tree cases follow `dendro-ref-tree-http` through `scoped-device-config-guard` output 2 into `dendro-ref-tree-fn`, asserting that wiring and the `dendro-http-resp` response node on every call. They cover:

- flag-off owner writes that set and then clear the flag, each incrementing `sync_version` once;
- flag-off foreign, unclaimed and missing devices, which get an identical 404 `{error:'Device not found'}` and leave the row unchanged;
- missing, malformed, expired and wrongly signed sessions, which get 401 in both flag states without mutation;
- scoped access: an assigned non-owner researcher and an in-scope admin succeed, while an out-of-scope admin (404), a viewer (403), a disabled account (403), a revoked zone assignment (404) and an owned but unassigned device (404) are refused without mutation;
- an ownership change injected between the SELECT and the UPDATE, which returns 404 and closes the DB once;
- the flag-off route succeeding while any scope-helper load throws;
- SELECT, UPDATE and close faults, each closing once: the first two answer 500 without mutation, and a close fault keeps the committed 200 write.

The valve-router route cases run the real `osi-valve-control` API:

- the eight `/api/valves*` HTTP nodes match the exercised method/URL set, and four invalid sessions on each route get 401 without opening a DB or creating a client;
- an authenticated list and an ownership refusal (403) create no client;
- on a plan resend, close runs only after an async flush settles, whether it resolves or rejects, and the response stays 202 with pushes recorded;
- a factory failure keeps the best-effort 202 and warns;
- a synchronous flush throw inside the real API still closes the client.

Six further cases per profile substitute the API to reach router-only branches. Returned close errors, a throwing close and an API rejection each close the client once without replacing the response. A synchronous API throw answers 500 and creates no client, a mapping failure after a flush answers 500 and closes once, and two flushes share one request-local client that closes once.

The mirror's function bodies run separately. The unchanged helper bindings use canonical modules; profile parity proves the helper copies agree. These tests do not measure network channel counts or prove the issue's claimed 30-minute idle duration.

Add this exact step immediately before `- name: Scoped-access endpoint ratchet` in `.github/workflows/verify-sync-flow.yml`:

```yaml
      - name: Reference-tree ownership and valve-router client lifetime
        run: node --test scripts/test-reference-tree-and-valve-router.js
```

Run:

```bash
node --test scripts/test-reference-tree-and-valve-router.js
```

Expected regression result on the reviewed base: 66 tests, 38 pass, 28 fail, zero cancelled/skipped. Per profile, the foreign flag-off write and ownership-change cases return 200 instead of 404; the eight-route session matrix creates 32 clients instead of zero; the authenticated read/ownership rejection creates two instead of zero; the two deferred-flush cases and three cleanup fault cases close zero clients instead of one. The added reference close failure, synchronous API throw, synchronous flush failure, mapping failure and repeated-flush cases fail once per profile too. The SELECT/UPDATE exception cases pass on base. Every scoped-role/grant control and the exact HTTP method/URL-set assertion passes. This is the expected RED result; record its exit 1 before staging. A different failure is harness divergence: report it before changing production code.

```bash
git diff --check
git add scripts/test-reference-tree-and-valve-router.js .github/workflows/verify-sync-flow.yml
node scripts/verify-test-inventory.js
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
const reasons = {
  'dendro-ref-tree-fn': 'With the flag off, the handler binds the verified user id next to the EUI in both the SELECT and the UPDATE, so a foreign, unclaimed or missing device and an ownership change between read and write all get 404 with no write. The token JSON-parse catch gains a fixed warning.',
  'valve-api-router-fn': 'flushQueue creates the ChirpStack client per request on first use, after the API has checked the session and valve authorization, and a finally handler closes it after the API promise and its awaited flush settle.',
};
for (const id of diffIds) {
  const before = baseSizes.get(id).chars, after = sizes.get(id).chars;
  allowances.node_allowances[id] = { delta: Math.max(0, after - before), reason: `osi-os #470, measured against ${base}: ${id} ${before} -> ${after} = ${after - before} chars in each byte-identical maintained profile. ${reasons[id]} Supersedes any consumed allowance for this node.` };
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
node --test scripts/test-reference-tree-and-valve-router.js
```

Expected: two before/after `byte-identical: true` pairs; the changed-node assertion names only `dendro-ref-tree-fn` and `valve-api-router-fn`; the editor prints reference-tree 6700 → 7054 (+354), valve router 1866 → 2385 (+519), and total growth +873 characters per profile. The route suite exits 0 with 66 passed and no failures, cancellations or skips. Inspect both profile diffs and the allowance provenance; do not accept unexplained formatting or wiring changes.

### 3. Run the existing gates and commit the fix

Run each command in sequence, retaining exit codes and logs.

```bash
node --test scripts/test-export-routes-require-session.js scripts/test-scoped-access-writes.js
node scripts/test-watermark-calibration-routes.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/api.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/push.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-flows-output-arity.js
node scripts/flows-bare-require-scan.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-auth-flag-off-hermetic.js
node scripts/verify-scoped-access.js
node scripts/test-flows-wiring.js
node scripts/verify-profile-parity.js
node scripts/verify-test-inventory.js
bash scripts/check-mqtt-topics.sh
node scripts/verify-sync-flow.js
node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-10-25-issue-470-reference-tree-and-valve-client.md
node scripts/verify-doc-hygiene.js
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
- This committed plan.

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-flows-size-ratchet-allowances.json
git commit -m "fix: scope reference-tree writes and close lazy valve clients"
git status --short --branch
```

Stop if any runtime file outside the listed two function bodies changes. Report the test and fix commit SHAs, the reviewed base, complete gate results and any warnings. The executor stage does not push or open a PR.

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
OSI_470_FLOWS_ROOT=/tmp/osi-470-base node --test scripts/test-reference-tree-and-valve-router.js
```

Expected: the same 28 failures from step 1, exit 1. Remove the override and rerun the focused suite for 66/66 green. The actual auth/helper code remains real in both runs; the only substituted production artifact is the loaded flow source. These are offline function-node tests, so the final report must not claim an HTTP-listener smoke check, live hardware verification or measured gRPC idle time.

After independent GREEN the draft PR uses exactly “Partially addresses #470; partially addresses #465; related #451”. Keep #470 and #465 open; use no auto-closing wording until a separate final issue-wide acceptance review permits it. State that no server companion or sync-contract mirror is needed. No merge or deployment is part of this plan.

## Response to the first plan review

The review at plan commit `4c3fcd227dc5a6f9aea4d5adf5647e6d0009c0a9` rejected execution. R1 is addressed by observing RED first, staging the new test and workflow, then running inventory and the staged diff check before commit. An amendment probe of the actual verifier confirms the unstaged-file rejection and a clean result when the new file is supplied in the tracked-file set; it substitutes verifier inputs without changing the repository index or runtime files.

R2 is addressed by independently inspecting and probing all sibling claims, recording the already-shipped flag-off filters, and associating the retained Chameleon grant failure with existing #451. Delivery wording now partially addresses #470 and #465 and relates #451. Issue closure awaits final acceptance review.

Both optional findings are adopted. The suite compares the actual eight HTTP `(method, url)` pairs against the exercised route set. Seven additional exception scenarios run per profile: reference SELECT, UPDATE and close failures; a synchronous API throw; synchronous flush failure through the real API; mapping failure after a flush; and two flushes sharing one request-local client. These additions bring the suite to 66 cases.

## Design-stage verification record

Before writing this plan, actual shipped-route probes reproduced both findings. A prospective copy of the test suite was run from `/tmp` against both untouched flow profiles; it was corrected to preserve the shipped zone-scope rule for admins. Its expected failures identify the production defects, while its existing auth/grant controls pass. No repository runtime source was modified to obtain a green result. After amendment the same 66-case source returned 38 pass / 28 expected fail on untouched base flows and 66 pass / zero fail on the independent reviewer's existing scratch-proposed flow artifacts. A file-based check proved that those artifacts match exactly the unchanged two proposed function bodies and all other nodes match the base. Scratch GREEN is evidence for the revised plan, not final-SHA implementation verification. All amendment probes passed their inputs as file arguments, not on stdin.

The design base passed function-node parse, bare-require scan, silent-catch, stray-DDL and size ratchets, auth flag-off hermeticity, scoped-access ratchet, flow wiring, test inventory and the full sync verifier. Full sync ended `All parity checks passed.` Post-fix GREEN and independent plan review remain pending.

There is no unresolved product decision. The next stage is adversarial plan review, particularly the owner predicate's write-time race and the promise boundary that keeps the client open through a rejected async flush. Broader #465 callers, the Chameleon grant-parity instances associated with #451, and any partially constructed helper-client cleanup remain outside this change.
