# Field-gateway history sync recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a gateway in `tail` state continue its ordered history stream while corrections and manifest repairs are pending, without allowing those repair acknowledgements to move the stream cursor.

**Architecture:** Keep one stream cursor per history table. Only `shadow`, `backfill`, and `tail` batches may advance it; `repair`, `correction`, and `derived` acknowledgements update their dirty-key rows and batch health only. This implementation changes ACK ownership only. Scheduling fairness is deferred until cursor isolation is tested; the current finite repair queue and matching manifests do not prove that a new scheduler is needed.

**Tech stack:** Node-RED function nodes, JavaScript, SQLite, Node's test runner, the existing real-flow SQLite harness.

**Spec:** `.superpowers/sdd/2026-10-07-history-coverage-diagnosis/investigation.md`

## Global constraints

- The edge SQLite database remains canonical. Do not synthesize `DEVICE_DATA_APPENDED` events for historical rows.
- Keep history protocol/hash version 1 unchanged. This repair changes scheduling and cursor ownership, not canonicalization.
- Keep the two Raspberry Pi profile payloads byte-for-byte equal.
- Do not reset or rewrite a live cursor as part of product code. A `tail` query already reads rows whose ID is greater than `last_acked_id` without the original snapshot bound.
- Keep cloud account `data_retention_days`, the 7-day hourly window, the 90-day daily window, and weekly rollup behavior unchanged in this slice.
- Treat `edge_history_row_index` as an ingestion receipt when cloud retention has removed its backing `sensor_data` row. Do not make a same-hash replay bypass account retention.
- No live gateway or production cloud operation belongs to implementation. The recovery procedure at the end requires a separate reviewed operation after both local and deployment gates pass.

## Evidence and scope

The Field-gateway `device_data` cursor is in `tail` with `snapshot_high_id=0` and `last_acked_id=584`, while the source table contains IDs through 83,366. The build node gives pending dirty keys absolute priority. The mark node then writes `ackedThroughId` from every durable phase into `last_acked_id`; a repair for an old row can therefore rewind the stream to 584 again.

The cloud's 30-day account retention is separate. `TelemetryRetentionService` deletes old `sensor_data`, while `edge_history_row_index` remains as the durable receipt. On the inspected cloud, 296 of 581 index rows no longer have backing raw rows. Changing `DUPLICATE` to reinsert those rows would defeat the configured retention policy, so this plan does not change cloud ingestion.

The live cloud already builds the root-zone soil source as well as per-device sources. Its scheduler deliberately generates hourly rollups for 7 days and daily rollups for 90 days; it generates no weekly rollups. This plan does not add an aggregation fallback or a new rollup tier.

## Root review — execution scope

Execute Task 1 only, plus a concrete non-executing recovery record. Task 2 is deferred. Preserve monotonic cursor movement at the SQL write itself (an earlier JavaScript read can race a newer ACK). Compare numeric IDs numerically, key cursors by their existing cursor representation, and keep the unrelated cursor column unchanged. Cover both older and newer dirty boundaries. Preserve systemic retries and partial-prefix ACK handling. No schema or live state changes.

Do not rewrite the historical flow migration generator: it predates newer radio/rejection behavior and is not the current source of truth. Edit the shipped flow nodes using the guarded parse/mutate/serialize procedure. Add new helper functions only if they materially simplify the change.

The rollup and retention operations in Task 3 remain proposals: orphaned index entries mean a same-hash replay is not proof of raw-row restoration. No archive recovery claim until backing-row availability and requested policy are verified.

## Review focus

- An old repair ACK must leave both numeric and key stream cursors unchanged.
- A dirty queue that is continuously replenished must not prevent a newer tail row from reaching the cloud.
- A tail ACK may advance the cursor, but an older late ACK must never rewind it.
- A dirty-row rejection or retry must retain the existing queue/backoff behavior without borrowing the stream cursor.
- Restarting Node-RED may forget the alternation hint, but the next two eligible turns must still include one tail attempt; correctness cannot depend on a permanent in-memory phase.

### Task 1: Separate stream progress from dirty-key acknowledgement

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (`sync-history-mark`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (byte-identical mirror)
- Modify: `scripts/migrate-flows-durable-history-batch.js` only if it remains the checked-in source for the current mark function; preserve all newer radio and queue behavior when copying the function
- Modify: `scripts/history-sync-flow-harness.js`
- Test: `scripts/test-sync-history-queue-drain.js`
- Test: `scripts/test-sync-history-worker.js`

**Interfaces:**
- Consumes: `_historyBatch.phase`, the cloud `ackedThroughId` / `ackedThroughKey`, `helper.shouldApplyDurableAck`, and `dirtyRowKeysByHistoryKey`.
- Produces: the invariant that `sync_history_cursors.last_acked_id` and `last_acked_key` describe only ordered stream progress.

- [x] **Step 1: Write the failing numeric-cursor regression**

  In the real-flow harness, seed `device_data` in `tail` with `last_acked_id=1000`, queue a repair for row 584, deliver its successful ACK, and assert all three outcomes:

  ```js
  assert.equal(cursorAfter.last_acked_id, 1000);
  assert.equal(dirtyAfter.status, 'done');
  assert.equal(repairBatch.phase, 'repair');
  ```

  Add the symmetric key-cursor case with a `derived` dirty batch whose acknowledged key sorts before the current `last_acked_key`.

- [x] **Step 2: Run the two regressions and record the expected failure**

  Run:

  ```bash
  node --test --test-name-pattern='dirty ACK.*cursor|derived ACK.*cursor' scripts/test-sync-history-queue-drain.js
  ```

  Expected before the fix: at least the numeric assertion reports the repair boundary instead of the seeded stream boundary.

- [x] **Step 3: Gate cursor mutation by stream phase**

  In `sync-history-mark`, derive one exact predicate:

  ```js
  const streamPhase = ['backfill', 'tail'].includes(String(batch.phase || '').toLowerCase());
  ```

  Keep the existing `shadow` branch separate because it owns `last_shadow_acked_*`. After `helper.shouldApplyDurableAck` succeeds:

  - For `backfill` or `tail`, advance `last_acked_id` / `last_acked_key` only when the acknowledged boundary sorts after the stored boundary. Update batch metadata, retry state, and backfill completion as today. A late response from an older stream batch must be harmless.
  - For `repair`, `correction`, or `derived`, update batch metadata and retry/error state without writing either `last_acked_*` column.
  - Continue completing accepted dirty keys from `dirtyRowKeysByHistoryKey`.
  - Keep row-level rejection set-aside behavior and systemic retry backoff unchanged.

  Monotonic comparison applies only inside the stream-phase branch. A correction above the stream boundary must not skip unseen stream rows, just as an old correction must not rewind it.

- [x] **Step 4: Pin late and forward dirty ACKs**

  Add cases where a repair ACK is below the cursor and a correction ACK is above it. Both leave the cursor exactly unchanged. Then send a genuine `tail` batch and assert that its boundary advances the cursor. Finally apply an older tail response after the newer response and assert the boundary remains at the newer value. Cover numeric IDs and text keys.

- [x] **Step 5: Run the focused history tests**

  Run:

  ```bash
  node --test scripts/test-sync-history-queue-drain.js
  node scripts/test-sync-history-worker.js
  ```

  Expected: both exit 0, and the new tests exercise the shipped function node rather than a copied local implementation.

### Task 2: DEFERRED — Give ordered tail work bounded access beside dirty work

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (`sync-history-build`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (byte-identical mirror)
- Modify: `scripts/migrate-flows-durable-history-batch.js` under the same source-preservation rule as Task 1
- Modify: `scripts/history-sync-flow-harness.js` only where required to expose emitted phases
- Test: `scripts/test-sync-history-queue-drain.js`

**Interfaces:**
- Consumes: `cursor.state`, pending dirty keys, `helper.batchQuery(tableName, 'tail')`, and per-flow context.
- Produces: while dirty and tail work both exist, no more than one eligible turn for that table passes without giving tail work a chance.

- [ ] **Step 1: Write the starvation regression**

  Seed a `tail` cursor at ID 584, source rows through at least 900, and more than two dirty batches of older IDs. Configure the fake manifest to keep replenishing or preserving dirty work. Drive enough full table rotations for two `device_data` turns and assert:

  ```js
  assert.deepEqual(deviceDataBatches.slice(0, 2).map((batch) => batch.phase), ['repair', 'tail']);
  assert.ok(deviceDataBatches[1].keys.some((key) => key.endsWith('|585')));
  ```

  The test must leave dirty rows pending when the tail batch is selected. A test that drains the queue first does not prove fairness.

- [ ] **Step 2: Run the starvation regression and record the expected failure**

  Run:

  ```bash
  node --test scripts/test-sync-history-queue-drain.js --test-name-pattern='tail progresses while repair remains pending'
  ```

  Expected before the fix: both eligible `device_data` turns emit dirty work and no tail row is sent.

- [ ] **Step 3: Add a per-table one-turn alternation hint**

  In `sync-history-build`, read a flow-context set of tables whose last emitted eligible batch was dirty. In `tail`:

  1. If pending dirty keys exist and the table is not marked, emit the dirty batch and mark the table.
  2. If the table is marked, skip dirty selection for this turn, query the ordinary tail stream, and clear the mark whether the tail query returns rows or is idle.
  3. If no dirty keys exist, clear the mark and run the ordinary tail query.
  4. Do not apply this alternation in `shadow` or `backfill`.

  Scope the hint by table name, not globally, because table rotation interleaves eight independent cursors. Store only table names; do not store row data or cursor boundaries in flow context.

- [ ] **Step 4: Cover restart and no-tail cases**

  Add two focused cases:

  - Clear the flow-context hint between turns, then show that one dirty batch may run first but a following uninterrupted turn gives tail a chance.
  - Seed no row above `last_acked_id`; the marked turn clears the hint and returns idle, and the next dirty turn resumes. This prevents a permanent empty-tail loop.

- [ ] **Step 5: Prove convergence without a cursor reset**

  Extend the regression from ID 584 until the tail cursor reaches the seeded source maximum while dirty rows continue to be accepted. Assert monotonic stream boundaries after every `tail` ACK and unchanged boundaries after every dirty ACK.

- [ ] **Step 6: Run edge sync gates**

  Run:

  ```bash
  node --test scripts/test-sync-history-queue-drain.js
  node scripts/test-sync-history-worker.js
  node scripts/verify-sync-flow.js
  node scripts/verify-profile-parity.js
  ```

  Expected: all exit 0 and profile parity confirms identical flow payloads.

### Task 3: Document the gated field-gateway recovery procedure

**Files:**
- Modify: `.superpowers/sdd/2026-10-07-history-coverage-diagnosis/investigation.md`
- Create: `.superpowers/sdd/2026-10-07-history-coverage-diagnosis/recovery-runbook.md`

**Interfaces:**
- Consumes: the released edge fix, the existing cloud rollup backfill endpoint, and read-only counts from the edge and cloud.
- Produces: a reviewable operation proposal. It does not authorize or execute production changes.

- [ ] **Step 1: Record the preconditions and abort conditions**

  Require a fresh gateway backup, stable identity/link state, no history retry error, and recorded values for source `MAX(id)`, stream `last_acked_id`, dirty counts by status, cloud raw min/max/count, and root-zone daily rollup min/max/count. Abort on gateway identity transition, cursor retry/backoff, permanent rejection growth, or a cloud ownership/hash error.

- [ ] **Step 2: Specify the deployment and observation order**

  Deploy the ordinary reviewed edge release first. Do not edit the cursor. Observe tail boundaries increasing beyond 584 while old repairs complete, and require `last_acked_id` to reach the captured source maximum or a newer maximum before any catch-up rollup action.

- [ ] **Step 3: Separate retention from sync correctness**

  State that the account currently retains raw cloud telemetry for 30 days. Recovering older raw rows for long enough to aggregate them may require a temporary, user-scoped retention override; that data-policy operation needs explicit approval and a rollback value. The product patch must neither change the default nor silently override the account value.

- [ ] **Step 4: Define the bounded rollup catch-up**

  After the stream catches up and while the required raw rows still exist, call the existing admin rollup backfill for the smallest day count covering the Pi's oldest April row. Record start/end counts and duration. Validate the `root-zone` daily source used by the pilot, plus each expected soil channel; per-device rows alone do not satisfy the pilot card.

  The existing endpoint backfills hourly and daily for the requested window. If review rejects that cost, stop and write a separate cloud plan for a daily-only admin operation. Do not widen the scheduled 7-day/90-day windows in this repair.

- [ ] **Step 5: Define acceptance evidence**

  Require all of the following before calling the recovery successful:

  - Edge stream cursor is monotonic and reaches the captured source high-water mark.
  - Dirty repair rows stop starving tail batches; rejected rows do not increase.
  - Cloud root-zone daily rollups cover the target April interval for the channels actually available in history protocol v1 (`swt_1`, `swt_2`).
  - A cloud pilot request for an April 90-day-or-smaller viewport returns daily points; a later empty interval still permits gesture recovery.
  - Restoring any temporary retention override does not delete the daily rollups. Raw detail older than the account retention window remains explicitly unavailable.

- [ ] **Step 6: Run the prose gate**

  Run:

  ```bash
  node .claude/skills/anti-slop-writing/slop-check.js \
    docs/superpowers/plans/2026-10-07-field-gateway-history-sync-recovery.md \
    .superpowers/sdd/2026-10-07-history-coverage-diagnosis/investigation.md \
    .superpowers/sdd/2026-10-07-history-coverage-diagnosis/recovery-runbook.md
  ```

  Expected: exit 0 with no tier-1 findings. Review every tier-2 warning rather than suppressing it in bulk.

## Excluded follow-ups

- History hash/protocol v2 activation and recovery of channels absent from v1, including `swt_3`, temperature, humidity, and light.
- A daily-only cloud backfill endpoint.
- Weekly rollup generation or changes to `season` aggregation.
- Any global or default retention-policy change.
- Automatic frontend aggregation fallback.
- A live cursor rewrite, database replacement, or manual insertion into sync queues.
