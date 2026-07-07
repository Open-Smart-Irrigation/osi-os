# Expert architecture review — OSI OS (edge) + OSI Server (cloud)

**Created:** 2026-07-02
**Purpose:** Brief for a higher-tier model. Route this to the expert; if it has repo
access, point it at the artifacts listed under "Concrete artifacts." Otherwise the
brief below is self-contained enough to reason from. Ask for a thorough, critical,
independent analysis — it should push back on our decisions, not validate them.

---

```
You are a principal/staff-level software architect with deep, scar-tissue experience
in: offline-first edge/cloud data systems, embedded SQLite on constrained devices,
schema migration and drift control, polyglot persistence (SQLite ↔ PostgreSQL), and
sync/replication protocols. I want a THOROUGH, CRITICAL, INDEPENDENT analysis of a
body of work that was just done and planned across two repos, and then your opinion
on the best LONG-TERM architecture for both. Disagree freely; if our decisions were
wrong, say so and say what you'd do instead. Lead with your strongest points.

## The system (verified facts)
- OSI OS (edge): OpenWrt 24.10 firmware for Raspberry Pi 5 LoRaWAN irrigation
  gateways. Runs ChirpStack (LoRaWAN NS) + Node-RED (all backend logic, in a giant
  ~9.8k-line flows.json) + SQLite (`/data/db/farming.db`) + a React dashboard.
  Offline-first; the EDGE is the source of truth. ~35 SQLite tables, ~31 triggers.
- OSI Server (cloud): PostgreSQL + Flyway (~52 migrations) + Java/Spring backend +
  React frontend. It MIRRORS edge state; it is NOT authoritative. Sync is edge→cloud
  telemetry over MQTT + a `sync_outbox` of typed JSON events (e.g. DEVICE_DATA_APPENDED,
  UPSERT_ZONE); cloud→edge commands are delivered by REST polling (30s). IDs are UUIDs.
- Fleet: ONE live production gateway (its local history must never be lost); demo/test
  gateways are freely rebuildable. Small team. Supply-chain-minimal (committed
  artifacts, NO runtime codegen on device). osi-server currently has NO CI.
- Cross-repo divergence (real): device-type vocab differs (edge 6-7 types incl.
  AQUASCOPE_LORAIN/TEKTELIC_CLOVER; server `DeviceType.java` is a String-constant
  holder — not even a JPA enum — with 5, incl. a server-only GATEWAY); edge stores
  typed sensor columns (`device_data.swt_1..3`), server stores opaque JSONB
  (`sensor_data`); naming differs (`deveui`/`device_eui`, `user_id`/`claimed_by_user_id`,
  `dendrometer_readings`/`dendro_readings`); booleans are INTEGER on edge vs BOOLEAN on
  server; timestamps are TEXT on edge vs TIMESTAMPTZ on server. A shared JSON-schema
  contract exists (`docs/contracts/sync-schema/`) but was partial and had drifted
  (two live commands missing from the enum).

## The problem we tackled
Edge schema knowledge was TRIPLICATED and drifting across: (1) `seed-blank.sql`
(full CREATE for a fresh device); (2) an inline Node-RED node `sync-init-fn` that runs
on EVERY boot doing ~93 idempotent `ADD COLUMN`s (81 already in the seed → redundant),
a `devices` CHECK table-rebuild, trigger creation, and ~24 data `UPDATE`s — with ALL
per-statement errors swallowed; (3) an ops repair script. There was NO migration
ledger and no general runner (dated `.sql` files in `database/migrations/` were
orphaned). Documented harm: a field HISTORY-LOSS incident from an unfenced boot-time
`devices` table rebuild cascade-deleting child history tables; and a recurring
regression where the boot rebuild recreated `devices` with a CHECK missing a device
type (breaking that device type until an ops repair re-fixed it).

## What we DECIDED (an ADR), after rejecting a proposal and running several reviews
The original proposal was a canonical YAML DSL as single source of truth generating
BOTH repos' DDL (SQLite + Flyway) + Java/TS types + JSON-schema contracts. We rejected
it. The ADR decision ("Option C"):
1. Edge SQLite DDL is owned by ORDERED, versioned, checksummed MIGRATIONS + a
   `schema_migrations` ledger (the only executable edge schema authority).
2. Cloud Postgres DDL is owned INDEPENDENTLY by Flyway. The two DBs are not forced
   into one table model.
3. Cross-repo compatibility is owned by VERSIONED SYNC EVENT/PAYLOAD SCHEMAS — NOT
   shared DDL. A governed contract package may GENERATE types/fixtures (never DDL),
   enforced by CI, with a kill-switch: delete it if it rots into a hand-maintained
   shadow. No shared SQLite↔Postgres DDL generator.
Rationale the reviews converged on: the hardest problem is not "spelling BOOLEAN in
two dialects," it's "safely transforming an unknown, months-old, live SQLite DB
without losing canonical edge data" — which a declarative final-state model can't
encode (it doesn't know the safe path through rebuilds, FK fences, backfills,
tombstones, partial-failure recovery); ordered migrations do. The SQLite↔Postgres
gap puts shared DDL generation on the wrong side of "declarative schema-as-code vs
two-schemas-in-a-trenchcoat."

## What we BUILT and merged to production main
- Phase 1 (`lib/osi-migrate/`): a CLI-backed migration runner (applies ordered
  migrations exactly once via `sqlite3 -bail`, one process per migration = one
  connection); a `schema_migrations` ledger with per-object SEMANTIC fingerprints
  (PRAGMA table_xinfo/foreign_key_list/index_list/index_xinfo + normalized CREATE-SQL,
  to catch CHECK/partial-index drift that PRAGMA alone misses); online-backup +
  integrity/foreign_key checks; a `0001` baseline generated from `seed-blank.sql` and
  CI-verified to equal "empty DB + replay all migrations"; new CI. 45 tests. ZERO
  runtime/flow changes. It was hardened through ~4 external review rounds that caught
  real defects BEFORE merge: `PRAGMA foreign_keys=OFF` is a no-op inside a transaction
  (so destructive migrations toggle FK OUTSIDE the txn, writers stopped); without
  `-bail` sqlite3 commits partial work on error; schema-change + ledger-record must be
  atomic (compose the ledger insert into the migration txn), with post-commit
  postflight failure → terminal `repair_required` (not re-run); `verifyHead` must
  compare the full applied version+checksum list, not just the max version.
- Phase 2: fixed the recurring `devices` CHECK regression on the shipped flows; added
  a CI "runtime↔seed parity guard" that fails only when the SHIPPED flow DOWNGRADES
  the seed (device-type CHECK set or whole-flow trigger set); documented a boot-DDL
  FREEZE and explicit "Option B" trigger conditions. This was itself the output of a
  multi-role debate (architect / edge-reliability / SRE / product) that concluded:
  ship the guard now, FREEZE the boot node, and gate the bigger rewiring behind
  explicit conditions rather than doing it under production pressure.

## What we DEFERRED (documented + gated, NOT built)
- OPTION B — the substantive remaining work: rewire the inline boot-time schema DDL
  in `sync-init-fn` to CALL the Phase-1 runner instead (package `lib/osi-migrate` for
  Node-RED; invoke at deploy/boot via a state machine with preflight fingerprint,
  verified backup, fail-closed, rollback, observability, post-boot verification;
  rehearse on a production-DB copy). This subsumes the 81 redundant `ADD COLUMN`s, the
  `data_invalid` "duplicate column" class (`verify-sync-flow` is pre-existing red on
  it), and finally removes the every-boot inline-DDL liability. Gated on: a real
  runtime migration need appearing (table rebuild / trigger replacement / destructive
  cleanup / data backfill / ordering-sensitive migration) AND the machinery being
  designed + rehearsed first.
- SPEC 2 TRANCHE A — command/event CODEGEN: generate the command/event enums + types
  + fixtures from the sync-schema contract, CI-enforced parity, merge-gate governance.
  TRANCHE B (later): full payload DTOs/validators, release-compatibility / edge↔cloud
  `contract_version` negotiation, versioning mechanics.

## Design tensions we want you to weigh in on
1. Ordered migrations vs a declarative schema model/codegen — did we choose right for
   a polyglot, drift-prone, small-team, one-production-device system? Under what
   conditions would you flip?
2. Cross-repo contract at the SYNC-PAYLOAD layer vs shared DDL — right durable
   boundary, or does it under-serve future needs (analytics, admin, reconciliation)?
3. Is FREEZING the inline boot-DDL and deferring the rewiring (Option B) the right
   call, or is the every-boot inline DDL an unacceptable long-term liability that
   should be removed now regardless?
4. The migration runner runs on the edge but the runtime is Node-RED (async
   node-sqlite3) while the runner/tests use the `sqlite3` CLI (sync, one process per
   migration). Is that dual-execution model sound, or a trap?
5. Baseline-stamping existing DRIFTED field devices as "migration 0001 applied" —
   we gate it on semantic fingerprints + a production-copy dry run. Is that safe
   enough for the one production device, or is there a better cutover?
6. osi-server has NO CI, a String-constant "DeviceType", opaque JSONB sensor storage,
   and independent Flyway. Given the edge is authoritative, how SHOULD osi-server
   evolve — and how should the two repos co-evolve without a shared DDL model?

## Deliverable — be specific and critical
1. Your candid assessment of the WORK done (Phase 1 + Phase 2): correctness,
   robustness, over/under-engineering, anything you'd have caught or done differently.
2. Your candid assessment of the PLANS (Option B, Spec 2 Tranche A/B): are they the
   right next steps, in the right order, with the right scope?
3. The single biggest risk or blind spot in the current direction.
4. Your OPINION on the best LONG-TERM architecture for osi-os (edge) AND osi-server
   (cloud): the edge schema/migration story, the cloud schema story, the cross-repo
   contract, and how they should evolve together over the next 1-2 years. Concrete
   recommendations and a prioritized sequence — not platitudes.
```

---

## Concrete artifacts (if the expert has repo access)
- `docs/adr/2026-06-30-schema-and-contract-ownership.md` — the decision + flip conditions.
- `docs/superpowers/specs/2026-06-30-edge-schema-migration-foundation-design.md` — Spec 1.
- `docs/superpowers/specs/2026-06-30-sync-contract-package-design.md` — Spec 2 (Tranche A/B).
- `docs/superpowers/plans/2026-06-30-edge-migration-foundation-phase1.md` + `…-phase1-fixes.md` — Phase 1 plan + the review-fix plan.
- `docs/superpowers/plans/2026-07-01-edge-migration-phase2-runtime-parity-guard.md` — Phase 2.
- `lib/osi-migrate/` (runner, ledger, fingerprints, backup) + `scripts/verify-migrations.js`, `verify-seed-replay.js`, `verify-runtime-schema-parity.js`.
- `docs/operations/edge-history-retention.md` — the documented history-loss incident.
- `database/seed-blank.sql`, `database/migrations/ordered/0001__baseline.sql`, and the `sync-init-fn` node inside `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`.
- osi-server: `backend/src/main/java/org/osi/server/device/DeviceType.java`, `backend/src/main/resources/db/migration/`, `docs/contracts/sync-schema/`.
