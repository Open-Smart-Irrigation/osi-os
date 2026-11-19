# History repair convergence and drain budget

The manifest marker currently resets completed keys on every mismatching segment
comparison. A partial day takes several worker turns, so the five-minute manifest
can requeue rows before the day finishes. Issue #668 describes this loop.

Implementation scope is the existing `osi-history-sync-helper/index.js`, its two
profile copies, and the history build/mark/manifest-mark and sync-state flow nodes.
The cloud protocol, schema, migrations and bundled databases stay unchanged.

1. Add SQLite flow-harness regressions in
   `scripts/test-sync-history-repair-convergence.js`, registered in
   `.github/workflows/verify-sync-flow.yml`. Run them against the base and record
   the failures for unchanged refreshes and the 250-row drain budget.
2. Add a segment repair checkpoint in `app_settings`, committed atomically with
   its dirty keys. Hash the current canonical segment content. Repeated comparisons
   preserve completed keys, pending corrections and retry state. A changed segment
   may requeue completed keys; missing keys are always inserted. Existing completed
   keys without a checkpoint remain completed on upgrade. Unlink already
   clears dirty keys, so checkpoints cannot suppress repairs for a new account.
   A matched manifest records confirmed parity; a later mismatch starts a new
   repair generation, including when content changed on the cloud.
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
6. Mirror payloads, run the flow editing and common-brief gates, inspect the diff,
   commit and file a draft PR. No reviewer delegation or review request is allowed
   by this writer brief; independent review remains pending with the lead.

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
the task5b3 history suite, `verify-profile-parity.js`, `verify-sync-flow.js`,
`verify-no-new-silent-catch.js`, `verify-test-inventory.js`, `verify-doc-hygiene.js`,
`verify-flows-size-ratchet.js`, `verify-flows-fn-parse.js`, `test-flows-wiring.js`,
`flows-bare-require-scan.js`, `verify-no-stray-ddl.js`, `check-mqtt-topics.sh`, the
PR-body slop check, and `git diff --check origin/main...HEAD`. Every command must
exit 0; heavy verification runs through `osi-heavy`, one job at a time.
