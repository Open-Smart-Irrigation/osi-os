# Incremental bootstrap snapshots (refactor-program 5.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans WHEN THIS ITEM IS SCHEDULED. Steps use checkbox (`- [ ]`) syntax.
> **STATUS: DEFERRED — DO NOT EXECUTE YET.** Per the pre-ruling and spec §D, the incremental-bootstrap machinery is **specified now, scheduled later** — not enabled until the fleet crosses **~10 gateways** (or a measured bootstrap-load budget is exceeded). This plan is the ready-to-run implementation for that future window; running it before the trigger fires adds a divergent full/delta code path for zero present benefit. **When the trigger fires, re-verify every shape below against current main first** — 1.B4, 3.4, and 5.4 will have churned the sync package.
> **Repo split:** the server change is in **`/home/phil/Repos/osi-server`** (branch `feat/incremental-bootstrap`, PR, **do not merge**). The paired edge-builder change is **osi-os flows** — a paired slice landing WITH the server side (the full-mode fallback keeps them independently safe). Zero osi-os edits in the server PR.
> **Execution notes (when scheduled):** run osi-server commands from `/home/phil/Repos/osi-server/backend`; gates are LOCAL `./gradlew test` (Docker required for the 1.B4 Testcontainers slice); re-verify the Flyway version before any migration (a `SyncCursor` field add, if used for anti-entropy bookkeeping, is additive).
> **Spec:** [`docs/superpowers/specs/2026-07-08-incremental-bootstrap-snapshots-design.md`](../specs/2026-07-08-incremental-bootstrap-snapshots-design.md) (approved; §A–§E references point there).
> **Depends on:** 5.4 (jitter is the interim mitigation this replaces structurally) and 1.B4's `SyncResourceWatermark` machinery + Testcontainers slice.

**Goal (when scheduled):** Make the 6 h bootstrap send only rows newer than the server's acknowledged per-resource watermark (watermark-delta), falling back to today's full windowed snapshot only on cursor gap or a periodic anti-entropy full — so a gateway with no new data sends near-nothing and the server upserts nothing, killing the redundant thundering-herd payload at scale. Reuse the existing `SyncResourceWatermark` / `SyncCursor` machinery; add no new table (an additive `SyncCursor` field only if anti-entropy bookkeeping needs it).

**Architecture (spec §A–§C):** the server advertises its per-gateway watermark manifest (read from `sync_resource_watermarks`); the edge selects only rows above it per resource; the server applies the delta through the same watermark guard the event path uses (post-1.B4/3.4: the applier + `applyOne` machinery), so bootstrap and event idempotency converge. Any watermark uncertainty → today's full windowed snapshot (the permanent safe default). Incremental is opt-in via a request flag; an un-upgraded edge (no flag) hits the unchanged full path.

**Tech Stack (when scheduled):** Java 17 / Spring Boot 3.4.3, Lombok, Flyway (additive `SyncCursor` field only if used), Testcontainers Postgres 16 (1.B4 slice), JUnit 5 + AssertJ. Edge side: Node-RED flows (`Build Cloud Bootstrap` function node, `osi-flows-json-editing` change control, both-profile parity).

## Global Constraints (when scheduled)

- **Deferred until the §D trigger.** Do not enable before ~10 gateways / measured bootstrap-load budget. The spec records the trigger; this plan is dormant until it fires.
- **All server code changes in osi-server only.** Branch `feat/incremental-bootstrap`; PR; **do not merge** without the paired edge slice or a full-mode-default confirmation.
- **The full-snapshot path is NEVER removed** — it is the permanent safe default the delta optimizes away. Backward-compat: absent incremental flag → today's `applyBootstrap` behavior, byte-for-byte.
- **No new table** — reuse `sync_resource_watermarks` + `SyncCursor`; additive `SyncCursor` field only if anti-entropy cadence bookkeeping needs it.
- **Reuse, don't fork, the watermark guard** — delta apply routes through the event-path stale-version logic (post-1.B4/3.4 machinery), not a second copy.
- **No production/live access.** All Testcontainers-synthetic.

## Non-goals (do not do these)

- Enabling/scheduling before the trigger. Removing the full path. A new streaming/CDC protocol (YAGNI). Changing `applyEventsV2` (reuse only). Changing the 6 h cadence or jitter (5.4). Implementing the edge builder change standalone (it's paired).

## File Structure (all paths relative to `/home/phil/Repos/osi-server/backend`; when scheduled)

- Modify: `src/main/java/org/osi/server/sync/EdgeSyncService.java` (delta-mode `applyBootstrap`), `src/main/java/org/osi/server/sync/EdgeSyncController.java` (watermark manifest exposure) — exact shapes re-verified at scheduling time.
- Create: `src/test/java/org/osi/server/sync/IncrementalBootstrapIT.java`
- Possibly modify: `src/main/java/org/osi/server/sync/SyncCursor.java` + a migration (additive field, only if anti-entropy bookkeeping uses it).
- Paired osi-os slice (separate PR): `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` + bcm2709 mirror — the `Build Cloud Bootstrap` node.

---

### Task 0 (GATE): confirm the scheduling trigger has fired

- [ ] **Step 0.1: Confirm the trigger.** Do not proceed unless the fleet has crossed ~10 gateways OR a measured bootstrap-load budget is exceeded (spec §D). If neither, STOP — 5.4's jitter remains the correct interim state. Record which trigger fired and the evidence.
- [ ] **Step 0.2: Re-verify the sync-package surface against current main** — `SyncResourceWatermark`, `SyncCursor`, `applyBootstrap`, and (post-3.4) the applier registry / `applyOne` watermark guard. 1.B4/3.4/5.4 will have moved things; re-read before designing the delta apply route. **Resolve the spec §B OPEN ITEM here:** read the edge `farming.db` schema and determine, per append resource (`sensor_data`, `dendro_readings`, `chameleon_readings`, `irrigation_events`, `zone_environments`), whether it carries a per-row `sync_version` (clean `WHERE sync_version > :watermark` filter) or must fall back to `recorded_at` (monotonic-timestamp caveat, interacts with item 5.6 clock-jump handling). This is the deferred fork the spec left open; decide it with the real edge schema in front of you before writing Task 3.

---

### Task 1: Server advertises the per-gateway watermark manifest (read-only)

**Files:** Modify `EdgeSyncController.java` (or add a bootstrap-response field), read-only from `sync_resource_watermarks`.

- [ ] **Step 1.1: Write the failing IT** — `IncrementalBootstrapIT` (1.B4 `PostgresSyncTestBase` slice, unique gateway EUI): seed some `sync_resource_watermarks` rows for a gateway, request the manifest (endpoint or bootstrap-response field), assert it returns the correct per-resource `highest_sync_version` map. Red: endpoint/field absent.
- [ ] **Step 1.2: Implement the manifest read** — a bounded, admin-or-gateway-scoped read (matching the existing sync endpoints' auth) that projects `sync_resource_watermarks` for the gateway into a compact `(resource_type[, resource_id] → highest_sync_version)` DTO. No new state.
- [ ] **Step 1.3: Green + commit.**

---

### Task 2: Delta-mode `applyBootstrap` (reuses the watermark guard)

**Files:** Modify `EdgeSyncService.applyBootstrap`.

- [ ] **Step 2.1: Write the failing delta-correctness IT** — seed watermarks; send an incremental bootstrap (flagged) whose rows are all ≤ watermark → assert zero upserts + zero watermark advance; rows > watermark → assert only those apply + watermark advances; a stale row inside a fresh batch → assert stale skipped (converged with the event path). Red: `applyBootstrap` blind-upserts everything (today's behavior).
- [ ] **Step 2.2: Implement delta mode** — when the request declares incremental, route each resource's rows through the event-path stale-version comparison (post-1.B4/3.4: the applier + `applyOne` watermark guard — reuse, do not fork). A full-mode request keeps today's exact blind-upsert. Cursor-gap detection: if no watermark baseline for the gateway (or a periodic anti-entropy full is due), signal full-required in the manifest and honor it.
- [ ] **Step 2.3: Backward-compat IT** — a full-mode request (no flag) applies identically to today's `applyBootstrap` (the golden net: reuse/extend any existing bootstrap test). Green.
- [ ] **Step 2.4: Anti-entropy cadence IT** — every Nth bootstrap forces a full even with a valid watermark; assert a server-lost row re-syncs on the next full. (Additive `SyncCursor.lastIncrementalBootstrapAt` / full-resync-due marker only if this cadence needs persistent bookkeeping — additive migration, re-verify version.)
- [ ] **Step 2.5: Green + commit.**

---

### Task 3: Paired edge-builder slice (SEPARATE osi-os PR — designed, landed with the server side)

**Files:** `conf/full_raspberrypi_bcm27xx_bcm2712/.../flows.json` `Build Cloud Bootstrap` node + bcm2709 mirror (both-profile parity, `verify-profile-parity.js`).

- [ ] **Step 3.1: Under `osi-flows-json-editing` change control** (the `Build Cloud Bootstrap` node is a normal function node, editable — NOT the frozen `sync-init-fn`): make the edge (a) fetch/consume the server watermark manifest, (b) select rows above the watermark per resource instead of the fixed time window (`WHERE sync_version > :serverWatermark`, or `recorded_at`-based where no per-row sync_version exists — resolve per resource), (c) fall back to the full windowed snapshot on any uncertainty. Set the incremental flag on the request.
- [ ] **Step 3.2: Both-profile parity** — mirror the bcm2712 flows to bcm2709 byte-identically; `verify-profile-parity.js` green.
- [ ] **Step 3.3: Land together** — the edge slice and server PR land in the same window (or behind the full-mode default so an un-upgraded edge keeps working — the §B fallback guarantees this). Golden-vector discipline per the edge change-control skill.

---

### Task 4: Full-suite gate + PR (server), edge slice PR

- [ ] **Step 4.1: Server full suite** — `cd /home/phil/Repos/osi-server/backend && ./gradlew test` green (Docker running).
- [ ] **Step 4.2: Open the server PR (do not merge)** and the paired edge PR; cross-link them; note the full-mode fallback makes coexistence non-breaking.

---

## Verification checklist (when scheduled, before marking done)

- [ ] Trigger confirmed fired (Task 0) — not run speculatively.
- [ ] Watermark manifest exposed read-only from `sync_resource_watermarks`; no new table.
- [ ] Delta-mode `applyBootstrap` reuses the event-path watermark guard (not a fork); ≤-watermark rows no-op; >-watermark apply; stale-in-batch skipped.
- [ ] Cursor-gap → full; anti-entropy full cadence self-heals drift.
- [ ] Full-mode (no flag) byte-for-byte identical to today's `applyBootstrap` (backward-compat net).
- [ ] Paired edge slice: watermark-select + full fallback + incremental flag; both-profile parity; lands with the server side.
- [ ] Full `./gradlew test` green; server PR has zero osi-os edits; PRs open, not merged.

## Note on the deferral

This plan intentionally has a GATE task (Task 0) at the front. It exists so that when the ~10-gateway trigger fires, execution is turnkey — but until then, the correct action is **no action** beyond keeping this plan and its spec accurate against the churning sync package. Do not treat the plan's existence as a signal to build.
