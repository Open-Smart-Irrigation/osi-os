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

The follow-up starts at `1906a3803`: resume readiness is WARN, one commit behind
and four ahead of `origin/main` (`1a984f31f`), with AGENTS.md revision
`1f9c2c4b8`. The newer main runbook guidance concerns ChirpStack recovery and was
read without changing this PR's base or its repair-tool review surface.

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
publication. Self-review added an explicit durable-publication boundary: a late
cleanup error retains the verified replacement rather than restoring the old
catalog after its exclusion lock may have been released. Candidate identity as
well as content is checked before the swap. Caught errors additionally inspect FK ON/legacy OFF on the actual
repair connection before close. A killed connection cannot run `finally`; the
original remains intact and an unverified candidate cannot be published.

CI caught a preflight transport regression at `dbe85aaeb`: the guard spawned
SQLite CLI readers for the persistent reference-chain adapter. The adapter's
zero-subprocess test failed (3 calls instead of 0). The correction uses native
adapter reads and a dedicated forced-read-only CLI query method; the focused
baseline test is covered by GitHub CI on the final head.

The migrations job at `1906a3803` exposed a separate fresh-install regression:
the CLI adapter's read-only preflight ran before the first database file existed.
Seven unchanged add-column cases and the new absent-file test fail locally
before the correction (32 passed, 8 failed). The corrected guard accepts only a
missing path for the CLI adapter, without creating it. It still refuses a corrupt
catalog, a dangling symlink, an existing-file read failure and an incomplete
repair lock. Persistent adapters always query their existing handle, including
an in-memory database or uncommitted catalog changes. All 40 focused runner and
add-column tests then pass, with no skips or changes to existing assertions.

The CTO's updated gate rule uses GitHub CI on the exact final head for the full
migration, sync, smoke and shell suites. The queued full-suite wrapper was
cancelled before it ran. Local populated repair, rebuild and interruption tests
remain required through `osi-heavy` regardless of CI status.
Current command results are recorded by head SHA in [PR #699](https://github.com/Open-Smart-Irrigation/osi-os/pull/699).
This report records the implementation and required validation; the PR body is
updated after execution rather than retaining an obsolete queue status here.

For this regression, the lead explicitly requires a complete local rerun of
`.github/workflows/migrations.yml` as well as the 51 populated qualification
checks. This overrides the earlier instruction to leave full suites to CI.
The local replay uses every validation command and its workflow environment,
including the cutover job, with logs and exit codes per step. Node 22 and the
SQLite CLI are already installed; the server source is an isolated snapshot of
its remote default branch because no matching EB19 branch exists. Each step
gets fresh private scratch space through the same `osi-heavy` reservation.

All 122 workflow command steps passed locally. The migration module batch passed
205/205, the deploy/baseline/CLI batch 561/561, the populated repair qualification
51/51 and the separate cutover job 15/15, each with no skips. The full workflow
retained nine existing conditional skips (optional MQTT restart and benchmark,
unavailable production columns, and six pending #520 composition cases). No
existing test or skip condition was changed. Per-command logs and exit codes
are retained in the package's local evidence directory.

| Gate | Command or evidence |
|---|---|
| Local populated repair, rebuild and interruption qualification | `node scripts/run-legacy-catalog-rehearsal.js` through `osi-heavy` with private tmpfs |
| Full suites | GitHub CI on the exact reviewed head: migration/seed checks, sync, smoke, shell fixtures, and `scripts/deploy-command-ledger-dependency.test.js` |
| Lightweight source checks | `node scripts/verify-agents-size.js`, `node scripts/verify-doc-hygiene.js`, the prose checker, test inventory, JS/shell syntax, and `git diff --check` |

The source checks passed during implementation. Full-suite results from a parent
head are not accepted for a later head. Local repair qualification remains
mandatory even when the CI runner also exercises its test driver. The
existing boot-node suite's production-column-capture skip is not a field
rehearsal. All new fixtures are synthetic.

## Sol review remediation

Sol reviewed `2479425fa` with three P1, four P2 and one P3 findings. The changes
below address all eight; they still require independent re-review on the new
head. The earlier command counts above describe `2479425fa`, not the revised
implementation. Follow-up readiness remains WARN: one behind/five ahead at
resume, intended base `origin/main` (`1a984f31f`), AGENTS revision `1f9c2c4b8`.
The branch history is preserved. Field count remains unknown.

| Finding | Revised behavior and regression |
|---|---|
| P1 catalog inventory | A literal `sqlite_` prefix test replaces wildcard LIKE. An unknown sqliteX trigger or index refuses; its object and source hash survive. |
| P1 reboot and retained original | `--prepare-offline` records prior service enablement durably, disables and verifies installed autostart links before downtime, and refuses pending boot enable scripts. Apply on the gateway requires this hold. The prepared-boundary power-loss fixture dispatches the real OpenWrt rc.common with shipped init files and proves the old writer does not start. Retained originals and restoration files are independent copies, with inode and hash checks. Explicit release checks the repaired DB, installed retirement flow and verified migration head before restoring recorded enablement. |
| P1 stock runtime | A streamed SQLite CLI adapter holds one connection throughout each fenced transaction. Node 20.18.3 runs availability, report, apply and both full profile boot functions on populated fixtures, including 64-bit IDs. Both profile configurations select the SQLite CLI and default BusyBox mkfifo; qualification checks those dependencies. No native addon or node:sqlite is required by recovery. |
| P2 detector | The shared shell/library predicate includes views and bounded exact legacy tokens. A historical view-only remnant refuses; a benign devices_oldest_seen_at column passes. Ambiguous exact text remains conservative. |
| P2 FK commit boundary | Foreign-key checking runs before COMMIT and again after rebuilding. A real orphan refuses report eligibility and rolls the staged catalog back to its original FK targets. |
| P2 first backup | EB19 uses its own strict online backup mode: available CLI, successful .backup, integrity=ok and runtime artifacts in one fsynced set. Failure retains evidence without a raw-copy fallback or service restart. |
| P2 missing-main evidence | WAL, SHM, journal, repair lock and durable writer hold are checked before a missing file is treated as fresh. The shell checks repair evidence again before seeding. Tests include dangling links and an actual committed orphan WAL; no main file is created and evidence remains intact. |
| P3 refusal scope | Refusal promises no database repair or migration and accounts for possible WAL-index creation. Incomplete locks point directly to receipt inspection, not a report command that would refuse the lock. The existing damaged-database message assertion now pins this narrower wording; its data/hash assertions remain. |

The adapter streams SQL-encoded storage classes into row witnesses so binary
values, embedded NULs, Unicode, full-precision reals and 64-bit integers do not
cross a lossy JSON conversion. Its private FIFO protocol rejects CLI
metacommands, suppresses ambient CLI init files, frames trailing SQL comments
and checks the required transport/JSON/FK capabilities before service downtime.
The Node 20 qualification runs on the workstation architecture with both
profile payloads; no ARM gateway or field catalog was accessed.

The new regression selection is RED on the reviewed parent: 16 failing tests,
including both sqliteX objects, view and substring cases, orphan sidecars/locks,
a committed WAL, staged orphan rollback and stock Node recovery. The expanded
qualification retains all original 51 cases and adds these review cases,
OpenWrt boot/release fixtures, mixed partially healed children and binary-value
preservation. Current final-head results and exact command logs are recorded
in the PR and package evidence. The full migrations workflow, including its
cutover job, is rerun locally through one osi-heavy reservation as requested.
The ordered corpus, seeds and both flows files remain unchanged; 0083 is free.

The revised local validation is green: migration modules 205/205, the complete
deploy/baseline/CLI batch 561/561, populated qualification 84/84, cutover 15/15
and deploy pin contract 55/55. Qualification retains all original 51 cases with
no skips, and includes both Node 20 full profile boot functions. Image dependency
checks cover SQLite CLI and default BusyBox mkfifo. The strict online backup
also passes as the last reader of a committed WAL without changing main/WAL
bytes. The final parent selection reproduces 22 failures, including acceptance
without a durable hold and misleading refusal wording.

The first complete 125-step replay had two stale assertions: the expected
missing-main refusal text and the static three-physical-file sidecar guard.
Their replacements assert the corrected wording and stronger physical/link
checks; byte/hash assertions remain. The complete affected batch and full sync
verifier were rerun, along with the latest native preflight and qualification
commands. All effective workflow results are green. Nine pre-existing optional
or pending-composition skips remain in the broad workflow. No new skips or test
filters were used in the final complete qualification.

For local reproduction, run the Node 22 harness with
`EB19_STOCK_NODE=/path/to/node-v20.18.3/bin/node`; CI provisions that executable
before returning to Node 22. The local Node 20 binary was verified against the
[versioned Node release checksums](https://nodejs.org/download/release/v20.18.3/SHASUMS256.txt).
Use the private-PID-namespace driver through osi-heavy as shown above. GitHub CI
on the pushed head and the separate Sol re-review remain external gates. The
PR's “Assumptions to confirm” records the conservative view/startup-script
refusals, workstation-only hardware qualification and pending flows reservation.

The CI launcher explicitly preserves `EB19_STOCK_NODE` and `TMPDIR` across
sudo's environment reset. A launcher-construction check is red on `3cf0a90fb`
and green with the correction. The stock-profile cases include that regression;
the local qualification is rerun for the launcher follow-up. Recovery code is
unchanged by this test-environment correction.

## Round 2 integration with atomic publication

Rebased the seven EB19 commits onto `bda200db`, including #714. No ordered SQL,
seed image or flows file changed. The deploy seed keeps its same-directory
staging, fsync and exclusive publication, with every recovery marker checked
again inside the publisher. Factory seeding and boot integrity defer to retained
EB19 evidence too; a marker arriving during restore staging keeps the original
main file in place.

The durable writer hold now uses `.osi-recovery`, shared with boot integrity.
Legacy EB19 names remain refusal aliases. Preparation still disables and verifies
both installed boot entries, covering old software already on a gateway. Deploy
suppresses identityd enablement and its pending UCI default until explicit
release. Every automatic Node-RED start checks the installed retirement payload
and repaired database; the init repeats the check after pending-switch repair.
The original cleanup trap covers an owed health start before the later deploy
exit handler is installed. Failed deploys leave the writers stopped.

Release requires the active payload's healthy state and a durable health receipt
bound to its real flow path and SHA-256. It consumes only the reviewed pending
enable script and restores the recorded enablement. A cut during release can be
retried: the tool re-establishes disabled boot entries before verification, then
finishes restoration and receipt archival. Internal repair rechecks prove their
own lock's device and inode; deploy and health starts still refuse that lock.

The absent-main fence now runs before the native adapter opens. Late migration
entry checks recovery evidence before its missing-DB return, and compatibility
metadata uses an existing-file-only read. Committed WAL and SHM bytes must remain
intact when the main file is absent.

Added native-adapter, publication-race and writer-handoff regressions. Validation
is queued as one serial osi-heavy batch, including the original qualification,
the new cases and every local migrations-workflow command. The shared runner is
occupied by firmware work. These changes have passed syntax, whitespace,
instruction-size and test-inventory checks; no new heavy pass is claimed yet.
The flows handoff remains unapplied and the field count remains unknown.
