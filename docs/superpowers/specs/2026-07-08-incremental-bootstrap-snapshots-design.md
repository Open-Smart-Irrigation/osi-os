# Incremental bootstrap snapshots — watermark-delta, full only on cursor gap

**Status:** Draft — **spec now, scheduling deferred** (explicit deferred-trigger: not scheduled until ~10 gateways; the spec records the trigger, a later slice flips it on)
**Refactor-program item:** 5.5 (the "~30–100× thundering herd" scale-table row: "6 h full bootstrap snapshots × N in lockstep"; cheap durable fix = "jitter now; 5.5 incremental snapshots via existing watermarks")
**Focus: osi-server** (server consumes/advertises the watermark; the edge builder change it enables is a paired osi-os slice, noted §E)
**Depends on:** 5.4 (bootstrap jitter is the *interim* thundering-herd mitigation; 5.5 is the *structural* one — jitter smears the spike, delta removes most of the payload), and 1.B4's per-resource watermark machinery being present.
**Repo split:** the server change is in `/home/phil/Repos/osi-server`; the edge-builder change it enables is osi-os flows. This item designs both sides; DOCUMENTS-ONLY, no implementation.

## Problem

Every 6 h, every gateway POSTs `/api/v1/sync/edge/bootstrap` a **fixed-size recent-window snapshot** of its state, and the server re-upserts all of it (`EdgeSyncService.applyBootstrap`, verified `:99-169`: loops over users, zones, schedules, devices, sensorData, dendroReadings, chameleonReadings, dendroDaily, zoneRecommendations, zoneEnvironments, gatewayLocations, irrigationEvents — upserting each, then stamps `SyncCursor.lastFullBackfillAt = now`). The payload is **not** a full-DB dump (verified in the edge `Build Cloud Bootstrap` node: sensor data windowed to 3 days LIMIT 500, dendro/chameleon 30 days LIMIT 500, dailies LIMIT 365, etc.) — but it is **the same fixed-size payload on every tick regardless of whether anything changed**. A gateway whose telemetry hasn't moved since the last bootstrap re-sends and the server re-upserts hundreds of rows to arrive at zero net change.

At scale this is doubly wasteful: (1) **thundering herd** — N gateways on aligned 6 h ticks (5.4's jitter smears the *timing*, not the *volume*); (2) **redundant work** — each tick re-upserts data the server already has, burning CPU/IO on the 4 GB host and WAL on Postgres for no state change. The existing machinery to fix this is already in place and unused for bootstrap: **`SyncResourceWatermark` (per `(gateway_eui, resource_type, resource_id)`, `highest_sync_version` + `payload_hash`) and `SyncCursor.lastFullBackfillAt`** are exactly a "what has the server already durably seen" ledger. The event path (`applyEventsV2`) already consults watermarks; the bootstrap path ignores them.

## Verified ground truth

1. **`applyBootstrap` is a distinct code path from the watermark-guarded `applyEventsV2`** (`applyBootstrap` at `:99`; the **guarded** event path is `applyEventsV2` at `:213`, which consults `watermarkRepository` ~`:271-294` — **not** `applyEvents` at `:173`, which is the V1 *legacy* blind path that also has no guard; the reusable guard lives in `applyEventsV2`/`applyOne`, so that is the path 5.5 reuses). `applyBootstrap` does **not** consult `SyncResourceWatermark` at all — it unconditionally upserts every row in the request and never checks whether a row is stale. It stamps only `SyncCursor.lastFullBackfillAt` at the end (`:164-167`). (So bootstrap and the guarded event path have *divergent* idempotency models today — the event path is watermark-guarded, bootstrap is blind-upsert.)
2. **The watermark table already carries the delta cursor** (`SyncResourceWatermark`, verified): `highest_sync_version` per resource, `payload_hash`, `last_event_uuid`, `updated_at`. This is the "high-water mark the server has durably applied" — precisely what an incremental bootstrap needs to tell the edge "send only what's newer."
3. **`SyncCursor` has `lastFullBackfillAt` and `lastEventAt`/`lastEventUuid`** per peer node — a per-peer full-snapshot timestamp already exists; a "last incremental bootstrap" concept slots alongside it.
4. **The edge bootstrap builder is already windowed** (`Build Cloud Bootstrap`, verified: `limitRecentDays(3)` for sensor, `limitRecentDays(30)` for dendro/chameleon, `LIMIT 500/365/200`) — so the payload is bounded but time-window-based, not watermark-based. The delta redesign replaces the time window with a server-supplied watermark for the append-heavy resources.
5. **The bootstrap request/response is a defined contract** (`EdgeBootstrapRequest` with typed collections; the controller returns a `Map<String,Object>`). Adding a watermark exchange fits the existing bootstrap round trip (request carries state; response can carry the watermark snapshot the edge uses next time — or the edge fetches it, see §B).
6. **Fleet is small today** (3 live gateways: Silvan, kaba100, Uganda). The thundering herd is a **~30–100× problem**; at 3 gateways the redundant work is negligible. **This is why scheduling is deferred** — the spec exists so the machinery is designed and ready before the fleet forces it, not because it's needed now.

## Design

### A. Incremental bootstrap = watermark-delta, full-snapshot only on cursor gap

**The model:**
- The server maintains, per `(gateway_eui, resource_type[, resource_id])`, the `highest_sync_version` it has durably applied (already true for the event path via `SyncResourceWatermark`).
- On an **incremental** bootstrap, the edge sends only rows whose `sync_version` (append resources) or state (upsert resources) is **newer than the server's acknowledged watermark** for that resource — not a fixed time window. A gateway with no new data since the last successful bootstrap sends a near-empty payload; the server upserts nothing and advances nothing.
- A **full snapshot** (today's windowed behavior) is sent **only on cursor gap** — i.e. when the edge and server disagree on the watermark baseline, or no baseline exists:
  - first-ever bootstrap for a gateway (no `SyncCursor`/watermark rows),
  - the server signals it lost/reset state (watermark absent or older than the edge's floor),
  - the edge cannot prove continuity (its own record of "last acknowledged watermark" is missing — e.g. after an edge DB restore),
  - a periodic **full-resync cadence** (e.g. every Nth bootstrap or once per day) as an anti-entropy backstop so silent drift self-heals without waiting for a detected gap.
- This mirrors the pre-ruled decision verbatim: **watermark-delta incremental; full snapshot only on cursor gap.**

**Why watermark-delta over "send changed since lastFullBackfillAt":** a timestamp cursor is fragile against clock jumps (item 5.6) and against out-of-order edge writes; the per-resource `highest_sync_version` is monotonic and already the authority the event path trusts. Reusing it keeps bootstrap and event idempotency models **convergent** rather than divergent (ground-truth #1 notes they diverge today — this is an opportunity to align them).

### B. Watermark exchange — the round trip

Two viable shapes; **decision: server advertises its watermark snapshot, edge diffs against it.**

- **On bootstrap request**, the server responds with (or the edge first GETs) a compact **watermark manifest**: per resource-type, the `highest_sync_version` (and/or a coarse `(resource_id → version)` map for upsert resources) the server has durably applied for that gateway. Reuse of the existing `sync_resource_watermarks` rows — a read, not new state.
- **The edge** builds its next bootstrap by selecting only rows above the advertised watermark per resource. For append resources (`sensor_data`, `dendro_readings`, `chameleon_readings`, `irrigation_events`, `zone_environments`) this is `WHERE sync_version > :serverWatermark`, **or** `recorded_at`-based where a table has no per-row `sync_version` column. For upsert resources (`zones`, `schedules`, `devices`, `gateway_locations`, `dendro_daily`, `zone_recommendations`) it is `WHERE sync_version > :serverWatermark` on the aggregate. **OPEN ITEM for Task 0.2 (scheduling-time re-verification):** whether each append table carries a per-row `sync_version` (enabling the clean watermark filter) or must fall back to `recorded_at` (needing a monotonic-timestamp caveat, clock-jump-interacting with item 5.6) is an **edge-schema question this server-focused spec cannot settle now** — it must be resolved per resource at scheduling time by reading the edge `farming.db` schema (`sync_outbox`/the per-table `sync_version` columns). Recorded as open, not decided.
- **The server** on receiving the delta bootstrap applies it **through the watermark guard** (the same stale/equal-version logic `applyEventsV2` uses), so a re-sent-but-already-applied row is a no-op rather than a blind re-upsert — closing ground-truth #1's divergence.

**Fallback on any watermark uncertainty → full snapshot.** If the manifest is missing, malformed, or the edge cannot establish it has a coherent baseline, the edge sends today's windowed full snapshot and the server applies it (blind-upsert, as today) — correctness over efficiency. The full path is never removed; it is the safe default the delta path *optimizes away* when both sides agree.

### C. Server-side changes (in scope to design; deferred to schedule)

- **A read endpoint (or bootstrap-response field) exposing the per-gateway watermark manifest** from `sync_resource_watermarks` — read-only, no new table. Bounded, admin-or-gateway-scoped like the existing sync endpoints.
- **`applyBootstrap` gains a delta mode:** when the request declares itself incremental (a flag/field), route each resource's rows through the watermark-guarded apply (reuse the event path's stale-version comparison — post-1.B4 / 3.4 this is the applier + `applyOne` machinery, so a delta bootstrap and an event batch converge on the same per-resource apply) rather than blind upsert. A full-mode request keeps today's exact behavior.
- **Cursor-gap detection:** the server decides "you must send a full snapshot" when it has no watermark baseline for the gateway (or a periodic anti-entropy full is due) and signals it in the manifest response; the edge honors it.
- **No schema change strictly required** — `sync_resource_watermarks` and `SyncCursor` already carry everything. A small `SyncCursor` field (`lastIncrementalBootstrapAt`, and/or a full-resync-due marker) may be added for anti-entropy cadence bookkeeping; keep additive.

### D. Deferred scheduling — the explicit trigger (pre-ruled: not until ~10 gateways)

**This spec is written now; the machinery is NOT scheduled/enabled until the fleet reaches ~10 gateways.** The trigger, recorded per the pre-ruling:

- **Enable when the fleet crosses ~10 gateways** (the scale-table's "~30–100×" herd threshold begins biting well before 100; ~10 is the conservative early flip so the machinery is proven before it's load-critical), **or** when measured bootstrap-driven VPS load (CPU/WAL/upsert volume during the aligned tick window) exceeds a documented budget — whichever comes first.
- **Until then:** 5.4's bootstrap jitter is the sufficient interim mitigation (smears the timing spike across the interval); the redundant-payload cost at 3–10 gateways is negligible and not worth the added protocol complexity and its testing burden.
- **The deferral is a feature, not a gap:** shipping the delta protocol before it's needed adds a divergent code path (full vs delta) that must be kept correct through 1.B4/3.4's churn for zero present benefit. Designing it now (so the watermark contract is understood and the edge builder's eventual change is scoped) while deferring the enable is the honest YAGNI-respecting posture the program mandates ("Resist scaling ambition… until… the ~10th gateway forces the next decision").

### E. Edge-side counterpart (paired osi-os slice, noted not built)

The delta requires the edge `Build Cloud Bootstrap` node to (1) fetch/consume the server watermark manifest, (2) select rows above the watermark instead of the fixed time window, (3) fall back to the full windowed snapshot on any uncertainty. This is a real flows.json change (the `Build Cloud Bootstrap` node is a normal function node, editable under `osi-flows-json-editing` change control — not the frozen `sync-init-fn`), both-profile parity required. **Designed here, implemented as a paired osi-os slice when the §D trigger fires** — the edge and server changes must land together (or behind a full-mode default so an un-upgraded edge keeps working, which the fallback in §B guarantees). The fallback is what makes this non-breaking: an old edge that never sends the incremental flag simply keeps hitting the full path.

## Testing (designed; runs when the item is scheduled)

- **Delta correctness (Testcontainers, 1.B4 slice):** seed watermarks, send an incremental bootstrap whose rows are all ≤ watermark → assert zero upserts, zero watermark advance; send rows > watermark → assert only those apply and the watermark advances; interleave a stale row inside a fresh batch → assert stale is skipped (converged with the event path's behavior).
- **Cursor-gap → full:** no watermark baseline → server signals full-required → edge (simulated) sends full → today's behavior reproduced exactly.
- **Anti-entropy full cadence:** every Nth bootstrap forces a full even with a valid watermark → assert drift self-heals (a row the server somehow lost gets re-sent on the next full).
- **Backward-compat:** a full-mode request (no incremental flag) applies identically to today's `applyBootstrap` — the full path is untouched.
- **No production/live access;** all synthetic.

## Non-goals

- **Enabling/scheduling the incremental path** — deferred to the §D trigger (~10 gateways). This item designs and (when scheduled) implements the machinery; it does not turn it on now.
- **Removing the full-snapshot path** — it is the permanent safe default the delta optimizes away; never removed.
- **A new event/streaming protocol** — this is delta-on-the-existing-bootstrap-round-trip, not Kafka/CDC (YAGNI, per the program's rejected-at-scale list).
- **Changing the event path (`applyEventsV2`)** — 5.5 reuses its watermark guard for delta bootstrap apply; it does not modify it.
- **The 6 h cadence or jitter** — cadence stays; jitter is 5.4's job. 5.5 changes payload *content*, not timing.
- **Implementing the edge builder change now** (§E) — paired slice, lands with the server side when scheduled.

## Definition of Done (of the SPEC, since implementation is deferred)

- The watermark-delta model, the cursor-gap → full-snapshot fallback, and the anti-entropy full cadence are specified against the verified `SyncResourceWatermark` / `SyncCursor` / `applyBootstrap` machinery (this document).
- The server-side changes (watermark manifest exposure, delta-mode `applyBootstrap` reusing the event-path guard, cursor-gap detection) are scoped without requiring a new table (additive `SyncCursor` field only if used for anti-entropy bookkeeping).
- The paired edge-builder change (§E) is scoped and explicitly marked as a paired osi-os slice, with the full-mode fallback guaranteeing non-breaking coexistence.
- **The deferral trigger (§D: ~10 gateways or measured bootstrap load budget) is recorded** — the explicit pre-ruled requirement that this item "spec now, schedule later."
- Testing strategy designed against the 1.B4 Testcontainers slice, to run when the item is scheduled.
- "Open decisions" shows none outstanding.

## Open decisions

None outstanding.

- Delta cursor: **per-resource `highest_sync_version` watermark, not a timestamp**, decided in §A — monotonic, clock-jump-safe, already the event path's authority; reusing it converges bootstrap and event idempotency models (which diverge today, ground-truth #1).
- Watermark exchange: **server advertises the manifest from `sync_resource_watermarks`; edge diffs and sends only rows above it; any uncertainty → full snapshot**, decided in §B — read-only reuse of existing rows, no new state, full path as the permanent safe default.
- Full-snapshot triggers: **first-ever / lost-baseline / edge-can't-prove-continuity / periodic anti-entropy cadence**, decided in §A — cursor gap plus a self-healing backstop.
- Scheduling: **deferred until ~10 gateways or a measured bootstrap-load budget**, decided in §D — the explicit pre-ruled spec-now-schedule-later; 5.4 jitter is the interim mitigation.
- Backward compatibility: **incremental is opt-in via a request flag; absent flag → full path unchanged**, decided in §B/§E — an un-upgraded edge keeps working via the fallback; the paired edge/server slices can land together without a flag-day.
