# Issue 410 exact calibration test repair plan

Status: committed execution plan only. Product edits, new tests, negative controls,
release commands and release-row review are **UNRUN**. The accepted source design
was reviewed against immutable campaign base
`63c7a70f8f3b373f162b33b0669b0df89b3763fa` in R1–R4. This plan is
bound to fetched `origin/main` at
`33cdfae5f47809bdfbbdc7f9f74f12139b4124bf` on 2026-10-27.
The test, writer, seven-path manifest, checked-in seed, versioning document,
ledger verifier and calibration schema are byte-identical at those two commits.
The changed migrations workflow retains the focused calibration test as a gate;
its other changes do not alter this repair. Recheck that premise and obtain a
fresh independent review of this exact plan commit before any implementation.

The campaign ledger records #410 as open at provisional P1. Its last recorded
GitHub check was 2026-10-26T14:32:00Z, OPEN with no comments. Do not infer
current issue state or closure from that historical check.

## Execution order and stop gates

1. The independent reviewer checks this plan commit against the current base,
   the R1–R4 findings and the two owned files. A changed source contract or a
   required plan correction stops execution until a revised plan is reviewed.
2. In a disposable repository-shaped tree, reproduce the old second fixed-count
   assertion with the exact command and numeric oracle below. Preserve the
   coordinator's first `3 !== 2` result as historical evidence until independently
   rerun. Neither reproduction may touch tracked images.
3. Edit only `scripts/test-apply-chameleon-calibration-seed.js`. Write the
   literal synthetic fixtures and prepared-input assertions before changing
   the old fixed-count assertions. Run the focused test and confirm failures
   identify the intended old assumptions; then complete the full-row oracles.
   A setup failure, raw-row leak or different failure is a stop, not a pass.
4. Run the positive and failure fixtures, then the four isolated mutation
   controls. Confirm each control fails at its named redacted assertion. Keep
   a command/status record with no calibration rows or child streams.
5. Edit only `docs/versioning-workflow.md` using the release-document recipe.
   Review its commands as future private operator steps; do not execute them
   in this repair. Run the wrapped focused test, prose checker, doc-hygiene
   checker and diff check. Stop on a red base gate or a changed contract.
6. Commit the two-file repair only after independent exact-commit plan review.
   A separate verifier inspects the resulting diff, source image hashes,
   redaction behavior, fixture outcomes and exact command exits. A subsequent
   release and any PR need their own approvals; this plan grants neither.

## Claim and evidence limit

The checked-in test copies the writer, path manifest, SQL and seven database
images to a temporary tree, then requires exactly two rows after its synthetic
two-row seed. Its second case equates the whole table count to the number of
seed INSERT statements. Both assertions reject images that already contain
calibrations. The writer uses `INSERT OR IGNORE`, so the correct row set is the
initial set plus seed keys that were absent; an existing key keeps all its old
column values, even when the seed conflicts. `docs/versioning-workflow.md`
Step 1a and its checklist explicitly disable bundling for this test defect.

The coordinator's saved disposable-tree probe reports that the unchanged first
test passed on the supplied base and failed with `3 !== 2` after one distinct
synthetic row was added to each copied image. That is historical coordinator
evidence, not a check run for this draft. The finder inspected the second
count assertion without executing a populated case for it. Source inspected:
`scripts/test-apply-chameleon-calibration-seed.js`,
`scripts/apply-chameleon-calibration-seed.js`, `scripts/seed-db-paths.js`,
`scripts/refresh-chameleon-calibrations.js`, the table schema, the migrations
workflow, and the release instructions in the immutable base. No seed contents
or database rows were printed here.

## Scope and owned files

After admission, change only
`scripts/test-apply-chameleon-calibration-seed.js` and
`docs/versioning-workflow.md` for #410. Keep the real writer, generator,
manifest, tracked database images, SQL snapshot, schema, workflow and guards
unchanged. The test must continue to execute the actual writer from a temporary
repository-shaped tree with the actual seven manifest paths. All fixture SQL
and writer file mutations stay there. It must never invoke the writer against the
source checkout.

The snapshot retrieval, credentials, row review of actual release data,
database-image update, release commit, tag, deployment and publication are a
separate release action. This campaign plan neither performs nor approves it.

## Test edit recipe (future work, UNRUN)

1. Retain `sandbox()` and `runApply()` as the isolation boundary. `sandbox()`
   must remove its newly made root in its own `catch` if any copy or seed write
   throws before it returns. Wrap each case in a second `try/finally` that
   removes a returned root and checks the seven source-image hashes even when
   setup or an assertion fails. Add an explicit
   seven-path expectation beside the manifest import, with these exact strings:

   ```text
   conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
   conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
   conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
   conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
   database/farming.db
   web/react-gui/farming.db
   ```

   Assert both the source manifest and the manifest copied into each sandbox
   equal that list before running the writer. A manifest accidentally
   shortened to six must fail rather than redefining the test's meaning.
   Record SHA-256 of all seven source images before fixture
   setup and assert those source hashes are unchanged after each case, including
   failures. Keep temporary-tree cleanup in `finally`.
2. Replace `calibrationRows()` with a full-row reader over all 17 columns,
   ordered by `array_id`. Use `spawnSync('sqlite3', ['-readonly', '-json',
   dbPath, SELECT_17_COLUMNS], { encoding: 'utf8' })` on temporary images.
   The explicit column list is `array_id`, `sensor_id`, `sensor1_a/b/c/r2`,
   `sensor2_a/b/c/r2`, `sensor3_a/b/c/r2`, `test_rig_run_start_date`, `source`,
   `fetched_at`. Capture stdout/stderr in memory. A child error, signal, or
   nonzero status raises a new sanitized `row-query` error. On status 0,
   `stdout.trim()` equal to `''` means the valid zero-row result `[]`;
   otherwise parse the nonempty stdout as JSON and require an array. A parse
   failure or non-array result raises a new sanitized `row-json` error.
   These branches report only the manifest path and class, discarding child
   errors, captured streams and parse text; attach none as `cause`. In
   executable form, the decision is:

   ```js
   if (r.error || r.signal || r.status !== 0) failRedacted(rel, 'row-query');
   if (typeof r.stdout !== 'string') failRedacted(rel, 'row-json');
   const out = r.stdout.trim();
   if (out === '') return [];
   let rows;
   try { rows = JSON.parse(out); }
   catch { failRedacted(rel, 'row-json'); }
   if (!Array.isArray(rows)) failRedacted(rel, 'row-json');
   return rows;
   ```
3. Compare maps with explicit loops, not `assert.deepEqual()` on row objects.
   First compare lengths and key membership; then compare each of the 17
   column values with `Object.is` (including nullable `sensor*_r2` and date
   metadata). On failure, throw a new error containing only the manifest path,
   mismatch class (`key-set`, `field-value`, or `collision-preservation`) and
   column name where applicable. Never put an actual key, row object, SQL
   literal, child stdout/stderr, or JSON parse text in the error, attachment,
   test name or CI log. Replace the existing `assert.equal(r.status, 0,
   r.stderr || r.stdout)` pattern with a helper that reports only a fixture
   label, the numeric status or signal, and `writer-exit`. For expected
   failures, test the captured diagnostic with a boolean regex and raise only
   `expected-diagnostic-absent` if it does not match; `assert.match()` would
   print the raw stream on failure.
4. Pin synthetic expectations independently of the SQL. Write two hand-coded
   `INSERT OR IGNORE` statements in `SYNTHETIC_SEED`, and separate literal JS
   expected objects *before* `runApply()`. Do not parse the synthetic SQL or
   use a post-run query to construct the expected values. Give each coefficient
   a distinct value so a channel or column swap is visible. This is the
   proposed complete expected pair; write the SQL literals separately with
   exactly these values:

   ```js
   const EXPECTED_S1 = {
     array_id: 'TEST-ARRAY-1', sensor_id: 'T001',
     sensor1_a: 1.1, sensor1_b: 1.2, sensor1_c: 1.3, sensor1_r2: 0.91,
     sensor2_a: 2.1, sensor2_b: 2.2, sensor2_c: 2.3, sensor2_r2: 0.92,
     sensor3_a: 3.1, sensor3_b: 3.2, sensor3_c: 3.3, sensor3_r2: 0.93,
     test_rig_run_start_date: '2024-01-01T00:00:00Z',
     source: 'bundled', fetched_at: '2026-01-01T00:00:00Z',
   };
   const EXPECTED_S2 = {
     array_id: 'TEST-ARRAY-2', sensor_id: 'T002',
     sensor1_a: 4.1, sensor1_b: 4.2, sensor1_c: 4.3, sensor1_r2: 0.94,
     sensor2_a: 5.1, sensor2_b: 5.2, sensor2_c: 5.3, sensor2_r2: null,
     sensor3_a: 6.1, sensor3_b: 6.2, sensor3_c: 6.3, sensor3_r2: 0.96,
     test_rig_run_start_date: null,
     source: 'bundled', fetched_at: '2026-01-02T00:00:00Z',
   };
   ```

   Pin the prepared-row expectations separately as well:

   ```js
   const EXPECTED_UNRELATED = {
     array_id: 'TEST-EXISTING-1', sensor_id: 'T900',
     sensor1_a: 70.1, sensor1_b: 70.2, sensor1_c: 70.3, sensor1_r2: null,
     sensor2_a: 71.1, sensor2_b: 71.2, sensor2_c: 71.3, sensor2_r2: 0.71,
     sensor3_a: 72.1, sensor3_b: 72.2, sensor3_c: 72.3, sensor3_r2: 0.72,
     test_rig_run_start_date: '2023-01-01T00:00:00Z',
     source: 'prior', fetched_at: '2025-01-01T00:00:00Z',
   };
   const EXPECTED_OVERLAP = {
     array_id: 'TEST-ARRAY-1', sensor_id: 'T901',
     sensor1_a: 81.1, sensor1_b: 81.2, sensor1_c: 81.3, sensor1_r2: null,
     sensor2_a: 82.1, sensor2_b: 82.2, sensor2_c: 82.3, sensor2_r2: 0.82,
     sensor3_a: 83.1, sensor3_b: 83.2, sensor3_c: 83.3, sensor3_r2: 0.83,
     test_rig_run_start_date: '2023-02-01T00:00:00Z',
     source: 'prior', fetched_at: '2025-02-01T00:00:00Z',
   };
   ```

   Hand-code fixture SQL independently of these objects and assert the
   prepared rows match them before running the writer. The post-run
   expectations are literal sets: empty `{S1,S2}`; unrelated
   `{UNRELATED,S1,S2}`; overlap `{UNRELATED,OVERLAP,S2}`. For divergent input,
   use the fixed key list `TEST-EXISTING-1` through `TEST-EXISTING-7`, with
   the old overlap on manifest indices 0, 2 and 4 only; the other four paths
   expect incoming S1. Give each unrelated row the same 16 non-key values as
   `EXPECTED_UNRELATED`, but its listed distinct key, in independently
   hand-coded fixture SQL and expected objects. These tokens are SQLite
   writer fixtures, not runtime 16-hex array-ID examples.
5. For the checked-in SQL integration case only, learn proposed rows by
   applying that SQL to a separate cleared disposable copy. Build the expected
   map from each target's starting rows, adding proposed keys only when absent;
   compare the full map with the redaction-safe helper. This tests supplied
   snapshot application, not omission within that snapshot. Keep all actual
   rows in memory and never dump them. After clearing the oracle copy and
   *before* applying checked-in SQL, assert its full-row reader returns `[]`.
   For each copied starting image, an empty reader result is a valid initial
   map and must still pass the seven-path loop. Run the oracle's
   `sqlite3 -bail` child
   with captured streams and a sanitized `snapshot-oracle-exit` error on
   failure; neither `execFileSync`'s raw thrown error nor JSON parse text may
   reach `node:test`. Ordinary empty SQL remains allowed unless
   `--require-rows` is passed.
6. Use two fixture families. For parity cases, clear and populate the seven
   copied temporary tables identically, then hash those *prepared temporary
   files immediately before each* `runApply()` (including reapplication).
   Require one input hash and one output hash plus the exact row maps. A
   source-image parity check before fixture preparation does not prove this
   boundary. For divergent input, assert its prepared rows against the fixed
   per-path expectations and compare each output to its own expected map;
   never require output byte parity. In the checked-in SQL case, hash the
   seven copied inputs immediately before the writer and assert output byte
   parity only if those copied input hashes already match. `INSERT OR IGNORE`
   preserves differences in divergent inputs.

### Fixture matrix (all proposed, UNRUN)

| Case | Setup and exact oracle |
|---|---|
| Empty, parity | Clear all seven temporary tables; before the writer, assert the full-row reader returns `[]` for each of the seven paths, then verify prepared-input hash parity. Apply a two-row synthetic seed with `--require-rows`. Every target equals the fixed `{S1,S2}` full-row set and output hashes match. Recheck prepared-input parity before a second application; row maps remain equal and output parity still holds. |
| Unrelated existing, parity | Put the same complete unrelated synthetic row in all seven copies and verify prepared-input hash parity. After the two-row seed, every target equals fixed `{UNRELATED,S1,S2}`; all old column values remain and output hashes match. |
| Identical overlap, parity | Put `OVERLAP` and `UNRELATED` in every copy and verify prepared-input hash parity. After application every target equals fixed `{UNRELATED,OVERLAP,S2}` with the old `sensor1_a: 81.1`, sensor ID and metadata, and output hashes match. This pins current `INSERT OR IGNORE` collision behavior. |
| Divergent input | Give each copy its listed distinct unrelated row and put `OVERLAP` on indices 0, 2 and 4 only. Assert each prepared full-row set, then compare each output with its fixed per-path set. `S2` lands everywhere; `S1` lands on indices 1, 3, 5 and 6; the other three retain `OVERLAP`. No output byte-parity assertion is made. |
| Checked-in SQL | On unmodified temporary copies of the seven current images, snapshot complete starting rows, accepting `[]` for any empty table without skipping its path. Clear the separate temporary oracle copy and assert its reader returns `[]` before applying checked-in SQL there. Hash the seven copied inputs immediately before running the writer. Compare every final row against the initial-wins union by the redaction-safe helper. Assert seven-path coverage. Assert output byte parity only if copied input hashes matched. |
| Missing target | Preserve the existing last-path omission case. Require nonzero status, the expected missing-database diagnostic, unchanged SHA-256 of all six present temporary originals, and no temporary image files. |
| Empty snapshot refusal | Preserve `--require-rows` with SQL containing no INSERT. Require nonzero status, its empty-snapshot diagnostic, unchanged hashes for all seven temporary originals, and no temporary image files. |
| Staging SQL failure | Preserve the broken-table case on the last temporary image. Require nonzero status, unchanged hashes for all seven originals, and no `.calibration-tmp` or other `farming.db*` strays. It proves failure before replacement only. |

The first old fixed-count failure on a populated fixture is historical
coordinator evidence (`3 !== 2`), not a run by this author. The second old
assertion needs its own **UNRUN** reproduction before amendment. Make a
disposable repository tree containing the *unchanged* old
`scripts/test-apply-chameleon-calibration-seed.js`, writer, manifest,
checked-in SQL and seven copied images. Clear only the seven copied
`chameleon_calibrations` tables and add one complete synthetic
`TEST-COUNT-2` row to each copied table. No source DB or copied program/SQL
file changes. `TEST-COUNT-2` is outside the runtime 16-hex key form, so it
cannot collide with a generated release row. From the disposable tree, run
this exact old-test selection, capturing its own status and private TAP
output without a pipe:

```bash
cd "$ISSUE410_DISPOSABLE_ROOT" || exit 2
if node --test --test-name-pattern='^the bundled seed SQL applies to every target$' \
    scripts/test-apply-chameleon-calibration-seed.js > old-second-count.tap 2>&1; then
  old_second_exit=0
else
  old_second_exit=$?
fi
```

Require `old_second_exit` to be nonzero *and* the selected old assertion to
show `actual = expected + 1`, where `expected` is the checked-in SQL
INSERT-statement count and `actual` is the table count with the one distinct
`TEST-COUNT-2` row. Inspect the private
TAP only to classify the failure as that old count assertion, with numeric
actual/expected values. A setup, missing-file, SQLite, parse or unrelated
assertion failure does not satisfy this control. Report only `old second
fixed-count mismatch`, the command's own numeric exit status, and the two
numeric counts; do not attach raw TAP or row data. Remove that TAP with the
disposable tree after recording the classification. Keep the first old
`3 !== 2` result separately attributed to the coordinator until an admitted
independent rerun. The amended populated cases must then pass.

The following mutation controls are also **UNRUN** and run only on disposable
test copies or candidate files. Each leaves the expectation objects above
unchanged and reports no row contents:

| Mutation | Required failure |
|---|---|
| Delete the `TEST-ARRAY-2` INSERT from the temporary `SYNTHETIC_SEED`, still expecting `{S1,S2}` in the empty parity case. | `key-set` on the first manifest path. The missing key itself stays out of the error. |
| After the writer returns in the empty parity case, run `UPDATE chameleon_calibrations SET sensor2_b=41.25 WHERE array_id='TEST-ARRAY-2'` on the first temporary image. | `field-value` naming `sensor2_b`; expected S2 remains 5.2. |
| After the writer returns in the identical-overlap case, run `UPDATE chameleon_calibrations SET sensor1_a=1.1 WHERE array_id='TEST-ARRAY-1'` on the first temporary image. | `collision-preservation` naming `sensor1_a`; fixed old value remains 81.1. |
| Remove the last path from the *copied* `scripts/seed-db-paths.js` before the writer runs; have the test load and check that copied manifest against the frozen seven-path list. | `seven-path` assertion before writer execution. |

No mutation control edits the production writer or source databases. Its
failure is evidence only if it reaches the named oracle for the stated
reason; a setup or parse failure is not a pass.

## Release-document edit recipe (future work, UNRUN)

Replace the current Step 1a heading and paragraph with a bundling procedure.
All inspection below is a future release-operator action in a private local
terminal without session logging, `tee`, redirected output, CI, or an agent
transcript. The operator supplies the token privately. No real calibration
fetch, row inspection, or database mutation belongs to this #410 repair.
Inspect every generated SQL `INSERT` and every final table row; counts and
samples cannot substitute. Record only `review passed` or `release stopped`
and the nonidentifying reason category. Never copy identifiers, rows or
credentials into a PR, issue, CI log, release note or campaign report.

Use this proposed Step 1a text, subject to independent prose review. All
commands in it are **UNRUN** here:

> ### Step 1a — Bundle Chameleon calibrations
>
> Before the release commit, obtain the calibration snapshot with the
> refresh script using an operator-supplied admin token in a private,
> unrecorded local terminal. First run the seven-image parity gate. If it
> fails, stop the release and inspect each image separately; one image is
> representative only after the gate passes. Inspect every generated SQL
> row and every preexisting bundled-table row across all 17 columns.
> Review names, deployment-linked device identifiers, private mappings and
> other fields that may be unfit for a public repository. Decide whether
> every identifier is publishable. For each `array_id` present in both the
> snapshot and the old image, decide whether retaining all old column values
> is correct. Approve that retention explicitly or stop the release for a
> separately reviewed update policy.
>
> Apply the reviewed snapshot to all seven bundled images with
> `--require-rows`; an empty-snapshot refusal stops the release. Run the
> seven-image parity gate again *before* using one image to inspect the final
> table. Inspect every final row and all 17 columns, including rows retained
> by `INSERT OR IGNORE`. If parity fails, stop and inspect each image; do not
> assume the representative row set covers the others. Record only
> `public-row review passed; retained-old-value collisions approved` or
> `release stopped: <nonidentifying category>`, without identifiers or row
> values. Run
> the remaining checks, then commit the SQL and all seven images with the
> release change.

The Step 1a command block should contain the following **UNRUN** future
commands. `quote()` makes SQL `NULL` visibly `NULL` and an empty text value
visibly `''`; each projection retains its column name. The same query covers
all 17 columns and every row before and after application. Its output is for
private visual inspection only. The operator must scroll through every row,
including nullable `sensor*_r2` and metadata; do not capture or publish it.

```bash
OSI_ADMIN_TOKEN="$CALIBRATION_ADMIN_TOKEN" node scripts/refresh-chameleon-calibrations.js
# Private terminal: inspect every generated INSERT and decide publishability.
less database/seeds/chameleon-calibrations.sql
calibration_review_sql='SELECT
  quote(array_id) AS array_id,
  quote(sensor_id) AS sensor_id,
  quote(sensor1_a) AS sensor1_a,
  quote(sensor1_b) AS sensor1_b,
  quote(sensor1_c) AS sensor1_c,
  quote(sensor1_r2) AS sensor1_r2,
  quote(sensor2_a) AS sensor2_a,
  quote(sensor2_b) AS sensor2_b,
  quote(sensor2_c) AS sensor2_c,
  quote(sensor2_r2) AS sensor2_r2,
  quote(sensor3_a) AS sensor3_a,
  quote(sensor3_b) AS sensor3_b,
  quote(sensor3_c) AS sensor3_c,
  quote(sensor3_r2) AS sensor3_r2,
  quote(test_rig_run_start_date) AS test_rig_run_start_date,
  quote(source) AS source,
  quote(fetched_at) AS fetched_at
FROM chameleon_calibrations
ORDER BY array_id;'
node scripts/verify-seed-db-ledger.js
# Private terminal: inspect every old row and compare overlapping keys with the SQL.
sqlite3 -readonly -line database/farming.db "$calibration_review_sql"
# For each collision, approve retained old values or stop the release.
node scripts/apply-chameleon-calibration-seed.js --require-rows
node scripts/verify-seed-db-ledger.js
# Private terminal: inspect every final row only after seven-image parity passes.
sqlite3 -readonly -line database/farming.db "$calibration_review_sql"
node --test scripts/test-apply-chameleon-calibration-seed.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-profile-parity.js
```

Explain that the operator supplies `CALIBRATION_ADMIN_TOKEN` privately in the
shell environment; the placeholder is not a token or a retrieval step for
this campaign. The documented sequence is conditional: a failed parity gate
or disapproved collision stops it before the next command. When parity fails,
stop the release and run this **UNRUN** private fallback from the same shell.
It reuses the named, NULL-distinguishing 17-column projection on every
manifest path:

```bash
for db in \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db \
  web/react-gui/farming.db
do
  printf '%s\n' "$db"
  sqlite3 -readonly -line "$db" "$calibration_review_sql"
done
```

Do not commit or publish until parity is repaired and the review repeated.
`verify-seed-db-ledger.js` checks all seven
tracked image digests as well as ledger/schema fingerprints;
`verify-profile-parity.js` alone covers the maintained profile pair. The
focused writer test checks row values on temporary copies. Add
the following exact paths to Step 4's existing `git add` command, retaining
its other entries:

```text
database/seeds/chameleon-calibrations.sql
conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db
conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
database/farming.db
web/react-gui/farming.db
```

Replace the checklist line with:

```text
[ ] Step 1a — Refresh Chameleon snapshot; review every SQL, old and final row privately; approve or stop on collisions; apply with --require-rows; verify all seven images before representative inspection
```

Do not edit the actual snapshot in this #410 repair.

Future verification of this tests/docs-only patch, **UNRUN**: run the focused
Node test from the repository root and capture its own exit code and full
failure context; run the anti-slop checker on `docs/versioning-workflow.md`,
`node scripts/verify-doc-hygiene.js`, and `git diff --check`. The independent
verifier must inspect the final diff and source image hashes. If the release
action later changes SQL or DB images, it separately needs the seed/schema
parity gates and a fresh per-row public-data review at that release SHA.

## Separately tracked consistency gap

The writer stages all seven files and discards staged copies on SQL failure,
but then calls `fs.renameSync(tmpPath, dbPath)` seven times without a catch or
rollback around that loop. If a later rename throws after an earlier one
succeeded, the earlier target has already been replaced. The existing
broken-table test stops in staging, so it cannot prove all-or-none replacement.
The original #410 body calls the writer all-or-none, but its explicit to-do is
the fixed-count test and release checklist. Treat replacement failure as a
newly identified consistency issue, with its own disposition and review,
instead of expanding this repair into a multi-file transaction design or
calling staging-only evidence full atomicity. Correct the writer's broad
"any failure leaves every image unchanged" comment in that follow-up.

Proposed follow-up acceptance: use seven isolated temporary images and a
deterministic fault injection that fails a rename after at least one earlier
replacement. Record each original hash and the exact substituted point.
Specify and implement recovery for catchable replacement errors, then assert
all seven originals are restored byte-for-byte and no staged or backup files
remain. Separately state and test the policy for interruption or power loss;
do not infer crash consistency from the catchable-error test. The follow-up
must preserve nonempty-snapshot refusal and the current collision contract.
No follow-up issue is filed and no writer change is authorized by this plan.

## Review and execution boundary

R4 accepted the source direction; it did not review this plan commit. Obtain
fresh independent review bound to the exact commit before editing either owned
file. Execution must record base and candidate SHAs, exact commands, command
exit statuses, named negative-control failures, source hashes and limitations.
A different candidate requires fresh affected verification. The campaign's
current schema-2 physical-RAM policy governs any later executable work:
validate a pressure report younger than 45 seconds and sampler PID/start-time
identity before each wrapped launch, wait for any legitimate active heavy
registration, require at least 8 GiB available, clear a low-memory latch only
at 10 GiB, and terminate a registered command below 4 GiB. Swap occupancy is
telemetry. Do not start new heavy work after 2026-11-01T22:30:00Z or continue
campaign work past 22:59:00Z. This plan contains no implementation approval,
issue closure, release snapshot or publication.
