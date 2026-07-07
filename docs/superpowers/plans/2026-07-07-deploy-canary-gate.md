# Deploy Canary Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution notes:** (1) work inside a feature branch `feat/deploy-canary-gate` (worktree recommended, not the root `main` checkout); (2) `flows.json` edits are made ONLY via a one-shot Node script per `.claude/skills/osi-flows-json-editing/SKILL.md` — never by hand, never by text-replacement tool; the roundtrip guard runs before AND after every mutation; (3) every `flows.json` mutation is applied to **both** `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (canonical) and `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (mirror) in the same script run so they stay byte-identical (`verify-profile-parity.js` gates it); (4) run every command from the repo/worktree root; (5) osi-os CI must stay green at every commit.
> **Spec:** [`docs/superpowers/specs/2026-07-07-deploy-canary-gate-design.md`](../specs/2026-07-07-deploy-canary-gate-design.md) (Draft, treated as settled — this plan elaborates, it does not redesign). Section references (§A–§D) below point there.
> **Charter:** [`docs/architecture/refactor-program-2026.md`](../../architecture/refactor-program-2026.md) — Phase 0, item 0.2 (`spec+plan`, depends on heartbeat #100 which is done); DD10 ("Canary gate consumes existing heartbeat fields... server/operator-side").

**Goal:** Build `scripts/deploy-canary-gate.js` (a zero-dependency Node CLI that polls osi-server's `GET /api/v1/admin/sync-health` and judges one gateway against the spec §C criteria — freshness, server verdict, disk, error-delta, consecutiveness), close the #102-deferred edge gap by wiring `errors_total`/`errors_last_at` into the heartbeat's `health` object (both flows.json profiles), and — **only if verification below confirms it's needed** — add a small additive osi-server pass-through so those two fields are visible in the sync-health response. Document the rollout runbook (§D) and wire the gate's tests into osi-os CI.

**Architecture:** The gate is a pure HTTP client + judgment loop — it computes nothing the server doesn't already report except (a) the error-count delta across its own polling window and (b) pass/fail consecutiveness bookkeeping. It never touches SQLite, flows.json, or SSH. Input is JSON from one HTTP endpoint; output is an exit code (0/1/2) plus a human-readable reason summary. Edge-side, `Gather Edge Health` (function node `2a4f142e3e9b6d80`) already merges a helper-computed health snapshot into `global.set('edge_health', ...)`; this plan adds two more keys to that same merge, read directly from `global.get('error_counts')` (maintained by `Record Error`, node `record-error-fn`, untouched). `Build Heartbeat` (function node `062a0f9bf66d9789`) copies named keys out of `edge_health` through a small local `healthValue(source, key)` allowlist function into the `health` object it ships over MQTT — this plan adds the same two keys to both branches of that allowlist (fresh and stale-fallback).

**Tech Stack:** Node.js (`node --test`, zero new dependencies — `node:https`/`node:http` only, matching `scripts/refresh-chameleon-calibrations.js`'s idiom), existing osi-os CI (`.github/workflows/migrations.yml`, which already runs `node --test` suites and `node scripts/verify-heartbeat-health.js`). Conditionally: Java/Spring (`org.osi.server.sync.SyncHealthService`), Mockito, run locally via `./gradlew test` (osi-server has no CI).

## Global Constraints

- **No SSH, no live gateways, no production hosts.** All gate-script tests run against a mocked local HTTP fixture server (`node:http`), never a real osi-server instance.
- **Never touch `sync-init-fn`** (frozen boot-DDL node) or any schema/migration file. This plan is flows + tooling + (conditional) one small osi-server service method — no DDL.
- **flows.json edits are scoped to exactly two named nodes**: `Gather Edge Health` (`2a4f142e3e9b6d80`) and `Build Heartbeat` (`062a0f9bf66d9789`), both already on tab `93b1537a596e0e6d`. No other node, wire, or tab changes. Apply identically to both profile copies; `verify-profile-parity.js` must stay green.
- **The gate script has zero runtime dependencies beyond Node built-ins** (`node:http`, `node:https`, `node:url`) — no npm install, no package.json change.
- osi-os CI (`.github/workflows/migrations.yml`) must stay green at every commit.
- If the osi-server pass-through task (T3) is needed: additive only (no existing test's assertions change meaning), its own commit, Mockito-only (no Testcontainers/Postgres needed — this is pure Java Map logic), and note prominently in the PR that osi-server has no CI — local `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend` is the only verification available.
- Work on `feat/deploy-canary-gate`, commit per task, open a PR at the end, **do not merge it**.

## Non-goals (do not do these)

- No automatic rollback (that's item 5.3), no fleet orchestration, no Pi-side agent, no SSH from the gate.
- No server verdict changes beyond the conditional T3 pass-through — `schema_sig` acceptance stays the server's existing allowlist mechanism; error-delta judgment stays gate-side by design (spec §B, §C.4).
- No fix for issue #107 (`schema_sig` CHECK-blindness).
- No change to `Record Error`'s `error_counts` shape, rate-limiting, or warning logic — only a read.
- No change to `osi-health-helper/index.js`'s `gatherEdgeHealth()` — `errors_total`/`errors_last_at` come from `global.get('error_counts')` directly inside `Gather Edge Health`, not through that helper (verified: `error_counts` is a `Record Error` global, not a DB-derived health field).
- No live gate run against a real gateway in this plan — item 0.1's demo deploy is the gate's first live validation, tracked as a **follow-up**, not a task here.

## Verification findings (from spec-vs-repo checks before writing this plan)

These are load-bearing for the tasks below; they are reported as findings, not silently patched into the spec:

1. **Node names differ from a literal reading of the spec.** The spec's prose ("`Build Heartbeat` reads `global.get('edge_health')`... `Record Error` maintains `global.get('error_counts')`") is accurate, but there is a third node in between that the spec doesn't name: **`Gather Edge Health`** (`2a4f142e3e9b6d80`), which calls `osiHealth.gatherEdgeHealth(db)` and merges the result into `global.set('edge_health', {at, ...})`. `errors_total`/`errors_last_at` must be added to *this* node's merge (reading `global.get('error_counts')` directly), not to the DB-backed `osi-health-helper` module — `error_counts` is a flow-global, not a DB query. Task 1 below targets `Gather Edge Health`, not the helper module.
2. **`healthValue` is a closed allowlist, not a generic pass-through.** The spec's phrase "`Build Heartbeat`'s existing `healthValue` pass-through then carries them with zero further change" is a mismatch: `healthValue(source, key)` is a type-coercing accessor called once per named key inside two hand-written object literals (`freshHealth`/stale-fallback branches). Adding a key requires editing `Build Heartbeat`'s `func` in **both** branches — this is captured as an explicit sub-step in Task 1, not "zero further change."
3. **An existing verifier hard-gates the health key list and must be updated in the same commit.** `scripts/verify-heartbeat-health.js` defines `REQUIRED_HEALTH_KEYS` (currently 7 keys) and asserts `Build Heartbeat`'s output object has **exactly** those keys (`assertHealthKeys` via `sameStringArray`), for both profiles. Task 1 is silently red without also updating this constant and its expected-value fixtures. This file is already wired into CI (`node scripts/verify-heartbeat-health.js` in `.github/workflows/migrations.yml`).
4. **osi-server's `SyncHealthService.edgeHealth()` is a fully closed, named-field mapping — not a generic pass-through, and the SQL itself is closed too.** `loadGatewayRows()`'s SQL explicitly extracts five named JSON paths from `current_state_json` (`#>> '{health,schema_sig}'`, `sync_linked`, `sync_oldest_age_s`, `sync_rejected`, `disk_free_pct`) — `sync_pending` and `sync_dirty_pending` (both already in the edge heartbeat's `health` object) are not even extracted today, confirming this is a hand-maintained allowlist at the SQL layer, not a generic JSON pass-through at the Java layer. **The spec's conditional pass-through IS needed** (see Task 3) — and it's two-layered: the SQL must add `#>> '{health,errors_total}'` / `#>> '{health,errors_last_at}'` columns AND the Java `edgeHealth()` method must map them into the response, matching the existing pattern exactly (`nullableLong`/`nullableString` accessors already exist and are reused, not duplicated).
5. **Freshness data (spec §C.1) lives outside `edgeHealth`, at the gateway-row level.** `heartbeatAgeSeconds`/`lastSeen`/`currentStateRecordedAt` are siblings of `edgeHealth` on each gateway row in the `gateways` array, not nested inside it. The gate script's parser must read `gateways[i].heartbeatAgeSeconds` (or derive from `currentStateRecordedAt`) for criterion 1, and `gateways[i].edgeHealth.{schemaSig,reasons,diskFreePct}` plus (after T3) `errorsTotal`/`errorsLastAt` for criteria 2–4. This is captured exactly in Task 1's fixture shape below — no guessing was needed since the real service and its Mockito test fully pin the shape.

## File Structure (all changes)

- Create: `scripts/deploy-canary-gate.js` + `scripts/deploy-canary-gate.test.js` (Task 1)
- Modify (flows, both profiles): `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` — nodes `2a4f142e3e9b6d80` (Gather Edge Health) and `062a0f9bf66d9789` (Build Heartbeat) (Task 2)
- Modify: `scripts/verify-heartbeat-health.js` (`REQUIRED_HEALTH_KEYS` + fixture expectations) (Task 2)
- Modify (conditional on Task 3 verification staying valid at execution time): `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/SyncHealthService.java` (SQL + `edgeHealth()`), `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/sync/SyncHealthServiceTest.java` (Task 3)
- Create: `docs/operations/deploy-canary-gate-runbook.md` (Task 4)
- Modify: `.github/workflows/migrations.yml` (wire the gate's `node --test` suite) (Task 4)
- Modify: `docs/architecture/refactor-program-2026.md` (Phase 0 table, item 0.2 outcome + PR link) (Task 4)

---

### Task 1: `scripts/deploy-canary-gate.js` — gate script + full test suite

**Files:**
- Create: `scripts/deploy-canary-gate.test.js`
- Create: `scripts/deploy-canary-gate.js`

**Interfaces:**
- Produces: `evaluatePoll(pollResult, ctx) → { pass: boolean, reasons: string[] }` (pure, unit-testable criterion evaluation for one poll); `runGate(options) → Promise<{ ok: boolean, reasons: string[] }>` (the polling loop); CLI `node scripts/deploy-canary-gate.js --eui <EUI> --since <ISO8601> [--server <url>] [--expect-schema-sig <sig>] [--consecutive 5] [--interval 60] [--timeout 900] [--min-disk-free-pct 10]`. Exit codes: `0` PASS, `1` FAIL (reasons on stderr), `2` usage/auth/transport error.
- Consumes: `GET {server}/api/v1/admin/sync-health?gatewayEui=<EUI>&limit=1` via `node:https`/`node:http` (protocol chosen by URL scheme, matching `refresh-chameleon-calibrations.js`), header `Authorization: Bearer ${OSI_ADMIN_TOKEN}`. Real response shape (pinned from `SyncHealthService`/`SyncHealthServiceTest.java`, verified 2026-07-07):

```json
{
  "status": "healthy",
  "fleet": { "totalGateways": 1, "...": "..." },
  "gateways": [
    {
      "gatewayEui": "0016C001F11715E2",
      "pendingEventCount": 0,
      "oldestPendingEventAgeSeconds": 0.0,
      "pendingCommandCount": 0,
      "staleSentCommands": 0,
      "linkedAuthRepairStatus": "unknown",
      "lastSeen": "2026-07-07T12:00:00Z",
      "currentStateRecordedAt": "2026-07-07T12:00:00Z",
      "lastSeenAgeSeconds": 15.0,
      "heartbeatAgeSeconds": 15.0,
      "heartbeatStatus": "HEALTHY",
      "edgeHealth": {
        "status": "healthy",
        "reasons": [],
        "schemaSig": "abc123",
        "syncLinked": true,
        "syncOldestAgeSeconds": 45.0,
        "syncRejected": 0,
        "diskFreePct": 25.0
      }
    }
  ],
  "dbHealth": {},
  "staleSentCommands": 0,
  "oldestPendingEventAgeSeconds": 0.0
}
```

  Note: `errorsTotal`/`errorsLastAt` are **not yet present** in `edgeHealth` above — this is exactly finding #4. The gate's parser must tolerate their absence (treat as `null`/no-baseline, never crash) so this task is independently testable and mergeable before Task 3 lands. Once Task 3 lands, the same parser picks them up with no gate-script change (they're read via `pollResult.edgeHealth.errorsTotal`, optional-chained).

- [ ] **Step 1.1: Write the failing test suite** — create `scripts/deploy-canary-gate.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { evaluatePoll, runGate } = require('./deploy-canary-gate');

const EUI = '0016C001F11715E2';
const SINCE = '2026-07-07T12:00:00.000Z';

function gatewayRow(overrides = {}) {
  return {
    gatewayEui: EUI,
    lastSeen: '2026-07-07T12:05:00Z',
    currentStateRecordedAt: '2026-07-07T12:05:00Z',
    heartbeatAgeSeconds: 10,
    heartbeatStatus: 'HEALTHY',
    edgeHealth: {
      status: 'healthy',
      reasons: [],
      schemaSig: 'sig-a',
      syncLinked: true,
      syncOldestAgeSeconds: 5,
      syncRejected: 0,
      diskFreePct: 40,
      errorsTotal: 3,
      errorsLastAt: '2026-07-07T12:04:00Z',
      ...overrides.edgeHealth,
    },
    ...overrides,
    ...(overrides.edgeHealth ? {} : {}),
  };
}

function healthyBody(overrides = {}) {
  return { status: 'healthy', gateways: [gatewayRow(overrides)] };
}

// ---- evaluatePoll: pure criterion checks (spec §C) ----

test('evaluatePoll: all criteria pass', () => {
  const res = evaluatePoll(healthyBody(), { eui: EUI, sinceMs: Date.parse(SINCE), nowMs: Date.parse('2026-07-07T12:05:10Z'), minDiskFreePct: 10 });
  assert.equal(res.pass, true);
  assert.deepEqual(res.reasons, []);
});

test('evaluatePoll: gateway not found in response FAILS', () => {
  const res = evaluatePoll({ status: 'healthy', gateways: [] }, { eui: EUI, sinceMs: Date.parse(SINCE), nowMs: Date.parse(SINCE), minDiskFreePct: 10 });
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['gateway_not_found']);
});

test('evaluatePoll: heartbeat older than 120s FAILS freshness', () => {
  const res = evaluatePoll(healthyBody({ heartbeatAgeSeconds: 121 }), { eui: EUI, sinceMs: Date.parse(SINCE), nowMs: Date.parse('2026-07-07T12:05:10Z'), minDiskFreePct: 10 });
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['heartbeat_stale']);
});

test('evaluatePoll: currentStateRecordedAt before --since FAILS (never passes on pre-deploy heartbeats)', () => {
  const res = evaluatePoll(
    healthyBody({ currentStateRecordedAt: '2026-07-07T11:59:00Z' }),
    { eui: EUI, sinceMs: Date.parse(SINCE), nowMs: Date.parse('2026-07-07T12:00:05Z'), minDiskFreePct: 10 }
  );
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['heartbeat_before_deploy']);
});

test('evaluatePoll: server verdict reasons surface verbatim FAIL', () => {
  const res = evaluatePoll(
    healthyBody({ edgeHealth: { status: 'unhealthy', reasons: ['schema_sig_not_accepted'] } }),
    { eui: EUI, sinceMs: Date.parse(SINCE), nowMs: Date.parse('2026-07-07T12:05:10Z'), minDiskFreePct: 10 }
  );
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['schema_sig_not_accepted']);
});

test('evaluatePoll: --expect-schema-sig mismatch FAILS even with an otherwise-healthy verdict', () => {
  const res = evaluatePoll(
    healthyBody({ edgeHealth: { status: 'healthy', reasons: [], schemaSig: 'sig-old' } }),
    { eui: EUI, sinceMs: Date.parse(SINCE), nowMs: Date.parse('2026-07-07T12:05:10Z'), minDiskFreePct: 10, expectSchemaSig: 'sig-new' }
  );
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['schema_sig_mismatch']);
});

test('evaluatePoll: --expect-schema-sig exact match with healthy verdict PASSES', () => {
  const res = evaluatePoll(
    healthyBody({ edgeHealth: { status: 'healthy', reasons: [], schemaSig: 'sig-new' } }),
    { eui: EUI, sinceMs: Date.parse(SINCE), nowMs: Date.parse('2026-07-07T12:05:10Z'), minDiskFreePct: 10, expectSchemaSig: 'sig-new' }
  );
  assert.equal(res.pass, true);
});

test('evaluatePoll: disk_free_pct below threshold FAILS', () => {
  const res = evaluatePoll(
    healthyBody({ edgeHealth: { status: 'healthy', reasons: [], diskFreePct: 9 } }),
    { eui: EUI, sinceMs: Date.parse(SINCE), nowMs: Date.parse('2026-07-07T12:05:10Z'), minDiskFreePct: 10 }
  );
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['disk_free_low']);
});

test('evaluatePoll: errorsTotal rising past the in-window baseline FAILS', () => {
  const ctx = { eui: EUI, sinceMs: Date.parse(SINCE), nowMs: Date.parse('2026-07-07T12:05:10Z'), minDiskFreePct: 10, errorsBaseline: 3 };
  const res = evaluatePoll(healthyBody({ edgeHealth: { status: 'healthy', reasons: [], errorsTotal: 5 } }), ctx);
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ['errors_total_increased']);
});

test('evaluatePoll: errorsTotal absent (pre-Task-3 server) is tolerated, not a crash or a fail', () => {
  const body = healthyBody();
  delete body.gateways[0].edgeHealth.errorsTotal;
  delete body.gateways[0].edgeHealth.errorsLastAt;
  const res = evaluatePoll(body, { eui: EUI, sinceMs: Date.parse(SINCE), nowMs: Date.parse('2026-07-07T12:05:10Z'), minDiskFreePct: 10 });
  assert.equal(res.pass, true);
  assert.deepEqual(res.reasons, []);
});

test('evaluatePoll: multiple simultaneous failures all surface', () => {
  const res = evaluatePoll(
    healthyBody({ heartbeatAgeSeconds: 200, edgeHealth: { status: 'unhealthy', reasons: ['sync_rejected'], diskFreePct: 5 } }),
    { eui: EUI, sinceMs: Date.parse(SINCE), nowMs: Date.parse('2026-07-07T12:05:10Z'), minDiskFreePct: 10 }
  );
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons.sort(), ['disk_free_low', 'heartbeat_stale', 'sync_rejected'].sort());
});

// ---- runGate: consecutiveness, reset, timeout, auth, over HTTP ----

function startFixtureServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

test('runGate: PASS after N consecutive healthy polls', async () => {
  let polls = 0;
  const server = await startFixtureServer((req, res) => {
    polls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(healthyBody()));
  });
  try {
    const result = await runGate({
      server: serverUrl(server),
      eui: EUI,
      since: SINCE,
      adminToken: 'tok',
      consecutive: 3,
      intervalMs: 1,
      timeoutMs: 5000,
      minDiskFreePct: 10,
    });
    assert.equal(result.ok, true);
    assert.ok(polls >= 3, `expected at least 3 polls, got ${polls}`);
  } finally {
    server.close();
  }
});

test('runGate: a failing poll resets the consecutive counter', async () => {
  let polls = 0;
  const server = await startFixtureServer((req, res) => {
    polls += 1;
    const body = polls === 2
      ? healthyBody({ edgeHealth: { status: 'unhealthy', reasons: ['disk_free_low'], diskFreePct: 1 } })
      : healthyBody();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  try {
    const result = await runGate({
      server: serverUrl(server),
      eui: EUI,
      since: SINCE,
      adminToken: 'tok',
      consecutive: 3,
      intervalMs: 1,
      timeoutMs: 5000,
      minDiskFreePct: 10,
    });
    assert.equal(result.ok, true);
    // poll 1 pass (count=1), poll 2 fail (reset to 0), polls 3-5 pass (count=3, done) = 5 polls
    assert.ok(polls >= 5, `expected reset then re-accumulation, got ${polls} polls`);
  } finally {
    server.close();
  }
});

test('runGate: FAILS with last-seen reasons when the timeout budget expires', async () => {
  const server = await startFixtureServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(healthyBody({ edgeHealth: { status: 'unhealthy', reasons: ['schema_sig_not_accepted'] } })));
  });
  try {
    const result = await runGate({
      server: serverUrl(server),
      eui: EUI,
      since: SINCE,
      adminToken: 'tok',
      consecutive: 3,
      intervalMs: 1,
      timeoutMs: 20,
      minDiskFreePct: 10,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes('schema_sig_not_accepted'));
  } finally {
    server.close();
  }
});

test('runGate: HTTP 401/403 from the server is an auth failure, not a poll failure', async () => {
  const server = await startFixtureServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  try {
    await assert.rejects(
      () => runGate({
        server: serverUrl(server),
        eui: EUI,
        since: SINCE,
        adminToken: 'bad-tok',
        consecutive: 3,
        intervalMs: 1,
        timeoutMs: 5000,
        minDiskFreePct: 10,
      }),
      /auth/i
    );
  } finally {
    server.close();
  }
});

test('runGate: missing OSI_ADMIN_TOKEN is a usage error (caller-level, checked by main())', () => {
  assert.throws(() => require('./deploy-canary-gate').requireAdminToken(undefined), /OSI_ADMIN_TOKEN/);
});
```

- [ ] **Step 1.2: Run it (red)**

Run: `node --test scripts/deploy-canary-gate.test.js`
Expected: FAIL — `Cannot find module './deploy-canary-gate'`.

- [ ] **Step 1.3: Implement** — create `scripts/deploy-canary-gate.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// Deploy canary gate — refactor-program item 0.2 (Phase 0, DD10):
//   docs/superpowers/specs/2026-07-07-deploy-canary-gate-design.md
// Polls osi-server's GET /api/v1/admin/sync-health and refuses to advance a
// staged rollout until the just-deployed gateway reports N consecutive
// healthy polls. Computes NOTHING the server doesn't already know except the
// error-count delta (spec §C.4) and consecutiveness bookkeeping (§C.5) — the
// server verdict (edgeHealth.status/reasons) is the single health authority.
//
// Auth idiom copied from scripts/refresh-chameleon-calibrations.js:
// OSI_ADMIN_TOKEN env -> `Authorization: Bearer` header. Zero dependencies
// beyond Node built-ins (node:http/node:https/node:url), per program
// constraint.
//
// Exit contract (spec §C): 0 PASS, 1 FAIL (reasons on stderr), 2 usage/auth/
// transport error (gate couldn't judge -> treat as FAIL for rollout purposes).

const http = require('node:http');
const https = require('node:https');

const DEFAULTS = {
  consecutive: 5,
  intervalMs: 60000,
  timeoutMs: 900000,
  minDiskFreePct: 10,
};

function requireAdminToken(token) {
  if (!token) throw new Error('Set OSI_ADMIN_TOKEN to run this script.');
  return token;
}

function fetchSyncHealth(serverBase, eui, adminToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/v1/admin/sync-health?gatewayEui=${encodeURIComponent(eui)}&limit=1`, serverBase);
    const client = url.protocol === 'http:' ? http : https;
    const req = client.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers: { Authorization: `Bearer ${adminToken}` },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error(`auth failure: HTTP ${res.statusCode}`));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`sync-health HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`sync-health response was not valid JSON: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Pure: one poll's JSON body -> {pass, reasons}. No I/O, no clock reads other
// than what's passed in ctx. This is the unit the full §C criteria live in.
function evaluatePoll(body, ctx) {
  const reasons = [];
  const gateway = (body.gateways || []).find((g) => g.gatewayEui === ctx.eui);
  if (!gateway) {
    return { pass: false, reasons: ['gateway_not_found'] };
  }

  // §C.1 Freshness + liveness
  const heartbeatAgeSeconds = Number(gateway.heartbeatAgeSeconds);
  if (!Number.isFinite(heartbeatAgeSeconds) || heartbeatAgeSeconds > 120) {
    reasons.push('heartbeat_stale');
  }
  const recordedAtMs = Date.parse(gateway.currentStateRecordedAt || '');
  if (!Number.isFinite(recordedAtMs) || recordedAtMs < ctx.sinceMs) {
    reasons.push('heartbeat_before_deploy');
  }

  // §C.2 Server verdict (+ optional exact schema_sig pin for schema-changing deploys)
  const edgeHealth = gateway.edgeHealth || {};
  for (const reason of edgeHealth.reasons || []) reasons.push(reason);
  if (ctx.expectSchemaSig && edgeHealth.schemaSig !== ctx.expectSchemaSig) {
    reasons.push('schema_sig_mismatch');
  }

  // §C.3 Disk (also enforced server-side via disk_free_low, but the gate
  // checks its own configured threshold independently in case the server's
  // default differs from --min-disk-free-pct)
  if (Number.isFinite(edgeHealth.diskFreePct) && edgeHealth.diskFreePct < ctx.minDiskFreePct
      && !reasons.includes('disk_free_low')) {
    reasons.push('disk_free_low');
  }

  // §C.4 Error delta — baseline is the first post-deploy value seen by the
  // gate itself (no pre-deploy capture, no persistence). errorsTotal may be
  // absent if the osi-server pass-through (item 0.2 Task 3) hasn't shipped
  // yet or the edge hasn't been redeployed with the errors_total heartbeat
  // field — tolerate absence, never crash, never fail on it alone.
  if (Number.isFinite(ctx.errorsBaseline) && Number.isFinite(edgeHealth.errorsTotal)
      && edgeHealth.errorsTotal > ctx.errorsBaseline) {
    reasons.push('errors_total_increased');
  }

  return { pass: reasons.length === 0, reasons };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// §C.5 Consecutiveness loop + §C.4 baseline capture. Any failing poll resets
// the consecutive-pass count to zero. Exits the loop as soon as N consecutive
// passes are observed, or when the timeout budget is exhausted.
async function runGate(opts) {
  const consecutive = opts.consecutive ?? DEFAULTS.consecutive;
  const intervalMs = opts.intervalMs ?? DEFAULTS.intervalMs;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const minDiskFreePct = opts.minDiskFreePct ?? DEFAULTS.minDiskFreePct;
  const sinceMs = Date.parse(opts.since);
  if (!Number.isFinite(sinceMs)) throw new Error(`--since is not a valid ISO8601 timestamp: ${opts.since}`);

  const deadline = Date.now() + timeoutMs;
  let consecutivePasses = 0;
  let errorsBaseline = null;
  let lastReasons = ['timeout_no_poll_completed'];

  while (Date.now() < deadline) {
    const body = await fetchSyncHealth(opts.server, opts.eui, opts.adminToken);
    const gateway = (body.gateways || []).find((g) => g.gatewayEui === opts.eui);
    const errorsTotal = gateway && gateway.edgeHealth ? Number(gateway.edgeHealth.errorsTotal) : NaN;
    if (errorsBaseline === null && Number.isFinite(errorsTotal)) {
      errorsBaseline = errorsTotal; // first post-deploy value becomes the baseline, per §C.4
    }

    const { pass, reasons } = evaluatePoll(body, {
      eui: opts.eui,
      sinceMs,
      nowMs: Date.now(),
      minDiskFreePct,
      expectSchemaSig: opts.expectSchemaSig,
      errorsBaseline,
    });
    lastReasons = reasons.length ? reasons : lastReasons;

    if (pass) {
      consecutivePasses += 1;
      if (consecutivePasses >= consecutive) {
        return { ok: true, reasons: [] };
      }
    } else {
      consecutivePasses = 0; // §C.5: any failing poll resets the count
    }

    if (Date.now() + intervalMs >= deadline) break;
    await sleep(intervalMs);
  }

  return { ok: false, reasons: lastReasons };
}

function parseArgs(argv) {
  const out = { consecutive: DEFAULTS.consecutive, intervalMs: DEFAULTS.intervalMs, timeoutMs: DEFAULTS.timeoutMs, minDiskFreePct: DEFAULTS.minDiskFreePct };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--eui') out.eui = next();
    else if (a === '--since') out.since = next();
    else if (a === '--server') out.server = next();
    else if (a === '--expect-schema-sig') out.expectSchemaSig = next();
    else if (a === '--consecutive') out.consecutive = Number(next());
    else if (a === '--interval') out.intervalMs = Number(next()) * 1000;
    else if (a === '--timeout') out.timeoutMs = Number(next()) * 1000;
    else if (a === '--min-disk-free-pct') out.minDiskFreePct = Number(next());
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (!opts.eui) throw new Error('--eui <EUI> is required');
    if (!opts.since) throw new Error('--since <ISO8601 deploy timestamp> is required');
    opts.server = opts.server || process.env.OSI_SERVER_BASE_URL || 'https://server.opensmartirrigation.org';
    opts.adminToken = requireAdminToken(process.env.OSI_ADMIN_TOKEN);
  } catch (e) {
    console.error(`[deploy-canary-gate] usage error: ${e.message}`);
    process.exit(2);
  }

  try {
    const result = await runGate(opts);
    if (result.ok) {
      console.log(`[deploy-canary-gate] PASS — ${opts.eui} healthy for ${opts.consecutive} consecutive polls`);
      process.exit(0);
    }
    console.error(`[deploy-canary-gate] FAIL — reasons: ${result.reasons.join(', ')}`);
    process.exit(1);
  } catch (e) {
    console.error(`[deploy-canary-gate] transport/auth error: ${e.message}`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { evaluatePoll, runGate, requireAdminToken, fetchSyncHealth, parseArgs };
```

- [ ] **Step 1.4: Run it (green)**

Run: `node --test scripts/deploy-canary-gate.test.js`
Expected: all tests pass (16 tests), exit 0.

- [ ] **Step 1.5: Commit**

```bash
git add scripts/deploy-canary-gate.js scripts/deploy-canary-gate.test.js
git commit -m "feat(deploy): heartbeat-verified canary gate script (refactor-program 0.2)"
```

---

### Task 2: Edge slice — wire `errors_total`/`errors_last_at` into the heartbeat (both profiles)

**Files:**
- Modify (via one-shot script, both profiles): `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-heartbeat-health.js`

**Interfaces:**
- `Gather Edge Health` (`2a4f142e3e9b6d80`) merges `errors_total`/`errors_last_at` from `global.get('error_counts')` (shape `{total, last:{at, src, message}}`, maintained by `Record Error` / `record-error-fn`, untouched) into the same object it already merges into `global.set('edge_health', ...)`.
- `Build Heartbeat` (`062a0f9bf66d9789`) copies those two keys through its `healthValue` allowlist into both branches (`freshHealth` / stale-fallback) of the `health` object shipped in the MQTT payload.
- `scripts/verify-heartbeat-health.js`'s `REQUIRED_HEALTH_KEYS` grows from 7 to 9 keys; its `assertHealthMatches`/`assertAllNullHealth` fixtures gain matching entries.

- [ ] **Step 2.1: Write the failing assertions** — edit `scripts/verify-heartbeat-health.js`: change the `REQUIRED_HEALTH_KEYS` array (currently lines 13–21) to:

```js
const REQUIRED_HEALTH_KEYS = [
  'schema_sig',
  'sync_linked',
  'sync_pending',
  'sync_oldest_age_s',
  'sync_rejected',
  'sync_dirty_pending',
  'disk_free_pct',
  'errors_total',
  'errors_last_at',
];
```

Then find the call sites of `assertHealthMatches` and `assertAllNullHealth` in the same file (they pass an `edgeHealth`/expected fixture built earlier in the file) and add matching keys to those fixture objects — e.g. wherever the file builds a `const edgeHealth = { schema_sig: ..., sync_linked: ..., ... }` fixture for the "healthy" case, add `errors_total: 3, errors_last_at: 1720000000000` (a plain epoch-ms number, matching how `Record Error`'s `counts.last.at = Date.now()` is a number); wherever it builds the "stale/all-null" fixture, add `errors_total: null, errors_last_at: null`. Read the full file first (`node scripts/verify-heartbeat-health.js` output plus a read of the surrounding fixture-construction code around lines 220–370) before editing, since the exact fixture variable names must be matched — do not guess names blind.

- [ ] **Step 2.2: Run it (red)**

Run: `node scripts/verify-heartbeat-health.js`
Expected: FAIL — reports that `Build Heartbeat`'s health payload keys differ from `REQUIRED_HEALTH_KEYS` (missing `errors_total`, `errors_last_at`) for both profiles, since the flows.json edit hasn't happened yet.

- [ ] **Step 2.3: Write the flows.json mutation script** — save to the scratchpad (e.g. `/tmp/claude-.../scratchpad/edit-heartbeat-errors.js`), per `.claude/skills/osi-flows-json-editing/SKILL.md`'s mandatory roundtrip-guard pattern:

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd(); // run from repo root
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function assertRoundtripByteIdentical(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  const reserialized = serialize(parsed);
  if (Buffer.compare(original, reserialized) !== 0) {
    throw new Error(`Roundtrip guard failed for ${filePath}: STOP and investigate before mutating.`);
  }
  return parsed;
}

const GATHER_ID = '2a4f142e3e9b6d80';
const BUILD_ID = '062a0f9bf66d9789';

const NEW_GATHER_FUNC = [
  "const _db = new osiDb.Database('/data/db/farming.db');",
  "try {",
  "  const errCounts = global.get('error_counts') || {};",
  "  const errorsTotal = Number.isFinite(errCounts.total) ? errCounts.total : null;",
  "  const errorsLastAt = errCounts.last && Number.isFinite(errCounts.last.at) ? errCounts.last.at : null;",
  "  global.set('edge_health', Object.assign(",
  "    {at: Date.now(), errors_total: errorsTotal, errors_last_at: errorsLastAt},",
  "    await osiHealth.gatherEdgeHealth(_db)",
  "  ));",
  "} finally {",
  "  _db.close(()=>{});",
  "}",
  "return null;",
].join('\n');

function mutateBuildHeartbeatFunc(func) {
  // healthValue() allowlist is a closed set of two hand-written object
  // literals (fresh/stale branches) — add the two new keys to each,
  // immediately after disk_free_pct, matching existing style exactly.
  const freshMarker = "  disk_free_pct: healthValue(_h, 'disk_free_pct')\n} : {";
  const freshReplacement = "  disk_free_pct: healthValue(_h, 'disk_free_pct'),\n  errors_total: healthValue(_h, 'errors_total'),\n  errors_last_at: healthValue(_h, 'errors_last_at')\n} : {";
  if (!func.includes(freshMarker)) throw new Error('fresh-branch marker not found in Build Heartbeat func — inspect current source before retrying');
  let out = func.replace(freshMarker, freshReplacement);

  const staleMarker = '  disk_free_pct: null\n};';
  const staleReplacement = '  disk_free_pct: null,\n  errors_total: null,\n  errors_last_at: null\n};';
  if (!out.includes(staleMarker)) throw new Error('stale-branch marker not found in Build Heartbeat func — inspect current source before retrying');
  out = out.replace(staleMarker, staleReplacement);
  return out;
}

function mutate(flows) {
  const gather = flows.find((n) => n.id === GATHER_ID);
  if (!gather) throw new Error('Gather Edge Health node not found');
  if (gather.func.includes('errors_total')) throw new Error('Gather Edge Health already mutated — refusing double-edit');
  gather.func = NEW_GATHER_FUNC;

  const build = flows.find((n) => n.id === BUILD_ID);
  if (!build) throw new Error('Build Heartbeat node not found');
  if (build.func.includes('errors_total')) throw new Error('Build Heartbeat already mutated — refusing double-edit');
  build.func = mutateBuildHeartbeatFunc(build.func);
}

const flows = assertRoundtripByteIdentical(CANONICAL);
console.log('Roundtrip guard OK (canonical). Node count:', flows.length);
mutate(flows);
fs.writeFileSync(CANONICAL, serialize(flows));
console.log('Wrote canonical.');

const mirrorFlows = assertRoundtripByteIdentical(MIRROR);
mutate(mirrorFlows);
fs.writeFileSync(MIRROR, serialize(mirrorFlows));
console.log('Wrote mirror.');

assertRoundtripByteIdentical(CANONICAL);
assertRoundtripByteIdentical(MIRROR);
console.log('Post-write roundtrip guard OK on both profiles.');
```

Before running: read the *actual current* `func` strings of both nodes (`node -e "console.log(JSON.stringify(require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json').find(n=>n.id==='062a0f9bf66d9789').func))"`) and confirm the `freshMarker`/`staleMarker` literal strings above match byte-for-byte before running the mutation — the markers were extracted from the current source but function bodies drift; treat this as the final check, not a formality.

Run: `node /path/to/scratchpad/edit-heartbeat-errors.js` (from repo root)
Expected: `Roundtrip guard OK (canonical). Node count: 564` then `Wrote canonical.` then `Wrote mirror.` then `Post-write roundtrip guard OK on both profiles.`

- [ ] **Step 2.4: Run it (green)** — the full pre-commit checklist for a flows.json edit:

```bash
node scripts/verify-heartbeat-health.js
node scripts/verify-profile-parity.js
node --test scripts/test-error-recording-flow.js
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-no-stray-ddl.js
```

Expected: `verify-heartbeat-health.js` reports no failures for either profile (health keys now match `REQUIRED_HEALTH_KEYS`, values match the fixtures updated in Step 2.1); `verify-profile-parity.js` prints `All parity checks passed.` (both profiles still byte-identical to each other); `test-error-recording-flow.js` still passes (Record Error itself is untouched); `verify-sync-flow.js` and the silent-catch/stray-DDL verifiers stay green (no new catch blocks or DDL were introduced).

- [ ] **Step 2.5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/verify-heartbeat-health.js
git commit -m "feat(heartbeat): wire errors_total/errors_last_at into edge_health (closes #102 deferred slice, refactor-program 0.2)"
```

---

### Task 3 (conditional): osi-server — additive pass-through for `errors_total`/`errors_last_at`

**Precondition — re-verify before starting:** confirm `SyncHealthService.edgeHealth()` in `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/SyncHealthService.java` still does NOT expose `errorsTotal`/`errorsLastAt` (as verified 2026-07-07: the SQL in `loadGatewayRows()` extracts exactly five named `#>> '{health,...}'` paths, and `edgeHealth()` maps exactly those five into the response — no generic pass-through exists at either layer). If someone already added it, skip this task and note so in the PR.

**Files:**
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/SyncHealthService.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/sync/SyncHealthServiceTest.java`

**Interfaces:**
- SQL (`loadGatewayRows`, inside the `SELECT` list, immediately after the `edge_disk_free_pct` line): add
  ```sql
  gateway.current_state_json #>> '{health,errors_total}' AS edge_errors_total,
  gateway.current_state_json #>> '{health,errors_last_at}' AS edge_errors_last_at,
  ```
- Java (`edgeHealth(Map<String,Object> row)`): read the two new columns with the **existing** `nullableLong`/`nullableString` helpers (already defined in the class — do not add new ones), and add them to the response map. No new failure `reasons` entry — per spec §B/§21, "a rising counter is diagnostic, not a server-side failure" — the gate (Task 1), not the server, judges the delta.

- [ ] **Step 3.1: Write the failing test** — in `SyncHealthServiceTest.java`, add a new test after `presentHealthyEdgeHealthWithAcceptedSchemaYieldsHealthyVerdict` (copy its structure exactly, changing only the added fields and assertions):

```java
    @Test
    @SuppressWarnings("unchecked")
    void edgeHealthPassesThroughErrorsTotalAndErrorsLastAtAdditively() {
        when(jdbc.queryForObject(anyString(), any(Class.class)))
            .thenReturn(0L, 0L, 0L, 0L, 0L, 0L, 0.0);
        when(jdbc.queryForList(anyString(), any(Object[].class))).thenReturn(List.of(gatewayRow(
                "gateway_eui", "0016C001F11715E2",
                "pending_event_count", 0L,
                "oldest_pending_event_age_seconds", 0.0,
                "pending_command_count", 0L,
                "stale_sent_commands", 0L,
                "linked_auth_repair_status", "unknown",
                "last_seen_age_seconds", 15.0,
                "heartbeat_age_seconds", 15.0,
                "edge_health_present", true,
                "edge_schema_sig", "schema-a",
                "edge_sync_linked", "true",
                "edge_sync_oldest_age_s", "45",
                "edge_sync_rejected", "0",
                "edge_disk_free_pct", "25",
                "edge_errors_total", "3",
                "edge_errors_last_at", "1720000000000"
        )));
        when(dbHealthCounters.snapshot()).thenReturn(Map.of());

        SyncHealthService service = new SyncHealthService(jdbc, dbHealthCounters);
        service.setEdgeHealthConfig(3600, 10.0, "schema-a");
        Map<String, Object> health = service.getSyncHealth(null, 10);

        List<Map<String, Object>> gateways = (List<Map<String, Object>>) health.get("gateways");
        Map<String, Object> edgeHealth = (Map<String, Object>) gateways.get(0).get("edgeHealth");
        assertThat(edgeHealth).containsEntry("status", "healthy");
        assertThat(edgeHealth).containsEntry("errorsTotal", 3L);
        assertThat(edgeHealth).containsEntry("errorsLastAt", "1720000000000");
        // additive: a rising error count is NOT a server-side unhealthy reason (spec §B) —
        // the gate script judges the delta, not this service.
        assertThat((List<String>) edgeHealth.get("reasons")).isEmpty();
    }

    @Test
    @SuppressWarnings("unchecked")
    void edgeHealthToleratesMissingErrorsFieldsAsNull() {
        when(jdbc.queryForObject(anyString(), any(Class.class)))
            .thenReturn(0L, 0L, 0L, 0L, 0L, 0L, 0.0);
        when(jdbc.queryForList(anyString(), any(Object[].class))).thenReturn(List.of(gatewayRow(
                "gateway_eui", "0016C001F11715E2",
                "pending_event_count", 0L,
                "oldest_pending_event_age_seconds", 0.0,
                "pending_command_count", 0L,
                "stale_sent_commands", 0L,
                "linked_auth_repair_status", "unknown",
                "last_seen_age_seconds", 15.0,
                "heartbeat_age_seconds", 15.0,
                "edge_health_present", true,
                "edge_schema_sig", "schema-a",
                "edge_sync_linked", "true",
                "edge_sync_oldest_age_s", "45",
                "edge_sync_rejected", "0",
                "edge_disk_free_pct", "25"
        )));
        when(dbHealthCounters.snapshot()).thenReturn(Map.of());

        SyncHealthService service = new SyncHealthService(jdbc, dbHealthCounters);
        service.setEdgeHealthConfig(3600, 10.0, "schema-a");
        Map<String, Object> health = service.getSyncHealth(null, 10);

        List<Map<String, Object>> gateways = (List<Map<String, Object>>) health.get("gateways");
        Map<String, Object> edgeHealth = (Map<String, Object>) gateways.get(0).get("edgeHealth");
        assertThat(edgeHealth).containsEntry("status", "healthy");
        assertThat(edgeHealth).containsEntry("errorsTotal", null);
        assertThat(edgeHealth).containsEntry("errorsLastAt", null);
    }
```

- [ ] **Step 3.2: Run it (red)**

Run (from `/home/phil/Repos/osi-server`): `./gradlew test --tests "org.osi.server.sync.SyncHealthServiceTest" -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL — `edgeHealthPassesThroughErrorsTotalAndErrorsLastAtAdditively` fails on `containsEntry("errorsTotal", 3L)` (key absent), since the SQL/Java changes haven't landed yet.

- [ ] **Step 3.3: Implement** — in `SyncHealthService.java`:

In `loadGatewayRows()`'s SQL string, immediately after the line `gateway.current_state_json #>> '{health,disk_free_pct}' AS edge_disk_free_pct,`, insert:

```java
                       gateway.current_state_json #>> '{health,errors_total}' AS edge_errors_total,
                       gateway.current_state_json #>> '{health,errors_last_at}' AS edge_errors_last_at,
```

In the same method's row-normalization loop, no change needed — `edgeHealth(row)` is called with the whole `row` map, which will now contain the two new keys automatically via the existing `value(row, key)` case-insensitive lookup helper.

In `edgeHealth(Map<String, Object> row)`, immediately after the line `Double diskFreePct = nullableDouble(diskFreePctValue);`, insert:

```java
        Long errorsTotal = nullableLong(value(row, "edge_errors_total"));
        String errorsLastAt = nullableString(value(row, "edge_errors_last_at"));
```

and immediately after `edgeHealth.put("diskFreePct", diskFreePct);` (before the `return edgeHealth;` line), insert:

```java
        edgeHealth.put("errorsTotal", errorsTotal);
        edgeHealth.put("errorsLastAt", errorsLastAt);
```

No new `reasons.add(...)` call — errors_total is diagnostic-only at this layer per spec §B.

- [ ] **Step 3.4: Run it (green)**

Run: `./gradlew test --tests "org.osi.server.sync.SyncHealthServiceTest" -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: all tests in the class pass, including the two new ones.

Then run the full backend suite to confirm no regression (osi-server has no CI, so this is the only gate):

Run: `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3.5: Commit** (in the osi-server repo/branch, separate from the osi-os branch)

```bash
git add backend/src/main/java/org/osi/server/sync/SyncHealthService.java \
        backend/src/test/java/org/osi/server/sync/SyncHealthServiceTest.java
git commit -m "feat(sync-health): additive pass-through of errors_total/errors_last_at (osi-os refactor-program item 0.2)"
```

Note in the osi-os PR (Task 4) that this commit lives in a companion osi-server branch/PR, since osi-server is a separate repository — link both.

---

### Task 4: Runbook doc + CI wiring + program doc update + PR

**Files:**
- Create: `docs/operations/deploy-canary-gate-runbook.md`
- Modify: `.github/workflows/migrations.yml`
- Modify: `docs/architecture/refactor-program-2026.md`

**Interfaces:** none (docs + CI config only).

- [ ] **Step 4.1: Wire the gate's test suite into CI** — edit `.github/workflows/migrations.yml`: add a new step after the existing `- run: node --test scripts/test-gateway-health-persistence.js` line:

```yaml
      - run: node --test scripts/deploy-canary-gate.test.js
```

- [ ] **Step 4.2: Run the full local CI-equivalent sequence to confirm green**

```bash
git fetch --no-tags origin main:refs/remotes/origin/main
node --test lib/osi-migrate/__tests__/*.test.js
node --test scripts/check-sync-parity.test.js scripts/restamp-fingerprints.test.js scripts/verify-migrations.test.js scripts/verify-no-stray-ddl.test.js scripts/verify-no-new-silent-catch.test.js scripts/test-error-recording-flow.js
node scripts/test-history-helper.js
node --test scripts/test-health-helper.js
node scripts/verify-migrations.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-seed-replay.js
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-devices-rebuild-fence.js
node scripts/verify-heartbeat-health.js
node --test scripts/rehearse-devices-rebuild.test.js
node --test scripts/test-gateway-health-persistence.js
node scripts/test-contract-schemas.js
node --test scripts/deploy-canary-gate.test.js
node scripts/verify-profile-parity.js
```

Expected: every command exits 0 with its documented success message (see each script's own `OK`/`PASS` output); no regressions from Tasks 1–2.

- [ ] **Step 4.3: Write the runbook** — create `docs/operations/deploy-canary-gate-runbook.md` with exactly:

```markdown
# Deploy Canary Gate — Rollout Runbook

**Spec:** `docs/superpowers/specs/2026-07-07-deploy-canary-gate-design.md`
**Script:** `scripts/deploy-canary-gate.js`
**Scope:** operator procedure for using the gate between manual per-Pi deploy steps. The gate does not deploy, does not roll back, and does not orchestrate the fleet (refactor-program items 5.3 / future fleet work) — it is the go/no-go check.

## When to use

After running `deploy.sh` (or any manual flows/schema push) against a gateway, before moving on to the next gateway or declaring the rollout done.

## Usage

```bash
export OSI_ADMIN_TOKEN=<admin JWT>
node scripts/deploy-canary-gate.js \
  --eui <GATEWAY_EUI> \
  --since <ISO8601 timestamp of when the deploy started> \
  [--server https://server.opensmartirrigation.org] \
  [--expect-schema-sig <sig>]   # required for schema-changing deploys (e.g. migration 0004 delivery)
```

Exit codes: `0` = PASS (advance to the next gateway); `1` = FAIL (reasons printed on stderr — investigate before advancing, do not proceed); `2` = usage/auth/transport error (the gate could not judge — treat as FAIL).

## Rollout shape (per spec §D)

`deploy kaba100 → gate kaba100 → deploy Silvan → gate Silvan`. Each gateway is gated independently before moving to the next; a FAIL or exit-2 stops the rollout at that gateway.

## Uganda

Uganda (#87) runs inside its own deploy window using this same gate as the final verification step — the heartbeat is Uganda's only remote post-migration signal (per the Option B plan). No SSH-based verification substitutes for the gate's judgment; if the gate fails, follow the standard live-ops incident path (`osi-live-ops-runbook` skill) before retrying.

## What the gate does NOT do

- Does not deploy or roll back (rollback is refactor-program item 5.3).
- Does not orchestrate multiple gateways in parallel — one gateway per invocation.
- Does not SSH or inspect the Pi directly — it is a pure consumer of osi-server's `GET /api/v1/admin/sync-health`, so it can run from any operator machine that can reach the cloud.

## Evidence

Item 0.1's demo-gateway deploy (kaba100 / Silvan) is the gate's first live validation. Record its PASS output (stdout/stderr) as evidence in that rollout's tracking issue/PR.
```

- [ ] **Step 4.4: Update the program doc** — in `docs/architecture/refactor-program-2026.md`, edit the Phase 0 table row for item 0.2 to append an outcome note. Change:

```
| 0.2 Heartbeat canary gate: deploy tooling refuses to advance until target gateway reports N healthy heartbeats (schema_sig = target, error_count flat, disk_free OK) | osi-os tooling | M | heartbeat #100 (done) | spec+plan |
```

to:

```
| 0.2 Heartbeat canary gate: deploy tooling refuses to advance until target gateway reports N healthy heartbeats (schema_sig = target, error_count flat, disk_free OK) | osi-os tooling | M | heartbeat #100 (done) | spec+plan — done: `scripts/deploy-canary-gate.js` + runbook, PR #<FILL IN AT PR TIME> |
```

(Fill in the actual PR number when Step 4.5 opens it — do not leave `<FILL IN AT PR TIME>` in the committed version; edit again after the PR exists if the doc commit lands before the PR does.)

- [ ] **Step 4.5: Commit**

```bash
git add .github/workflows/migrations.yml docs/operations/deploy-canary-gate-runbook.md docs/architecture/refactor-program-2026.md
git commit -m "docs(deploy): canary gate runbook + CI wiring + program doc update (refactor-program 0.2)"
```

- [ ] **Step 4.6: Open the PR (do not merge)**

```bash
git push -u origin feat/deploy-canary-gate
gh pr create --title "Deploy canary gate: heartbeat-verified staged rollout (0.2)" --body "$(cat <<'EOF'
## Summary
- `scripts/deploy-canary-gate.js` + full `node --test` suite: polls osi-server's `GET /api/v1/admin/sync-health` and refuses to advance a rollout until N consecutive healthy polls (freshness, server verdict, disk, error-delta, consecutiveness — spec §C).
- Edge: wires `errors_total`/`errors_last_at` into the heartbeat's `health` object via `Gather Edge Health` + `Build Heartbeat` (both flows.json profiles), closing the #102-deferred slice.
- Conditional: osi-server additive pass-through so `errors_total`/`errors_last_at` are visible in `edgeHealth` (see companion osi-server PR, if Task 3 was needed — link here).
- Runbook: `docs/operations/deploy-canary-gate-runbook.md`.
- CI: gate's test suite wired into `.github/workflows/migrations.yml`.

## Evidence
- `node --test scripts/deploy-canary-gate.test.js` — all passing (mocked sync-health fixture: pass path, each §C criterion failing individually, consecutiveness reset, timeout, `--expect-schema-sig` mismatch, auth failure).
- `node scripts/verify-heartbeat-health.js` — green on both profiles with the new keys.
- `node scripts/verify-profile-parity.js` — green (flows.json profiles still byte-identical).
- Full local CI-equivalent sequence (see plan Task 4 Step 4.2) — all green.

Part of refactor-program item 0.2. Item 0.1's demo-gateway deploy (kaba100/Silvan) is the gate's first live validation — not yet run as of this PR; tracked as a runbook follow-up, not blocking merge.

## Test plan
- [ ] CI green on this PR
- [ ] Companion osi-server PR (if applicable) merged or linked
- [ ] Runbook reviewed by whoever runs the next live deploy
EOF
)"
```

---

## Follow-ups (not tasks in this plan)

- **Live gate validation**: run `scripts/deploy-canary-gate.js` for real against kaba100 and/or Silvan as part of item 0.1's demo deploy, and record the PASS output as evidence (spec DoD line 4). This requires a live gateway and is explicitly out of scope for this plan's no-SSH constraint.
- **osi-server companion PR**: if Task 3 was executed, its commit lives on a separate osi-server branch/PR — merge coordination between the two repos is an operator step, not a plan task.
- Program doc: after both PRs are open, replace the `<FILL IN AT PR TIME>` placeholder in `docs/architecture/refactor-program-2026.md` with the real PR link(s) if it wasn't done in Step 4.4.
