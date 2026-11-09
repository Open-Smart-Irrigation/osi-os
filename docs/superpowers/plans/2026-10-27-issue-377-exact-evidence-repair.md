# Issue 377: exact evidence repair plan

Status as of 2026-10-27: This plan was originally reviewed against main `8ec3ec3cc65b532a4ad980efa390bf8111bb82c5`. Commit #515 changed the reachable valve, schedule and zone paths. Its combined valve writer, schedule `Save to DB`, zone-delete SQL chain, and original timing and count forecast describe the earlier source state and do not qualify current route evidence. The current execution follows the separately reviewed reconciliation plan at `docs/superpowers/plans/2026-10-27-issue-377-pr533-exact-reconciliation.md`.

> **Publication correction (2026-10-27):** The reviewed source plan remains at commit `ba59f8c9166168be7d6aa75fb9dba09cebd4b938`, blob `03c17af3a81643f79d05fe99e9f48fc14ea63200`. The imported copy at parent commit `7d23ab30ebfd651c7e37c89b1dc7368be2dbefaa` preserves that implementation binding. This published copy spells Node-RED nodes by their canonical flow names, uses the `AGENTS.md` synthetic EUI example for the primary valve, and retains the second valve's test alias. Scope, criteria, gates, and case expectations are unchanged.

## Decision and bound source

Issue #377 remains open, P1, and a closure candidate. This is a plan for an independent executor, not authorization to edit the product or close the issue. It starts at clean `origin/main` commit `8ec3ec3cc65b532a4ad980efa390bf8111bb82c5`, freshly fetched on 2026-10-27 into the isolated `t3/issue-377-evidence-plan` worktree. The older campaign finder used immutable `63c7a70f8f3b373f162b33b0669b0df89b3763fa`; the parent worktree initially sat at `c37207b30b002fb79da8ae57253d78c04613b6a5`. The seven original valve/schedule Function nodes, their named SQLite nodes, `scripts/test-request-context-isolation.js`, `scripts/lib/scoped-access-harness.js`, `scripts/verify-request-context-isolation.js`, and the SQLite package Makefile compare unchanged between campaign base and this main commit. Other flow nodes changed, so recheck the named wires and reachable siblings at the implementation candidate SHA. #470/#519 and later integration may change auth seams before execution; a changed seam requires a plan amendment and fresh review.

The saved issue and refreshed GitHub discussion retain the original acceptance and zero comments. The saved 94-pass TAP log is historical. No product gate, fixture test, profile gate, build, or live test was run for this plan. The issue requires valid same-user and valid distinct-user valve and schedule requests under both scoped flag states, normal/rejected/error paths, asynchronous helper and SQLite completions, SQL and seed effects, correlation, sibling trace, and profile parity. #451 auth/response races and #427/#428 physical policy are separate. Do not invent a new authorization or hardware oracle while proving request isolation.

## Verified SQLite dependency and product discrepancy

The Makefile pins `node-red-node-sqlite` 1.1.0 and SHA-256 `bc19564d9c9c089e4f3e865acffed03badae6927618aaa1ed96fa1745df5fdce`. A bounded local search found only an unproven extracted `/tmp/issue-428-runtime-deps-e8tynkkj/node-red-node-sqlite/sqlite.js`, not a tarball. The exact public package was downloaded without installation or execution to `/home/phil/projects/osi-release-campaign-2026-10-25/artifacts/issue-377/node-red-node-sqlite-1.1.0.tgz`; wrapped `sha256sum` matched the Makefile hash. `package/sqlite.js:38-85` sets `sqlquery` to `msg.topic` by default. That branch calls `node.mydbConfig.db.all(msg.topic, bind, callback)` at line 61, sends the same message with `payload=rows` only on success, and calls `node.error(err,msg)` without sending it on error. Its distinct `batch` branch calls `db.exec(msg.topic, callback)` at line 78. The package declares `sqlite3: ^5.1.6`.

The [node-sqlite3 API](https://github.com/TryGhost/node-sqlite3/wiki/API) defines `all` as one query with an error-first callback and `exec` as the API that runs all queries in a string. The [SQLite prepare contract](https://sqlite.org/c3ref/prepare.html) says prepare compiles only the first SQL statement; its unused tail requires separate handling. The locally extracted sqlite3 C++ source illustrates this with `sqlite3_prepare_v2(..., NULL)` (`src/statement.cc:139-145`), but that extraction has no established package checksum and is corroboration, not the provenance anchor. On the pinned handler/API path, `msg.topic` does **not** execute the appended `UPDATE`. This is a source-proven product discrepancy, not a live gateway observation. The current valve builder `Build actuator_command + DB writes` emits `INSERT INTO actuator_log;\nUPDATE devices SET target_state ...` as one topic to SQLite node `DB: actuator_log + devices update`, configured `sqlquery: "msg.topic"`. A successful INSERT can produce a successful callback, HTTP 202 and actuator fanout while `devices.target_state` stays unchanged.

**Stop line:** plan the product repair separately with its own review. Do not alter `flows.json`, its mirror, or a product helper under this evidence plan. Do not make the fixture execute the UPDATE that the verified handler omits. The valve two-effect acceptance and the dropped-UPDATE negative control cannot go green on this source. Record them as blocked by the product discrepancy; retain the log, command and response observations with their narrower meaning. Rebind this plan after any product fix and review the new adapter and effect oracle before implementation continues. No absent provenance or fabricated UPDATE may be reported as closure evidence.

## Exact edit surface and sequence after independent plan review

The evidence-only edit surface is `scripts/test-request-context-isolation.js` and the optional injection seam in `scripts/lib/scoped-access-harness.js`. The source guard stays unchanged unless a reviewed finding requires a separate edit. Never alter firmware flows to make a test pass. Work in an isolated candidate from the reviewed plan commit; record candidate base SHA, changed seams, command outputs, and final SHA. Write failing controls first, observe the stated failure, then implement the harness seam and cases. If any failure differs from the expected one, stop and amend this plan. The following are literal replacement/insertion contracts; keep the existing 94 tests and existing helper exports.

### 1. Live per-tab context and final key oracle

In `executeFunction`'s options destructuring add `flowStore: suppliedFlowStore` and `dbCallGate`. Replace its local flow-store creation with:

```js
const flowStore = suppliedFlowStore === undefined
  ? new Map(Object.entries(flowState))
  : suppliedFlowStore;
if (!(flowStore instanceof Map)) throw new TypeError('flowStore must be a Map');
const databaseFacade = facadeDb(db, dbCallGate);
```

Keep the existing `flow.get/set` closures and return shape; they now use the supplied live Map. In `FlowRuntime` initialize a Map for each tab when first encountered, pass it as `flowStore` to **every** `executeFunction` call, and remove `this.tabContext.set(node.z, outcome.flowState)` on the live path. The historical direct harness call without `flowStore` retains its snapshot behavior. Keep a runtime-owned live global store if a traced in-scope Function writes request data there; no per-invocation replacement may hide a bad write. Replace `flowKeys()` with:

```js
flowKeys() {
  const keys = [];
  for (const store of this.tabContext.values()) {
    if (store instanceof Map) keys.push(...store.keys());
    else if (store && Object.getPrototypeOf(store) === Object.prototype) keys.push(...Object.keys(store));
    else throw new TypeError('unexpected tab context store');
  }
  return keys;
}
```

Leave `withRuntime()`'s final `REQUEST_SCRATCH_KEY` assertion in place. Add two **separate** fresh `withRuntime` cases. The negative body sets `rt.tabContext.set('device-api-tab', new Map([['valve_cmd_probe', 'A']]))` and must reject with `per-request value left in shared flow context: valve_cmd_probe`. The positive body sets the same Map, deletes `valve_cmd_probe` through `rt.tabContext.get('device-api-tab').delete(...)` before returning, and resolves. Do not clear tab context during cleanup before the final assertion.

### 2. Start/settle scheduler and cleanup

Keep `lane.queue`, `send`, `route` and `raise`. Add `this.inFlight = new Map()` and monotonic step keys in `FlowRuntime`. `startStep(name)` shifts exactly one queued `{nodeId,msg}`, records `{name,nodeId,msg}` in `inFlight` **before** invoking a Function or SQLite node, and returns `{key, promise}`. The promise captures either `{result,outcome}` or `{error}` without routing. `settleStep(key)` awaits that promise, deletes exactly that key, then uses the existing route/raise logic once. The old `step(name)` is `const {key}=startStep(name); await settleStep(key);`; its synchronous node cases retain their current routing. `runReady(name)` drains queued independent siblings while a held key remains: it may process the valve builder's actuator and HTTP outputs, but cannot route the held SQLite result. `run(name)` must reject as incomplete when its queue is empty and an `inFlight` key still belongs to that lane. The test `finally` releases or rejects every gate, awaits all started promises, verifies `inFlight.size===0`, then closes the seed DB. Do not call an empty queue completion while a Function await or callback delivery remains held.

For SQLite node `DB: actuator_log + devices update`, the builder has outputs to `To Actuator (same as scheduler)`, the DB write, and `device-response`. Process the two independent outputs through `runReady(A)` while A's write callback is held. The write branch contains `{topic}` only; `device-api-http500` returns when `msg.res` is absent. A held write error therefore leaves its already emitted command and HTTP 202, and creates no second HTTP response. A held read error has no downstream command/write and follows its own catch response. Assert these by stage, not by an invented rollback rule.

### 3. Operation-complete, delivery-held gates

Extend `facadeDb(db, dbCallGate)` with a test-only selector and delivery hook. For each `get/all/run`, normalize arguments, then call `dbCallGate.select({method, sql, params})` **before** `db.prepare` or any SQL execution; bind the gate to the calling lane and match its SQL role and occurrence there. The selector returns `{kind:'execute', hold}` or `{kind:'synthetic_busy', hold:true}`. An unmatched call uses `{kind:'execute', hold:false}`. Capture the operation outcome with this exact ordering (the `params` array is already normalized):

```js
function captureDbOutcome(db, method, sql, params, decision) {
  if (decision.kind === 'synthetic_busy') {
    return {
      kind: 'synthetic_busy', operationCount: 0, value: undefined,
      error: new Error('SQLITE_BUSY: database is locked'),
    };
  }
  if (decision.kind !== 'execute') throw new Error('unknown DB gate outcome');
  try {
    return {
      kind: 'completed_operation', operationCount: 1,
      value: db.prepare(sql)[method](...params), error: null,
    };
  } catch (error) {
    return { kind: 'completed_operation', operationCount: 1, value: undefined, error };
  }
}
```

The helper facade uses the captured `value` or `error` for its existing Promise/callback contract. If `hold` is true, store that outcome and withhold **only** Promise resolution/rejection or callback delivery while B completes; otherwise deliver it immediately. A one-shot delivery guard throws on a second release and never invokes `db.prepare` again. Trace `kind`, method, SQL role, occurrence, `operationCount`, actual result/error versus synthetic error, gate entry, B completion and release order. A synthetic busy is selected before preparation, executes no A SQL, holds one error delivery, and has no A write effect. A real success or real SQLite error executes once and retains its actual effect or failure before delivery is held. `close(callback)` has no SQL operation; select its success-only delay before invoking the close callback, and hold only that callback's delivery. The shipped `osi-db-helper` serializes operations before resolving the Promise or scheduling the callback (`.../osi-db-helper/index.js:129-203,299-301`); never hold an unexecuted A operation while B completes and call that production timing.

At each Node-RED SQLite step, first append the original, byte-exact `msg.topic` to `lane.sql`, **before** choosing either outcome. Next select the lane/node/occurrence gate before `db.prepare`. For `synthetic_busy`, skip preparation and all SQL, record `operationCount:0`, and hold one `SQLITE_BUSY` error delivery. For `execute`, use the source-faithful single-statement adapter `db.prepare(msg.topic).all()` exactly once, with no statement split; capture its actual rows or error and `operationCount:1`, then hold only delivery. On release, assign captured rows to `msg.payload` and route the original success wire, or call `raise` with the captured error, exactly once. Release never retries SQL. Keep existing `lane.failAt` explicitly pre-execution and separate from this delayed-delivery model. Trace gate kind, original topic, operation count, execution result/error, B-before-release order and exactly one callback settlement. Cleanup settles every pending key even after assertion failure.

The scoped-on Function success sites, in order, are actor `users` lookup, target device or zone lookup, scope-user lookup, four scope-list `all` calls, and close callback: eight per chain. Use the actual SQL strings and method/occurrence from `Auth + Validate + Normalize`, `Decode Token`, and `osi-scope-helper/index.js:98-151,221-247,333-339`; a gate that fails to match is a red test, never silently skipped. Reset scope-helper cache and use a fresh seed DB for each case. Four failure cases hold A at actor lookup or one access-helper query for each chain. A's own error response and no downstream write/command are required; B completes successfully. Close delay is success-only because the shipped wrapper ignores a close callback error.

### 4. Valid actors, lane oracles and controls

Use the existing seed and `USERS.res1` (ID 2, `u-res1`) for A and `USERS.admin1` (ID 1, `u-admin`) for B. A targets `VALVE_A` (synthetic device EUI `A840410000000001`, the `AGENTS.md` example) for 12 minutes; B targets the separate `VALVE_FOREIGN` fixture alias for 3 minutes. A updates owned zone 1 (`z-1`, version 5) with `{trigger_metric:'SWT_WM1', threshold_kpa:40, duration_minutes:12, response_mode:'fixed', enabled:true}`. B creates on owned zone 2 (`z-2`, version 1) with `{trigger_metric:'SWT_2', threshold_kpa:65, duration_minutes:3, response_mode:'aggressive', enabled:false}`. Use `valveMsg`/`scheduleMsg`, each lane's own `res`, and the existing `assertValveAccepted`/`assertScheduleApplied` as starting assertions. Extend those assertions to inspect the numeric actor on `msg.osi.request`, own user and target lookup, command and expectation `command_id`, emitted SQL, own response connection and seed row. Scoped-on valve also expects `_actorUserUuid`; scoped-off does not enrich it. At schedule user lookup, `msg.osi.request` has **not** been constructed; assert `msg.authUserId`, `msg.req.params.id` and `msg.req_body` there, and the normalized envelope only after the schedule chain's `Verify Zone Ownership` Function node. Do not turn a foreign-user rejection into a valid distinct-user case.

For a successful schedule save, inspect one statement's stored `irrigation_schedules` row, response, and `msg.syncAck.aggregateKey`/`appliedSyncVersion`. `msg.syncAck` is local metadata. Published cloud ACK checks are the existing separate `commandAcks` tests: cloud 501 remains on its cloud lane, manual open borrows no 501, and the missing-ID cloud command has `commandId:null` while B retains 77. At a read error, assert no later SQL, actuator link or successful response from A. At a synthetic busy schedule save, assert its actual catch behavior, zero A SQL executions and no stored A row. At a synthetic busy valve write, assert the already emitted actuator link and HTTP 202, no second response, zero A SQL executions and no A log/device-row effect. A completed real operation, whether its result or error delivery is delayed, retains its actual effect or failure; read it separately and never claim rollback. Require one held error delivery and no retry in each synthetic case.

Add a test-local clone of valve ingress only in the test file. It sets `flow.valve_cmd_target` before A's deferred scoped DB await, then reads the shared key after that await to set A's target. Run B's clone while A is held so B overwrites the key. On A's release, assert its actor remains ID 2 and its expected `targetEui=VALVE_A` assertion fails **inside or immediately after the resumed Function**, before a downstream SQLite step. Require that intended mismatch message; another throw is invalid evidence. Keep the clone out of both firmware flows. The separate final-Map negative and removal-positive cases from step 1 must also pass their stated control outcomes.

The valve device-row control is now a **known red product finding**. Read `SELECT target_state FROM devices WHERE deveui = ?` after the source-faithful combined topic: the log row exists and `target_state` is not `OPEN`. Do not name that a passing two-effect positive. A test-local adapter mutation that drops the UPDATE is indistinguishable from the verified deployed path and cannot be counted as a discriminating negative. After a separately reviewed product fix changes the deployed SQL path, amend this plan to name its exact handler/API behavior; only then require the positive both-row assertion and a test-local dropped-UPDATE variant that fails specifically at the device-row assertion.

### 5. Bounded sibling and context trace

Trace the reachable valve open/cancel route, schedule PUT, zone delete, `Route Command`, `Build Status + ACK`, and `Build Schedule ACK`. For each, write source node/helper location, actor/target/validated payload/correlation field, context access and lifetime, output wire, and disposition in the execution report. Check dotted `flow/global/context.get|set|keys`, computed methods such as `flow['get']`, method variables such as `global[method]`, aliases/destructuring, and request-state calls into loaded helpers. Inspect helper bodies for request scratch versus intentional scope cache. The existing guard detects dotted literal calls only; keep its blind spot explicit. A synthetic dotted `flow.set('valve_cmd_probe', ...)` against a temporary flows copy must make the guard fail. Do not build a general JS analyzer or expand to physical command policy.

## Forecast case matrix and gates

The R3-accepted forecast is **74 new cases**, `24 + 16 + 4 + 24 + 2 + 2 + 2`. The historical 94 would yield 168 only if unchanged. These are planning counts, never a pass quota. The valve combined-write positive and its dropped-UPDATE control, plus every case claiming `devices.target_state='OPEN'`, stay blocked until the separate product fix is reviewed. Other cases may produce narrower evidence now. A changed count is documented before execution, not hidden in a green total.

| Cases | Held lane/boundary | Required observation |
|---:|---|---|
| 24 | A then B at each of three valve and three schedule SQLite nodes, scoped off/on | Other valid own-target user completes; held lane resumes. Both own identity, lookup, SQL, response and supported seed effects. |
| 16 | A at eight scoped ingress success sites per chain | Operation completes once, B finishes, A receives its own delayed result and own-target envelope. |
| 4 | A at actor lookup or access-helper query per chain | Captured real error or labeled injected callback busy; B succeeds, A has its own failure and no downstream mutation. |
| 24 | A at each of three SQLite nodes per chain, scoped off/on, success and injected busy | A outcome captured once before B completes; delivery held. Assert stage-specific read/write effects and response. |
| 2 | Valve combined topic and schedule single statement | Schedule row/local ACK passes; valve log/device row exposes current discrepancy until product repair. |
| 2 | Bad ingress clone and dropped-UPDATE adapter mutation | In-Function actor/target negative must fail as intended; dropped-UPDATE control is deferred until product repair. |
| 2 | Separate final shared-Map scratch cases | Residual key fails final assertion; removal before return passes. |

After independent exact-plan acceptance and resource admission, all checkers run through `python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py COMMAND ARGS`, one heavy command at a time. The wrapper enforces fresh guard and process identity, 8 GiB admission, 10 GiB recovery, 4 GiB termination, serialization and cleanup. Swap occupancy is telemetry. A refusal defers the command; no bypass or retry loop. #183 retains implementation priority. Planned gates at the implementation candidate SHA: `node --test scripts/test-request-context-isolation.js`, `node scripts/verify-request-context-isolation.js`, `node scripts/verify-profile-parity.js`, `node scripts/verify-sync-flow.js`, `node scripts/verify-no-new-silent-catch.js`, and `git diff --check <candidate-base-sha>...HEAD`, each with its own exit code and output. Bind `<candidate-base-sha>` to the recorded exact base before running it; an unqualified post-commit `git diff --check` can examine zero lines. If source or product changes require other flow gates, amend and review first. This plan stage runs none of these product gates. Record expected negative-control failures separately from passing tests, with their exact assertion messages. The post-execution verifier must be independent of the implementation author and check the final candidate SHA, source-fidelity account, case outputs, bounded sibling trace, parity and limits before any PR or issue closure.
