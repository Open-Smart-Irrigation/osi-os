# Rollup Hardening & History Data-Path Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the `osi-history-helper` rollup path (invariant guard, merged-scope tests, honest coverage for in-progress windows), expose the data-path `source` field on the card-data API, and draft the two pending decisions (per-source rollup keys, 1.A3 dual-suite residue) — all **before** refactor item 4.2 captures its golden vectors.

**Architecture:** All code changes live in `osi-history-helper/index.js` (both profile mirrors) plus one small edit to the History API Router function node in `flows.json` (both mirrors) and a one-line GUI type. Tests append to `scripts/test-history-helper.js` — today's canonical, CI-wired rollup suite (see Task 5's 1.A3 adjudication draft for where they eventually live).

**Tech Stack:** Plain Node (node:test/assert harness in `scripts/test-history-helper.js` with a `node:sqlite` fixture seeded from `database/seed-blank.sql`), Node-RED function-node JS embedded in `flows.json`.

**Origin:** 2026-07-11 rollup analysis (follow-up to the mobile history review). Verified facts this plan builds on: merged cards write ONE combined-aggregate row per bucket/channel under a single `logical_source_key`; the read path binds exactly one key; the overwrite scenario does not occur today but is an unguarded invariant; rollup write/read paths are tested only with single-device scopes; coverage denominators include future time.

## Global Constraints

- **Sequencing (hard):** every task here must land **before refactor item 4.2 (Extract History API Router) captures its pre-extraction golden vectors** — Tasks 3 and 4 change API response content/shape, and DD4 vectors captured earlier would enshrine the old behavior. Do not run this plan in parallel with 4.2 or with any other work touching `osi-history-helper` or `history-api-router-fn`.
- **Coordination with the mobile fix plan** (`docs/superpowers/plans/2026-07-11-mobile-history-review-fixes.md`): its Task 5 adds an interpretation-layer coverage rescale. This plan's Task 3 supersedes that rescale with an aggregation-layer clamp and removes it again. Default assumption: mobile Task 5 lands first (it ships with user-facing fixes). If the orchestrator schedules THIS plan first instead, execute Task 3's "alternative entry state" step and strike the rescale from mobile Task 5 before it runs.
- Any edit to `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/...` **must be mirrored** to `conf/full_raspberrypi_bcm2709/files/usr/share/...`, then `node scripts/verify-profile-parity.js` (22 checks) must pass.
- Before editing `flows.json` (Task 4), load the `osi-flows-json-editing` skill. After flows edits run `node scripts/verify-sync-flow.js`.
- Helper test suite: `node scripts/test-history-helper.js` (CI: `migrations.yml:56`). Co-located suite: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js` (CI: `migrations.yml:74`). Both must stay green.
- Branch: `git checkout -b fix/rollup-hardening` off the checkout the orchestrator designates (helper is byte-identical on `main` and `feat/refactor-and-forge-handoff` as of 2026-07-11, so either base works).
- Commit after every task.

---

### Task 1: Invariant guard + contract documentation for `rollupRowsToResult`

The function keys `bucket.series` by `channel_id` only; feed it rows spanning two `logical_source_key`s and it silently drops all but the last source's stats while still summing their `sample_count`s. Correct today only because its single caller binds one key in SQL. Make the invariant explicit and loud.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js:1135` (function) and `:2583` (exports)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js` (identical)
- Test: `scripts/test-history-helper.js` (append)

**Interfaces:**
- Produces: `rollupRowsToResult(rows, query, channels)` added to `module.exports` (39th export); throws `Error(/single logical_source_key/)` on multi-key input.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-history-helper.js` (before the final success log, matching the file's `test('…', …)` style):

```js
test('rollupRowsToResult rejects rows spanning multiple logical source keys', () => {
  const row = (key, mean) => ({
    bucket_start: '2026-07-01T00:00:00.000Z',
    bucket_end: '2026-07-02T00:00:00.000Z',
    logical_source_key: key,
    channel_id: 'swt_1',
    min_value: mean, max_value: mean, mean_value: mean, median_value: mean, latest_value: mean,
    dominant_status: null, sample_count: 4, event_count: 0, threshold_crossing_count: 0,
    coverage_pct: 100, coverage_confidence: 'configured', unit: 'kPa',
  });
  assert.throws(
    () => helper.rollupRowsToResult(
      [row('root-zone', 10), row('src-aa01', 30)],
      { aggregation: 'daily' },
      [{ id: 'swt_1', field: 'swt_1', fields: ['swt_1'], unit: 'kPa' }],
    ),
    /single logical_source_key/,
  );
});

test('rollupRowsToResult builds buckets from single-key rows', () => {
  const rows = [{
    bucket_start: '2026-07-01T00:00:00.000Z',
    bucket_end: '2026-07-02T00:00:00.000Z',
    logical_source_key: 'root-zone',
    channel_id: 'swt_1',
    min_value: 5, max_value: 15, mean_value: 10, median_value: 10, latest_value: 15,
    dominant_status: null, sample_count: 4, event_count: 0, threshold_crossing_count: 0,
    coverage_pct: 100, coverage_confidence: 'configured', unit: 'kPa',
  }];
  const result = helper.rollupRowsToResult(rows, { aggregation: 'daily' }, [{ id: 'swt_1', field: 'swt_1', fields: ['swt_1'], unit: 'kPa' }]);
  assert.strictEqual(result.buckets.length, 1);
  assert.strictEqual(result.buckets[0].series.swt_1.mean, 10);
  assert.strictEqual(result.buckets[0].sampleCount, 4);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node scripts/test-history-helper.js`
Expected: FAIL — `helper.rollupRowsToResult is not a function` (not exported).

- [ ] **Step 3: Implement guard, contract docs, export (bcm2712)**

Above `function rollupRowsToResult(...)` add the contract, and the guard as its first statement:

```js
/**
 * Builds an aggregate result from history_channel_rollups rows.
 *
 * CONTRACT (verified live on kaba100, 2026-07-11):
 * - Input rows MUST all belong to ONE logical_source_key. Merged cards
 *   (soil='root-zone', environment='microclimate') store ONE combined-
 *   aggregate row per bucket/channel — computeRollupBuckets aggregates the
 *   UNION of the card's devices before upserting. Per-source detail exists
 *   only in raw device_data and the CSV export path.
 * - bucket.series is keyed by channel_id only; multi-key input would
 *   silently drop data, hence the guard below. A future per-source rollup
 *   scheme must extend this keying (see refactor-program open decisions).
 * - bucket.sampleCount sums sample_count ACROSS CHANNELS (same semantics
 *   as the live aggregateRows path).
 */
function rollupRowsToResult(rows, query, channels) {
  const sourceKeys = new Set((rows || [])
    .map((row) => row.logical_source_key)
    .filter((value) => value !== undefined && value !== null));
  if (sourceKeys.size > 1) {
    throw new Error(`rollupRowsToResult requires rows from a single logical_source_key, got: ${Array.from(sourceKeys).sort().join(', ')}`);
  }
```

Add a matching one-line JSDoc to `computeRollupBuckets` (line 1051): `/** Aggregates the UNION of scope.deveuis into one combined row per bucket/channel under scope.logicalSourceKey. */`

Add `rollupRowsToResult,` to `module.exports` (after `computeRollupBuckets,`).

- [ ] **Step 4: Run tests**

Run: `node scripts/test-history-helper.js`
Expected: PASS, including both new tests and all pre-existing ones (the guard is a no-op for the existing single-key read path).

- [ ] **Step 5: Mirror to bcm2709 + parity**

Apply the identical edit to the bcm2709 `index.js`, then:
Run: `node scripts/verify-profile-parity.js` — expected: 22/22 pass.

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js scripts/test-history-helper.js
git commit -m "fix(history-api): guard + document rollupRowsToResult single-source-key invariant"
```

---

### Task 2: Multi-device merged-scope golden tests

Every existing rollup test uses a single-device scope. The union-merge semantics that make merged cards correct (verified live: 2026-07-09 env bucket = union mean of Temp1+Dendro1, sample_count 72+72) are untested. Pin them.

**Files:**
- Test: `scripts/test-history-helper.js` (append)

**Interfaces:**
- Consumes: `helper.computeRollupBuckets(db, scope, level, windowMs, nowMs)` (existing export, tested at line ~818 — reuse that test's DB fixture pattern: `db.runSql` seeding users/zones/devices/device_data).

- [ ] **Step 1: Write the failing test**

Append (reuse the fixture-creation helper the `computeRollupBuckets returns completed buckets` test at line ~818 uses — same `db` setup/teardown shape):

```js
test('computeRollupBuckets merges a multi-device scope into ONE combined row per bucket/channel', async () => {
  const db = createFixtureDb(); // same helper the existing rollup tests use
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Z',1,'zu','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES
        ('AA00000000000001','Temp A','DRAGINO_LSN50',1,7,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z'),
        ('AA00000000000002','Temp B','DRAGINO_LSN50',1,7,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,ext_temperature_c) VALUES
        ('AA00000000000001','2026-06-01T08:10:00.000Z',10),
        ('AA00000000000002','2026-06-01T08:20:00.000Z',30),
        ('AA00000000000001','2026-06-01T08:40:00.000Z',20),
        ('AA00000000000002','2026-06-01T08:50:00.000Z',40);
    `);
    const scope = {
      zoneId: 7,
      cardType: 'environment',
      logicalSourceKey: 'microclimate',
      channels: [{ id: 'ext_temperature_c', field: 'ext_temperature_c', unit: 'C' }],
      deveuis: ['AA00000000000001', 'AA00000000000002'],
      timezone: 'UTC',
    };
    const rows = await helper.computeRollupBuckets(db, scope, 'hourly', 24 * 3600 * 1000, Date.parse('2026-06-02T00:00:00.000Z'));
    const hourRows = rows.filter((row) => row.channel_id === 'ext_temperature_c' && row.bucket_start === '2026-06-01T08:00:00.000Z');
    assert.strictEqual(hourRows.length, 1, 'exactly ONE combined row for the merged scope');
    assert.strictEqual(hourRows[0].logical_source_key, 'microclimate');
    assert.strictEqual(hourRows[0].mean_value, 25);   // union mean of (10,30,20,40)
    assert.strictEqual(hourRows[0].min_value, 10);    // union min (device A)
    assert.strictEqual(hourRows[0].max_value, 40);    // union max (device B)
    assert.strictEqual(hourRows[0].sample_count, 4);  // both devices' samples
  } finally {
    db.close();
  }
});
```

If the existing rollup tests inline their fixture creation rather than using a named helper, copy that inline pattern verbatim instead of `createFixtureDb()` — match the file, don't invent.

- [ ] **Step 2: Run to verify it fails or passes for the right reason**

Run: `node scripts/test-history-helper.js`
Expected: PASS immediately (this pins existing correct behavior — it is a regression net for the per-source refactor, not a bug fix). If it FAILS, stop: that would falsify the live-verified analysis; re-open the investigation before proceeding.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-history-helper.js
git commit -m "test(history-api): pin multi-device merged-scope rollup union semantics"
```

---

### Task 3: Clamp coverage denominators at `now` (aggregation layer) and simplify the interpretation rule

Coverage denominators currently include future time: a month-window calendar request reports ~35% coverage with perfect uptime, and today's in-progress daily bucket under-reports all day. Clamp expected time at `now` where coverage is computed, then remove the interpretation-layer rescale that mobile-plan Task 5 added as the interim fix (keeping only its fully-future-window skip and the `rangeFrom`/`rangeTo` plumbing).

**Entry state (default):** mobile-plan Task 5 has landed (helper has the rescale block + flows passes `rangeFrom`/`rangeTo`). **Alternative entry state:** if the orchestrator runs this plan first, apply Step 4's final interpretation code directly as part of mobile Task 5 (replacing its rescale block) and keep that plan's flows.json range plumbing step unchanged — then skip Step 4 here.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js` — `aggregateRows` bucket loop (~line 966-990) and `buildLocalInterpretations` (~line 2134)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js` (identical)
- Test: `scripts/test-history-helper.js`

**Interfaces:**
- Consumes: `toFiniteNumber`, `coverageForBucket`, `parseTime` (existing internals); `options.nowMs`/`query.nowMs` (already threaded through `aggregateDeviceData` → `aggregateRows` via `{ ...query }` spread).
- Produces: `aggregateRows` honors `options.nowMs` for coverage denominators; interpretation rule reduced to threshold + fully-future skip.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-history-helper.js`:

```js
test('aggregateRows clamps coverage denominators at now for in-progress windows', () => {
  const rows = [
    { deveui: 'AA00000000000001', recorded_at: '2026-07-11T00:10:00.000Z', ext_temperature_c: 20 },
    { deveui: 'AA00000000000001', recorded_at: '2026-07-11T05:50:00.000Z', ext_temperature_c: 22 },
  ];
  const result = helper.aggregateRows(rows, {
    aggregation: 'daily',
    channels: [{ id: 'ext_temperature_c', field: 'ext_temperature_c', unit: 'C' }],
    start: '2026-07-11T00:00:00.000Z',
    end: '2026-07-12T00:00:00.000Z',      // window extends 18h into the future
    timezone: 'UTC',
    nowMs: Date.parse('2026-07-11T06:00:00.000Z'),
    expectedCadences: { AA00000000000001: { seconds: 1200, confidence: 'configured' } },
  });
  // elapsed window = 6h = 18 expected samples at 20min cadence; 2 observed ≈ 11.1%
  // WITHOUT the clamp the denominator would be 24h = 72 expected ≈ 2.8%
  assert.ok(result.coveragePct > 10 && result.coveragePct < 12,
    `coverage must be computed over elapsed time only, got ${result.coveragePct}`);
  assert.strictEqual(result.buckets.length, 1);
  assert.ok(result.buckets[0].coveragePct > 10 && result.buckets[0].coveragePct < 12);
});

test('aggregateRows leaves completed-window coverage unchanged by the clamp', () => {
  const rows = [
    { deveui: 'AA00000000000001', recorded_at: '2026-07-10T00:10:00.000Z', ext_temperature_c: 20 },
  ];
  const result = helper.aggregateRows(rows, {
    aggregation: 'daily',
    channels: [{ id: 'ext_temperature_c', field: 'ext_temperature_c', unit: 'C' }],
    start: '2026-07-10T00:00:00.000Z',
    end: '2026-07-11T00:00:00.000Z',
    timezone: 'UTC',
    nowMs: Date.parse('2026-07-12T00:00:00.000Z'), // now is AFTER the window
    expectedCadences: { AA00000000000001: { seconds: 1200, confidence: 'configured' } },
  });
  // full 24h window = 72 expected samples, 1 observed ≈ 1.4% — same as before the clamp
  assert.ok(result.coveragePct < 2, `completed windows keep the full denominator, got ${result.coveragePct}`);
});
```

Check `aggregateRows`'s expected-cadence input shape against the existing tests in this file (`expectedCadences` map vs `sourceCadences` derivation) and match it; the assertions above are cadence-shape-agnostic beyond the 1200 s value.

- [ ] **Step 2: Run to verify failure**

Run: `node scripts/test-history-helper.js`
Expected: the in-progress test FAILS (coverage ≈ 2.8, not ≈ 11).

- [ ] **Step 3: Implement the clamp (bcm2712, then mirror)**

In `aggregateRows`, immediately after `const buckets = aggregationBuckets(...)` (~line 964), add:

```js
  const nowMs = toFiniteNumber(options.nowMs) ?? Date.now();
```

Replace the per-bucket coverage call (~line 981):

```js
    const coverage = coverageForBucket(bucketRows, channels, sourceCadences, (bucket.bucketEndMs - bucket.bucketStartMs) / 1000);
```

with:

```js
    // Coverage denominator counts only elapsed time: a bucket (or window)
    // that extends past `now` cannot be "missing" samples it could not
    // yet have received. Fully-future buckets get a zero denominator,
    // which coverageForBucket maps to coveragePct null.
    const elapsedBucketSeconds = Math.max(0, (Math.min(bucket.bucketEndMs, nowMs) - bucket.bucketStartMs) / 1000);
    const coverage = coverageForBucket(bucketRows, channels, sourceCadences, elapsedBucketSeconds);
```

Replace the total-window line (~line 989):

```js
  const totalSeconds = (endMs - startMs) / 1000;
```

with:

```js
  const totalSeconds = Math.max(0, (Math.min(endMs, nowMs) - startMs) / 1000);
```

- [ ] **Step 4: Simplify `buildLocalInterpretations` (remove the interim rescale)**

Replace the rescale block that mobile-plan Task 5 introduced (the `effectiveCoveragePct` computation) with the reduced form — coverage arriving here is now already elapsed-based:

```js
  const generatedMs = parseTime(generatedAt);
  const rangeFromMs = parseTime(input.rangeFrom);
  // Fully-future windows have nothing to be missing yet; coverage is null
  // there and must not trigger the unknown-confidence info banner either.
  const fullyFutureWindow = rangeFromMs !== null && generatedMs !== null && rangeFromMs >= generatedMs;
  if (!fullyFutureWindow && (coverageConfidence === 'unknown' || (coveragePct !== null && coveragePct < 80))) {
```

and revert the pushed item's `params`/`evidence` to the plain `coveragePct` (no `effectiveCoveragePct`). Keep `rangeFrom`/`rangeTo` in the input contract (flows already passes them after mobile Task 5).

Update the four mobile-Task-5 asserts in `scripts/test-history-helper.js`: delete the `fullElapsedCoverage` case (its scenario — raw full-window coverage 34% — can no longer reach the rule; Step 1's aggregateRows test covers that behavior at the right layer now); keep `realGap` (15% fires), `pastWindow` (70% fires), and `fullyFuture` (no banner) unchanged.

- [ ] **Step 5: Run tests, mirror, parity**

Run: `node scripts/test-history-helper.js` — expected: PASS (new clamp tests + updated interpretation tests + all pre-existing; the rollup read-path tests are unaffected because completed rollup buckets never extend past now).
Mirror both edits to bcm2709, then `node scripts/verify-profile-parity.js` — 22/22.

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js scripts/test-history-helper.js
git commit -m "fix(history-api): coverage denominators clamp at now; retire interim interpretation rescale"
```

---

### Task 4: Expose the data-path `source` on the card-data payload

`aggregateDeviceData` already computes `source: 'history_channel_rollups' | 'device_data' | 'rollups+live'` but the router drops it. Exposing it ends a whole class of "which path served this data" diagnosis (it cost real time in both the 2026-06-07 and 2026-07-11 investigations; noted as a follow-up in the kaba100 issues doc since 2026-06-02 and never picked up).

**Prerequisite: load the `osi-flows-json-editing` skill. Sequencing: must land before 4.2's golden-vector capture — this changes the response payload shape.**

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (node `history-api-router-fn`, function `buildDeviceCardData`)
- Modify: `conf/full_raspberrypi_bcm2709/files/usr/share/flows.json` (identical)
- Modify: `web/react-gui/src/history/types.ts` (optional field)

- [ ] **Step 1: Locate the two aggregation-summary objects**

In `history-api-router-fn`'s `func`, `buildDeviceCardData` assembles the response `aggregation` object in two places, both anchored by a `pointCount:` property: the empty-source branch (`pointCount: 0`, visible verbatim in the node) and the populated branch (pointCount derived from the aggregate result). Identify the local variable in the populated branch that holds the `osiHistory.aggregateDeviceData(...)` result (read the surrounding ~20 lines; it is the object the branch reads `coveragePct`/`coverageConfidence` from).

- [ ] **Step 2: Add the field**

In the populated branch's aggregation object add (using the actual local variable name found in Step 1, shown here as `aggregate`):

```js
          source: (aggregate && aggregate.source) || null,
```

In the empty-source branch's aggregation object add:

```js
          source: null,
```

Mirror the identical edit into the bcm2709 `flows.json`.

- [ ] **Step 3: Type the field in the GUI**

In `web/react-gui/src/history/types.ts`, find the `HistoryCardDataResponse` `aggregation` object type (grep `coverageConfidence`) and add:

```ts
  source?: string | null;
```

No UI consumes it yet — this is a diagnostic field (Advanced View can render it in a later slice).

- [ ] **Step 4: Verify structurally and live**

Run: `node scripts/verify-sync-flow.js && node scripts/verify-profile-parity.js && cd web/react-gui && npx tsc --noEmit 2>/dev/null || npm run build`
Expected: all pass.

Live check (kaba100, after this plan's deploy — can ride the mobile plan's Task 13 deploy): authenticated
`GET /api/history/zones/3/cards/<cardId>/data?range=30d&…` must return `aggregation.source` ∈ {`history_channel_rollups`, `rollups+live`} and `range=24h` must return `device_data`.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm2709/files/usr/share/flows.json web/react-gui/src/history/types.ts
git commit -m "feat(history-api): expose data-path source on card-data aggregation payload"
```

---

### Task 5: Draft the two pending decisions for the refactor program (PROPOSED, not adopted)

Two items need adjudication by the program owner, not silent implementation. Draft them into the open-decisions doc so they enter the program's normal decision flow.

**Files:**
- Modify: `docs/architecture/refactor-program-2026-open-decisions.md` (append)

- [ ] **Step 1: Append the two proposals**

Append under a new section (adjust the heading style to match the doc's existing sections):

```markdown
## Proposed 2026-07-11 (pending adjudication) — from the mobile-history review / rollup analysis

### P1 — Per-source rollup key scheme (prerequisite for the environment per-source series split)

The merged environment series interleaves two sensors ~2.5 °C apart into a false sawtooth
(kaba100, Temp1 + Dendro1, verified 2026-07-11). Fixing it requires per-source series, which
requires per-source rollups for 30d/season. Proposal: write per-source rollup rows ALONGSIDE
the existing merged row, reusing the dendro pattern (`dendro-src-<hash>`) via the router's
existing `sourceKeyForDevice` tokens (e.g. `env-src-<hash>`, `soil-src-<hash>`). Additive:
the write job already holds per-device rows in scope; merged reads stay byte-identical.
The read path must then be extended per query (one key per query, or lift the
`rollupRowsToResult` single-key guard added 2026-07-11 with per-source bucket keying).
Cost: rollup table row count multiplies by (1 + sources-per-card); trivial at current fleet scale.
Decide BEFORE the per-source split spec is written — it determines whether that spec is
"add rows + extend one query" or "migrate a table".

### P2 — 1.A3 residue: dual helper test suites

1.A3's plan (`docs/superpowers/plans/2026-07-08-osi-history-helper-tests.md`) defines
relocating the full 2,141-line `scripts/test-history-helper.js` suite to co-located
`index.test.js` and retiring the scripts copy. What landed: a 446-line co-located suite
PLUS the un-retired scripts suite, both CI-wired (`migrations.yml:56` and `:74`). The
rollup-path coverage (incl. the 2026-07-11 hardening tests) lives only in the scripts copy —
the location DD4 calls wrong for extraction seams. Options: (A) finish the relocation and
retire the scripts copy at next helper touch (recommended — completes 1.A3 as specced);
(B) accept dual suites and document the split of responsibilities. Either way the program
table's "1.A3 done" wording should note the residual.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/refactor-program-2026-open-decisions.md
git commit -m "docs(program): propose per-source rollup key scheme + 1.A3 dual-suite adjudication"
```

---

## Self-review notes

- Task 1/2 are pure hardening (no behavior change for current callers — guard is unreachable via the existing single-key SQL; Task 2 pins verified-live behavior).
- Task 3 changes reported coverage for in-progress windows only (completed windows keep identical denominators — pinned by Step 1's second test) and knowingly supersedes mobile-plan Task 5's rescale; both entry orders are specified.
- Task 4 changes payload shape — the reason for the before-4.2 sequencing constraint; empty-branch and populated-branch both get the field so the shape is consistent.
- Task 5 proposes, does not adopt: both entries are marked pending adjudication.
- Type consistency: `rollupRowsToResult` export name matches Task 1's tests; `nowMs` option name matches the existing `query.nowMs` reads in `aggregateDeviceData`; `source` field name matches the helper's existing result field.
