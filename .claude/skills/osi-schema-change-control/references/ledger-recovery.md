# Ledger recovery

Part of the osi-schema-change-control skill; read SKILL.md first.

## Restamp rules

`scripts/restamp-fingerprints.js` and `scripts/baseline-existing-db.js` (Option B
Stage 0 — semantic-gated ledger baseline + fingerprint sync for pre-ledger
devices) are the **only** sanctioned ways to re-baseline
`schema_object_fingerprints`. `restamp-fingerprints.js` takes a DB path, refuses
if the path doesn't exist (specifically to avoid the `sqlite3` CLI silently
creating an empty file at a typoed path and "successfully" restamping that
instead), and calls `syncFingerprints` directly — recomputing live fingerprints
and replacing the whole `schema_object_fingerprints` table with them.

**When it applies:** only after a crash between a migration's schema commit and
its fingerprint stamp, where the live schema has been independently confirmed
correct (e.g. via `PRAGMA integrity_check` and a manual review of what the
migration was supposed to produce). It is a recovery verb for a known-safe state,
not a way to silence a real drift preflight failure. The actual on-Pi recovery
procedure/runbook for when and how to run this against a live gateway is owned by
`osi-live-ops-runbook`; this skill only states the rule of when the tool is
appropriate to reach for at all.

## Ledger numbering reconciliation

`scripts/reconcile-ledger-numbering.js` is the **only** sanctioned way to
recover a gateway whose `schema_migrations` ledger was stamped under a
foreign branch's own version numbering — currently two customer
lines (one valve-focused, one not), both audited (stabilization plan §3.5c,
2026-09-10) as mapping 1:1 by content onto main, just under different version
numbers. The symptom: that branch's version numbers collide with main's own
(e.g. `v22` is `journal_catalog_v2` on a customer branch, `valve_control` on main).
`applyPending` correctly refuses the moment it hits the mismatch (checksum
mismatch → `repair_required`) and `deploy.sh` aborts before the payload
flip — safe, but the device is then wedged with no forward path. Never
hand-edit `schema_migrations` to work around this.

**What it does, row by row, refuse-on-doubt throughout:**

1. **Exact match** — the ledger row's checksum equals a main migration's raw
   SHA-256 exactly (byte-identical content). Safe to remap without further
   proof; if the main migration is already at the row's own version number
   this is a no-op.
2. **Header-stripped match** — the checksum is unknown to main directly, but
   is recognized via a small vendored registry of the two known foreign
   lineages' own migration files (`scripts/fixtures/lineages/<lineage>/` +
   `CHECKSUMS.json` — vendored because a live device holds only the
   checksum, not the original foreign SQL text, and the only way to
   recognize that checksum again is to independently hold byte-identical
   source). Once identified, the tool strips the leading `-- risk: ...` /
   `-- NNNN: ...` comment block from both the known foreign text and every
   main migration and looks for a body-only hash match — exactly one
   candidate required (zero or more than one both refuse).
3. **Structural proof** (required before a header-stripped match is
   trusted) — builds `reference(target.version - 1)` (main's own migrations
   1..target-1 replayed via the real runner, reusing
   `baseline-existing-db.js`'s memoized reference chain), applies the known
   foreign migration text to one scratch copy and main's candidate to
   another copy of that *same* pre-state, and requires
   `scripts/semantic-schema-compare.js` (`snapshotSchema`/`compareSchemas`)
   to find **zero** diffs of any class. Anything else refuses that row —
   this is what catches a migration that merely *looks* like a renumbering
   but actually changed the DDL.
4. **Unknown checksum** (matches neither main nor the vendored registry) →
   refuse; possible orphan, never guessed.
5. **Batch-level ambiguity** — after per-row classification, any version
   slot claimed by more than one row (two rows mapping to the same target,
   or a remap landing on a slot an unrelated already-correct row already
   occupies) refuses every row in the collision, not an arbitrary pick.

**Apply** (`--apply`, never the default `--report` dry run) only proceeds
when *every* ledger row classified as `match` or `remap` — a single refusal
anywhere refuses the whole run and touches nothing. It requires
`writersStopped` (same contract as `migrate-cli.js`), takes the same
persistent, fsync'd, retention-pruned off-device backup `migrate-cli.js`
takes (reused from there, under `--backup-dir`), rewrites
`version`/`name`/`checksum`/`status` for every remapped row inside one
`BEGIN IMMEDIATE`/`COMMIT` (DELETE-then-INSERT, never UPDATE, so two rows
trading version slots can never collide on the `INTEGER PRIMARY KEY`
mid-transaction), then `syncFingerprints`, then an internal
`verifyReconciliationConsistency` self-check MUST return `ok` — otherwise
the byte image is restored from the backup just taken and the process exits
non-zero. This is deliberately narrower than `verifyHead` (used by `node
scripts/verify-head-cli.js`): `verifyHead` requires the applied set to equal
*every* migration main has ever shipped ("head reached"), which a
foreign-numbered device will not satisfy immediately after reconciliation
whenever it is genuinely missing whole features the other lineage never
had (a device that only ran the non-valve customer line has never run main's valve-control migrations
at all) — that is real pending work for the `applyPending` carry-forward
that follows, not a reconciliation failure. `verifyReconciliationConsistency`
checks only what reconciliation can actually guarantee: no row left
`repair_required`, every `applied` row's checksum matches main at that
version, and fingerprints are synced to the live schema. It never runs
migration DDL against the live/target database itself (structural proof
runs only against disposable scratch copies).

`--clear-repair-required` is a narrower, separate recovery path for a row
already stuck `repair_required` whose checksum, at its OWN current version
number, already matches main (e.g. a prior reconcile run committed the
remap but crashed before the status flip — the same "commit landed,
bookkeeping didn't" class of crash `restamp-fingerprints.js` recovers from,
just for the ledger's status column instead of fingerprints). It never
blindly clears the flag: a row whose checksum still disagrees with main is
left `repair_required` and reported, not silently unstuck — run the full
`--apply` classification first for those.

`deploy.sh`'s `run_schema_migration()` calls `--apply` automatically,
between the ledger inspection and `migrate-cli.js`, whenever the ledger's
checksum for the lowest applied version above the shared `0001`-`0021`
prefix disagrees with main's checksum for that same version number — a
main-numbered gateway's checksums already agree there, so it takes the
unmodified fast path (two read-only `sqlite3` queries, nothing fetched,
nothing invoked). If reconciliation refuses, the deploy aborts (existing
`run_schema_migration || exit 1` semantics) rather than proceeding onto an
unreconciled ledger.

`node scripts/verify-head-cli.js <db>` is a thin, read-only CLI wrapper over
`lib/osi-migrate`'s `verifyHead` (previously test-only) — use it to check
whether a device's ledger honestly matches main's expected head without
running any migration or reconciliation.
