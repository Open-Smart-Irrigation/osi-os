# Valve control Phase B — edge→cloud parity: design

**Status:** draft for review. The fundamental decisions in §5 are deliberately
left open for an independent reviewer; everything else is either inherited from
the Phase A design or is a mechanical consequence of it.

**Predecessor:** [2026-08-19-valve-control-design.md](2026-08-19-valve-control-design.md)
(Phase A, shipped). Read §7 "Data model" and §8 "Cloud" of that document first —
this spec extends it and does not restate its data model.

**Scope of this document:** the **edge** half only. The osi-server half is a
lockstep plan in that repository and is referenced here only where the edge
shape depends on it.

---

## 1. What this is

Phase A shipped valve control end-to-end on the gateway: schedules, compile,
LoRaWAN push, ACK tracking, observed runs, and (since 2026-08-23) a
hardware-verified GEN2 encoder. None of it reaches the cloud.

Phase B closes exactly one gap: `valve_schedules` rows become domain events the
cloud can ingest, via the op `VALVE_SCHEDULE_UPSERTED`.

That op is currently declared in `docs/contracts/sync-schema/events.schema.json`
and implemented by **neither** side. It is the sole reason
`scripts/verify-sync-op-parity.js` fails:

```
schema (24): … VALVE_SCHEDULE_UPSERTED …
server (18): … (no VALVE_SCHEDULE_UPSERTED)
  schema extra vs deployed edge plus staged union: VALVE_SCHEDULE_UPSERTED
verify-sync-op-parity: FAIL
```

Making that verifier go green is the acceptance signal for the pair of changes.

## 2. What is already covered — CORRECTED after review

An earlier draft of this spec claimed "valve actuations already reach the cloud".
**That is true only for ONCE schedules, and it was the wrong premise to build on.**

Verified:

- `irrigation_events` is written from exactly two places in the valve module,
  `workers.js:53` and `:62`, both inside **`runOnceTick`** — and only when the
  valve has both a zone and a user.
- **`runObserveTick` writes zero `irrigation_events`.** That is the worker that
  files observed *weekly* and on-valve runs. Those land only in
  `valve_actuation_expectations`.
- `valve_actuation_expectations` has **no sync trigger in any migration**
  (checked across `0001`, `0011`, `0019`, `0022`). It never reaches the cloud.

**So the flagship weekly path is invisible to the cloud.** Under Phase B as
scoped, the cloud would receive valve *schedules* and never see them *execute* —
a farmer looking at the cloud would see a plan with no runs against it.

Whether to close that gap in Phase B or record it as a known limitation is a
decision, not an established fact (see §10). What Phase B does not need to
rebuild is the ONCE path, which genuinely does flow.

## 3. Decisions inherited from Phase A (binding unless §5 overturns them)

Quoted from the 2026-08-19 design, §4 and §8:

| Decision | Detail |
|---|---|
| Migration | `0024`, **trigger-only** — Phase A already shipped `schedule_uuid`, `sync_version`, `deleted_at` on `valve_schedules`, so no columns are added |
| Aggregate | type `VALVE_SCHEDULE`, key `schedule_uuid` |
| Op | `VALVE_SCHEDULE_UPSERTED` |
| Trigger pair | `_ai` + `_au`, mirroring the `irrigation_schedules` pair |
| `_au` guard | fires only when cloud-linked **and** a synced column actually changed |
| Not synced | `valve_settings` and `valve_schedule_pushes` have no sync triggers |
| Write direction | cloud-authored changes arrive as **commands**, the edge compiles and pushes — so the valve has exactly one writer |

The single-writer rule is the load-bearing one. The valve is a Class A device
with a 4-window-per-day plan; two writers racing to compile a plan would produce
downlinks that silently overwrite each other's days.

## 4. What has changed since 2026-08-19

Four things, and the first two weaken a stated rationale.

**(a) "every live gateway is cloud-linked" is no longer true.** That was the
reason Phase A deferred the triggers — emitting an aggregate the cloud has never
seen produces terminally-rejected outbox rows. The Bovey Pi 4 has **no
`sync_link_state` row at all**, so its triggers would never fire. The risk is now
conditional on link state rather than universal, which changes the sequencing
argument (see D3).

**(b) AgroLink is a separate cloud instance on a separate branch pair.** Parity
work on this branch does not serve AgroLink and must not be justified by it.

**(c) GEN2 shipped and is hardware-verified** (2026-08-23, a real SV2 ACKed a
daymask plan on FPort 25 and a clock sync on FPort 13). Phase C is partly done.
Any cloud-side `ValveSchedule` resource must therefore be generation-agnostic
from the start — it must not assume the Gen1 weekday-port model.

**(d) The outbox has a measured cost, which was not known when Phase A was
written.** On a Pi 5, same box, same rows:

| | rows/s |
|---|---|
| bulk insert **with** the `device_data` outbox trigger | 2,083 |
| same insert **without** it | 25,000 |

A `DEVICE_DATA` outbox payload averages **1,388 bytes** for a measurement row
carrying ~100 bytes of data, because it denormalizes `device_name`,
`device_type`, `zone_id`, `zone_uuid` and `gateway_device_eui` into every row.

This does **not** by itself argue against a valve-schedule trigger — schedules
change a handful of times per day, not 96 times per device per day. It is
recorded here because D1 asks whether Phase B should adopt the existing pattern
or the one we may be about to change.

**(e) Weekday bit order was never written down.** It is `bit0 = Sunday …
bit6 = Saturday` (confirmed against `plan.js:117 WEEKDAY_INDEX` and
`valveState.ts:56`, which maps a Monday-first *display* order over the same
0=Sunday storage). The GUI displays Monday-first; the wire format and the mask
are Sunday-first. This is exactly the kind of mismatch that silently shifts a
farmer's irrigation by a day across a runtime boundary, and it belongs in
`canonicalization.md` as a cross-runtime contract.

## 5. Fundamental decisions — for independent review

These are the questions a reviewer should rule on. Each states the choice, the
evidence, and what it costs to be wrong.

### D1 — Trigger-emitted outbox, or watermark?

**Choice:** (i) follow the existing pattern — a `_ai`/`_au` trigger pair writing
`sync_outbox` rows with a denormalized JSON payload; or (ii) adopt a
cursor/watermark for `valve_schedules` as a pilot for a broader outbox redesign.

**Evidence for (i):** it is the pattern every other aggregate uses, the verifier
and delivery machinery already understand it, and schedule churn is low — the
measured 12× ingest penalty applies to per-measurement telemetry, not to a table
that changes a few times a day. Consistency has real value in a contract shared
across two runtimes.

**Evidence for (ii):** we may well change the telemetry path (99% of outbox
volume is append-only telemetry), and adding a 25th trigger to a pattern we are
questioning entrenches it further.

**Recommendation: (i).** The cost argument does not apply at schedule volume,
and coupling Phase B to an unresolved redesign would block a small, well-specified
change behind a large, unspecified one. If the outbox is later redesigned,
migrating one low-volume aggregate is cheap.

**If wrong:** we write a 0024 trigger pair and later replace it. That is one
migration and one contract revision — recoverable.

### D2 — Is the cloud authoritative for valve schedules?

**Choice:** edge-authoritative with cloud commands (Phase A's stated model), or
genuine bidirectional ownership.

Phase A already chose edge-authoritative: `UPSERT_VALVE_SCHEDULE`,
`DELETE_VALVE_SCHEDULE`, `RESEND_VALVE_PLAN`, `SET_VALVE_SCHEDULER_STATUS`
arrive as commands and route to the same handlers as the REST endpoints, so the
compile/push path is identical whether a farmer edits on the gateway or in the
cloud.

**The reviewer should confirm this still holds**, because it determines whether
`sync_version` needs conflict resolution at all. Under edge-authoritative, the
edge always wins and `sync_version` is a change-detector. Under bidirectional it
becomes a real vector clock and needs a documented merge rule.

**If wrong:** a farmer edits in the cloud during an outage, the edge edits the
same schedule, and one silently loses. On a valve that is a wrong irrigation.

### D3 — What should an unlinked gateway do?

The Bovey Pi 4 has no `sync_link_state` row. With the inherited `_ai`/`_au`
guard (`WHEN EXISTS (… linked = 1)`), its triggers never fire — so schedules
created before linking are **invisible to the cloud forever**, because the
outbox only ever captured changes, not state.

**Options:** (a) accept it — the gateway is a bench unit; (b) emit regardless of
link state and let the rows queue (risks the terminally-rejected-rows problem
Phase A warned about); (c) a backfill-on-link step that walks existing
`valve_schedules` and enqueues one upsert each.

**Recommendation: (c)**, reusing the existing `last_full_backfill_at` concept in
`sync_cursor`. This is the only option that makes "link an existing gateway"
produce a correct cloud state, and every gateway that adopts valve control after
Phase B will be in exactly this position.

**If wrong:** a farm's existing schedules never appear in the cloud, and nobody
notices until someone edits one.

### D4 — Does `valve_settings` really stay edge-only?

Phase A says no sync. But `flow_rate_lpm` is what converts a duration into
litres, and litres are what the cloud reports. Today the cloud receives
`estimated_gross_liters` on the actuation event, computed edge-side — so the
number crosses even though its input does not.

**CORRECTION after review — the premise above was false.** `estimated_gross_liters`
does **not** cross to the cloud. It exists only on `valve_actuation_expectations`
(`0001__baseline.sql:809`), which has no sync trigger, and the
`IRRIGATION_EVENT_APPENDED` payload carries no volume field at all — its keys are
`contract_version, event_uuid, event_id, user_id, irrigation_zone_id, zone_uuid,
gateway_device_eui, action, reason, aggregate_kpa, threshold_kpa,
duration_minutes, valve_deveui`.

So the cloud receives **no** per-valve volume today, estimated or otherwise. The
ruling (edge-only for Phase B) still stands on its own merits —
`valve_settings` has neither `sync_version` nor `deleted_at`, so syncing it later
is not a trigger-only migration — but the "the number crosses anyway" argument
must not be used to support it. If cloud-side litres are wanted, the cheap route
is adding the edge-computed estimate to the irrigation-event payload, not
syncing `valve_settings`.

**Recommendation: keep it edge-only for Phase B**, and record explicitly that
adding it later costs a column migration.

### D5 — Soft delete: carried field or distinct op?

`valve_schedules.deleted_at` is a soft delete, and the contract already
contains both patterns: zones use a distinct `ZONE_DELETED` op, while
`irrigation_schedules` carries `deleted_at` *inside* the upsert — its `_au`
guard lists `COALESCE(NEW.deleted_at,'') <> COALESCE(OLD.deleted_at,'')` and
still emits `SCHEDULE_UPSERTED` (`0003__stamp_contract_version_and_zone_op_split.sql`).

**Recommendation: carry `deleted_at` in the upsert**, matching the
schedule-shaped precedent rather than the zone-shaped one — `valve_schedules`
is a near-mirror of `irrigation_schedules`, so the reviewer should have to argue
*against* consistency rather than for it.

Whichever is chosen, the cloud must not resurrect a deleted schedule on a
replayed event; state that as an explicit acceptance test rather than an
assumption about arrival order.

## 6. Edge changes (once §5 is ruled on)

Subject to the decisions above; this is the shape under the recommended answers.

1. **Migration `0024__valve_schedule_sync_triggers.sql`** — trigger-only.
   `trg_sync_valve_schedules_outbox_ai` and `_au`, mirroring
   `trg_sync_irrigation_schedules_*` in `0003`. `_au` guard lists exactly the
   synced columns: `kind`, `label`, `weekdays_mask`, `start_time`, `fire_at`,
   `duration_minutes`, `timezone`, `enabled`, `once_state`, `deleted_at`,
   `sync_version`. Deliberately **not** `once_fired_at` (edge bookkeeping) —
   including it would emit an event every time a ONCE schedule fires.
2. **Contract** — `resources.schema.json` gains `ValveSchedule`;
   `commands.schema.json` gains the four commands; `canonicalization.md` gains
   the weekday bit order (§4e) and `start_time` format.
3. **Route Command** (`934bf2bc19a8ce22`) gains the four command cases,
   delegating to the existing `osi-valve-control` API handlers so there is one
   code path per operation.
4. **Backfill-on-link** (D3) — enqueue one upsert per existing non-deleted
   `valve_schedules` row when a gateway transitions to linked.

## 7. Verification

- `node scripts/verify-sync-op-parity.js` — **green** (the acceptance signal;
  requires the osi-server change, hence lockstep).
- `node scripts/verify-sync-contract.js`, `verify-sync-flow.js`,
  `verify-no-stray-ddl.js`, `verify-migrations.js`, `verify-seed-replay.js`,
  `verify-trigger-body-parity.js`.
- Both hardware profiles identical (`verify-profile-parity.js`).
- A migration test proving `_au` does **not** fire on an unsynced-column update
  (e.g. `once_fired_at`), and **does** on `enabled`.
- On an unlinked gateway: no outbox rows are produced at all.

## 8. Sequencing

Lockstep with the osi-server release, as Phase A specified. The edge migration
must not reach a linked gateway before the server can accept the op, or the
outbox fills with terminally-rejected rows. The Bovey Pi 4 is unlinked, which
makes it a safe place to land and test the edge half first (D3 backfill then
becomes the mechanism that populates the cloud when it is finally linked).

## 9. Server-side facts that bind this design

From a read-only survey of `osi-server@main` (2026-08-23). These are not
suggestions to the cloud team — they are constraints the *edge* shape has to
respect, and three of them are load-bearing.

**Cloud-side valve support is greenfield.** Zero occurrences of
`valve_schedule` / `VALVE_SCHEDULE` in osi-server. The existing valve surface is
device-level only (`Device.currentValveState`, `DeviceType.STREGA_VALVE`, Strega
command endpoints). Nothing was staged in anticipation, and there is no
`UPSERT_VALVE_SCHEDULE` command. So the server half is a real piece of work, not
a registration.

**Three server gaps would make our events die terminally, not retry:**

1. `EventResourceRef.resourceTypeFromOp` (`EdgeSyncService.java:1632`) — a
   `VALVE_*` op falls through to `"EVENT"` with resource-id = `event_uuid`,
   which **silently disables watermark dedupe and ordering**. Every replay would
   look like a new resource.
2. `EdgeOwnershipService.resolveOwnerEui` (`:22`) — an unmapped resource type
   yields a `null` owner, and that is **terminal `ownership_denied`**, not
   retryable. This is the same bootstrap gap already known from
   `sync-ownership-bootstrap-gap-2026-08-12`.
3. `SyncEventTxExecutor.isParentMissing` (`:228`) decides retryable-vs-terminal
   by **literal exception message prefixes** (`"Zone not found"`,
   `"Schedule not found"`). A valve-schedule handler that throws any other
   wording gets its events dead-lettered permanently.

Consequence for **D3 (backfill)**: backfilled events for a schedule whose parent
device/zone has not yet landed on the cloud will be **terminally dead-lettered**,
not retried. Backfill ordering therefore matters — parents before children — or
the backfill must run only after the structural bootstrap has been acknowledged.
The reviewer should treat this as part of D3, not an implementation detail.

**Mechanics we must match:**

| Constraint | Value |
|---|---|
| Dispatch | two-stage: `appliersByOp` registry (from `List<SyncEventApplier>`) then a single `switch (event.op())` |
| What the parity verifier reads | that one switch in `EdgeSyncService.java`, plus sibling `.java` files implementing `SyncEventApplier` (`verify-sync-op-parity.js:1215`) |
| Trigger-emitted ops | must be listed in `SQL_OWNED_EVENT_OPS` (`:83`), else the verifier reports no edge emitter |
| `event_uuid` | **≤ 36 chars** or it is never recorded in `sync_inbox` and replays forever (`SyncEventTxExecutor.java:25,194`). Our `lower(hex(randomblob(16)))` = 32 ✓ |
| `payload_json` | must carry top-level `contract_version` (`verify-sync-op-parity.js:462`) |
| Batch size | ≤ 100 events (sync protocol 2) |
| Column widths | `resource_type VARCHAR(64)`, `resource_id VARCHAR(128)` |
| Unknown op (v2) | dead-lettered `unknown_op` *before* ownership/watermark; rest of the batch is unaffected |
| Idempotency | `sync_inbox` by `event_uuid`; plus a `(gateway, resource_type, resource_id)` watermark on `highest_sync_version` + canonical `payload_hash` |

**Confirms D2 (edge-authoritative).** There is no cloud→edge *event* mirror at
all — `recordOutboxMirror` (`EdgeSyncService.java:509`) is dead code, never
called. Cloud-authored change reaches the edge only as a pending command, which
is exactly the model Phase A specified. The precedent is
`IrrigationZoneController.updateSchedule:71`, which issues `UPSERT_SCHEDULE`
with `syncVersion + 1`.

**One open question the survey could not settle**, and the reviewer should:
what `resource_type` / resource-id a valve schedule uses — per-schedule
(`schedule_uuid`) or per-zone. There is no server precedent, and it determines
watermark granularity and how the ownership resolver finds the owning gateway.
Note the nearest analogue, `irrigation_schedules`, is **one row per zone**
(`zone_id` is UNIQUE) whereas `valve_schedules` is **many per device** — so the
analogue does not transfer cleanly, and copying it blindly would be wrong.

## 9b. Known future direction: shared schedules

**Operator intent, 2026-08-24:** saved schedules are conceptually a plan for the
whole holding, not a per-valve detail. A fleet-wide *read* view shipped
immediately (`ValveScheduleOverview`). The larger change — one schedule
*applied to several valves*, edited once — is deliberately deferred, and the
cloud side should be designed knowing it is coming.

Why it is not a display change: `valve_schedules.device_eui` is
`NOT NULL REFERENCES devices(deveui)`, one schedule to one valve. Sharing needs
a join table and a migration.

**It also reopens a decision already made here.** The server resource id is the
composite `device_eui|schedule_uuid`, chosen so ownership resolves from the EUI
prefix and each schedule gets its own watermark slot. A schedule spanning
several valves has no single `device_eui`, so that key would need rethinking on
both sides — along with the `EdgeOwnershipService` branch that parses it.

Anyone taking this on should re-read D2 and the resource-key ruling before
touching the schema, rather than treating it as a GUI feature.

## 10. Open items

- `verify-sync-op-parity.js` fails on `main` too. Confirm it goes green rather
  than merely changing which op it complains about.
- Whether the cloud reuses `irrigation_schedules` or gets a new table is an
  osi-server decision; it does not change the edge payload.
- **Open, raised by review:** weekly/on-valve runs never reach the cloud (§2).
  Decide whether Phase B closes that (an `irrigation_events` write from
  `runObserveTick`, or a sync trigger on `valve_actuation_expectations`) or
  records it as a documented limitation.
