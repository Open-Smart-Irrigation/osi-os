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
