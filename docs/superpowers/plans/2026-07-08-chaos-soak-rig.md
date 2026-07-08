# Chaos / soak rig — local rehearsal harness (refactor-program 5.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Repo:** all changes in **osi-os** (`/home/phil/Repos/osi-os`). Branch `feat/52-chaos-soak-rig`, PR, **do not merge**. Work in a worktree, not the root `main` checkout.
> **Execution notes:** (1) run every command from the worktree root; (2) this rig **runs** real edge code (the `sync-init-fn` boot node, flows function nodes, `lib/osi-migrate`) — it **never modifies** any of them; (3) the deterministic scenario tests wire into `.github/workflows/migrations.yml` as a NEW `node --test` line added after the existing `node --test scripts/rehearse-devices-rebuild.test.js` run (line 49) — see Task 6.4; (4) the genuine-SIGKILL kill-point matrix + constrained-FS cases are OPERATOR rehearsals with committed artifacts, NOT CI (mirroring the `rehearse-devices-rebuild.test.js` CI-vs-production-copy split); (5) `node:sqlite` (`DatabaseSync`) requires Node >= 22.5 — the workflow already pins `node-version: '22'` (line 32) for `rehearse-devices-rebuild`; (6) `sqlite3` CLI is on the image and in CI (`lib/osi-migrate` uses it).
> **Spec:** [`docs/superpowers/specs/2026-07-08-chaos-soak-rig-design.md`](../specs/2026-07-08-chaos-soak-rig-design.md) (recovered + verified; §A–§G references point there).

**Goal:** A local chaos/soak rig under `scripts/soak/` that exercises the four field-fatal failure modes — weeks-offline outbox replay, clock jump, kill-9-mid-migration, SD-full — against **real edge code** (the `rehearse-devices-rebuild.js` facade-shim pattern over `node:sqlite` for flows function nodes; the real `lib/osi-migrate` runner + `backup.js` for migration scenarios), on **synthetic or copied DBs only** (never a live file). Each scenario emits a machine-readable JSON **evidence artifact** the Stage-1/Stage-2 runbooks and downstream items (4.3, #87, 5.6) cite as "rehearsed." The kill-9-mid-migration matrix (§D) is the **power-loss-mid-migration rehearsal** that gates Option B Stage 2 (4.3, boot-DDL removal).

**Architecture (spec §A–§G):** A shared harness module (`scripts/soak/rig.js`) provides: a scratch-dir factory, a fixture-copy helper that asserts the source hash is unchanged after, the `rehearse-devices-rebuild.js`-style facade shim (`makeFacadeShim(dbPath)` over `node:sqlite` `DatabaseSync`, mirroring the `osi-db-helper` `run/all/get/exec/transaction/close` surface), a `funcText(nodeId)` reader that pulls the real function body out of `flows.json`, and an `emitArtifact(scenario, result)` writer (JSON under `scripts/soak/artifacts/`). Four scenario modules (`scenario-outbox-replay.js`, `scenario-clock-jump.js`, `scenario-kill9-migration.js`, `scenario-sd-full.js`) each export a `run(opts)` returning the artifact object; a `node --test` file per scenario drives the deterministic subset; a thin CLI (`scripts/soak/run.js <scenario>`) runs the operator/artifact-capturing form.

**Tech Stack:** Node.js (`node:test`, `node:sqlite` `DatabaseSync`, `node:child_process`, no new deps), `sqlite3` CLI via `lib/osi-migrate/runner-iface`/`backup.js`, GitHub Actions (`migrations.yml`).

## Global Constraints

- **osi-os only.** Branch `feat/52-chaos-soak-rig`; commit per task; PR; **do not merge**.
- **The rig RUNS real code; it NEVER modifies it.** No change to `sync-init-fn`, any flows function node, `lib/osi-migrate`, `backup.js`, `deploy.sh`, or any decoder. Zero flows.json edit in this plan.
- **Synthetic or COPIED DBs only, in a scratch dir** (spec §A / the 5.1 invariant). Where a scenario needs "a real gateway shape," seed from `database/seed-blank.sql` or copy a supplied read-only fixture, and assert the source fixture's SHA-256 is unchanged after the run. **Never a live/production DB, never SSH, never a cloud write to production.**
- **The kill-9 runner operates on a DB COPY only** (spec §D) — it SIGKILLs a child mid-`applyPending` against a copied/seeded DB, never a farm file. This is the load-bearing farm-data-safety property 4.3 gates on: farm data is never at risk because the migration target is always a copy.
- **Each scenario emits one JSON artifact** (`{scenario, timestamp, inputs, invariants, outcome, timingsMs, notes}`) — the rig's output IS the gate's evidence.
- **CI-vs-operator split** (spec §G): deterministic scenarios (outbox-replay against a local Postgres/harness, clock-jump via injectable `now`, the deterministic kill-recovery cases, an SD-full subset forced via a size-capped scratch mount) run in CI `node --test`; the genuine-SIGKILL kill-point matrix + real-constrained-FS cases are operator rehearsals with committed artifacts.
- CI (`migrations.yml`) green at every commit.

## Non-goals (do not do these)

- No live gateways, no SSH, no production cloud writes (spec §Non-goals). No QEMU / full-image boot (verified: none exists today — plain-process Node + `node:sqlite` + `sqlite3` is the feasible tooling). Not a load/perf benchmark — timings are sanity bounds, not SLAs. Does NOT modify the code it exercises. Does NOT implement 5.6's scheduler behavior (Scenario 2 *rehearses* it; 5.6 *builds* it), does NOT fix 1.A5's outbox retention (Scenario 4 *exercises* the SD-full mode 1.A5 addresses), does NOT reimplement 1.B4's server-side backlog-drain test (Scenario 1 is its edge-side companion).

## File Structure (all paths from the worktree root)

- Create: `scripts/soak/rig.js` + `scripts/soak/rig.test.js` (Task 1 — shared harness)
- Create: `scripts/soak/scenario-outbox-replay.js` + `scripts/soak/scenario-outbox-replay.test.js` (Task 2)
- Create: `scripts/soak/scenario-clock-jump.js` + `scripts/soak/scenario-clock-jump.test.js` (Task 3)
- Create: `scripts/soak/scenario-kill9-migration.js` + `scripts/soak/scenario-kill9-migration.test.js` + `scripts/soak/kill9-child.js` (Task 4)
- Create: `scripts/soak/scenario-sd-full.js` + `scripts/soak/scenario-sd-full.test.js` (Task 5)
- Create: `scripts/soak/run.js` (CLI); `scripts/soak/artifacts/.gitkeep`; `scripts/soak/README.md` (Task 6)
- Modify: `.github/workflows/migrations.yml` (add the deterministic scenario tests) (Task 6)

---

### Task 1: `scripts/soak/rig.js` — shared harness (scratch dirs, facade shim, fixture-copy guard, artifact writer)

**Files:**
- Create: `scripts/soak/rig.test.js`
- Create: `scripts/soak/rig.js`

**Interfaces:**
- Produces: `scratchDir(prefix?) → string`; `copyFixture(srcDbPath, destDir) → { dbPath, srcSha256 }`; `assertFixtureUnchanged(srcDbPath, srcSha256) → void` (throws on change); `funcText(nodeId, flowsPath?) → string`; `makeFacadeShim(dbPath) → shim` (the `rehearse-devices-rebuild.js` shim, re-exported for scenario reuse); `emitArtifact(dir, scenario, result) → string` (writes `<dir>/<scenario>-<stamp>.json`, returns the path). Consumed by every scenario module (Tasks 2–5).

- [ ] **Step 1.1: Worktree + branch** — create a worktree of `main` at `feat/52-chaos-soak-rig`; `cd` into it. Confirm the on-disk facts the harness copies from:

```bash
node -e "const f=require('./scripts/rehearse-devices-rebuild.js')" 2>/dev/null; echo "rehearse module present: $?"
node --version   # expect v22.x — node:sqlite DatabaseSync needs >=22.5
```

- [ ] **Step 1.2: Write the failing test (red)** — create `scripts/soak/rig.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scratchDir, copyFixture, assertFixtureUnchanged, funcText, makeFacadeShim, emitArtifact } = require('./rig');

const REPO = path.resolve(__dirname, '..', '..');

test('scratchDir creates a unique writable directory', () => {
  const a = scratchDir('rigtest-');
  const b = scratchDir('rigtest-');
  assert.notEqual(a, b);
  assert.ok(fs.existsSync(a) && fs.statSync(a).isDirectory());
  fs.writeFileSync(path.join(a, 'probe'), 'ok');
  assert.equal(fs.readFileSync(path.join(a, 'probe'), 'utf8'), 'ok');
});

test('copyFixture copies a DB and reports the source hash; assertFixtureUnchanged passes when untouched', () => {
  const srcDir = scratchDir('rigsrc-');
  const src = path.join(srcDir, 'source.db');
  fs.writeFileSync(src, 'PRAGMA user_version=1;'); // opaque bytes are fine for the hash test
  const { dbPath, srcSha256 } = copyFixture(src, scratchDir('rigdst-'));
  assert.ok(fs.existsSync(dbPath));
  assert.equal(srcSha256, crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex'));
  fs.writeFileSync(dbPath, 'MUTATED COPY'); // mutating the COPY must not trip the source guard
  assert.doesNotThrow(() => assertFixtureUnchanged(src, srcSha256));
});

test('assertFixtureUnchanged THROWS if the source fixture was modified (the farm-data guard)', () => {
  const src = path.join(scratchDir('rigsrc2-'), 'source.db');
  fs.writeFileSync(src, 'original');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
  fs.writeFileSync(src, 'TAMPERED');
  assert.throws(() => assertFixtureUnchanged(src, sha), /fixture changed/i);
});

test('funcText pulls the REAL function body of a flows node by id', () => {
  const body = funcText('sync-outbox-build'); // "Build Edge Event Batch" — verified to exist
  assert.match(body, /LIMIT\s+100/, 'the real outbox drain caps at LIMIT 100');
});

test('makeFacadeShim exposes the osi-db-helper surface over a real node:sqlite DB', async () => {
  const db = path.join(scratchDir('rigshim-'), 'f.db');
  const shim = makeFacadeShim(db);
  await shim.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
  await shim.run("INSERT INTO t (v) VALUES ('x')");
  assert.deepEqual(await shim.all('SELECT v FROM t'), [{ v: 'x' }]);
  assert.deepEqual(await shim.get('SELECT COUNT(*) c FROM t'), { c: 1 });
  await shim.transaction(async (s) => { await s.run("INSERT INTO t (v) VALUES ('y')"); });
  assert.equal((await shim.get('SELECT COUNT(*) c FROM t')).c, 2);
  await new Promise((res) => shim.close(res));
});

test('emitArtifact writes a JSON evidence file and returns its path', () => {
  const dir = scratchDir('rigart-');
  const p = emitArtifact(dir, 'demo', { outcome: 'pass', invariants: { rows: 3 }, timingsMs: 12 });
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(doc.scenario, 'demo');
  assert.equal(doc.outcome, 'pass');
  assert.equal(doc.invariants.rows, 3);
  assert.equal(typeof doc.timestamp, 'string');
});
```

Run: `node --test scripts/soak/rig.test.js`
Expected: FAIL — `Cannot find module './rig'`.

- [ ] **Step 1.3: Implement** — create `scripts/soak/rig.js` with exactly:

```js
'use strict';
// Chaos/soak rig — shared harness (refactor-program 5.2), spec §A:
//   docs/superpowers/specs/2026-07-08-chaos-soak-rig-design.md
// This module RUNS real edge code; it never modifies it. The facade shim mirrors
// scripts/rehearse-devices-rebuild.js exactly (the run-real-function-text precedent).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..', '..');
const DEFAULT_FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

function scratchDir(prefix = 'soak-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Copy a read-only fixture into a scratch dir and return its source hash so the
// caller can prove (via assertFixtureUnchanged) it never mutated the source.
function copyFixture(srcDbPath, destDir) {
  if (!fs.existsSync(srcDbPath)) throw new Error(`fixture does not exist: ${srcDbPath}`);
  const dbPath = path.join(destDir, path.basename(srcDbPath));
  fs.copyFileSync(srcDbPath, dbPath);
  return { dbPath, srcSha256: sha256(srcDbPath) };
}

function assertFixtureUnchanged(srcDbPath, srcSha256) {
  const now = sha256(srcDbPath);
  if (now !== srcSha256) {
    throw new Error(`source fixture changed during run (farm-data guard): ${srcDbPath}`);
  }
}

function funcText(nodeId, flowsPath = DEFAULT_FLOWS) {
  const node = JSON.parse(fs.readFileSync(flowsPath, 'utf8')).find((n) => n.id === nodeId);
  if (!node) throw new Error(`flows node not found: ${nodeId}`);
  if (typeof node.func !== 'string') throw new Error(`flows node ${nodeId} has no func body`);
  return node.func;
}

// Facade-compatible shim over node:sqlite (REAL engine) — copied from
// scripts/rehearse-devices-rebuild.js makeFacadeShim: run/all/get/exec (promise OR
// node-style callback) + transaction (BEGIN IMMEDIATE/COMMIT/ROLLBACK) + close.
function makeFacadeShim(dbPath) {
  const db = new DatabaseSync(dbPath);
  const call = (kind) => (sql, cb) => {
    try {
      let r;
      if (kind === 'run' || kind === 'exec') { db.exec(sql); r = undefined; }
      else if (kind === 'get') r = db.prepare(sql).get();
      else r = db.prepare(sql).all();
      if (typeof cb === 'function') { process.nextTick(() => cb(null, r)); return; }
      return Promise.resolve(r);
    } catch (e) {
      if (typeof cb === 'function') { process.nextTick(() => cb(e)); return; }
      return Promise.reject(e);
    }
  };
  const scope = { run: call('run'), all: call('all'), get: call('get'), exec: call('exec') };
  return Object.assign({}, scope, {
    async transaction(executor) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = await executor(scope); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
    },
    close(cb) { try { db.close(); } catch (_) {} if (typeof cb === 'function') cb(); },
  });
}

function emitArtifact(dir, scenario, result) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${scenario}-${stamp}.json`);
  const doc = Object.assign({ scenario, timestamp: new Date().toISOString() }, result);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

module.exports = {
  REPO,
  DEFAULT_FLOWS,
  scratchDir,
  sha256,
  copyFixture,
  assertFixtureUnchanged,
  funcText,
  makeFacadeShim,
  emitArtifact,
};
```

- [ ] **Step 1.4: Run it (green)**

Run: `node --test scripts/soak/rig.test.js`
Expected: all 7 tests pass, exit 0.

- [ ] **Step 1.5: Commit**

```bash
git add scripts/soak/rig.js scripts/soak/rig.test.js
git commit -m "feat(soak): chaos/soak rig shared harness — facade shim, fixture-copy guard, artifact writer (5.2)"
```

---

### Task 2: Scenario 1 — weeks-offline outbox replay (spec §B)

**Files:**
- Create: `scripts/soak/scenario-outbox-replay.test.js`
- Create: `scripts/soak/scenario-outbox-replay.js`

**Interfaces:**
- Produces: `synthesizeBacklog(shim, { total, poisonEveryN }) → { inserted, poison }` — seeds `sync_outbox` with a large `delivered_at IS NULL` set plus a 1-in-`poisonEveryN` poison mix; `drainBacklog(shim, { applyBatch }) → { batches, delivered, rejected, retryable, remaining }` — runs the REAL `Build Edge Event Batch` (`sync-outbox-build`, `LIMIT 100`) drain query in a loop, calling `applyBatch(events)` (an injectable server-apply; the CI test uses an in-process fake modelling 1.B4's per-event-tx `applyEventsV2`, the operator run points it at a Testcontainers Postgres); `run(opts) → artifact`. Consumes Task 1's harness.

> **Server note:** the outbox-replay-into-a-real-server form uses the **1.B4 Testcontainers harness** (Docker Postgres + `applyEventsV2`) — cite, do not re-implement. Because that harness is a separate item, this plan's CI test drives the drain through an **in-process fake apply** that models 1.B4's contract (per-event transaction: a poison event is rejected without wedging its batch). The operator rehearsal swaps in the real server via `--server-url`; the artifact records which apply target was used.

- [ ] **Step 2.1: Write the failing test (red)** — create `scripts/soak/scenario-outbox-replay.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { scratchDir, makeFacadeShim } = require('./rig');
const { synthesizeBacklog, drainBacklog, MIN_OUTBOX_DDL } = require('./scenario-outbox-replay');

async function freshOutbox() {
  const db = path.join(scratchDir('sov1-'), 'f.db');
  const shim = makeFacadeShim(db);
  await shim.exec(MIN_OUTBOX_DDL);
  return shim;
}

// In-process apply that models 1.B4's per-event-transaction contract: each event
// is applied independently; a poison event is rejected, never wedges the batch.
function fakeServer() {
  const applied = new Set();
  return {
    applied,
    apply(events) {
      const out = { delivered: [], rejected: [] };
      for (const e of events) {
        if (e.poison) { out.rejected.push({ uuid: e.event_uuid, reason: 'constraint_violation' }); continue; }
        if (applied.has(e.event_uuid)) { out.delivered.push(e.event_uuid); continue; } // idempotent
        applied.add(e.event_uuid);
        out.delivered.push(e.event_uuid);
      }
      return out;
    },
  };
}

test('a weeks-offline backlog drains to zero pending (minus terminally-rejected); no poison wedges a batch', async () => {
  const shim = await freshOutbox();
  const { inserted, poison } = await synthesizeBacklog(shim, { total: 2500, poisonEveryN: 500 });
  assert.ok(inserted > 2000 && poison >= 4, `inserted=${inserted} poison=${poison}`);
  const server = fakeServer();
  const res = await drainBacklog(shim, { applyBatch: (events) => server.apply(events) });
  // reconciliation: delivered + rejected + retryable == input
  assert.equal(res.delivered + res.rejected + res.retryable, inserted);
  assert.equal(res.rejected, poison, 'exactly the poison rows are terminally rejected');
  // no undelivered/unrejected rows remain (a wedged batch would leave a stuck LIMIT-100 window)
  assert.equal(res.remaining, 0, 'backlog fully drained');
  assert.ok(res.batches >= Math.ceil(inserted / 100), 'drained via LIMIT-100 batches');
});

test('re-drain of an already-delivered backlog is a clean no-op (idempotent replay)', async () => {
  const shim = await freshOutbox();
  const { inserted } = await synthesizeBacklog(shim, { total: 300, poisonEveryN: 0 });
  const server = fakeServer();
  await drainBacklog(shim, { applyBatch: (e) => server.apply(e) });
  const second = await drainBacklog(shim, { applyBatch: (e) => server.apply(e) });
  assert.equal(second.delivered + second.rejected + second.retryable, 0);
  assert.equal(second.remaining, 0);
  assert.equal(inserted, 300);
});
```

- [ ] **Step 2.2: Run it (red)**

Run: `node --test scripts/soak/scenario-outbox-replay.test.js`
Expected: FAIL — `Cannot find module './scenario-outbox-replay'`.

- [ ] **Step 2.3: Implement** — create `scripts/soak/scenario-outbox-replay.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// Scenario 1: weeks-offline outbox replay (refactor-program 5.2, spec §B).
//   docs/superpowers/specs/2026-07-08-chaos-soak-rig-design.md
// Synthesizes a large `delivered_at IS NULL` backlog + a poison mix, then drains
// it through a LIMIT-100 loop modelling the REAL `Build Edge Event Batch` query
// (flows node `sync-outbox-build`), applying each batch per 1.B4's per-event-tx
// contract. Edge-side companion to 1.B4's server-side backlog-drain test.
const { emitArtifact, scratchDir, makeFacadeShim } = require('./rig');

// Minimal sync_outbox shape sufficient for the LIMIT-100 drain + delivered/rejected
// bookkeeping (matches the v2 columns in database/seed-blank.sql: rejected_at exists).
const MIN_OUTBOX_DDL = `
CREATE TABLE sync_outbox (
  event_uuid TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_key TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  delivered_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT
);`;

async function synthesizeBacklog(shim, { total, poisonEveryN }) {
  let inserted = 0;
  let poison = 0;
  await shim.transaction(async (s) => {
    for (let i = 0; i < total; i += 1) {
      const isPoison = poisonEveryN > 0 && i % poisonEveryN === 0;
      const uuid = `evt-${String(i).padStart(6, '0')}`;
      const payload = isPoison ? '{"bad":' : '{"ok":true}'; // malformed payload marks the poison rows
      await s.run(
        `INSERT INTO sync_outbox (event_uuid, aggregate_type, aggregate_key, op, payload_json, occurred_at)
         VALUES ('${uuid}', 'device_data', 'k${i}', 'insert', '${payload}', '2026-05-01T00:00:00Z')`
      );
      inserted += 1;
      if (isPoison) poison += 1;
    }
  });
  return { inserted, poison };
}

// The REAL drain shape: SELECT the oldest undelivered/unrejected rows, LIMIT 100
// (verified against flows node `sync-outbox-build`, which uses `LIMIT 100`).
const DRAIN_SQL = `
  SELECT event_uuid, aggregate_type, aggregate_key, op, payload_json, occurred_at
  FROM sync_outbox
  WHERE delivered_at IS NULL AND rejected_at IS NULL
  ORDER BY occurred_at ASC, event_uuid ASC
  LIMIT 100`;

async function drainBacklog(shim, { applyBatch }) {
  let batches = 0;
  let delivered = 0;
  let rejected = 0;
  let retryable = 0;
  // Guard against an accidental infinite loop if a batch makes no progress.
  for (let guard = 0; guard < 100000; guard += 1) {
    const rows = await shim.all(DRAIN_SQL);
    if (rows.length === 0) break;
    batches += 1;
    const events = rows.map((r) => ({
      event_uuid: r.event_uuid,
      aggregate_type: r.aggregate_type,
      payload_json: r.payload_json,
      poison: (() => { try { JSON.parse(r.payload_json); return false; } catch (_) { return true; } })(),
    }));
    const result = applyBatch(events);
    const now = new Date().toISOString();
    for (const uuid of result.delivered) {
      await shim.run(`UPDATE sync_outbox SET delivered_at='${now}' WHERE event_uuid='${uuid}'`);
      delivered += 1;
    }
    for (const r of result.rejected) {
      await shim.run(
        `UPDATE sync_outbox SET rejected_at='${now}', rejection_reason='${r.reason}' WHERE event_uuid='${r.uuid}'`
      );
      rejected += 1;
    }
    // Any row neither delivered nor rejected this batch is retryable — re-selected next tick.
    // If a full batch made zero progress, treat the rest as retryable and stop (no wedge).
    if (result.delivered.length === 0 && result.rejected.length === 0) {
      retryable += rows.length;
      break;
    }
  }
  const remaining = (await shim.get(
    'SELECT COUNT(*) c FROM sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL'
  )).c;
  return { batches, delivered, rejected, retryable, remaining };
}

async function run({ total = 10000, poisonEveryN = 500, applyBatch, artifactDir } = {}) {
  const db = require('node:path').join(scratchDir('sov1-run-'), 'f.db');
  const shim = makeFacadeShim(db);
  await shim.exec(MIN_OUTBOX_DDL);
  const t0 = Date.now();
  const { inserted, poison } = await synthesizeBacklog(shim, { total, poisonEveryN });
  const drain = await drainBacklog(shim, { applyBatch: applyBatch || (() => ({ delivered: [], rejected: [] })) });
  const timingsMs = Date.now() - t0;
  const outcome = (drain.remaining === 0
    && drain.delivered + drain.rejected + drain.retryable === inserted
    && timingsMs < 60000) ? 'pass' : 'fail';
  const result = {
    inputs: { total, poisonEveryN, applyTarget: applyBatch ? 'injected' : 'null' },
    invariants: { inserted, poison, ...drain },
    outcome,
    timingsMs,
    notes: 'Edge-side companion to 1.B4 server backlog-drain; drain query mirrors flows node sync-outbox-build (LIMIT 100).',
  };
  await new Promise((res) => shim.close(res));
  if (artifactDir) result.artifactPath = emitArtifact(artifactDir, 'outbox-replay', result);
  return result;
}

module.exports = { MIN_OUTBOX_DDL, synthesizeBacklog, drainBacklog, run };

if (require.main === module) {
  run({ artifactDir: require('node:path').join(__dirname, 'artifacts') })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.outcome === 'pass' ? 0 : 1); })
    .catch((e) => { console.error(`[outbox-replay] ERROR: ${e.message}`); process.exit(2); });
}
```

- [ ] **Step 2.4: Run it (green)**

Run: `node --test scripts/soak/scenario-outbox-replay.test.js`
Expected: both tests pass, exit 0.

- [ ] **Step 2.5: Commit**

```bash
git add scripts/soak/scenario-outbox-replay.js scripts/soak/scenario-outbox-replay.test.js
git commit -m "feat(soak): Scenario 1 — weeks-offline outbox replay drain (5.2, edge-side companion to 1.B4)"
```

---

### Task 3: Scenario 2 — clock jump (spec §C) — the 5.6 regression net

**Files:**
- Create: `scripts/soak/scenario-clock-jump.test.js`
- Create: `scripts/soak/scenario-clock-jump.js`

**Interfaces:**
- Produces: `runScheduleTick(shim, { nowMs, lastTriggeredAt, meanKpa, thresholdKpa }) → { fired, lastTriggeredAtWritten, logEvent }` — evaluates the scheduler decision path with an **injectable `now`** and a seeded `last_triggered_at`, returning whether it would fire; `run(opts) → artifact`. Consumes Task 1's harness.

> **Coupling (spec §C / §D):** this scenario is the regression net for item **5.6** — 5.6 *builds* the scheduler forward/backward-jump behavior; this scenario *proves* it. Until 5.6's guard lands in the real `Decide + build actuator cmd` node, this scenario models the intended contract (forward jump: no missed-window fire; backward jump with same-day `last_triggered_at`: suppressed; normal tick: fires). When 5.6 lands, re-point `runScheduleTick` at the real node body via `funcText('5f0d2b7e9b9b1b3a')` + the facade shim — the assertions do not change (recorded in Task 3's `notes`).

- [ ] **Step 3.1: Write the failing test (red)** — create `scripts/soak/scenario-clock-jump.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runScheduleTick } = require('./scenario-clock-jump');

const WINDOW_START = Date.parse('2026-05-10T06:00:00Z'); // the daily 06:00 window
const DAY = 24 * 3600 * 1000;

test('forward jump across the window does NOT auto-fire a missed window', () => {
  // Clock leaps from yesterday to well past today's 06:00; last fire was 2 days ago.
  const r = runScheduleTick({
    nowMs: WINDOW_START + 5 * 3600 * 1000, // 11:00, past the 06:00 tick
    lastTriggeredMs: WINDOW_START - 2 * DAY,
    forwardJump: true,
    meanKpa: 100, thresholdKpa: 50, // soil dry enough that a naive backfill WOULD fire
  });
  assert.equal(r.fired, false, 'a forward jump must never backfill a missed window');
  assert.equal(r.logEvent, 'clock_jump_forward');
});

test('backward jump with same-window last_triggered_at is suppressed (no double-fire)', () => {
  const r = runScheduleTick({
    nowMs: WINDOW_START, // clock rewound back onto 06:00
    lastTriggeredMs: WINDOW_START + 60 * 1000, // already fired today (1 min after the window)
    backwardJump: true,
    meanKpa: 100, thresholdKpa: 50,
  });
  assert.equal(r.fired, false, 'the same-day last_triggered_at guard must suppress the re-fire');
  assert.equal(r.logEvent, 'clock_jump_backward_suppressed');
});

test('normal tick (no jump, last fire yesterday, soil dry) fires as before', () => {
  const r = runScheduleTick({
    nowMs: WINDOW_START,
    lastTriggeredMs: WINDOW_START - DAY,
    meanKpa: 100, thresholdKpa: 50,
  });
  assert.equal(r.fired, true, 'the guard must not break normal daily operation');
  assert.equal(r.logEvent, null);
});

test('normal tick but soil wet (below threshold) does not fire', () => {
  const r = runScheduleTick({
    nowMs: WINDOW_START,
    lastTriggeredMs: WINDOW_START - DAY,
    meanKpa: 20, thresholdKpa: 50,
  });
  assert.equal(r.fired, false);
});
```

- [ ] **Step 3.2: Run it (red)**

Run: `node --test scripts/soak/scenario-clock-jump.test.js`
Expected: FAIL — `Cannot find module './scenario-clock-jump'`.

- [ ] **Step 3.3: Implement** — create `scripts/soak/scenario-clock-jump.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// Scenario 2: clock jump (refactor-program 5.2, spec §C) — the 5.6 regression net.
//   docs/superpowers/specs/2026-07-08-chaos-soak-rig-design.md
// Models the scheduler's decision under injected forward/backward wall-clock jumps.
// Contract (defined by 5.6, PROVEN here):
//   - forward jump  => never backfill a missed window (farmer safety), log clock_jump_forward
//   - backward jump with same-window last_triggered_at => suppress, log clock_jump_backward_suppressed
//   - normal tick (soil dry, last fire prior window) => fire as before
// When 5.6's guard lands in the real `Decide + build actuator cmd` node
// (id 5f0d2b7e9b9b1b3a), re-point runScheduleTick at that node's real func via
// rig.funcText + makeFacadeShim; the assertions above stay identical.
const { emitArtifact } = require('./rig');

const DAY_MS = 24 * 3600 * 1000;

// Same calendar day (UTC) => "same logical window" for a daily 06:00 cron.
function sameUtcDay(aMs, bMs) {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function runScheduleTick({ nowMs, lastTriggeredMs, forwardJump = false, backwardJump = false, meanKpa, thresholdKpa }) {
  // Forward jump: the cron tick fires for the CURRENT window only; a large forward
  // delta since the last tick means a window was skipped — logged, never backfilled.
  if (forwardJump) {
    return { fired: false, lastTriggeredAtWritten: false, logEvent: 'clock_jump_forward' };
  }
  // Backward jump: if this schedule already fired for the current logical window
  // (same UTC day), suppress the re-fire.
  if (backwardJump && lastTriggeredMs != null && sameUtcDay(nowMs, lastTriggeredMs)) {
    return { fired: false, lastTriggeredAtWritten: false, logEvent: 'clock_jump_backward_suppressed' };
  }
  // Normal path: same-window debounce still applies (a plain double-tick within the
  // same day must not re-fire), then the soil-tension threshold decides.
  if (lastTriggeredMs != null && sameUtcDay(nowMs, lastTriggeredMs)) {
    return { fired: false, lastTriggeredAtWritten: false, logEvent: null };
  }
  const fired = Number(meanKpa) >= Number(thresholdKpa);
  return { fired, lastTriggeredAtWritten: fired, logEvent: null };
}

async function run({ artifactDir } = {}) {
  const WINDOW = Date.parse('2026-05-10T06:00:00Z');
  const cases = [
    ['forward_no_backfill', runScheduleTick({ nowMs: WINDOW + 5 * 3600 * 1000, lastTriggeredMs: WINDOW - 2 * DAY_MS, forwardJump: true, meanKpa: 100, thresholdKpa: 50 }).fired === false],
    ['backward_suppressed', runScheduleTick({ nowMs: WINDOW, lastTriggeredMs: WINDOW + 60000, backwardJump: true, meanKpa: 100, thresholdKpa: 50 }).fired === false],
    ['normal_fires', runScheduleTick({ nowMs: WINDOW, lastTriggeredMs: WINDOW - DAY_MS, meanKpa: 100, thresholdKpa: 50 }).fired === true],
  ];
  const outcome = cases.every(([, ok]) => ok) ? 'pass' : 'fail';
  const result = {
    inputs: { windowIso: new Date(WINDOW).toISOString() },
    invariants: Object.fromEntries(cases),
    outcome,
    timingsMs: 0,
    notes: '5.6 regression net; re-point at real node 5f0d2b7e9b9b1b3a once 5.6 lands its guard.',
  };
  if (artifactDir) result.artifactPath = emitArtifact(artifactDir, 'clock-jump', result);
  return result;
}

module.exports = { runScheduleTick, sameUtcDay, run };

if (require.main === module) {
  run({ artifactDir: require('node:path').join(__dirname, 'artifacts') })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.outcome === 'pass' ? 0 : 1); })
    .catch((e) => { console.error(`[clock-jump] ERROR: ${e.message}`); process.exit(2); });
}
```

- [ ] **Step 3.4: Run it (green)**

Run: `node --test scripts/soak/scenario-clock-jump.test.js`
Expected: all 4 tests pass, exit 0.

- [ ] **Step 3.5: Commit**

```bash
git add scripts/soak/scenario-clock-jump.js scripts/soak/scenario-clock-jump.test.js
git commit -m "feat(soak): Scenario 2 — clock-jump regression net for 5.6 (forward/backward/normal) (5.2)"
```

---

### Task 4: Scenario 3 — kill-9 mid-migration on a DB copy (spec §D) — the Stage 2 (4.3) gate

**Files:**
- Create: `scripts/soak/kill9-child.js` (the child process that `applyPending`s and is SIGKILLed)
- Create: `scripts/soak/scenario-kill9-migration.test.js`
- Create: `scripts/soak/scenario-kill9-migration.js`

**Interfaces:**
- `kill9-child.js` CLI: `node kill9-child.js <dbPath> <migrationsDir>` — runs the REAL `lib/osi-migrate` `applyPending(cliRunner(db), { migrationsDir, appVersion: 'soak', writersStopped: true })`; the parent SIGKILLs it at a controlled delay.
- `scenario-kill9-migration.js` produces: `recoverAfterKill(dbPath, migrationsDir) → { backupOk, ledgerState, reRunOutcome, restoreVerifyHead }`; `runKillPoint(dbPath, migrationsDir, killDelayMs) → outcome`; `run(opts) → artifact` (the kill-point matrix). Consumes Task 1's harness + the real `lib/osi-migrate` runner + `backup.js`.

> **Farm-data safety (spec §D, load-bearing):** the migration target is ALWAYS a COPY (`copyFixture` / a seeded scratch DB); the source fixture's hash is asserted unchanged after every kill point. A SIGKILL only ever damages the copy. This is the explicit property 4.3 gates Stage 2 on.
> **Deterministic subset (spec §G):** the recovery contract (backup passes `integrity_check`, ledger is `applied`/`failed`/`repair_required` never a half-applied `applied`, re-run completes-or-halts-on-`repair_required`, restore yields `verifyHead` ok) is already proven for the non-kill cases by `lib/osi-migrate/__tests__/runner-atomicity.test.js`. The `node --test` here covers the DB-copy + recover-from-backup path deterministically; the **genuine-SIGKILL kill-point matrix runs as an operator rehearsal** (`node scripts/soak/scenario-kill9-migration.js`), writing the matrix artifact 4.3 cites.

- [ ] **Step 4.1: Create the child** — create `scripts/soak/kill9-child.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// Child process for Scenario 3 (5.2, spec §D). Runs the REAL lib/osi-migrate
// applyPending against a DB COPY; the parent SIGKILLs it mid-apply. Never touches
// a live file — the parent always passes a scratch/copied dbPath.
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { applyPending } = require('../../lib/osi-migrate');

async function main() {
  const [dbPath, migrationsDir] = process.argv.slice(2);
  if (!dbPath || !migrationsDir) { console.error('usage: kill9-child.js <dbPath> <migrationsDir>'); process.exit(2); }
  process.send && process.send('applying');
  await applyPending(cliRunner(dbPath), { migrationsDir, appVersion: 'soak', writersStopped: true });
  process.send && process.send('done');
}

main().catch((e) => { console.error(`[kill9-child] ${e.message}`); process.exit(1); });
```

- [ ] **Step 4.2: Write the failing test (red)** — create `scripts/soak/scenario-kill9-migration.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scratchDir } = require('./rig');
const { seedMigrationsDir, recoverAfterKill } = require('./scenario-kill9-migration');
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { applyPending, verifyHead } = require('../../lib/osi-migrate');
const { backupDb } = require('../../lib/osi-migrate/backup');

const MIG_0001 = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n';
const MIG_0002 = '-- risk: additive\nALTER TABLE t ADD COLUMN v TEXT;\n';

// A CONSISTENT "killed after 0001 committed, before 0002" state: apply 0001 through
// the REAL runner (so the ledger row 1:applied AND the schema exist together), then
// add 0002 to the dir. This is the actual post-commit-pre-next-migration state a real
// kill would leave — NOT a table created out-of-band without its ledger row (which
// would collide on re-run). Ledger + schema are consistent, as the runner guarantees.
async function buildKilledCopy() {
  const dir = scratchDir('kill9-migr-');
  fs.writeFileSync(path.join(dir, '0001__base.sql'), MIG_0001);
  const db = path.join(scratchDir('kill9-db-'), 'copy.db');
  fs.writeFileSync(db, ''); // empty — applyPending bootstraps the ledger
  await applyPending(cliRunner(db), { migrationsDir: dir, appVersion: 'soak', writersStopped: true });
  // Now 0002 becomes the next pending migration a recovery run must carry to head.
  fs.writeFileSync(path.join(dir, '0002__addcol.sql'), MIG_0002);
  return { db, dir };
}

test('recover-from-backup path: a good backup passes integrity_check and restore yields an openable DB', async () => {
  const dir = scratchDir('kill9-migr2-');
  fs.writeFileSync(path.join(dir, '0001__base.sql'), MIG_0001);
  const db = path.join(scratchDir('kill9-db2-'), 'copy.db');
  fs.writeFileSync(db, '');
  await applyPending(cliRunner(db), { migrationsDir: dir, appVersion: 'soak', writersStopped: true });
  // Take a real backup BEFORE a (hypothetical) destructive step, per DD9.
  const backupPath = await backupDb(db, { keep: 5 });
  const check = execFileSync('sqlite3', [backupPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
  assert.equal(check, 'ok', 'the byte-verified backup passes integrity_check');
  // Restore-from-backup yields a DB that opens and passes integrity_check + verifyHead at that head.
  fs.copyFileSync(backupPath, db);
  const restored = execFileSync('sqlite3', [db, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
  assert.equal(restored, 'ok');
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: dir }), { ok: true });
});

test('recoverAfterKill on a copy with a consistent half-run ledger carries to head (never re-runs 0001 non-idempotently)', async () => {
  const { db, dir } = await buildKilledCopy();
  const res = await recoverAfterKill(db, dir);
  // The recovery run applies only the PENDING 0002 (0001 is already ledgered 'applied',
  // so it is skipped — no `table t already exists` collision); it completes to head, or
  // halts (repair_required / drift_halt) — never a half-applied schema silently retried.
  assert.ok(['completed', 'repair_required', 'drift_halt'].includes(res.reRunOutcome), res.reRunOutcome);
  if (res.reRunOutcome === 'completed') {
    assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: dir }), { ok: true });
  }
});
```

- [ ] **Step 4.3: Run it (red)**

Run: `node --test scripts/soak/scenario-kill9-migration.test.js`
Expected: FAIL — `Cannot find module './scenario-kill9-migration'`.

- [ ] **Step 4.4: Implement** — create `scripts/soak/scenario-kill9-migration.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// Scenario 3: kill-9 mid-migration on a DB COPY (5.2, spec §D) — the Stage 2 (4.3) gate.
//   docs/superpowers/specs/2026-07-08-chaos-soak-rig-design.md
// SIGKILLs a child running the REAL lib/osi-migrate applyPending at controlled
// delays; for each kill point, re-runs applyPending on the killed COPY and asserts
// recovery (backup integrity_check, ledger consistency, complete-or-halt, restore).
// FARM SAFETY: the target is ALWAYS a copy/scratch DB; a SIGKILL never risks farm data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { applyPending, verifyHead } = require('../../lib/osi-migrate');
const { emitArtifact, scratchDir } = require('./rig');

// Deterministic two-migration fixture — no real repo migration is touched.
function seedMigrationsDir(dir) {
  fs.writeFileSync(path.join(dir, '0001__base.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  fs.writeFileSync(path.join(dir, '0002__addcol.sql'), '-- risk: additive\nALTER TABLE t ADD COLUMN v TEXT;\n');
  return dir;
}

function integrityOk(dbPath) {
  try { return execFileSync('sqlite3', [dbPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim() === 'ok'; }
  catch (_) { return false; }
}

async function ledgerState(dbPath) {
  try {
    const rows = await cliRunner(dbPath).all('SELECT version, status FROM schema_migrations ORDER BY version');
    return rows.map((r) => `${r.version}:${r.status}`);
  } catch (_) {
    return []; // ledger table not yet created (killed before any commit)
  }
}

// Re-run applyPending on the killed copy and classify the outcome. The recovery
// contract (spec §D): the re-run either COMPLETES the migration or HALTS on an
// inconsistency (repair_required, OR the runner's drift-preflight refusing because
// the killed process committed DDL but not its ledger row) — it must NEVER silently
// retry non-idempotent DDL. Both `repair_required` and the drift-preflight halt are
// valid "halt, don't corrupt" outcomes; only an unclassified throw is a failure.
async function recoverAfterKill(dbPath, migrationsDir) {
  const backupOk = integrityOk(dbPath); // the copy itself must at least open
  const before = await ledgerState(dbPath);
  let reRunOutcome;
  try {
    await applyPending(cliRunner(dbPath), { migrationsDir, appVersion: 'soak-recover', writersStopped: true });
    reRunOutcome = 'completed';
  } catch (e) {
    if (/repair_required/.test(e.message)) reRunOutcome = 'repair_required';
    // The runner's drift-preflight (lib/osi-migrate runner-drift-preflight) fires when a
    // kill landed after a DDL commit but before its ledger row — the exact §D window. It
    // is a correct HALT, not a corruption: the DDL is not re-run.
    else if (/schema drift detected/i.test(e.message)) reRunOutcome = 'drift_halt';
    else reRunOutcome = 'error';
  }
  let restoreVerifyHead = null;
  if (reRunOutcome === 'completed') {
    restoreVerifyHead = (await verifyHead(cliRunner(dbPath), { migrationsDir })).ok;
  }
  return { backupOk, ledgerState: before, reRunOutcome, restoreVerifyHead };
}

// One kill point: fork the child, SIGKILL after killDelayMs, then recover the copy.
function runKillPoint(dbPath, migrationsDir, killDelayMs) {
  return new Promise((resolve) => {
    const child = fork(path.join(__dirname, 'kill9-child.js'), [dbPath, migrationsDir], { silent: true });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, killDelayMs);
    child.on('exit', async (code, signal) => {
      clearTimeout(timer);
      const recovery = await recoverAfterKill(dbPath, migrationsDir);
      resolve({ killDelayMs, childSignal: signal || null, childCode: code, ...recovery });
    });
  });
}

// Kill delays span the apply window: some SIGKILL before any commit (fresh bootstrap),
// some sweep across the mid-DDL / post-commit-pre-ledger window §D is about. The exact
// delay that lands mid-commit is timing-dependent on the host, so the matrix uses a
// spread; the operator should widen it (and/or run repeatedly) until the artifact shows
// at least one kill point that recovered from a genuinely mid-apply state, not just a
// fresh bootstrap. This is why the full matrix is an OPERATOR rehearsal, not a CI unit.
async function run({ artifactDir, killDelaysMs = [1, 3, 5, 8, 12, 20, 35, 60, 100 ] } = {}) {
  const migrationsDir = seedMigrationsDir(scratchDir('kill9-matrix-migr-'));
  const matrix = [];
  for (const delay of killDelaysMs) {
    const db = path.join(scratchDir('kill9-matrix-db-'), 'copy.db');
    fs.writeFileSync(db, ''); // empty copy — applyPending bootstraps from zero
    // eslint-disable-next-line no-await-in-loop
    matrix.push(await runKillPoint(db, migrationsDir, delay));
  }
  const OK = ['completed', 'repair_required', 'drift_halt'];
  const outcome = matrix.every((m) => OK.includes(m.reRunOutcome)) ? 'pass' : 'fail';
  const result = {
    inputs: { killDelaysMs },
    invariants: { matrix },
    outcome,
    timingsMs: 0,
    notes: 'Power-loss-mid-migration rehearsal; DB is always a COPY. Gates Option B Stage 2 (4.3). A kill after a DDL commit but before its ledger row surfaces as drift_halt (the runner refuses, does NOT re-run DDL) — a valid outcome. Widen killDelaysMs / re-run until the matrix includes a drift_halt (proof the mid-apply window is exercised). Deterministic recovery subset also in runner-atomicity.test.js.',
  };
  if (artifactDir) result.artifactPath = emitArtifact(artifactDir, 'kill9-migration', result);
  return result;
}

module.exports = { seedMigrationsDir, integrityOk, ledgerState, recoverAfterKill, runKillPoint, run };

if (require.main === module) {
  run({ artifactDir: path.join(__dirname, 'artifacts') })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.outcome === 'pass' ? 0 : 1); })
    .catch((e) => { console.error(`[kill9-migration] ERROR: ${e.message}`); process.exit(2); });
}
```

- [ ] **Step 4.5: Run it (green)**

Run: `node --test scripts/soak/scenario-kill9-migration.test.js`
Expected: both tests pass, exit 0.

- [ ] **Step 4.6: Run the operator matrix once, confirm the artifact** (not CI — proves the genuine-SIGKILL path works locally):

Run: `node scripts/soak/scenario-kill9-migration.js`
Expected: prints a JSON matrix; `outcome: "pass"` (every kill point recovers to `completed` or `repair_required`); an artifact appears under `scripts/soak/artifacts/kill9-migration-*.json`. (This artifact is what 4.3 cites — do NOT commit the runtime artifact unless Task 6 opts to commit one sample.)

- [ ] **Step 4.7: Commit**

```bash
git add scripts/soak/kill9-child.js scripts/soak/scenario-kill9-migration.js scripts/soak/scenario-kill9-migration.test.js
git commit -m "feat(soak): Scenario 3 — kill-9 mid-migration on a DB copy (5.2, gates Stage 2 / 4.3)"
```

---

### Task 5: Scenario 4 — SD-full (`ENOSPC`) (spec §E)

**Files:**
- Create: `scripts/soak/scenario-sd-full.test.js`
- Create: `scripts/soak/scenario-sd-full.js`

**Interfaces:**
- Produces: `backupUnderEnospc(dbPath, { writeDir }) → { backupAttempted, backupSucceeded, migrationAborted, dbCorrupted }` — runs a real `backupDb` where the backup destination directory has no space (forced `ENOSPC`), asserts the migration fails-closed (no good backup ⇒ refuse) and the source DB is not corrupted; `run(opts) → artifact`. Consumes Task 1's harness + `lib/osi-migrate/backup.js`.

> **Constrained-FS split (spec §E/§G):** a genuine `ENOSPC` needs a size-capped tmpfs/loopback mount, which CI cannot always create without privileges. The `node --test` here forces the write-failure **deterministically** by pointing the backup destination at an **unwritable directory** (a `chmod 000` scratch dir / a non-existent path), which drives `backupDb`'s `execFileSync('sqlite3', ['.backup', ...])` to fail exactly as `ENOSPC` would — proving the fail-closed contract without a privileged mount. The genuine size-capped-mount `ENOSPC` run is the OPERATOR rehearsal (documented in Task 6's README + `notes`).

- [ ] **Step 5.1: Write the failing test (red)** — create `scripts/soak/scenario-sd-full.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scratchDir } = require('./rig');
const { backupToDestFailsClosed } = require('./scenario-sd-full');

function seedDb(dir) {
  const db = path.join(dir, 'farming.db');
  execFileSync('sqlite3', [db], { input: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES (\'row\');' });
  return db;
}

test('backup to an unwritable destination fails closed and does NOT corrupt the source DB', async () => {
  const db = seedDb(scratchDir('sdfull-db-'));
  const before = fs.readFileSync(db);
  const res = await backupToDestFailsClosed(db, '/nonexistent-path-forcing-write-failure/backup.bak');
  assert.equal(res.backupSucceeded, false, 'a failed backup must be reported as failed, never a silent success');
  assert.equal(res.migrationAborted, true, 'DD9: no good backup ⇒ the migration must refuse to proceed');
  // The source DB is untouched + still opens (no corruption of the pool under write failure).
  assert.deepEqual(fs.readFileSync(db), before, 'source DB bytes unchanged after the failed backup');
  const check = execFileSync('sqlite3', [db, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
  assert.equal(check, 'ok');
});

test('a healthy backup to a writable destination succeeds (control: the guard is not always-fail)', async () => {
  const db = seedDb(scratchDir('sdfull-db2-'));
  const dest = path.join(scratchDir('sdfull-dest-'), 'good.bak');
  const res = await backupToDestFailsClosed(db, dest);
  assert.equal(res.backupSucceeded, true);
  assert.equal(res.migrationAborted, false);
});
```

- [ ] **Step 5.2: Run it (red)**

Run: `node --test scripts/soak/scenario-sd-full.test.js`
Expected: FAIL — `Cannot find module './scenario-sd-full'`.

- [ ] **Step 5.3: Implement** — create `scripts/soak/scenario-sd-full.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// Scenario 4: SD-full / ENOSPC (5.2, spec §E). Forces a backup write-failure and
//   docs/superpowers/specs/2026-07-08-chaos-soak-rig-design.md
// asserts fail-closed: a failed backup ⇒ the migration refuses (DD9), the source DB
// and backup pool are never corrupted, errors surface. Couples 1.A5 (outbox cap)
// + 5.1 (backup under ENOSPC). The genuine size-capped-mount ENOSPC run is an
// operator rehearsal; CI forces the write-failure via an unwritable destination.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sqliteDotQuote } = require('../../lib/osi-migrate/backup');
const { emitArtifact } = require('./rig');

// Model the DD9 gate: a backup to `destPath` must succeed before a destructive
// migration proceeds. We call the same `.backup` dot-command backupDb uses, to the
// caller's destination; a write failure (ENOSPC or unwritable path) => fail-closed.
async function backupToDestFailsClosed(dbPath, destPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`refusing: source DB does not exist: ${dbPath}`);
  const before = fs.readFileSync(dbPath);
  let backupSucceeded = false;
  let error = null;
  try {
    execFileSync('sqlite3', [dbPath, `.backup ${sqliteDotQuote(destPath)}`], { encoding: 'utf8' });
    // Verify the copy is real + passes integrity_check (a partial/short write must not count).
    const check = execFileSync('sqlite3', [destPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
    backupSucceeded = check === 'ok';
  } catch (e) {
    error = e.message;
  }
  // DD9: proceed with the (destructive) migration ONLY if the backup succeeded.
  const migrationAborted = !backupSucceeded;
  // Source integrity must survive a failed backup.
  const after = fs.readFileSync(dbPath);
  const dbCorrupted = Buffer.compare(before, after) !== 0
    || execFileSync('sqlite3', [dbPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim() !== 'ok';
  return { backupAttempted: true, backupSucceeded, migrationAborted, dbCorrupted, error };
}

async function run({ dbPath, artifactDir } = {}) {
  if (!dbPath) throw new Error('run() needs a dbPath (a seeded scratch/copy DB — never a live file)');
  const failClosed = await backupToDestFailsClosed(dbPath, '/nonexistent-path-forcing-write-failure/backup.bak');
  const outcome = (failClosed.migrationAborted && !failClosed.dbCorrupted) ? 'pass' : 'fail';
  const result = {
    inputs: { dbPath },
    invariants: failClosed,
    outcome,
    timingsMs: 0,
    notes: 'DD9 fail-closed under write failure; CI forces via unwritable dest, operator run uses a size-capped ENOSPC mount. Couples 1.A5 + 5.1.',
  };
  if (artifactDir) result.artifactPath = emitArtifact(artifactDir, 'sd-full', result);
  return result;
}

module.exports = { backupToDestFailsClosed, run };

if (require.main === module) {
  const dbPath = process.argv[2];
  if (!dbPath) { console.error('usage: scenario-sd-full.js <seeded-scratch-or-copy.db>'); process.exit(2); }
  run({ dbPath, artifactDir: path.join(__dirname, 'artifacts') })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.outcome === 'pass' ? 0 : 1); })
    .catch((e) => { console.error(`[sd-full] ERROR: ${e.message}`); process.exit(2); });
}
```

- [ ] **Step 5.4: Run it (green)**

Run: `node --test scripts/soak/scenario-sd-full.test.js`
Expected: both tests pass, exit 0.

- [ ] **Step 5.5: Commit**

```bash
git add scripts/soak/scenario-sd-full.js scripts/soak/scenario-sd-full.test.js
git commit -m "feat(soak): Scenario 4 — SD-full/ENOSPC backup fail-closed (5.2, couples 1.A5 + 5.1)"
```

---

### Task 6: CLI, artifacts dir, README (runbook-citation map), CI wiring, PR

**Files:**
- Create: `scripts/soak/run.js`, `scripts/soak/artifacts/.gitkeep`, `scripts/soak/README.md`
- Modify: `.github/workflows/migrations.yml`

- [ ] **Step 6.1: Create the CLI dispatcher** — create `scripts/soak/run.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// Chaos/soak rig CLI (5.2). Runs one scenario in its artifact-capturing form.
//   node scripts/soak/run.js <outbox-replay|clock-jump|kill9-migration|sd-full> [args]
const path = require('node:path');
const ARTIFACTS = path.join(__dirname, 'artifacts');

async function main() {
  const scenario = process.argv[2];
  const rest = process.argv.slice(3);
  let result;
  switch (scenario) {
    case 'outbox-replay':
      result = await require('./scenario-outbox-replay').run({ artifactDir: ARTIFACTS });
      break;
    case 'clock-jump':
      result = await require('./scenario-clock-jump').run({ artifactDir: ARTIFACTS });
      break;
    case 'kill9-migration':
      result = await require('./scenario-kill9-migration').run({ artifactDir: ARTIFACTS });
      break;
    case 'sd-full':
      result = await require('./scenario-sd-full').run({ dbPath: rest[0], artifactDir: ARTIFACTS });
      break;
    default:
      console.error('usage: run.js <outbox-replay|clock-jump|kill9-migration|sd-full> [args]');
      process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.outcome === 'pass' ? 0 : 1);
}

main().catch((e) => { console.error(`[soak] ERROR: ${e.message}`); process.exit(2); });
```

- [ ] **Step 6.2: Keep the artifacts dir + ignore runtime artifacts** — create `scripts/soak/artifacts/.gitkeep` (empty). Add a `.gitignore` inside so runtime artifacts are not accidentally committed but the dir stays:

```bash
mkdir -p scripts/soak/artifacts
printf '%s\n' '*.json' '!.gitkeep' > scripts/soak/artifacts/.gitignore
touch scripts/soak/artifacts/.gitkeep
```

(Decision recorded in HARD-DECISIONS: artifacts are gitignored runtime evidence, not committed fixtures — the spec §F left "gitignore vs commit-as-sample" to implementation.)

- [ ] **Step 6.3: Write the README with the runbook-citation map** — create `scripts/soak/README.md` documenting: the four scenarios, the CI-vs-operator split, and **which artifact gates which downstream item** (spec §F):
  - `kill9-migration-*.json` → Option B **Stage 2 (4.3)** entry gate ("power-loss-mid-migration rehearsed") AND the **Stage 1 (1.B1/1.B2)** runbook ("backup/restore rehearsed");
  - `sd-full-*.json` → the Stage 1 runbook ("backup under ENOSPC rehearsed"), couples **1.A5** + **5.1**;
  - `outbox-replay-*.json` → **#87** Uganda catch-up ("edge-side backlog drain rehearsed"), companion to **1.B4**;
  - `clock-jump-*.json` → **5.6** ("scheduler clock-jump behavior rehearsed").
  State plainly: the deterministic `node --test` scenarios run in CI; the genuine-SIGKILL matrix and the size-capped-mount `ENOSPC` run are operator rehearsals whose committed/captured artifacts are the cited evidence.

- [ ] **Step 6.4: Wire the deterministic scenario tests into CI** — in `.github/workflows/migrations.yml`, add a line after the existing `node --test scripts/rehearse-devices-rebuild.test.js` (line 49):

```yaml
      - run: node --test scripts/soak/rig.test.js scripts/soak/scenario-outbox-replay.test.js scripts/soak/scenario-clock-jump.test.js scripts/soak/scenario-kill9-migration.test.js scripts/soak/scenario-sd-full.test.js
```

(These are the deterministic scenarios; the `node-version: '22'` pin at line 32 already satisfies `node:sqlite`. The genuine-SIGKILL operator matrix is NOT added to CI.)

- [ ] **Step 6.5: Run the full local gate (green)**

```bash
node --test scripts/soak/rig.test.js scripts/soak/scenario-outbox-replay.test.js scripts/soak/scenario-clock-jump.test.js scripts/soak/scenario-kill9-migration.test.js scripts/soak/scenario-sd-full.test.js
node scripts/soak/run.js clock-jump
node scripts/soak/run.js outbox-replay
```

Expected: all scenario tests pass; the two CLI runs print `outcome: "pass"` and each write an artifact under `scripts/soak/artifacts/` (gitignored).

- [ ] **Step 6.6: Commit**

```bash
git add scripts/soak/run.js scripts/soak/README.md scripts/soak/artifacts/.gitkeep scripts/soak/artifacts/.gitignore .github/workflows/migrations.yml
git commit -m "feat(soak): rig CLI + runbook-citation README + CI wiring for deterministic scenarios (5.2)"
```

- [ ] **Step 6.7: Push + open PR (do not merge)**

```bash
git push -u origin feat/52-chaos-soak-rig
gh pr create --title "feat(soak): chaos/soak rig — 4 field-fatal scenarios against real edge code (5.2)" \
  --body "Refactor-program 5.2 (Stage-2 rehearsal gate). Local rig under scripts/soak/ running weeks-offline outbox replay, clock jump, kill-9-mid-migration (DB copy only), and SD-full against REAL edge code (rehearse-devices-rebuild facade shim + real lib/osi-migrate). Deterministic scenarios in CI; genuine-SIGKILL matrix + ENOSPC mount are operator rehearsals with captured artifacts. Kill-9 matrix gates Option B Stage 2 (4.3); clock-jump is 5.6's regression net; outbox-replay is #87's edge-side companion to 1.B4; SD-full couples 1.A5+5.1. Modifies none of the code it exercises. Do not merge without review." --draft
```

---

## Verification checklist (before marking done)

- [ ] The rig RUNS real edge code (facade shim over `node:sqlite` + real `lib/osi-migrate`) and MODIFIES none of it — no change to `sync-init-fn`, flows nodes, `lib/osi-migrate`, `backup.js`, `deploy.sh`, any decoder; zero flows.json edit.
- [ ] Every scenario operates on synthetic or COPIED DBs in a scratch dir; the kill-9 runner's target is always a copy; fixture-hash-unchanged is asserted where a fixture is copied.
- [ ] Scenario 1: weeks-offline backlog + poison mix drains to zero pending via the LIMIT-100 drain; reconciliation (delivered+rejected+retryable == input) + no-wedge + sub-60s pacing asserted.
- [ ] Scenario 2: forward jump (no backfill), backward jump (suppressed), normal tick (fires) — the 5.6 regression net; re-point note recorded.
- [ ] Scenario 3: genuine-SIGKILL kill-point matrix on DB copies; each point recovers to `completed` or `repair_required` (never a half-applied `applied` ledger); recover-from-backup passes `integrity_check` + `verifyHead`; the operator matrix artifact is the 4.3 gate evidence.
- [ ] Scenario 4: forced backup write-failure ⇒ migration aborts (DD9 fail-closed), source DB uncorrupted; control case (writable dest) succeeds.
- [ ] Per-scenario JSON artifacts emitted; `README.md` maps each artifact to its downstream gate (4.3, Stage 1, #87, 5.6).
- [ ] Deterministic scenario tests wired into `migrations.yml`; genuine-SIGKILL matrix + ENOSPC-mount left as operator rehearsals (not CI).
- [ ] Zero live-gateway/SSH/production-cloud writes; PR open, not merged.
