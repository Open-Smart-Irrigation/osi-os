# History repair convergence and drain budget

The manifest marker currently resets completed keys on every mismatching segment
comparison. A partial day takes several worker turns, so the five-minute manifest
can requeue rows before the day finishes. Issue #668 describes this loop.

Implementation scope is the existing `osi-history-sync-helper/index.js`, its two
profile copies, the history batch and manifest build/ACK nodes, and sync-state.
The cloud protocol stays unchanged. The progress indexes use an additive migration
and rebuilt bundled databases.

1. Add SQLite flow-harness regressions in
   `scripts/test-sync-history-repair-convergence.js`, registered in
   `.github/workflows/verify-sync-flow.yml`. Run them against the base and record
   the failures for unchanged refreshes and the 250-row drain budget.
2. Add a segment repair checkpoint in `app_settings`, committed atomically with
   its dirty keys. Hash the current canonical segment content. Preserve pending
   corrections and retry state. Completed keys are preserved only within an active
   partial repair generation. A fresh
   mismatch after that generation drains starts another round even before first
   parity and after upgrade. Carry a request epoch/sequence through the manifest
   nodes, and record the latest sequence at ACK time to reject stale answers.
   After three unsuccessful rounds for unchanged local content, retain a segment
   quarantine entry and expose its count; parity or changed content clears it.
   Scope generations to the linked account and server, so relink starts a fresh
   budget. Existing done keys without a checkpoint must be rechecked on upgrade.
3. Extract dirty-row selection into the helper. Load at most 250 repair rows or 50
   correction rows, stopping between row lookups after 200 ms. Keep table rotation
   and alternating live-tail service. Keep the existing HTTP request timeout and
   one request per turn; slow lookups may finish after the cooperative deadline.
4. Capture dirty timestamps and payload hashes in batch-local metadata. Before
   completing a key, check that its current content and timestamp still match the
   submitted row. Preserve the radio generation fence. An intervening correction
   must survive an older ACK, including a same-millisecond update.
5. Expose `historyRepairPendingByTable` from fresh SQLite counts on the existing
   authenticated `/api/sync/state` route. Include zeroes for supported tables.
   Extract the route's quick-check formatter to keep the node below its base size.
   Migration `0082__history_repair_progress_indexes.sql` adds partial indexes over
   pending cloud dirty keys and unresolved repair quarantines. Add them to the
   seed and schema contract, then rebuild all bundled images through the seed
   builder and reapply the committed calibration snapshot. No boot DDL changes.
6. Mirror payloads, run the flow editing and common-brief gates, inspect the diff,
   commit and file a draft PR. No reviewer delegation or review request is allowed
   by this writer brief; independent review remains pending with the lead.

Manifest processing examines at most 32 segments and 2,000 source rows per call,
plus one lookahead row. A single oversized segment can run alone up to 10,000
rows, preserving its atomic enqueue; a larger segment is quarantined explicitly.
Check a cooperative two-second deadline during preparation and inside the atomic
enqueue. Roll back an unfinished segment on expiry and retain its continuation;
three unsuccessful attempts become an unresolved repair quarantine. Each page
keeps its own continuation so pages of 500 do not continually restart at row one.
Source reads are capped with SQL LIMIT; hashing happens before the write
transaction. Individual SQL operations may finish after the deadline.
A segment blocked by its own table's pending-key capacity advances the page
continuation while preserving its retry eligibility on the next page wrap. Other
tables can proceed within the same work limits. A regression holds a 3,000-row
dendrometer segment behind one backed-off repair or correction, checks delivery
of following device history, then drains the blocked key and checks its retry.

Review regressions cover cloud divergence before first parity and on upgrade,
stale answers across ACKs, persistent mismatch exhaustion, a 100,000-completed-key
EXPLAIN plan, and 3,000 keys in eleven unchanged mismatching segments. Include a
slow-clock continuation case and verify that incomplete segments enqueue nothing.
The radio static guard traces callbacks through the extracted helper on both
profiles and rejects adapter bypasses and misplaced bookkeeping.

The 10,000-row test uses ten-table rotation, five-minute manifests and continuously
arriving tail rows. At 250 repairs per repair turn it requires 40 repair turns,
at most 80 table visits or 800 ticks: 6 h 40 min at 30 seconds per tick. With no
tail traffic it needs 400 ticks (3 h 20 min). These are scheduling estimates for a
Pi 4 when row loading fits the 200 ms budget and requests succeed within the tick;
they are not hardware measurements or bounds under network failure. Test the
deadline separately with an injected clock and slow row reads.

Verification commands: `node --test scripts/test-sync-history-repair-convergence.js
scripts/test-sync-history-queue-drain.js scripts/test-sync-history-manifest-paging.js`,
`node scripts/test-sync-history-worker.js`, the durable and radio history suites,
the task5b3 history suite, `verify-profile-parity.js`,
`verify-no-new-silent-catch.js`, `verify-test-inventory.js`, `verify-doc-hygiene.js`,
`verify-flows-size-ratchet.js`, `verify-flows-fn-parse.js`, `test-flows-wiring.js`,
`flows-bare-require-scan.js`, `verify-no-stray-ddl.js`, `check-mqtt-topics.sh`, the
PR-body slop check, and `git diff --check origin/main...HEAD`. Every command must
exit 0; heavy verification runs through `osi-heavy`, one job at a time.
For this correction, run every command in the workflow's standalone inventory
verbatim and record each exit code. The lead requested individual scripts instead
of rerunning the full sync verifier on the home disk; hosted CI runs that gate.
Add the schema verifier set and seed ledger check after the approved rebuild.

CI follow-up verification runs all eight `run-module-tests.js` commands from
`migrations.yml` with their exact file lists and the workflow
`OSI_BASELINE_RUNNER=node-sqlite` setting. Reconciliation and cutover suites derive
their expected pending lists from the ordered corpus, preserving the fixture's
fixed historical mappings. Run the interrupted-deploy suite and the slow cutover
rehearsal too. The live-identity verifier treats the silent-catch fixture count as
a ceiling of 72, allowing later cleanup; the dedicated ratchet still requires
the actual flow count to equal the fixture.
