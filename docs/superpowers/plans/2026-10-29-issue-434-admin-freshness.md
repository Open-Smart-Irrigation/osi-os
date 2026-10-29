# Issue 434: fresh admin authorization, plan bound to main bd1afcd2 (R3)

## Status and source binding

This plan targets `main` at `bd1afcd248616653e1962081c8c9e3d7b19d650f` (called B below). It carries the source design that independent Sol review R3 accepted on 2026-10-26 against `63c7a70f8f3b373f162b33b0669b0df89b3763fa` (N), the corrections from a source reconciliation of N against B on 2026-10-29 (packet R1), the four corrections that the independent Sol review of packet R1 required (packet R2), and one forecast correction that the independent Sol review of packet R2 required (this packet, R3). Every test, gate, editor run and prose check named here is **UNRUN**. No RED or GREEN result exists for this plan. The only behavioral evidence on record is the coordinator's four-counterexample probe at N: it imported the shipped helper over a synthetic SQLite facade, so it says nothing about routes.

GitHub state read at 2026-10-29 14:21Z: #434 is OPEN with no comments, labelled P1; #520 cross-references it. Fresh role reads do not revoke issued tokens; that stays with #520.

Reconciliation result. The scope helper, `osi-system-settings`, `osi-scoped-access-commands`, `osi-db-helper`, `osi-journal/api.js`, the history contract verifier and its test, both auth flag-off verifiers, and every consumer function node in the inventory below except `history-api-router-fn` are byte-identical at N and B. `history-api-router-fn` changed only inside its card-data builders. `scopeCheckForRoute`, the edited comment and call, `getGatewayContext`, the preference upsert and the opened write are unchanged. The set of flow nodes that call a cached helper method is the same at N and B. Three facts changed what this plan has to say:

1. `scripts/test-scoped-access-writes.js` now has 101 top-level tests (96 at N), so the forecast after six additions is 107.
2. `scripts/test-sync-outbox-recovery-route.js` runs in CI (`migrations.yml`, "Rejection recovery tests") and fakes the identity query with a row that holds only `user_uuid`. Under the one-query helper its admin control would fail. The file is unchanged since N; the accepted draft and its three reviews did not list it. This plan adds an exact fixture replacement.
3. CI commands that execute a changed helper function, the edited router node or the contract verifier were missing from the gate list. "CI dependency accounting" below gives every CI-run file, and every child that `verify-sync-flow.js` spawns, either a planned command or a source-based exclusion.

The four R2 corrections, one per finding of the Sol review of packet R1:

- **CI accounting (finding R1).** Packet R1 claimed its 23 regression controls covered every CI test that loads the real helper. That was false: it missed `node --test scripts/test-auth-bootstrap-policy.js scripts/test-account-recovery.js scripts/test-account-recovery-cli.js` and `node --test scripts/test-rain-history-route.js`, and it credited three files that never load the real helper (`osi-lib/index.test.js`, the writer-wrapper test, the command-path test). A wrapped source audit of every workflow at B now gives one disposition to each of 445 files: every CI-run code file plus the two bcm2709 mirrors that the plan runs outside CI. Each control carries an evidence class (changed path, reset only, router, load only), and controls that execute no real helper code were removed.
- **Fresh-main fence (finding R2).** Step 0 and the plan-only commit both fetch `main` into the executor's own `FETCH_HEAD` and stop unless it equals B, before any extracted asset runs. The external digests are compared inside wrapped commands before the editors execute. Step 6 repeats the fetch so that drift during execution is reported.
- **Command custody (finding R3).** Every command is written out with its label and capture bound. `run434` sets `GIT_NO_LAZY_FETCH=1` for direct and spawned Git. Counts are recomputed from the listed commands: 146 execution commands and 12 plan-commit commands.
- **H10 (finding R4).** H10 now races the original request's settlement against the second barrier. At B, and under M2 and M4, the request settles first and H10 fails at a named assertion instead of waiting on a barrier that B never opens. M7's forecast now names the `TypeError` it raises.

The R3 correction changes forecast text only. Packet R2 said that H4–H6 pass at B; the Sol review of packet R2 showed from source that they fail. Each passes its early status checks and then fails a later assertion, because B's `assertAuthenticatedRole` sends the old `SELECT user_uuid` identity query and then calls cached `assertRole`, and B's `authorizeAdminRead` closes the handle without wrapping a query error. H4 fails at its SQL equality, H5 at its call list and H6 at its first `assert.rejects` predicate. This holds in both helper profiles and under mutant M1, which restores B's `assertAuthenticatedRole`. H1 stays the first failing top-level test in each helper run, and H12 still passes at B. No test, editor, mutant, command, pin or design byte changed in R3.

Text retained from the accepted draft says "pinned" for the bound source and "draft" for this document; each such statement was rechecked at B and holds there unless a B note says otherwise. The design itself is unchanged: same helper bodies, same history call, same tests except H10's synchronization, same flow editor bytes. Packet R1 added literal before-text pins, a guarded stage editor with after-edit digests, base-ref pinning to B for every git-anchored verifier, and wrapped command custody with per-command receipts.

At B, `osi-scope-helper/index.js` has a 30,000 ms cache. `authorizeAdminRead` verifies a signed bearer, then calls `assertAuthenticatedRole`, which performs an identity lookup followed by cached `assertRole`. An enabled cache miss also loads four zone/plot tables. `resolveScope` writes the result after `await loadScope()` even when `invalidateScope()` ran while that load was pending. A stale load can therefore republish an old role after a supported admin mutation invalidated the key.

## Boundary and invariant

The role decision for every scoped, gateway-wide privileged path must use the current `users` row selected by the signed token's numeric `userId` and trimmed `username`. A fresh role check must never consult or fill the scope cache. `authorizeAdminRead` performs exactly one `db.get` statement with two bound parameters and zero `db.all` statements, regardless of whether the user is allowed or refused. The SQL selects `id, username, role, disabled_at, user_uuid` from `users` with `WHERE id = ? AND username = ? LIMIT 1`. A missing row or missing `user_uuid` is 401; a disabled row, non-admin role, or unknown role is 403. SQL failure carries HTTP 500 and the original error as `cause`, so reboot/fan's current catch blocks cannot misclassify a failed role read as 403. Token verification and close behavior retain their current ordering.

The identity grammar stays as shipped: `Number(auth.userId)` must be finite and `String(auth.username || '').trim()` must be nonempty. This deliberately does not import a stricter positive-integer or UUID grammar from another issue's plan. The SQL still binds the converted number and trimmed name. `verifyBearer` continues to accept the existing two-part HMAC token and its current `exp` behavior. This work does not create durable token revocation; #520 owns old-token revival after disable and re-enable.

Cache invalidation has a separate contract. When a scope load overlaps either per-user or global invalidation, its result must neither enter the cache nor be returned to its original waiting caller. The caller retries once, first consulting any newer cache entry. If a second load is invalidated, the **helper Promise** rejects with `status` and `statusCode` 503 and leaves no stale entry. This is not a route-wide HTTP 503 promise: pinned `api-me-fn` and `sdi12-profiles-scope-fn` map that failure to HTTP 500, and this plan leaves those catches intact. A database load error rejects directly and is never cached. This gives a bounded two-load maximum per call under repeated invalidation. It does not promise a serialized authorization decision against a DB mutation after the fresh query has completed; the supported admin mutation must still call invalidation after its write.

Flag-off routes keep their current bearer-only or wildcard behavior and must not gain a scope-helper dependency. Account-wide zone/history reads and per-user workspace ownership remain as shipped. #370 owns read identity/visibility changes. No schema, migration, new flag, seed, cloud contract, GUI, or alias is proposed. `authorizeAdminRead` remains the exported name; an `authorizeAdmin` alias adds no acceptance value.

## Caller inventory and disposition

The inventory comes from the bcm2712 function bodies at B, `osi-system-settings/api.js`, and a call-site scan of every module under `node-red/`. Both flow profiles are byte-identical at B (`flows.json` SHA-256 `542df53f2744dc454ae4c0b27cf3663e83c0b4b870325faed2efa39939dc6117`). The bcm2709 payload receives the byte-identical edit. Execution is bound to B exactly (step 0 below), so this inventory is the one the executor works against.

| Caller | Current decision | Proposed disposition |
|---|---|---|
| `account-link-admin-write-guard`, `account-unlink-admin-write-guard`, `sync-force-admin-write-guard`, `get-gateway-location-auth-fn`, `history-rollups-admin-write-guard`, `database-download-admin-read-guard`, `sync-state-admin-read-guard`, `system-stats-admin-read-guard`, `fieldtest-download-admin-read-guard`, `sync-outbox-recover-admin-guard` | `authorizeAdminRead` in scoped branch | Keep bodies and wiring. The helper's single fresh `assertAuthenticatedRole` query secures all ten; test their real function bodies and fail-closed outputs. The outbox guard still consumes `scope.username` for `_recoveryActor`. |
| `sys-reboot-fn`, `sys-fan-fn` | Direct `assertAuthenticatedRole` in scoped branch | Keep call sites, make that method fresh. Assert denial before `setTimeout(cp.exec)` or any fan filesystem write. Preserve inline bearer verification and flag-off path. |
| `al-status-decode` | Direct `assertAuthenticatedRole` before linked-account status query | Keep call site; its separate status `db.all` remains after fresh authorization. A denied request must not return status rows. |
| `improvement-requests-api-router` | Direct `assertAuthenticatedRole` for two admin GET paths; `assertEnabledAccount` for POST filing | Freshen only the admin GET role decision through the shared method. POST remains available to any enabled role, with its existing fresh enabled-account check. Its later identity query is a separate route read, not part of the one-query `authorizeAdminRead` promise. |
| `osi-system-settings/api.js` | Direct `assertAuthenticatedRole` for scoped PUT | Freshen via the shared method; GET remains bearer-only and flag-off PUT remains bearer-only. Test a denied PUT leaves settings unchanged. |
| `history-api-router-fn` | Direct `assertRole(db, user.user_uuid, 'admin', { scopedMode: true })` on gateway routes | Replace this one call with `assertAuthenticatedRole(db, principal, 'admin', { scopedMode: true })`. Retain the preceding fresh `SELECT user_uuid, disabled_at` check on every history request. Gateway GET/PUT/POST stay admin-only; zone history stays account-wide, workspaces owner-filtered. This route makes two user reads on gateway paths, which is outside the `authorizeAdminRead` one-query acceptance. |
| Existing `assertFreshRole` users | Fresh `loadScope` on writes | No change. Do not redirect them through a cached assertion or remove their zone/plot checks. |
| `assertEnabledAccount`, `assertRole`, `isAdmin`, `resolveScope` elsewhere | Cached full scope where explicitly used | Keep the full-scope API and 30 s TTL, but repair invalidation races. Do not claim this makes every account-wide read identity-fresh; #370 is separate. |
| `conditional-policy-route-fn` (new at B), and `osi-irrigation-policy/routes.js`, which now holds the bodies of `scoped-zone-delete-router`, `scoped-device-assign-router`, `scoped-device-unassign-router` and `scoped-device-delete-router` | `verifyBearer`, `assertFreshRole`, `assertFreshZoneAccess`, `assertFreshDeviceAccess`, `canMutate` | No change. These are fresh write controls and call no cached method. |
| `osi-entity-name/commands.js`, `osi-installation-location-helper/commands.js`, `osi-network-api/index.js`, `osi-journal/commands.js` | `assertFreshDeviceAccess`, `assertFreshZoneAccess`, `canMutate`, `verifyBearer`, `isScopedMode` | No change; fresh paths only. |

At N, `scoped-zone-delete-router` invalidated the actor and every grantee after a zone delete. At B that body lives in `scopedZoneDelete` in `osi-irrigation-policy/routes.js`, which calls no `invalidateScope`, so a cached full scope can keep a deleted zone's UUID and `api-me-fn` returns that set. A completed load keeps it for the rest of its 30,000 ms cache lifetime; at B an overlapping older load can also republish after the delete, so the window is not a flat 30 s from the delete. The pending tickets in this plan do not help, because the delete path makes no invalidation call. This is stale write-scope metadata, not a shown authorization bypass: `/api/me` rechecks identity and disabled state before serializing, and the mutation paths inspected authorize freshly. No role or enabled-state decision in this plan reads that set, and #434 does not change it; the coordinator holds it for separate triage.

### Scope-load error boundary audit

This is the pinned direct-call inventory for `resolveScope` and `assertEnabledAccount`, including the two module callers. It is an audit of propagation boundaries, not an expansion of role or visibility policy. `assertRole` and `isAdmin` also call `resolveScope` inside the helper; their callers keep their existing catches. A second invalidation yields helper 503 for every one of these calls, but **only the first two rows below have a new exact HTTP-status oracle**. Other route catches remain as shipped; this draft makes no blanket HTTP 503 claim for them.

| Direct caller | Pinned catch boundary and #434 disposition |
|---|---|
| `api-me-fn` → `resolveScope` | Its broad catch writes HTTP 500 and `{message:'unable to resolve scope'}` even for helper 503. H10 must assert that exact 500. Preserve its full `zoneUuids`/`plotUuids` ownership response on successful loads. |
| `sdi12-profiles-scope-fn` → `assertEnabledAccount` | Its `[401,403,500]` allowlist remaps helper 503 to HTTP 500 with `Unable to authorize SDI-12 profiles`. H10 must assert the error output and null success output. |
| `get-devices-query`, `get-zones-query`, `fn_build_sensor_sql_params` | Their existing enclosing flow error paths remain unchanged. None is a privileged-role decision; no #434 HTTP 503 guarantee is made. |
| `dendro-history-fn`, `sensor-history-fn`, `rain-history-fn`, `dendro-daily-fn`, `dendro-zone-rec-fn`, `dendro-raw-fn` | Existing route-local catches/HTTP responses remain unchanged. The first three use status-aware history catches; #434 does not change account-wide read filters. |
| `zone-env-fn`, `s2120-zones-get-fn`, `strega-today-liters-fn`, `watermark-cal-fn`, `get-actuations-query`, `zone-rain-source-fn` | Existing route-local error boundaries remain unchanged. #370 separately owns the `s2120-zones-get-fn` and `watermark-cal-fn` token identity issue. |
| `analysis-api-router-fn`, `catalog-authenticated-read-guard`, `improvement-requests-api-router` POST branch | Their existing account-enabled checks and catch boundaries remain unchanged. Improvement-request admin GETs use the separate fresh `assertAuthenticatedRole` path above. |
| `osi-history-router/index.js` portable all-zones export → `assertEnabledAccount`; `osi-journal/api.js` → `resolveScope` | Module-level callers retain their own error conversion/propagation. Neither gets a new route-status or account-wide visibility contract from #434. |

At B the module-level `assertEnabledAccount` call in `osi-history-router/index.js` sits at line 858 inside `portableAssertEnabledAccount` (line 692 at N); the call itself is unchanged. No module gained a direct `resolveScope`, `assertEnabledAccount`, `assertRole`, `isAdmin`, `assertAuthenticatedRole` or `authorizeAdminRead` call between N and B.

The direct inventory is exhaustive for the pinned helper name search, but it is not proof of a universal HTTP status: some calls are nested in modules or flow chains. Step 0 binds execution to B, so this scan result is the one the executor works against. H10 proves the helper limit and the two known 500 mappings without editing either route.

The scan behind this inventory covered direct `assertAuthenticatedRole(`, `assertRole(`, `authorizeAdminRead(`, `resolveScope(`, `assertEnabledAccount(`, `isAdmin(` and `invalidateScope(` calls in both flow profiles and every helper module at B. A new direct privileged caller on any later base needs the same fresh-role disposition before implementation. Do not silently expand this plan into unrelated read routes.

## Exact proposed product change

Under both `conf/full_raspberrypi_bcm27xx_<profile>/files/usr/share/node-red/osi-scope-helper/index.js`, keep `loadScope`, `assertRole`, `assertEnabledAccount`, `assertFreshRole`, `verifyBearer`, and `authorizeAdminRead` exports. Add `pendingLoads` adjacent to `cache`, replace only `resolveScope`, `invalidateScope`, `assertAuthenticatedRole`, and `_resetForTests` with the following bodies. The return from `assertAuthenticatedRole` is intentionally a role-only result: `zoneUuids` and `plotUuids` are `null`, so no caller can mistake it for a loaded ownership scope. Current product callers inspect only the role result or its `username`; the outbox recovery caller needs that name. The flag-off wildcard result retains the old wildcard shape.

<!-- asset:product-helper -->
```js
const pendingLoads = new Map();

async function resolveScope(db, userUuid, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) {
    return {
      role: 'admin', disabled: false, wildcard: true,
      zoneUuids: null, plotUuids: null,
    };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const hit = cache.get(userUuid);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scope;

    let pending = pendingLoads.get(userUuid);
    if (!pending) {
      pending = new Set();
      pendingLoads.set(userUuid, pending);
    }
    const ticket = { invalidated: false };
    pending.add(ticket);
    try {
      const scope = await loadScope(db, userUuid);
      if (ticket.invalidated) continue;
      cache.set(userUuid, { at: Date.now(), scope });
      return scope;
    } finally {
      pending.delete(ticket);
      if (pending.size === 0 && pendingLoads.get(userUuid) === pending) {
        pendingLoads.delete(userUuid);
      }
    }
  }
  throw httpError(503, 'scope changed during read');
}

function invalidateScope(userUuid) {
  if (userUuid) {
    cache.delete(userUuid);
    const pending = pendingLoads.get(userUuid);
    if (pending) for (const ticket of pending) ticket.invalidated = true;
    return;
  }
  cache.clear();
  for (const pending of pendingLoads.values()) {
    for (const ticket of pending) ticket.invalidated = true;
  }
}

async function assertAuthenticatedRole(db, auth, role, options) {
  if (!auth || !Number.isFinite(Number(auth.userId)) ||
      !String(auth.username || '').trim()) {
    throw httpError(401, 'Unauthorized');
  }
  let user;
  try {
    user = await db.get(
      'SELECT id, username, role, disabled_at, user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1',
      [Number(auth.userId), String(auth.username).trim()]
    );
  } catch (error) {
    const unavailable = httpError(500, 'authorization database read failed');
    unavailable.cause = error;
    throw unavailable;
  }
  if (!user || !user.user_uuid) throw httpError(401, 'Unauthorized');
  if (!isScopedMode() && (!options || options.scopedMode !== true)) {
    return {
      role: 'admin', disabled: false, wildcard: true,
      zoneUuids: null, plotUuids: null,
    };
  }
  if (user.disabled_at) throw httpError(403, 'account disabled');
  if (user.role !== role) throw httpError(403, 'insufficient role');
  return {
    role: user.role,
    username: user.username,
    disabled: false,
    wildcard: false,
    zoneUuids: null,
    plotUuids: null,
  };
}

function _resetForTests() {
  invalidateScope();
}
```

`authorizeAdminRead` keeps its existing body: token verification occurs before constructing `Database`, then `try/finally` closes via the callback facade. The new `assertAuthenticatedRole` runs one parameterized user query inside that handle. A rejection from `db.get` is wrapped with status 500 and the original error as `cause`; `close` still runs. A close callback error still warns and does not replace the authorization result. This is compatibility with the pinned facade, whose `get` returns a Promise and whose `close` accepts a callback. Do not use synchronous `DatabaseSync` methods in product code.

The `pendingLoads` map holds tickets only while calls await `loadScope`. Per-user invalidation marks exactly that user's pending tickets. Global invalidation marks all pending tickets. A post-invalidation load gets an unmarked ticket even if an earlier load is still waiting. The old load cannot overwrite a new result: its ticket remains marked, its first completion is discarded, and the bounded retry reads the new cached entry or reloads. The `finally` removes tickets after success, error, or retry; the map does not accumulate one entry per invalidated user. There is no `await` between checking a ticket and publishing/returning its scope.

### Literal before text at B and the guarded stage editor

Nobody applies these edits by hand. The stage editor (asset `stage-editor` at the end of this plan) reads each marked block from the committed plan bytes, requires every `before` block to occur exactly once in its target, and checks the SHA-256 of every input file and every output file against the pins it carries before it writes. At B both helper copies have SHA-256 `5c652cf6c7d7ca8f7cc6bf242f5edcb8de6e7fd37f05bee88ce00d93393af63c`.

The `product-helper` block above holds five declarations separated by blank lines. The editor inserts the first, `const pendingLoads = new Map();`, on the line after `const cache = new Map();` and replaces each of the four B blocks below with the matching declaration.

<!-- asset:before-resolveScope -->
```js
async function resolveScope(db, userUuid, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) {
    return {
      role: 'admin',
      disabled: false,
      wildcard: true,
      zoneUuids: null,
      plotUuids: null,
    };
  }
  const hit = cache.get(userUuid);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scope;
  const scope = await loadScope(db, userUuid);
  cache.set(userUuid, { at: Date.now(), scope });
  return scope;
}
```

<!-- asset:before-invalidateScope -->
```js
function invalidateScope(userUuid) {
  if (userUuid) cache.delete(userUuid);
  else cache.clear();
}
```

<!-- asset:before-assertAuthenticatedRole -->
```js
async function assertAuthenticatedRole(db, auth, role, options) {
  if (!auth || !Number.isFinite(Number(auth.userId)) || !String(auth.username || '').trim()) {
    throw httpError(401, 'Unauthorized');
  }
  const user = await db.get(
    'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1',
    [Number(auth.userId), String(auth.username).trim()]
  );
  if (!user || !user.user_uuid) throw httpError(401, 'Unauthorized');
  return assertRole(db, user.user_uuid, role, options);
}
```

<!-- asset:before-resetForTests -->
```js
function _resetForTests() {
  cache.clear();
}
```

The history contract pin later in this plan is printed without indentation. In the file it sits inside `verifyHistoryRouterImplementation` with two-space indentation, so the editor replaces the B line with this indented form of the same text:

<!-- asset:before-contract-pin -->
```js
  assertContains(failures, adapterSource, "assertRole(db, user.user_uuid, 'admin', { scopedMode: true })", 'gateway history stays admin-only (P2)');
```

<!-- asset:contract-pin -->
```js
  assertContains(failures, adapterSource,
    "assertAuthenticatedRole(db, principal, 'admin', { scopedMode: true })",
    'gateway history uses fresh token-bound admin role (P2)');
```

In `history-api-router-fn` only, replace the exact line

```js
await scope.assertRole(db, user.user_uuid, 'admin', { scopedMode: true });
```

with

```js
await scope.assertAuthenticatedRole(db, principal, 'admin', { scopedMode: true });
```

Delete the immediately preceding comment `// P2: gateway-wide history stays admin-only.` so that this function node shrinks despite the longer call. Keep the preceding `SELECT user_uuid, disabled_at`, the `!user || user.disabled_at` refusal, and `scopeRouteForRequest` unchanged. In `scripts/verify-history-api-contract.js`, replace its one old literal pin with the exact new call string and change its description to `gateway history uses fresh token-bound admin role (P2)`. Do not weaken or remove the pin. The scope-guard probe must still see a helper decision on gateway routes.

At B the comment and the call are lines 388 and 389 of the 65,149-character function body, unchanged from N. Removing the comment line and lengthening the call changes the body by −42 characters, to 65,107. The size ratchet compares against B, so this edit needs no allowance. The stage editor's `check-flows` mode pins the SHA-256 of both edited `flows.json` files.

For future flow editing, use a one-shot JSON parser/editor in the isolated worktree. First assert that `JSON.stringify(JSON.parse(original), null, 2) + '\n'` is byte-identical for each profile; abort otherwise. Assert exactly one `history-api-router-fn`, exactly one old call line, and exactly one preceding comment; replace them in memory, serialize the canonical profile, and copy those exact bytes to bcm2709. Assert that the result changes only `func` for that ID and that its character count is no greater than the pinned original. No flow-size allowance is proposed. If a refreshed base makes the node grow, stop for reviewed scope/allowance amendment; never add a broad total allowance by guess. Mirror helper, helper tests, and system-settings API/test files byte-for-byte where edited.

## Future test specification

All cases below are forecasts, not executed results. Use actual helper imports from each maintained profile and real `DatabaseSync(':memory:')` as backing storage. The test facade must expose Promise-returning `get(sql, params)` and `all(sql, params)`, and callback `close(cb)`, matching `osi-db-helper`. Each `get` and `all` records SQL and a copy of the bound parameter array before returning. In the race cases, the facade executes `raw.prepare(sql).get(...params)` first, captures that row, signals a one-shot `entered` Promise, and only then awaits a test-controlled `release` Promise. The pause applies to exactly the selected users query; a later load must remain runnable. Never hold a database transaction across the barrier. Use `finally` to release every gate, restore `Date.now`, call `_resetForTests`, and close the disposable raw database. No live Node-RED, real fan, reboot, network, or persistent DB is involved.

Use this fixture shape in the mirrored helper tests. It deliberately keeps the disposable raw connection open when `close(cb)` is called, as the coordinator's saved probe did, so sequential authorizations can inspect one mutable in-memory database. The production facade still owns its real handle; this is only a test adapter. `all` must execute real SQL rather than returning `[]`, so an accidental zone/plot query is counted and exercised.

<!-- asset:helper-test-fixture -->
```js
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function observedFacade(raw) {
  const calls = [];
  const gates = [];
  let nextGetError = null;
  let closeError = null;
  let closeCount = 0;
  return {
    calls,
    get closeCount() { return closeCount; },
    pauseNextScopeUserGet() {
      const entered = deferred();
      const release = deferred();
      gates.push({ entered, release });
      return { entered: entered.promise, release: () => release.resolve() };
    },
    rejectNextGet(error) { nextGetError = error; },
    failClose(error) { closeError = error; },
    async get(sql, params = []) {
      calls.push({ method: 'get', sql, params: [...params] });
      if (nextGetError) {
        const error = nextGetError;
        nextGetError = null;
        throw error;
      }
      const row = raw.prepare(sql).get(...params);
      if (sql === 'SELECT id, username, role, disabled_at, user_uuid FROM users WHERE user_uuid = ?' && gates.length) {
        const gate = gates.shift();
        gate.entered.resolve(row);
        await gate.release.promise;
      }
      return row;
    },
    async all(sql, params = []) {
      calls.push({ method: 'all', sql, params: [...params] });
      return raw.prepare(sql).all(...params);
    },
    close(callback) {
      closeCount += 1;
      callback(closeError);
    },
  };
}

function signedToken(userId, username, secret, exp = Date.now() + 60000) {
  const payload = Buffer.from(JSON.stringify({ userId, username, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return 'Bearer ' + payload + '.' + signature;
}
```

Create minimal real SQLite tables with the exact columns `users(id, username, role, disabled_at, user_uuid)`, `irrigation_zones(user_id, deleted_at, zone_uuid)`, `user_zone_assignments(user_uuid, deleted_at, zone_uuid)`, `journal_plots(owner_user_uuid, deleted_at, plot_uuid)`, and `user_plot_assignments(user_uuid, deleted_at, plot_uuid)`. Insert `id=7, username='admin', role='admin', disabled_at=NULL, user_uuid='u-admin'` plus a second user for H11. The four scope tables may start empty. For each `authorizeAdminRead` call use `Database: function Database() { return observed; }`, `authorization: signedToken(7, 'admin', secret)`, and `configuredSecret: secret`. Count only calls recorded between the start and end of that authorization; fixture setup statements are outside the count. For each race, await `gate.entered`, mutate the raw row, invalidate, and call `gate.release()` in `finally` even if an assertion fails.

Add exactly twelve named tests to the existing `osi-scope-helper/index.test.js` in each profile. Current pinned source has 25 top-level tests, so the intended source count is 37 per profile after this addition. Replace the two existing tests with the exact bodies below in **both** files; their assertions and test names stay the same, and the one-row `get` fixture now supplies all five selected columns. These are fixture corrections, not extra tests. Run the two profile files separately to avoid sharing module cache or clock override in one process.

| ID | Test and meaningful assertions | Base/negative control |
|---|---|---|
| H1 | Warm `resolveScope` as admin, change `users.role` to `viewer` without invalidation, call `authorizeAdminRead`; assert 403, zero scope-table reads, and one close. | Base authorizes. Restoring the `assertRole` call inside `assertAuthenticatedRole` must make it authorize again. |
| H2 | Independently warm admin then set `disabled_at`, assert 403; clear it while role remains admin, assert success on the next request. Repeat admin restoration after a viewer denial. | Base authorizes the disabled admin in the first phase; removing the fresh query must reintroduce that wrong result. The restoration assertions are compatibility controls. |
| H3 | Valid admin call returns `role='admin'`, matching `username`, `wildcard=false`, and null zone/plot sets. Record exactly one `get`, zero `all`, exact SQL text above, and exact params `[7, 'admin']`; repeat with a warm cache and assert the same counts. | Base makes two users `get`s plus four `all`s on a miss. Adding a scope-table load to the new helper fails the statement-count oracle. |
| H4 | Signed token matrix: missing header, malformed two-part token, forged signature, expired token each yields 401 and constructs no DB handle; valid token with missing row, stale username, wrong numeric ID, or row lacking `user_uuid` yields 401 after one bound query and one close. | Base passes the four invalid-token cases, then fails the first valid-token case (missing row) at the SQL equality: B records `SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1`. Removing token verification or either SQL identity predicate makes a listed case succeed. No new stricter ID grammar is asserted. |
| H5 | Enabled `viewer`, `researcher`, and unrecognized role each yields 403; a disabled admin yields 403. All make one users query, no `all`, and one close. | Base returns 403 in the first (viewer) case, then fails the call-list assertion: B records its identity `get`, a `user_uuid` lookup `get` and four scope-table `all`s, not one bound `get`. Replacing the role equality with a viewer-only denylist admits the unrecognized role. |
| H6 | Make `get` reject with a sentinel `Error('fixture-read-failed')`; assert the caller receives status/statusCode 500 with that identical sentinel as `cause`, no `all`, one close, and a subsequent successful call performs its own fresh `get`. Separately make `close(cb)` report a sentinel error; assert exactly one warning while the valid authorization result remains successful, matching the pinned warning policy. | Base fails the first `assert.rejects` predicate: B's `assertAuthenticatedRole` has no catch, so `authorizeAdminRead` closes the handle and rethrows the plain sentinel, with no status 500 and no `cause`. Swallowing query failures, defaulting them to 403, or dropping `finally` fails. Turning a close warning into a silent success without calling `close` also fails the close count. |
| H7 | Capture an old admin row, invalidate its UUID, change DB role to viewer, release; assert the original waiting `resolveScope` resolves viewer, not admin, and a following call returns viewer without another users query. | Base returns and caches admin; removing per-user ticket marking reproduces that result. |
| H8 | Repeat H7 with `invalidateScope()` and disabled admin; assert original waiting call resolves disabled and following `assertRole` rejects 403. | Base returns/caches enabled admin; removing global ticket marking reproduces it. |
| H9 | For each invalidation kind, pause old admin load, mutate to viewer, invalidate, complete a new load first, then release old. Assert new result stays cached and old waiter receives viewer; exact users-query count is two before old completion and still two after old retry consumes the new cache. | Base old completion overwrites the new cache. Removing the ticket check fails both orderings. |
| H10 | Gate first and second loads; invalidate after the first captured row and release it, then race the original request's settlement against the second barrier: the retry must reach the second barrier first. Invalidate again and release; assert status/statusCode 503, exactly two user loads, no stale cache publication, and a third independent call sees the current row through one new `get`. Ticket cleanup is also established by the literal `finally` and reviewer inspection; success alone does not prove map cleanup. | Base settles the original request on the first release, so the race assertion fails (`'settled'` where `'retried'` is required) before any 503 check and without waiting; dropping per-user marking (M2) or the ticket check (M4) fails the same assertion. A third attempt (M5) loads unpaused and resolves, failing `assert.rejects`. |
| H11 | Start two same-user cache misses with separate one-shot barriers; invalidate while both are pending. Assert both old rows are discarded and both callers see current role. In a separate two-user case, per-user invalidation reloads A but B remains the same cached object with no new users query; global invalidation reloads both. | Marking only one ticket, clearing unrelated keys, or omitting global clear fails specific counts/identity assertions. |
| H12 | With `Date.now` temporarily controlled in this nonparallel test, assert a cache hit before 30,000 ms, reload at exactly 30,000 ms, and no cache entry after a rejected load. Assert `resolveScope(..., {scopedMode:false})` gives wildcard admin with zero DB calls when `OSI_SCOPED_ACCESS` is unset. | Changing TTL boundary, caching an error, or making flag-off query the DB fails. Restore the clock in `finally`. |

Add six top-level route tests to the existing CI-discovered `scripts/test-scoped-access-writes.js` (101 top-level tests at B, proposed source count 107). For each test, iterate both profile flow JSON files with `loadNode(id, flowsPath)`, import the corresponding scope helper, and pass `osiLibModules: { scope: helper }` to `executeFunction`. `seedScopedDb()` and `facadeDb()` in `scripts/lib/scoped-access-harness.js` already provide actual function bodies and a Promise/callback SQLite facade. Warm the helper cache, mutate the disposable DB directly *without* invalidation for the stale-role cases, and use `_resetForTests` only in setup/finally, not between warmup and request. Match each route's two-output result rather than assuming every node returns one `msg`.

| ID | Route assertions | Base/negative control |
|---|---|---|
| R1 | Each of the ten `authorizeAdminRead` guards: admin warmup passes; after viewer demotion, its denied output is 403 and success output is null; after reset, disabled admin also denies. Cover account link, unlink, database download, sync state, system stats, field-test export, force sync, gateway location, rollup run, and outbox recovery. For outbox recovery, assert no `_recoveryActor` on denial and the current username on allowed admin. | Base warm cache lets protected output through. Reverting the helper to cached role fails the matrix. |
| R2 | Reboot and fan, for each profile: warm admin then demote and separately disable; response is 403, reboot scheduler spy receives zero calls, and fake fan filesystem records zero writes. Inject one rejected `roleDb.get` and assert HTTP 500 with the same zero side-effect counts. Allowed admin still reaches the planned response; use fake `cp` and fake fan paths only. | Base schedules reboot or reaches fan control after demotion and reports a raw query failure as 403. Moving authorization after side effects fails spies. |
| R3 | Account-link status, improvement-request list GET and diagnostics-preview GET: after warm admin demotion/disable, assert 403 and no status/request/diagnostic rows. An enabled viewer can still POST an improvement request with `type:'bug'`, `severity:'annoying'`, `area:'system'`, a 3–80 character title, a 10–4000 character description, `consent_public:true`, and `consent_diagnostics:false`; a disabled viewer cannot. Assert resulting row count, not only HTTP status. | Base exposes admin GETs. Applying admin-only role to POST fails the enabled-viewer control. |
| R4 | History gateway GET plus gateway preference PUT and opened POST, using the actual `history-api-router-fn`: a warm-cache demoted admin gets 403 before any history data/write. A disabled admin also gets 403 through the already-fresh `disabled_at` check. A current admin passes the role gate. A separate zone-history read by an enabled non-admin stays account-wide, and workspace rows remain filtered by `user_id`. | Base gateway path permits a cached **demoted** admin; the disabled case is a base-passing control. Removing the route's helper decision fails `verify-scoped-access`; adding a role gate to zone reads fails the control. |
| R5 | Through actual `scoped-admin-account-router`, use a second admin so last-admin protection is not tripped. Warm target cache, apply `PUT /api/users/:uuid/role` with `{role:'viewer'}` and `PUT /api/users/:uuid/disabled` with `{disabled:true}`, then assert target's `resolveScope` reloads changed state; restore role and re-enable through the same route and assert fresh state. Verify mutation response and DB row before checking cache; do not use `adminApi` helper because it resets cache per call. For global invalidation use a **separate** DB: seed two enabled admins, one with the contract UUID `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, role `admin`, `sync_version=1`, and username `field-user`. Copy the `UPSERT_SCOPED_USER` envelope and transaction facade from pinned `osi-scoped-access-commands/index.test.js`, set `base_sync_version:1`, matching `effect_key` suffix `:1`, and incoming role `viewer`; pass `runtime.scope_helper` as the profile helper. Pause that user's pre-command load after capturing its admin row, apply the command and assert `ack.result === 'APPLIED'` and persisted viewer role, then release and assert the original waiter and cache see viewer. A `CONFLICT` ACK must not change the row or invalidate; the shipped replay of a stored `APPLIED` ACK does invalidate again, so assert that behavior as a compatibility control. | Removing the admin mutation's `invalidateScope` call leaves warm cached state; removing the command helper's global invalidation lets the pending old result publish. |
| R6 | Flag-off for both profiles: all ten guard nodes pass through a valid bearer as they did before; reboot/fan still verify bearer but never call the scope module; system-settings flag-off PUT accepts a valid viewer and GET remains open to an authenticated viewer. Invalid bearer still denies where the shipped route requires one. Assert a throwing scope-loader spy is never called in each flag-off path. | An unconditional scope call fails the spy. Removing bearer auth makes the invalid-token control fail. |

Add one focused test to `osi-system-settings/api.test.js` in each profile (50 current top-level tests, proposed 51): warm the scope cache as admin in the same module instance, demote then attempt scoped PUT and assert 403 plus unchanged `app_settings`; restore admin and assert PUT 200 plus the requested row. The existing GET-viewer and flag-off PUT tests remain controls. Avoid `TestDatabase` handles sharing a closed `DatabaseSync`; use the file-backed disposable DB and the existing per-call facade. Revert-to-cached-role must make the demoted PUT write. The profile files are mirrored.

Update the existing static pin in `scripts/verify-history-api-contract.js` and export `verifyHistoryRouterImplementation` alongside its existing `verifyAnalysisRouterImplementation` export. Add one mutation assertion to its CI-discovered `scripts/verify-history-api-contract.test.js` (2 current top-level tests, proposed 3): import `verifyHistoryRouterImplementation`, pass an in-memory flow copy, a `failures` array, and the pinned `osi-history-router/index.js` source; remove or revert the fresh gateway call in that copy and assert `failures` contains `gateway history uses fresh token-bound admin role (P2)`. The unmodified copy must produce no such failure. Do not count the literal pin alone as R4 behavioral evidence; R4 executes the route.

Integration seam: open draft PR #561 (#436, head `5bdf01e94a5b9c9f330d497301dee8834eb8e930`, based on `f6682ef6`) adds `verifyZoneCsvResponseContract` to the same export line and import block, and four tests to this test file. Whichever change lands second merges both export names and both imports, and the test file then has 7 top-level tests. This plan does not compose #561's edits.

No new test file or workflow discovery entry is proposed.

### CI dependency accounting

The changed surface is: the helper functions `resolveScope`, `invalidateScope`, `assertAuthenticatedRole` and `_resetForTests` (and through them `assertRole`, `assertEnabledAccount`, `isAdmin` and `authorizeAdminRead`); the `history-api-router-fn` body; and `scripts/verify-history-api-contract.js`. `loadScope`, `freshScope`, every `assertFresh*` function, `canMutate`, `verifyBearer`, `isScopedMode` and `resolveAuthSecret` are byte-unchanged. A CI test that loads the real helper but calls only those exercises module loading, not the change.

Method. A wrapped audit read every workflow file and every code blob at B as data and split them into 429 shell command segments (283 name code files; one `2>&1` redirection token is recorded as a parse artifact, not a file). For each file it built a conservative input graph: literal requires, literal `path.join`/`path.resolve` arguments with both profiles substituted into templated paths, osi-lib registry names, flow node ids named as string literals together with each node's own `osiLib.require` names, shell scripts, and spawned children named by literals. The eighteen children that `verify-sync-flow.js` spawns (ten through `execFileSync`, six through `runQuietNodeScript`, two through `spawnSync`) were added as entries; the disposition script asserts that this list equals the set the file spawns. An earlier run of that script stopped on this assertion because the list lacked four `runQuietNodeScript` children; the receipt is kept. The graph over-approximates: through module literals it reaches the helper from 205 files. The author then read every file with local evidence (a changed-node id literal or a changed-helper call in the file or in the `scripts/` files it requires, two hops) and recorded what it reaches. Every file without such evidence is excluded by class; the disposition script fails if a file has local evidence but no recorded disposition. This audit reads source; it does not show that any test path executes.

Limits. The graph does not evaluate computed module names or computed node ids. Two harness facts close the computed cases that matter here: `scripts/lib/scoped-access-harness.js` loads a node-red module only when an executed node asks osi-lib for it and the test supplied no override, and `scripts/lib/flow-node-harness.js` maps `scope` to a nonexistent `osi-scope` directory, so tests on that harness never load the real helper. Flag-off executions do not request `scope` at all (the hermetic flag-off verifier is a gate). The two AJV-dependent contract tests are not among the planned commands, so no `npm ci --prefix scripts` step is needed. Node 22 and the `sqlite3` CLI are required, as in CI.

Audit assets, in the campaign report directory `issue-434-current-base-plan-r2/_work/` (observed digests, not execution credentials): `ci-audit.json` `71661fd35a6f1bafea31dacd85afba266062f82a2eeb3867991539002d11651a`, `ci-classify.json` `29ec9b7ef5579c55b3bf2f5e6a3083080325997dd765b883597b620adee6e6f9`, `ci-inventory.json` `6d247e3ab2a12859fe7ee24489e12b9931203ed4749af1a8cd4f798bb676345c`. The inventory holds each file's CI command lines, closure class, disposition and, for exclusions, the helper chain the graph found.

The 23 regression controls, each in its CI form (a single-file subset where CI lists several files in one step; `node --test` runs each file in its own process, so the subset changes nothing for that file):

| Label | Evidence class | What it reaches at B (author read) | CI step |
|---|---|---|---|
| `x-auth-recovery` | changed path | bootstrap-auth-harness loads the real bcm2712 helper (line 14) and injects it as osiLib scope; f.account() runs scoped-admin-account-router (invalidateScope) with OSI_SCOPED_ACCESS=1; the spawned account-recovery.js child loads lib/account-recovery-transaction.js and the sqlite3/bcryptjs fixtures through resolve.cjs, none of which loads the scope helper | `migrations.yml`, same argv |
| `x-rain-history` | changed path | flag-on rain-history-fn through the scoped-access harness with no scope override: harness loads the real helper; assertEnabledAccount -> resolveScope | `migrations.yml`, same argv |
| `x-policy-api` | changed path | requires the real helper and calls invalidateScope directly | `migrations.yml`, single-file subset |
| `x-analysis-discovery` | changed path | real helper; flag-on analysis-api-router-fn (assertEnabledAccount); _resetForTests | `migrations.yml`, single-file subset |
| `x-export-session` | changed path | real helper; flag-on fn_build_sensor_sql_params and strega-today-liters-fn (assertEnabledAccount); _resetForTests | `migrations.yml`, same argv |
| `x-all-zones-export` | changed path | passes the real helper to the portable all-zones export when scoped (portableAssertEnabledAccount -> assertEnabledAccount); _resetForTests | `migrations.yml`, same argv |
| `x-lifecycle-routes` | changed path | real helper; flag-on zone-command-apply-fn (invalidateScope); _resetForTests | `verify-sync-flow.yml`, same argv |
| `x-entity-create` | changed path | real helper; flag-on scoped-zone-create-router (invalidateScope) | `verify-sync-flow.yml`, single-file subset |
| `x-watermark-routes` | changed path | real helper; flag-on watermark-cal-fn (assertEnabledAccount); _resetForTests | `verify-sync-flow.yml`, same argv |
| `x-rain-source` | changed path | real helper; flag-on zone-rain-source-fn (assertEnabledAccount); _resetForTests | `verify-sync-flow.yml`, same argv |
| `x-journal-api` | changed path | passes the real helper as principal.scope (resolveScope) and calls invalidateScope | `field-journal.yml`, same argv |
| `x-network-api` | reset only | real helper; beforeEach _resetForTests; network API calls only verifyBearer, assertFreshDeviceAccess, canMutate (unchanged) | `verify-sync-flow.yml`, single-file subset |
| `x-reference-tree` | reset only | real helper; _resetForTests; executed nodes call no changed helper function | `verify-sync-flow.yml`, same argv |
| `x-context-isolation` | reset only | real helper; _resetForTests; executed nodes call no changed helper function | `verify-sync-flow.yml`, same argv |
| `x-journal-command` | reset only | real helper with OSI_SCOPED_ACCESS=1; _resetForTests; journal commands call only isScopedMode | `field-journal.yml`, same argv |
| `x-history-vectors` | router | executes the edited history-api-router-fn body flag-off against the golden cases | `history-router.yml`, same argv |
| `x-soil-projection` | router | imports capture-history-router-vectors and executes the edited history-api-router-fn body flag-off on soil-projection fixtures | `verify-sync-flow.yml`, same argv |
| `x-journal-bootstrap` | router | static assertions over history-api-router-fn text (auth secret resolution occurrences) | `field-journal.yml`, same argv |
| `x-installation-revision` | load only | lazy commands export loads the real helper; commands.js calls only assertFreshDeviceAccess (freshScope -> loadScope) and canMutate, all byte-unchanged | `verify-sync-flow.yml`, same argv |
| `x-entity-commands` | load only | real helper; commands.js calls assertFreshDeviceAccess, assertFreshZoneAccess, canMutate (unchanged); the test monkeypatches assertFreshDeviceAccess | `migrations.yml`, single-file subset |
| `x-credential-isolation` | load only | real helper as osiLib scope; auth nodes call only resolveAuthSecret (unchanged) | `migrations.yml`, single-file subset |
| `x-device-rename` | load only | real helper on flag-on device-rename-scope-guard, which calls only fresh helpers (unchanged) | `verify-sync-flow.yml`, single-file subset |
| `x-zone-rename` | load only | real helper on flag-on zone-rename-scope-guard, which calls only fresh helpers (unchanged) | `verify-sync-flow.yml`, single-file subset |

"Changed path" means the real helper is loaded and a changed function runs under scoped mode. "Reset only" means the only changed function that runs is `_resetForTests`. "Router" means the edited router body runs flag-off or its text is asserted. "Load only" means the real helper module loads inside a real consumer and only byte-unchanged exports run; these five check that the four replaced functions leave the other exports usable, and nothing more. None of the 23 is counted as evidence for the fresh-role or ticket behavior; that evidence is the focused helper, writes, settings, contract and outbox commands.

Repetitions, not extra coverage. `verify-sync-flow.js` (gate `sync-flow`) spawns `verify-history-api-contract.js --allow-missing-history`, `node --test verify-history-api-contract.test.js`, `verify-scoped-access.js` and, at its end, `verify-profile-parity.js`. Packet R1's direct `contract`, `scoped` and `parity` gates repeated those children, and its `bare-require` gate ran a scan that `verify-sync-flow.js` imports and ratchets; none of the four was a distinct control, and all four are dropped. The focused `contract` command remains because RED and GREEN must be read per file; inside `sync-flow` it is the same test run again. `x-history-vectors` and `x-soil-projection` both execute the router body through `capture-history-router-vectors.js`, on different fixtures. `helper-2709` and `settings-2709` are not CI commands; CI relies on `verify-profile-parity.js` for the bcm2709 copies, and these two run the mirrored files directly.

Removed from packet R1's control list, with the source reason: `x-osi-lib` (sets `OSI_LIB_BASE` to a temporary directory and asserts only `NAME_TO_PATH.scope`; its CI form is `node --test`, not the module runner), `x-writer-wrappers` (no scope module reaches a changed function), `x-command-path` (supplies `runtime.scope_helper` as a recording object literal), `x-no-conditional` (runs with `OSI_SCOPED_ACCESS=0`).

Exclusions by class (400 files). "graph-only": the conservative closure reaches the helper only through module literals, and neither the file nor its `scripts/` requires name a changed node or call a changed helper function. "no-reach": the closure reaches neither the helper, the edited router node nor the contract verifier. "stub", "flag-off", "registry-only", "no-scope-call" and "umbrella-child" carry a per-file reason in the inventory.

- **flag-off** (7): `scripts/test-dendro-rain-policy.js`, `scripts/test-sync-without-conditional-helper.js`, `scripts/test-zone-env-forecast-instants.js`, `scripts/test-zone-env-rain-policy.js`, `scripts/test-zone-env-unknown-rain.js`, `scripts/test-zone-update-sync-version.js`, `scripts/test-zone-weather-source.js`
- **graph-only** (150): `bcm2709/osi-journal/index.test.js`, `bcm2709/osi-module-defaults/index.test.js`, `bcm2712/osi-entity-name/index.test.js`, `bcm2712/osi-installation-location-helper/index.test.js`, `bcm2712/osi-journal-replication/index.test.js`, `bcm2712/osi-journal/index.test.js`, `bcm2712/osi-module-defaults/index.test.js`, `bcm2712/osi-valve-control/live-wrapper-4c2.test.js`, `bcm2712/osi-valve-control/unclaim.test.js`, `lib/osi-migrate/__tests__/add-column-compat.test.js`, `lib/osi-migrate/__tests__/fingerprint-refresh.test.js`, `lib/osi-migrate/__tests__/fingerprint-sort.test.js`, `lib/osi-migrate/__tests__/fingerprints-boot-rewrite-rehearsal.test.js`, `lib/osi-migrate/__tests__/fingerprints-sql-comments.test.js`, `lib/osi-migrate/__tests__/runner-additive.test.js`, `lib/osi-migrate/__tests__/runner-atomicity.test.js`, `lib/osi-migrate/__tests__/runner-boot-devices-rebuild-grace.test.js`, `lib/osi-migrate/__tests__/runner-boot-trigger-grace.test.js`, `lib/osi-migrate/__tests__/runner-corpus.test.js`, `lib/osi-migrate/__tests__/runner-data-risk.test.js`, `lib/osi-migrate/__tests__/runner-destructive.test.js`, `lib/osi-migrate/__tests__/runner-drift-preflight.test.js`, `lib/osi-migrate/__tests__/runner-fingerprint-scheme-upgrade.test.js`, `lib/osi-migrate/__tests__/runner-partial-batch-retry.test.js`, `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`, `lib/osi-migrate/__tests__/seed-replay.test.js`, `lib/osi-migrate/__tests__/verify-head-gap.test.js`, `scripts/baseline-existing-db.test.js`, `scripts/deploy-bundle.test.sh`, `scripts/deploy-command-ledger-dependency.test.js`, `scripts/deploy-corpus.test.js`, `scripts/deploy-fetch-list.test.js`, `scripts/deploy-local-server.test.js`, `scripts/deploy-payload-lifecycle.test.js`, `scripts/flows-bare-require-scan.test.js`, `scripts/flows-size-scan.test.js`, `scripts/migrate-cli.test.js`, `scripts/migrate-flows-journal-v2-replication.test.js`, `scripts/migration-caller-corpus.test.js`, `scripts/ops/rebuild-corpus.test.js`, `scripts/preview-sdi12-profile.test.js`, `scripts/reconcile-ledger-numbering.test.js`, `scripts/reconcile-ledger-scratch-cleanup.test.js`, `scripts/rehearse-devices-type-migration.test.js`, `scripts/rehearse-irrigation-calibration-sync.test.js`, `scripts/rehearse-ledger-cutover.test.js`, `scripts/rehearse-weather-station-zone-sync.test.js`, `scripts/restamp-fingerprints.test.js`, `scripts/soak/rig.test.js`, `scripts/soak/scenario-kill9-migration.test.js`, `scripts/test-account-link-legacy-cloud.js`, `scripts/test-chirpstack-env-file.js`, `scripts/test-clover-ingest-flow.js`, `scripts/test-conditional-irrigation-adapters.js`, `scripts/test-conditional-irrigation-clock-install.js`, `scripts/test-conditional-irrigation-fix5.js`, `scripts/test-conditional-irrigation-flow.js`, `scripts/test-conditional-irrigation-peer-convergence.js`, `scripts/test-conditional-irrigation-projection-tick.js`, `scripts/test-conditional-irrigation-review-fixes.js`, `scripts/test-conditional-irrigation-route.js`, `scripts/test-conditional-irrigation-schema.js`, `scripts/test-conditional-irrigation-sync-schema.js`, `scripts/test-conditional-irrigation-tick.js`, `scripts/test-conditional-irrigation-writer-guards.js`, `scripts/test-contract-schemas.js`, `scripts/test-delete-device-flow.js`, `scripts/test-dendro-rolling-7d-rain.js`, `scripts/test-deploy-atomic-payload-wiring.js`, `scripts/test-deploy-fresh-install.js`, `scripts/test-deploy-gateway-setup.js`, `scripts/test-deploy-init-log-check.js`, `scripts/test-deploy-migration-wiring.js`, `scripts/test-deploy-native-sqlite3.js`, `scripts/test-deploy-node-red-service-state.js`, `scripts/test-deploy-reconcile-probe.js`, `scripts/test-device-list-rain-day.js`, `scripts/test-force-sync-pending-after.js`, `scripts/test-gateway-eui-attribution.js`, `scripts/test-gateway-health-persistence.js`, `scripts/test-history-helper.js`, `scripts/test-journal-lifecycle.js`, `scripts/test-journal-perf-fixture.js`, `scripts/test-journal-v2-contract.js`, `scripts/test-journal-v2-media.js`, `scripts/test-journal-v2-replication.js`, `scripts/test-journal-v2-worker.js`, `scripts/test-legacy-upsert-zone-config.js`, `scripts/test-legacy-upsert-zone-name.js`, `scripts/test-lorain-dry-zone-row.js`, `scripts/test-lorain-ingest.js`, `scripts/test-lsn50-flow-only-zone-row.js`, `scripts/test-node-red-admin-root-off.js`, `scripts/test-outbox-retry-backoff.js`, `scripts/test-protected-config-command-dispatch-timeouts.test.js`, `scripts/test-protected-config-command-dispatch.js`, `scripts/test-radio-flow.js`, `scripts/test-radio-history-flow-integration.js`, `scripts/test-radio-history.js`, `scripts/test-rain-zone-days.js`, `scripts/test-s2120-rain-ingest.js`, `scripts/test-sdi12-registration.js`, `scripts/test-strega-gen2-reconcile.js`, `scripts/test-sync-health-honesty.js`, `scripts/test-sync-history-durable-flow.js`, `scripts/test-sync-history-durable-integration.js`, `scripts/test-sync-history-manifest-paging.js`, `scripts/test-sync-history-queue-drain.js`, `scripts/test-sync-outbox-json-guard.js`, `scripts/test-sync-rejection-recovery.js`, `scripts/test-task5b3-history.js`, `scripts/test-tensiomark-contract.js`, `scripts/test-tensiomark-precision.js`, `scripts/test-tensiomark-runtime.js`, `scripts/test-terra-zone-config-command-flow.js`, `scripts/test-upsert-sync-versioning.js`, `scripts/test-valve-actuation-bootstrap.js`, `scripts/test-valve-command-safety-path.js`, `scripts/test-valve-schedule-sync-triggers.js`, `scripts/test-valve-settings-sync-triggers.js`, `scripts/test-verify-flows-output-arity.js`, `scripts/test-watermark-calibration-bootstrap.js`, `scripts/test-watermark-cloud-command-path.js`, `scripts/test-watermark-contact-payload.js`, `scripts/test-watermark-ingest-flow.js`, `scripts/test-zone-agronomy-sync-triggers.js`, `scripts/test-zone-device-assignment-flow.js`, `scripts/test-zone-env-rain-quality-sync.js`, `scripts/test-zone-timezone-route.js`, `scripts/verify-command-ack-postconditions.js`, `scripts/verify-command-safety.js`, `scripts/verify-flows-output-arity.js`, `scripts/verify-flows-size-ratchet.test.js`, `scripts/verify-head-cli.test.js`, `scripts/verify-helper-registration.test.js`, `scripts/verify-module-file-deploy-coverage.js`, `scripts/verify-no-stray-ddl.js`, `scripts/verify-no-stray-ddl.test.js`, `scripts/verify-osi-lib-db-caller-binding.js`, `scripts/verify-osi-lib-db-caller-binding.test.js`, `scripts/verify-rename-swap-fence.js`, `scripts/verify-rename-swap-fence.test.js`, `scripts/verify-request-context-isolation.js`, `scripts/verify-s2120-gust-fix.js`, `scripts/verify-seed-db-ledger.js`, `scripts/verify-seed-replay.js`, `scripts/verify-sqlite-cli-limits.js`, `scripts/verify-strega-gen1.js`, `scripts/verify-sync-op-parity.js`, `scripts/verify-sync-op-parity.test.js`
- **no-reach** (228): `bcm2712/osi-agronomy-daily/et0.test.js`, `bcm2712/osi-agronomy-daily/facade-contract.test.js`, `bcm2712/osi-agronomy-daily/index.test.js`, `bcm2712/osi-chirpstack-helper/index.test.js`, `bcm2712/osi-command-ledger/index.test.js`, `bcm2712/osi-crop-kc/index.test.js`, `bcm2712/osi-db-integrity/index.test.js`, `bcm2712/osi-dendro-analytics/index.test.js`, `bcm2712/osi-device-commands/weather.test.js`, `bcm2712/osi-device-writer/facade-contract.test.js`, `bcm2712/osi-device-writer/index.test.js`, `bcm2712/osi-history-helper/analysis.test.js`, `bcm2712/osi-history-helper/device-sources.test.js`, `bcm2712/osi-history-helper/index.test.js`, `bcm2712/osi-history-router/index.test.js`, `bcm2712/osi-irrigation-policy/clock.test.js`, `bcm2712/osi-irrigation-policy/evaluate.test.js`, `bcm2712/osi-irrigation-policy/lifecycle.test.js`, `bcm2712/osi-irrigation-policy/model.test.js`, `bcm2712/osi-irrigation-policy/observations.test.js`, `bcm2712/osi-irrigation-policy/occurrences.test.js`, `bcm2712/osi-irrigation-policy/replication.test.js`, `bcm2712/osi-irrigation-policy/store.test.js`, `bcm2712/osi-irrigation-policy/worker.test.js`, `bcm2712/osi-journal-replication/canonicalization.test.js`, `bcm2712/osi-lsn50-normalize/index.test.js`, `bcm2712/osi-matric-potential/index.test.js`, `bcm2712/osi-radio-helper/fieldtester.test.js`, `bcm2712/osi-radio-helper/index.test.js`, `bcm2712/osi-rain/facade-contract.test.js`, `bcm2712/osi-rain/index.test.js`, `bcm2712/osi-sdi12-commissioning/index.test.js`, `bcm2712/osi-sdi12-normalize/configuration.test.js`, `bcm2712/osi-sdi12-normalize/index.test.js`, `bcm2712/osi-sdi12-normalize/tensiomark-live.test.js`, `bcm2712/osi-sdi12-normalize/tensiomark.test.js`, `bcm2712/osi-sdi12-reassemble/index.test.js`, `bcm2712/osi-sdi12-recipe/index.test.js`, `bcm2712/osi-station-hours/facade-contract.test.js`, `bcm2712/osi-station-hours/index.test.js`, `bcm2712/osi-sync-protocol-state/index.test.js`, `bcm2712/osi-sync-protocol-state/protocol-verbs.test.js`, `bcm2712/osi-uc512-normalize/index.test.js`, `bcm2712/osi-uplink-dedup-guard/index.test.js`, `bcm2712/osi-valve-control/ack.test.js`, `bcm2712/osi-valve-control/api.test.js`, `bcm2712/osi-valve-control/cancel.test.js`, `bcm2712/osi-valve-control/cloud-commands.test.js`, `bcm2712/osi-valve-control/composition-4c2.test.js`, `bcm2712/osi-valve-control/dispatch.test.js`, `bcm2712/osi-valve-control/effects-safety-dispatch.test.js`, `bcm2712/osi-valve-control/effects-safety.test.js`, `bcm2712/osi-valve-control/effects.test.js`, `bcm2712/osi-valve-control/lifecycle-clear.test.js`, `bcm2712/osi-valve-control/plan.test.js`, `bcm2712/osi-valve-control/push.test.js`, `bcm2712/osi-valve-control/runtime.test.js`, `bcm2712/osi-valve-control/store.test.js`, `bcm2712/osi-valve-control/test-helpers.test.js`, `bcm2712/osi-valve-control/workers.test.js`, `bcm2712/osi-valve-control/writer-integration.test.js`, `bcm2712/osi-watermark-helper/commands.test.js`, `bcm2712/osi-watermark-helper/conversion.test.js`, `bcm2712/osi-watermark-helper/store.test.js`, `bcm2712/osi-weather-provider/facade-contract.test.js`, `bcm2712/osi-weather-provider/index.test.js`, `bcm2712/osi-zone-env/index.test.js`, `lib/osi-migrate/__tests__/backup.test.js`, `lib/osi-migrate/__tests__/fingerprints-gateway-eui.test.js`, `lib/osi-migrate/__tests__/fingerprints.test.js`, `lib/osi-migrate/__tests__/ledger-fixes.test.js`, `lib/osi-migrate/__tests__/ledger.test.js`, `lib/osi-migrate/__tests__/migration-manifest.test.js`, `lib/osi-migrate/__tests__/migrations-loader.test.js`, `lib/osi-migrate/__tests__/runner-iface.test.js`, `lib/osi-migrate/__tests__/sql-normalize.test.js`, `scripts/calibrate-lux-radiation.test.js`, `scripts/capture-dendro-analytics-vectors.js`, `scripts/check-sdi12-capture.test.js`, `scripts/check-sync-parity.test.js`, `scripts/deploy-canary-gate.test.js`, `scripts/deploy-payload-swap.test.js`, `scripts/diagnose-sensor-history-gap.test.js`, `scripts/export-journal-catalog.js`, `scripts/fixtures/device-integration/uc512/codec.test.js`, `scripts/gen-devices-columns.test.js`, `scripts/generate-journal-catalog.js`, `scripts/generate-sync-trigger-source.js`, `scripts/helpers/test-owned-scratch.js`, `scripts/hooks/pre-push-doc-hygiene.test.js`, `scripts/installation-recovery-adapter.test.js`, `scripts/migrate-flows-journal-generators.test.js`, `scripts/preview-sdi12-converter.test.js`, `scripts/preview-sdi12-exchange.test.js`, `scripts/preview-sdi12-recipe.test.js`, `scripts/rehearse-devices-rebuild.test.js`, `scripts/rehearse-scoped-access-migration.test.js`, `scripts/rehearse-scoped-trigger-boot-survival.test.js`, `scripts/rehearse-watermark-cloud-parity-migration.test.js`, `scripts/repair-sync-outbox-v2.test.js`, `scripts/repair-watermark-clipped.test.js`, `scripts/repair-watermark-unsettled.test.js`, `scripts/replay-sdi12-transport.test.js`, `scripts/requeue-rejected-outbox-policy.test.js`, `scripts/requeue-rejected-outbox.test.js`, `scripts/run-module-tests.js`, `scripts/run-module-tests.test.js`, `scripts/semantic-schema-compare.test.js`, `scripts/soak/scenario-clock-jump.test.js`, `scripts/soak/scenario-outbox-replay.test.js`, `scripts/soak/scenario-sd-full.test.js`, `scripts/sync-protocol-capability-cli.test.js`, `scripts/test-apply-chameleon-calibration-seed.js`, `scripts/test-assess-s2120-rain-history.js`, `scripts/test-audit-schema.js`, `scripts/test-chirpstack-bootstrap-clover.js`, `scripts/test-command-ack-mark-delivered.js`, `scripts/test-conditional-irrigation-5b1.js`, `scripts/test-conditional-irrigation-clock.js`, `scripts/test-conditional-irrigation-command-boundary.js`, `scripts/test-conditional-irrigation-command-boundary.test.js`, `scripts/test-conditional-irrigation-contract.js`, `scripts/test-conditional-irrigation-conversion.js`, `scripts/test-conditional-irrigation-integration.js`, `scripts/test-conditional-irrigation-transport.js`, `scripts/test-crash-loop-escalation.js`, `scripts/test-dendro-contract.js`, `scripts/test-error-recording-flow.js`, `scripts/test-export-journal-catalog.js`, `scripts/test-gateway-identity-helper.sh`, `scripts/test-health-helper.js`, `scripts/test-history-recorded-at-formats.js`, `scripts/test-history-source-v2.js`, `scripts/test-improvement-requests-schema.js`, `scripts/test-installation-helper.js`, `scripts/test-installation-recovery-flow.js`, `scripts/test-installation-recovery-schema.js`, `scripts/test-journal-catalog-generator.js`, `scripts/test-journal-schema.js`, `scripts/test-journal-v2-canonicalization.js`, `scripts/test-journal-v2-config.js`, `scripts/test-journal-v2-init-startup.js`, `scripts/test-journal-v2-plot-group-migration.js`, `scripts/test-lorain-ingest-concurrency.js`, `scripts/test-lorain-rain-contract.js`, `scripts/test-lsn50-counter-concurrency.js`, `scripts/test-migration-helpers.js`, `scripts/test-node-red-init-cloud-broker.sh`, `scripts/test-osi-db-helper-read-snapshot.js`, `scripts/test-osi-identityd.sh`, `scripts/test-outbox-retention.js`, `scripts/test-protected-command-replay-chain.js`, `scripts/test-radio-chirpstack.js`, `scripts/test-radio-restore-guards.js`, `scripts/test-radio-store.js`, `scripts/test-rain-history-diff.js`, `scripts/test-rejection-recovery-contract.js`, `scripts/test-rejection-recovery-transaction-queue.js`, `scripts/test-repair-tensiomark-history.js`, `scripts/test-s2120-ingest-concurrency.js`, `scripts/test-scheduler-clock-jump.js`, `scripts/test-sdi12-bench-capture.js`, `scripts/test-sdi12-converter-lab.js`, `scripts/test-sdi12-protocol-lab.js`, `scripts/test-sdi12-recipe-schema.js`, `scripts/test-sdi12-sensor-recipes.js`, `scripts/test-sdi12-transport-lab.js`, `scripts/test-sentek-vwc-vic-schema.js`, `scripts/test-shared-agronomy-locales.js`, `scripts/test-stage-started-on-migration.js`, `scripts/test-strega-reconciliation-observed-events.js`, `scripts/test-sync-history-schema.js`, `scripts/test-sync-history-worker.js`, `scripts/test-sync-token-refresh-window.js`, `scripts/test-sync-trigger-source.js`, `scripts/test-tensiomark-schema.js`, `scripts/test-timestamp-clamp.js`, `scripts/test-unified-soil-tension-scheduler.js`, `scripts/test-valve-ack-time-selector.test.js`, `scripts/test-verify-history-uplot-vendor.sh`, `scripts/test-watermark-cloud-command-auth.js`, `scripts/test-work-request-status-idempotency.js`, `scripts/verify-agents-size.js`, `scripts/verify-agents-size.test.js`, `scripts/verify-agronomy-contract.js`, `scripts/verify-agroscope-linkage.js`, `scripts/verify-boot-ddl-interpolation.js`, `scripts/verify-boot-ddl-interpolation.test.js`, `scripts/verify-chameleon-calibration.js`, `scripts/verify-channel-manifest-parity.js`, `scripts/verify-channel-manifest-parity.test.js`, `scripts/verify-codec-robustness.js`, `scripts/verify-communication-contract.js`, `scripts/verify-db-schema-consistency.js`, `scripts/verify-dendro-contract-mirror.js`, `scripts/verify-dendro-contract-mirror.test.js`, `scripts/verify-device-integration.js`, `scripts/verify-devices-rebuild-fence.js`, `scripts/verify-devices-rebuild-fence.test.js`, `scripts/verify-doc-hygiene.js`, `scripts/verify-doc-hygiene.test.js`, `scripts/verify-flows-fn-parse.test.js`, `scripts/verify-heartbeat-health.js`, `scripts/verify-history-hash-fixtures.js`, `scripts/verify-init-log-capture.js`, `scripts/verify-init-log-capture.test.js`, `scripts/verify-journal-catalog-vendor.sh`, `scripts/verify-journal-catalog-vendor.test.sh`, `scripts/verify-lorain-codec.js`, `scripts/verify-lsn50-chameleon-codec.js`, `scripts/verify-lsn50-chameleon-persistence.js`, `scripts/verify-lsn50-watermark-codec.js`, `scripts/verify-merge-allowance-preservation.test.js`, `scripts/verify-migrations.js`, `scripts/verify-migrations.test.js`, `scripts/verify-no-new-silent-catch.test.js`, `scripts/verify-runtime-schema-parity.js`, `scripts/verify-s2120-codec.js`, `scripts/verify-sdi12-codec.js`, `scripts/verify-sync-contract.js`, `scripts/verify-tektelic-agriculture-codec.js`, `scripts/verify-test-inventory.test.js`, `scripts/verify-trigger-body-parity.js`, `scripts/verify-trigger-body-parity.test.js`, `scripts/verify-ui-core-vendor.sh`, `scripts/verify-ui-core-vendor.test.sh`, `scripts/watermark-drydown-analysis.test.js`, `web/react-gui/scripts/css-rule-diff.test.mjs`
- **no-scope-call** (2): `scripts/test-terra-selection-edge-acceptance.js`, `scripts/test-zone-command-path.js`
- **registry-only** (1): `bcm2712/osi-lib/index.test.js`
- **stub** (7): `scripts/capture-zone-env-vectors.js`, `scripts/test-conditional-irrigation-writer-wrappers.js`, `scripts/test-entity-name-command-path.js`, `scripts/test-outbox-event-flush.js`, `scripts/test-scoped-access-command-path.js`, `scripts/test-sdi12-recipe-flow.js`, `scripts/test-task5b2-projections.js`
- **umbrella-child** (5): `scripts/osi-lib-binding-audit.test.js`, `scripts/verify-history-api-contract.js`, `scripts/verify-live-gateway-identity.js`, `scripts/verify-profile-parity.js`, `scripts/verify-scoped-access.js`

### Plan-only commit, after independent acceptance of these bytes

This text is a campaign report until an independent Sol review accepts it by SHA-256. The accepted bytes are then copied once, unchanged, to `docs/superpowers/plans/2026-10-29-issue-434-admin-freshness.md` in an isolated checkout at B and committed alone. Execution later reads the committed plan, never a campaign copy. All commands below are **UNRUN**. They use `run434` and the variables of step 0, except `RCPT=$C/reports/issue-434-plan-commit-r2`; `ROOT` is the isolated checkout at B, `PACKET` the absolute path of the accepted report file and `PLAN_SHA256` the accepted digest. `STAGE_EDITOR_SHA256` and `FLOW_EDITOR_SHA256` may be left empty for this sequence. The parent independently observes the clean checkout at B before `pc-fetch` and records that observation; the wrapped checks below repeat it.

```bash
run434 pc-fetch 600 git -c credential.helper= fetch --no-tags --refmap= origin main
run434 pc-fence 60 sh -c 'printf "%s\n%s\n" "$(git rev-parse FETCH_HEAD)" "$B"; test "$(git rev-parse FETCH_HEAD)" = "$B"'
run434 pc-state 120 sh -c 'git rev-parse HEAD; git status --porcelain=v2 --untracked-files=all; test "$(git rev-parse HEAD)" = "$B" && test -z "$(git status --porcelain --untracked-files=all)"'
run434 pc-copy 60 sh -c 'cp "$1" "$PLAN" && sha256sum "$PLAN" && test "$(sha256sum < "$PLAN" | cut -d" " -f1)" = "$PLAN_SHA256"' sh "$PACKET"
run434 pc-add 120 git add docs/superpowers/plans/2026-10-29-issue-434-admin-freshness.md
run434 pc-staged 60 git diff --cached --name-only
run434 pc-check 60 git diff --cached --check
run434 pc-hygiene 300 node scripts/verify-doc-hygiene.js
run434 pc-slop 120 node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-10-29-issue-434-admin-freshness.md
run434 pc-commit 120 sh -c 'git -c user.name=Project-OSI -c user.email="$(git log -1 --format=%ae "$B")" commit -m "docs: plan issue 434 fresh admin authorization" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"'
run434 pc-post 120 sh -c 'set -e; git rev-parse HEAD HEAD^ HEAD^{tree}; test "$(git rev-parse HEAD^)" = "$B"; test "$(git rev-list --count "$B"..HEAD)" = 1; test "$(git diff --name-status "$B" HEAD)" = "$(printf "A\t%s" "$PLAN")"; test -z "$(git status --porcelain --untracked-files=all)"; test "$(git cat-file blob HEAD:"$PLAN" | sha256sum | cut -d" " -f1)" = "$PLAN_SHA256"'
run434 pc-message 120 sh -c 'git log -1 --format=%B | node scripts/verify-doc-hygiene.js --stdin'
```

Forecasts: `pc-fetch` exits 0 and writes only this checkout's `FETCH_HEAD` (`--refmap=` leaves `refs/remotes/origin/main` and every other ref unchanged). `pc-fence` prints B twice; if `FETCH_HEAD` differs from B it exits 1 and the sequence stops for reconciliation, with no copy and no commit. `pc-state` prints HEAD B, no status entries and exits 0. `pc-copy` exits 0 only when the copied file's digest equals `PLAN_SHA256`. `pc-staged` prints only the plan path; `pc-check` prints nothing. `pc-hygiene` ends `verify-doc-hygiene: OK (...)`; `pc-slop` ends `slop-check: PASS (no tier-1 findings)`. `pc-post` exits 0 only if `HEAD^` is B, exactly one commit and one added path lie above B, the status is empty and the committed blob's digest equals `PLAN_SHA256`. `pc-message` scans the commit message with the built-in hygiene patterns. Stop before `pc-commit` on any nonzero exit or extra staged path. A different committing model replaces only the attribution trailer with its own. The built-in hygiene scan covers EUIs and addresses; the private name list (`OSI_DOC_HYGIENE_TERMS`) is held by maintainers and is not applied by this sequence.

### Execution, after the plan commit is accepted and resource admission allows

Every command in this section is **UNRUN**. The order is fixed; stop on the first output that differs from its forecast, and report instead of improvising. Commits use the identity on B (`Project-OSI` and B's author address) and never skip hooks.

#### Step 0: custody, trust root, fresh-main fence and binding

The trust root comes from outside this plan: the parent's dispatch brief supplies the SHA-256 of `run-heavy.py`, `resource_control.py`, `memory_guard.py`, `test_resource_control.py` and the capture controller `reports/issue-436-runtime-base-execute-r1/capture.py`; the Sol acceptance record supplies `PLAN_SHA256`, `STAGE_EDITOR_SHA256` and `FLOW_EDITOR_SHA256`. Do not take those digests from this file. Run every command through `run434`, which registers it with the campaign wrapper and writes `command.json`, `child.json`, `stdout`, `stderr`, `status.json`, `.pre`, `.post`, `.outer.stdout`, `.outer.stderr` and `.wrapper.exit` per label. Record three exits per label: the direct child (`status.json` `direct_returncode`), the controller (`controller_exit`, 124 on timeout) and the wrapper (`.wrapper.exit`). Keep every receipt, including failed and refused launches; a rerun takes a new label with a suffix. Each launch needs a fresh schema-2 pressure sample (at most 30 s old), the expected guard identity, at least 8 GiB actual `MemAvailable`, and an unlatched hold; the capture controller refuses otherwise with exit 125. The capture bound is at most 1,800 s; allow at least 2,400 s of queue time beyond each bound before treating a launch as stuck, and never bypass the lock, the guard or the registration. Do not add an inner GNU `timeout` under `run434`: without `--foreground` it starts a new process group that the registered capture no longer owns. If an inner deadline is ever needed, use `timeout --foreground` so the registered PGID and SID are preserved.

```bash
C=/home/phil/projects/osi-release-campaign-2026-10-25
ROOT=/absolute/path/of/the/isolated/checkout   # recorded in the execution report
RCPT=$C/reports/issue-434-execute-r2           # must not exist yet
B=bd1afcd248616653e1962081c8c9e3d7b19d650f
PLAN=docs/superpowers/plans/2026-10-29-issue-434-admin-freshness.md
PLAN_SHA256=...                                # from the Sol acceptance record
STAGE_EDITOR_SHA256=...                        # from the Sol acceptance record
FLOW_EDITOR_SHA256=...                         # from the Sol acceptance record
mkdir "$RCPT" "$RCPT/.tmp" "$RCPT/.cache" "$RCPT/tools"
mkdir -p "$C/home/434x/.config"
run434() {
  label=$1; bound=$2; shift 2
  { date -u +%Y-%m-%dT%H:%M:%SZ; grep MemAvailable /proc/meminfo; cat "$C/pressure.json"; echo; } > "$RCPT/$label.pre"
  env -i HOME="$C/home/434x" XDG_CONFIG_HOME="$C/home/434x/.config" XDG_CACHE_HOME="$RCPT/.cache" \
    TMPDIR="$RCPT/.tmp" PATH=/usr/bin:/bin LANG=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
    GIT_NO_LAZY_FETCH=1 PYTHONDONTWRITEBYTECODE=1 B="$B" PLAN="$PLAN" PLAN_SHA256="$PLAN_SHA256" \
    STAGE_EDITOR_SHA256="$STAGE_EDITOR_SHA256" FLOW_EDITOR_SHA256="$FLOW_EDITOR_SHA256" \
    python3 "$C/run-heavy.py" python3 "$C/reports/issue-436-runtime-base-execute-r1/capture.py" \
    --worktree "$ROOT" --receipt-dir "$RCPT/$label" --label "$label" --timeout-seconds "$bound" -- "$@" \
    > "$RCPT/$label.outer.stdout" 2> "$RCPT/$label.outer.stderr"
  rc=$?; echo "$rc" > "$RCPT/$label.wrapper.exit"
  { date -u +%Y-%m-%dT%H:%M:%SZ; echo "wrapper_exit=$rc"; } > "$RCPT/$label.post"
  return "$rc"
}
run434 s0-trust 60 sha256sum "$C/run-heavy.py" "$C/resource_control.py" "$C/memory_guard.py" "$C/test_resource_control.py" "$C/reports/issue-436-runtime-base-execute-r1/capture.py"
run434 s0-fetch 600 git -c credential.helper= fetch --no-tags --refmap= origin main
run434 s0-fence 60 sh -c 'printf "%s\n%s\n" "$(git rev-parse FETCH_HEAD)" "$B"; test "$(git rev-parse FETCH_HEAD)" = "$B"'
run434 s0-state 120 sh -c 'set -e; git rev-parse HEAD HEAD^ HEAD^{tree}; git status --porcelain=v2 --branch --untracked-files=all; test -z "$(git status --porcelain --untracked-files=all)"; test "$(git rev-parse HEAD^)" = "$B"; test "$(git rev-list --count "$B"..HEAD)" = 1; test "$(git diff --name-status "$B" HEAD)" = "$(printf "A\t%s" "$PLAN")"; test "$(sha256sum < "$PLAN" | cut -d" " -f1)" = "$PLAN_SHA256"; test "$(git cat-file blob HEAD:"$PLAN" | sha256sum | cut -d" " -f1)" = "$PLAN_SHA256"'
run434 s0-extract 60 sh -c 'for a in stage-editor flow-editor; do awk -v m="<!-- asset:$a -->" "$2" "$PLAN" > "$1/$a.cjs"; done; sha256sum "$1/stage-editor.cjs" "$1/flow-editor.cjs"' sh "$RCPT/tools" '$0==m{f=1;next} f&&$0=="```js"{g=1;next} g&&$0=="```"{exit} g{print}'
run434 s0-verify 60 sh -c 'test "$(sha256sum < "$1/stage-editor.cjs" | cut -d" " -f1)" = "$STAGE_EDITOR_SHA256" && test "$(sha256sum < "$1/flow-editor.cjs" | cut -d" " -f1)" = "$FLOW_EDITOR_SHA256"' sh "$RCPT/tools"
```

Forecasts: `s0-trust` prints the five dispatch digests. `s0-fetch` exits 0 and writes only this checkout's `FETCH_HEAD`. `s0-fence` prints B twice and exits 0; any other `FETCH_HEAD` exits 1: stop and reconcile, because an unedited transitive input may have moved. `s0-state` exits 0 only if the checkout is clean, `HEAD^` is B, exactly one commit and one added path (the plan) lie above B, and both the worktree file and the committed blob hash to `PLAN_SHA256`; the clean status is what makes the worktree file the committed blob that the stage editor later reads. `s0-extract` prints two digests. `s0-verify` exits 0 only if they equal `STAGE_EDITOR_SHA256` and `FLOW_EDITOR_SHA256`. No extracted asset runs before `s0-verify` passes, and the stage editor checks the plan digest against `PLAN_SHA256` again before it reads any block. Binding to B exactly is what keeps the caller inventory and the before pins valid; if the execution base must move, this plan needs a fresh reconciliation and review.

#### Step 1: base controls at the plan commit (no edits yet)

Run the 7 focused commands, the 13 gates and the 23 regression controls at the plan commit. Forecast: every command exits 0 with no timeout. The focused files hold their B counts (helper 25 per profile, scoped writes 101, settings 50 per profile, history contract 2, outbox recovery 5). A nonzero exit is red-on-base: stop and report.

```bash
run434 b-helper-2712 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
run434 b-helper-2709 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.test.js
run434 b-writes 900 node --test scripts/test-scoped-access-writes.js
run434 b-settings-2712 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-system-settings/api.test.js
run434 b-settings-2709 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-system-settings/api.test.js
run434 b-contract 300 node --test scripts/verify-history-api-contract.test.js
run434 b-outbox 300 node --test scripts/test-sync-outbox-recovery-route.js
run434 b-sync-flow 1800 env OSI_FLOWS_SIZE_BASE_REF=bd1afcd248616653e1962081c8c9e3d7b19d650f OSI_DDL_BASE_REF=bd1afcd248616653e1962081c8c9e3d7b19d650f OSI_MIGRATIONS_BASE_REF=bd1afcd248616653e1962081c8c9e3d7b19d650f OSI_IDENTITY_BASE_REF=bd1afcd248616653e1962081c8c9e3d7b19d650f node scripts/verify-sync-flow.js
run434 b-scoped-test 900 node --test scripts/verify-scoped-access.test.js
run434 b-flagoff 900 node scripts/verify-auth-flag-off-hermetic.js
run434 b-flagoff-test 900 node --test scripts/verify-auth-flag-off-hermetic.test.js
run434 b-fn-parse 900 node scripts/verify-flows-fn-parse.js
run434 b-size 900 node scripts/verify-flows-size-ratchet.js --base-ref bd1afcd248616653e1962081c8c9e3d7b19d650f
run434 b-catch 900 node scripts/verify-no-new-silent-catch.js
run434 b-wiring 900 node scripts/test-flows-wiring.js
run434 b-registration 900 node scripts/verify-helper-registration.js
run434 b-inventory 900 node scripts/verify-test-inventory.js
run434 b-reads 900 node --test scripts/test-scoped-access-reads.js
run434 b-source-guards 900 node --test scripts/test-history-source-guards.js
run434 b-commands 900 node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scoped-access-commands/index.test.js
run434 b-x-auth-recovery 900 node --test scripts/test-auth-bootstrap-policy.js scripts/test-account-recovery.js scripts/test-account-recovery-cli.js
run434 b-x-rain-history 900 node --test scripts/test-rain-history-route.js
run434 b-x-policy-api 900 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/api.test.js
run434 b-x-analysis-discovery 900 node --test scripts/test-analysis-device-discovery.js
run434 b-x-export-session 900 node --test scripts/test-export-routes-require-session.js
run434 b-x-all-zones-export 900 node --test scripts/test-history-all-zones-export.js
run434 b-x-lifecycle-routes 900 node --test scripts/test-conditional-irrigation-lifecycle-routes.js
run434 b-x-entity-create 900 node --test scripts/test-entity-name-create-paths.js
run434 b-x-watermark-routes 900 node scripts/test-watermark-calibration-routes.js
run434 b-x-rain-source 900 node --test scripts/test-zone-rain-source-route.js
run434 b-x-journal-api 900 node scripts/test-journal-api.js
run434 b-x-network-api 900 node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-network-api/index.test.js
run434 b-x-reference-tree 900 node --test scripts/test-reference-tree-and-valve-router.js
run434 b-x-context-isolation 900 node --test scripts/test-request-context-isolation.js
run434 b-x-journal-command 900 node scripts/test-journal-command-path.js
run434 b-x-history-vectors 900 node scripts/capture-history-router-vectors.js --verify
run434 b-x-soil-projection 900 node --test scripts/test-history-router-soil-projection.js
run434 b-x-journal-bootstrap 900 node scripts/test-journal-bootstrap.js
run434 b-x-installation-revision 900 node scripts/test-installation-revision-command.js
run434 b-x-entity-commands 900 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.test.js
run434 b-x-credential-isolation 900 env OSI_BASELINE_RUNNER=node-sqlite node --test scripts/test-auth-credential-isolation.js
run434 b-x-device-rename 900 node --test scripts/test-device-rename-route.js
run434 b-x-zone-rename 900 node --test scripts/test-zone-rename-route.js
```

#### Step 2: test-only stage and RED

```bash
run434 t1-edit 120 node "$RCPT/tools/stage-editor.cjs" test
run434 t2-check 60 node "$RCPT/tools/stage-editor.cjs" check-test
run434 t3-status 60 sh -c 'git status --porcelain=v2 --untracked-files=all; git diff --check'
```

Forecast: `t1-edit` and `t2-check` print `issue-434-stage-edit test: OK` and `issue-434-stage-edit check-test: OK`; `t3-status` lists exactly the eight modified test-stage files (two helper tests, two settings tests, scoped writes, the history contract verifier and its test, the outbox recovery test; the helper and flow product files untouched) and `git diff --check` prints nothing. Then run the seven focused commands:

```bash
run434 r-helper-2712 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
run434 r-helper-2709 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.test.js
run434 r-writes 900 node --test scripts/test-scoped-access-writes.js
run434 r-settings-2712 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-system-settings/api.test.js
run434 r-settings-2709 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-system-settings/api.test.js
run434 r-contract 300 node --test scripts/verify-history-api-contract.test.js
run434 r-outbox 300 node --test scripts/test-sync-outbox-recovery-route.js
```

| Label | Bound (s) | Forecast exit | First intended failure, after its positive controls pass |
|---|---:|---|---|
| `r-helper-2712` | 600 | 1 | H1 `assert.rejects` (cached admin authorizes the demoted row). Further intended REDs, recorded individually: H2, H3, H4 (first valid-token case: the recorded SQL is B's `SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1`, not `ISSUE434_USER_SQL`), H5 (first viewer case, after its 403 check: the call list holds B's identity `get`, a `user_uuid` `get` and four `all`s, not one bound `get`), H6 (first `assert.rejects`: the plain sentinel arrives without status 500 or `cause`), H7, H8, H9, H10 (race assertion: the original request settles before any retry, `'settled'` where `'retried'` is required) and H11 (waiter roles). H12 passes. |
| `r-helper-2709` | 600 | 1 | Same assertions in the mirror. |
| `r-writes` | 900 | 1 | R1, after its 20 valid admin guard controls: first demoted account-link guard fails `result[0] === null`. R2 timer, R3 admin GET, R4 gateway GET/PUT/POST and R5's command waiter (`(await waiting).role` is `admin`, not `viewer`) are further named REDs. |
| `r-settings-2712` | 600 | 1 | The issue-434 test's demoted scoped PUT returns 200, not 403. |
| `r-settings-2709` | 600 | 1 | Same assertion in the mirror. |
| `r-contract` | 300 | 1 | New test: `freshCall` count is 0, not 1. |
| `r-outbox` | 300 | 0 | None; the fixture replacement is a compatibility change and all 5 tests pass at B. |

No base RED waits on a barrier: H10 races settlement against its second barrier, and every other gate in H7–H11 is opened by a load that B also performs, so the runner reaches H11 and H12. Of the seven focused invocations, six are forecast to exit nonzero; `r-outbox` exits 0. Top-level source counts after the test stage: helper 37 per profile, scoped writes 107, settings 51 per profile, history contract 3, outbox recovery 5. Runner subtest totals can differ; measure them. A positive control that fails, a cancelled test, a timeout, or a runner that stops before the named assertion is fixture divergence, not RED: stop and amend the plan. Then commit the test stage:

```bash
run434 t4-add 120 git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-system-settings/api.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-system-settings/api.test.js scripts/test-scoped-access-writes.js scripts/verify-history-api-contract.js scripts/verify-history-api-contract.test.js scripts/test-sync-outbox-recovery-route.js
run434 t5-commit 120 sh -c 'git -c user.name=Project-OSI -c user.email="$(git log -1 --format=%ae "$B")" commit -m "test: pin fresh admin authorization for issue 434" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"'
run434 t6-post 60 sh -c 'git rev-parse HEAD HEAD^; git status --porcelain=v2 --untracked-files=all; git diff --name-status HEAD^ HEAD'
```

#### Step 3: product stage and GREEN

```bash
run434 p1-helper 120 node "$RCPT/tools/stage-editor.cjs" product
run434 p2-flows 120 node "$RCPT/tools/flow-editor.cjs"
run434 p3-check 60 sh -c 'node "$1" check-product && node "$1" check-flows && git status --porcelain=v2 --untracked-files=all && git diff --check' sh "$RCPT/tools/stage-editor.cjs"
```

Forecast: `p1-helper` prints `issue-434-stage-edit product: OK`; `p2-flows` exits 0 with no output; `p3-check` prints both `OK` lines and lists exactly five modified files (both helpers, both flows, the history contract verifier). Then the seven focused commands:

```bash
run434 g-helper-2712 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
run434 g-helper-2709 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.test.js
run434 g-writes 900 node --test scripts/test-scoped-access-writes.js
run434 g-settings-2712 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-system-settings/api.test.js
run434 g-settings-2709 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-system-settings/api.test.js
run434 g-contract 300 node --test scripts/verify-history-api-contract.test.js
run434 g-outbox 300 node --test scripts/test-sync-outbox-recovery-route.js
```

Every one exits 0 with the counts above, and no test is cancelled or skipped. Commit:

```bash
run434 p4-add 120 git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-history-api-contract.js
run434 p5-commit 120 sh -c 'git -c user.name=Project-OSI -c user.email="$(git log -1 --format=%ae "$B")" commit -m "fix: read the admin role fresh and drop invalidated scope loads (#434)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"'
run434 p6-post 60 sh -c 'git rev-parse HEAD HEAD^{tree}; git status --porcelain=v2 --untracked-files=all; git diff --name-status "$B" HEAD'
```

`p6-post` forecast: 13 paths against B: the plan, the eight test-stage files, both helpers and both flows (the history contract verifier is already among the eight). This commit is the candidate.

#### Step 4: candidate gates and regression controls

Run the 13 gates and the 23 regression controls at the candidate. Forecast: every command exits 0 with no timeout.

```bash
run434 c-sync-flow 1800 env OSI_FLOWS_SIZE_BASE_REF=bd1afcd248616653e1962081c8c9e3d7b19d650f OSI_DDL_BASE_REF=bd1afcd248616653e1962081c8c9e3d7b19d650f OSI_MIGRATIONS_BASE_REF=bd1afcd248616653e1962081c8c9e3d7b19d650f OSI_IDENTITY_BASE_REF=bd1afcd248616653e1962081c8c9e3d7b19d650f node scripts/verify-sync-flow.js
run434 c-scoped-test 900 node --test scripts/verify-scoped-access.test.js
run434 c-flagoff 900 node scripts/verify-auth-flag-off-hermetic.js
run434 c-flagoff-test 900 node --test scripts/verify-auth-flag-off-hermetic.test.js
run434 c-fn-parse 900 node scripts/verify-flows-fn-parse.js
run434 c-size 900 node scripts/verify-flows-size-ratchet.js --base-ref bd1afcd248616653e1962081c8c9e3d7b19d650f
run434 c-catch 900 node scripts/verify-no-new-silent-catch.js
run434 c-wiring 900 node scripts/test-flows-wiring.js
run434 c-registration 900 node scripts/verify-helper-registration.js
run434 c-inventory 900 node scripts/verify-test-inventory.js
run434 c-reads 900 node --test scripts/test-scoped-access-reads.js
run434 c-source-guards 900 node --test scripts/test-history-source-guards.js
run434 c-commands 900 node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scoped-access-commands/index.test.js
run434 c-x-auth-recovery 900 node --test scripts/test-auth-bootstrap-policy.js scripts/test-account-recovery.js scripts/test-account-recovery-cli.js
run434 c-x-rain-history 900 node --test scripts/test-rain-history-route.js
run434 c-x-policy-api 900 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/api.test.js
run434 c-x-analysis-discovery 900 node --test scripts/test-analysis-device-discovery.js
run434 c-x-export-session 900 node --test scripts/test-export-routes-require-session.js
run434 c-x-all-zones-export 900 node --test scripts/test-history-all-zones-export.js
run434 c-x-lifecycle-routes 900 node --test scripts/test-conditional-irrigation-lifecycle-routes.js
run434 c-x-entity-create 900 node --test scripts/test-entity-name-create-paths.js
run434 c-x-watermark-routes 900 node scripts/test-watermark-calibration-routes.js
run434 c-x-rain-source 900 node --test scripts/test-zone-rain-source-route.js
run434 c-x-journal-api 900 node scripts/test-journal-api.js
run434 c-x-network-api 900 node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-network-api/index.test.js
run434 c-x-reference-tree 900 node --test scripts/test-reference-tree-and-valve-router.js
run434 c-x-context-isolation 900 node --test scripts/test-request-context-isolation.js
run434 c-x-journal-command 900 node scripts/test-journal-command-path.js
run434 c-x-history-vectors 900 node scripts/capture-history-router-vectors.js --verify
run434 c-x-soil-projection 900 node --test scripts/test-history-router-soil-projection.js
run434 c-x-journal-bootstrap 900 node scripts/test-journal-bootstrap.js
run434 c-x-installation-revision 900 node scripts/test-installation-revision-command.js
run434 c-x-entity-commands 900 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.test.js
run434 c-x-credential-isolation 900 env OSI_BASELINE_RUNNER=node-sqlite node --test scripts/test-auth-credential-isolation.js
run434 c-x-device-rename 900 node --test scripts/test-device-rename-route.js
run434 c-x-zone-rename 900 node --test scripts/test-zone-rename-route.js
```

`verify-sync-flow.js` needs the `sqlite3` CLI on `PATH`; its pass signal is `Sync flow verification passed` followed by `All parity checks passed.` and exit 0. `capture-history-router-vectors.js --verify` executes the edited `history-api-router-fn` body flag-off against `docs/contracts/history-router/cases`; with `OSI_SCOPED_ACCESS` unset the scope check returns early, so the vectors must match unchanged. `check-mqtt-topics.sh` and `verify-no-stray-ddl.js` are not run: the edit adds no MQTT node and no DDL-like text.

#### Step 5: mutation controls on the candidate

Each mutant is applied in place by the stage editor, which first proves the candidate digests, and is removed by restoring the touched paths from HEAD. After each restore, `check-product`, `check-flows` and an empty status must hold before the next mutant.

```bash
run434 m1-apply 60 node "$RCPT/tools/stage-editor.cjs" mutate M1
run434 m1-helper 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
run434 m1-writes 900 node --test scripts/test-scoped-access-writes.js
run434 m1-settings 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-system-settings/api.test.js
run434 m1-restore 60 git restore --source=HEAD --worktree -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.js
run434 m1-check 60 sh -c 'node "$1" check-product && node "$1" check-flows && test -z "$(git status --porcelain --untracked-files=all)"' sh "$RCPT/tools/stage-editor.cjs"
run434 m2-apply 60 node "$RCPT/tools/stage-editor.cjs" mutate M2
run434 m2-helper 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
run434 m2-restore 60 git restore --source=HEAD --worktree -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.js
run434 m2-check 60 sh -c 'node "$1" check-product && node "$1" check-flows && test -z "$(git status --porcelain --untracked-files=all)"' sh "$RCPT/tools/stage-editor.cjs"
run434 m3-apply 60 node "$RCPT/tools/stage-editor.cjs" mutate M3
run434 m3-helper 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
run434 m3-restore 60 git restore --source=HEAD --worktree -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.js
run434 m3-check 60 sh -c 'node "$1" check-product && node "$1" check-flows && test -z "$(git status --porcelain --untracked-files=all)"' sh "$RCPT/tools/stage-editor.cjs"
run434 m4-apply 60 node "$RCPT/tools/stage-editor.cjs" mutate M4
run434 m4-helper 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
run434 m4-restore 60 git restore --source=HEAD --worktree -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.js
run434 m4-check 60 sh -c 'node "$1" check-product && node "$1" check-flows && test -z "$(git status --porcelain --untracked-files=all)"' sh "$RCPT/tools/stage-editor.cjs"
run434 m5-apply 60 node "$RCPT/tools/stage-editor.cjs" mutate M5
run434 m5-helper 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
run434 m5-restore 60 git restore --source=HEAD --worktree -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scope-helper/index.js
run434 m5-check 60 sh -c 'node "$1" check-product && node "$1" check-flows && test -z "$(git status --porcelain --untracked-files=all)"' sh "$RCPT/tools/stage-editor.cjs"
run434 m6-apply 60 node "$RCPT/tools/stage-editor.cjs" mutate M6
run434 m6-contract 300 node --test scripts/verify-history-api-contract.test.js
run434 m6-writes 900 node --test scripts/test-scoped-access-writes.js
run434 m6-restore 60 git restore --source=HEAD --worktree -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
run434 m6-check 60 sh -c 'node "$1" check-product && node "$1" check-flows && test -z "$(git status --porcelain --untracked-files=all)"' sh "$RCPT/tools/stage-editor.cjs"
run434 m7-apply 60 node "$RCPT/tools/stage-editor.cjs" mutate M7
run434 m7-outbox 300 node --test scripts/test-sync-outbox-recovery-route.js
run434 m7-restore 60 git restore --source=HEAD --worktree -- scripts/test-sync-outbox-recovery-route.js
run434 m7-check 60 sh -c 'node "$1" check-product && node "$1" check-flows && test -z "$(git status --porcelain --untracked-files=all)"' sh "$RCPT/tools/stage-editor.cjs"
```

| Mutant | Change (exact text in the stage editor) | Forecast |
|---|---|---|
| M1 | restore the B `assertAuthenticatedRole` (cached `assertRole`) | each run exits 1: H1 `assert.rejects` (in `m1-helper`, H4–H6 also fail at their base assertions); R1 first demoted guard; issue-434 settings PUT returns 200 |
| M2 | drop per-user ticket marking | exit 1: H7 waiter role; H10 also fails at its race assertion (`'settled'`), without waiting |
| M3 | drop global ticket marking | exit 1: H8 waiter `disabled` |
| M4 | publish an invalidated ticket (`continue` removed) | exit 1: H7 waiter role; H9 and H10's race assertion also fail |
| M5 | allow three attempts | exit 1: H10 `assert.rejects` (the unpaused third load resolves) |
| M6 | revert the history call in both flows | each run exits 1: new contract test `freshCall` count; R4 demoted gateway 403 |
| M7 | restore the B outbox fixture | exit 1: `TypeError` reading `_recoveryActor` of `null` inside `recovery route applies the real bearer and current admin-role checks`, before its `assert.equal` runs |

Every apply, restore and check command exits 0. Route-level probes from the accepted draft (move reboot scheduling ahead of the role check, drop the admin-router invalidation, make zone history owner-only, call the scope helper with the flag off) are left to the independent verifier, who writes and runs them against R2, R5, R4 and R6.

#### Step 6: closing state and drift report

```bash
run434 z1-final 120 sh -c 'node "$1" check-product && node "$1" check-flows && git status --porcelain=v2 --branch --untracked-files=all && git rev-parse HEAD HEAD^{tree} && git log --format="%H %P %s" "$B"..HEAD && git diff --name-status "$B" HEAD' sh "$RCPT/tools/stage-editor.cjs"
run434 z2-fetch 600 git -c credential.helper= fetch --no-tags --refmap= origin main
run434 z3-fence 60 sh -c 'printf "%s\n%s\n" "$(git rev-parse FETCH_HEAD)" "$B"; test "$(git rev-parse FETCH_HEAD)" = "$B"'
run434 z4-cleanup 60 sh -c 'found=0; for p in $(pgrep -x node); do if [ "$(readlink /proc/$p/cwd)" = "$1" ]; then ps -o pid=,pgid=,args= -p "$p"; found=1; fi; done; exit "$found"' sh "$ROOT"
```

Forecast: `z1-final` prints both `OK` lines, a clean status, three commits above B (plan, tests, fix) and the 13 paths of step 3. `z2-fetch` exits 0. `z3-fence` prints B twice; a different `FETCH_HEAD` means `main` moved during execution: report it, because the B-bound candidate then needs reconciliation before any integration. `z4-cleanup` prints nothing: no process outside its own group still names the checkout. Wrapped command count: 6 in step 0, 43 in step 1, 13 in step 2 (3 edit/status, 7 RED, 3 commit), 13 in step 3 (3 edit/check, 7 GREEN, 3 commit), 36 in step 4, 31 in step 5 (M1 uses 6, M6 uses 5, the other five use 4 each), 4 in step 6: 146 in total, plus the 12 plan-commit commands. These are forecasts, not passes.

#### Step 7: independent verification

A Sol verifier who did not write this plan or the candidate reruns the focused files, the route-level probes, the gates and the parity check at the candidate SHA, checks both profiles' bytes and the B-to-candidate diff against this plan, and records exact exits and output. Under the 2026-10-28 user override, that Sol verification is the final review for this Opus-authored work; no separate final Opus round follows. A risk-class change still needs the three-provider council and a maintainer merge; the third-provider vote is missing and stays visible. No PR, merge, deploy, release or live access follows from this plan.

The future executor must stop on any source or output divergence, including a newly added privileged caller, changed query facade, missing test fixture column, flow-size growth, baseline verifier failure, or a guard that responds differently than this draft predicts. Amend the plan and obtain another independent review before improvising a product change.

## Claims and unresolved decisions

Proposed ownership for #434, for coordinator arbitration: both `osi-scope-helper/index.js` and `index.test.js`; `history-api-router-fn` (`func` only) in both `flows.json`; the history contract verifier's export line and gateway pin, and its test; the appended block in `scripts/test-scoped-access-writes.js`; the appended block in both `osi-system-settings/api.test.js`; and, new in this version, the one-line fixture in `scripts/test-sync-outbox-recovery-route.js`. The coordinator has since recorded that single-line claim for #434. Inspection and test surfaces with no product edit: `osi-system-settings/api.js`, the ten admin guard nodes, reboot, fan, account status, the improvement router, `scoped-admin-account-router`, `deploy.sh`, workflows, schema, flags and allowance JSON. This author did not change the ledger.

R1 accepted the role-only result with null zone/plot sets and the bounded helper retry for the consumers at N. The inventory at B adds no consumer that reads those sets from `assertAuthenticatedRole`; do not populate them from the stale cache. The helper-only 503 and the route-level 500 mappings are explicit above. This plan needs a fresh independent review; its author does not approve it. Overlapping work that is not on `main` is listed under "Integration seams" at the end.

## R1 and R2 amendments: literal test additions and editor

The independent R1 review accepted the role-only result and bounded retry for pinned consumers. Those decisions are settled for this source draft. The code below is the execution text for the case matrix above. Copy it into the specified existing test files in the isolated plan's TDD stage; do not treat the matrix alone as a test. Every `test` declaration below is one top-level test. All code and expected RED/GREEN outcomes remain **UNRUN**.

### H1–H12: append to each mirrored `osi-scope-helper/index.test.js`

Add `const { DatabaseSync } = require('node:sqlite');` and `const path = require('node:path');` with the existing imports. Copy the `deferred`, `observedFacade`, and `signedToken` functions from the fixture block above verbatim, then append this block. The helper test file's existing `beforeEach` calls `_resetForTests`; each new case also owns and closes its raw DB. `fixture434` makes no network or host-file access.

<!-- asset:helper-test-H -->
```js
const ISSUE434_SECRET = 'issue-434-test-secret';
const ISSUE434_USER_SQL =
  'SELECT id, username, role, disabled_at, user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1';

function fixture434() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    CREATE TABLE users(id INTEGER, username TEXT, role TEXT, disabled_at TEXT, user_uuid TEXT);
    CREATE TABLE irrigation_zones(user_id INTEGER, deleted_at TEXT, zone_uuid TEXT);
    CREATE TABLE user_zone_assignments(user_uuid TEXT, deleted_at TEXT, zone_uuid TEXT);
    CREATE TABLE journal_plots(owner_user_uuid TEXT, deleted_at TEXT, plot_uuid TEXT);
    CREATE TABLE user_plot_assignments(user_uuid TEXT, deleted_at TEXT, plot_uuid TEXT);
    INSERT INTO users VALUES(7,'admin','admin',NULL,'u-admin');
    INSERT INTO users VALUES(8,'other','viewer',NULL,'u-other');
  `);
  const observed = observedFacade(raw);
  const Database = function Database() { return observed; };
  const options = (authorization = signedToken(7, 'admin', ISSUE434_SECRET), extra = {}) => ({
    Database, authorization, configuredSecret: ISSUE434_SECRET, ...extra,
  });
  return {
    raw, observed, options,
    close() { scope._resetForTests(); raw.close(); },
  };
}

function userGets434(f) {
  return f.observed.calls.filter((call) => call.method === 'get' &&
    call.sql.includes('FROM users'));
}

test('H1 fresh admin read rejects a warm-cache demotion', { concurrency: false }, async () => {
  const f = fixture434();
  try {
    await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    f.observed.calls.length = 0;
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    await assert.rejects(scope.authorizeAdminRead(f.options()), (e) => e.status === 403);
    assert.deepEqual(f.observed.calls, [{ method: 'get', sql: ISSUE434_USER_SQL, params: [7, 'admin'] }]);
    assert.equal(f.observed.closeCount, 1);
  } finally { f.close(); }
});

test('H2 disabled and restored roles are read on each admin request', { concurrency: false }, async () => {
  const f = fixture434();
  try {
    await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    f.observed.calls.length = 0;
    f.raw.exec("UPDATE users SET disabled_at='2026-10-26' WHERE id=7");
    await assert.rejects(scope.authorizeAdminRead(f.options()), (e) => e.status === 403);
    f.raw.exec("UPDATE users SET disabled_at=NULL WHERE id=7");
    assert.equal((await scope.authorizeAdminRead(f.options())).role, 'admin');
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    await assert.rejects(scope.authorizeAdminRead(f.options()), (e) => e.status === 403);
    f.raw.exec("UPDATE users SET role='admin' WHERE id=7");
    assert.equal((await scope.authorizeAdminRead(f.options())).role, 'admin');
    assert.equal(f.observed.closeCount, 4);
    assert.equal(userGets434(f).filter((c) => c.sql === ISSUE434_USER_SQL).length, 4);
  } finally { f.close(); }
});

test('H3 admin read uses one bound user statement and no scope tables even on cache hit', { concurrency: false }, async () => {
  const f = fixture434();
  try {
    for (let i = 0; i < 2; i += 1) {
      const before = f.observed.calls.length;
      const result = await scope.authorizeAdminRead(f.options());
      assert.deepEqual(f.observed.calls.slice(before),
        [{ method: 'get', sql: ISSUE434_USER_SQL, params: [7, 'admin'] }],
        `call ${i + 1}: one bound get and zero all`);
      assert.deepEqual({ role: result.role, username: result.username, wildcard: result.wildcard,
        zoneUuids: result.zoneUuids, plotUuids: result.plotUuids },
      { role: 'admin', username: 'admin', wildcard: false, zoneUuids: null, plotUuids: null });
      if (i === 0) {
        await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
        f.observed.calls.length = 0;
      }
    }
    assert.deepEqual(f.observed.calls,
      [{ method: 'get', sql: ISSUE434_USER_SQL, params: [7, 'admin'] }]);
    assert.equal(f.observed.closeCount, 2);
  } finally { f.close(); }
});

test('H4 token and current id plus username binding reject missing identities', { concurrency: false }, async () => {
  const invalid = [null, 'Bearer x', 'Bearer x.forged',
    signedToken(7, 'admin', ISSUE434_SECRET, Date.now() - 1000)];
  for (const authorization of invalid) {
    const f = fixture434();
    let opens = 0;
    try {
      await assert.rejects(scope.authorizeAdminRead({ ...f.options(authorization),
        Database: function Database() { opens += 1; return f.observed; } }),
      (e) => e.status === 401);
      assert.equal(opens, 0);
      assert.equal(f.observed.calls.length, 0);
      assert.equal(f.observed.closeCount, 0);
    } finally { f.close(); }
  }
  for (const [sql, token] of [
    ["DELETE FROM users WHERE id=7", signedToken(7, 'admin', ISSUE434_SECRET)],
    ['', signedToken(7, 'old-name', ISSUE434_SECRET)],
    ['', signedToken(9, 'admin', ISSUE434_SECRET)],
    ["UPDATE users SET user_uuid=NULL WHERE id=7", signedToken(7, 'admin', ISSUE434_SECRET)],
  ]) {
    const f = fixture434();
    try {
      if (sql) f.raw.exec(sql);
      await assert.rejects(scope.authorizeAdminRead(f.options(token)), (e) => e.status === 401);
      assert.equal(f.observed.calls.length, 1);
      assert.equal(f.observed.calls[0].sql, ISSUE434_USER_SQL);
      assert.equal(f.observed.calls[0].params.length, 2);
      assert.equal(f.observed.closeCount, 1);
    } finally { f.close(); }
  }
});

test('H5 disabled, viewer, researcher and unknown roles all fail closed', { concurrency: false }, async () => {
  for (const [role, disabled] of [['viewer', null], ['researcher', null],
    ['unknown-role', null], ['admin', '2026-10-26']]) {
    const f = fixture434();
    try {
      f.raw.prepare('UPDATE users SET role=?, disabled_at=? WHERE id=7').run(role, disabled);
      await assert.rejects(scope.authorizeAdminRead(f.options()), (e) => e.status === 403);
      assert.deepEqual(f.observed.calls, [{ method: 'get', sql: ISSUE434_USER_SQL, params: [7, 'admin'] }]);
      assert.equal(f.observed.closeCount, 1);
    } finally { f.close(); }
  }
});

test('H6 query cause and close warning remain observable', { concurrency: false }, async () => {
  const f = fixture434();
  const cause = new Error('fixture-read-failed');
  const warnings = [];
  try {
    f.observed.rejectNextGet(cause);
    await assert.rejects(scope.authorizeAdminRead(f.options()),
      (e) => e.status === 500 && e.statusCode === 500 && e.cause === cause);
    assert.equal(f.observed.closeCount, 1);
    assert.equal(f.observed.calls.filter((c) => c.method === 'all').length, 0);
    assert.equal((await scope.authorizeAdminRead(f.options())).role, 'admin');
    assert.equal(f.observed.closeCount, 2);
    f.observed.failClose(new Error('fixture-close-failed'));
    assert.equal((await scope.authorizeAdminRead(f.options(undefined,
      { warn: (message) => warnings.push(message) }))).role, 'admin');
    assert.equal(f.observed.closeCount, 3);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /fixture-close-failed/);
    assert.equal(userGets434(f).filter((c) => c.sql === ISSUE434_USER_SQL).length, 3);
  } finally { f.close(); }
});

test('H7 per-user invalidation discards old result for cache and waiter', { concurrency: false }, async () => {
  const f = fixture434();
  const gate = f.observed.pauseNextScopeUserGet();
  try {
    const waiting = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    await gate.entered;
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    scope.invalidateScope('u-admin');
    gate.release();
    assert.equal((await waiting).role, 'viewer');
    assert.equal((await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true })).role, 'viewer');
    assert.equal(userGets434(f).length, 2);
  } finally { gate.release(); f.close(); }
});

test('H8 global invalidation discards old result for cache and waiter', { concurrency: false }, async () => {
  const f = fixture434();
  const gate = f.observed.pauseNextScopeUserGet();
  try {
    const waiting = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    await gate.entered;
    f.raw.exec("UPDATE users SET disabled_at='2026-10-26' WHERE id=7");
    scope.invalidateScope();
    gate.release();
    assert.equal((await waiting).disabled, true);
    await assert.rejects(scope.assertRole(f.observed, 'u-admin', 'admin', { scopedMode: true }),
      (e) => e.status === 403);
    assert.equal(userGets434(f).length, 2);
  } finally { gate.release(); f.close(); }
});

test('H9 old-last load cannot overwrite a newer published scope', { concurrency: false }, async () => {
  for (const globalClear of [false, true]) {
    const f = fixture434();
    const gate = f.observed.pauseNextScopeUserGet();
    try {
      const old = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
      await gate.entered;
      f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
      scope.invalidateScope(globalClear ? undefined : 'u-admin');
      const newer = await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
      assert.equal(newer.role, 'viewer');
      gate.release();
      assert.strictEqual(await old, newer);
      assert.strictEqual(await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true }), newer);
      assert.equal(userGets434(f).length, 2);
    } finally { gate.release(); f.close(); }
  }
});

test('H10 second invalidation ends after two loads; route 500 mappings are explicit', { concurrency: false }, async () => {
  const f = fixture434();
  const first = f.observed.pauseNextScopeUserGet();
  const second = f.observed.pauseNextScopeUserGet();
  try {
    const waiting = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    await first.entered;
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    scope.invalidateScope('u-admin');
    first.release();
    // Both outcomes settle this race, so the test never waits on a barrier
    // that the code under test does not open.
    const afterFirst = await Promise.race([
      waiting.then(() => 'settled', () => 'settled'),
      second.entered.then(() => 'retried'),
    ]);
    assert.equal(afterFirst, 'retried', 'an invalidated first load must not settle the original request');
    scope.invalidateScope('u-admin');
    second.release();
    await assert.rejects(waiting, (e) => e.status === 503 && e.statusCode === 503);
    assert.equal(userGets434(f).length, 2);
    assert.equal((await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true })).role, 'viewer');
    assert.equal(userGets434(f).length, 3);
  } finally { first.release(); second.release(); f.close(); }

  const root = path.resolve(__dirname, '../../../../../../../');
  const { executeFunction, loadNode, makeAuthHeader, seedScopedDb } =
    require(path.join(root, 'scripts/lib/scoped-access-harness'));
  const profile = __dirname.includes('bcm2709') ? 'bcm2709' : 'bcm2712';
  const flowPath = path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
  const raw = seedScopedDb();
  const changed = Object.assign(new Error('scope changed during read'), { status: 503, statusCode: 503 });
  const injected = { ...scope,
    resolveScope: async () => { throw changed; },
    assertEnabledAccount: async () => { throw changed; } };
  const env = { OSI_SCOPED_ACCESS: '1', AUTH_TOKEN_SECRET: 'scoped-access-test-secret' };
  const msg = { authUserId: 1, authUsername: 'admin1', req: { headers: {
    authorization: makeAuthHeader({ userId: 1, username: 'admin1' }) } } };
  try {
    const me = await executeFunction(loadNode('api-me-fn', flowPath),
      { msg, db: raw, env, osiLibModules: { scope: injected } });
    assert.equal(me.result.statusCode, 500);
    assert.deepEqual(me.result.payload, { message: 'unable to resolve scope' });
    const sdi = await executeFunction(loadNode('sdi12-profiles-scope-fn', flowPath), {
      msg: { req: { method: 'GET', path: '/api/sdi12/probe-profiles', headers: {
        authorization: makeAuthHeader({ userId: 1, username: 'admin1' }) }, params: {} } },
      db: raw, env, osiLibModules: { scope: injected },
    });
    assert.equal(sdi.result[0], null);
    assert.equal(sdi.result[1].statusCode, 500);
    assert.deepEqual(sdi.result[1].payload, { message: 'Unable to authorize SDI-12 profiles' });
  } finally { raw.close(); scope._resetForTests(); }
});

test('H11 same-user waiters and unrelated-user cache isolation', { concurrency: false }, async () => {
  const f = fixture434();
  const first = f.observed.pauseNextScopeUserGet();
  const second = f.observed.pauseNextScopeUserGet();
  try {
    const a = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    const b = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    await Promise.all([first.entered, second.entered]);
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    scope.invalidateScope('u-admin');
    first.release(); second.release();
    assert.deepEqual([(await a).role, (await b).role], ['viewer', 'viewer']);
    const adminCached = await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    const other = await scope.resolveScope(f.observed, 'u-other', { scopedMode: true });
    const before = userGets434(f).length;
    scope.invalidateScope('u-admin');
    assert.notStrictEqual(await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true }), adminCached);
    assert.equal(userGets434(f).length, before + 1);
    assert.strictEqual(await scope.resolveScope(f.observed, 'u-other', { scopedMode: true }), other);
    assert.equal(userGets434(f).length, before + 1);
    scope.invalidateScope();
    assert.notStrictEqual(await scope.resolveScope(f.observed, 'u-other', { scopedMode: true }), other);
    assert.equal(userGets434(f).length, before + 2);
  } finally { first.release(); second.release(); f.close(); }
});

test('H12 TTL boundary, failed load, and flag-off wildcard remain bounded', { concurrency: false }, async () => {
  const f = fixture434();
  const realNow = Date.now;
  const oldFlag = process.env.OSI_SCOPED_ACCESS;
  let now = 1000000;
  try {
    Date.now = () => now;
    const original = await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    now += 29999;
    assert.strictEqual(await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true }), original);
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    now += 1;
    assert.equal((await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true })).role, 'viewer');
    assert.equal(userGets434(f).length, 2);
    scope.invalidateScope('u-admin');
    f.observed.rejectNextGet(new Error('load failed'));
    await assert.rejects(scope.resolveScope(f.observed, 'u-admin', { scopedMode: true }), /load failed/);
    assert.equal((await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true })).role, 'viewer');
    assert.equal(userGets434(f).length, 4);
    process.env.OSI_SCOPED_ACCESS = '';
    const before = f.observed.calls.length;
    const wildcard = await scope.resolveScope(f.observed, 'u-admin', { scopedMode: false });
    assert.equal(wildcard.wildcard, true);
    assert.equal(wildcard.role, 'admin');
    assert.equal(f.observed.calls.length, before);
  } finally {
    Date.now = realNow;
    if (oldFlag === undefined) delete process.env.OSI_SCOPED_ACCESS;
    else process.env.OSI_SCOPED_ACCESS = oldFlag;
    f.close();
  }
});
```

### Exact replacements for the two existing helper tests, in both profiles

At B the two declarations being replaced read as follows (both profiles, lines 188–218 and 220–252):

<!-- asset:before-helper-test-1 -->
```js
test('assertAuthenticatedRole binds token id and username before checking role', async () => {
  const db = fakeDb({
    get: (sql) => {
      if (sql.includes('id = ? AND username = ?')) return { user_uuid: 'u-admin' };
      return {
        id: 7,
        username: 'admin',
        role: 'admin',
        disabled_at: null,
        user_uuid: 'u-admin',
      };
    },
    all: () => [],
  });
  await scope.assertAuthenticatedRole(
    db,
    { userId: 7, username: 'admin' },
    'admin',
    { scopedMode: true }
  );
  const missingDb = fakeDb({ get: () => undefined });
  await assert.rejects(
    () => scope.assertAuthenticatedRole(
      missingDb,
      { userId: 7, username: 'admin' },
      'admin',
      { scopedMode: true }
    ),
    (error) => error.statusCode === 401
  );
});
```

<!-- asset:before-helper-test-2 -->
```js
test('authorizeAdminRead verifies, authorizes, and closes its database handle', async () => {
  const secret = 'admin-read-test-secret';
  const payload = Buffer.from(JSON.stringify({
    userId: 7,
    username: 'admin',
    exp: Date.now() + 60000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  let closeCalls = 0;
  const db = fakeDb({
    get: (sql) => {
      if (sql.includes('id = ? AND username = ?')) return { user_uuid: 'u-admin' };
      return {
        id: 7,
        username: 'admin',
        role: 'admin',
        disabled_at: null,
        user_uuid: 'u-admin',
      };
    },
    all: () => [],
  });
  db.close = (callback) => {
    closeCalls += 1;
    callback();
  };
  await scope.authorizeAdminRead({
    Database: function Database() { return db; },
    authorization: `Bearer ${payload}.${signature}`,
    configuredSecret: secret,
  });
  assert.equal(closeCalls, 1);
});
```

Replace the pinned `assertAuthenticatedRole binds token id and username before checking role` declaration with this entire declaration, byte-for-byte in each mirrored file:

<!-- asset:helper-test-replace-1 -->
```js
test('assertAuthenticatedRole binds token id and username before checking role', async () => {
  const db = fakeDb({
    get: () => ({
      id: 7,
      username: 'admin',
      role: 'admin',
      disabled_at: null,
      user_uuid: 'u-admin',
    }),
    all: () => [],
  });
  await scope.assertAuthenticatedRole(
    db,
    { userId: 7, username: 'admin' },
    'admin',
    { scopedMode: true }
  );
  const missingDb = fakeDb({ get: () => undefined });
  await assert.rejects(
    () => scope.assertAuthenticatedRole(
      missingDb,
      { userId: 7, username: 'admin' },
      'admin',
      { scopedMode: true }
    ),
    (error) => error.statusCode === 401
  );
});
```

Replace the pinned `authorizeAdminRead verifies, authorizes, and closes its database handle` declaration with this entire declaration, byte-for-byte in each mirrored file:

<!-- asset:helper-test-replace-2 -->
```js
test('authorizeAdminRead verifies, authorizes, and closes its database handle', async () => {
  const secret = 'admin-read-test-secret';
  const payload = Buffer.from(JSON.stringify({
    userId: 7,
    username: 'admin',
    exp: Date.now() + 60000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  let closeCalls = 0;
  const db = fakeDb({
    get: () => ({
      id: 7,
      username: 'admin',
      role: 'admin',
      disabled_at: null,
      user_uuid: 'u-admin',
    }),
    all: () => [],
  });
  db.close = (callback) => {
    closeCalls += 1;
    callback();
  };
  await scope.authorizeAdminRead({
    Database: function Database() { return db; },
    authorization: `Bearer ${payload}.${signature}`,
    configuredSecret: secret,
  });
  assert.equal(closeCalls, 1);
});
```

Expected base RED assertions are H1's 403, H2's disabled 403, H3's exact one-get/zero-all list, H4's SQL equality in its first valid-token case, H5's call list in its first (viewer) case, H6's first `assert.rejects` predicate (the plain sentinel has no status 500 and no `cause`), H7/H8's waiter state, H9's identity with the newer object, H10's race assertion (the original request settles before any retry), and H11's two fresh waiter roles. No base case waits on a barrier: H10 races settlement against its second barrier, and every other gate in H7–H11 is opened by a load that B also performs. The checks before those named H4–H6 assertions pass on base: H4's four invalid-token cases and the 401 and one-call checks of its first valid-token case, and H5's 403 predicate. H12 is a compatibility control; it passes on base and must not be reported as RED. Candidate GREEN requires every H assertion. Mutation controls: restore the old cached `assertAuthenticatedRole` call to break H1/H3 (H4–H6 then fail as at B); omit per-user or global ticket marking to break H7/H8 (per-user omission also fails H10's race); publish an invalidated ticket to break H7, H9 and H10's race; allow a third attempt to break H10's `assert.rejects`; let only one ticket be marked to break H11. Step 5 runs M1–M5 as literal mutants on the candidate; the single-ticket variant for H11 is left to the independent verifier.

### R1–R6: append to `scripts/test-scoped-access-writes.js`

The existing file already imports `test`, `assert`, `executeFunction`, `facadeDb`, `loadNode`, `makeAuthHeader`, `seedScopedDb`, defines `scopedRequest`, `ENV`, and uses synthetic filesystem/command spies. Add the `path` import if absent. These six declarations are nonparallel because R2 temporarily replaces `global.setTimeout`. Each case loops both maintained profiles and injects the matching helper with `osiLibModules`; no fixture opens real hardware or a network service.

<!-- asset:writes-R -->
```js
const path434 = require('node:path');
const profileNames434 = ['bcm2712', 'bcm2709'];
const gateway434 = 'A840410000000042';
const card434 = gateway434 + ':gateway:hub';
const adminRoutes434 = [
  { id: 'account-link-admin-write-guard', method: 'POST', path: '/api/account-link' },
  { id: 'account-unlink-admin-write-guard', method: 'DELETE', path: '/api/account-link' },
  { id: 'sync-force-admin-write-guard', method: 'POST', path: '/api/sync/force' },
  { id: 'get-gateway-location-auth-fn', method: 'GET',
    path: `/api/gateways/${gateway434}/location`, params: { gatewayEui: gateway434 } },
  { id: 'history-rollups-admin-write-guard', method: 'POST', path: '/api/history/rollups/run' },
  { id: 'database-download-admin-read-guard', method: 'GET', path: '/download/database' },
  { id: 'sync-state-admin-read-guard', method: 'GET', path: '/api/sync/state' },
  { id: 'system-stats-admin-read-guard', method: 'GET', path: '/api/system/stats' },
  { id: 'fieldtest-download-admin-read-guard', method: 'GET', path: '/download-fieldtest' },
  { id: 'sync-outbox-recover-admin-guard', method: 'POST', path: '/api/sync/outbox/recover' },
];
const diagnosticsGlobals434 = {
  fs: {
    existsSync: () => false,
    readFileSync(filePath) {
      if (String(filePath).includes('/thermal/')) return '42000\n';
      if (String(filePath).endsWith('/period')) return '100\n';
      if (String(filePath).endsWith('/duty_cycle')) return '50\n';
      return '';
    },
    readdirSync: () => [],
    accessSync() { const error = new Error('not found'); error.code = 'ENOENT'; throw error; },
  },
  os: {
    loadavg: () => [0.1, 0.2, 0.3],
    totalmem: () => 1024 * 1024 * 1024,
    freemem: () => 512 * 1024 * 1024,
    cpus: () => [{}, {}],
  },
};

function profile434(name) {
  const root = path434.resolve(__dirname, '..');
  return {
    name,
    flowPath: path434.join(root, `conf/full_raspberrypi_bcm27xx_${name}/files/usr/share/flows.json`),
    scope: require(path434.join(root,
      `conf/full_raspberrypi_bcm27xx_${name}/files/usr/share/node-red/osi-scope-helper`)),
  };
}

function req434(id, username, method, routePath, params = {}, body = {}) {
  return scopedRequest(id, username, method, routePath, params, body);
}

async function run434(profile, nodeId, db, msg, extra = {}) {
  return executeFunction(loadNode(nodeId, profile.flowPath), {
    msg, db,
    env: { ...ENV, DEVICE_EUI: '0016C001F1000001' },
    osiLibModules: { scope: profile.scope },
    ...extra,
  });
}

async function warm434(profile, db, uuid = 'u-admin') {
  return profile.scope.resolveScope(facadeDb(db), uuid, { scopedMode: true });
}

test('R1 all ten scoped admin guards reject warm-cache demotion and disablement',
  { concurrency: false }, async () => {
    for (const name of profileNames434) for (const route of adminRoutes434) {
      const profile = profile434(name);
      profile.scope._resetForTests();
      const db = seedScopedDb();
      try {
        const allowedMsg = req434(1, 'admin1', route.method, route.path, route.params || {});
        const allowed = await run434(profile, route.id, db, allowedMsg);
        assert.strictEqual(allowed.result[0], allowedMsg, `${name}/${route.id}: valid admin reaches handler`);
        assert.equal(allowed.result[1], null, `${name}/${route.id}: valid admin has no refusal`);
        assert.equal(allowed.result[0].statusCode, undefined, `${name}/${route.id}: guard did not answer route`);
        if (route.id === 'sync-outbox-recover-admin-guard') {
          assert.equal(allowed.result[0]._recoveryActor, 'admin1');
        }
      } finally { db.close(); profile.scope._resetForTests(); }
    }
    for (const name of profileNames434) for (const route of adminRoutes434) for (const change of [
      "UPDATE users SET role='viewer' WHERE id=1",
      "UPDATE users SET disabled_at='2026-10-26' WHERE id=1",
    ]) {
      const profile = profile434(name);
      profile.scope._resetForTests();
      const db = seedScopedDb();
      try {
        await warm434(profile, db);
        db.exec(change);
        const out = await run434(profile, route.id, db,
          req434(1, 'admin1', route.method, route.path, route.params || {}));
        assert.equal(out.result[0], null, `${name}/${route.id}: no success output`);
        assert.equal(out.result[1].statusCode, 403, `${name}/${route.id}: denied output`);
        assert.equal(out.result[1]._recoveryActor, undefined);
      } finally { db.close(); profile.scope._resetForTests(); }
    }
  });

test('R2 reboot scheduling and fan writes occur only after a fresh admin decision',
  { concurrency: false }, async () => {
    const realTimer = global.setTimeout;
    const scheduled = [];
    const execs = [];
    const fanWrites = [];
    const fakeCp = { exec: (command) => { execs.push(command); } };
    const fakeFanFs = { ...fakeFsRawPwmReadFailures,
      writeFileSync(name, value) {
        fanWrites.push([name, value]);
        return fakeFsRawPwmReadFailures.writeFileSync(name, value);
      },
    };
    global.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
    try {
      for (const name of profileNames434) for (const kind of ['demoted', 'disabled', 'db-fault']) {
        const profile = profile434(name);
        profile.scope._resetForTests();
        const db = seedScopedDb();
        try {
          await warm434(profile, db);
          if (kind === 'demoted') db.exec("UPDATE users SET role='viewer' WHERE id=1");
          if (kind === 'disabled') db.exec("UPDATE users SET disabled_at='2026-10-26' WHERE id=1");
          const faultDb = { get: async () => { throw new Error('fixture-db-fault'); },
            close: (cb) => cb() };
          const overrides = kind === 'db-fault'
            ? { osiDb: { Database: function Database() { return faultDb; } } } : {};
          const timerBefore = scheduled.length;
          const execBefore = execs.length;
          const writeBefore = fanWrites.length;
          const reboot = await run434(profile, 'sys-reboot-fn', db,
            req434(1, 'admin1', 'POST', '/api/system/reboot'),
            { globals: { cp: fakeCp, fs: fakeFanFs }, libOverrides: overrides });
          assert.equal(reboot.result.statusCode, kind === 'db-fault' ? 500 : 403);
          assert.equal(scheduled.length, timerBefore, `${name}/${kind}: no reboot timer`);
          assert.equal(execs.length, execBefore, `${name}/${kind}: no reboot execution`);
          const fan = await run434(profile, 'sys-fan-fn', db,
            req434(1, 'admin1', 'POST', '/api/system/fan', {}, { speed: 100 }),
            { globals: { cp: fakeCp, fs: fakeFanFs }, libOverrides: overrides });
          assert.equal(fan.result.statusCode, kind === 'db-fault' ? 500 : 403);
          assert.equal(fanWrites.length, writeBefore, `${name}/${kind}: no fan write`);
        } finally { db.close(); profile.scope._resetForTests(); }
      }
      for (const name of profileNames434) {
        const profile = profile434(name);
        profile.scope._resetForTests();
        const db = seedScopedDb();
        try {
          const before = scheduled.length;
          const out = await run434(profile, 'sys-reboot-fn', db,
            req434(1, 'admin1', 'POST', '/api/system/reboot'),
            { globals: { cp: fakeCp, fs: fakeFanFs } });
          assert.equal(out.result.statusCode, 200);
          assert.equal(scheduled.length, before + 1);
          assert.equal(scheduled[before].ms, 3000);
          const execBefore = execs.length;
          scheduled[before].fn();
          assert.deepEqual(execs.slice(execBefore), ['reboot']);
          const fan = await run434(profile, 'sys-fan-fn', db,
            req434(1, 'admin1', 'POST', '/api/system/fan', {}, { speed: 100 }),
            { globals: { cp: fakeCp, fs: fakeFanFs } });
          assert.equal(fan.result.statusCode, 200);
          assert.ok(fanWrites.length > 0);
        } finally { db.close(); profile.scope._resetForTests(); }
      }
    } finally { global.setTimeout = realTimer; }
  });

test('R3 account status and improvement admin GETs reject stale role; viewer filing remains',
  { concurrency: false }, async () => {
    for (const name of profileNames434) {
      const profile = profile434(name);
      profile.scope._resetForTests();
      const db = seedScopedDb();
      try {
        const allowedStatus = await run434(profile, 'al-status-decode', db,
          req434(1, 'admin1', 'GET', '/api/account-link/status'));
        assert.ok(allowedStatus.result[0], `${name}: valid status GET reaches its query`);
        assert.equal(allowedStatus.result[1], null);
        assert.ok(Array.isArray(allowedStatus.result[0].payload));
        for (const routePath of ['/api/improvement-requests',
          '/api/improvement-requests/diagnostics-preview']) {
          const allowedRead = await run434(profile, 'improvement-requests-api-router', db,
            req434(1, 'admin1', 'GET', routePath), { globals: diagnosticsGlobals434 });
          assert.equal(allowedRead.result.statusCode, 200,
            `${name}/${routePath}: valid admin GET reaches response`);
        }
      } finally { db.close(); profile.scope._resetForTests(); }
    }
    for (const name of profileNames434) for (const change of [
      "UPDATE users SET role='viewer' WHERE id=1",
      "UPDATE users SET disabled_at='2026-10-26' WHERE id=1",
    ]) {
      const profile = profile434(name);
      profile.scope._resetForTests();
      const db = seedScopedDb();
      try {
        await warm434(profile, db);
        db.exec(change);
        const status = await run434(profile, 'al-status-decode', db,
          req434(1, 'admin1', 'GET', '/api/account-link/status'));
        assert.equal(status.result[0], null);
        assert.equal(status.result[1].statusCode, 403);
        for (const routePath of ['/api/improvement-requests',
          '/api/improvement-requests/diagnostics-preview']) {
          const read = await run434(profile, 'improvement-requests-api-router', db,
            req434(1, 'admin1', 'GET', routePath), { globals: diagnosticsGlobals434 });
          assert.equal(read.result.statusCode, 403);
          assert.equal(read.result.payload.generated_at, undefined);
          assert.ok(!Array.isArray(read.result.payload));
        }
      } finally { db.close(); profile.scope._resetForTests(); }
    }
    for (const name of profileNames434) {
      const profile = profile434(name);
      profile.scope._resetForTests();
      const db = seedScopedDb();
      const body = { type: 'bug', severity: 'annoying', area: 'system',
        title: 'Visible issue', description: 'A reproducible fixture issue.',
        consent_public: true, consent_diagnostics: false };
      try {
        const before = db.prepare('SELECT COUNT(*) AS n FROM improvement_requests').get().n;
        const filed = await run434(profile, 'improvement-requests-api-router', db,
          req434(3, 'view1', 'POST', '/api/improvement-requests', {}, body));
        assert.equal(filed.result.statusCode, 201);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM improvement_requests').get().n, before + 1);
        db.exec("UPDATE users SET disabled_at='2026-10-26' WHERE id=3");
        profile.scope.invalidateScope('u-view1');
        const denied = await run434(profile, 'improvement-requests-api-router', db,
          req434(3, 'view1', 'POST', '/api/improvement-requests', {}, body));
        assert.equal(denied.result.statusCode, 403);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM improvement_requests').get().n, before + 1);
      } finally { db.close(); profile.scope._resetForTests(); }
    }
  });

test('R4 gateway history GET PUT POST reject demoted admin before context or preference writes',
  { concurrency: false }, async () => {
    const cases = [
      ['GET', `/api/history/gateways/${gateway434}/cards`, { gatewayEui: gateway434 }, {}],
      ['PUT', `/api/history/gateways/${gateway434}/cards/${card434}/preferences`,
        { gatewayEui: gateway434, cardId: card434 }, { pinned: true, manualOrder: 2 }],
      ['POST', `/api/history/gateways/${gateway434}/cards/${card434}/opened`,
        { gatewayEui: gateway434, cardId: card434 }, {}],
    ];
    for (const name of profileNames434) for (const [method, routePath, params, body] of cases) {
      const profile = profile434(name);
      profile.scope._resetForTests();
      const db = seedScopedDb();
      db.prepare('UPDATE irrigation_zones SET gateway_device_eui=? WHERE id=2').run(gateway434);
      try {
        db.prepare(`INSERT INTO history_card_preferences
          (user_id,owner_user_uuid,scope_type,gateway_eui,card_id,pinned,manual_order,open_count,updated_at)
          VALUES (1,'u-admin','gateway',?,?,0,1,0,'2026-01-01')`)
          .run(gateway434, card434);
        const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM history_card_preferences').get().n;
        const allowed = await run434(profile, 'history-api-router-fn', db,
          req434(1, 'admin1', method, routePath, params, body));
        assert.equal(allowed.result.statusCode, 200, `${name}/${method}: valid card route succeeds`);
        const preference = db.prepare(`SELECT pinned,manual_order,open_count,last_opened_at
          FROM history_card_preferences WHERE user_id=1 AND gateway_eui=? AND card_id=?`)
          .get(gateway434, card434);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history_card_preferences').get().n,
          beforeCount, `${name}/${method}: existing preference reused`);
        if (method === 'PUT') {
          assert.deepEqual({ pinned: preference.pinned, manual_order: preference.manual_order,
            open_count: preference.open_count },
          { pinned: 1, manual_order: 2, open_count: 0 });
        } else if (method === 'POST') {
          assert.equal(preference.open_count, 1);
          assert.ok(preference.last_opened_at, `${name}: opened timestamp recorded`);
        } else {
          assert.equal(preference.pinned, 0);
          assert.equal(preference.open_count, 0);
        }
      } finally { db.close(); profile.scope._resetForTests(); }
    }
    for (const name of profileNames434) for (const [method, routePath, params, body] of cases)
    for (const change of ["UPDATE users SET role='viewer' WHERE id=1",
      "UPDATE users SET disabled_at='2026-10-26' WHERE id=1"]) {
      const profile = profile434(name);
      profile.scope._resetForTests();
      const db = seedScopedDb();
      db.exec(`UPDATE irrigation_zones SET gateway_device_eui='${gateway434}' WHERE id=2`);
      try {
        const current = await run434(profile, 'history-api-router-fn', db,
          req434(1, 'admin1', 'GET', `/api/history/gateways/${gateway434}/cards`,
            { gatewayEui: gateway434 }));
        assert.equal(current.result.statusCode, 200, `${name}: valid gateway context`);
        db.prepare(`INSERT OR REPLACE INTO history_card_preferences
          (user_id,owner_user_uuid,scope_type,gateway_eui,card_id,pinned,manual_order,open_count,updated_at)
          VALUES (1,'u-admin','gateway',?,?,0,1,0,'2026-01-01')`)
          .run(gateway434, card434);
        const preferenceSql = `SELECT pinned,manual_order,open_count,updated_at
          FROM history_card_preferences WHERE user_id=1 AND gateway_eui=? AND card_id=?`;
        const before = db.prepare(preferenceSql).get(gateway434, card434);
        const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM history_card_preferences').get().n;
        profile.scope._resetForTests();
        await warm434(profile, db);
        db.exec(change);
        const baseFacade = facadeDb(db);
        const gatewayReads = [];
        const watched = { ...baseFacade,
          get(sql, params, cb) {
            if (String(sql).includes('gateway_device_eui')) gatewayReads.push(sql);
            return baseFacade.get(sql, params, cb);
          },
          all(sql, params, cb) {
            if (String(sql).includes('gateway_device_eui')) gatewayReads.push(sql);
            return baseFacade.all(sql, params, cb);
          } };
        const out = await run434(profile, 'history-api-router-fn', db,
          req434(1, 'admin1', method, routePath, params, body),
          { libOverrides: { osiDb: { Database: function Database() { return watched; } } } });
        assert.equal(out.result.statusCode, 403, `${name}/${method}: fresh admin role`);
        assert.equal(gatewayReads.length, 0, `${name}/${method}: no gateway context read`);
        assert.deepEqual(db.prepare(preferenceSql).get(gateway434, card434), before,
          `${name}/${method}: existing preference unchanged`);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history_card_preferences').get().n,
          beforeCount, `${name}/${method}: no preference insert`);
      } finally { db.close(); profile.scope._resetForTests(); }
    }
    for (const name of profileNames434) {
      const profile = profile434(name);
      profile.scope._resetForTests();
      const db = seedScopedDb();
      try {
        const zone = await run434(profile, 'history-api-router-fn', db,
          req434(2, 'res1', 'GET', '/api/history/zones/2/cards', { zoneId: '2' }));
        assert.equal(zone.result.statusCode, 200, `${name}: zone history remains account-wide`);
        db.exec(`CREATE TABLE IF NOT EXISTS history_workspaces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL, owner_user_uuid TEXT, zone_id INTEGER,
          name TEXT NOT NULL, workspace_json TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO history_workspaces(user_id,owner_user_uuid,zone_id,name,workspace_json,created_at,updated_at)
        VALUES(1,'u-admin',2,'Foreign','{}','2026-01-01','2026-01-01');`);
        const foreign = await run434(profile, 'history-api-router-fn', db,
          req434(2, 'res1', 'PUT', '/api/history/workspaces/1', { id: '1' },
            { name: 'Changed' }));
        assert.equal(foreign.result.statusCode, 404);
        assert.equal(db.prepare('SELECT name FROM history_workspaces WHERE id=1').get().name, 'Foreign');
      } finally { db.close(); profile.scope._resetForTests(); }
    }
  });

test('R5 supported local and cloud mutations invalidate target or all pending loads',
  { concurrency: false }, async () => {
    for (const name of profileNames434) {
      const profile = profile434(name);
      profile.scope._resetForTests();
      const db = seedScopedDb();
      try {
        const created = await run434(profile, 'scoped-admin-account-router', db,
          req434(1, 'admin1', 'POST', '/api/users', {},
            { username: 'second-admin', password: 'temporary-pass', role: 'admin' }));
        assert.equal(created.result.statusCode, 201);
        const uuid = created.result.payload.user_uuid;
        for (const [routePath, body, expectedRole, disabled] of [
          [`/api/users/${uuid}/role`, { role: 'viewer' }, 'viewer', false],
          [`/api/users/${uuid}/disabled`, { disabled: true }, 'viewer', true],
          [`/api/users/${uuid}/role`, { role: 'admin' }, 'admin', true],
          [`/api/users/${uuid}/disabled`, { disabled: false }, 'admin', false],
        ]) {
          const warm = await warm434(profile, db, uuid);
          const out = await run434(profile, 'scoped-admin-account-router', db,
            req434(1, 'admin1', 'PUT', routePath, { uuid }, body));
          assert.equal(out.result.statusCode, 200);
          const row = db.prepare('SELECT role,disabled_at FROM users WHERE user_uuid=?').get(uuid);
          assert.equal(row.role, expectedRole);
          assert.equal(Boolean(row.disabled_at), disabled);
          const after = await warm434(profile, db, uuid);
          assert.notStrictEqual(after, warm, 'supported mutation invalidates cached object');
          assert.equal(after.role, expectedRole);
          assert.equal(after.disabled, disabled);
        }
      } finally { db.close(); profile.scope._resetForTests(); }

      const commandDb = seedScopedDb();
      const userUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const gateway = '0016C001F1000001';
      const commandId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      commandDb.prepare("INSERT INTO users(username,password_hash,created_at,user_uuid,role,sync_version) VALUES('field-user','h','2026-01-01',?,'admin',1)").run(userUuid);
      const commandFacade = facadeDb(commandDb);
      const entered = (() => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; })();
      const release = (() => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; })();
      const loadingDb = { ...commandFacade,
        async get(sql, params) {
          const row = await commandFacade.get(sql, params);
          if (sql.includes('WHERE user_uuid = ?') && params[0] === userUuid) {
            entered.resolve(); await release.promise;
          }
          return row;
        } };
      const envelope = {
        commandId: 434, commandType: 'UPSERT_SCOPED_USER',
        payload: { command_id: commandId, command_type: 'UPSERT_SCOPED_USER',
          effect_key: `scoped_user:${userUuid}:1`,
          user: { user_uuid: userUuid, gateway_device_eui: gateway,
            username: 'field-user', role: 'viewer', disabled_at: null,
            base_sync_version: 1, password_hash: null } },
      };
      let invalidations = 0;
      const trackedScope = { invalidateScope() {
        invalidations += 1; profile.scope.invalidateScope();
      } };
      try {
        const waiting = profile.scope.resolveScope(loadingDb, userUuid, { scopedMode: true });
        await entered.promise;
        const commands = require(path434.resolve(__dirname, '..',
          `conf/full_raspberrypi_bcm27xx_${name}/files/usr/share/node-red/osi-scoped-access-commands`));
        const applied = await commands.applyScopedAccessCommand(commandFacade, envelope,
          { gateway_device_eui: gateway, scope_helper: trackedScope });
        assert.equal(applied.ack.result, 'APPLIED');
        assert.equal(invalidations, 1);
        assert.equal(commandDb.prepare('SELECT role FROM users WHERE user_uuid=?').get(userUuid).role, 'viewer');
        release.resolve();
        assert.equal((await waiting).role, 'viewer');
        assert.equal((await profile.scope.resolveScope(commandFacade, userUuid, { scopedMode: true })).role, 'viewer');
        const conflict = await commands.applyScopedAccessCommand(commandFacade,
          { ...envelope, commandId: 435, payload: { ...envelope.payload,
            command_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } },
          { gateway_device_eui: gateway, scope_helper: trackedScope });
        assert.equal(conflict.ack.result, 'CONFLICT');
        assert.equal(invalidations, 1);
        assert.equal(commandDb.prepare('SELECT role FROM users WHERE user_uuid=?').get(userUuid).role, 'viewer');
        const replay = await commands.applyScopedAccessCommand(commandFacade, envelope,
          { gateway_device_eui: gateway, scope_helper: trackedScope });
        assert.equal(replay.ack.result, 'APPLIED');
        assert.equal(invalidations, 2, 'stored APPLIED replay retains shipped invalidation');
      } finally {
        release.resolve(); commandDb.close(); profile.scope._resetForTests();
        require(path434.resolve(__dirname, '..',
          `conf/full_raspberrypi_bcm27xx_${name}/files/usr/share/node-red/osi-scoped-access-commands`))._resetForTests();
      }
    }
  });

test('R6 flag-off guards and full-scope wildcard keep their old bearer boundary',
  { concurrency: false }, async () => {
    const oldFlag = process.env.OSI_SCOPED_ACCESS;
    const realTimer = global.setTimeout;
    const scheduled = [];
    process.env.OSI_SCOPED_ACCESS = '';
    global.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
    try {
    for (const name of profileNames434) {
      const profile = profile434(name);
      profile.scope._resetForTests();
      const db = seedScopedDb();
      const forbiddenLib = { require() { throw new Error('flag-off scope helper touched'); } };
      try {
        for (const route of adminRoutes434) {
          const out = await run434(profile, route.id, db,
            req434(3, 'view1', route.method, route.path, route.params || {}),
            { env: { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' },
              libOverrides: { osiLib: forbiddenLib } });
          assert.notEqual(out.result[0], null, `${name}/${route.id}: flag-off pass`);
          assert.equal(out.result[1], null);
        }
        const wildcardDb = { get() { throw new Error('flag-off read'); },
          all() { throw new Error('flag-off read'); } };
        const wildcard = await profile.scope.resolveScope(wildcardDb, 'u-view1', { scopedMode: false });
        assert.equal(wildcard.wildcard, true);
        const forbiddenGlobals = { cp: { exec() { throw new Error('reboot callback ran'); } },
          fs: fakeFsNoFanHardware };
        const reboot = await run434(profile, 'sys-reboot-fn', db,
          req434(3, 'view1', 'POST', '/api/system/reboot'),
          { env: { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' },
            globals: forbiddenGlobals, libOverrides: { osiLib: forbiddenLib } });
        assert.equal(reboot.result.statusCode, 200);
        assert.equal(scheduled.at(-1).ms, 3000);
        const fan = await run434(profile, 'sys-fan-fn', db,
          req434(3, 'view1', 'POST', '/api/system/fan', {}, { speed: 100 }),
          { env: { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' },
            globals: forbiddenGlobals, libOverrides: { osiLib: forbiddenLib } });
        assert.equal(fan.result.statusCode, 503, 'no simulated fan hardware after bearer passes');
        for (const id of ['system-stats-admin-read-guard', 'fieldtest-download-admin-read-guard']) {
          const route = adminRoutes434.find((candidate) => candidate.id === id);
          const msg = req434(3, 'view1', route.method, route.path, route.params || {});
          msg.req.headers.authorization = 'Bearer invalid';
          const refused = await run434(profile, id, db, msg,
            { env: { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' },
              libOverrides: { osiLib: forbiddenLib } });
          assert.equal(refused.result[0], null);
          assert.equal(refused.result[1].statusCode, 401);
        }
        for (const id of ['sys-reboot-fn', 'sys-fan-fn']) {
          const bad = req434(3, 'view1', 'POST', '/api/system/reboot', {}, { speed: 100 });
          bad.req.headers.authorization = 'Bearer invalid';
          const refused = await run434(profile, id, db, bad,
            { env: { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' },
              globals: forbiddenGlobals, libOverrides: { osiLib: forbiddenLib } });
          assert.equal(refused.result.statusCode, 401);
        }
      } finally { db.close(); profile.scope._resetForTests(); }
    }
    } finally {
      global.setTimeout = realTimer;
      if (oldFlag === undefined) delete process.env.OSI_SCOPED_ACCESS;
      else process.env.OSI_SCOPED_ACCESS = oldFlag;
    }
  });
```

The pinned base must fail R1's demotion/disable 403 assertions, R2's demoted timer or fan-write denial, R3's admin GET refusal, and R4's demoted gateway 403 (GET/PUT/POST all use a real gateway and card). R6 is a compatibility control that may already pass. R5's admin-route part passes at B; its command part fails at B, because the paused waiter returns the old admin scope (`(await waiting).role` is `admin`). Candidate GREEN requires every assertion, including R2's zero scheduled callbacks and R4's zero gateway-context reads, unchanged preference fields, and unchanged preference count. Negative mutations are: move reboot scheduling before the role check (R2 timer count fails), restore the cached role helper (R1–R4 fail), drop a supported invalidation (R5 object identity or old command waiter fails), change account-wide zone reads to owner-only (R4 zone 200 fails), or call the scope helper unconditionally while the flag is off (R6 throws). Do not claim a RED for a case whose base fixture fails before its intended assertion; repair the fixture and re-review the plan.

For the R4 demotion branch specifically, the forecast is base GET 200, PUT 200, and opened POST 200 against the seeded gateway/card/preference; each candidate response is 403 before a gateway-context query or preference mutation. The disabled branch is a base-passing 403 control. R2's base demotion may report a later fan hardware status, but it must fail the expected immediate 403 or zero-side-effect oracle; the candidate returns 403 with zero timers, fake executions, and fan writes. R1 and R3 base demotion must fail their 403 assertions; enabled-viewer filing, R5's admin-route invalidation, and R6 flag-off are compatibility controls. These are forecasts to record per invocation during future RED/GREEN, not observed results.

### Mirrored system-settings test: append to each `osi-system-settings/api.test.js`

The existing file already imports `fs`, `path`, `DatabaseSync` and defines `tempDb`, `insertUser`, `TestDatabase`, `reqAs`, `callScoped`, and `DEFAULT_MODULES_PAYLOAD`. One additional top-level declaration raises each pinned file from 50 to 51. The test uses the shipped UUID trigger, warms the corresponding profile helper, then changes the row without invalidation. Its base RED is the first denied PUT (base returns 200); its candidate GREEN also covers restored admin PUT, viewer GET, and flag-off viewer PUT. A mutation restoring cached role fails the first assertion; an overbroad GET/flag-off role gate fails the controls.

<!-- asset:settings-test -->
```js
test('issue 434 system-settings PUT uses fresh role while GET and flag-off stay open',
  { concurrency: false }, async () => {
    const dbPath = await tempDb();
    const scope434 = require('../osi-scope-helper');
    scope434._resetForTests();
    try {
      insertUser(dbPath, { id: 1, username: 'admin1', role: 'admin' });
      const raw = new DatabaseSync(dbPath);
      let uuid;
      try {
        uuid = raw.prepare('SELECT user_uuid FROM users WHERE id=1').get().user_uuid;
        assert.ok(uuid, 'seed trigger assigned a scope key');
      } finally { raw.close(); }
      const warmDb = TestDatabase(dbPath);
      try {
        // Leave this admin scope cached across the out-of-band demotion.
        assert.equal((await scope434.resolveScope(warmDb, uuid, { scopedMode: true })).role, 'admin');
      } finally { await new Promise((resolve) => warmDb.close(resolve)); }
      const demoteRaw = new DatabaseSync(dbPath);
      try { demoteRaw.exec("UPDATE users SET role='viewer' WHERE id=1"); }
      finally { demoteRaw.close(); }

      const denied = await callScoped(dbPath,
        reqAs('PUT', { gatewayTimezone: 'Europe/Zurich' }, 1, 'admin1'));
      assert.equal(denied.statusCode, 403);
      const inspectDenied = new DatabaseSync(dbPath);
      try {
        assert.equal(inspectDenied.prepare(
          "SELECT value FROM app_settings WHERE key='gateway_timezone'").get(), undefined);
      } finally { inspectDenied.close(); }

      const viewerGet = await callScoped(dbPath, reqAs('GET', undefined, 1, 'admin1'));
      assert.equal(viewerGet.statusCode, 200);
      const flagOff = await handleHttpRequest({
        msg: reqAs('PUT', { gatewayTimezone: 'UTC' }, 1, 'admin1'),
        Database: TestDatabase,
        environment: { authTokenSecret: SECRET, dbPath },
        scope: { assertAuthenticatedRole() { throw new Error('flag-off scope call'); } },
        warn: () => {},
      });
      assert.equal(flagOff.statusCode, 200);

      const restoreRaw = new DatabaseSync(dbPath);
      try { restoreRaw.exec("UPDATE users SET role='admin' WHERE id=1"); }
      finally { restoreRaw.close(); }
      const allowed = await callScoped(dbPath,
        reqAs('PUT', { gatewayTimezone: 'Europe/Zurich' }, 1, 'admin1'));
      assert.equal(allowed.statusCode, 200);
      const inspectAllowed = new DatabaseSync(dbPath);
      try {
        assert.equal(inspectAllowed.prepare(
          "SELECT value FROM app_settings WHERE key='gateway_timezone'").get().value,
          'Europe/Zurich');
      } finally { inspectAllowed.close(); }
    } finally {
      scope434._resetForTests();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
```

### History contract test: append to `scripts/verify-history-api-contract.test.js`

For the RED stage, replace the verifier's final export line exactly:

<!-- asset:contract-export -->
```js
module.exports = { verifyAnalysisRouterImplementation, verifyHistoryRouterImplementation };
```

Replace the test file's existing import exactly:

<!-- asset:contract-import -->
```js
const {
  verifyAnalysisRouterImplementation,
  verifyHistoryRouterImplementation,
} = require('./verify-history-api-contract');
```

Keep the verifier's old gateway literal pin at this stage. Append the test below; it is RED at `router.func.split(freshCall).length - 1 === 1` against pinned base, with no missing-export error. For the candidate stage, replace the old pin with this exact line, and change no other `verifyHistoryRouterImplementation` assertions:

```js
assertContains(failures, adapterSource,
  "assertAuthenticatedRole(db, principal, 'admin', { scopedMode: true })",
  'gateway history uses fresh token-bound admin role (P2)');
```

The new top-level declaration raises the pinned test file from two to three. Candidate GREEN requires the unmodified router to satisfy the pin and a reverted call to fail it. This static test supplements R4's real route behavior.

<!-- asset:contract-test -->
```js
test('gateway history contract requires the fresh token-bound admin call', () => {
  const flows = loadFlows();
  const moduleSource = fs.readFileSync(path.resolve(__dirname, '..',
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/index.js'),
    'utf8');
  const freshCall = "await scope.assertAuthenticatedRole(db, principal, 'admin', { scopedMode: true });";
  const oldCall = "await scope.assertRole(db, user.user_uuid, 'admin', { scopedMode: true });";
  const router = flows.find((node) => node.id === 'history-api-router-fn');
  assert.ok(router);
  assert.equal(router.func.split(freshCall).length - 1, 1);
  const failures = [];
  verifyHistoryRouterImplementation(flows, failures, moduleSource);
  assert.ok(!failures.some((failure) =>
    failure.includes('gateway history uses fresh token-bound admin role (P2)')),
  failures.join('\n'));

  router.func = router.func.replace(freshCall, oldCall);
  const revertedFailures = [];
  verifyHistoryRouterImplementation(flows, revertedFailures, moduleSource);
  assert.ok(revertedFailures.some((failure) =>
    failure.includes('gateway history uses fresh token-bound admin role (P2)')),
  revertedFailures.join('\n'));
});
```

### B amendment: the outbox recovery fixture

`runGuardWithRealScope` in `scripts/test-sync-outbox-recovery-route.js` answers the identity query with `{ user_uuid: 'user-1' }`. Under the one-query helper that row has no `role`, so the admin call is refused with 403, `admin[0]` is `null`, and the test `recovery route applies the real bearer and current admin-role checks` throws while reading `_recoveryActor`. Its researcher and expired-token assertions would still pass, for the wrong reason. The file runs in CI (`migrations.yml`, "Rejection recovery tests") and has been unchanged since N. Replace the one line with the full row:

<!-- asset:before-outbox-fixture -->
```js
      if (sql.includes('id = ? AND username = ?')) return { user_uuid: 'user-1' };
```

<!-- asset:outbox-fixture -->
```js
      if (sql.includes('id = ? AND username = ?')) {
        return { id: 7, username: 'operator', role, disabled_at: null, user_uuid: 'user-1' };
      }
```

At B the identity branch returns the full row, `loadUser` still matches the `user_uuid = ?` branch, and all five tests keep their meaning, so this is a compatibility fixture rather than a RED. On the candidate the single bound query receives `role` and `username`: the admin call returns `_recoveryActor === 'operator'` and the researcher call fails on its role. The file keeps 5 top-level tests. Mutant M7 restores the old line on the candidate. Its researcher and expired-token checks still pass; the admin call is refused, `admin[0]` is `null`, and evaluating `admin[0]._recoveryActor` throws a `TypeError` inside `recovery route applies the real bearer and current admin-role checks` before `assert.equal` runs. That TypeError in the named test is the intended M7 failure. It is not an `AssertionError`, and no assertion is added to the claimed one-line fixture.

### One-shot guarded flow editor for the later isolated checkout

Use this literal temporary script only after the plan-only SHA passes independent review. Step 0 extracts it to `$RCPT/tools/flow-editor.cjs` and checks its digest against `FLOW_EDITOR_SHA256`; step 3 (`p2-flows`) invokes it once from the isolated repo root. It performs all assertions in memory before writing either profile. A failure exits before product writes. The subsequent reviewed diff and profile-parity gate remain mandatory. This script and invocation are **UNRUN** here.

<!-- asset:flow-editor -->
```js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const profiles = ['bcm2712', 'bcm2709'];
const paths = profiles.map((profile) => path.join(root,
  `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`));
const originals = paths.map((file) => fs.readFileSync(file, 'utf8'));
const parsed = originals.map((source) => JSON.parse(source));
const serialize = (flows) => JSON.stringify(flows, null, 2) + '\n';
for (let i = 0; i < paths.length; i += 1) {
  assert.equal(serialize(parsed[i]), originals[i], `${profiles[i]} JSON roundtrip`);
}
assert.equal(originals[0], originals[1], 'maintained flow profiles start byte-identical');
const oldCall = "await scope.assertRole(db, user.user_uuid, 'admin', { scopedMode: true });";
const freshCall = "await scope.assertAuthenticatedRole(db, principal, 'admin', { scopedMode: true });";
const indexes = parsed.map((flows) => {
  const matching = flows.map((node, index) => node.id === 'history-api-router-fn' ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(matching.length, 1, 'exactly one history router per profile');
  return matching[0];
});
for (let p = 0; p < parsed.length; p += 1) {
  const node = parsed[p][indexes[p]];
  const originalFunc = node.func;
  assert.equal(originalFunc.split(oldCall).length - 1, 1, 'exactly one old call');
  const lines = originalFunc.split('\n');
  const callLine = lines.findIndex((line) => line.trim() === oldCall);
  assert.ok(callLine > 0, 'old call has a preceding line');
  assert.equal(lines.filter((line) => line.trim() === oldCall).length, 1);
  assert.equal(lines[callLine - 1].trim(), '// P2: gateway-wide history stays admin-only.');
  assert.equal(lines.filter((line) =>
    line.trim() === '// P2: gateway-wide history stays admin-only.').length, 1);
  const oldSpan = lines[callLine - 1] + '\n' + lines[callLine];
  const freshLine = lines[callLine].replace(oldCall, freshCall);
  node.func = originalFunc.replace(oldSpan, freshLine);
  assert.ok(node.func.length <= originalFunc.length, 'history node must not grow');
  const restored = node.func.replace(freshLine, oldSpan);
  assert.equal(restored, originalFunc, 'only intended function span changed');
}
const outputs = parsed.map(serialize);
assert.equal(outputs[0], outputs[1], 'edited profiles remain byte-identical');
for (let i = 0; i < paths.length; i += 1) {
  fs.writeFileSync(paths[i], outputs[i]);
}
```

This one-shot editor claims only `history-api-router-fn.func`. It neither changes wiring nor touches flow allowances. The future exact-plan review must confirm the pinned comment's indentation and profile roundtrip before permitting execution; if either differs, stop and amend the plan rather than modifying the script ad hoc. The reconciliation confirmed both at B: the comment has four-space indentation and both profiles roundtrip byte-identical.

### Guarded stage editor

Step 0 extracts this block and `s0-verify` compares its SHA-256 with `STAGE_EDITOR_SHA256` from the Sol acceptance record before it runs. Its pins are the SHA-256 digests of the files at B and after each stage; the reconciliation computed them by applying the same recipe in a separate implementation, without running this script.

<!-- asset:stage-editor -->
```js
'use strict';
// Issue 434 stage editor. Run from the isolated repo root:
//   PLAN_SHA256=<accepted digest> node <tools>/issue-434-stage-edit.cjs <mode> [mutant]
// Modes: test, product, check-test, check-product, check-flows, mutate <M1..M7>.
// It reads literal blocks from the plan file at PLAN, refuses unless that
// file's digest equals PLAN_SHA256, checks every input digest before writing,
// and checks every output digest before writing anything. Step 0 separately
// proves that file is the clean committed blob one commit above B.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const PLAN = 'docs/superpowers/plans/2026-10-29-issue-434-admin-freshness.md';
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const planBytes = fs.readFileSync(path.join(ROOT, PLAN));
assert.equal(crypto.createHash('sha256').update(planBytes).digest('hex'),
  process.env.PLAN_SHA256, 'committed plan digest must equal PLAN_SHA256');
const planLines = planBytes.toString('utf8').split('\n');

function asset(name) {
  const marker = '<!-- asset:' + name + ' -->';
  const at = planLines.indexOf(marker);
  assert.ok(at >= 0, 'missing marker ' + name);
  assert.equal(planLines.indexOf(marker, at + 1), -1, 'duplicate marker ' + name);
  assert.equal(planLines[at + 1], '```js', 'fence after marker ' + name);
  const end = planLines.indexOf('```', at + 2);
  assert.ok(end > at + 1, 'closing fence for ' + name);
  return planLines.slice(at + 2, end).join('\n');
}

function replaceOnce(text, from, to, label) {
  const count = text.split(from).length - 1;
  assert.equal(count, 1, label + ': expected one match, found ' + count);
  return text.replace(from, () => to);
}

const PROFILES = ['bcm2712', 'bcm2709'];
const share = (p) => 'conf/full_raspberrypi_bcm27xx_' + p + '/files/usr/share';
const HELPER = PROFILES.map((p) => share(p) + '/node-red/osi-scope-helper/index.js');
const HELPER_TEST = PROFILES.map((p) => share(p) + '/node-red/osi-scope-helper/index.test.js');
const SETTINGS_TEST = PROFILES.map((p) => share(p) + '/node-red/osi-system-settings/api.test.js');
const FLOWS = PROFILES.map((p) => share(p) + '/flows.json');
const WRITES = 'scripts/test-scoped-access-writes.js';
const CONTRACT = 'scripts/verify-history-api-contract.js';
const CONTRACT_TEST = 'scripts/verify-history-api-contract.test.js';
const OUTBOX = 'scripts/test-sync-outbox-recovery-route.js';

// Digests at B (bd1afcd2) and the forecast digests after each stage.
const PIN = {
  "base": {
    "helper": "5c652cf6c7d7ca8f7cc6bf242f5edcb8de6e7fd37f05bee88ce00d93393af63c",
    "helperTest": "bd53dc5918f0e0a7a795cce4a9f6785667946232454b8d1eb4a9bbd6f187dfb8",
    "settingsTest": "2287392fe1e24078705d42ed22138a6873b4efa13f2e65041ba203b2d53af827",
    "flows": "542df53f2744dc454ae4c0b27cf3663e83c0b4b870325faed2efa39939dc6117",
    "writes": "3b6a5f4690d860fbd53f7bc2a354d194d56a3e64c4cc7c68108e7d3a9cfce876",
    "contract": "6bf21dfda7f090d902f5140c25295c7f8f4373502a36f8cc2a8a6fb67e869598",
    "contractTest": "ce56b27a1b89dcbb28160052d09cf47d6f2ffce6824d6253159f60e88b119592",
    "outbox": "7358e953c199572499341cb0592b211bed03fabf857908bd49eb08cc6420de43"
  },
  "test": {
    "helperTest": "eb28a8d895caff45e894748b5c9fbc4d559dfbd7c36761649fc96a938c77486b",
    "settingsTest": "f7a1c802c229d85a71a757b424f0c52b670aa47b5b3f160926f8940cff3e1779",
    "writes": "84fa9f3d3b7fb9857fe9e83418a64139cec305e80c87cd473e8fa55d1d6dc095",
    "contract": "41ab2ead35f371b82f26481ed1f7580564b417ee855f699fc0aa7f155c7677fe",
    "contractTest": "e073d5e36da947df98164140c6927d05ae996d26fbfe582c33da587117362134",
    "outbox": "9434ce3f947743b4732e3f346581034bf7f858136cd7a2d13f54c3534caa4f8f"
  },
  "product": {
    "helper": "2b18361730f169feb86ae19a1b8004e323db7a55e33c75dac1a3b52c07dc5b28",
    "contract": "1981fd18f444a358a4981894ff9877b8bc9a81788c29e3edab7aaa0df77e6a96",
    "flows": "a69eff0daa1a5e3185c1b4dc32e1ff4525761e800f8e91ef8ba77053386eab13"
  }
};

function expect(rel, digest, label) {
  assert.equal(sha(read(rel)), digest, label + ': ' + rel);
}

function planWrites(edits) {
  // Every output digest is checked before the first write.
  for (const [rel, text, digest] of edits) assert.equal(sha(text), digest, 'forecast digest: ' + rel);
  for (const [rel, text] of edits) fs.writeFileSync(path.join(ROOT, rel), text);
}

function testStage() {
  const edits = [];
  for (const rel of HELPER_TEST) {
    let t = read(rel);
    assert.equal(sha(t), PIN.base.helperTest, 'B helper test: ' + rel);
    t = replaceOnce(t, "const scope = require('./index.js');\n",
      "const scope = require('./index.js');\nconst { DatabaseSync } = require('node:sqlite');\nconst path = require('node:path');\n",
      'helper test imports');
    t = replaceOnce(t, asset('before-helper-test-1') + '\n', asset('helper-test-replace-1') + '\n', 'helper test 1');
    t = replaceOnce(t, asset('before-helper-test-2') + '\n', asset('helper-test-replace-2') + '\n', 'helper test 2');
    t = t + '\n' + asset('helper-test-fixture') + '\n\n' + asset('helper-test-H') + '\n';
    edits.push([rel, t, PIN.test.helperTest]);
  }
  for (const rel of SETTINGS_TEST) {
    const t = read(rel);
    assert.equal(sha(t), PIN.base.settingsTest, 'B settings test: ' + rel);
    edits.push([rel, t + '\n' + asset('settings-test') + '\n', PIN.test.settingsTest]);
  }
  {
    const t = read(WRITES);
    assert.equal(sha(t), PIN.base.writes, 'B writes test');
    edits.push([WRITES, t + '\n' + asset('writes-R') + '\n', PIN.test.writes]);
  }
  {
    const t = read(CONTRACT);
    assert.equal(sha(t), PIN.base.contract, 'B contract verifier');
    edits.push([CONTRACT, replaceOnce(t, 'module.exports = { verifyAnalysisRouterImplementation };\n',
      asset('contract-export') + '\n', 'contract export'), PIN.test.contract]);
  }
  {
    let t = read(CONTRACT_TEST);
    assert.equal(sha(t), PIN.base.contractTest, 'B contract test');
    t = replaceOnce(t, "const {\n  verifyAnalysisRouterImplementation,\n} = require('./verify-history-api-contract');\n",
      asset('contract-import') + '\n', 'contract import');
    edits.push([CONTRACT_TEST, t + '\n' + asset('contract-test') + '\n', PIN.test.contractTest]);
  }
  {
    const t = read(OUTBOX);
    assert.equal(sha(t), PIN.base.outbox, 'B outbox recovery test');
    edits.push([OUTBOX, replaceOnce(t, asset('before-outbox-fixture') + '\n', asset('outbox-fixture') + '\n',
      'outbox fixture'), PIN.test.outbox]);
  }
  for (const rel of [...HELPER, ...FLOWS]) expect(rel, rel.endsWith('flows.json') ? PIN.base.flows : PIN.base.helper, 'unchanged product');
  planWrites(edits);
}

function helperParts() {
  const parts = asset('product-helper').split(/\n\n(?=\S)/);
  assert.equal(parts.length, 5, 'product helper block has five declarations');
  assert.equal(parts[0], 'const pendingLoads = new Map();');
  assert.ok(parts[1].startsWith('async function resolveScope('));
  assert.ok(parts[2].startsWith('function invalidateScope('));
  assert.ok(parts[3].startsWith('async function assertAuthenticatedRole('));
  assert.ok(parts[4].startsWith('function _resetForTests('));
  return parts;
}

function productStage() {
  checkTest();
  for (const rel of [...HELPER, ...FLOWS]) expect(rel, rel.endsWith('flows.json') ? PIN.base.flows : PIN.base.helper, 'unchanged product');
  const parts = helperParts();
  const edits = [];
  for (const rel of HELPER) {
    let t = read(rel);
    assert.equal(sha(t), PIN.base.helper, 'B helper: ' + rel);
    t = replaceOnce(t, 'const cache = new Map();\n', 'const cache = new Map();\n' + parts[0] + '\n', 'pendingLoads');
    t = replaceOnce(t, asset('before-resolveScope') + '\n', parts[1] + '\n', 'resolveScope');
    t = replaceOnce(t, asset('before-invalidateScope') + '\n', parts[2] + '\n', 'invalidateScope');
    t = replaceOnce(t, asset('before-assertAuthenticatedRole') + '\n', parts[3] + '\n', 'assertAuthenticatedRole');
    t = replaceOnce(t, asset('before-resetForTests') + '\n', parts[4] + '\n', '_resetForTests');
    edits.push([rel, t, PIN.product.helper]);
  }
  edits.push([CONTRACT, replaceOnce(read(CONTRACT), asset('before-contract-pin') + '\n',
    asset('contract-pin') + '\n', 'contract pin'), PIN.product.contract]);
  planWrites(edits);
}

function checkTestFiles() {
  for (const rel of HELPER_TEST) expect(rel, PIN.test.helperTest, 'test stage');
  for (const rel of SETTINGS_TEST) expect(rel, PIN.test.settingsTest, 'test stage');
  expect(WRITES, PIN.test.writes, 'test stage');
  expect(CONTRACT_TEST, PIN.test.contractTest, 'test stage');
  expect(OUTBOX, PIN.test.outbox, 'test stage');
}

function checkTest() {
  checkTestFiles();
  expect(CONTRACT, PIN.test.contract, 'test stage');
}

function checkProduct() {
  checkTestFiles();
  for (const rel of HELPER) expect(rel, PIN.product.helper, 'product stage');
  expect(CONTRACT, PIN.product.contract, 'product stage');
}

function checkFlows() {
  for (const rel of FLOWS) expect(rel, PIN.product.flows, 'flow editor output');
}

const FRESH = "await scope.assertAuthenticatedRole(db, principal, 'admin', { scopedMode: true });";
const OLD = "await scope.assertRole(db, user.user_uuid, 'admin', { scopedMode: true });";
function mutants() {
  const parts = helperParts();
  return {
    M1: HELPER.map((rel) => [rel, parts[3] + '\n', asset('before-assertAuthenticatedRole') + '\n']),
    M2: HELPER.map((rel) => [rel, '    if (pending) for (const ticket of pending) ticket.invalidated = true;\n', '']),
    M3: HELPER.map((rel) => [rel, '  for (const pending of pendingLoads.values()) {\n    for (const ticket of pending) ticket.invalidated = true;\n  }\n', '']),
    M4: HELPER.map((rel) => [rel, '      if (ticket.invalidated) continue;\n', '']),
    M5: HELPER.map((rel) => [rel, 'for (let attempt = 0; attempt < 2; attempt += 1) {', 'for (let attempt = 0; attempt < 3; attempt += 1) {']),
    M6: FLOWS.map((rel) => [rel, FRESH, OLD]),
    M7: [[OUTBOX, asset('outbox-fixture') + '\n', asset('before-outbox-fixture') + '\n']],
  };
}

function mutate(id) {
  checkProduct();
  checkFlows();
  const list = mutants()[id];
  assert.ok(list, 'unknown mutant ' + id);
  const out = list.map(([rel, from, to]) => [rel, replaceOnce(read(rel), from, to, id + ' ' + rel)]);
  for (const [rel, text] of out) fs.writeFileSync(path.join(ROOT, rel), text);
  console.log('mutant ' + id + ' applied to ' + out.map(([rel]) => rel).join(', '));
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'test') testStage();
else if (mode === 'product') productStage();
else if (mode === 'check-test') checkTest();
else if (mode === 'check-product') checkProduct();
else if (mode === 'check-flows') checkFlows();
else if (mode === 'mutate') mutate(arg);
else throw new Error('usage: issue-434-stage-edit.cjs test|product|check-test|check-product|check-flows|mutate <M1..M7>');
console.log('issue-434-stage-edit ' + mode + (arg ? ' ' + arg : '') + ': OK');
```

## Integration seams with work that is not on main

Nothing below is composed here. Each later integration recomputes affected allowances, reruns profile parity and the commands above, and gets a fresh final-SHA review. The stage editor's B digests will refuse a tree that already contains any of these changes; composing them needs a re-pinned plan.

| Work | Candidate head | Overlap with #434 | Seam |
|---|---|---|---|
| #443 edge | `ba1a06f931002d6fddf5e6c5e862ac0886446e4c`, parent B | both `osi-scope-helper/index.js`: 150 lines inserted after line 340, just before `_resetForTests`, plus new exports; `test-scoped-access-writes.js` P9/W4 edits with no new top-level test; `cs-reg-cloud-fn` and `cs-reg-cloud-ack-fn` in both flows; silent-catch baseline; `verify-sync-flow.js`; `migrations.yml` | #434 rewrites `_resetForTests` (B lines 341–343), one unchanged line below #443's insertion point. A text merge is likely clean and must still be checked. |
| #521, PR #569 | `98cda757072b7ec040477d1ce449639f8d31ed41`, parent B | `scoped-admin-account-router` (user list and create carry `auth_mode`, password reset refusal); both flows; size allowances; `migrations.yml` | R5 drives that router's create, role and disabled routes; rerun R5 after #521 lands. |
| #356, PR #573 | `58e38651d188486b964cf4cc522647ec4e5dfed7`, parent B | four Chameleon flow nodes in both flows; allowances; silent-catch baseline; `verify-sync-flow.js` and its workflow | Flow, allowance and baseline merge; no consumer node overlap. |
| #331, PR #572 | `8a2e75675d8b59ba584c4733ace27a2813072f3f`, parent B | `sync-bootstrap-build` and `sync-force-build` in both flows; `sync-force-build` is wired after `sync-force-admin-write-guard` | Flow merge; R1 executes only the guard, which is unchanged. |
| #436, PR #561 | `5bdf01e94a5b9c9f330d497301dee8834eb8e930`, parent `f6682ef6` | `verify-history-api-contract.js` export line and the test's import block, four new tests; `history-api-response` headers; `migrations.yml` | Merge both export names and both imports; the contract test then has 7 top-level tests. |
| PR #533 (#377) | `7bd3894584f96acae6b7ea60e34f43007cf7c8f5` | `scripts/lib/scoped-access-harness.js`: `facadeDb` gains an optional call gate | Rerun R1–R6 and H10 if it lands first. |
| PR #565 | `b1f983e2c4125ba0c00f79f251a55f7380363970` | size ratchet becomes fix-only, with `flows-growth-exceptions.json` | #434 shrinks one node and adds none; rerun the size gate under the new rule. |
| PR #550 (#395) | `87a797b732ec7542599b4308e271cb2f3b7daab8` | `run-module-tests.js` and `verify-test-inventory.js` | Rerun the module-test commands with the new runner. |
| #520 | stopped after round 5 | none | Permanent token revocation stays separate; fresh role reads do not provide it. |
| #370, #450, #451 | planned, not executing | scope helper and flow planning surfaces | Independent; recheck claims before any of them executes. |

## Reconciliation record (N to B)

Source of this record: a wrapped read-only audit at B, receipts in the campaign report `issue-434-current-base-reconcile-r1`. Changed inputs and what each means for this plan:

| Input | N to B | Effect on this plan |
|---|---|---|
| `osi-scope-helper/index.js`, `index.test.js` (both) | unchanged | Design and fixture replacements apply as accepted. |
| `osi-system-settings/api.js`, `api.test.js` (both) | unchanged | Settings test applies as accepted (50 → 51). |
| `osi-scoped-access-commands/index.js`, test | unchanged | R5 command fixture applies as accepted. |
| `verify-history-api-contract.js`, test | unchanged | Export, import, pin and new test apply as accepted (2 → 3). |
| `flows.json` (both) | changed; profiles still identical | Consumer nodes unchanged except `history-api-router-fn` card-data builders; edit anchors unchanged; −42 characters. `conditional-policy-route-fn` added (fresh paths). Four scoped zone/device routers moved into `osi-irrigation-policy/routes.js`; zone delete no longer invalidates the cache (reported separately). |
| `osi-history-router/index.js` | changed (source-aware card data, soil profiles moved in) | R4 routes (gateway cards list, preferences PUT, opened POST) do not reach the changed builders. |
| `scripts/lib/scoped-access-harness.js` | additive: `profilePaths`, `nodeRedModules` option, registry-backed `moduleByName`, `seedScopedDb(valveEui)` default unchanged | Draft calls keep their meaning; harness modules other than the scope helper still load from bcm2712. |
| `scripts/test-scoped-access-writes.js` | five STREGA claim tests added; fixtures used by R1–R6 unchanged | Count forecast 101 → 107. |
| `database/seed-blank.sql` | additive policy tables and columns; no trigger change on `users`, `irrigation_zones`, `history_card_preferences` | Fixtures unaffected. |
| `scripts/test-sync-outbox-recovery-route.js` | unchanged; missed at N | Fixture replacement added (M7). |
| `capture-history-router-vectors.js`, `history-router.yml` | script unchanged; workflow gained a step | Golden vectors added as regression control. |
| `verify-scoped-access.js`, its test, `test-flows-wiring.js`, `test-history-source-guards.js`, `verify-sync-flow.js`, `verify-profile-parity.js`, `verify-test-inventory.js` and inventory JSON, silent-catch baseline, size allowances, `deploy.sh`, workflows | changed for other work | No pin on the edited text; still gates. `deploy.sh` still fetches the helper and settings files. |
| `AGENTS.md`, playbook, skills | changed | Risk-class loop applies; base-ref pinning per the verification skill; merge-time allowance checks noted for integration. |
| CI workflows (all) | read at B for packet R2 | Every CI-run file and every `verify-sync-flow.js` child has a command or a source exclusion ("CI dependency accounting"). |
| `history-api-router-fn` H10 race, M7 and R5 forecasts | packet R2 | H10 cannot wait on an unopened barrier; M7 is a `TypeError` in the named test; R5's command part is a base RED. |
| H4–H6 base forecasts | packet R3 | H4 fails at its SQL equality, H5 at its call list and H6 at its first `assert.rejects`, in both helper profiles and under M1; H12 still passes at B. |
