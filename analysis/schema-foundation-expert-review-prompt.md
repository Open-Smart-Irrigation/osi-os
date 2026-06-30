# Expert review prompt — schema-foundation design (round 1)

**Created:** 2026-06-30
**Purpose:** Self-contained prompt to get an outside expert critique of the edge
schema-migration foundation. Route to one or more external agents.
**Role:** staff/principal engineer — offline-first edge data systems, idempotent
embedded-SQLite migration + sync contract to a cloud RDBMS.

---

```
You are a staff/principal engineer who specializes in offline-first edge data
systems: idempotent schema migration for embedded SQLite running on
intermittently-connected devices, and the synchronization contract between
those edge databases and a cloud relational database. I want a critical,
opinionated review of a design decision — please push back hard rather than
validate. Disagree with the framing if it's wrong.

## System context
- Offline-first LoRaWAN smart-irrigation gateways. Each gateway is a Raspberry Pi
  running OpenWrt + Node-RED + SQLite (`farming.db`). Edge is the source of truth.
- A cloud server (PostgreSQL + Java/Flyway) mirrors edge state via a one-way-ish
  sync (edge→cloud telemetry over MQTT; cloud→edge commands via REST polling).
  Edge SQLite has sync triggers that enqueue change events into a `sync_outbox`.
- ~35 SQLite tables, ~19 sync triggers. There is one live PRODUCTION gateway
  (must not lose data); demo/test gateways are freely rebuildable.
- Hard rule: never reseed or overwrite a live device's farming.db. Schema changes
  on live devices must be strictly additive / backed-up.

## The problem
Schema knowledge is currently encoded in THREE drifted places on the edge:
  1. seed-blank.sql — full CREATE script used to seed a fresh device.
  2. An inline Node-RED function node ("sync init") that runs on every flow
     start: ~92 idempotent `ALTER TABLE ... ADD COLUMN`, a CHECK-constraint
     change done via table-rebuild (create new table, copy, drop, rename), and
     it creates a sync trigger that seed-blank.sql DOESN'T have.
  3. An ops repair script (Node CLI) with idempotent primitives
     (PRAGMA table_info introspection, addColumnIfMissing, CREATE IF NOT EXISTS).
A 4th node redundantly ensures 6 analytics tables (+79 more ADD COLUMNs).
Real drift exists between these (e.g., a trigger present in source #2 but missing
from #1, and vice versa).

## Proposed design (the thing to critique)
Collapse to ONE canonical, declarative schema MODEL in a shared module
(`lib/osi-schema/`), structured data (not SQL strings):
  - tables { columns[{name, sql_type, default, nullable}], checks, indexes },
    triggers {}, and a TARGET_VERSION constant.
Two outputs from the one model:
  - emitSeedSql()  → generates seed-blank.sql (full CREATE).
  - ensureSchema(runner) → idempotent migrator: CREATE TABLE IF NOT EXISTS →
    column reconcile (introspect existing cols, ADD missing) → CHECK-constraint
    rebuilds (backed up first) → CREATE TRIGGER/INDEX IF NOT EXISTS.
A "runner" abstraction lets the SAME logic run under two SQLite drivers: the
async node-sqlite3 driver (Node-RED runtime, called on every flow start) and a
synchronous sqlite3-CLI adapter (the ops script + tests).
Consumers become thin: the Node-RED bootstrap node calls ensureSchema(); the
analytics node drops its inline ensures; the ops script becomes a CLI wrapper;
seed-blank.sql becomes generated + verified in CI.
Minimal versioning: a schema_meta(version, applied_at) row + TARGET_VERSION;
NOT a full edge↔cloud contract version yet (that's a deferred later phase). This
module is explicitly intended as phase 1 of an eventual cross-repo contract that
would also generate the Postgres/Flyway side and TypeScript/Java types.

## Questions — be specific and concrete
1. Source form: structured-model-as-truth vs. SQL-as-truth + introspection. Given
   the eventual dual-target (SQLite edge + Postgres cloud), which scales better,
   and what are the failure modes of the structured-model choice?
2. "ensureSchema on every boot" (every Node-RED flow start) vs. versioned
   migrations applied once and recorded. Trade-offs for an offline device that
   may be on an old version for months? Is convergent/declarative ensure safer
   or more dangerous than ordered migrations here?
3. Idempotent convergence on a LIVE production SQLite DB: what failure modes are
   we underestimating? (interrupted table-rebuild, WAL/locking, busy_timeout,
   FK enforcement during rebuild, partial migration, power loss mid-migration,
   backup/rollback strategy.)
4. SQLite-specific reconciliation: no ALTER for CHECK constraints, can't ADD
   COLUMN with non-constant default, trigger drift. Best practices for making
   these safe + idempotent + testable?
5. Is the minimal version marker (single TARGET_VERSION + schema_meta) enough, or
   do we need per-object checksums / a migration ledger to detect partial or
   hand-edited divergence on a device?
6. Does this foundation correctly anticipate the cross-repo SQLite↔Postgres
   contract, or does it bake in edge-specific assumptions (e.g., boolean-as-
   INTEGER, TEXT timestamps, column-add semantics) that will fight the Postgres
   side later? What should change NOW to avoid a rewrite later?
7. Testing: we plan unit (emit==ensure round-trip), convergence-from-old-snapshot,
   idempotency (2nd run is a no-op), and a production-schema-copy dry run. What's
   missing or naive?

Give your strongest objections first. If you'd reject this approach, say what
you'd do instead and why.
```
