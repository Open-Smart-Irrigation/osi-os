# Postgres care (refactor-program 5.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Repo split:** this plan file lives in **osi-os** (docs home). The Postgres work is in **`/home/phil/Repos/osi-server`** (branch `feat/postgres-care`, PR in osi-server, **do not merge**). The bootstrap-jitter half is **osi-os flows** — DESIGNED here, handed to the edge team as a separate slice (§D of the spec); this plan does NOT edit flows.json.
> **Execution notes:** (1) run all osi-server commands from `/home/phil/Repos/osi-server/backend`; gates are LOCAL `./gradlew test` (fast: `-x buildFrontend -x buildTerraIntelligenceFrontend`); (2) **Docker required** — the migration + reloptions assertions run against the 1.B3 Testcontainers Postgres slice; (3) **re-verify the highest Flyway version before adding a migration** — `ls src/main/resources/db/migration | sort | tail -5`; a concurrent merge may bump past `V2026_07_06_001` / the 1.B4 `V2026_07_07_001__sync_dead_letter.sql`; rename this plan's migration to sort after the actual highest; (4) **re-verify `idx_sensor_data_recorded_at`'s live state** — the `V2026_05_16_030` migration's own note says it may be FAILED/never-applied in production (`SELECT version, success FROM flyway_schema_history WHERE version = '2026_05_16_030'` on the target).
> **Spec:** [`docs/superpowers/specs/2026-07-08-postgres-care-design.md`](../specs/2026-07-08-postgres-care-design.md) (approved; §A–§D references point there).
> **Depends on:** 1.B3 (Testcontainers Flyway slice + CI). If the `PostgresSyncTestBase` / Flyway clean-migrate slice from 1.B4/1.B3 is absent, STOP — this plan's evidence gates need it.

**Goal:** Make the `sensor_data` hot-path index/vacuum/retention decisions before the fleet forces them: one additive Flyway migration that (a) resolves the redundant `(device_id, recorded_at)` index pair, (b) adds a BRIN on `recorded_at` for the non-device-qualified retention scan, (c) resolves the FAILED-state `recorded_at` btree, (d) sets tight per-table autovacuum reloptions on `sensor_data` — every change justified by captured `EXPLAIN (ANALYZE)` evidence. Record the BRIN→partitioning flip conditions. Hand the edge bootstrap-jitter design to the edge team.

**Architecture (spec §A–§C):** decisions are evidence-gated, not speculative. The hot device-scoped queries are already served by `idx_sensor_data_device_recorded (device_id, recorded_at DESC)`; the gaps are (1) a redundant ASC near-duplicate to drop, (2) the retention `recorded_at < cutoff` scan that a tiny BRIN serves ideally over a monotonically-increasing append column, (3) `sensor_data` on stock autovacuum defaults (20% scale factor) bloating between vacuums. Partitioning is deferred behind explicit flip conditions.

**Tech Stack:** Postgres 16, Flyway (date-versioned), Testcontainers Postgres 16 (1.B3 slice), JUnit 5 + AssertJ. No application-code change beyond a small assertion IT.

## Global Constraints

- **All code changes in osi-server only.** Branch `feat/postgres-care`; commit per task; PR at the end; **do not merge**. Never modify `/home/phil/Repos/osi-os`.
- **The migration is additive/idempotent** where possible (`CREATE INDEX IF NOT EXISTS`, `DROP INDEX IF EXISTS`, `ALTER TABLE ... SET (...)` — reloptions are idempotent). No table rewrite. No `sensor_data` data change.
- **Every index add/drop is gated on captured `EXPLAIN (ANALYZE)` evidence** against a seeded Testcontainers table — the drops especially (a wrong drop regresses the dashboard). No blind index changes.
- **The bootstrap jitter is NOT implemented here** — designed in the spec §D, handed to the edge team as a separate osi-os flows slice (both-profile parity). Server 5.4 ships independently and must not couple to it.
- **No production / live-DB access.** All evidence is Testcontainers-seeded synthetic data.
- Local `./gradlew test` green before the PR.

## Non-goals (do not do these)

- No partitioning of `sensor_data` (deferred behind §C flip conditions — record them, don't build).
- No global `postgresql.conf` / container memory tuning (`shared_buffers` etc.) — per-table autovacuum only.
- No autovacuum tuning for tables the audit finds low-churn — only `sensor_data` (+ any companion with a real nightly retention delete).
- No change to `TelemetryRetentionJob`'s 365-day window.
- No edge flows.json edit (jitter is a handed-off slice).
- No 1.B4 / sync-path change.

## File Structure (all paths relative to `/home/phil/Repos/osi-server/backend`)

- Create: `src/main/resources/db/migration/V2026_07_08_001__sensor_data_index_vacuum.sql` (Task 2 — re-verify/rename version)
- Create: `src/test/java/org/osi/server/telemetry/SensorDataIndexVacuumIT.java` (Task 2)
- Create (evidence artifact, committed under docs or PR body): `EXPLAIN` captures (Task 1 — see step)

---

### Task 1: Index audit + `EXPLAIN (ANALYZE)` evidence on a seeded table (the justification)

**Files:** none created in main; produces the evidence that gates Task 2's every change.

- [ ] **Step 1.1: Branch** — `cd /home/phil/Repos/osi-server && git checkout main && git pull --ff-only && git checkout -b feat/postgres-care`.

- [ ] **Step 1.2: Confirm the 1.B3/1.B4 Testcontainers slice exists** — `PostgresSyncTestBase` (or the 1.B3 Flyway clean-migrate harness) under `src/test/java/org/osi/server/testsupport/`. If absent, STOP (dependency unmet).

- [ ] **Step 1.3: Verify current index inventory + FAILED-state check** — write a throwaway IT (or a `psql` session against a Testcontainers container) that, after Flyway migrates, runs `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'sensor_data'` and captures the three expected indexes (`idx_sensor_data_device_recorded` DESC, `idx_sensor_data_recorded_at` ASC, `idx_sensor_data_device_recorded_at` ASC). On the real fleet, separately confirm `idx_sensor_data_recorded_at`'s live state per the execution note (may be FAILED/absent).

- [ ] **Step 1.4: Seed a representative table + capture `EXPLAIN (ANALYZE, BUFFERS)` BEFORE** — **this is DEV-TIME / PR-BODY EVIDENCE, not a `./gradlew test` gate.** The 1–5 M-row seed + `EXPLAIN` capture is a one-off local harness run whose output goes into the PR body; do NOT wire the multi-minute seed into the committed test suite (only the fast reloptions/BRIN-presence assertion of Step 2.1 is a permanent test). Run it as a throwaway `main()` / scratch test / `psql` session against a Testcontainers container. Insert ~1–5 M `sensor_data` rows across a handful of devices with realistic `recorded_at` spread and JSONB payloads, `ANALYZE sensor_data`, then capture and save plans for the three real queries (spec §A/Testing):
  1. device-range DESC dashboard: `... WHERE device_id = ? AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC`
  2. device-range ASC history: `... WHERE device_id = ? AND recorded_at >= ? AND data_json ->> 'field' IS NOT NULL ORDER BY recorded_at ASC LIMIT 30000`
  3. retention delete scan: `EXPLAIN (ANALYZE) DELETE FROM sensor_data WHERE recorded_at < ?` (or the `SELECT count(*)` equivalent to avoid mutating the seed).
  Save these BEFORE plans (into the PR body / a scratch note) — they justify every Task-2 change.

- [ ] **Step 1.5: Map every existing index to its consuming repository query** — write the audit (spec §A(3)): each index in `pg_indexes` for the hot tables (`sensor_data`, and cross-check `device_commands`, `sync_inbox`, `sync_dead_letter` already have theirs) → the `SensorDataRepository`/etc. method it serves. Flag any index with no consuming query (the redundant ASC pair) and any query with no index. This audit IS the deliverable's paper trail; put it in the PR body.

- [ ] **Step 1.6: Decide keep/drop from the BEFORE plans** — confirm from Step 1.4's plans that `idx_sensor_data_device_recorded` (DESC) serves BOTH the DESC dashboard scan and the ASC history scan (backward index scan). If yes → the ASC `idx_sensor_data_device_recorded_at` is the drop candidate. If the planner genuinely prefers the ASC index for the LIMIT-30000 history query, KEEP both and record why (spec §A(1)). Record the decision.

- [ ] **Step 1.7: Commit the audit note** (if kept as a repo file; otherwise it rides in the PR body — no code commit for this task).

---

### Task 2: The migration (redundant-index drop + BRIN + FAILED-state resolution + autovacuum) — TDD'd by the AFTER plan + reloptions assertion

**Files:**
- Create: `src/main/resources/db/migration/V2026_07_08_001__sensor_data_index_vacuum.sql`
- Create: `src/test/java/org/osi/server/telemetry/SensorDataIndexVacuumIT.java`

**Interfaces:** produces the tuned/indexed `sensor_data`; the IT asserts reloptions present + migration clean.

- [ ] **Step 2.1: Write the failing reloptions assertion (red)** — create `SensorDataIndexVacuumIT.java` (uses `PostgresSyncTestBase`, `@DataJpaTest` + `@AutoConfigureTestDatabase(replace = NONE)`, `@Autowired JdbcTemplate`): assert the four autovacuum keys are set on `sensor_data`, a BRIN index `idx_sensor_data_recorded_brin` exists, and (per Step 1.6's decision) the redundant ASC index is absent. **Reloptions assertion — parse, don't string-match:** `reloptions` is a `text[]` of `key=value` strings and Postgres may normalize the value (e.g. `0.02` → `0.02` but formatting can differ). Do NOT assert the array literally "contains" `"autovacuum_vacuum_scale_factor=0.02"`; instead `unnest(reloptions)` (or `SELECT option_name, option_value FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE relname='sensor_data'))`) and assert each `(key, value)` pair — tolerant of formatting, avoiding a first-run false-red. Index/BRIN presence via `pg_indexes` count is fine as-is.

Run: `./gradlew test --tests 'org.osi.server.telemetry.SensorDataIndexVacuumIT' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL — reloptions null / BRIN absent / redundant index still present.

- [ ] **Step 2.2: Verify the migration version slot, then create the migration** — `ls src/main/resources/db/migration | sort | tail -5`; confirm the highest and name the file to sort strictly after it (rename `V2026_07_08_001__...` if a later date already exists). Create `V2026_07_08_001__sensor_data_index_vacuum.sql`:

```sql
-- 5.4 Postgres care (spec 2026-07-08-postgres-care-design.md §A–§C). Additive/idempotent.
-- Evidence: EXPLAIN(ANALYZE) captures in the PR body justify each change.

-- (a) Drop the redundant ASC near-duplicate of idx_sensor_data_device_recorded (DESC),
--     which serves both the DESC dashboard scan and the ASC history scan (backward
--     index scan). ONLY if Task-1 EXPLAIN confirmed — else omit this line and record why.
DROP INDEX IF EXISTS idx_sensor_data_device_recorded_at;

-- (b) BRIN on recorded_at: tiny, correlation-friendly over the monotonically-increasing
--     append column; serves the non-device-qualified retention scan (recorded_at < cutoff)
--     and fleet-wide time-range analytics. The device-qualified hot queries stay on the
--     btree composite (BRIN is unselective under device_id = ?).
CREATE INDEX IF NOT EXISTS idx_sensor_data_recorded_brin
    ON sensor_data USING brin (recorded_at);

-- (c) Resolve the FAILED-state btree recorded_at index (V2026_05_16_030). The BRIN in (b)
--     serves the retention delete, so drop the btree as redundant. If the fleet target
--     still shows V030 FAILED, run flywayRepair there first (ops note, not this migration).
DROP INDEX IF EXISTS idx_sensor_data_recorded_at;

-- (d) Per-table autovacuum: sensor_data is the highest-churn table (append every uplink,
--     bulk-delete nightly). Default 20% scale factor lets millions of dead tuples
--     accumulate; tighten to 2% + keep planner stats fresh for the range scans.
--     Starting point, not measured optima — revisit via pg_stat_user_tables.
ALTER TABLE sensor_data SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 5000,
    autovacuum_analyze_scale_factor = 0.01,
    autovacuum_analyze_threshold = 5000
);
```

**Adjust per Task-1 evidence:** if Step 1.6 said keep the ASC index, delete line (a). If the retention delete's `EXPLAIN` shows the BRIN is NOT chosen over a seq scan (e.g. too-low correlation on the seeded data — verify with a realistic monotonic insert order), keep the btree `idx_sensor_data_recorded_at` and skip line (c). **The migration must match the evidence, not the sketch.**

- [ ] **Step 2.3: Capture the AFTER `EXPLAIN (ANALYZE)`** — re-run Step 1.4's three query captures against the migrated + re-`ANALYZE`d seeded table. Assert (in the PR note): device composite still serves scans 1 and 2; the BRIN serves scan 3 (retention delete) with a heap fraction far below the seq scan; no dropped index regressed a plan. **If any plan regressed, revert that line of the migration.**

- [ ] **Step 2.4: Run it (green)**

Run: `./gradlew test --tests 'org.osi.server.telemetry.SensorDataIndexVacuumIT' --tests 'org.osi.server.testsupport.FlywayMigrationIT' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: reloptions assertion passes, BRIN present, redundant index absent (per decision), and the 1.B3/1.B4 Flyway clean-migrate test still green (new migration applies cleanly on real Postgres).

- [ ] **Step 2.5: Commit**

```bash
git add src/main/resources/db/migration/V2026_07_08_001__sensor_data_index_vacuum.sql \
        src/test/java/org/osi/server/telemetry/SensorDataIndexVacuumIT.java
git commit -m "feat(db): sensor_data BRIN + redundant-index cleanup + per-table autovacuum tuning (5.4)"
```

---

### Task 3: Record flip conditions + hand off the bootstrap-jitter design, full-suite gate, PR

**Files:** none (documentation + handoff live in the PR body and the already-committed spec).

- [ ] **Step 3.1: Record the BRIN→partitioning flip conditions** — in the migration comment (done in Task 2) AND the PR body, restate spec §C's triggers: flip to monthly `recorded_at` range partitioning when (a) fleet ≥ ~30 gateways, OR (b) hot dashboard-query p95 > documented budget (e.g. 200 ms) despite BRIN + tuned autovacuum, OR (c) nightly retention `DELETE` causes autovacuum/lock pressure a `DROP PARTITION` would eliminate. Note partitioning's real payoff is O(1) retention, not read speed.

- [ ] **Step 3.2: Hand off the bootstrap-jitter design** — do NOT implement. In the PR body / a note to the edge team, restate spec §D: the 6 h bootstrap is edge-scheduled (`Sync Bootstrap` inject, `"repeat": "21600"`), so jitter is an EUI-seeded offset added in flows.json (both profiles, `verify-profile-parity.js`), ±30 min spread target, editable node (not frozen `sync-init-fn`). It is a separate osi-os slice, uncoupled from this server PR.

- [ ] **Step 3.3: Full-suite gate**

Run: `cd /home/phil/Repos/osi-server/backend && ./gradlew test`
Expected: entire suite green (Docker running). The new migration + reloptions IT + all pre-existing tests pass.

- [ ] **Step 3.4: Push + open PR (do not merge)**

```bash
git push -u origin feat/postgres-care
gh pr create --title "feat(db): sensor_data Postgres care — BRIN, index cleanup, autovacuum tuning (5.4)" \
  --body "Refactor-program 5.4. Additive migration; every index change gated on EXPLAIN(ANALYZE) evidence (in body). BRIN-first; partitioning deferred behind recorded flip conditions. Bootstrap jitter is a separate osi-os edge slice (spec §D). Do not merge without review." --draft
```

---

## Verification checklist (before marking done)

- [ ] Index audit written (every `sensor_data` index → consuming query; redundant pair identified).
- [ ] `EXPLAIN (ANALYZE)` before/after captured for all three hot queries — the justification for every index change; no regressed plan.
- [ ] Migration additive/idempotent; sorts after the highest applied version; matches the evidence (lines omitted where evidence said keep).
- [ ] BRIN present; redundant ASC index resolved; FAILED-state btree resolved per evidence.
- [ ] `sensor_data` autovacuum reloptions set + asserted by the IT.
- [ ] 1.B3/1.B4 Flyway clean-migrate test green with the new migration.
- [ ] Flip conditions (BRIN→partition) recorded in migration comment + PR body.
- [ ] Bootstrap-jitter design handed to the edge team; NOT implemented; server PR uncoupled from it.
- [ ] Full `./gradlew test` green; zero osi-os changes; PR open, not merged.
