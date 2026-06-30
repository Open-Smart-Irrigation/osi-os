# Decision prompt — ordered migrations vs declarative schema model

**Created:** 2026-06-30
**Purpose:** Tie-breaker prompt for the A/B/C foundation decision. Route to one or
more external agents for an independent pick.
**Role:** principal-level data-platform / database schema-tooling architect.

---

```
You are a principal-level data-platform / database schema-tooling architect. You
have designed and operated schema-management systems across HETEROGENEOUS
datastores — embedded SQLite on edge devices AND server-side PostgreSQL — and you
have strong, experience-based opinions about when a declarative "schema-as-code"
/ codegen model pays off versus when plain ordered migration files win. I need
you to settle ONE architectural decision. Reason from first principles. Give a
clear recommendation, not a hedge. If you think both options are wrong, say so
and propose the right one.

## System (concise)
- Offline-first LoRaWAN irrigation gateways: each is a Raspberry Pi running
  Node-RED + SQLite (`farming.db`). The EDGE is the source of truth.
- A cloud server (PostgreSQL + Java/Flyway) MIRRORS edge state. Sync is via JSON
  event payloads (an outbox of typed events: e.g. DEVICE_DATA_APPENDED,
  UPSERT_ZONE). Cloud→edge is command polling. IDs are UUIDs (not autoincrement).
- Scale: ~35 SQLite tables, ~19 sync triggers. ONE live production device that
  must not lose data; other (demo/test) devices are freely rebuildable.
- Constraints: devices can be offline for months (may be many schema versions
  behind); supply-chain-minimal (committed artifacts, NO runtime codegen on
  device); a small team; CI is currently near-zero and being stood up.

## Current state (verified)
- There is NO migration ledger and NO general migration runner today.
- Schema knowledge is triplicated and has DRIFTED across: (1) a hand-authored
  full-CREATE seed file; (2) an inline Node-RED "schema init" function that runs
  on EVERY boot, performing ~92 idempotent `ADD COLUMN`s, a CHECK-constraint
  table REBUILD (create-new/copy/rename/drop), trigger creation, and ~24 data
  `UPDATE`s — with all per-statement errors swallowed; (3) an ops repair script.
- A documented field incident: an unfenced boot-time table rebuild cascade-
  deleted history rows. A FK-off fence was added and is CI-guarded.
- Dated `.sql` files exist in a migrations/ folder but are ORPHANED (nothing
  applies them in order; no ledger).

## The decision — pick one (A, B, or C) and justify
The long-term goal is to stop the drift AND eventually align the edge and cloud
on a shared cross-repo contract.

OPTION A — Ordered migrations, no model.
  Plain ordered, versioned, idempotent SQL migration files + a runner + a
  `schema_migrations` ledger (per-migration checksum/status), applied exactly
  once, transactional, with backup + preflight/postflight. The canonical seed is
  hand-authored SQL, CI-verified to equal "empty DB + replay all migrations."
  Cross-repo alignment is handled SEPARATELY at the sync event/payload layer
  (a versioned event/payload schema catalog); edge owns its SQLite DDL and cloud
  owns its Postgres DDL independently. No shared schema model.

OPTION B — Declarative schema-as-code model.
  A single structured/declarative schema model using LOGICAL/semantic types
  (boolean, timestamp, eui, uuid, enum, json, …). Generators emit the SQLite DDL
  + an idempotent "ensure" now, and later emit Postgres DDL + TypeScript/Java
  types from the same source. The model is the single source of truth; seed and
  migrations are generated artifacts, committed and verified in CI.

OPTION C — Hybrid.
  Ordered migrations as the executable truth for the edge now (Option A), PLUS a
  thin logical model used ONLY for type generation / documentation, deferring any
  cross-repo DDL generation until a real second consumer exists.

## Questions
1. Which option, and why — for THIS system specifically (edge SQLite source of
   truth, Postgres mirror via JSON events, offline-for-months devices, one
   production device, tiny team, polyglot)?
2. Under what specific conditions would your answer flip?
3. For a cross-repo edge↔cloud system, is the durable "contract" better expressed
   as a shared SCHEMA model (DDL) or as a versioned SYNC EVENT/PAYLOAD schema,
   with each side owning its own DDL? Why?
4. Where does declarative schema-as-code GENUINELY pay off, and where does it
   degenerate into "two schemas in a trenchcoat" (dialect overrides everywhere)?
   Does the SQLite↔Postgres gap (no native BOOLEAN, TEXT timestamps, CHECK-rebuild
   vs ALTER, trigger languages) put this case on the wrong side of that line?
5. Biggest 2-year regret risk of each option? What would you wish you'd done?
6. For offline devices that may jump many versions at once, do ordered migrations
   vs a final-state declarative "ensure" differ in safety? How?

Context, stated so you can push against it: three prior reviewers leaned toward
Option A (ordered migrations) and toward putting the cross-repo contract at the
sync-event layer. I want your INDEPENDENT take — if the declarative model
(Option B) is actually right for a polyglot, drift-prone, small-team system,
make that case forcefully. Lead with your strongest argument.
```
