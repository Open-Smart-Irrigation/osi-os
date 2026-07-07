# Option B Stage 0 — Edge Schema Canonicalization

**Status:** Spec, revised per review rounds 1–2 (accepted; implementation plan: [`docs/superpowers/plans/2026-07-07-option-b-stage0-canonicalization.md`](../plans/2026-07-07-option-b-stage0-canonicalization.md)) — refactor-program item 0.3, issue #88
**Scope:** osi-os edge only. No boot-node change (frozen, per `osi-schema-change-control`), no deploy.sh wiring (Stage 1), no Uganda execution (#87).
**Governs:** [`docs/superpowers/plans/2026-07-05-option-b-boot-path-cutover.md`](../plans/2026-07-05-option-b-boot-path-cutover.md) §2. Reshape decisions there (semantic reference, not fingerprint canonicalization; deploy-time CLI only) are SETTLED and not relitigated here.
**ADR:** [`docs/adr/2026-06-30-schema-and-contract-ownership.md`](../../adr/2026-06-30-schema-and-contract-ownership.md) — this spec's baseline tool is the **second** sanctioned schema-bookkeeping tool after `scripts/restamp-fingerprints.js`; see §E for its guardrails.

## Problem

The runner (`lib/osi-migrate`) is a real, tested migration engine, but it has never run against a live gateway DB. Three live gateways (kaba100, Silvan, Uganda) have schemas that grew via `deploy.sh` `ensure_*` idempotent repairs and the boot-node's inline DDL, not via the runner — so no field DB has a `schema_migrations` ledger, and the runner's preflight (`applyPending` refuses to proceed if live fingerprints don't match the stored baseline) has nothing to compare against. Before Stage 1 can invoke the runner on-device, every device needs a **baseline**: a ledger stamped at the migration version its live schema actually matches, verified by comparison against a canonical reference — not blind trust.

The naive approach — match against head (`0005`, once §D(a) lands) — cannot work: `0004` is a destructive CHECK-widening rebuild of `irrigation_schedules` that has reached zero live gateways (confirmed: `deploy.sh` has no path that runs destructive-class SQL, and the runner has never executed on-device). Meanwhile live devices already carry `analysis_views` — future-`0005` content that arrived early via `ensure_analysis_views_schema`. So a live device is `reference(3)`-shaped, **plus** early-arrived 0005 content, **minus** 0004 — no strict prefix of the reference matches it exactly. The gate must handle exactly this shape (§B), then let `applyPending` carry the device the rest of the way with its own writers-stopped/backup machinery (Stage 1, not here).

## Goal

Produce: (1) a canonical semantic reference that folds in every real, deliberate live-schema addition the migrations/seed are currently missing; (2) a semantic comparator usable both to gate baselining and (via a shared normalization primitive) to fix issue #107's `schema_sig` CHECK-blindness later; (3) a version-aware baseline tool that stamps a device's ledger at the migration version it actually matches, or refuses; (4) a pre-baseline repair for the one verified pre-`0001` gap (`sync_outbox` v2 columns); (5) a rehearsal procedure proving all of this against a real gateway DB copy before Stage 1 ever touches a live device.

## A. The canonical semantic reference

The reference is **`bootstrapFresh` replaying `database/migrations/ordered/*.sql` into a scratch DB**, exactly as `scripts/verify-seed-replay.js` already does — not a separate artifact. `seed-blank.sql` is kept equal to it (CI-enforced) so either can serve as "the reference"; the migrations are the versioned one because baselining needs a reference *per version*, not just at head.

**Versioning:** the reference is not one fixed schema — it is a function `reference(N)` = replay migrations `0001..N` into an empty DB. `scripts/baseline-existing-db.js` (§E) builds `reference(N)` on demand for whatever `N` it is testing, by assembling a temp directory containing only migration files `≤ N` and calling `bootstrapFresh` on it. Zero change to `lib/osi-migrate` — `loadMigrations` + `bootstrapFresh` already operate on "whatever `.sql` files are in the directory."

**What Stage 0 adds to the reference now:** `database/migrations/ordered/0005__analysis_views.sql` (§D(a)), plus the matching `seed-blank.sql` append and all-7-bundled-DB regeneration per the `osi-schema-change-control` walkthrough. Two hard requirements on `0005`, both forced by the fact that live devices already have the table:
1. **Idempotent DDL** — `CREATE TABLE IF NOT EXISTS` (there are no indexes/triggers on `analysis_views`; if any are ever added they get `IF NOT EXISTS` too) — so that when Stage 1's `applyPending` reaches `0005` on a device that got the table early via `ensure_*`, the migration is a clean no-op rather than a failure.
2. **Semantically identical to the live shape** — `0005`'s DDL must reproduce, semantically (per §C), exactly what `deploy.sh`'s `ensure_analysis_views_schema` creates today (8 columns incl. the `is_default IN (0,1)` CHECK, the `users(id) ON DELETE CASCADE` FK, `CURRENT_TIMESTAMP` defaults). Live shape wins by construction: the fleet already has these tables and we are canonicalizing reality, not rebuilding it. §B's tolerance rule *depends* on this identity — if the rehearsal comparator ever classifies live `analysis_views` as `extra_unknown` instead of `extra_forward`, that is a genuine finding that the ensure_* DDL and 0005 diverged, and 0005 is what gets fixed.

## B. Version-aware baselining with forward-drift tolerance

**Gate rule at candidate version N** — the device passes iff the comparator (§C) against `reference(N)` reports:
- zero `missing` diffs (reference-at-N object absent live),
- zero `changed` diffs (object present in both but semantically different),
- and every `extra` live object is classified `extra_forward` or `extra_allowlisted` (§C taxonomy) — i.e. each extra is semantically identical to an object that `reference(head)` introduces at some version `> N`, or is on the small named allowlist (§D(b)). Any `extra_unknown` fails the gate.

This is the **forward-drift tolerance** rule: live devices legitimately carry content from future migrations because the `ensure_*` deploy path delivered additive DDL ahead of the ledger. Tolerating *exactly* the extras that the migration stream itself will later (re-)apply — and nothing else — keeps prefix stamping sound: stamp `1..N`, and `applyPending` later runs `N+1..head`, where the destructive `0004` executes for real and the idempotent `0005` no-ops over the early-arrived table. Chosen over version-*set* stamping (stamp `{1,2,3,5}`, leave 4 pending — mechanically valid, since `applyPending` skips applied versions and applies unapplied ones in order): the set variant's search space is combinatorial, its ledger tells a confusing story ("5 applied before 4"), and the tolerance rule achieves the same end with one principled predicate and an honest prefix.

**Baselining precondition (operator order of operations):** the device must have completed a standard deploy of the CURRENT flows — refactor-program item 0.1 — including a reboot (so `sync-init-fn` has converged the trigger set to the current bodies, per §C's ownership note) and the current `ensure_*` pass, before baselining. Against a stale deploy the comparator correctly reports the deployment gap as `changed` triggers / `missing` tables and the gate refuses; that refusal is a feature, not a comparator bug. Sequence: deploy (0.1) → baseline → Stage 1.

**How N is determined** (`baseline-existing-db.js <db-path> [--version N]`):
1. `--version N` given: evaluate the gate only at `N`; pass/fail is binary. Operator escape hatch for a known device history.
2. Otherwise walk `N` from head down to `1`, evaluating the gate at each step; stamp at the **highest N that passes**. Head-down because it maximizes the stamped prefix (fewest replays) and fails fast on the expected fleet shape (today: `N=4,5` fail on the un-widened `irrigation_schedules` CHECK (`changed`); `N=3` passes with `analysis_views` tolerated as `extra_forward`).
3. **No N passes:** refuse and report. Print the classified diff for `N = head` and for the best-scoring N — fewest *failing* diffs, i.e. `missing + changed + extra_unknown`; tolerated extras don't count against the score — then exit non-zero. Stamp nothing. This is a real "non-migration drift" signal (e.g. the §D(c) gap before its repair runs, or a table this spec didn't anticipate) and must stop the baseline, not guess.
4. **Per-N reporting:** one log line per N attempted with the classified counts (`N=4: FAIL (1 changed: irrigation_schedules CHECK)`, `N=3: PASS (1 extra_forward: analysis_views)`) so an operator sees *why* higher versions failed and can judge the match point, not just that "some N passed."

No runner change is needed downstream — `applyPending` (`runner.js:27-42`) already skips any version present with a matching checksum and applies everything after it in order, under its existing writers-stopped/backup/postflight guarantees.

## C. Semantic comparator (`scripts/semantic-schema-compare.js`)

Order/whitespace-insensitive **set** comparison between a live DB and `reference(N)` (via `cliRunner`, matching `lib/osi-migrate`'s I/O style), with `reference(head)` supplied as a third input for forward-classification. Returns `{ ok, diffs }`; never throws on a mismatch (only on connection/IO failure) — mismatches are data, so §B's search loop can compare many N cheaply.

**Diff taxonomy** (every diff carries one class; §B consumes these):
- `missing` — reference(N) has it, live doesn't. Always failing.
- `changed` — both have it, semantic content differs. Always failing.
- `extra_forward` — live has it, reference(N) doesn't, and it is semantically identical to an object `reference(head)` introduces at a version `> N`. Tolerated (reported, non-failing).
- `extra_allowlisted` — live has it, and it is on the static named allowlist (§D(b): exactly `chameleon_readings.{swt_1,swt_2,swt_3}` today). Tolerated (reported, non-failing).
- `extra_unknown` — live has it and neither rule above applies. Always failing.

**Compared, per object:**
- **Tables** — set of table names (minus ignore-list below).
- **Columns**, per table — set of `(name, type, notnull, dflt_value, pk)` from `PRAGMA table_xinfo`, with `dflt_value` compared **through the shared `normalizeSqlClause`** (case/quote/whitespace-folded). Defaults are semantic: a wrong or missing default changes the behavior of every future insert that omits the column — precisely the drift class the gate exists to catch. If rehearsal against the kaba100 copy surfaces a real false-positive lineage class on defaults, document the concrete example and add a *targeted* normalization rule — do not exclude the axis wholesale. Column **order** is deliberately excluded: it's exactly the axis the reshaped plan ruled out of fingerprint canonicalization (live DBs got columns via `ADD COLUMN` in boot/deploy order; the seed declares them inline — order will never converge and carries no functional meaning).
- **Indexes** — set of `(name, unique, ordered-column-tuple)`; `PRAGMA index_xinfo` provides the ordered column list, and column order within a compound index is significant (query-planning semantics), so compare the ordered tuple, not a set.
- **Triggers** — set of trigger names **and** normalized body text. Trigger *logic* is the point — a same-named trigger with different behavior is exactly the drift class in `osi-schema-change-control`'s incident history (`trg_dp_chameleon_readings_outbox_ai`). Views (none exist in the edge schema today) are compared the same way — name + normalized body — so a stray live view cannot hide. **Ownership note:** live trigger bodies are owned by the deployed *flows* version — `sync-init-fn` runs `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` for all 30 triggers on every boot (verified: zero `IF NOT EXISTS`), so until Stage 2 a gateway's trigger state converges to whatever flows it last booted, not to the ledger.
- **CHECK constraints**, per table — extracted from `sqlite_master.sql` via a regex-scoped reader (a lighter-weight version of the sanctioned-exception rebuild's own CHECK-set extraction in `sync-init-fn`), normalized, compared as a set. This is the axis `PRAGMA` cannot see at all — and exactly issue #107's `schema_sig` finding.

**Normalization (shared, single implementation, reusable by #107):** one exported `normalizeSqlClause(text)` in `lib/osi-migrate/sql-normalize.js` — collapse whitespace; lowercase SQL keywords and identifiers **but not string literals** (matching `fingerprints.js`'s existing case-preservation rule); fold identifier quote styles (`"col"` / `` `col` `` / `[col]` / bare). `IN (...)` list reordering is not attempted (CHECK clause text is stable in `sqlite_master` unless hand-edited, which is already forbidden). This module is explicitly the seam for #107 — its `schema_sig` fix imports it rather than re-deriving normalization rules.

**Ignored entirely:**
- Column order (above).
- Ledger/bookkeeping tables `schema_migrations`, `schema_object_fingerprints` — runner-owned state; their presence is what baselining *decides*, not what it compares.
- `sqlite_*` internals — never enumerated by the queries used here in the first place.
- **`sqlite_sequence`** — SQLite's own `AUTOINCREMENT` bookkeeping, created lazily on first insert, so a fresh zero-row reference and a live DB with years of history differ on its mere existence for reasons with no schema meaning. Comparing it would produce permanent false-positive drift on every real device.

## D. Known live-only drift — dispositions

**(a) `analysis_views`** — table exists live (created by `deploy.sh`'s `ensure_analysis_views_schema`), absent from `seed-blank.sql` and all migrations (confirmed: zero DDL hits repo-wide outside `deploy.sh`). **Fold in** as `0005__analysis_views.sql` (`-- risk: additive`), under §A's two hard requirements (idempotent `IF NOT EXISTS`; semantically identical to the live ensure_*-created shape). Also: `seed-blank.sql` append, 7 bundled DBs, `verify-db-schema-consistency.js` `schemaContract` extension, per the standard walkthrough.

**(b) `chameleon_readings.swt_1/2/3`** — **allowlist as tolerated extras; do not fold in.** Verified directly in code, contradicting this project's working assumption that these are "diagnostic mirror columns written by current flows":
- `deploy.sh`'s `ensure_chameleon_schema` does `ALTER TABLE chameleon_readings ADD COLUMN swt_1/2/3` ("V42 — kept columns" block), so the columns exist live.
- The only INSERT into `chameleon_readings` (`Insert Chameleon Reading` node) does **not** include them in its column list.
- The only node computing calibrated kPa from `chameleon_readings`' raw resistance (`calibration-local-backfill`) writes results to **`device_data.swt_1/2/3`**, never back to `chameleon_readings`.
- The only two `UPDATE chameleon_readings` statements in the flows — in the `calibration-persist` and `chameleon-refresh-persist` nodes — set **only `calibration_status`**; no other UPDATE path exists (stated here so a future reviewer grepping `UPDATE chameleon_readings` doesn't conclude the spec missed them).
- `verify-db-schema-consistency.js`'s hand-maintained `chameleon_readings` contract (the CI-enforced column list) already excludes `swt_1/2/3`; only `device_data`'s contract has them.

So these three columns are genuinely dead: present live, never read, never written, not in the enforced contract, not in the seed. Folding them into the reference would canonicalize noise; removing them live is a `destructive`-class rebuild for zero functional gain — pure risk, against this program's "refuse-and-report beats auto-heal" bias. Resolution: they are the **entire initial content of the §C `extra_allowlisted` list** (a named `{table: [columns]}` denylist with this rationale inline), rather than a general "ignore all extra columns" rule, which would defeat the gate. If a future device is ever found writing real data into them, that's new information requiring a fresh decision.

**(c) `sync_outbox` v2 columns (`rejected_at`, `rejection_reason`, `last_retryable_failure_at`)** — present in `seed-blank.sql` and therefore in `0001`'s reference (they predate the ordered-migrations project; `0001` is the seed-equivalent baseline), confirmed **missing on live kaba100**, and — per the plan's Decision paragraph — **no existing healer adds them** (zero refs in `sync-init-fn` and `repair-pi-schema.js`). A device missing them fails the gate at every N with a `missing` diff, correctly: this is real pre-baseline drift the reference must not paper over. Since kaba100 is also the mandated rehearsal device (§F), the fix is **in Stage 0 scope** as a pre-baseline repair artifact:

**`scripts/repair-sync-outbox-v2.js`** — the ensure_* idiom, packaged as operator tooling:
- Refuses if the DB path doesn't exist (same anti-typo rule as `restamp-fingerprints.js`).
- Executes up to three statements via `cliRunner`: `ALTER TABLE sync_outbox ADD COLUMN rejected_at TEXT`, `... rejection_reason TEXT`, `... last_retryable_failure_at TEXT` — skipping any column already present per `PRAGMA table_xinfo` (the `ensure_*` duplicate-column no-op, implemented as a presence check rather than error-string parsing; idempotency contract: any subset may already exist, and re-running on a repaired DB is a clean no-op). Column types verified against `seed-blank.sql` (lines ~536–538: all three `TEXT`), so the repaired columns match `reference(1)` exactly under §C's `(name, type)` comparison — a type mismatch there would surface as a `changed` diff and defeat the repair's purpose.
- Refuses outright if `sync_outbox` is missing entirely — that is the #87 whole-table gap (§D(d)), not this repair's scope.
- Asserts afterward via `PRAGMA table_xinfo(sync_outbox)` that all three are present; exits non-zero otherwise.
- Never touches any other table, never writes data, never stamps ledger/fingerprints.
- It is deliberately **not** an ordered migration — `0001` already contains these columns, so no migration slot can express "add them to a pre-ledger DB." It runs on a copy as rehearsal step 0 (§F) and on-device inside the Stage-1/#87 windows immediately before baselining. **Retired (deleted) once the fleet is baselined** — consumed-or-deleted, per the ADR invariant.

**(d) Uganda missing whole tables (`sync_outbox`, `sync_link_state`)** — **explicitly out of scope.** This is the #87 catch-up artifact per plan §5, one rehearsed window combining catch-up + baseline. Stage 0 delivers the general tooling that window will use (comparator, baseline tool, and the (c) repair, which Uganda will also need once its tables exist); it does not run against Uganda's DB or author Uganda-specific catch-up migrations. Boundary: a device failing baselining on missing whole tables is a §B "no N passes" refusal — fix the device out-of-band (#87's procedure), then re-run baselining.

## E. `scripts/baseline-existing-db.js` — contract

**This is the second sanctioned schema-bookkeeping tool**, alongside `scripts/restamp-fingerprints.js` (the `osi-schema-change-control` NEVER-list statement "the only sanctioned re-baseline is restamp-fingerprints.js" is amended to name both — a DoD deliverable, not an implication). Its guardrails, mirroring why `restamp-fingerprints.js` is trusted:

- **Inputs:** `<db-path>` (required, must exist — a typo must never let the `sqlite3` CLI silently create and "successfully" baseline an empty file), `--version N` (optional; §B).
- **The gate:** §B's rule against `reference(N)` **must** pass before any write. On failure: print the full classified diff (per-object, per-class) to stderr, exit non-zero, **stamp nothing** — not a partial ledger, not fingerprints. This is the load-bearing safety property: a bad baseline-stamp is the plan's named biggest risk ("blessing a semantically-wrong schema... a future migration fails non-deterministically in the field").
- **The stamp, on gate pass:** two writes, both safe to re-run:
  1. `schema_migrations` rows for versions `1..N` with the **real per-file SHA-256 checksums from `database/migrations/ordered/CHECKSUMS.json`** (never recomputed from a possibly-divergent local migrations dir, never invented) — `status='applied'`, `app_version` tagged `'baseline-existing-db'` so a baseline-stamped row is forever distinguishable from a runner-applied one. A wrong checksum here bricks the device on its first real `applyPending`: the checksum-repair path (`runner.js:32-40`) marks `repair_required` and refuses — correct for real drift, self-inflicted if the baseline tool lied.
  2. `syncFingerprints(runner)` (the same export `restamp-fingerprints.js` calls) — replaces `schema_object_fingerprints` with the live schema's fingerprints, so `applyPending`'s drift preflight (`runner.js:19-25`) sees a consistent stamped-vs-live world on the next run.
- **Idempotency:** re-running at the same N re-derives the same gate result (the comparator is pure) and re-writes identical ledger rows (`INSERT OR REPLACE`, matching `ledger.js`'s `successInsertSql`) and re-syncs fingerprints — a no-op unless the live schema changed between runs, in which case re-running is the right recovery action. Re-running with a different `--version` is allowed: the gate re-evaluates from scratch; no "can't lower/raise N" special case, since the operation is compare-then-overwrite either direction.
- **Never does:** no DDL (read-only against the schema; write-only against the two bookkeeping tables `ensureLedger` creates), no data writes to application tables, no backup-taking (nothing destructive to back up against — if that reasoning ever feels wrong, the tool has scope-crept into Stage 1 and must stop), and it does not call `applyPending` — carrying a device from N to head is Stage 1's job under the runner's own writers-stopped/backup path, deliberately a separate blast radius from baselining.

## F. Rehearsal harness

Rehearsals run against byte-copies of real gateway DBs, never the live file. **The `analysis/kaba100-chameleon-zero-export-20260702/` copy referenced by the plan has moved** to `/home/phil/backups/kaba100-chameleon-zero-export-20260702/farming-kaba100-20260702T0754Z.db` — outside the repo (real farm data; never commit it). That 2026-07-02 copy is a **development fixture only** for iterating on the tools locally; before Stage 1 runs anything against a real gateway, pull a **fresh** byte-copy at execution time (`.backup` → `integrity_check` → transfer), per `osi-live-ops-runbook`.

**Expected fixture behavior:** the 2026-07-02 fixture predates the #105 flows deploy, so against it the comparator WILL report trigger `changed` diffs at N=3 (pre-`contract_version` bodies). That is the fixture being stale, not the comparator being wrong — do NOT loosen the tool. The local dry-run therefore first simulates item 0.1's standard deploy on the copy (boot-node trigger convergence from the seed's trigger set + the additive `ensure_*` equivalents), documenting the pre-simulation refusal as evidence of the §B precondition, before running steps 0–5 below. The rehearsal-of-record uses a fresh copy taken after the real 0.1 deploy, where N=3 is expected to pass directly.

**Rehearsal DoD** (all must pass on a copy before that gateway's Stage-1 window):
0. `repair-sync-outbox-v2.js` on the copy (§D(c)) — then re-run it once more to prove the no-op idempotency contract.
1. The comparator report over N = head..1 (via `baseline-existing-db.js --report`, which builds each `reference(N)` internally and never stamps; the bare `semantic-schema-compare.js` CLI compares two explicit DB files) — capture the per-N classified log. **This step must show live `analysis_views` classified `extra_forward` at N=3** — that classification *is* the proof that the ensure_*-created DDL and 0005 are semantically identical; an `extra_unknown` here is a genuine divergence finding, resolved by fixing 0005 to match the live shape (§A).
2. `baseline-existing-db.js` on the copy — gate passes at the step-1 N (expected: 3), stamps cleanly.
3. `applyPending` (existing runner, `writersStopped: true`) from N+1 to head on the same copy — `0004` executes for the first time against real historical `irrigation_schedules` rows (row shapes, CHECK-conforming values, FK to `irrigation_zones`), and `0005` must no-op over the early-arrived `analysis_views`.
4. Full postflight beyond the runner's internal checks: `PRAGMA integrity_check` = `ok`, `PRAGMA foreign_key_check` = zero rows, `verifyHead` returns `{ ok: true }`.
5. **Row-count invariants** — before baselining vs after `applyPending` to head, identical counts on: **`irrigation_schedules` (the headline check — it is the table `0004` rebuilds)**, plus every history-bearing table (`device_data`, `chameleon_readings`, `dendrometer_readings`, `dendrometer_daily`, `irrigation_events`, `zone_daily_environment`, `zone_daily_recommendations`, `analysis_views`). This is the mechanical check against the exact failure class in `docs/operations/edge-history-retention.md`.
6. Node-RED boots against the migrated copy (throwaway instance) with no schema-related errors — proves the post-`0004` `irrigation_schedules` shape breaks no query the flows issue.

Any rehearsal failure is a hold on that gateway's Stage-1 window, full stop.

## G. CI integration

**Runs in CI forever:**
- Comparator self-test (`node --test`) against synthetic fixtures with injected drift covering the full taxonomy: extra column, missing trigger, CHECK text differing only in whitespace/case/quote-style (must NOT fail), a changed default (MUST fail, per §C), an extra object identical to a forward-reference object (must classify `extra_forward`), the chameleon allowlist entry, and a `sqlite_sequence`-only diff (must NOT fail).
- `reference(N)` construction is what `verify-seed-replay.js` already builds and gates — kept green as `0005` lands (extending the existing check, not adding one).
- `baseline-existing-db.js` unit tests: gate-pass, gate-fail-stamps-nothing, checksums-come-from-CHECKSUMS.json-not-recomputed, idempotent re-run. `repair-sync-outbox-v2.js` tests: repairs a v1-shaped fixture, no-ops on a repaired one, refuses a missing path. Both wired into `migrations.yml` like `restamp-fingerprints.test.js` today.

**Operator tooling, not CI:** running the baseline/repair tools against actual gateway DB copies (no real farm data in CI, by design), and the §F rehearsal — inherently manual, per-device, per-window (same split as `rehearse-devices-rebuild.test.js` CI-automated vs the production-copy rehearsal being separately expected, per `osi-schema-change-control`).

## Non-goals

- **Stage 1** (`deploy.sh` invokes the runner on-device; lifting the additive-only gate) — separate spec, depends on this one.
- **Stage 2** (boot-node DDL removal) — gated on two clean fleet deliveries including Uganda.
- **Uganda catch-up itself (#87)** — this spec's tooling is a dependency of that window, not a replacement for planning it.
- **`writable_schema` surgery retirement (#93)** — separate, already-decoupled PR per plan §1.1; unrelated code path.
- **Fixing issue #107's `schema_sig`** — this spec builds the shared normalization (§C) as the seam #107 imports; it does not modify `osi-health-helper` or re-harvest the heartbeat allowlist.

## Definition of Done

- `0005__analysis_views.sql` merged (additive, idempotent, live-shape-identical per §A), `seed-blank.sql` + 7 bundled DBs updated, `verify-db-schema-consistency.js` contract extended, `verify-seed-replay.js` green.
- `lib/osi-migrate/sql-normalize.js` with the shared normalization, unit-tested standalone.
- `scripts/semantic-schema-compare.js` + full-taxonomy synthetic-drift suite, in CI.
- `scripts/baseline-existing-db.js` + suite (gate-pass, gate-fail, checksum-source, idempotency), in CI.
- `scripts/repair-sync-outbox-v2.js` + suite (repair, no-op, refuse-missing-path), in CI; marked for deletion once the fleet is baselined.
- `.claude/skills/osi-schema-change-control/SKILL.md` NEVER-list updated to name `baseline-existing-db.js` as the second sanctioned bookkeeping tool (and `repair-sync-outbox-v2.js` as a sanctioned, temporary pre-baseline repair).
- Rehearsal DoD (§F) executed and passing against a **fresh** kaba100 copy — written up as evidence, not just claimed.
- This document updated with the actual N found for kaba100 (expected: 3) and any surprises the rehearsal uncovered.
- No change to `sync-init-fn`, `deploy.sh`, or any live gateway in this slice.

## Open decisions

None outstanding. Review round 1 resolved the two structural gaps: strict prefix-equality could never match the real fleet shape (fixed via §B's forward-drift tolerance, which requires §A's 0005 idempotency), and the kaba100 rehearsal was unsatisfiable while the sync_outbox v2 repair was out of scope (fixed via §D(c)'s in-scope repair artifact). §D(b) stands on direct code evidence reversing the plan's working assumption: `chameleon_readings.swt_1/2/3` are dead columns, allowlisted rather than folded in.
