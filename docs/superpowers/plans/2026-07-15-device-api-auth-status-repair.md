# Device API auth status propagation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every auth-gated route on the Device API tab return HTTP 401 for the shipped bearer-token failures while retaining HTTP 500 for unexpected handler failures.

**Architecture:** Every shipped `verifyBearer` copy sets one private, exact `msg._osiAuthFailure` tag immediately before every auth throw, using three public failure codes and clears the field before verification. The tag contains only `{format:1,code,sourceId}`, where the closed code enum is `MISSING_BEARER|INVALID_TOKEN|TOKEN_EXPIRED`; public messages are mapped centrally. A successful verifier leaves no tag, so a later domain failure in the same mixed-responsibility function cannot become a false 401. The tab catch responder returns 401 only when the catch source is in the reviewed inventory and an exact tag from that same source carries a recognized code. It returns a bounded 500 for every untagged, malformed, injected, stale, or mismatched error. The route fixture and executable graph test prove complete route-to-auth-to-local-response or tab-catch-to-response reachability.

**Tech Stack:** Node-RED function nodes, Node.js 22 `node:test`, Python 3 pipeline checks, pytest, curl.

## Global constraints

- Execute the sync delivery stop-loss plan first. This plan may then run in parallel with the LSN50/database and ChirpStack repairs; rebase cleanly because they share flow verifiers and CI workflow files.
- Base implementation on `origin/main` containing merged [OSI OS PR #146](https://github.com/Open-Smart-Irrigation/osi-os/pull/146), merge commit `f50950b1767a1aa6302ef2553d68a4e379b5b142` or a verified descendant. Rerun the 41-verifier/route inventory on that flow before mutation. Preserve the merged restart-sentinel gates, system-status API, `GatewayRestartBanner`, `useSystemStatus`, i18n strings, identity tests, and flow-size allowances; this plan changes no React source.
- Under `2026-07-15-refactor-repair-program.md`, use this plan's Kaba100 steps as checks inside the single Train A deployment, not as a separate deploy or restart.
- Change no React source. The stale dendrometer GUI data was caused by missing edge rows, not rendering logic.
- Edit the canonical `flows.json` with a guarded one-shot script and mirror it byte-for-byte to bcm2709.
- The `scripts/verify-flows-size-ratchet-allowances.json` edits in this plan target the absolute `max_chars`/`max_total` schema created by repair-program Task A0. At the pinned base the file still holds base-relative deltas, so standalone execution outside the program must land A0's ratchet-format migration first (or an equivalent reviewed migration) before changing any ceiling.
- Keep JSON responses bounded. Do not expose stack traces, tokens, secrets, arbitrary Error properties, or unexpected Error messages.
- Preserve every authenticated route's success behavior and every unexpected-error 500 path.
- Keep the existing verifier copies in this repair, but mechanically add and verify the same private failure-tag protocol in all 41. Do not introduce a second authentication implementation or hand-edit a subset.
- Do not access `osicloud.ch`.
- If the LSN50 writer recovery is also locally green, deploy one combined payload after both commit series instead of restarting Kaba100 twice. Run both plans' live gates against the same recorded commit.

---

## Confirmed cause and scope

Commit `e100c796` changed `device-api-http500` to read `msg.error.statusCode`. A Node-RED catch message preserved `Error: Unauthorized` but did not preserve the thrown Error object's custom `statusCode`. Kaba100 therefore still returned:

```text
HTTP 500
{"error":"device-api failed","message":"Error: Unauthorized"}
```

Current `main` has 103 function nodes on `device-api-tab`; 41 contain their own `verifyBearer` copy. Those copies use three 401 messages: `Unauthorized`, `Invalid token`, and `Token expired`. Configuration failure from `getAuthSecret()` uses a different message and must remain 500.

The tab already has one catch node, `device-api-catch`, wired to `device-api-http500`, then to `device-response`. Fixing only `get-devices-auth` would leave the same regression on the other 40 auth-bearing handlers.

## File map

| File | Responsibility after this plan |
|---|---|
| `scripts/fixtures/device-api-auth-routes.json` | Exact reviewed HTTP route, method, route-node ID, and auth-source-node ID inventory for current `main`. |
| `scripts/test-device-api-auth-status.js` | Verifies the route/source inventory and executes every shipped Device API auth node plus the shared catch responder in both maintained profiles. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | Verifier-owned private auth tags plus central code-to-public-response classification. |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` | Byte-identical runtime mirror. |
| `scripts/verify-sync-flow.js` | Structural pins for the bounded 401 classifier and unexpected-error 500 behavior. |
| `scripts/pipeline/checks/routes.py` | Requires exact 401 from unauthenticated protected probes and exact 200 from separate authenticated probes. |
| `scripts/pipeline/tests/test_checks.py` | Rejects the former `/api/irrigation-zones` 500 allowance. |
| `.github/workflows/verify-sync-flow.yml` | Runs the executable auth-status test in CI. |
| `scripts/test-ci-guard-wiring.js` | Pins the direct auth-status command in the required workflow. |

### Task 1: Reproduce the tab-wide status loss with executable tests

**Files:**

- Create: `scripts/test-device-api-auth-status.js`
- Create: `scripts/fixtures/device-api-auth-routes.json`

**Interfaces:**

- Produces: an exact, unknown-field-rejecting inventory of every protected Device API HTTP route, auth function, and allowed terminal response boundary.
- Produces: an executable test that requires discovered routes, discovered verifier nodes, the inventory, responder source allowlist, and complete route-to-auth-to-response/catch reachability to agree.
- Produces: `executeFunction(node, msg, options) -> Promise<unknown>` and `asCatchMessage(msg, error) -> object` test helpers.

- [ ] **Step 1: Build a small function-node executor**

Use `node:vm`, not source-string rewriting. Compile each shipped function body with these arguments:

```js
const fn = new vm.Script(
  `(async function(msg, node, env, global, crypto, Buffer) {${node.func}\n})`
).runInNewContext({ console, Date, Promise, setTimeout, clearTimeout });
```

Provide `node.warn/error/status` spies, `env.get`, and `global.get`. For the missing-token cases, the verifier throws before reading the auth secret or filesystem. Convert a thrown Error into the observed Node-RED catch shape:

```js
function asCatchMessage(msg, error, sourceId) {
  return {
    ...msg,
    error: {
      message: `Error: ${String(error.message || error)}`,
      source: { id: sourceId, type: 'function' },
    },
  };
}
```

- [ ] **Step 2: Test every auth-bearing node in both profiles**

Create `scripts/fixtures/device-api-auth-routes.json` from a manual review of current `main`. Each sorted entry has exactly `method`, `url`, `httpNodeId`, and `authNodeId`. It contains the 43 protected HTTP route nodes and 41 distinct verifier-bearing auth sources currently present; the two shared auth sources each retain both route entries. The fixture also carries a sorted `unprotectedRoutes` array with exactly `method`, `url`, and `httpNodeId` per entry, naming the three deliberately public route nodes at the pinned base: `GET /api/catalog` (`get-catalog-http`), `GET /api/v1/devices/:deveui/today-liters` (`strega-today-liters-http-in`), and `OPTIONS /api/*` (`device-options-http`). The test requires every discovered `http in` node on `device-api-tab` to appear in exactly one of the two lists, so a new route cannot land unprotected without an explicit fixture review. Do not infer protection from a name prefix. The test rejects unknown/duplicate entries, a route or source outside `device-api-tab`, a non-HTTP route node, a non-function auth node, a method/URL mismatch, a first wire that bypasses the declared auth source, or an auth source without `function verifyBearer`.

For each maintained profile:

1. load `flows.json`;
2. find `device-api-http500`, every protected HTTP route, every Device API function containing `function verifyBearer`, all link-node transitions, and all local/shared response terminals;
3. require exact set equality between discovered route/source pairs and the reviewed fixture, exact equality between distinct fixture sources and the responder allowlist, and complete route-to-auth-to-response/catch reachability;
4. construct deterministic tokens for malformed parts, bad signature, correctly signed malformed payload JSON, correctly signed invalid claims, and correctly signed expiry, using a test-only `JWT_SECRET`;
5. invoke every auth node with no authorization plus all five invalid token variants;
6. if the node returns its auth response locally, require status 401 and require `payload.message || payload.error` to equal the expected bounded message; and
7. if the node rejects, require the expected message and exact same-source private tag/code, pass the synthetic catch message into `device-api-http500`, and require status 401 with `{ error: 'Unauthorized', message: <expected> }`.

The missing header maps to `MISSING_BEARER/Unauthorized`; malformed parts, bad signature, malformed JSON, and invalid claims map to `INVALID_TOKEN/Invalid token`; expiry maps to `TOKEN_EXPIRED/Token expired`. Fail if a node neither returns a 401 response nor rejects. This preserves the already-correct local handlers while covering every uncaught handler through the shared responder. It also makes any future verifier-message drift fail CI.

For each route, traverse the executable Node-RED graph rather than checking only its first wire. Require every path to enter its declared auth source before any domain-mutating node, and every auth outcome to reach either a local HTTP response or `device-api-catch -> device-api-http500 -> device-response`. Reject a cycle without a bounded terminal, a link-node target that bypasses auth, a second unreviewed auth source, a response reachable before auth, or a dangling branch. Add mutation controls that remove one fixture route, remove one distinct source, redirect the first or an intermediate/link wire around auth, add a pre-auth response, detach the catch response, add an undeclared verifier route, add a new `http in` node absent from both the protected and unprotected lists, or add an unused allowlisted source. Each must fail with the exact route, path, or set difference. A new protected route therefore requires explicit fixture review. Independently remove the tag assignment from each of the six verifier throw sites, one at a time, and require the executable invalid-token case for that site to fail with the source and failure category.

- [ ] **Step 3: Cover every bounded auth message and the 500 control case**

Invoke the catch responder directly with both plain and Node-RED-prefixed forms:

```js
const authMessages = [
  'Unauthorized',
  'Error: Unauthorized',
  'Invalid token',
  'Error: Invalid token',
  'Token expired',
  'Error: Token expired',
];
```

For each public auth message, supply the exact same-source private tag and code produced by that verifier and require 401. Then use the same `Unauthorized`, `Invalid token`, and `Token expired` text from a real non-auth source, an unknown source, a missing source, and a declared auth source after a successful verifier with no tag; require 500 and `{ error: 'device-api failed', message: 'Internal server error' }`. Also reject a request-injected tag, unknown code, extra tag field, wrong format, wrong source ID, stale tag on a success path, and tag/message disagreement. Send configuration and secret-sentinel errors from a declared auth source and require bounded 500. Pin that tagged throws occur only inside `verifyBearer`, the tag is cleared at verifier entry, and every successful call leaves it absent. Warnings identify only a bounded source ID.

- [ ] **Step 4: Run the test and capture the red signal**

```bash
node --test scripts/test-device-api-auth-status.js
```

Expected: FAIL because current verifiers do not emit the trusted tag and the catch responder still returns 500.

- [ ] **Step 5: Preserve red evidence without creating a broken commit**

Record the failing command and assertion in the execution report or review notes. Keep the test file uncommitted while Task 2 is implemented. Do not add a deliberately failing CI step, commit, or push; the final green commit must contain both the reproducer and repair.

### Task 2: Classify bounded auth failures at the shared catch responder

**Files:**

- Carry forward from Task 1: `scripts/test-device-api-auth-status.js`
- Carry forward from Task 1: `scripts/fixtures/device-api-auth-routes.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: `.github/workflows/verify-sync-flow.yml`
- Modify: `scripts/test-ci-guard-wiring.js`

**Interfaces:**

- Consumes: the catch source ID plus the exact verifier-owned `{format,code,sourceId}` tag preserved on `msg`.
- Produces: `{ error: 'Unauthorized', message: <bounded-auth-message> }` with status 401, or `{ error: 'device-api failed', message: 'Internal server error' }` with status 500.

- [ ] **Step 1: Add the green test to CI**

After the implementation below makes the focused test pass, add this step after the sync-flow verifier in `.github/workflows/verify-sync-flow.yml`:

```yaml
- name: Verify Device API auth status propagation
  run: node --test scripts/test-device-api-auth-status.js
```

Extend `scripts/test-ci-guard-wiring.js` with that exact command and a remove-one negative; run it in the green slice. The aggregate flow verifier cannot replace the route-level executable.

- [ ] **Step 2: Add structural pins for the trusted tag policy**

Require `device-api-catch -> device-api-http500 -> device-response`, complete route reachability, exact fixture/allowlist equality, and the same verifier protocol in all 41 sources. The verifier must delete `msg._osiAuthFailure` at entry and set it immediately before every auth throw and nowhere else:

```js
msg._osiAuthFailure = { format: 1, code: '<closed-code>', sourceId: '<literal-node-id>' };
```

Pin exact code-to-message mappings and reject any tagged throw outside the lexical `verifyBearer` body. The responder must require exact tag keys, `format === 1`, a reviewed source, equality between tag and catch source IDs, and one recognized code. Exclude `msg.error.statusCode` and raw-message classification.

- [ ] **Step 3: Add tags to every verifier and classify only those tags**

Use the guarded parse-mutate-serialize procedure. After the mandatory no-op round-trip check, mechanically update all 41 verifier-bearing function bodies from the reviewed fixture. At verifier entry delete any preexisting `msg._osiAuthFailure`. At all six current throw sites—missing bearer, malformed token parts, bad signature, malformed payload JSON, invalid claims, and expiry—immediately before the throw, set codes `MISSING_BEARER`, `INVALID_TOKEN`, and `TOKEN_EXPIRED` with that function node literal ID. Do not tag configuration, database, validation, or domain errors. Then replace `device-api-http500` with an exact validator:

```js
if (!msg.res) return null;
const sourceId = String(msg.error?.source?.id || '');
const tag = msg._osiAuthFailure;
const authSources = new Set([/* exact sorted fixture source IDs */]);
const publicByCode = new Map([
  ['MISSING_BEARER', 'Unauthorized'],
  ['INVALID_TOKEN', 'Invalid token'],
  ['TOKEN_EXPIRED', 'Token expired'],
]);
const exactKeys = tag && Object.keys(tag).sort().join(',') === 'code,format,sourceId';
const authMessage = exactKeys && tag.format === 1 &&
  authSources.has(sourceId) && tag.sourceId === sourceId
  ? publicByCode.get(tag.code)
  : undefined;
const statusCode = authMessage ? 401 : 500;
delete msg._osiAuthFailure;
if (statusCode === 500) {
  const boundedSourceId = String(sourceId || 'unknown')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 64);
  node.warn('Device API handler failed at node ' + boundedSourceId);
}
msg.statusCode = statusCode;
msg.headers = { 'Content-Type': 'application/json; charset=utf-8' };
msg.payload = {
  error: statusCode === 401 ? 'Unauthorized' : 'device-api failed',
  message: statusCode === 401 ? authMessage : 'Internal server error',
};
return msg;
```

Generate `authSources` from the fixture and fail the edit if graph, verifier count, throw count, or lexical placement differs. Assert exactly those 42 node `func` values changed and every other node object serialized identically. Mirror the full flow byte-for-byte. The executable tests must prove a same-source post-auth throw with auth-like text remains 500 and that no request/body field can manufacture the private top-level tag.

- [ ] **Step 4: Account for the measured responder growth**

Measure the exact final character count for each of the 41 verifier nodes and `device-api-http500` after inserting the reviewed tag protocol and source set. Replace only their absolute `max_chars` ceilings and set absolute `max_total` to the exact measured final total. Use bounded reasons naming source-bound auth classification and the redacted unexpected-error warning. Do not add general headroom or a wildcard. Extend the executable test with an extra-character mutation that fails without an explicit ceiling edit, so later unrelated growth cannot consume stale allowance.

- [ ] **Step 5: Run the executable, structural, and size tests**

```bash
node --test scripts/test-device-api-auth-status.js
node scripts/verify-sync-flow.js
node scripts/verify-flows-size-ratchet.js
node scripts/test-ci-guard-wiring.js
```

Expected: all three exit 0. The executable test covers every reviewed protected route and auth-bearing source in both profiles, all six message forms, same-message non-auth controls, graph bypass/remove-one controls, and the exact bounded size allowance.

- [ ] **Step 6: Commit the green vertical slice**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  scripts/test-device-api-auth-status.js scripts/fixtures/device-api-auth-routes.json \
  scripts/verify-sync-flow.js \
  scripts/verify-flows-size-ratchet-allowances.json \
  scripts/test-ci-guard-wiring.js \
  .github/workflows/verify-sync-flow.yml
git commit -m "fix: preserve Device API auth status through catch"
```

### Task 3: Remove the pipeline's accepted-500 loophole

**Files:**

- Modify: `scripts/pipeline/checks/routes.py`
- Modify: `scripts/pipeline/tests/test_checks.py`

**Interfaces:**

- Produces: unauthenticated route-health policy that accepts exactly 401 for both protected Device API GET probes; authenticated 200 is verified separately.

- [ ] **Step 1: Tighten the route policy**

Change:

```python
("/api/irrigation-zones", EXISTS),
```

to:

```python
("/api/devices", (401,)),
("/api/irrigation-zones", (401,)),
```

Replace the existing `/api/devices` `(200, 401)` entry at the same time. Update the module comment to state these probes are deliberately unauthenticated and therefore also test that auth was not bypassed. This was the only `EXISTS` entry, so delete the now-unused sentinel and its special branch. Every route in `ROUTES` must have an explicit tuple of accepted status codes; the loop reduces to `if status not in expected` plus the existing failure detail.

- [ ] **Step 2: Replace the permissive test fixture**

Change the healthy fixtures for both protected routes to `(401, "unauthorized")`. Add parameterized negatives proving unauthenticated 200 and 500 each fail and name the affected protected route; 200 is a security failure here, not health. Retain the 404 and connection-failure tests. The authenticated live/API tests in Task 5 remain responsible for exact 200 success.

- [ ] **Step 3: Run and commit the pipeline tests**

```bash
python -m pytest scripts/pipeline/tests/test_checks.py -q
```

```bash
git add scripts/pipeline/checks/routes.py scripts/pipeline/tests/test_checks.py
git commit -m "test: reject Device API 500 from route health"
```

### Task 4: Run the complete local gate set

**Files:**

- No new files.
- Verify every file changed in Tasks 1 through 3.

- [ ] **Step 1: Run the focused tests**

```bash
node --test scripts/test-device-api-auth-status.js
python -m pytest scripts/pipeline/tests -q
```

- [ ] **Step 2: Run every required flow gate**

```bash
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
node scripts/test-flows-wiring.js
node scripts/verify-flows-size-ratchet.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
scripts/check-mqtt-topics.sh
```

Expected: every command exits 0 with its documented pass signal. The MQTT command is a regression check; this plan does not change an MQTT node.

- [ ] **Step 3: Check the exact diff**

```bash
git diff --check
git status --short --branch
git log -4 --oneline
```

Expected: only the planned files differ from the selected base; unrelated untracked user files remain untouched.

### Task 5: Deploy to Kaba100 and prove both auth branches

**Files:**

- Runtime only on `root@100.93.68.86`.

**Interfaces:**

- Consumes: the exact locally verified commit from Task 4.
- Produces: unauthenticated and malformed-token 401 evidence plus authenticated 200 responses used by the GUI.

When invoked by `2026-07-15-refactor-repair-program.md`, this task is an HTTP verification leg of the single Train A Task A4 deployment. Consume A4's deployment ID, backup/manifest hashes, deployment receipt, and verification boundary; do not take a second backup, deploy again, restart a guarded role, or require a sealed-release symlink in Train A compatibility mode. The standalone backup/deploy wording below applies only when this source plan is explicitly authorized outside the program.

- [ ] **Step 1: Back up and deploy through the staged payload path**

Record the exact commit and active flow/control stamp or sealed-release symlink when present. In standalone mode, take the live-ops backup covering `/data/db/`, `/srv/node-red/`, and `/usr/lib/node-red/gui/`, require `PRAGMA quick_check=ok`, deploy atomically through the merged identityd lifecycle, and require identityd ready afterward. Under the repair program, reverify A4's backup and deployment receipt and confirm its active flow/control stamp without another deploy or restart.

- [ ] **Step 2: Check the unauthenticated routes**

Use `127.0.0.1` on the Pi:

```bash
curl -sS -o /tmp/device-api-body -w '%{http_code}\n' \
  http://127.0.0.1:1880/api/devices
curl -sS -o /tmp/zone-api-body -w '%{http_code}\n' \
  http://127.0.0.1:1880/api/irrigation-zones
```

Require 401 from both and a bounded JSON body with `error: Unauthorized`. Send `Authorization: Bearer malformed` to both routes and require 401 again. Remove the temporary response files after recording the status and bounded body.

- [ ] **Step 3: Check the authenticated routes used by the GUI**

Obtain a local token through the existing login path without printing or persisting it. Require HTTP 200 from `/api/devices` and `/api/irrigation-zones`. The device response must include all five dendrometer DevEUIs and latest timestamps equal to SQLite.

- [ ] **Step 4: Run final health checks**

Require `PRAGMA quick_check=ok`, Node-RED `running`, `/gui` in `200/301/302`, and no new `device-api failed` lines in the Node-RED log during the probe window. Restore the pre-deploy payload if any gate fails.

## Exit criteria

This plan is complete only when:

- every discovered Device API auth node passes the executable missing-token contract in both profiles;
- all three shipped bearer-failure messages map to 401 through the real shared responder;
- unexpected errors still map to 500;
- the pipeline rejects 500 for both protected Device API GET probes;
- profile parity and the full flow gate set pass; and
- Kaba100 proves unauthenticated 401 and authenticated 200 without any auth-repair schema or data mutation; normal concurrent sensor/runtime writes remain allowed.

Shared auth extraction remains a separate maintainability refactor. It is not required to repair this status-propagation regression.
