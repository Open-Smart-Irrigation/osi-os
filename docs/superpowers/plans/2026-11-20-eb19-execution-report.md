# EB19 execution report

The CTO selected option B: fail closed during deployment, and repair supported
catalogs with an explicit offline tool. There is no runtime migration and no
0083. Field count: **unknown**. The flows retirement remains unapplied behind
EB2 and EB12. This draft awaits destructive-path review and the flows reservation.

The [analysis and flows handoff](2026-11-20-eb19-legacy-catalog.md) records the
source trace, implementation plan and exact decoded-function patch for both
profiles. Neither flows file, the ordered corpus, seed SQL nor bundled databases
changed. No gateway, host or cloud access occurred.

## Code and authorization

Resume readiness: READY at `9e7e3c69a`, intended base `origin/main` at
`ec822b556`, 0 behind/1 ahead, AGENTS.md source revision `c63103827`. The new
AGENTS line explicitly sanctions this copy-based offline recovery. The user
instructed a fast-forward continuation of draft PR #699 and a later Sol review.

Deploy's read-only database check now refuses matching table, trigger and index
SQL before its first live change, before checkpointing, and again at migration
entry. The migration CLI refuses before creating backup directories, pruning or
ledger inspection; `applyPending` refuses before ledger creation, and
`verifyHead` refuses before any fingerprint grace. The predicate and recovery
message are shared with the runner and checked against deploy's shell text.
The command-ledger pinned files are unchanged; their existing pins are retained.

The offline tool requires `--report` or `--apply --writers-stopped --backup-dir`.
Apply checks gateway procd state, sidecars and open handles, and refuses unknown
schemas. It rebuilds on a private copy, verifies schema and complete streaming
row/column/rowid digests, checks integrity and FKs, refreshes existing fingerprints
on that proven copy, and publishes by atomic rename only after a fsync'd backup
and retained original. Incomplete attempts retain their lock and receipt.

Initial support is the shipped schema with legacy FK-reference damage. A
surviving old parent, older or divergent schema, missing objects, or ambiguous
literal/comment matches are refused. The full historical-rename fixture also
has missing objects and is deliberately refused for separate qualification.
There is no inferred repair for unknown field shapes.

## Evidence and verification

All SQLite-heavy work uses:

```sh
osi-heavy wait --contain --scratch-tmpfs 1G --need-gib 8 -- <command>
```

The preflight regression test run against parent `9e7e3c69a` is RED: its
integrity-only probe accepts the populated damaged catalog (exit 0 where refusal
is required). The same test passes with the new guard. Original row-survival
characterization remains: deletion alone preserves 28 complete fixture rows
but leaves 26 FK violations and rejects telemetry INSERT.

A direct unisolated expanded run reached the new safety refusal on this
workstation: `/proc` denies inspection of an unrelated process. The tool's
refusal is retained. `scripts/run-legacy-catalog-rehearsal.js` runs the fixture
family in a private PID namespace so every fixture process is inspectable;
locally it uses an unprivileged user namespace, while CI uses its disposable
runner's sudo facility. This changes the test environment, not the production
check. Live-handle refusal is still exercised against a real open SQLite handle.

The suite covers report/apply CLI paths, all supported FK spellings, both profile
boot functions after repair, divergent-catalog refusal, source/candidate races,
64-bit IDs and AUTOINCREMENT high-water values, ledger/fingerprint agreement,
and SIGKILL before commit, after verification, before publication and after
publication. Caught errors additionally inspect FK ON/legacy OFF on the actual
repair connection before close. A killed connection cannot run `finally`; the
original remains intact and an unverified candidate cannot be published.

Verification results are recorded below after the queued runs complete. The
existing boot-node suite's production-column-capture skip is not a field
rehearsal. All new fixtures are synthetic.
