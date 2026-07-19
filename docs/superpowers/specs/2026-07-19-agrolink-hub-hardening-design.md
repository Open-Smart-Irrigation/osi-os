# AgroLink hub operational hardening — design

**Date:** 2026-07-19
**Status:** Approved direction, pending implementation plan
**Context:** AgroLink runs one shared Pi 5 hub (16 GB RAM, NVMe RAID) for 20–30 accounts. The hardware removes SD-card and memory constraints; it does not fix the single Node-RED event loop or the unbounded growth of raw telemetry. This spec covers the operational changes for that hub, independent of the scoped-access work in [2026-07-19-agrolink-scoped-multiuser-design.md](2026-07-19-agrolink-scoped-multiuser-design.md).

## 1. Goal and non-goals

Keep response times acceptable for a dozen concurrent dashboard users and keep the database healthy for years on NVMe, with changes small enough to merge without destabilizing the maintained profiles. Non-goals: replacing SQLite (analysis showed it is not the bottleneck at this load), horizontal scaling, multi-process Node-RED.

## 2. Storage layout on NVMe

`/data` (database, backups) moves onto the NVMe RAID in the hub image; the SD card holds only boot and rootfs. The deploy path must detect the NVMe mount and skip its fresh-SD assumptions. Backups: a daily timestamped `sqlite3 .backup` of `/data/db/farming.db` into `/data/db/backups/` on the RAID, retained 30 days, plus the existing pre-repair backup rule. The RAID protects against disk failure, not against deletion or corruption, so the backup schedule stays mandatory. Off-hub copy (Litestream-style WAL shipping or an rsync pull from the ops host) is an operator option, tracked against issue #56, not built here.

## 3. Database access consolidation on request paths

About 85 function nodes open a fresh `new osiDb.Database('/data/db/farming.db')` per execution, bypassing the `osi-db-helper` serialized queue. Under one operator this is harmless; under concurrent dashboards it produces `SQLITE_BUSY` spikes against the 5 s `busy_timeout`. The fix is an inventory plus conversion, in two tiers:

- **Tier 1 (convert):** every DB access reachable from an authenticated HTTP request path — dashboard lists, history queries, exports, `/api/me`, scope resolution — routes through `osi-db-helper` so reads and writes serialize predictably.
- **Tier 2 (leave):** batch/offline paths (rollups, prunes, simulators, migration rehearsal helpers) keep their own connections; they already run outside request latency budgets.

Conversion is mechanical: replace per-call open/close with the helper's promise interface, keep the existing error-visible `catch` convention. No schema change. The silent-catch and profile-parity verifiers guard the diff.

## 4. Bounding the expensive endpoints

One 2-year CSV export must not stall the event loop for everyone else. Three measures, applied to the history and export endpoints:

1. **Range caps.** History queries without an explicit range default to the last 31 days; maximum range 400 days per request. Larger spans require pagination.
2. **Row caps with continuation.** Export endpoints stream in chunks (e.g. 10k rows per iteration, yielding between chunks) instead of materializing the full result in one `db.all`.
3. **Query audit.** Each request-path query is checked against available indexes (`device_data(deveui, recorded_at)` and friends); any sequential scan over a telemetry table gets an index or a rewrite.

## 5. Raw telemetry retention tier

`device_data` (and `chameleon_readings`, `dendrometer_readings`) currently grow forever by design — the edge is the canonical history store. On a multi-year research hub this eventually slows even indexed range queries. Add an opt-in retention tier, default off:

- `OSI_HISTORY_RAW_RETENTION_DAYS` (e.g. 180): a daily job deletes raw rows older than the cutoff, but only after verifying that `history_channel_rollups` covers the period being pruned. If rollups are missing or stale, the job skips and warns instead of deleting unaggregated history.
- Rollups and daily tables (`dendrometer_daily`, `zone_daily_*`, `gateway_health_hourly`) are never pruned by this job.
- The AgroLink hub enables the tier at provisioning; default-off keeps the current canonical-history guarantee on all other deployments. If Agroscope requires indefinite raw retention, leave it off — NVMe capacity is not the constraint; query latency is, and it degrades gradually enough to revisit later.

## 6. AgroLink branding

Login screen, GUI title, and favicon carry AgroLink branding, driven by existing config (feature-flag/branding surface), not by renaming internals. Package names, topics, env vars, and the `osi-` prefix stay unchanged; branding is a display layer. Strings go through the i18n workflow.

## 7. What is deliberately not done

- No PostgreSQL on the hub: the measured load (sub-1 write/s, a dozen concurrent readers) sits far inside SQLite's WAL envelope, and a swap would break `osi-migrate` and the single-file backup model.
- No connection-pool rewrite of `osi-db-helper`; tier-1 conversion (§3) removes the pressure instead.
- No multi-process Node-RED or clustering; §4 addresses the realistic stall sources.

## 8. Phasing

| Phase | Deliverable | Gate |
|---|---|---|
| H1 | NVMe `/data` layout + daily `.backup` schedule in the hub image | Fresh-flash rehearsal; restore test from backup |
| H2 | Tier-1 DB-access consolidation | Sync-flow verifier + silent-catch ratchet green |
| H3 | Endpoint bounding (range caps, chunked exports, query audit) | Export of a 2-year range completes without blocking a concurrent dashboard request |
| H4 | Retention tier behind `OSI_HISTORY_RAW_RETENTION_DAYS` | Rollup-verified prune on a seeded DB copy; skip-when-stale path exercised |
| H5 | AgroLink branding config | GUI build + visual check |

H1–H3 are prerequisites for the hub going live; H4–H5 can follow.
