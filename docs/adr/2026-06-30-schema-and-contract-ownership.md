# ADR — Schema and cross-repo contract ownership

**Status:** Accepted — 2026-06-30
**Closes:** —
**Supersedes:** `docs/superpowers/specs/2026-06-30-schema-driven-codegen-design.md` (draft — schema-driven codegen / YAML DSL)
**Superseded by:** —

## Context

A draft spec proposed a canonical YAML DSL as the single source of truth for **all** structural domain definitions across both repos (osi-os edge, osi-server cloud), generating SQLite DDL, Flyway migrations, Java entities, TypeScript types, JSON Schema contracts, and channel manifests.

Investigation of the current state, plus four independent expert reviews of the proposal, established:

1. **There is no migration ledger and no general migration runner.** The dated `.sql` files in `database/migrations/` are orphaned (only two bespoke scripts apply anything). The de-facto edge migration engine is the inline Node-RED node `Sync Init Schema + Triggers` (`sync-init-fn`), which runs on every boot: ~92 idempotent `ADD COLUMN`s, a `devices` CHECK table-rebuild, trigger creation, and ~24 data `UPDATE`s — with all per-statement errors swallowed.
2. **Schema knowledge is triplicated and has drifted** across `seed-blank.sql`, `sync-init-fn`, and `scripts/repair-pi-schema.js`. Verified consequences: the boot rebuild recreated `devices` with a CHECK missing `AQUASCOPE_LORAIN` (downgraded every restart; fixed in `a646efe3`); `trg_dp_chameleon_readings_outbox_ai` existed in runtime but not the seed, and `sync_dendro_to_readings` vice-versa; `commands.schema.json` was missing the live commands `REMOVE_DEVICE_FROM_ZONE` and `UNCLAIM_DEVICE` (fix prepared in `41f431a9` on branch `fix/cmd-schema-remove-device-from-zone-drift`; **not yet integrated into the working branch — `verify-sync-contract` fails until it is**).
3. **A documented field history-loss incident** (`docs/operations/edge-history-retention.md`) was caused by an unfenced boot-time table rebuild cascading deletes into history tables. A FK-off fence was added and is CI-guarded.
4. **The edge and cloud databases have genuinely different jobs.** SQLite is canonical local edge state and operational runtime; Postgres is mirror, analytics, API serving, reconciliation, and history indexing. Their physical schemas differ on booleans (`INTEGER` vs `BOOLEAN`), timestamps (`TEXT` vs `TIMESTAMPTZ`), CHECK/constraint handling, trigger languages, FK enforcement, and JSON storage.

The reviews converged: the hardest problem is not "how do we spell `BOOLEAN` in two dialects," it is "how do we safely transform an unknown, months-old, live SQLite database without losing canonical edge data." A declarative final-state model does not encode the safe path through table rebuilds, FK fences, trigger changes, backfills, tombstones, and partial-failure recovery. Ordered migrations do.

## Decision

Adopt a hard ownership boundary between three layers:

1. **Edge SQLite DDL is owned by osi-os ordered migrations + a ledger.** This is the *only* executable schema authority on the edge. Migrations are versioned, idempotent, checksummed, transactional where possible, applied exactly once, and recorded in a `schema_migrations` ledger. Risky operations (table rebuilds, trigger replacement, backfills) carry explicit preflight/postflight checks and backups. (See Spec 1.)
2. **Cloud Postgres DDL is owned by osi-server Flyway**, independently. The two databases are **not** forced into one table model.
3. **Cross-repo compatibility is owned by versioned sync event/payload schemas**, not shared DDL. This extends the existing `docs/contracts/sync-schema/` surface into a governed contract package that *generates* types, fixtures, and docs and is enforced by CI. (See Spec 2.)

**We do not build a shared SQLite↔Postgres DDL generator.** The cross-dialect gap puts shared DDL generation on the wrong side of the line where declarative schema-as-code degenerates into per-dialect escape hatches.

### Governance invariant (the kill-switch)

The Spec 2 contract package may exist **only if** it generates artifacts that are actually consumed (types/fixtures) and CI proves the generated output matches the committed output. If it degrades into a hand-maintained shadow schema that nobody generates from, **delete it** — a stale non-executable model is worse than no model.

### Flip conditions (recorded so the decision stays honest)

We would revisit a declarative schema model (the rejected approach) only if **all** of these become true: there are multiple serious DDL consumers (not "maybe Postgres later"); the team can own a generator as product infrastructure; CI can replay generated migrations against real old DB snapshots; the model supports explicit imperative migration hooks; most changes are additive or mechanically diffable; and the table model itself is the cross-system API. That is not this system today.

## Consequences

- The edge gains a real, auditable migration system it currently lacks, eliminating the every-boot mutation class that caused the history-loss incident.
- Each repo evolves its own DDL freely; coordination happens at the payload boundary, where it belongs.
- Two efforts result: Spec 1 (edge migration foundation) is the safety-critical, pre-production deliverable; Spec 2's narrow **Tranche A** (command/event codegen + merge-gate CI) runs **in parallel** to close the live contract-drift class, while the rest of Spec 2 (full payload contract, release-compatibility, versioning — **Tranche B**) follows later.
- Column renames (e.g. `deveui`→`device_eui`) and any edge↔cloud `contract_version` negotiation are out of scope here and, if pursued, sit behind the Spec 2 contract once it exists.

## Alternatives considered

- **Full declarative DDL codegen (the superseded draft).** Rejected: premature for a polyglot, drift-prone, small-team system with one live production edge DB; the cross-dialect gap forces endless escape hatches; and a final-state model cannot express the safe migration path for live data.
- **Ordered migrations with no contract package at all.** Rejected as the end state: it fixes field-safety but lets typed payload/event semantics drift between repos (exactly the `REMOVE_DEVICE_FROM_ZONE`/`UNCLAIM_DEVICE` class). It is the correct *first increment* — hence Spec 1 first, with the narrow contract Tranche A in parallel.

## Boot-path migration cutover (Option B) — trigger conditions

The edge migration runner (Phase 1) exists but does not yet run on-device; the
Node-RED boot node still owns inline schema DDL (frozen — see AGENTS.md). Replacing
it with the runner is deferred until a real runtime migration need appears, AND the
deploy/boot machinery is designed first (preflight fingerprint, backup provenance,
fail-closed behavior, rollback, observability, post-boot verification) and rehearsed
on a copied production DB + rebuildable demo gateways. Promote Option B only when a
non-trivial production-bound schema change appears: a table rebuild, trigger
replacement, destructive cleanup, data backfill, or an ordering-sensitive migration.
Cleaning up the ~81 redundant inline ADD COLUMNs (and greening verify-sync-flow) is
part of this cutover, not a standalone task. Until then: freeze + guard the boot node.
