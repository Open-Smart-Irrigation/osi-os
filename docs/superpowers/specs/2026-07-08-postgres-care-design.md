# Postgres care — hot-path index audit, retention/BRIN decision, autovacuum tuning, bootstrap jitter

**Status:** Draft
**Refactor-program item:** 5.4 (the "~10–30× first break" row of the scale table: `sensor_data` growth, missing hot-path indexes, autovacuum stalls; and the "~30–100×" thundering-herd row: 6 h bootstrap × N in lockstep → jitter now)
**Focus: osi-server** (with a small, parity-noted osi-os flows change for the jitter half — see §D)
**Depends on:** 1.B3 (CI + `./gradlew test` + Testcontainers Flyway slice — the only place a new migration gets exercised against real Postgres).
**Repo split:** the Postgres work is in `/home/phil/Repos/osi-server`. The bootstrap-jitter change is edge-side in `/home/phil/Repos/osi-os` flows.json (both profiles) — see §D and the honest caveat there.

## Problem

The scale table in the program map names two Postgres breaks that arrive well before 100 gateways and are cheap to defuse *now*, expensive to retrofit under load:
- **~10–30× (30 gateways):** `sensor_data` (the append-heavy telemetry table) grows unbounded relative to today's fleet; hot-path queries may lack the right index; autovacuum can stall on a high-churn append+delete table, bloating it and degrading the very range scans the dashboard depends on.
- **~30–100×:** the 6 h full-bootstrap snapshot fires from every gateway on an **aligned** schedule (verified: edge `Sync Bootstrap` inject node, `"repeat": "21600"` = 6 h, no jitter), so N gateways that booted near the same time thunder the VPS in lockstep — a self-inflicted load spike on a 4 CPU / 4 GB host.

This item makes the index/retention/autovacuum/BRIN decisions **before** the fleet forces them, records the flip conditions honestly, and adds bootstrap jitter. It is deliberately conservative: measure-or-reason before adding machinery, and prefer the cheap durable fix the scale table prescribes.

## Verified ground truth

Read directly at spec time (re-verify at implementation — migrations may have advanced):

1. **`sensor_data` schema** (`V3__create_sensor_data.sql`): `id BIGSERIAL PK, device_id BIGINT NOT NULL FK devices(id) ON DELETE CASCADE, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), data_json JSONB NOT NULL`. One index at creation: `idx_sensor_data_device_recorded ON sensor_data (device_id, recorded_at DESC)`.
2. **Existing indexes on `sensor_data` (three total):**
   - `idx_sensor_data_device_recorded` — `(device_id, recorded_at DESC)` (`V3`).
   - `idx_sensor_data_recorded_at` — `(recorded_at ASC)` (`V2026_05_16_030__retention_indexes.sql`). **Warning in that file:** the migration was historically FAILED-state ("never successfully applied anywhere"; run `flywayRepair` before next deploy). **Verify its live state before relying on this index** — `SELECT * FROM flyway_schema_history WHERE version = '2026_05_16_030'` on the target; if FAILED, the retention delete has no `recorded_at`-only index in production today.
   - `idx_sensor_data_device_recorded_at` — `(device_id, recorded_at)` ASC (`V2026_05_31_001__history_data_visualization_rollups.sql`). **This is a near-duplicate of `idx_sensor_data_device_recorded`** (same leading columns; differs only in the trailing sort direction of `recorded_at`). One of the two is redundant for most planner needs — a finding for §B.
3. **Hot-path queries on `sensor_data`** (`SensorDataRepository.java`), all **device-qualified**:
   - `findByDeviceIdAndRecordedAtBetweenOrderByRecordedAtDesc(deviceId, from, to)` — `WHERE device_id = ? AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC`. Served by `idx_sensor_data_device_recorded` (DESC).
   - `findSensorHistory` / the fallback variant — native: `WHERE device_id = ? AND recorded_at >= ? AND data_json ->> :field IS NOT NULL ORDER BY recorded_at ASC LIMIT 30000`. Device-scoped range; served by either device composite (ASC variant marginally better for the ASC sort, DESC still usable via backward scan).
   - `findByDeviceIdAndRecordedAt` / `findFirstByDeviceIdAndRecordedAtOrderByIdDesc` — point/near-point lookup on `(device_id, recorded_at)`; served by the composite.
   - `countByRecordedAtBefore` / `deleteByRecordedAtBefore(cutoff)` — **the only non-device-qualified access**: pure `recorded_at < ?`. This is the sole query that benefits from a `recorded_at`-leading index (or a BRIN on `recorded_at`).
   - `deleteOldDataForUser` — `device.claimedBy.id = ? AND recorded_at < ?` (join-qualified).
4. **`TelemetryRetentionJob`** exists (`@Scheduled cron 0 0 4 * * *`, `@Value("${osi.retention.telemetry.raw-days:365}")`) — daily `DELETE ... WHERE recorded_at < cutoff`. So `sensor_data` is a **bounded** append+delete table (365-day window), not truly unbounded — the growth ceiling is 365 days × fleet uplink rate. This materially changes the partition/BRIN calculus (§C).
5. **No autovacuum / Postgres tuning anywhere** — `docker-compose.yml` runs stock `postgres:16` with no `command:` overrides, no `postgresql.conf` mount, no per-table `ALTER TABLE ... SET (autovacuum_*)`. Everything is Postgres defaults.
6. **No BRIN, no partitioning** anywhere in `db/migration/` (grep clean).
7. **Bootstrap is edge-scheduled.** The server only exposes `POST /api/v1/sync/edge/bootstrap` (`EdgeSyncController:42`); it does not schedule anything. The 6 h cadence lives in the edge flow (`Sync Bootstrap` inject, `"repeat": "21600"`, `onceDelay` present but no per-gateway jitter). So **jitter is an edge-side change** (§D), not a server change — the pre-ruled "verify WHO schedules" resolves to: edge schedules, so jitter is a small flows change with both-profile parity.
8. **`DbHealthCounters`** already exposes `sensor_data_rows` (`COUNT(*)`) via its allowlist — the growth signal is already observable; no new counter needed to watch the trend.

## Design

### A. Index audit list (seeded from the cloud expert report §5, verified against actual schema/queries)

The audit's finding is **the hot device-scoped queries are already correctly indexed** by `idx_sensor_data_device_recorded (device_id, recorded_at DESC)`. The gaps are narrower than "missing hot-path indexes" implies:

1. **Redundant-index cleanup (§B):** `idx_sensor_data_device_recorded` (DESC) and `idx_sensor_data_device_recorded_at` (ASC) are near-duplicates. Keep the one the planner actually uses for both the DESC dashboard scan and the ASC history scan; drop the other to cut write-amplification and vacuum cost on the hottest insert path. **Decision:** keep `idx_sensor_data_device_recorded` (DESC — serves the dashboard's `ORDER BY recorded_at DESC` directly and the ASC history scan via backward index scan, which Postgres does efficiently); drop `idx_sensor_data_device_recorded_at` in a new migration. **Verify with `EXPLAIN (ANALYZE)` on both real queries against a Testcontainers-seeded table before dropping** — if the planner genuinely prefers the ASC index for the LIMIT-30000 history query, keep both and record why.
2. **Retention-delete index:** confirm `idx_sensor_data_recorded_at (recorded_at)` is live (ground-truth #2 warns it may be FAILED-state in production). If FAILED/absent, the daily `DELETE WHERE recorded_at < cutoff` does a full scan every night — cheap to fix, real at 30×. The BRIN decision (§C) covers this same access path and may make the btree unnecessary.
3. **Other hot tables — audit, don't speculatively index:** the report §5 index list is the seed; walk each named table's repository queries the same way (device_commands already has purpose-built partial indexes from `V030`; `sync_inbox` has `processed_at`/`source_node`; `sync_dead_letter` ships its own from 1.B4). Add an index only where a real repository query lacks one — record each add with the query it serves. No index without a named consuming query.

### B. Autovacuum tuning for `sensor_data`

`sensor_data` is the fleet's highest-churn table (append every uplink, bulk-delete nightly). Default autovacuum thresholds (`autovacuum_vacuum_scale_factor = 0.2` = vacuum after 20% of rows change) are far too lax for a table that grows to millions of rows: 20% of 10M rows = 2M dead tuples before a vacuum triggers, so bloat and stale planner stats accumulate between runs, degrading the range scans.

**Decision: per-table autovacuum settings via `ALTER TABLE`, in a migration** (not a global `postgresql.conf` change — keep the tuning colocated with the schema, versioned, and scoped to the one table that needs it; a global change would over-vacuum every small table):

```sql
ALTER TABLE sensor_data SET (
    autovacuum_vacuum_scale_factor = 0.02,   -- vacuum at 2% churn, not 20%
    autovacuum_vacuum_threshold = 5000,
    autovacuum_analyze_scale_factor = 0.01,  -- keep planner stats fresh for range scans
    autovacuum_analyze_threshold = 5000
);
```

- Numbers are the standard "large high-churn table" starting point, not measured optima — record them as a starting point to revisit if `pg_stat_user_tables.n_dead_tup` / last-autovacuum age show they're wrong. The point is *tighter than default*, versioned, and revisable.
- **Same treatment for the nightly-deleted companion tables if the audit finds equivalent churn** (`dendrometer_readings`, `chameleon_readings` if they have retention deletes) — one migration, one `ALTER TABLE` each, only where churn justifies it.
- Apply after the nightly bulk delete concern: bulk deletes create dead tuples in one shot; the tighter `autovacuum_vacuum_threshold` ensures the post-delete vacuum fires promptly rather than waiting for 20% more churn.

### C. Retention / partition-or-BRIN decision for `sensor_data` — **BRIN-first, partitioning gated**

Per the pre-ruled decision: **BRIN-first for `sensor_data` time-range access (cheap, no rewrite); monthly partitioning ONLY if BRIN proves insufficient; record the flip condition.**

**Honest nuance the query audit forces (§A):** the *dominant* time-range access is **device-qualified** (`device_id = ? AND recorded_at range`), which a BRIN on `recorded_at` alone does **not** serve well — BRIN is unselective when a highly-selective equality predicate (`device_id = ?`) is present; the btree composite wins there and stays. **The one access a BRIN genuinely helps is the non-device-qualified retention scan** (`recorded_at < cutoff`, ground-truth #3) and any future fleet-wide time-range analytics. So:

- **Add a BRIN index on `recorded_at`** (`CREATE INDEX idx_sensor_data_recorded_brin ON sensor_data USING brin (recorded_at)`) as the cheap, no-rewrite serving path for the retention delete and fleet-wide time scans. A BRIN over a monotonically-increasing append column (recorded_at rises with time; rows insert in ~time order) is near-ideal — tiny (kilobytes vs a btree's hundreds of MB at scale) and correlation-friendly.
- **If the BRIN serves the retention delete, drop the btree `idx_sensor_data_recorded_at`** (redundant with the BRIN for that access; §A(2) may already be handling its FAILED state — resolve them together). Verify via `EXPLAIN (ANALYZE) DELETE ... WHERE recorded_at < cutoff` on a seeded Testcontainers table that the BRIN is chosen and the scan is a fraction of the heap.
- **Do NOT partition now.** The table is bounded to a 365-day window (ground-truth #4) and the device btree + BRIN cover every real query. Partitioning is a table rewrite (one-way, operationally heavy on a 4 GB host) and buys little while the working set fits in that window.
- **Record the flip condition to monthly partitioning explicitly** (the pre-ruled requirement): flip to monthly range partitioning on `recorded_at` when **either** (a) the fleet crosses **~30 gateways** (the scale-table trigger), **or** (b) measured `sensor_data` range-scan latency on the hot dashboard query exceeds a documented budget (e.g. p95 > 200 ms) despite the BRIN + tuned autovacuum, **or** (c) the nightly retention `DELETE` starts causing autovacuum/lock pressure that a `DROP PARTITION` (O(1) vs a scan-and-delete) would eliminate. Partitioning primarily converts retention from a row-by-row delete into a partition drop — that, not read speed, is its real payoff here, and it's why (c) is a first-class trigger. Until one fires, BRIN + tuned autovacuum + the device btree is the correct, cheap, durable state.

### D. Bootstrap jitter (edge-side, both-profile parity)

Verified WHO schedules (ground-truth #7): **the edge does.** So jitter is a flows.json change, not a server change.

- **Add a deterministic per-gateway jitter to the 6 h bootstrap cadence** so N gateways do not fire in lockstep. The `Sync Bootstrap` inject (`"repeat": "21600"`) fires on a fixed interval from Node-RED start; two gateways that started near the same wall-clock time stay aligned forever. Introduce a per-gateway offset derived from `DEVICE_EUI` (stable, no coordination, no server round-trip) — e.g. a delay of `hash(DEVICE_EUI) mod 21600` seconds before the first bootstrap of each session, or (simpler and flows-idiomatic) convert the fixed-interval inject into a scheduled trigger whose phase is EUI-seeded. **Spread target: at least ±30 min across the fleet** so 30 gateways smear across the interval rather than spiking.
- **Both profiles:** the change lands in `conf/full_raspberrypi_bcm27xx_bcm2712/.../flows.json` and its bcm2709 mirror must stay byte-identical (`verify-profile-parity.js`). Note both-profile parity as a hard requirement — this is the standard flows-edit fence.
- **Honest caveat / scope boundary:** this is a genuine edge (osi-os) change, and the orchestrator's DOCUMENTS-ONLY constraint means **this spec designs it but does not implement it**; the flows edit is a follow-up implementation slice under the edge team's `osi-flows-json-editing` change-control (the `Sync Bootstrap` node is a normal inject, not the frozen `sync-init-fn`, so it is editable — but still a behavior-affecting flows change requiring the golden-vector/parity discipline). The server side of 5.4 (index audit, autovacuum, BRIN) is fully server-local and ships independently of the jitter; **do not couple the server migration to the edge flows change** — they are separate PRs in separate repos. If the fleet is small enough that lockstep isn't yet biting (< ~10 gateways), the jitter can trail the server work without harm; the scale table puts its bite at ~30–100×.

## Testing

- **Migration correctness:** the new migration (redundant-index drop + autovacuum `ALTER TABLE` + BRIN) applies cleanly on real Postgres via the 1.B3 Testcontainers Flyway clean-migrate slice — extend the existing "all migrations apply" assertion; it picks the new migration up automatically. Additive/idempotent where possible (`CREATE INDEX IF NOT EXISTS`, `DROP INDEX IF EXISTS`).
- **Index-choice evidence (not a permanent test — a captured artifact in the PR):** `EXPLAIN (ANALYZE, BUFFERS)` on each of the three real queries (device-range DESC dashboard scan, device-range ASC history scan, `recorded_at < cutoff` retention delete) against a Testcontainers table seeded with a representative row count (e.g. 1–5 M rows across a handful of devices), captured **before and after** the index changes, proving: the device composite still serves the dashboard/history scans, the BRIN serves the retention delete, and no dropped index regressed a plan. This is the load-bearing evidence for every drop.
- **Autovacuum settings are asserted present:** a small IT queries `pg_class.reloptions` (or `information_schema`) for `sensor_data` after migration and asserts the four autovacuum keys are set — a cheap guard that the `ALTER TABLE` survived and wasn't silently reverted.
- **No production/live-DB access.** All evidence is from Testcontainers-seeded synthetic data. The real-fleet flip-condition metrics (§C) are observed via `DbHealthCounters` + `pg_stat_user_tables` in operation, not in CI.

## Non-goals

- **Partitioning `sensor_data` now** — deferred behind the §C flip conditions (~30 gateways, measured latency budget, or retention-delete pressure). Recorded, not built.
- **Global `postgresql.conf` / container tuning** (`shared_buffers`, `work_mem`, etc.) — out of scope; per-table autovacuum is the targeted fix. A global memory tune on the 4 GB host is a separate ops decision, not a schema migration.
- **Autovacuum tuning for tables the audit finds low-churn** — only `sensor_data` (and any companion with a real nightly retention delete) is tuned; don't over-vacuum small tables.
- **Implementing the edge bootstrap-jitter flows change** — designed in §D, implemented by the edge team as a separate osi-os flows PR under change control; this spec does not edit flows.json.
- **Incremental bootstrap snapshots** — that is item 5.5; jitter here is the interim thundering-herd fix, 5.5 is the structural one. 5.4 explicitly ships jitter now and hands the durable fix to 5.5.
- **New retention-window policy** — `TelemetryRetentionJob`'s 365-day default is unchanged; this item indexes/vacuums the table it already prunes.
- **Any 1.B4 sync-path change** — independent code path.

## Definition of Done

- One new server-side Flyway migration (date-versioned, sorts after the highest applied — re-verify): drops the redundant `idx_sensor_data_device_recorded_at` (only if `EXPLAIN` confirms the DESC composite covers both scans), adds the BRIN on `recorded_at`, resolves the FAILED-state `idx_sensor_data_recorded_at` (keep or drop per the BRIN evidence), and sets the four `sensor_data` autovacuum reloptions.
- `EXPLAIN (ANALYZE)` evidence for all three hot queries captured before/after against a seeded Testcontainers table, in the PR body — the justification for every index change.
- Testcontainers slice: migration applies clean; an IT asserts the autovacuum reloptions are set on `sensor_data`.
- Index audit written up: each existing/added index mapped to its consuming repository query; no index without a named query; the redundant-index finding resolved.
- §C flip conditions (BRIN → partitioning) recorded in the migration comment and this spec's final version.
- Edge bootstrap-jitter design (§D) recorded here with EUI-seeded-offset approach and ±30 min spread target, both-profile parity noted, handed to the edge team as a separate slice — **not** implemented in this item.
- Local `./gradlew test` green (the new migration + autovacuum IT run in the 1.B3 slice).
- "Open decisions" shows none outstanding.

## Open decisions

None outstanding.

- BRIN vs partitioning: **BRIN-first, partitioning gated on ~30 gateways / measured latency / retention-delete pressure**, decided in §C — BRIN is cheap and no-rewrite; the device-qualified hot queries are already served by the btree composite, so BRIN's real value is the retention scan and fleet-wide analytics, and partitioning's real value is O(1) retention drop, deferred until a trigger fires.
- Autovacuum: **per-table `ALTER TABLE` reloptions in a migration, 2% scale factor**, decided in §B — colocated/versioned/scoped, over a global conf change that would over-vacuum small tables; numbers are a revisable starting point, not measured optima.
- Redundant index: **keep `idx_sensor_data_device_recorded` (DESC), drop the ASC near-duplicate**, decided in §A — gated on `EXPLAIN` confirming the DESC composite serves both the DESC dashboard scan and the ASC history scan; if the planner disagrees, keep both and record why.
- Bootstrap jitter side: **edge-side flows change (EUI-seeded offset), verified the edge schedules the 6 h bootstrap**, decided in §D — designed here, implemented as a separate osi-os slice with both-profile parity; server 5.4 ships independently.
- FAILED-state `idx_sensor_data_recorded_at`: **verify live state; resolve together with the BRIN** (the BRIN may make it redundant), decided in §A(2)/§C — the `V030` migration's own note flags it may never have applied in production.
