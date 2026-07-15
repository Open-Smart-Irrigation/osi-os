# Field Journal Review Fixes + Main Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate `feat/field-journal-slice1` with current `main` (resolving the 0014–0017 migration number collision by renumbering to 0018–0021) and fix the 9 remaining confirmed findings from the 2026-07-14 high-effort code review.

**Architecture:** One integration task first (merge main, renumber migrations, regenerate derived surfaces: catalog migration, CHECKSUMS.json, 7 bundled farming.db copies, flows.json wiring, size-ratchet baseline). Then one task per review finding, in severity order. All edge-module edits happen in the bcm2712 tree and are mirrored byte-identically to bcm2709.

**Tech Stack:** Node 22, Node-RED 3.1.15 function modules (`conf/*/files/usr/share/node-red/osi-journal/`), SQLite via osi-db-helper, ordered migrations (`lib/osi-migrate`), repo verify/test scripts under `scripts/`.

## Global Constraints

- **Workspace:** the existing worktree `/home/phil/Repos/osi-os/.claude/worktrees/feat+field-journal-slice1`, branch `feat/field-journal-slice1`. All commands below run from that directory unless stated otherwise.
- **Mirror rule:** every changed file under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` must be copied byte-identically to the same path under `conf/full_raspberrypi_bcm27xx_bcm2709/files/`, then `node scripts/verify-profile-parity.js` must print `All parity checks passed.`
- **Skills:** load `osi-schema-change-control` before touching `database/migrations/`, `database/seed-blank.sql`, or any bundled `farming.db`; load `osi-flows-json-editing` before touching `flows.json`.
- **TDD:** every behavior fix adds a failing test first, in the existing test file for that area (`scripts/test-journal-api.js`, `scripts/test-journal-lifecycle.js`, `scripts/test-journal-command-path.js`, `scripts/test-journal-perf-fixture.js`). Follow the existing harness patterns in those files (in-memory/tmp SQLite via the repo's TestDb helpers).
- **Migration edit rule:** the journal migrations are NOT merged to main and NOT deployed to any Pi (verified 2026-07-14), so editing/renaming them on this branch is allowed. Main's `0014`–`0017` are merged and immutable.
- **Evidence:** paste real command output in each task's report; never claim a gate green without running it.
- **Commit per task**, message prefixed `fix(journal):` / `chore(journal):` as noted.

## Review findings being fixed (from the 2026-07-14 review)

| # | Finding | Task |
|---|---|---|
| 1 | Migrations 0014–0017 collide with main's | Task 1 |
| 2 | Export endpoints always 500 (msg.res wrapper has no write()) | Task 2 |
| 3 | resolvePlotContext zone JOIN excludes NULL-gateway-EUI zones | Task 3 |
| 4 | upsertPlot re-validates soft-deleted zone → plot permanently un-editable | Task 4 |
| 5 | ensureZonePlot returns inactive plot → zone-based entry creation 404s | Task 5 |
| 6 | Zone-timezone override terminally NACKs valid cloud entry commands | Task 6 |
| 7 | Draft duplicate value → raw 500 instead of 422 | Task 7 |
| 8 | No (plot_uuid, occurred_start) index for plot-filtered list/export | Task 8 |
| 9 | deploy.sh journal file list unfenced (6 of 12 files unverified) | Task 9 |
| 10 | Fleet-wide command dedupe/ACK pipeline lives inside osi-journal | Task 10 |

---

### Task 1: Integrate main + renumber journal migrations to 0018–0021

**Files:**
- Modify: `database/migrations/ordered/` (rename 4 journal migrations), `database/migrations/ordered/CHECKSUMS.json`, `database/seed-blank.sql`, all 7 bundled `farming.db`, both `flows.json`, `scripts/generate-journal-catalog.js:15`, `scripts/verify-flows-size-ratchet-baseline.json` (+allowances), conflicted verify/test scripts (see step 3)
- Commit also: `docs/superpowers/plans/2026-07-14-field-journal-review-fixes.md` (this file, already in the worktree)

**Interfaces:**
- Produces: branch merged with main; journal migrations named `0018__field_journal.sql`, `0019__journal_catalog_v1.sql`, `0020__journal_resource_owner_scope.sql`, `0021__journal_plot_lookup_indexes.sql`; all gates green. Tasks 2–10 build on this.

- [ ] **Step 1: Safety tag, then merge**

```bash
git tag field-journal-slice1-pre-main-merge
git merge main
```

Expected: conflict list matching (roughly) the 24 both-sides-modified files: 7× `farming.db`, 2× `flows.json`, `seed-blank.sql`, `CHECKSUMS.json`, `docs/contracts/sync-schema/{commands,resources}.schema.json`, `scripts/{test-contract-schemas,test-flows-wiring,verify-db-schema-consistency,verify-sync-flow,verify-sync-op-parity}.js`, `scripts/verify-sync-op-parity.test.js`, `scripts/fixtures/silent-catch-baseline.json`, `scripts/verify-flows-size-ratchet-{baseline,allowances}.json`, 2× `osi-lib/index.test.js`.

- [ ] **Step 2: Resolve generated/binary surfaces by taking main's version (regenerated later)**

```bash
git checkout main -- \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db web/react-gui/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  database/migrations/ordered/CHECKSUMS.json \
  scripts/verify-flows-size-ratchet-baseline.json \
  scripts/verify-flows-size-ratchet-allowances.json
```

- [ ] **Step 3: Resolve the text conflicts by combining both sides**

For each remaining conflicted file, inspect main's delta first (`git diff 69f7a9f2..main -- <file>`) — main's changes since the merge-base are small (DD8 cleanup, field-work-request Stage 0, verify-sync-flow ratchet refresh). Resolution rule: keep the branch's journal additions AND main's changes; neither side's edits may be dropped. `database/seed-blank.sql`: keep main's version of the shared sections and re-append the branch's journal DDL + catalog seed blocks (they are appended sections; `verify-seed-replay` in step 8 is the equivalence check).

- [ ] **Step 4: Renumber the journal migrations**

```bash
git mv database/migrations/ordered/0014__field_journal.sql            database/migrations/ordered/0018__field_journal.sql
git mv database/migrations/ordered/0016__journal_resource_owner_scope.sql database/migrations/ordered/0020__journal_resource_owner_scope.sql
git mv database/migrations/ordered/0017__journal_plot_lookup_indexes.sql  database/migrations/ordered/0021__journal_plot_lookup_indexes.sql
git rm database/migrations/ordered/0015__journal_catalog_v1.sql
```

Edit `scripts/generate-journal-catalog.js:15`:

```js
const MIGRATION_NAME = '0019__journal_catalog_v1.sql';
```

Regenerate the catalog migration (read the script header for its exact invocation; it writes the migration file and its CHECKSUMS entry):

```bash
node scripts/generate-journal-catalog.js
```

Then sweep every stale reference (update each hit — tests, docs, deploy wiring, self-referencing header comments inside the renamed files):

```bash
grep -rn "0014__field_journal\|0015__journal_catalog\|0016__journal_resource\|0017__journal_plot" \
  --exclude-dir=node_modules --exclude-dir=.git .
```

Add the three non-generated entries to `CHECKSUMS.json` (0019 is written by the generator):

```bash
for f in 0018__field_journal 0020__journal_resource_owner_scope 0021__journal_plot_lookup_indexes; do
  node -e "const c=require('crypto'),fs=require('fs');console.log('\"$f.sql\": \"'+c.createHash('sha256').update(fs.readFileSync('database/migrations/ordered/$f.sql')).digest('hex')+'\",')"
done
```

Insert them after the `0017__zone_key_fallback_parity.sql` entry, keeping numeric order. `node scripts/verify-migrations.js` must pass before continuing.

- [ ] **Step 5: Re-apply the journal flows wiring onto main's flows.json**

Load `osi-flows-json-editing`. Run the three wiring scripts in their original order (routes → commands → bootstrap; confirm each script's header/self-checks before running):

```bash
node scripts/migrate-flows-journal-routes.js
node scripts/migrate-flows-journal-commands.js
node scripts/migrate-flows-journal-bootstrap.js
```

These scripts anchor on literal source strings (`replaceOnce` throws on a missed anchor) — main's flows.json still contains the known anchors (e.g. `historyCloudAiEnabled: false`, verified 2026-07-14). If a script pins an expected input hash of flows.json, update that pin to main's file (the pin exists for one-shot safety, not as an immutable contract). If a script only writes the bcm2712 file, mirror it: `cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`.

- [ ] **Step 6: Regenerate the 7 bundled DBs from main's DBs + renumbered migrations**

```bash
for db in \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db web/react-gui/farming.db
do
  for m in 0018__field_journal 0019__journal_catalog_v1 0020__journal_resource_owner_scope 0021__journal_plot_lookup_indexes; do
    sqlite3 -bail "$db" < "database/migrations/ordered/$m.sql" || exit 1
  done && echo "OK $db"
done
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db && echo "OK mirror"
```

- [ ] **Step 7: Re-pin the flows size ratchet**

Run `node scripts/verify-sync-flow.js`. If the size ratchet fails for the journal-wired nodes, update `scripts/verify-flows-size-ratchet-baseline.json` / `-allowances.json` following the existing per-node reason format (the branch's pre-merge versions of these files show the journal allowances to carry over; main's DD8 refresh must be preserved).

- [ ] **Step 8: Full gate suite — every line must pass**

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
node scripts/verify-sync-contract.js
node scripts/verify-sync-op-parity.js && node --test scripts/verify-sync-op-parity.test.js
node scripts/verify-helper-registration.js
node scripts/test-contract-schemas.js
node scripts/test-flows-wiring.js
node scripts/test-deploy-atomic-payload-wiring.js
node scripts/test-journal-schema.js
node scripts/test-journal-catalog-generator.js
node scripts/test-journal-lifecycle.js
node scripts/test-journal-api.js
node scripts/test-journal-command-path.js
node scripts/test-journal-bootstrap.js
node scripts/test-journal-perf-fixture.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/index.test.js
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore(journal): merge main; renumber journal migrations to 0018-0021"
```

---

### Task 2: Fix export streaming — unwrap Node-RED's msg.res wrapper (finding 2)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js` (`streamResponse`, ~line 2614)
- Test: `scripts/test-journal-api.js`
- Mirror: same file under `conf/full_raspberrypi_bcm27xx_bcm2709/`

**Interfaces:**
- Produces: `streamResponse` streams to `msg.res._res` when present. No export signature changes.

- [ ] **Step 1: Write the failing test.** In `scripts/test-journal-api.js`, add a test that calls `handleHttpRequest` for `GET /api/journal/export.csv` (authed, minimal seeded data) with a Node-RED-wrapper-shaped response object: `msg.res = { _res: sink, status(){}, set(){}, send(){}, type(){} }` where `sink` is the file's existing BackpressureSink-style mock (has `write`/`end`); assert HTTP 200 and CSV bytes arrive in `sink`, not a 500 `stream_unavailable`.
- [ ] **Step 2: Run it, confirm it fails** with `stream_unavailable`/500: `node scripts/test-journal-api.js`
- [ ] **Step 3: Implement.** In `streamResponse` (current guard: `const response = msg.res; if (!response || typeof response.write !== 'function') throw apiError(500, 'stream_unavailable', ...)`), unwrap first:

```js
const wrapper = msg.res;
const response = wrapper && wrapper._res && typeof wrapper._res.write === 'function'
  ? wrapper._res
  : wrapper;
```

Keep the existing guard on the unwrapped `response`. Audit the rest of the streaming path (header/status writes) so status code and headers are set on the same object that streams (`response.setHeader`/`response.writeHead` on `_res`; do not mix wrapper `.status()` with raw writes).
- [ ] **Step 4: Run `node scripts/test-journal-api.js`** — all pass, including the three existing export tests.
- [ ] **Step 5: Mirror + parity + commit**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js
node scripts/verify-profile-parity.js
git add -A && git commit -m "fix(journal): stream exports through Node-RED msg.res._res"
```

---

### Task 3: Fix resolvePlotContext NULL-gateway-EUI zone JOIN (finding 3)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/lifecycle.js` (~line 293)
- Test: `scripts/test-journal-lifecycle.js`
- Mirror: bcm2709 copy

**Interfaces:**
- Produces: entries save successfully on plots linked to zones whose `gateway_device_eui` is NULL. No signature changes.

- [ ] **Step 1: Failing test.** Seed a zone with `gateway_device_eui = NULL` (legal per `0001__baseline.sql`), link a plot to it via the API/upsert path, then save a final entry. Assert success and that the resolved context carries the zone (currently: 404 `zone_not_found`).
- [ ] **Step 2: Run `node scripts/test-journal-lifecycle.js`** — new test fails with `zone_not_found`.
- [ ] **Step 3: Implement.** In `resolvePlotContext`'s zone LEFT JOIN, change the join condition

```sql
AND z.gateway_device_eui = p.gateway_device_eui
```

to match api.js's ownership predicate (`ownedZone`, api.js:530):

```sql
AND (z.gateway_device_eui = p.gateway_device_eui OR z.gateway_device_eui IS NULL)
```

- [ ] **Step 4: Run `node scripts/test-journal-lifecycle.js` and `node scripts/test-journal-api.js`** — all pass.
- [ ] **Step 5: Mirror + parity + commit** (`fix(journal): match NULL-gateway-EUI zones in resolvePlotContext`)

---

### Task 4: Stop upsertPlot from bricking plots linked to soft-deleted zones (finding 4)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js` (~line 699)
- Test: `scripts/test-journal-api.js`
- Mirror: bcm2709 copy

**Interfaces:**
- Produces: `PUT /api/journal/plots/:uuid` succeeds after the linked zone is soft-deleted; zone ownership is still enforced for any zone link the request itself sets.

- [ ] **Step 1: Failing tests.** (a) Link plot to zone; soft-delete the zone (`UPDATE irrigation_zones SET deleted_at = <now>`); `PUT` the plot with `{zone_uuid: null}` → expect 200 detach (currently 404). (b) Same setup, `PUT {active: 0}` → expect 200. (c) Security regression guard: `PUT {zone_uuid: <other user's zone>}` → still 404; `PUT {zone_uuid: <soft-deleted zone>}` → still 404.
- [ ] **Step 2: Run — (a) and (b) fail with 404 'Zone was not found'.**
- [ ] **Step 3: Implement.** Remove the unconditional pre-update check on the *existing* link — current line ~699: `if (existing && existing.zone_uuid) await ownedZone(tx, existing.zone_uuid, principal);` — keeping the `ownedZone` validation that runs for `input.zone_uuid` (the link the request sets/keeps explicitly, ~line 703). An update that doesn't name a zone must not require the historical zone to still be live.
- [ ] **Step 4: Run `node scripts/test-journal-api.js`** — all pass, including the cross-tenant masking tests.
- [ ] **Step 5: Mirror + parity + commit** (`fix(journal): allow plot edits after linked zone soft-delete`)

---

### Task 5: ensureZonePlot must prefer/create an active plot (finding 5)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js` (`ensureZonePlot`, ~lines 826–836)
- Test: `scripts/test-journal-api.js`
- Mirror: bcm2709 copy

**Interfaces:**
- Produces: `POST /api/journal/entries` with `zone_uuid` works when the zone's previous plot is inactive: it selects an active plot if one exists, else auto-creates one (the function's existing no-plot creation path).

- [ ] **Step 1: Failing test.** Create entry via `zone_uuid` (auto-creates plot); deactivate that plot (`PUT {active:0}`); POST another entry with `zone_uuid` → expect success with a *new* active plot (currently 404 'Plot was not found').
- [ ] **Step 2: Run — fails with 404.**
- [ ] **Step 3: Implement.** Add `AND p.active = 1` to `ensureZonePlot`'s existing-plot lookup (currently filters only `p.deleted_at IS NULL`, `ORDER BY p.created_at, p.plot_uuid`). With no active match, execution falls through to the function's existing create path. Confirm the create path's zone-conflict rule stays consistent with `upsertPlot`'s active-only conflict check (~line 707).
- [ ] **Step 4: Run `node scripts/test-journal-api.js`** — all pass.
- [ ] **Step 5: Mirror + parity + commit** (`fix(journal): zone-based entry creation skips inactive plots`)

---

### Task 6: Entry timezone must beat zone timezone in occurrenceFor (finding 6)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/lifecycle.js` (`occurrenceFor`, ~line 692)
- Test: `scripts/test-journal-command-path.js`
- Mirror: bcm2709 copy

**Interfaces:**
- Produces: `occurrenceFor` resolves wall time in `input.occurred_timezone` when the entry supplies one; `plot.zone_timezone` is only a fallback. Cloud `UPSERT_JOURNAL_ENTRY` commands with a timezone differing from the zone's apply cleanly.

- [ ] **Step 1: Failing test.** In `scripts/test-journal-command-path.js`, build an `UPSERT_JOURNAL_ENTRY` command whose entry has `occurred_timezone: 'Africa/Kampala'` (offset +180) against a plot whose zone keeps the schema default `timezone = 'UTC'`. Assert the command APPLIES and the stored local time matches Kampala wall time. (Currently: `invalid_utc_offset` → `REJECTED_PERMANENT`. The existing fixtures mask this by setting both timezones to Europe/Zurich.)
- [ ] **Step 2: Run `node scripts/test-journal-command-path.js`** — fails with REJECTED_PERMANENT.
- [ ] **Step 3: Implement.** Flip the precedence at lifecycle.js:692 from

```js
plot.zone_timezone || input.occurred_timezone
```

to

```js
input.occurred_timezone || plot.zone_timezone
```

Trace REST `saveEntry` too: entries created without an explicit `occurred_timezone` must still fall back to the zone timezone (existing tests cover this — they must stay green).
- [ ] **Step 4: Run `node scripts/test-journal-command-path.js`, `node scripts/test-journal-lifecycle.js`, `node scripts/test-journal-api.js`** — all pass.
- [ ] **Step 5: Mirror + parity + commit** (`fix(journal): prefer entry timezone over zone timezone in occurrence resolution`)

---

### Task 7: Draft duplicate values → 422, not raw 500 (finding 7)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/lifecycle.js` (`validateDraftLimits`, ~lines 341–399)
- Test: `scripts/test-journal-lifecycle.js`
- Mirror: bcm2709 copy

**Interfaces:**
- Produces: drafts with two values for the same `(group_index, attribute_code)` fail validation with the same `duplicate_value` code finals get.

- [ ] **Step 1: Failing test.** POST a draft with `values: [{attribute_code:'x', group_index:0, value_num:1}, {attribute_code:'x', group_index:0, value_num:2}]` → expect 422 `duplicate_value` (currently 500 `internal_error` from SQLITE_CONSTRAINT).
- [ ] **Step 2: Run — fails (500).**
- [ ] **Step 3: Implement.** In `validateDraftLimits`, add the same key-set check `validateEntry` uses for finals (index.js:615-623): build `Set` of `` `${group_index}:${attribute_code}` `` over `input.values`; on a repeat, emit a `duplicate_value` error in this function's existing error-object shape (same code/field format the final path produces, so clients see one error contract).
- [ ] **Step 4: Run `node scripts/test-journal-lifecycle.js`** — all pass.
- [ ] **Step 5: Mirror + parity + commit** (`fix(journal): validate duplicate draft values instead of 500`)

---

### Task 8: Add plot-time index + pin its query plan (finding 8)

**Files:**
- Modify: `database/migrations/ordered/0021__journal_plot_lookup_indexes.sql`, `database/seed-blank.sql`, all 7 bundled `farming.db`, `database/migrations/ordered/CHECKSUMS.json` (0021 entry), `scripts/test-journal-perf-fixture.js` (`collectPlans`)
- Check: `scripts/verify-db-schema-consistency.js` — if journal indexes are in its hand-maintained contract, extend it

**Interfaces:**
- Produces: `idx_journal_entries_plot_time` exists in migration + seed + all bundled DBs; perf fixture pins the plot-filtered list plan.

- [ ] **Step 1: Failing test.** Extend `collectPlans` in `scripts/test-journal-perf-fixture.js` with the plain plot-filter list shape (the real `buildEntryWhere` output for `GET /entries?plot_uuid=X`, default `status='final'`, no activity/author filter) and assert its `EXPLAIN QUERY PLAN` uses `idx_journal_entries_plot_time`.
- [ ] **Step 2: Run `node scripts/test-journal-perf-fixture.js`** — fails (plan shows `idx_journal_entries_gateway_time`).
- [ ] **Step 3: Implement.** Append to `0021__journal_plot_lookup_indexes.sql` (allowed: unmerged, undeployed — this branch owns it):

```sql
CREATE INDEX IF NOT EXISTS idx_journal_entries_plot_time
  ON journal_entries (plot_uuid, occurred_start DESC, entry_uuid)
  WHERE deleted_at IS NULL;
```

Add the same statement to the journal index section of `database/seed-blank.sql`. Apply to the 6 non-mirror bundled DBs (`sqlite3 -bail "$db" "CREATE INDEX IF NOT EXISTS ..."`), mirror-copy bcm2712→bcm2709. Recompute the `0021` checksum entry in `CHECKSUMS.json` (same node one-liner as Task 1 step 4).
- [ ] **Step 4: Gates:** `node scripts/test-journal-perf-fixture.js`, `node scripts/verify-migrations.js`, `node scripts/verify-seed-replay.js`, `node scripts/verify-db-schema-consistency.js`, `node scripts/verify-profile-parity.js` — all pass.
- [ ] **Step 5: Commit** (`fix(journal): index plot-filtered entry listing`)

---

### Task 9: Directory-derived deploy fence for module files (finding 9)

**Files:**
- Modify: `scripts/test-deploy-atomic-payload-wiring.js`
- Read: `deploy.sh` (the 12 `fetch_required` lines for osi-journal, ~lines 458–504)

**Interfaces:**
- Produces: the wiring test derives the expected file set from the module directory listing, so any osi-journal file not fetched by deploy.sh fails CI.

- [ ] **Step 1: Rewrite the check to be discovery-based.** In `scripts/test-deploy-atomic-payload-wiring.js`, replace the 4-file hardcoded regex list with: `fs.readdirSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal')`, keep `package.json` + every `*.js` except `*.test.js`, and assert each filename appears in a `fetch_required` line targeting the osi-journal destination path in `deploy.sh` (extract the exact path pattern from the existing fetch lines).
- [ ] **Step 2: Negative self-test.** In the same file, add a unit case that runs the new check against a doctored copy of the deploy.sh content with one fetch line removed and asserts the check reports that filename (this proves the fence actually closes — structure the check as a pure function `missingFetches(deploySource, fileList)` so both cases share it).
- [ ] **Step 3: Run `node scripts/test-deploy-atomic-payload-wiring.js`** — passes against real deploy.sh, negative case detects the doctored omission.
- [ ] **Step 4: Commit** (`test(deploy): derive journal payload fence from module directory`)

---

### Task 10: Extract the shared command ledger out of osi-journal (finding 10)

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js`, `.../osi-command-ledger/package.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/commands.js`, both `flows.json` (libs of nodes `Deduplicate Pending Command` and `Queue REST Command ACK`), `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json` (+lock), `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed`, `deploy.sh`, `scripts/test-flows-wiring.js`, ratchet baseline if node sizes change
- Test: `scripts/test-journal-command-path.js` (must stay green through the move), new `.../osi-command-ledger/index.test.js` smoke test
- Mirror: bcm2709 copies of every touched conf file

**Interfaces:**
- Produces: module `osi-command-ledger` exporting `deduplicatePendingCommand(db, envelope, runtime)`, `queueCommandAck(db, ack)`, `classifyAckResult(result, errorText)`, and `validEffectBinding(envelope)` with an options hook `{extraEffectBindingValidator}`; `osi-journal/commands.js` imports these and registers its journal-specific binding validator. Flow nodes depend on `osi-command-ledger` (not `osi-journal`) for the generic pipeline.

- [ ] **Step 1: Move the generic code.** Relocate from `osi-journal/commands.js` into the new module: `deduplicatePendingCommand`, `queueCommandAck`, `classifyAckResult` (incl. the STREGA error-text heuristics), the non-journal effect-key grammar (`validNonJournalEffectBinding`, `irrigation:scheduler`/`irrigation:manual`/`config:` regexes, ~lines 493–518), and the `applied_commands`/`command_ack_outbox` reader/writer helpers they use. Keep function signatures identical. The journal-specific branch becomes an injected validator: the ledger's `validEffectBinding(envelope, opts)` calls `opts.extraEffectBindingValidator(envelope)` when the built-in grammar doesn't claim the type. `osi-journal/commands.js` keeps `validJournalEffectBinding` and re-exports thin wrappers that pass it in, so `osiJournal.deduplicatePendingCommand`/`queueCommandAck` keep working (compatibility for existing callers/tests).
- [ ] **Step 2: Wire the module** exactly like osi-journal is wired (use it as the template): `package.json` with `main: index.js`, entry in the node-red `package.json` `file:` deps + lockfile, registration in `98_osi_node_red_seed`, `fetch_required` lines in `deploy.sh`. `node scripts/verify-helper-registration.js` must pass.
- [ ] **Step 3: Repoint the flow nodes.** Load `osi-flows-json-editing`. In both flows.json, change the two nodes' `libs` from `{"var":"osiJournal","module":"osi-journal"}` to `{"var":"osiCommandLedger","module":"osi-command-ledger"}` and update their function bodies to call `osiCommandLedger.deduplicatePendingCommand(db, envelope, { extraEffectBindingValidator: osiJournal.validJournalEffectBinding })` — note the dedupe node keeps an `osiJournal` lib entry too, since journal command application still needs it (check the node's current body for how `osiJournal.applyJournalCommand` is reached; that call path must not change).
- [ ] **Step 4: Gates:** `node scripts/test-journal-command-path.js` (all pass — no behavior change), new module smoke test via `node --test`, `node scripts/test-flows-wiring.js`, `node scripts/verify-sync-flow.js` (re-pin ratchet if needed), `node scripts/verify-helper-registration.js`, `node scripts/test-deploy-atomic-payload-wiring.js` (extend its module list to cover osi-command-ledger — with Task 9's directory-derived fence this means adding the new directory to the discovered set), `node scripts/verify-profile-parity.js`.
- [ ] **Step 5: Commit** (`refactor(commands): extract shared command ledger module from osi-journal`)

**Scope note:** this task is behavior-preserving by design. If the extraction reveals hidden coupling that can't be resolved with signature-identical moves + the validator hook, STOP and report back rather than redesigning inline.

---

## Execution notes for the orchestrator

- Task 1 must complete (all gates green) before any other task starts. Tasks 2–7 all touch `api.js`/`lifecycle.js` — run them **sequentially**. Task 8 and 9 may run after 2–7 in either order; Task 10 last.
- Worker model: Sonnet. Each worker gets its task text verbatim plus the Global Constraints section.
- After each task: orchestrator reviews the diff + test output before dispatching the next.
