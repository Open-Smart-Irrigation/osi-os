# AgroLink hub operational hardening — design

**Date:** 2026-07-19 (v2, revised after two independent external reviews)
**Status:** Approved direction, pending implementation plan
**Context:** AgroLink runs one shared Pi 5 hub (16 GB RAM, NVMe RAID) for 20–30 accounts. The hardware removes SD-card and memory constraints; it does not fix the single Node-RED event loop or the single serialized database queue (§3). This spec covers the operational changes for that hub, independent of the scoped-access work in [2026-07-19-agrolink-scoped-multiuser-design.md](2026-07-19-agrolink-scoped-multiuser-design.md).

## 1. Goal and non-goals

Keep response times acceptable for a dozen concurrent dashboard users and keep the database healthy for years on NVMe, with changes small enough to merge without destabilizing the maintained profiles. Non-goals: replacing SQLite (write load is far inside its WAL envelope; the constraint is queue topology, §3), horizontal scaling, multi-process Node-RED.

## 2. Storage layout and backup durability on NVMe

`/data` (database, backups) moves onto the NVMe RAID in the hub image; the SD card holds only boot and rootfs. The deploy path must detect the NVMe mount and skip its fresh-SD assumptions.

Backups: a daily timestamped `sqlite3 .backup` of `/data/db/farming.db` into `/data/db/backups/`, retained 30 days, plus the existing pre-repair backup rule. Two production requirements, not options:

- **Storage budget and disk-pressure behavior.** Thirty full copies need 30 × current DB size plus WAL headroom; the hub image provisions that budget on the RAID and the backup job checks free space before starting, prunes oldest first, and raises a visible error (error-counter heartbeat path) when the budget is exceeded rather than filling the array.
- **Off-hub copy.** RAID-local backups cover single-disk failure, not array/controller loss, theft, or operator deletion. For a production research system an off-hub copy is a launch requirement: an rsync pull from the ops host is the minimum, Litestream-style WAL shipping the upgrade path (tracked against issue #56).

## 3. The real database topology and its actual bottleneck

v1 of this spec misread the access layer. Verified reality (`osi-db-helper/index.js`): the 92 `new osiDb.Database('/data/db/farming.db')` constructor sites in the flow return a **facade over one shared connection and one global FIFO operation queue**; `close()` is a no-op. Exactly one function node (the dendrometer sim setup) opens a raw `new sqlite3.Database`, the sole bypass. There is no connection sprawl and no `SQLITE_BUSY` problem.

The real bottleneck is the inverse: **head-of-line blocking on a single serialized queue.** Every dashboard read, telemetry write, scope resolution, nightly rollup, and export queues behind everything else; WAL's concurrent-reader capability goes unused because the facade serializes reads behind writes. One slow query — a 2-year export, a big rollup — stalls every DB-touching request, and rollups run on the same queue and event loop, so they are inside the request latency budget, not outside it.

H2 is therefore redefined:

1. **Benchmark first.** Measure queue depth and p95 latency under representative combined load — a dozen concurrent dashboard readers, live ingestion, a nightly rollup, a chunked export, a WAL checkpoint, and a `.backup` run — before changing anything. The scoped-access spec adds its own measurement (cold-cache `resolveScope`, its §14); the two share one benchmark harness.
2. **Bounded read-only snapshots for heavy reads.** Export and wide history queries move to a small pool (1–2) of read-only connections outside the FIFO queue, exploiting WAL snapshot isolation. Writes stay serialized on the existing queue. Pool bounded so a read storm cannot starve the writer.
3. **Fix or exempt the one raw constructor.** The dendro-sim raw `sqlite3.Database` either converts to the helper or is documented as a dev-only simulator path.

## 4. Bounding the expensive endpoints

One large export must not stall the event loop or the queue for everyone else. Four measures on the history and export endpoints:

1. **Range caps.** History queries without an explicit range default to the last 31 days; maximum 400 days per request. Larger spans go through pagination.
2. **Keyset pagination with snapshot semantics.** Exports paginate on `(recorded_at, id)` cursors, stable under concurrent inserts; the first page pins a snapshot timestamp so later pages read a consistent cut. Chunks (e.g. 10k rows) yield between iterations instead of materializing the full result in one `db.all`, and the HTTP response applies backpressure rather than buffering the whole export in memory.
3. **Query audit.** Each request-path query is checked against available indexes (`device_data(deveui, recorded_at)` and friends); any sequential scan over a telemetry table gets an index or a rewrite.
4. **Gate matches the mechanism.** The H3 acceptance test exercises the paginated workflow: a full 2-year export via cursor pages completes while a concurrent dashboard request stays within its latency budget. It does not assert a single 2-year request succeeds — that contradicts the range cap by design.

## 5. Raw telemetry retention tier (archive-first, default off)

`device_data` (and `chameleon_readings`, `dendrometer_readings`) grow forever by design; the edge is the canonical history store. Retention deletes are irreversible, so the tier is gated on proof that the data survives elsewhere — not on rollup presence. `history_channel_rollups` holds card-level statistics (min/max/mean/median per zone, card, channel, bucket), not per-device raw samples; it covers neither `chameleon_readings` nor `dendrometer_readings` raw. **Aggregate coverage is not deletion authority.**

H4 stays disabled until all of these exist:

- **Verified lossless off-hub archive** of the raw tables (§2's off-hub copy, or a table-level export), with a documented and rehearsed restore path into an edge DB.
- **Per-table/channel coverage manifests** stating exactly which ranges the archive holds, plus archive acknowledgements the prune job checks before deleting.
- **Delivered-cursor gate:** the prune additionally requires `sync_history_cursors` to show the affected ranges delivered, because pruned rows are permanently unavailable to cloud re-link backfill and to rollup recomputation if a rollup bug surfaces later.
- **Batched deletion with WAL hygiene:** small delete batches inside the latency budget, followed by checkpoint/vacuum behavior that keeps the file from growing past the freed pages without holding a long write lock.

Rollups and daily tables (`dendrometer_daily`, `zone_daily_*`, `gateway_health_hourly`) are never pruned. If Agroscope requires indefinite raw retention, leave the tier off: NVMe capacity is not the constraint, and query latency degrades gradually enough to revisit.

## 6. AgroLink branding

Login screen, GUI title, and favicon carry AgroLink branding. No branding configuration surface exists on main today, so this is a **new config seam** (image-level branding config consumed by the GUI at build or boot), not reuse of an existing one. Package names, topics, env vars, and the `osi-` prefix stay unchanged; branding is a display layer. Strings go through the i18n workflow.

## 7. What is deliberately not done

- No PostgreSQL on the hub: writes sit far inside SQLite's WAL envelope, and a swap would break `osi-migrate` and the single-file backup model. The queue-topology issue (§3) is fixed by read snapshots, not by a database swap.
- No rewrite of the write path: the serialized FIFO queue stays the single writer; §3 adds bounded read connections only.
- No multi-process Node-RED or clustering; §4 addresses the realistic stall sources.

## 8. Phasing

| Phase | Deliverable | Gate |
|---|---|---|
| H1 | NVMe `/data` layout, backup budget + disk-pressure behavior, off-hub copy | Fresh-flash rehearsal; restore test from off-hub copy |
| H2 | Queue benchmark harness; read-only snapshot pool for heavy reads; raw-constructor fix | Benchmark report; p95 dashboard latency within budget under combined load |
| H3 | Keyset-paginated exports, range caps, query audit | 2-year paginated export completes while a concurrent dashboard request stays in budget |
| H4 | Retention tier, enabled only after archive + restore verified | Restore rehearsal from archive; cursor-gate and manifest checks exercised on a seeded DB copy |
| H5 | AgroLink branding config seam | GUI build + visual check |

H1–H3 are prerequisites for the hub going live; H4 requires H1's off-hub copy and can follow; H5 is independent.

## 9. Revision history

- **v2 (2026-07-19):** folded in two external reviews. Changes: §3 rewritten around the verified facade/queue topology (v1's connection-sprawl premise was wrong; H2 redefined as benchmark + read snapshots); backup durability hardened (budget, disk pressure, mandatory off-hub copy); §4 gate contradiction resolved via keyset pagination; §5 retention re-gated from rollup coverage to archive-first with cursor gate and unrecoverability notes; §6 branding corrected to a new config seam.
- v1 (2026-07-19): initial approved direction.
