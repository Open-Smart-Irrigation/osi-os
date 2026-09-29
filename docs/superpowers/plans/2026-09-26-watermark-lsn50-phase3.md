# WATERMARK on the LSN50, Phase 3 (scheduler admission and raw-reading sync) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status (2026-09-29): E1 IS IMPLEMENTED; EVERY TASK AFTER E1 IS A SKETCH
> THAT MUST BE RE-PLANNED AGAINST MAIN BEFORE EXECUTION.** E1, the offline
> dry-down analyzer (`scripts/watermark-drydown-analysis.js` and its test),
> is implemented and lands separately from this document. The implemented
> analyzer also requires an integer `f_cnt` on every reading row and refuses
> two accepted rows with the same (`deveui`, `f_cnt`); `watermark_readings.f_cnt`
> is nullable on main, so export only rows that carry it. E2 to E11 and C1 to
> C6 were written against the unmerged phase 1 branch and the old phase 2 plan.
> Phase 1 is now on main as `ca08dcc13` (migration `0061__watermark_lsn50.sql`),
> so this plan's migration is `0063` there, after phase 2's `0062`. Re-plan
> those tasks against main and the rewritten phase 2 plan; do not execute them
> from the text below.
>
> **Review status (2026-09-27): E1 ONLY IS EXECUTABLE NOW; E2+ REMAINS NOT
> EXECUTABLE.** The project owner accepted OD-1 through OD-8 and
> directed OD-9 to follow the calibration/activation pattern intended for
> Chameleon and future SDI-12 calibration. The binding amendment below replaces
> `devices.watermark_enabled` with a calibration-bound admission resource.
> Task E1 has been rewritten as the executable bench-analyzer TDD task. Detailed
> sketches E2-E9 and C1/C3/C5/C6 still contain the old device-column design and
> must be rewritten before implementation. No worker may execute those sketches
> by mechanically substituting names.

**Goal:** A WATERMARK probe on a Dragino LSN50 drives the irrigation scheduler only after a person explicitly enables it, only while its calibration is live and Chameleon is off, and its raw readings reach the cloud.

**Architecture:**
- **Edge (osi-os) owns calibration-bound admission.** A new
  `watermark_scheduler_admissions` resource records `enabled`, the accepted
  `calibration_sync_version`, its own `sync_version`, and `updated_at`. One
  helper in `osi-watermark-helper/admission.js` is the only writer. The edge API
  and cloud command applier call it inside their transaction. No WATERMARK
  scheduler field is added to `devices`, and the frozen boot node is untouched.
- **The scheduler admits rows, not devices.** The phase 1 interlock becomes a
  per-row admission: a WATERMARK `device_data` row counts only when its
  admission is enabled, the admission names the live calibration version, and
  the row was converted under that same version. Chameleon rows keep the phase
  1 exclusion of WATERMARK rows.
- **Raw readings sync like Chameleon's.** Migration-owned triggers emit `WATERMARK_READING_APPENDED` on insert and again, with a higher `sync_version`, when a first calibration backfills a row. The cloud mirrors rows into a new `watermark_readings` table with retention.
- **Cloud (osi-server) mirrors and queues.** The cloud mirrors
  `WATERMARK_SCHEDULER_ADMISSION_UPSERTED` and queues
  `SET_WATERMARK_CONFIG` against that resource through the desired-state
  ledger. It never changes the mirror in response to the user's request.
- **Bench gate.** A dry-down protocol (separate document) decides whether unsettled readings may carry kPa. Task E10 implements that outcome only if the bench defines an envelope.

**Tech Stack:** Node-RED function nodes (Node 22), SQLite (`node:sqlite` in tests), the `osi-db-helper` facade, React + TypeScript + Vitest (edge GUI), Spring Boot 3 + Flyway/Postgres + JUnit 5 (cloud), React + Vitest (cloud GUI).

**Spec:** `docs/superpowers/specs/2026-09-25-watermark-lsn50-design.md` (§2 decisions D1, D2, D7; §8 phase 3; §11 tests; the §13 phase 2 addendum). Bench protocol: `docs/superpowers/plans/2026-09-26-watermark-dry-down-bench-protocol.md`. Phase 1 plan: `docs/superpowers/plans/2026-09-25-watermark-lsn50-phase1.md` (implemented, on main as `ca08dcc13`). Phase 2 plan: `docs/superpowers/plans/2026-09-26-watermark-lsn50-phase2.md` (REWRITE BEFORE EXECUTION); this plan was written against its `8d35fa4ca` revision, builds on its names and is reconciled with it below. Deferred work across all three phases: `docs/superpowers/plans/2026-09-29-watermark-deferred-work.md`.

## Confirmed owner decisions (2026-09-27)

The project owner accepted OD-1 through OD-8 as recommended. OD-9 is the
calibration-bound admission design below.

| # | Decision | Recommendation | Tasks affected |
|---|---|---|---|
| OD-1 | **Enable preconditions.** Spec §8: live calibration, `chameleon_enabled = 0`, at least one channel `ok` or `saturated` in the last 24 h. | Keep all three and tighten two of them. (a) The 24 h reading must have been converted under the **current** calibration version, so it proves the values being accepted produce a plausible kPa. (b) An enable request quotes the `calibration_sync_version` the person saw. On the edge API a mismatch is a 409 listing `calibration_changed`; on the command path it is acked `CONFLICT` / `stale_sync_version`, the phase 2 convention for a stale version, so the cloud ledger shows "conflicted" and the form reloads. Disabling has no preconditions. | E4, E5, E6, C5, C6 |
| OD-2 | **Revocation.** Spec: delete clears the flag in the same transaction; an update keeps it. | Keep that, and add a scheduler-side check as defense in depth: a WATERMARK row counts only if `watermark_readings.calibration_sync_version` equals the live calibration's `sync_version`. After a recalibration, rows converted under the old values stop counting at once and the next uplink (15 min in the field) restores admission. After a delete nothing counts even if a flag write were ever missed. | E4, E7 |
| OD-3 | **D7 mutual exclusion UX.** | Disable and explain, both directions, on both GUIs. Neither control auto-disables the other. The Chameleon toggle is disabled while WATERMARK control is on ("Turn off WATERMARK irrigation control first"). The WATERMARK control lists every unmet precondition by name. The servers refuse with 409 `watermark_scheduler_enabled` or `watermark_precondition_failed` whatever the GUI shows. Enabling needs a second confirming click that names the zone the probe will drive. | E5, E9, C5, C6 |
| OD-4 | **Raw-reading sync scope.** | Sync every `watermark_readings` row, `accepted` and `frame_rejected`, while the gateway is linked. The payload carries the raw hex. A calibration backfill re-emits the row with `sync_version + 1` (a new `watermark_readings.sync_version` column); do **not** register the table in history sync v1. Bootstrap and force sync carry the last 30 days, capped at 500 rows (the Chameleon numbers). The outbox pruner treats `WATERMARK_READING` as droppable telemetry. The cost: a reading whose outbox event is pruned under size pressure never reaches the cloud; history sync v1 would heal that. The data is diagnostic, not irrigation state, so the gap is acceptable. The raw event does not overlap phase 2's MQTT liveness (P2-7): `watermark-ingest-fn`'s telemetry auto-creates the device and refreshes `last_seen`, but the gateway-forwarded non-STREGA path returns before `updateCurrentState` and persists no canonical rows. `WATERMARK_READING_APPENDED` persists one mirror row per edge row and never touches `last_seen`. It does not lean on `device_data` events either, so the history hash v2 short-circuit (`SyncEventTxExecutor` answers `DEVICE_DATA_APPENDED` as `superseded_by_hash_v2` on a v2-active gateway) does not affect it; that short-circuit is keyed on the op, and this op has its own applier. | E2, E3, E8, C1, C2, C3 |
| OD-5 | **Retention.** Edge keeps raw rows indefinitely today. | Edge: unchanged (the edge DB is the full local history, like `chameleon_readings`; about 35 000 rows per node per year at 15 min). Cloud: 365 days, `osi.retention.watermark-readings.days`, the `TelemetryRetentionJob` default. | C4 |
| OD-6 | **Unsettled envelope: firmware or edge rule.** | Edge-side, versioned. The frame already carries early and late codes for both directions, so the edge can judge drift without a reflash, and a rule change bumps `conversion_version` (`wm-lsn50-p3-v2`) so every stored reading still says which rule produced it. The firmware flag stays a raw diagnostic. The bench tolerance is 3 kPa; the owner may tighten it before the run. Until the bench passes, the phase 1 rule stands (unsettled above 550 Ω gets no kPa). | E1, E10 |
| OD-7 | **Capability.** | A new capability `watermark_scheduler_v1`, advertised after phase 2's `watermark_v1`. A gateway on phase 2 firmware never receives `SET_WATERMARK_CONFIG`, and the cloud hides the control for it. The cloud also needs `watermark_v1` for the calibration version the enable quotes. | E6, C1, C5, C6 |
| OD-8 | **Field-use gate in code.** | No code gate. The per-device enable is the acceptance step, and D1 already makes kPa independent of scheduling. The bench gate is procedural: the release note and the enable confirmation say the circuit is experimental. A code flag would stay on long after the bench passed and nobody would know why. | E9, E11 |
| OD-9 | **Where scheduler admission lives on the edge.** | **A calibration-bound resource, not a `devices` flag.** `watermark_scheduler_admissions` is keyed by DevEUI and stores `enabled`, the accepted `calibration_sync_version`, its own `sync_version`, and `updated_at`. Calibration update atomically advances the accepted version when already enabled; calibration delete atomically disables admission. This is the concrete pattern Chameleon and a future calibrated SDI-12 tension source can follow. Do not create a generic cross-family table until the second family proves the shared key and lifecycle. | E2-E9, C1, C3, C5, C6 |

## Binding OD-9 amendment

This section supersedes every later sketch that mentions
`devices.watermark_enabled`, `Device.watermark_enabled`, a DEVICE payload
decorator, or `enable.js`.

### Resource and transitions

`watermark_scheduler_admissions` has one row per WATERMARK device:

```sql
CREATE TABLE watermark_scheduler_admissions (
  deveui TEXT PRIMARY KEY REFERENCES devices(deveui) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  calibration_sync_version INTEGER,
  sync_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  CHECK ((enabled = 0 AND calibration_sync_version IS NULL)
      OR (enabled = 1
          AND calibration_sync_version IS NOT NULL
          AND calibration_sync_version >= 1))
);
```

The explicit `IS NOT NULL` is required because a SQLite `CHECK` accepts a NULL
result. `enabled = 1 AND calibration_sync_version >= 1` alone would therefore
allow an enabled row with no bound calibration.

An absent row reads as disabled at resource version 0. Enabling validates OD-1
and upserts `enabled = 1` with the exact live calibration version the caller
accepted. Disabling sets `enabled = 0` and clears that version.

Every newly accepted `SET_WATERMARK_CONFIG` command advances the admission from
its exact base to `base + 1` and emits the mirror event, even when its desired
values equal the current row. `DesiredStateService` cannot complete an operation
from an APPLIED ACK alone: it also requires a mirror version greater than the
base. Keeping the same resource version would strand that operation in
ACKNOWLEDGED. Delivery replay is different: the same `command_id` returns its
stored terminal result and performs no second write or version bump. Local
same-state API calls that do not create a desired-state operation may still
return `changed: false` without advancing the resource.

Updating a live calibration while admission is enabled atomically advances
`calibration_sync_version` to the new calibration version and bumps admission
`sync_version`. Old readings stop qualifying immediately; the next uplink under
the new version restores scheduler input. Deleting a calibration atomically
disables admission and clears its calibration version. These two coupled writes
must use the phase 2 transaction-scoped calibration seam, so neither resource
can commit alone. The writer changes calibration first and admission second, so
their local outbox rows record the causal order. Delivery retries, batching, and
bootstrap mean the cloud cannot rely on receiving that order.

### Sync and command contract

- Event `WATERMARK_SCHEDULER_ADMISSION_UPSERTED`, aggregate/resource type
  `WATERMARK_SCHEDULER_ADMISSION`, aggregate key = DevEUI, carries the complete
  row plus `gateway_device_eui`.
- Bootstrap and force sync carry a `watermark_scheduler_admissions` array.
- `SET_WATERMARK_CONFIG` retains `enabled` and
  `calibration_sync_version`. It also carries `base_sync_version` for the
  admission resource. The edge maps a stale admission base to `CONFLICT /
  stale_sync_version`; a stale calibration quote uses `CONFLICT /
  stale_calibration_version` so the GUI can explain which state changed.
- Its required effect key is
  `watermark_scheduler_admission:<uppercase-device-eui>:<base_sync_version>`.
  The cloud desired-state request, `device_commands` row, command payload,
  edge terminal ledger, `effect-keys.md`, and `commands.schema.json`
  `x-semantic-bindings` metadata all carry the same value. The binding entry is
  `{prefix: "watermark_scheduler_admission", uuid_path: "device_eui",
  version_path: "base_sync_version"}`; `uuid_path` is the contract's existing
  generic identifier-path field name. The edge validates the prefix, EUI, and
  unpadded base before deduplication or mutation.
- The desired-state ledger targets `WATERMARK_SCHEDULER_ADMISSION`, not
  `DEVICE`. Its desired value includes `enabled` and the accepted calibration
  version. Unrelated renames, zone moves, and device flags therefore cannot
  produce the old plan's admitted `mirror_diverged` false conflict.
- The cloud mirror is written only by edge events/bootstrap. A user request
  queues the command and returns pending state; it never changes the mirror.
- The admission applier is order-tolerant. It stores the edge-authored admission
  observation even when the referenced calibration event has not arrived, but
  its effective scheduler/control state stays fail-closed until the live
  calibration mirror matches `calibration_sync_version`. If the implementation
  validates before storage instead, missing or mismatched calibration is
  retryable and must never become a terminal dead letter. Bootstrap follows the
  same rule.

### Scheduler and D7

The WATERMARK scheduler branch joins admission, live calibration, and raw row
on DevEUI and requires:

```text
admission.enabled = 1
admission.calibration_sync_version = calibration.sync_version
reading.calibration_sync_version = calibration.sync_version
```

The Chameleon writer refuses enable while the admission row is enabled. The
WATERMARK admission writer refuses enable while `devices.chameleon_enabled =
1`. Both checks occur in the same SQLite write transaction as their mutation.
The stable mutual-exclusion reason is `watermark_scheduler_enabled`; the generic
precondition envelope remains `watermark_precondition_failed`.

### Required plan rewrite

- E2 adds the admission table, its linked-gateway outbox triggers, and raw-row
  sync triggers. It removes every `devices`/`DEVICES_COLUMNS`/boot-node step.
- E3 adds the admission resource and event; it does not change `Device`.
- E3 also adds the version-scoped admission effect-key grammar and executable
  EUI/base semantic binding to both contract copies and their validators.
- E4 becomes `admission.js` and tests the atomic calibration update/delete
  transitions above. It also tests the explicit enabled/non-null CHECK.
- E5-E7 query the admission table and use its resource version.
- E6 requires an exact admission-base compare-and-set. A newly accepted
  same-value command advances to `base + 1` and emits once; redelivery of its
  `command_id` replays the stored result without another bump. Tests must cover
  both paths and prove the cloud operation reaches APPLIED after ACK plus
  mirror convergence.
- E8 bootstraps admissions as their own array; DEVICE rows stay unchanged.
- C3 must notify desired-state convergence after a successful admission
  bootstrap apply. It reloads the retained newest mirror and passes that
  version/payload to `DesiredStateService.observeMirror`; a stale incoming row
  is never used for notification.
- E9 and C6 obtain current state from the config/admission endpoint, not the
  device object.
- C1 creates a cloud admission mirror, not a device column. C3 bootstraps that
  mirror. C5 targets it in desired state.
- C2/C3 test admission-before-calibration delivery and bootstrap. The admission
  remains observationally retained but ineffective until calibration catches
  up; no terminal rejection is allowed for ordering alone.
- Before C5, fix `DesiredStateService.canRewrite` so an unleased command is
  reused only when request base and effect key both match the persisted
  operation/command. A changed binding issues a new command. The rewrite method
  currently changes payload and target but not the persisted effect key, which
  makes a later ACK fail validation.

The raw-reading, bench, retention, capability, and rollout decisions are
unchanged. Rewrite the named E2+ tasks and their tests before execution; their
code blocks are retained only as investigation notes until then.

### E1 execution boundary

Task E1 below replaces the rejected analyzer sketch; it is implemented with
synthetic fixtures. Isolated raw observational capture may also proceed before
Phase 1 is deployed on the bench gateway, provided the node is unassigned and cannot reach
irrigation control. Neither activity accepts a real gate result. Acceptance
requires the completed identity/software manifest, a green analyzer, and all
protocol evidence. The node's logical identity changed from
`<previous-device-eui>` to `<device-eui>`; coefficient provenance therefore
cannot be inferred from the current EUI alone.

E2-E9 and C1/C3/C5/C6 are still investigation notes. Their stale code sketches
remain non-executable until the OD-9 rewrite checklist is complete and the two
repositories have been cross-checked together.

## Execution order

E1 has three separate states:

1. Implement the analyzer offline by TDD; synthetic fixtures need no bench
   preflight. Done (see the status banner).
2. Capture isolated raw observations now if useful. Preserve each row's DevEUI
   and the original logger artifact. The node stays outside every irrigation
   zone and scheduler path.
3. Accept a real PASS/FAIL/INCONCLUSIVE result only after the identity/software
   manifest is complete, Task E1 is green, and the captured inputs pass its
   provenance validation. A capture made earlier may be analyzed then; capture
   time alone grants no acceptance.

E2 and later stay blocked. After their rewrite gate is removed, land them in
this order:

1. Phase 1 is on main (`ca08dcc13`). Land the shared desired-state rewrite
   guard, the corrected Chameleon pair, and phase 2 in the cross-track review's
   order. Start both phase 3 branches from those completed branches.
2. Implement osi-os E2/E3 as schema and contract preparation only. Do not
   deploy an edge that emits the new operations yet.
3. Implement and deploy osi-server C1-C6, including admission/calibration
   reordering and bootstrap convergence.
4. Implement and deploy osi-os E4-E9 and E11. Run E10 only if the valid bench
   result defines an envelope.

Task counts: osi-os 11 (E10 conditional), osi-server 6.

## Reconciled with the phase 2 plan

The phase 2 plan (written at `8d35fa4ca`, now in `docs/superpowers/plans/` and marked REWRITE BEFORE EXECUTION) supplies the names this plan uses. The table records each dependency and where it is used. Anything phase 2 changes before it merges must be carried into the named task.

| # | Phase 2 fact this plan depends on | Where used |
|---|---|---|
| R1 | Edge migration **0062** is phase 2's (`0062__watermark_calibration_sync.sql`); this plan takes **0063**. Numbers as on main at `ca08dcc13`, where phase 1 is `0061` and RAK10701 is `0060`; take the next free numbers at rebase time. | E2 |
| R2 | Cloud Flyway `V2026_09_27_001__watermark_calibration_mirror.sql`, re-dated at merge to sort after `origin/main`. This plan's `V2026_09_28_001__watermark_scheduler_and_readings.sql` is re-dated at merge to sort after phase 2's (`sh scripts/verify-flyway-ordering.sh`). | C1 |
| R3 | `osi-watermark-helper/calibration.js` gains the transaction-scoped seam `saveCalibrationInTransaction(tx, …)` / `deleteCalibrationInTransaction(tx, …)` and exports `backfillRemaining`. The REST writers wrap them. Phase 1 on main (`ca08dcc13`) batches the backfill in `backfillBatch(tx, deveui, calibrationRow, cursor)`, 500 readings per transaction; `backfillRemaining` is module-private there. | E4 (revocation goes in `deleteCalibrationInTransaction`, so the HTTP delete and `DELETE_WATERMARK_CALIBRATION` both revoke; the row-version bump goes in `backfillBatch`) |
| R4 | `osi-watermark-helper/commands.js` exports `applyWatermarkCalibrationCommand(db, envelope, runtime)` in the `osi-entity-name` ledger pattern: one transaction for the replay check (`applied_commands` by delivery `commandId`), parse, `authorize` (actor, device, gateway, scoped access), the write, the `applied_commands` row and the `command_ack_outbox` row. A stale version is acked `result: CONFLICT`, `reason: stale_sync_version`; other refusals `REJECTED_PERMANENT` with a stable reason. The flow node is `watermark-calibration-command-apply-fn`. | E6 (adds `SET_WATERMARK_CONFIG` to that module and node) |
| R5 | Registry entries use `dispatch: 'watermark_calibration_apply'` in `cmd-type-registry` and in `reject-indefinite-open`'s `COMMAND_TYPES_FALLBACK`. | E6 |
| R6 | Capability `watermark_v1` is appended after `'entity_name_commands_v1'` in `al-link-build-req`, `sync-bootstrap-build`, `sync-force-build`; pinned by `scripts/test-entity-name-command-path.js` (~line 545) and `scripts/test-journal-bootstrap.js` (`EXPECTED_CAPABILITIES`). Cloud: `linked_gateway_accounts.watermark_supported`, `LinkedGatewayAccount.isWatermarkSupported()`. | E6, C1 |
| R7 | Commands carry `base_sync_version` (the version of the resource they write) and a UUID `command_id`, `actor_user_uuid`, `requested_at` (UTC with ms) and `gateway_device_eui`. `SET_WATERMARK_CONFIG` follows the same envelope. Its base is the scheduler-admission resource version and is enforced. The accepted calibration version travels separately as `calibration_sync_version`; an admission-base mismatch is `CONFLICT / stale_sync_version`, while a calibration mismatch is `CONFLICT / stale_calibration_version`. Its required effect key is `watermark_scheduler_admission:<EUI>:<base>`; `DesiredStateService.validate` rejects a blank key, and the command contract plus edge parser bind all three segments. | E3, E6, C5 |
| R8 | Cloud contract vendoring: only `resources.schema.json` and phase 2's `watermark-calibration-v1-golden.json` are byte copies on the server. `events.schema.json`, `commands.schema.json` and `sync-contract-golden.json` keep the server's own formatting and staging and are edited by hand; `SyncContractVendorTest`, `SyncOpCoverageTest` and osi-os `verify-sync-op-parity.js` hold them in agreement. | C2, E11 |
| R9 | Resource type `WATERMARK_CALIBRATION` (aggregate key = EUI) for the calibration events. This plan's exact-match `WATERMARK_READING_APPENDED` → `WATERMARK_ROW` goes before any `WATERMARK_` prefix mapping phase 2 adds to `resourceTypeFromOp`. | C2 |
| R10 | Cloud command service `WatermarkCalibrationCommandService` with a private `target(actor, deviceEui)` (enabled account, `GatewayScope.requireMutation()`, zone write or owner/ADMIN for an unzoned board, capability, local actor identity, gateway binding) and `current(t) = max(mirror.sync_version, watermark slot)`. C5 extracts `target` so the config service applies the same rules. | C5 |
| R11 | Cloud frontend: `WatermarkCloudSection.tsx` (hosts phase 2's `WatermarkCalibrationPanel.tsx`) inside `DraginoCard.tsx`; the calibration view exposes `syncVersion`. `devices.watermark_calibrated` / `DeviceResponse.watermarkCalibrated` mark a calibrated LSN50. | C6 |
| R12 | Bootstrap and force sync gain a `watermark_calibrations` array (edge) and `EdgeBootstrapRequest.watermarkCalibrations` (cloud). This plan adds `watermark_readings` / `watermarkReadings` after it. | E8, C3 |
| R13 | Phase 2 E7: `watermark-ingest-fn` publishes WATERMARK MQTT telemetry for liveness. This plan leaves it alone (OD-4 explains why the two do not overlap). | E8 |

Still open, outside both plans:

| # | Assumption | Where used |
|---|---|---|
| A9 | The D6 fix (`feat/chameleon-enabled-cmd-fix`, planned separately) lands first. Today `Route Command` (`934bf2bc19a8ce22`) has no `SET_CHAMELEON_CONFIG` branch and the command is dropped. If D6 adds an edge applier that writes `chameleon_enabled`, E6 adds the D7 refusal to it; if not, E5's exclusion verifier fails any unguarded writer that appears later. | E5, E6 |

## Global Constraints

- **Worktrees:** osi-os `<osi-os-worktree>` (branch `feat/watermark-phase3`), osi-server `<osi-server-worktree>` (branch `feat/watermark-phase3`). The old osi-os branch was cut from the phase 1 branch at `22973f4b7`, before the last six phase 1 commits. Start the re-planned osi-os work from main after phase 2 lands (phase 1 is `ca08dcc13` there), and the osi-server work from the phase 2 osi-server branch before C1. Read phase 1 code with `git show origin/main:<path>`. Never push, never merge, never touch a gateway, the cloud hosts or any remote.
- **Shell is fish.** Wrap multi-command lines in `bash -c '…'`. Never bare `git stash`.
- Code names are fully qualified (`watermark_scheduler_admissions`, `WATERMARK_SCHEDULER_ADMISSION_UPSERTED`, `WATERMARK_READING_APPENDED`, `SET_WATERMARK_CONFIG`, `watermark_scheduler_v1`), never a bare `watermark` (spec D3).
- `conversion_version` stays `wm-lsn50-p3-v1` unless Task E10 runs, which makes it `wm-lsn50-p3-v2`.
- **Irrigation safety:** a `device_data` row that has a `watermark_readings` row reaches the scheduler only when all of these hold: device type `DRAGINO_LSN50`; an enabled admission exists; admission and reading both name the live calibration version; and the calibration is not tombstoned. No path enables admission except `writeWatermarkSchedulerAdmission` in `osi-watermark-helper/admission.js`.
- **D7:** no path writes `chameleon_enabled = 1` while WATERMARK admission is enabled, and no path enables WATERMARK admission while `chameleon_enabled = 1`. `scripts/verify-watermark-chameleon-exclusion.js` (Task E5 rewrite) enforces the writer list.
- **Schema:** load `.claude/skills/osi-schema-change-control/SKILL.md`. Migration 0063 is additive: it creates the admission table and sync triggers and adds `watermark_readings.sync_version`. It adds no `devices` column and does not touch the frozen `sync-init-fn`.
- **Flows:** load `.claude/skills/osi-flows-json-editing/SKILL.md`. Edit `flows.json` only with a Node script (`JSON.parse`, mutate, `JSON.stringify(flows, null, 2) + '\n'`) after a byte-identical no-op roundtrip; write both profiles. New nodes get fresh ids. Size-ratchet allowances are measured **per profile** and recorded in `scripts/verify-flows-size-ratchet-allowances.json` with a reason.
- **Pi 4 mirror:** every file created or changed under `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/` is copied byte-for-byte to the `bcm2709` tree in the same commit.
- **Sync contract:** load `.claude/skills/osi-sync-contract-awareness/SKILL.md`. On the server, `resources.schema.json` and the golden files are byte copies of osi-os `docs/contracts/sync-schema/` (`cmp`); `events.schema.json`, `commands.schema.json` and `sync-contract-golden.json` are edited by hand to carry the same ops and types (R8).
- **Auth:** the new edge route follows the phase 1 calibration route exactly. With `OSI_SCOPED_ACCESS` unset no code path reaches `osiLib.require('scope')` (`scripts/verify-auth-flag-off-hermetic.js`). A scoped write is accepted only with `msg.actor_user_uuid` set by `scoped-device-config-guard`. Every method other than the route's own is refused with 405 before auth.
- **Frontend builds:** never two at once on this workstation (it runs out of memory). Edge GUI builds once, in E11. Cloud GUI builds once, in C6. Use `npm run test:unit`, never bare `npx vitest run`.
- **Cloud tests:** `cd backend && ./gradlew test --tests '<pattern>'`; Testcontainers ITs need Docker API 1.44 (`-Dapi.version=1.44` is already in the Gradle test config on main; if a container test fails to start, check that first).
- **Locales:** edge `lg` gets the English text and an entry in `docs/i18n/pending-luganda-translations.md` (never machine Luganda). Cloud `lg` mirrors `en` by its gate.
- **Code status:** every code block in this plan is an **untested sketch** unless its task says it was run while writing the plan. E1's historical 8/8 run is invalid as readiness evidence because its suite omitted the four adversarial cases in the binding amendment. The E2 migration SQL and the E7 scheduler query were run against `database/seed-blank.sql` in `node:sqlite` 3.51.3; the Pi's SQLite is older, so `scripts/verify-sqlite-cli-limits.js` still gates them.
- Commit after every task with a conventional message. Do not amend.

## Review Focus

Inputs the spec implies but a task's own tests would not otherwise meet. Each has a test in the owning task.

1. **A board reflashed from Chameleon to WATERMARK that still has `chameleon_enabled = 1`.** The WATERMARK rows must never count through the Chameleon branch, and the WATERMARK enable must refuse with `chameleon_enabled`. Owner: E7 case S2, E4 case "refuses with Chameleon on".
2. **A recalibration while the flag is on.** Rows converted under the old version must stop counting immediately. The flag stays on and the next uplink counts. Owner: E7 case S3 (row B, at the older calibration version, never counts), E4 case "updating the calibration keeps the flag".
3. **An enable request that raced a calibration edit** (the GUI loaded version 3, someone saved version 4). The enable must change nothing: the edge API answers 409 listing `calibration_changed`, the command path acks `CONFLICT` / `stale_sync_version`, and the cloud refuses early with 409 `stale_sync_version`. Owner: E4, E5, E6, C5.
4. **A `SET_WATERMARK_CONFIG` command delivered long after it was issued**, when the calibration was deleted in between. The edge must reject it (`calibration_missing`), and the cloud desired-state operation must show rejected, not applied. Owner: E6, C5 (the operation also expires after 24 h).
5. **A DB state that bypassed the writers** (both flags 1, e.g. from a manual repair). Each row may count at most once and only through its own branch. Owner: E7 case S6.

---

## osi-os tasks

### Task E1: Dry-down analysis script (bench gate tooling; executable now)

> **Status:** Implemented (analyzer and test land separately from this
> document). Isolated raw capture may run in parallel. Do not accept a real
> gate verdict until bench protocol §2.3 is signed off and the analyzer is
> green. That manifest records that the physical node and WATERMARK circuit
> previously reporting `<previous-device-eui>` were reprogrammed to
> `<device-eui>`. A current DevEUI by itself is not coefficient provenance.

**Files:**
- Create: `scripts/watermark-drydown-analysis.js`
- Create: `scripts/watermark-drydown-analysis.test.js`
- Modify: `.github/workflows/migrations.yml` (run the test next to the existing
  `osi-watermark-helper` tests)
- Consume, but do not modify:
  `docs/superpowers/plans/2026-09-26-watermark-dry-down-bench-protocol.md`

**Existing interfaces:**
- `osi-watermark-helper/conversion.js` exports `parseProfile3(bytes)`,
  `resistanceFromCodes(fwd, rev, cal, supplyMv)`,
  `tensionFromResistance(ohm, soilTempC)`, and
  `channelCalibration(row, channel)`.
- The analysis module exports `analyze`, `parseCsv`, `deriveProbeEnvelope`,
  `selectGlobalEnvelope`, `evaluateP5`, and `LIMITS`. The CLI is a thin file
  reader/report writer over `analyze`.
- `analyze` returns
  `{ verdict, envelope, criteria, probes, resistor_check,`
  `reference_temperature_matches, input_manifest, identity, readings, limits }`.
  Task E10 may consume only the top-level `envelope` after a valid PASS.

#### Input and evidence contract

The CLI requires all six input files and the fixed interval:

```sh
node scripts/watermark-drydown-analysis.js \
  --readings drydown.csv \
  --calibration calibration.json \
  --run-metadata run-metadata.json \
  --resistors-before resistor-check-before.csv \
  --resistors-after resistor-check-after.csv \
  --reference-temperature reference-temperature.csv \
  --interval-min 5 \
  --out drydown-report
```

`run-metadata.json` is part of the evidence, not optional CLI decoration:

```json
{
  "schema_version": 1,
  "run_id": "2026-10-01-watermark-drydown-01",
  "operator": "<bench operator>",
  "recorded_at": "2026-10-01T00:00:00.000Z",
  "identity": {
    "physical_board_id": "<serial or durable physical label>",
    "previous_device_eui": "E605002000000001",
    "current_device_eui": "A84041A171000001",
    "physical_board_statement": "<statement that the EUI changed on this same physical node and measurement circuit>",
    "uart_device_eui": "A84041A171000001",
    "chirpstack_device_eui": "A84041A171000001",
    "edge_device_eui": "A84041A171000001"
  },
  "firmware": {
    "commit": "<40-hex commit>",
    "image_sha256": "<64-hex digest>",
    "build_id": "<reported image/build identifier>"
  },
  "circuit": {
    "revision": "<schematic/wiring revision>",
    "channel_1_probe_id": "<physical probe label>",
    "channel_2_probe_id": "<physical probe label>"
  },
  "calibration_record_path": "<bench-records>/E605002000000001/<record>",
  "capture": {
    "source_type": "edge_db_csv",
    "source_record": "<read-only SQL export or raw-logger conversion record>",
    "raw_source_path": null,
    "raw_source_sha256": null
  }
}
```

`calibration.json` uses these exact coefficient and provenance names:

```json
{
  "schema_version": 1,
  "device_eui": "A84041A171000001",
  "sync_version": 1,
  "pullup_1_ohm": 41670,
  "pulldown_1_ohm": 41260,
  "series_fwd_1_ohm": 130,
  "series_rev_1_ohm": 112,
  "pullup_2_ohm": 42530,
  "pulldown_2_ohm": 42070,
  "series_fwd_2_ohm": 46,
  "series_rev_2_ohm": 27,
  "provenance": {
    "physical_board_id": "<same value as the run manifest>",
    "previous_device_eui": "E605002000000001",
    "circuit_revision": "<same value as the run manifest>",
    "source_record_path": "<bench-records>/E605002000000001/<record>"
  }
}
```

The analyzer requires those four provenance values to equal the corresponding
manifest values and `device_eui` to equal the manifest's current EUI. It also
requires all three observed current-EUI fields to equal that canonical
uppercase value. It validates the commit and image-digest syntax and the
nonblank physical-board statement, but it does not claim that JSON can prove
the human statement; the signed preflight is the proof. No key or token belongs
in either file. `capture.source_type` is `edge_db_csv` or `raw_logger_json`. A
raw-logger conversion requires a nonblank original-artifact path and its
64-hex SHA-256; a direct edge export leaves both raw-source fields null. In both
cases `source_record` states the exact export or conversion command and tool
version.

`drydown.csv` requires canonical uppercase `deveui`, unique nonblank `id`, valid
ISO-8601 `recorded_at`, `frame_status`, and even-length hexadecimal
`payload_hex`; the query in the bench protocol supplies the diagnostic
cross-check columns too. Every row's `deveui` must equal the manifest's current
EUI. A missing or mixed EUI is an input error, including when raw logger JSON
was converted to CSV. Accepted profile-3 frames enter the scientific analysis.
Rejected frames remain counted in the input manifest but do not enter a
criterion.

Each resistor CSV has exactly these columns:

```text
resistor_id,nominal_band,channel,repeat,meter_ohm,fwd_early,fwd_late,rev_early,rev_late,supply_mv
```

The representation is exact:

- `nominal_band` is one of `2k2`, `4k7`, `10k`, or `15k`. It labels a component;
  it is not an accuracy limit.
- Each band maps to one nonblank physical `resistor_id`, the four IDs are
  distinct, and the mapping is identical before and after.
- Each file has one row for every
  `channel (1, 2) × resistor_id (4) × repeat (1, 2, 3)` cell: 24 rows per file,
  48 total. A duplicated cell is reported as a duplicate; it cannot replace a
  missing cell even if the file still has 24 rows.
- `meter_ohm` is finite and positive and is identical for all six uses of one
  resistor within one file. It may differ between before and after if the
  resistor was remeasured. `supply_mv` is finite and positive. ADC codes are
  integers from 0 through 4095. A complete cell whose late codes cannot produce
  a finite solve is an electrical P1 failure, not silently missing evidence.
- P1 evaluates the canonical late forward/reverse joint solve for every repeat.
  The early solve is retained as a diagnostic; this protocol does not invent a
  separate early-code accuracy limit.

`reference-temperature.csv` has
`reference_id,recorded_at,reference_c`. `reference_id` is nonblank and unique,
timestamps are valid ISO-8601 instants, and temperatures are finite. Every row
must appear once in `reference_temperature_matches`. Match it to the nearest
accepted frame with a valid DS18B20 temperature inside ±30 minutes. Resolve an
equal-distance tie by the earlier frame timestamp and then lexical reading ID.

Malformed columns, values, identity bindings, or calibration provenance are
input errors: the CLI exits 2 and writes no scientific verdict. A structurally
incomplete resistor matrix and an unmatched reference-temperature observation
are valid evidence gaps and therefore appear in the report as `no_data` rather
than disappearing.

`summary.json` includes schema version 1, the normalized identity/provenance
and capture record, the raw-source hash when applicable, SHA-256 and row count
for every analyzer input, all criteria with measured value, limit, verdict and
reason, both per-probe candidate tables, the single deployed envelope, P5
counts recomputed under it, and every unmatched thermometer row.
`readings.csv` contains one row per analyzed channel/frame and includes the
validated DevEUI, input reading ID, timestamp, channel, band, settled state,
`r_late`, `r_early`, `rho`, offset, kPa values, continuity residual, and the
final-envelope acceptance result. Valid analyses exit 0 for PASS, FAIL, or
INCONCLUSIVE; exit 2 means invalid input/usage and exit 1 means an internal
failure. The verdict is data, not a shell-success proxy.

#### Acceptance algorithms

For each accepted profile-3 frame, trust only channels without flags `0x01`,
`0x02`, `0x08`, or `0x10`, without a `0xFFFF` code, and without the phase 1
open or clipped signatures. A criterion's in-band denominator also requires a
valid source-2 DS18B20 temperature and late resistance in 2–15 kΩ. The three
sub-bands are [2, 5), [5, 10), and [10, 15] kΩ.

P2 passes per probe with at least 30 denominator rows and at least five in each
sub-band; otherwise it is INCONCLUSIVE. P3 compares each settled in-band offset
with the median of up to three settled neighbours on each side. A real p95
above 10 mV fails; no usable deviations are INCONCLUSIVE. P4 interpolates ln(R)
between the nearest settled in-band observations before and after the target,
both within three uplink intervals, converts that reference at the target's
temperature, and takes the absolute kPa residual. A settled row is excluded
from its own leave-one-out reference. P4 passes when the settled-residual p95
is at most 3 kPa; missing or wider evidence is INCONCLUSIVE.

P1 evaluates every valid, uniquely identified cell even when the matrix also
has structural defects. If any such cell has a non-finite late solve or exceeds
`0.015 × meter_ohm + 15 Ω`, P1 is `fail` and the overall result is FAIL. That
established electrical failure takes precedence over missing, duplicate,
unexpected, or remapped cells. If there is no established electrical failure
but either matrix is structurally incomplete, P1 is `no_data` and the overall
result is INCONCLUSIVE. Only a complete matrix with every unique cell inside
tolerance passes. Details always list evaluated cells and every matrix defect.

P6 accounts for every reference row:

- no reference rows, or any row with no DS18B20 match in the allowed window:
  `no_data` and overall INCONCLUSIVE, unless a matched row already establishes
  a real temperature failure;
- any matched absolute delta above 1.0 °C: `fail` and overall FAIL;
- otherwise, when every row matched: `pass`.

For each probe and candidate `c` in
`[0.005, 0.01, 0.02, 0.03, 0.05, 0.08]`, build the candidate's own set of
unsettled, in-band observations with a continuity reference and `rho <= c`.
Let `p` be the previous candidate, or 0 for candidate 0.005. The candidate
qualifies only when (a) its set contains at least five observations, (b) every
residual is at most 3 kPa, and (c) at least one observation has
`p < rho <= c`. Clause (c) is the predeclared observed-support rule: a candidate
cannot be selected when the run observed nothing in its grid interval. Record
the interval, total observation count, support count, largest residual,
qualification boolean, and rejection reason for every candidate. The
per-probe envelope is the largest qualifying candidate.

Choose the one deployable global envelope only after both per-probe tables
exist: it is the smaller per-probe envelope when both are non-null and null
otherwise. Then, and only then, compute P5 separately for each probe under that
global value. Its denominator is all trusted, unclipped, DS18B20-backed in-band
rows. Its numerator is every unsettled denominator row that runtime would reject
under the deployed rule: all unsettled rows when the global envelope is null,
or rows with missing `rho` or `rho > global` otherwise. A share above 20 percent
fails. A per-probe provisional envelope cannot determine P5.

The 1.5% + 15 Ω, 3 kPa, 20%, 1.0 °C, band, and sample-count limits are this
owner-approved protocol's gates, not universal WATERMARK accuracy claims.
Changing them after seeing a run is a protocol change and requires a fresh run.

- [ ] **Step 1: Write the tests before the implementation.**

Use synthetic frames built by running the joint model backwards, as in the
discarded sketch, but make the fixture builders express the evidence contract:

```js
completeResistorMatrix({ phase, errorRel = 0 })
referenceRows([{ id, at, celsius }])
runMetadata(overrides)
calibrationWithProvenance(overrides)
analyzeFixture({ readings, before, after, references, metadata, calibration })
```

Every synthetic reading builder stamps `deveui` from the fixture manifest by
default; mismatch tests override it explicitly.

The test module resolves
`process.env.WATERMARK_ANALYZER_MODULE` when present and otherwise imports
`./watermark-drydown-analysis`. Add these exact cases:

1. CSV quoting and required-column validation.
2. A complete 24-cell before matrix and 24-cell after matrix pass P1; all 48
   cell results are present in the report.
3. `regression: P1 rejects a duplicate substituted for a missing cell`. Start
   with a complete after matrix, remove
   `channel=2 / nominal_band=10k / repeat=3`, and append a second
   `channel=2 / nominal_band=2k2 / repeat=3` row. All electrical errors remain
   inside tolerance and the row count stays 24. Expect P1 `no_data`, the exact
   missing and duplicate keys, and overall INCONCLUSIVE.
4. `adversarial: a valid P1 failure outranks missing evidence`. Remove one cell
   from an otherwise complete matrix and put a different, uniquely identified
   cell outside its electrical tolerance. Expect both the missing-cell detail
   and failing-cell detail, P1 `fail`, and overall FAIL.
5. An electrically complete matrix with one late solve above
   `0.015 × meter_ohm + 15 Ω` fails P1 and the overall run.
6. Identity validation rejects a manifest mismatch, calibration-provenance
   mismatch, a missing readings `deveui`, and a row EUI that differs from the
   manifest before analysis. Capture validation rejects `raw_logger_json`
   without both raw-source fields and rejects non-null raw-source fields for a
   direct `edge_db_csv` export.
7. A clean settled dry-down passes with a null global envelope and zero P5
   unusable rows.
8. Trustworthy unsettled rows produce explicit candidate tables for both
   probes.
9. `regression: an unmatched thermometer row is never dropped`. Supply two
   unique reference rows, one with a nearby accepted DS18B20 frame and one more
   than 30 minutes from every valid frame. Expect `total=2`, `matched=1`,
   `unmatched=1`, P6 `no_data`, the unmatched `reference_id` and nearest-frame
   distance in details, and overall INCONCLUSIVE.
10. A fully matched reference row more than 1.0 °C away fails P6.
11. `regression: a candidate needs five observations inside itself`. Give one
    probe five continuity-backed rows with `rho=0.025` and residual 2 kPa, plus
    one row at `rho=0.04` with residual 4 kPa. Candidate 0.02 has count 0 and
    does not qualify; candidate 0.03 has count 5 and qualifies; candidates 0.05
    and 0.08 include the bad row and fail. The selected envelope is 0.03.
12. `adversarial: an envelope needs observed support in its grid interval`.
    Give one probe five rows at `rho=0.025`, all with residual 2 kPa, and no
    other unsettled rows. Candidate 0.03 qualifies with support in `(0.02,
    0.03]`; candidates 0.05 and 0.08 have support count zero and reject with
    `no_observed_support`. Expect envelope 0.03, never 0.08.
13. `regression: P5 is recomputed under the global envelope`. Make probe 1
    qualify through 0.02. Make probe 2's ten denominator rows include five
    good unsettled rows at `rho=0.01`, 0.015, 0.025, 0.03 and 0.04, plus one
    bad unsettled row at `rho=0.06` with residual above 3 kPa. Probe 2 qualifies
    through 0.05 but not 0.08. Its provisional 0.05 rejects only the 0.06 row
    (10%), while global 0.02 rejects the four rows above 0.02 (40%). Expect
    global 0.02, probe-2 `unusable=4`, `denominator=10`, share 0.4, P5 `fail`,
    and overall FAIL.
14. A wandering offset fails P3; insufficient coverage and an excessive
    leave-one-out noise floor remain INCONCLUSIVE rather than scientific FAIL.
15. The CLI writes both artifacts, reports every input hash/count, and uses exit
    codes 0/1/2 exactly as specified above.

Cases 3, 9, 11, and 13 are the four legacy regression guards and retain the
`regression:` prefix. Cases 4 and 12 are the two additional `adversarial:`
guards for verdict precedence and observed support.

- [ ] **Step 2: Prove the tests reject the discarded algorithm.**

First run the new suite normally and record the expected red result because the
module does not exist:

```sh
node --test scripts/watermark-drydown-analysis.test.js
```

For review evidence, extract the discarded implementation from documentation
commit `fd7411dbb` into a temporary file under `scripts/`, point only the four
`regression:` tests at it with `WATERMARK_ANALYZER_MODULE`, and remove the
temporary file afterward. The extraction selects the JavaScript fence following
`Step 3: Write the script` in Task E1. Expected: all four named regressions are
red for their stated reasons; a mere module-load or schema error is not proof.
If the old module needs an adapter for the new fixture wrapper, keep that
adapter in the test file and make it translate inputs only—it must not repair
the old decisions.

```sh
legacy_file="$(mktemp scripts/.watermark-drydown-legacy-XXXXXX.js)"
trap 'rm -f "$legacy_file"' EXIT
git show fd7411dbb:docs/superpowers/plans/2026-09-26-watermark-lsn50-phase3.md |
  node -e 'const fs=require("node:fs");const s=fs.readFileSync(0,"utf8");const p=s.slice(s.indexOf("- [ ] **Step 3: Write the script**"));const m=p.match(/```js\n([\s\S]*?)\n```/);if(!m)process.exit(2);process.stdout.write(m[1]);' \
  > "$legacy_file"
WATERMARK_ANALYZER_MODULE="./$(basename "$legacy_file")" \
  node --test --test-name-pattern='^regression:' \
  scripts/watermark-drydown-analysis.test.js
legacy_status=$?
rm -f "$legacy_file"
trap - EXIT
test "$legacy_status" -ne 0
```

Also record each failure's assertion. Do not accept a run in which the legacy
module simply fails to load.

- [ ] **Step 3: Implement the smallest analyzer that satisfies the contract.**

Keep parsing/validation, scientific calculations, verdict aggregation, and CLI
I/O as separate functions. Recompute every reading from `payload_hex` with the
shipped helper; stored derived columns remain cross-checks only. Build
frame-level DS18B20 observations before expanding channels so P6 cannot
double-count one frame. Preserve unmatched temperature observations and matrix
defects as report objects.

Implement in this order, rerunning the narrow test after each slice:

1. CSV/parser, manifest and calibration-provenance validation.
2. Exact P1 matrix construction and late-solve checks.
3. Frame/channel metrics, coverage, offset stability, and continuity residuals.
4. Per-candidate envelope tables and largest-qualifying selection.
5. Global envelope selection followed by P5 recomputation.
6. Exhaustive P6 matching and the verdict precedence.
7. Stable JSON/CSV serialization, input SHA-256/count manifest, and CLI exits.

Do not loosen `osi-watermark-helper` validation or duplicate its conversion
formulas in the analyzer. Sort report arrays by phase/channel/band/resistor/repeat
or by timestamp/channel so two runs over the same inputs are byte-stable.

- [ ] **Step 4: Run the focused tests to green.**

```sh
node --test scripts/watermark-drydown-analysis.test.js
```

Expected: every named case passes, including all four `regression:` cases and
both `adversarial:` cases.

- [ ] **Step 5: Wire and verify CI.**

Add this adjacent to the existing WATERMARK helper test in
`.github/workflows/migrations.yml`:

```yaml
      - run: node --test scripts/watermark-drydown-analysis.test.js
```

Then run:

```sh
node --test scripts/watermark-drydown-analysis.test.js
node --test \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/*.test.js
git diff --check
```

Synthetic and isolated observational runs may execute before the manifest is
complete, but they cannot produce an accepted gate result. Accept the first
real verdict only from the protocol's completed, identity-bound files. A
synthetic smoke run proves formatting only.

- [ ] **Step 6: Commit.**

```sh
git add scripts/watermark-drydown-analysis.js \
  scripts/watermark-drydown-analysis.test.js \
  .github/workflows/migrations.yml
git commit -m "feat(bench): make WATERMARK dry-down analysis auditable"
```

---

> **STOP BEFORE E2.** E1 above is implemented; real-result acceptance remains
> manifest-gated.
> E2-E9 and C1/C3/C5/C6 below remain non-executable investigation sketches.
> They still contain the rejected device-column model and must be rewritten
> from the binding OD-9 checklist before any code from them is used.

### Task E2: Schema, migration 0063 (flag, raw-reading sync triggers)

**Files:**
- Create: `database/migrations/ordered/0063__watermark_scheduler_readings_sync.sql` (R1: phase 2 owns 0062)
- Modify: `database/migrations/ordered/CHECKSUMS.json`, `database/seed-blank.sql`, the 7 bundled `farming.db` files (via `scripts/build-seed-db.js`)
- Modify: both `flows.json` profiles, node `sync-init-fn`, only through `node scripts/gen-devices-columns.js`
- Modify: `scripts/verify-runtime-schema-parity.js` (`MIGRATION_OWNED_TRIGGERS`), `scripts/verify-db-schema-consistency.js` (`schemaContract`, `requiredTriggerSqlFragments`), `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`, `scripts/reconcile-ledger-numbering.test.js`, `scripts/verify-flows-size-ratchet-allowances.json` (the regenerated `sync-init-fn` grows)
- Create: `scripts/test-watermark-sync-triggers.js`
- Modify: `.github/workflows/verify-sync-flow.yml`

**Interfaces:**
- Produces: `devices.watermark_enabled INTEGER NOT NULL DEFAULT 0`; `watermark_readings.sync_version INTEGER NOT NULL DEFAULT 0`.
- Produces outbox event, aggregate type `WATERMARK_READING`, op `WATERMARK_READING_APPENDED`, aggregate key `<DEVEUI>|<recorded_at>|<watermark_readings.id>`, event `sync_version` = row `sync_version`. Payload keys: `contract_version`, `device_eui`, `edge_reading_id`, `device_data_id`, `recorded_at`, `f_cnt`, `frame_status`, `reject_reason`, `payload_hex`, `supply_mv`, `soil_temp_c`, `soil_temp_source`, `die_temp_c`, `status_byte`, `channels` (array of two objects: `flags`, `fwd_early`, `fwd`, `rev_early`, `rev`, `r_fwd`, `r_rev`, `r_solved`, `offset_mv`, `r_upper_bound`, `kpa_upper_bound`, `status`, `kpa`), `calibration_sync_version`, `conversion_version`, `sync_version`, `gateway_device_eui`. E3 (contract), E8 (bootstrap rows) and C2 (cloud applier) use exactly these names.
- Produces: every DEVICE outbox payload carries `watermark_enabled` (0 or 1).

**Boot-node implications (OD-9), stated so the reviewer checks them.** This is the first `devices` column since 0029.
- The column is added only by the ordered migration and the seed. The frozen `sync-init-fn` gains no DDL and no trigger text.
- `DEVICES_COLUMNS` in `sync-init-fn` must be regenerated with `node scripts/gen-devices-columns.js` (Step 5): `scripts/gen-devices-columns.test.js` in CI fails otherwise. That regeneration is the only change to the node, and it triggers the full boot-node merge gate: `verify-runtime-schema-parity`, `verify-profile-parity`, `verify-devices-rebuild-fence`, `rehearse-devices-rebuild.test.js`, `gen-devices-columns --check` (Step 9).
- Deploy ordering (osi-os#222): `deploy.sh` runs the migration before the payload flip. If a gateway ever boots a flows payload older than its DB, the guarded rebuild, when a device-type change triggers it, aborts on the unknown `watermark_enabled` column and leaves `devices` intact (fail-closed). Ordinary boots never rebuild.
- No trigger is placed on `devices` itself: the guarded rebuild drops and recreates the table, which would silently drop a migration-owned trigger and trip the fingerprint preflight on the next deploy. The DEVICE payload gets `watermark_enabled` from a `sync_outbox` decorator instead (0029 Sentek pattern).
- Before any live rollout, the production-copy rehearsal that `osi-live-ops-runbook` requires for boot-node changes applies (operator step, not part of this plan).

The Step 1 test and the Step 2 SQL were run together while writing this plan (Step 2 appended to `seed-blank.sql`, `node:sqlite` 3.51.3): 5/5 cases pass. The seed placement in Step 4 and the bundled DBs were not run.

- [ ] **Step 1: Write the failing trigger test** `scripts/test-watermark-sync-triggers.js`:

```js
#!/usr/bin/env node
'use strict';

// WATERMARK phase 3 sync triggers against the real seed schema:
//  - trg_watermark_readings_outbox_ai: one WATERMARK_READING_APPENDED per insert, only while linked
//  - trg_watermark_readings_outbox_au: a re-emit at the higher sync_version when a row is corrected
//  - trg_watermark_device_outbox_payload_ai: DEVICE events carry watermark_enabled
// Run: node scripts/test-watermark-sync-triggers.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DEVEUI = 'A84041A171000001';
const GW = '0016C001F1000002';

function freshDb({ linked }) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'p', 'x', ?)").run(now);
  db.prepare("INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at, gateway_device_eui) VALUES (?, 'wm', 'DRAGINO_LSN50', 1, ?, ?, ?)")
    .run(DEVEUI, now, now, GW);
  db.prepare("INSERT INTO sync_link_state (peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', ?, ?, ?)")
    .run(linked ? 1 : 0, GW, now);
  return db;
}

function insertReading(db, extra = {}) {
  const row = Object.assign({
    deveui: DEVEUI, recorded_at: '2026-10-01T06:00:00.000Z', payload_hex: 'a203', frame_status: 'accepted',
    conversion_version: 'wm-lsn50-p3-v1', ch1_status: 'calibration_required', ch2_status: 'open',
  }, extra);
  const cols = Object.keys(row);
  return Number(db.prepare('INSERT INTO watermark_readings (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')')
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}

const outbox = (db, type) => db.prepare('SELECT * FROM sync_outbox WHERE aggregate_type = ? ORDER BY rowid').all(type);

const CASES = [];

CASES.push({ name: 'an insert while linked emits one WATERMARK_READING_APPENDED with the documented key and payload', run() {
  const db = freshDb({ linked: true });
  const id = insertReading(db, { f_cnt: 7, ch1_flags: 0x20, ch1_fwd: 800, ch1_rev: 3291 });
  const rows = outbox(db, 'WATERMARK_READING');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].op, 'WATERMARK_READING_APPENDED');
  assert.equal(rows[0].aggregate_key, DEVEUI + '|2026-10-01T06:00:00.000Z|' + id);
  assert.equal(rows[0].sync_version, 0);
  assert.equal(rows[0].gateway_device_eui, GW);
  const p = JSON.parse(rows[0].payload_json);
  assert.deepEqual(Object.keys(p).sort(), ['calibration_sync_version', 'channels', 'contract_version', 'conversion_version',
    'device_data_id', 'device_eui', 'die_temp_c', 'edge_reading_id', 'f_cnt', 'frame_status', 'gateway_device_eui',
    'payload_hex', 'recorded_at', 'reject_reason', 'soil_temp_c', 'soil_temp_source', 'status_byte', 'supply_mv',
    'sync_version'].sort());
  assert.equal(p.edge_reading_id, id);
  assert.equal(p.channels.length, 2);
  assert.equal(p.channels[0].fwd, 800);
  assert.equal(p.channels[0].status, 'calibration_required');
} });

CASES.push({ name: 'an unlinked gateway emits nothing', run() {
  const db = freshDb({ linked: false });
  insertReading(db);
  assert.equal(outbox(db, 'WATERMARK_READING').length, 0);
} });

CASES.push({ name: 'a correction (sync_version bump) re-emits at the higher version; other updates emit nothing', run() {
  const db = freshDb({ linked: true });
  const id = insertReading(db);
  db.prepare('UPDATE watermark_readings SET device_data_id = 5 WHERE id = ?').run(id);
  assert.equal(outbox(db, 'WATERMARK_READING').length, 1, 'an update without a version bump must not emit');
  db.prepare("UPDATE watermark_readings SET ch1_status = 'ok', ch1_kpa = 31.2, sync_version = sync_version + 1 WHERE id = ?").run(id);
  const rows = outbox(db, 'WATERMARK_READING');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].sync_version, 1);
  assert.equal(rows[1].aggregate_key, rows[0].aggregate_key);
  assert.equal(JSON.parse(rows[1].payload_json).channels[0].kpa, 31.2);
} });

CASES.push({ name: 'a frame_rejected row syncs too (OD-4)', run() {
  const db = freshDb({ linked: true });
  insertReading(db, { frame_status: 'frame_rejected', reject_reason: 'length', payload_hex: 'a2' });
  assert.equal(JSON.parse(outbox(db, 'WATERMARK_READING')[0].payload_json).reject_reason, 'length');
} });

CASES.push({ name: 'DEVICE events carry watermark_enabled from the device row', run() {
  const db = freshDb({ linked: true });
  db.prepare('UPDATE devices SET watermark_enabled = 1, sync_version = COALESCE(sync_version, 0) + 1 WHERE deveui = ?').run(DEVEUI);
  const events = outbox(db, 'DEVICE');
  assert.ok(events.length >= 1);
  assert.equal(JSON.parse(events[events.length - 1].payload_json).watermark_enabled, 1);
} });

let failed = 0;
for (const c of CASES) {
  try { c.run(); console.log('ok - ' + c.name); }
  catch (e) { failed += 1; console.log('not ok - ' + c.name + '\n  ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n  ')); }
}
if (failed) { console.log('FAIL: ' + failed + ' of ' + CASES.length); process.exit(1); }
console.log('PASS: ' + CASES.length + ' WATERMARK sync trigger cases');
```

Run: `node scripts/test-watermark-sync-triggers.js`
Expected: FAIL (`no such column: watermark_enabled` or zero outbox rows).

- [ ] **Step 2: Write the migration** `database/migrations/ordered/0063__watermark_scheduler_readings_sync.sql`:

```sql
-- risk: additive
-- 0063: WATERMARK phase 3 (spec 2026-09-25 section 8). Scheduler admission flag
-- and raw-reading sync. No trigger on devices: the boot node's guarded devices
-- rebuild would drop it. The DEVICE payload decorator sits on sync_outbox, like
-- 0029's Sentek decorators.

ALTER TABLE devices ADD COLUMN watermark_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE watermark_readings ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER trg_watermark_device_outbox_payload_ai
AFTER INSERT ON sync_outbox
FOR EACH ROW
WHEN NEW.aggregate_type = 'DEVICE'
BEGIN
  UPDATE sync_outbox
  SET payload_json = json_set(
    payload_json,
    '$.watermark_enabled',
    (SELECT COALESCE(watermark_enabled, 0) FROM devices WHERE deveui = NEW.aggregate_key)
  )
  WHERE event_uuid = NEW.event_uuid;
END;

CREATE TRIGGER trg_watermark_readings_outbox_ai
AFTER INSERT ON watermark_readings
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
  AND COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL),
               (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'), '') <> ''
BEGIN
  INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui)
  SELECT lower(hex(randomblob(16))), 'WATERMARK_READING',
         NEW.deveui || '|' || NEW.recorded_at || '|' || NEW.id,
         'WATERMARK_READING_APPENDED',
         json_object(
           'contract_version', 1,
           'device_eui', NEW.deveui,
           'edge_reading_id', NEW.id,
           'device_data_id', NEW.device_data_id,
           'recorded_at', NEW.recorded_at,
           'f_cnt', NEW.f_cnt,
           'frame_status', NEW.frame_status,
           'reject_reason', NEW.reject_reason,
           'payload_hex', NEW.payload_hex,
           'supply_mv', NEW.supply_mv,
           'soil_temp_c', NEW.soil_temp_c,
           'soil_temp_source', NEW.soil_temp_source,
           'die_temp_c', NEW.die_temp_c,
           'status_byte', NEW.status_byte,
           'channels', json_array(
             json_object('flags', NEW.ch1_flags, 'fwd_early', NEW.ch1_fwd_early, 'fwd', NEW.ch1_fwd,
               'rev_early', NEW.ch1_rev_early, 'rev', NEW.ch1_rev, 'r_fwd', NEW.ch1_r_fwd, 'r_rev', NEW.ch1_r_rev,
               'r_solved', NEW.ch1_r_solved, 'offset_mv', NEW.ch1_offset_mv, 'r_upper_bound', NEW.ch1_r_upper_bound,
               'kpa_upper_bound', NEW.ch1_kpa_upper_bound, 'status', NEW.ch1_status, 'kpa', NEW.ch1_kpa),
             json_object('flags', NEW.ch2_flags, 'fwd_early', NEW.ch2_fwd_early, 'fwd', NEW.ch2_fwd,
               'rev_early', NEW.ch2_rev_early, 'rev', NEW.ch2_rev, 'r_fwd', NEW.ch2_r_fwd, 'r_rev', NEW.ch2_r_rev,
               'r_solved', NEW.ch2_r_solved, 'offset_mv', NEW.ch2_offset_mv, 'r_upper_bound', NEW.ch2_r_upper_bound,
               'kpa_upper_bound', NEW.ch2_kpa_upper_bound, 'status', NEW.ch2_status, 'kpa', NEW.ch2_kpa)),
           'calibration_sync_version', NEW.calibration_sync_version,
           'conversion_version', NEW.conversion_version,
           'sync_version', NEW.sync_version,
           'gateway_device_eui', gw.eui),
         NEW.sync_version,
         strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         gw.eui
    FROM (SELECT COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL),
                          NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')) AS eui) gw;
END;

CREATE TRIGGER trg_watermark_readings_outbox_au
AFTER UPDATE OF sync_version ON watermark_readings
FOR EACH ROW
WHEN NEW.sync_version > OLD.sync_version
  AND EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
  AND COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL),
               (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'), '') <> ''
BEGIN
  INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui)
  SELECT lower(hex(randomblob(16))), 'WATERMARK_READING',
         NEW.deveui || '|' || NEW.recorded_at || '|' || NEW.id,
         'WATERMARK_READING_APPENDED',
         json_object(
           'contract_version', 1,
           'device_eui', NEW.deveui,
           'edge_reading_id', NEW.id,
           'device_data_id', NEW.device_data_id,
           'recorded_at', NEW.recorded_at,
           'f_cnt', NEW.f_cnt,
           'frame_status', NEW.frame_status,
           'reject_reason', NEW.reject_reason,
           'payload_hex', NEW.payload_hex,
           'supply_mv', NEW.supply_mv,
           'soil_temp_c', NEW.soil_temp_c,
           'soil_temp_source', NEW.soil_temp_source,
           'die_temp_c', NEW.die_temp_c,
           'status_byte', NEW.status_byte,
           'channels', json_array(
             json_object('flags', NEW.ch1_flags, 'fwd_early', NEW.ch1_fwd_early, 'fwd', NEW.ch1_fwd,
               'rev_early', NEW.ch1_rev_early, 'rev', NEW.ch1_rev, 'r_fwd', NEW.ch1_r_fwd, 'r_rev', NEW.ch1_r_rev,
               'r_solved', NEW.ch1_r_solved, 'offset_mv', NEW.ch1_offset_mv, 'r_upper_bound', NEW.ch1_r_upper_bound,
               'kpa_upper_bound', NEW.ch1_kpa_upper_bound, 'status', NEW.ch1_status, 'kpa', NEW.ch1_kpa),
             json_object('flags', NEW.ch2_flags, 'fwd_early', NEW.ch2_fwd_early, 'fwd', NEW.ch2_fwd,
               'rev_early', NEW.ch2_rev_early, 'rev', NEW.ch2_rev, 'r_fwd', NEW.ch2_r_fwd, 'r_rev', NEW.ch2_r_rev,
               'r_solved', NEW.ch2_r_solved, 'offset_mv', NEW.ch2_offset_mv, 'r_upper_bound', NEW.ch2_r_upper_bound,
               'kpa_upper_bound', NEW.ch2_kpa_upper_bound, 'status', NEW.ch2_status, 'kpa', NEW.ch2_kpa)),
           'calibration_sync_version', NEW.calibration_sync_version,
           'conversion_version', NEW.conversion_version,
           'sync_version', NEW.sync_version,
           'gateway_device_eui', gw.eui),
         NEW.sync_version,
         strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         gw.eui
    FROM (SELECT COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL),
                          NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')) AS eui) gw;
END;
```

The two trigger bodies are identical on purpose, so a correction carries the same payload shape as the first emit; keep them identical in any later edit. `AFTER UPDATE OF sync_version` fires only for a statement that sets `sync_version`, and the `WHEN` limits it to a real bump.

- [ ] **Step 3: Add the checksum.**

```bash
node -e 'const crypto=require("crypto"),fs=require("fs");const dir="database/migrations/ordered/";const file="0063__watermark_scheduler_readings_sync.sql";
const manifest=JSON.parse(fs.readFileSync(dir+"CHECKSUMS.json","utf8"));
manifest[file]=crypto.createHash("sha256").update(fs.readFileSync(dir+file)).digest("hex");
fs.writeFileSync(dir+"CHECKSUMS.json",JSON.stringify(manifest,null,2)+"\n");'
```

- [ ] **Step 4: Mirror the DDL into `database/seed-blank.sql`.**
  - In `CREATE TABLE devices`, add `  watermark_enabled                     INTEGER NOT NULL DEFAULT 0,` as the last column, after `sdi12_channel_layout_json` (phase 2 adds no `devices` column, R1/OD-9), before the `FOREIGN KEY` lines. `ALTER TABLE … ADD COLUMN` appends, so the seed must declare it last for `verify-seed-replay` to match.
  - In `CREATE TABLE watermark_readings`, add `  sync_version             INTEGER NOT NULL DEFAULT 0` after `created_at` (add the comma to the `created_at` line).
  - Append the three `CREATE TRIGGER` statements after the `watermark_readings` indexes, verbatim from Step 2.

- [ ] **Step 5: Regenerate `DEVICES_COLUMNS`** in the boot node (the sanctioned generator; never a hand edit):

```bash
node scripts/gen-devices-columns.js && node scripts/gen-devices-columns.js --check
```
Expected: `rewrote conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, the same for bcm2709, then `gen-devices-columns: OK`. The new entry must read `{ name: "watermark_enabled", ddl: "watermark_enabled INTEGER NOT NULL DEFAULT 0", from: ["watermark_enabled"], dflt: "0" }`.

- [ ] **Step 6: Register the migration-owned triggers.** In `scripts/verify-runtime-schema-parity.js`, add to `MIGRATION_OWNED_TRIGGERS`:

```js
  // 0063__watermark_scheduler_readings_sync.sql: WATERMARK raw-reading sync
  // and the DEVICE payload decorator. Seed DB + deploy-time migration runner
  // delivery, not the frozen sync-init-fn boot DDL.
  ['trg_watermark_device_outbox_payload_ai', '0063__watermark_scheduler_readings_sync.sql'],
  ['trg_watermark_readings_outbox_ai', '0063__watermark_scheduler_readings_sync.sql'],
  ['trg_watermark_readings_outbox_au', '0063__watermark_scheduler_readings_sync.sql'],
```

- [ ] **Step 7: Extend `scripts/verify-db-schema-consistency.js`.** Add `watermark_enabled` to the `devices` column list and `sync_version` to `watermark_readings` in `schemaContract`. Add to `requiredTriggerSqlFragments`: `'WATERMARK_READING_APPENDED'`, `'$.watermark_enabled'`, `'AFTER UPDATE OF sync_version ON watermark_readings'`.

- [ ] **Step 8: Extend the hard-coded migration lists** in `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js` and `scripts/reconcile-ledger-numbering.test.js`: append `63` after the `62` phase 2 appended (precedent: phase 1, merged to main as `ca08dcc13`, appended `61`).

- [ ] **Step 9: Rebuild the bundled DBs and run the schema gate.**

```bash
node scripts/build-seed-db.js
node scripts/test-watermark-sync-triggers.js
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-seed-db-ledger.js
node scripts/verify-db-schema-consistency.js && node scripts/verify-runtime-schema-parity.js
node scripts/verify-devices-rebuild-fence.js && node --test scripts/rehearse-devices-rebuild.test.js && node --test scripts/gen-devices-columns.test.js
node scripts/verify-no-stray-ddl.js && node scripts/verify-sqlite-cli-limits.js && node scripts/verify-profile-parity.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-flows-fn-parse.js
node --test lib/osi-migrate/__tests__/*.test.js && node --test scripts/reconcile-ledger-numbering.test.js
```
Expected: the trigger test prints `PASS: 5 WATERMARK sync trigger cases`; every other command exits 0. If `verify-flows-size-ratchet` reports `sync-init-fn` growth, add a per-profile `node_allowances` entry with the measured delta and the reason "gen-devices-columns entry for devices.watermark_enabled (migration 0063)".

- [ ] **Step 10: Wire CI.** In `.github/workflows/verify-sync-flow.yml`, after the `test-watermark-calibration-routes.js` line, add a comment line and `- run: node scripts/test-watermark-sync-triggers.js`.

- [ ] **Step 11: Commit.**

```bash
git add -A database scripts lib conf web/react-gui/farming.db .github
git commit -m "feat(schema): migration 0063 devices.watermark_enabled and WATERMARK raw-reading sync triggers"
```

---

### Task E3: Sync contract (event, resource fields, command)

**Files:**
- Modify: `docs/contracts/sync-schema/events.schema.json`, `resources.schema.json`, `commands.schema.json`
- Modify: `scripts/test-contract-schemas.js`, `scripts/verify-sync-op-parity.js`, `scripts/fixtures/sync-contract-staging.json`, `scripts/verify-sync-contract.js` (only if its exact-list constants name staged commands)

**Interfaces:**
- Consumes: the E2 payload shape.
- Produces: op `WATERMARK_READING_APPENDED` (aggregate type `WATERMARK_READING`, payload `$ref resources.schema.json#/definitions/WatermarkReading`); `Device.watermark_enabled` (0/1/null); command `SET_WATERMARK_CONFIG` with the phase 2 envelope fields `command_id`, `actor_user_uuid`, `requested_at`, `device_eui`, `gateway_device_eui` (all required), `enabled` (boolean, required) and `calibration_sync_version` (integer ≥ 1, required when `enabled` is true), and no `effect_key` (R7). C2 byte-copies `resources.schema.json` and hand-edits the server's events/commands files (R8); E6 and C5 use the command.
- Staging: `SET_WATERMARK_CONFIG` is `edgeDeferred` and `cloudDeferred` until E6 and C5 land; `WATERMARK_READING_APPENDED` is `cloudDeferred` until C2 lands. E11 removes all three.

- [ ] **Step 1: Write the failing contract cases.** Append to `scripts/test-contract-schemas.js`, next to the `UPSERT_DEVICE_NAME` block:

```js
// WATERMARK phase 3: raw reading event, device flag, scheduler command.
const watermarkReadingEvent = {
  eventUuid: '0f3c1f7a9b2d4e6f8a0b1c2d3e4f5a6b',
  aggregateType: 'WATERMARK_READING',
  aggregateKey: 'A84041A171000001|2026-10-01T06:00:00.000Z|42',
  op: 'WATERMARK_READING_APPENDED',
  syncVersion: 1,
  occurredAt: '2026-10-01T06:00:01.000Z',
  payload: {
    contract_version: 1, device_eui: 'A84041A171000001', edge_reading_id: 42, device_data_id: 977,
    recorded_at: '2026-10-01T06:00:00.000Z', f_cnt: 7, frame_status: 'accepted', reject_reason: null,
    payload_hex: 'a2030ce407c40834022000de00de0f950f952000d900d90f940f94', supply_mv: 3300,
    soil_temp_c: 19.88, soil_temp_source: 2, die_temp_c: 21.0, status_byte: 2,
    channels: [
      { flags: 32, fwd_early: 800, fwd: 800, rev_early: 3291, rev: 3291, r_fwd: 10050, r_rev: 9901, r_solved: 9977,
        offset_mv: 0.4, r_upper_bound: null, kpa_upper_bound: null, status: 'ok', kpa: 62.4 },
      { flags: 32, fwd_early: 71, fwd: 71, rev_early: 4058, rev: 4058, r_fwd: 690, r_rev: 369, r_solved: 529,
        offset_mv: 13.1, r_upper_bound: null, kpa_upper_bound: null, status: 'saturated', kpa: 0 },
    ],
    calibration_sync_version: 3, conversion_version: 'wm-lsn50-p3-v1', sync_version: 1,
    gateway_device_eui: '0016C001F1000002',
  },
};
expectValid('WATERMARK_READING_APPENDED event', eventsSchema, watermarkReadingEvent);
expectInvalid('WATERMARK_READING_APPENDED needs two channels', eventsSchema,
  Object.assign({}, watermarkReadingEvent, { payload: Object.assign({}, watermarkReadingEvent.payload, { channels: [watermarkReadingEvent.payload.channels[0]] }) }),
  'minItems');
expectInvalid('WATERMARK_READING_APPENDED rejects an unknown channel status', eventsSchema,
  Object.assign({}, watermarkReadingEvent, { payload: Object.assign({}, watermarkReadingEvent.payload, {
    channels: [Object.assign({}, watermarkReadingEvent.payload.channels[0], { status: 'maybe' }), watermarkReadingEvent.payload.channels[1]] }) }),
  'enum');

const setWatermarkConfig = {
  command_id: '6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b', command_type: 'SET_WATERMARK_CONFIG',
  actor_user_uuid: '12345678-1234-4234-8234-123456789abc', requested_at: '2026-10-02T06:00:00.000Z',
  device_eui: 'A84041A171000001', gateway_device_eui: '0016C001F1000002', enabled: true, calibration_sync_version: 3,
};
expectValid('SET_WATERMARK_CONFIG enable', cmdSchema, setWatermarkConfig);
expectValid('SET_WATERMARK_CONFIG disable needs no calibration version', cmdSchema,
  Object.assign({}, setWatermarkConfig, { enabled: false, calibration_sync_version: undefined }));
expectInvalid('SET_WATERMARK_CONFIG needs the actor', cmdSchema,
  Object.assign({}, setWatermarkConfig, { actor_user_uuid: undefined }), 'required');
expectInvalid('SET_WATERMARK_CONFIG enable without calibration_sync_version', cmdSchema,
  Object.assign({}, setWatermarkConfig, { calibration_sync_version: undefined }), 'required');
expectInvalid('SET_WATERMARK_CONFIG enabled must be boolean', cmdSchema,
  Object.assign({}, setWatermarkConfig, { enabled: 1 }), 'type');
expectValid('Device resource with watermark_enabled', resourcesSchema.definitions.Device,
  Object.assign({}, validDeviceResourceForWatermark(), { watermark_enabled: 1 }), resourcesSchema);
```

Define `validDeviceResourceForWatermark()` next to it by copying the minimal valid Device object that the existing "101-character name" case (line ~2066) builds. The third argument of `expectInvalid` is a substring of the expected error; check the helper at line 492 and adjust the substrings to what `validationErrors` actually reports for `minItems`, `enum`, `required` and `type`.

Run: `node scripts/test-contract-schemas.js`
Expected: FAIL on the first new case (unknown op).

- [ ] **Step 2: Edit `events.schema.json`.** Add `"WATERMARK_READING_APPENDED"` to the `op` enum after `"WORK_REQUEST_SUBMITTED"`. Append to `allOf`:

```json
        {
            "if": {"properties": {"op": {"const": "WATERMARK_READING_APPENDED"}}, "required": ["op"]},
            "then": {
                "properties": {
                    "aggregateType": {"const": "WATERMARK_READING"},
                    "payload": {"$ref": "resources.schema.json#/definitions/WatermarkReading"}
                }
            }
        }
```

- [ ] **Step 3: Edit `resources.schema.json`.** In `definitions.Device.properties`, after `chameleon_enabled`, add `"watermark_enabled": {"type": ["integer", "null"], "enum": [0, 1, null]},`. Add two definitions:

```json
        "WatermarkChannel": {
            "type": "object",
            "additionalProperties": false,
            "required": ["flags", "fwd_early", "fwd", "rev_early", "rev", "r_fwd", "r_rev", "r_solved", "offset_mv", "r_upper_bound", "kpa_upper_bound", "status", "kpa"],
            "properties": {
                "flags": {"type": ["integer", "null"], "minimum": 0, "maximum": 255},
                "fwd_early": {"type": ["integer", "null"], "minimum": 0, "maximum": 65535},
                "fwd": {"type": ["integer", "null"], "minimum": 0, "maximum": 65535},
                "rev_early": {"type": ["integer", "null"], "minimum": 0, "maximum": 65535},
                "rev": {"type": ["integer", "null"], "minimum": 0, "maximum": 65535},
                "r_fwd": {"type": ["number", "null"]},
                "r_rev": {"type": ["number", "null"]},
                "r_solved": {"type": ["number", "null"]},
                "offset_mv": {"type": ["number", "null"]},
                "r_upper_bound": {"type": ["number", "null"]},
                "kpa_upper_bound": {"type": ["number", "null"]},
                "status": {"type": ["string", "null"], "enum": ["ok", "saturated", "wet_offset_clipped", "short", "short_suspected", "open", "unsettled", "invalid_sample", "calibration_required", "temperature_missing", "temperature_out_of_range", "outside_200ss_range", null]},
                "kpa": {"type": ["number", "null"], "minimum": 0, "maximum": 200}
            }
        },
        "WatermarkReading": {
            "type": "object",
            "additionalProperties": false,
            "required": ["contract_version", "device_eui", "edge_reading_id", "recorded_at", "frame_status", "payload_hex", "channels", "conversion_version", "sync_version", "gateway_device_eui"],
            "properties": {
                "contract_version": {"const": 1},
                "device_eui": {"type": "string", "pattern": "^[0-9A-Fa-f]{16}$"},
                "edge_reading_id": {"type": "integer", "minimum": 1},
                "device_data_id": {"type": ["integer", "null"]},
                "recorded_at": {"type": "string", "format": "date-time"},
                "f_cnt": {"type": ["integer", "null"], "minimum": 0},
                "frame_status": {"enum": ["accepted", "frame_rejected"]},
                "reject_reason": {"type": ["string", "null"], "maxLength": 64},
                "payload_hex": {"type": "string", "pattern": "^([0-9a-f]{2})*$", "maxLength": 512},
                "supply_mv": {"type": ["integer", "null"]},
                "soil_temp_c": {"type": ["number", "null"]},
                "soil_temp_source": {"type": ["integer", "null"], "minimum": 0, "maximum": 3},
                "die_temp_c": {"type": ["number", "null"]},
                "status_byte": {"type": ["integer", "null"], "minimum": 0, "maximum": 255},
                "channels": {"type": "array", "minItems": 2, "maxItems": 2, "items": {"$ref": "#/definitions/WatermarkChannel"}},
                "calibration_sync_version": {"type": ["integer", "null"], "minimum": 1},
                "conversion_version": {"type": "string", "pattern": "^wm-lsn50-p3-v[0-9]+$"},
                "sync_version": {"type": "integer", "minimum": 0},
                "gateway_device_eui": {"type": "string", "pattern": "^[0-9A-F]{16}$"}
            }
        }
```

`device_eui` accepts lowercase because `watermark_readings.deveui` stores what ingest wrote (uppercased today, but the phase 1 review noted mixed-case risk); the cloud normalizes.

- [ ] **Step 4: Edit `commands.schema.json`.** Add `"SET_WATERMARK_CONFIG"` to the `command_type` enum after phase 2's `DELETE_WATERMARK_CALIBRATION`. Add the top-level property `"calibration_sync_version": {"type": "integer", "minimum": 1},` next to `base_sync_version`. Append to `allOf`:

```json
        {
            "if": {"properties": {"command_type": {"const": "SET_WATERMARK_CONFIG"}}, "required": ["command_type"]},
            "then": {
                "required": ["command_id", "actor_user_uuid", "requested_at", "device_eui", "gateway_device_eui", "enabled"],
                "properties": {"enabled": {"type": "boolean"}, "effect_key": {"type": "null"}}
            }
        },
        {
            "if": {
                "properties": {"command_type": {"const": "SET_WATERMARK_CONFIG"}, "enabled": {"const": true}},
                "required": ["command_type", "enabled"]
            },
            "then": {"required": ["calibration_sync_version"]}
        }
```

Phase 2 keeps its vectors in `docs/contracts/sync-schema/watermark-calibration-v1-golden.json`, byte-mirrored to the server. Put this task's event and command examples (the objects from Step 1) into a sibling `watermark-reading-v1-golden.json` in the same format, and load them in Step 1's test from that file instead of inline literals; add the file to `verify-sync-contract.js`'s file list next to phase 2's.

- [ ] **Step 5: Register the new op and command in the parity machinery.**
  - `scripts/verify-sync-op-parity.js`: add to `SQL_OWNED_EVENT_OPS` with the comment `// Emitted by 0063__watermark_scheduler_readings_sync.sql's trg_watermark_readings_outbox_ai/_au, not by flows.json.` and `'WATERMARK_READING_APPENDED',`. Add `'WATERMARK_READING_APPENDED'` to `EXACT_CLOUD_DEFERRED_EVENT_OPS` with a comment naming Task C2 as the activation point.
  - `scripts/fixtures/sync-contract-staging.json`: add `"SET_WATERMARK_CONFIG"` to `commands.edgeDeferred` and `commands.cloudDeferred`; add `"WATERMARK_READING_APPENDED"` to `eventOps.cloudDeferred`.
  - Update any `EXACT_*` list in `scripts/verify-sync-contract.js` and `scripts/verify-sync-op-parity.js` that must equal those manifest arrays (the scripts fail and name the list when they differ).

- [ ] **Step 6: Run the contract gate.**

```bash
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server-worktree>/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node scripts/verify-sync-op-parity.js
node scripts/test-watermark-sync-triggers.js
```
Expected: all exit 0.

Then add one more case to `scripts/test-watermark-sync-triggers.js` that validates a real trigger payload against the contract (loads `scripts/test-contract-schemas.js`'s validator the way that file exports it, or copies its `validationErrors` import): the outbox row from the first case, wrapped as an event envelope, must produce zero errors against `events.schema.json`. Rerun the trigger test; expected `PASS: 6 …`.

- [ ] **Step 7: Commit.**

```bash
git add -A docs/contracts/sync-schema scripts
git commit -m "feat(contract): WATERMARK_READING_APPENDED, Device.watermark_enabled, SET_WATERMARK_CONFIG (staged)"
```

---

## osi-server tasks

Run these after E3 and before E4. Paths are relative to `<osi-server-worktree>`. Rebase onto the phase 2 osi-server branch first. Load `.claude/skills/osi-server-backend-patterns/SKILL.md` from osi-os before the first task.

### Task C1: Flyway, device flag, capability column

**Files:**
- Create: `backend/src/main/resources/db/migration/V2026_09_28_001__watermark_scheduler_and_readings.sql` (R2: re-date at merge so it sorts after phase 2's file; `sh scripts/verify-flyway-ordering.sh`)
- Modify: `backend/src/main/java/org/osi/server/device/Device.java`, `backend/src/main/java/org/osi/server/user/LinkedGatewayAccount.java`, `backend/src/main/java/org/osi/server/user/LinkedGatewayAccountService.java` (`applyEdgeCapabilities`), `backend/src/main/java/org/osi/server/user/LinkedGatewaySyncService.java` (the linked-gateway view record at line ~405 and its builder at line ~300)
- Test: `backend/src/test/java/org/osi/server/testsupport/SchemaValidationIT.java` (existing; it must stay green), `backend/src/test/java/org/osi/server/user/LinkedGatewayAccountServiceTest.java` (add a case; create the class if absent)

**Interfaces:**
- Produces: `devices.watermark_enabled INTEGER NOT NULL DEFAULT 0`, `Device.getWatermarkEnabled()/setWatermarkEnabled(int)`; table `watermark_readings` (below); `linked_gateway_accounts.watermark_scheduler_supported`, `LinkedGatewayAccount.isWatermarkSchedulerSupported()`; the linked-gateway view gains `boolean watermarkSchedulerSupported` (the cloud GUI reads it in C6).

- [ ] **Step 1: Write the failing capability test** in `LinkedGatewayAccountServiceTest`. Copy the nearest existing case that asserts `isWeatherStationZonesDesiredStateSupported()` after a link request with `syncCapabilities`, and assert instead:

```java
    @Test
    void watermarkSchedulerCapabilityIsRecordedFromTheEdgeAdvertisement() {
        LinkedGatewayAccount account = linkWith(List.of("linked_auth_sync_v1", "watermark_scheduler_v1"));
        assertThat(account.isWatermarkSchedulerSupported()).isTrue();
        LinkedGatewayAccount older = linkWith(List.of("linked_auth_sync_v1", "watermark_v1"));
        assertThat(older.isWatermarkSchedulerSupported()).isFalse();
    }
```

`linkWith` is the local helper the copied case uses to call the service's link/refresh entry point with a capability list; reuse it or write it in the same shape.

Run: `cd backend && ./gradlew test --tests 'org.osi.server.user.LinkedGatewayAccountServiceTest'`
Expected: compile FAIL, `isWatermarkSchedulerSupported` not found.

- [ ] **Step 2: Write the migration** `V2026_09_28_001__watermark_scheduler_and_readings.sql`:

```sql
-- WATERMARK phase 3 (osi-os spec 2026-09-25 section 8): scheduler flag mirror,
-- raw reading mirror, gateway capability. The edge owns watermark_enabled; the
-- cloud only mirrors it from DEVICE events.

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS watermark_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS watermark_readings (
    id                       BIGSERIAL PRIMARY KEY,
    device_id                BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    gateway_device_eui       VARCHAR(16) NOT NULL,
    edge_reading_id          BIGINT NOT NULL,
    edge_sync_version        BIGINT NOT NULL DEFAULT 0,
    recorded_at              TIMESTAMPTZ NOT NULL,
    f_cnt                    BIGINT,
    device_data_id           BIGINT,
    frame_status             VARCHAR(16) NOT NULL CHECK (frame_status IN ('accepted', 'frame_rejected')),
    reject_reason            VARCHAR(64),
    payload_hex              TEXT NOT NULL,
    supply_mv                INTEGER,
    soil_temp_c              DOUBLE PRECISION,
    soil_temp_source         SMALLINT,
    die_temp_c               DOUBLE PRECISION,
    status_byte              SMALLINT,
    channels                 JSONB NOT NULL,
    calibration_sync_version BIGINT,
    conversion_version       VARCHAR(32) NOT NULL,
    received_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_watermark_readings_edge_row UNIQUE (device_id, recorded_at, edge_reading_id)
);

CREATE INDEX IF NOT EXISTS idx_watermark_readings_device_recorded_at
    ON watermark_readings(device_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_watermark_readings_recorded_at
    ON watermark_readings(recorded_at);

ALTER TABLE linked_gateway_accounts
    ADD COLUMN IF NOT EXISTS watermark_scheduler_supported BOOLEAN NOT NULL DEFAULT FALSE;
```

The unique key is `(device_id, recorded_at, edge_reading_id)`, not `(gateway, edge id)`: a gateway EUI migration rewrites the gateway on the edge but keeps the DB and its ids, and a device moved to another gateway restarts ids but never at the same `recorded_at`.

- [ ] **Step 3: Map the columns.**
  - `Device.java`, after `chameleonEnabled`:

```java
    @Column(name = "watermark_enabled", nullable = false)
    @Builder.Default
    private int watermarkEnabled = 0;
```
  - `LinkedGatewayAccount.java`, after phase 2's `watermarkSupported` (R6): `@Column(name = "watermark_scheduler_supported", nullable = false) @Builder.Default private boolean watermarkSchedulerSupported = false;` (match the neighbouring field's annotations exactly).
  - `LinkedGatewayAccountService.java`: `private static final String WATERMARK_SCHEDULER_V1 = "watermark_scheduler_v1";` and in `applyEdgeCapabilities`: `account.setWatermarkSchedulerSupported(hasCapability(syncCapabilities, WATERMARK_SCHEDULER_V1));`.
  - `LinkedGatewaySyncService.java`: add `boolean watermarkSchedulerSupported` after `weatherStationZonesDesiredStateSupported` in the view record, and pass `account.isWatermarkSchedulerSupported()` where the record is built.

- [ ] **Step 4: Run the tests.**

```bash
cd backend && ./gradlew test --tests 'org.osi.server.user.LinkedGatewayAccountServiceTest' --tests 'org.osi.server.testsupport.SchemaValidationIT'
```
Expected: PASS. `SchemaValidationIT` proves the `Device` and `LinkedGatewayAccount` mappings match the migrated schema.

- [ ] **Step 5: Commit.**

```bash
git add -A backend/src
git commit -m "feat(watermark): Flyway for the scheduler flag mirror, raw reading mirror and watermark_scheduler_v1"
```

---

### Task C2: Contract mirror and the raw-reading applier

**Files:**
- Modify (byte copy from osi-os E3, R8): `backend/src/test/resources/sync-contract/resources.schema.json`, `watermark-reading-v1-golden.json` (new), plus the edge-owned file list in `scripts/verify-edge-sync-contract-vendor.sh` and `SyncContractVendorTest.EDGE_OWNED_FILES` (phase 2 added its golden there; add this one the same way)
- Modify (by hand, server formatting, R8): `backend/src/test/resources/sync-contract/events.schema.json`, `commands.schema.json`, `sync-contract-golden.json`
- Create: `backend/src/main/java/org/osi/server/watermark/WatermarkReadingMirror.java`
- Create: `backend/src/main/java/org/osi/server/sync/WatermarkReadingApplier.java` (must live in the `sync` package: osi-os `verify-sync-op-parity.js` scans that directory for `implements SyncEventApplier`)
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java` (`resourceTypeFromOp`, `EventResourceRef.resourceIdForType`), `backend/src/main/java/org/osi/server/security/EdgeOwnershipService.java` (row bucket at line ~168)
- Test: create `backend/src/test/java/org/osi/server/watermark/WatermarkReadingMirrorIT.java`, `backend/src/test/java/org/osi/server/sync/WatermarkReadingApplierTest.java`; existing `SyncContractVendorTest`, `SyncOpCoverageTest`

**Interfaces:**
- Consumes: the E3 contract and the C1 table.
- Produces: `WatermarkReadingMirror.upsert(Map<String,Object> payload, String gatewayDeviceEui)` (C3 bootstrap reuses it); resource type `WATERMARK_ROW` with resource id = aggregate key `<DEVEUI>|<recorded_at>|<edge id>`.

- [ ] **Step 1: Mirror the contract.**

```bash
bash -c 'E=<osi-os-worktree>/docs/contracts/sync-schema; S=backend/src/test/resources/sync-contract; for f in resources.schema.json watermark-reading-v1-golden.json; do cp $E/$f $S/$f && cmp $E/$f $S/$f && echo "same $f"; done'
```
Expected: two `same` lines. Then, by hand in the server's own formatting: add `WATERMARK_READING_APPENDED` to the `op` enum and the `allOf` block of `events.schema.json`, and `SET_WATERMARK_CONFIG`, the `calibration_sync_version` property and both `allOf` blocks to `commands.schema.json`, each exactly as E3 wrote them in osi-os.

- [ ] **Step 2: Update the golden fixture.** In `sync-contract-golden.json`: add `"WATERMARK_READING_APPENDED"` to `eventOperations.accepted`, `eventOperations.edgeProducerEnabled` and `eventOperations.serverHandlerEnabled`; add `"SET_WATERMARK_CONFIG"` to `commandTypes.accepted` only (C5 adds it to `cloudIssuerEnabled`).

Run: `cd backend && ./gradlew test --tests 'org.osi.server.sync.SyncContractVendorTest' --tests 'org.osi.server.sync.SyncOpCoverageTest'`
Expected: `SyncContractVendorTest` PASS; `SyncOpCoverageTest` FAIL, `WATERMARK_READING_APPENDED` does not reach the runtime dispatch. That failure is the test for Steps 3–6.

- [ ] **Step 3: Write the mirror IT** `WatermarkReadingMirrorIT.java`, extending `org.osi.server.testsupport.PostgresSyncTestBase` like the other Postgres ITs in `sync/`:

```java
package org.osi.server.watermark;

class WatermarkReadingMirrorIT extends PostgresSyncTestBase {

    @Autowired WatermarkReadingMirror mirror;
    @Autowired DeviceRepository devices;
    @Autowired NamedParameterJdbcTemplate jdbc;

    private static final String GW = "0016C001F1000002";
    private static final String EUI = "A84041A171000001";

    private Map<String, Object> payload(long edgeId, long syncVersion, String status, Double kpa) {
        Map<String, Object> ch = new LinkedHashMap<>();
        ch.put("flags", 32); ch.put("fwd_early", 800); ch.put("fwd", 800); ch.put("rev_early", 3291); ch.put("rev", 3291);
        ch.put("r_fwd", null); ch.put("r_rev", null); ch.put("r_solved", 9977.0); ch.put("offset_mv", 0.4);
        ch.put("r_upper_bound", null); ch.put("kpa_upper_bound", null); ch.put("status", status); ch.put("kpa", kpa);
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("contract_version", 1); p.put("device_eui", EUI); p.put("edge_reading_id", edgeId); p.put("device_data_id", 977);
        p.put("recorded_at", "2026-10-01T06:00:00.000Z"); p.put("f_cnt", 7); p.put("frame_status", "accepted");
        p.put("reject_reason", null); p.put("payload_hex", "a203"); p.put("supply_mv", 3300); p.put("soil_temp_c", 19.88);
        p.put("soil_temp_source", 2); p.put("die_temp_c", 21.0); p.put("status_byte", 2);
        p.put("channels", List.of(ch, ch)); p.put("calibration_sync_version", 3);
        p.put("conversion_version", "wm-lsn50-p3-v1"); p.put("sync_version", syncVersion); p.put("gateway_device_eui", GW);
        return p;
    }

    @BeforeEach
    void device() {
        devices.save(Device.builder().deviceEui(EUI).name("wm").type("DRAGINO_LSN50").gatewayDeviceEui(GW).build());
    }

    @Test
    void insertsOnceAndAHigherVersionCorrectsTheRow() {
        mirror.upsert(payload(42, 0, "calibration_required", null), GW);
        mirror.upsert(payload(42, 0, "calibration_required", null), GW);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM watermark_readings", Map.of(), Long.class)).isEqualTo(1L);
        mirror.upsert(payload(42, 1, "ok", 62.4), GW);
        assertThat(jdbc.queryForObject(
                "SELECT channels->0->>'status' FROM watermark_readings WHERE edge_reading_id = 42", Map.of(), String.class))
                .isEqualTo("ok");
    }

    @Test
    void aLowerVersionNeverOverwritesAHigherOne() {
        mirror.upsert(payload(42, 1, "ok", 62.4), GW);
        mirror.upsert(payload(42, 0, "calibration_required", null), GW);
        assertThat(jdbc.queryForObject(
                "SELECT edge_sync_version FROM watermark_readings WHERE edge_reading_id = 42", Map.of(), Long.class))
                .isEqualTo(1L);
    }

    @Test
    void anUnknownDeviceIsARetryableParentMiss() {
        Map<String, Object> p = payload(43, 0, "ok", 10.0);
        p.put("device_eui", "A84041A1710000FF");
        assertThatThrownBy(() -> mirror.upsert(p, GW))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageStartingWith("Device not found");
    }
}
```

Imports are the usual Spring test, AssertJ and `java.util` ones; `Device.builder()` field names follow `Device.java` (check `type` is a String there; if it is `DeviceType`, use `DeviceType.DRAGINO_LSN50`).

- [ ] **Step 4: Write `WatermarkReadingMirror.java`:**

```java
package org.osi.server.watermark;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.osi.server.device.Device;
import org.osi.server.device.DeviceRepository;
import org.osi.server.sync.EdgeStrings;
import org.osi.server.sync.SyncEventShapes;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Cloud mirror of the edge's watermark_readings (osi-os migration 0063). One row per
 * edge row; a higher edge sync_version (a first-calibration backfill on the edge)
 * replaces the row, a lower or equal one never does. Shared by the event applier and
 * the bootstrap path.
 */
@Component
@RequiredArgsConstructor
public class WatermarkReadingMirror {

    private final NamedParameterJdbcTemplate jdbc;
    private final DeviceRepository devices;
    private final ObjectMapper objectMapper;

    public void upsert(Map<String, Object> p, String gatewayDeviceEui) {
        String eui = required(p, "device_eui").toUpperCase(Locale.ROOT);
        Device device = devices.findByDeviceEui(eui)
                .orElseThrow(() -> new IllegalArgumentException("Device not found for WATERMARK reading: " + eui));
        Object channels = p.get("channels");
        if (!(channels instanceof List<?> list) || list.size() != 2) {
            throw new IllegalArgumentException("WATERMARK reading needs exactly two channels");
        }
        String channelsJson;
        try {
            channelsJson = objectMapper.writeValueAsString(channels);
        } catch (Exception e) {
            throw new IllegalArgumentException("WATERMARK reading channels are not JSON", e);
        }
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("device", device.getId())
                .addValue("gw", SyncEventShapes.normalizeGatewayDeviceEui(gatewayDeviceEui))
                .addValue("edgeId", SyncEventShapes.numLong(p, "edge_reading_id", "edgeReadingId", -1L))
                .addValue("version", SyncEventShapes.numLong(p, "sync_version", "syncVersion", 0L))
                .addValue("recordedAt", Timestamp.from(Instant.parse(required(p, "recorded_at"))))
                .addValue("fCnt", p.get("f_cnt"))
                .addValue("deviceDataId", p.get("device_data_id"))
                .addValue("frameStatus", required(p, "frame_status"))
                .addValue("rejectReason", EdgeStrings.requireBounded(SyncEventShapes.str(p, "reject_reason"), 64, "watermark_reading.reject_reason"))
                .addValue("payloadHex", required(p, "payload_hex"))
                .addValue("supplyMv", p.get("supply_mv"))
                .addValue("soilTemp", p.get("soil_temp_c"))
                .addValue("soilSource", p.get("soil_temp_source"))
                .addValue("dieTemp", p.get("die_temp_c"))
                .addValue("statusByte", p.get("status_byte"))
                .addValue("channels", channelsJson)
                .addValue("calVersion", p.get("calibration_sync_version"))
                .addValue("conversion", required(p, "conversion_version"));
        if ((Long) params.getValue("edgeId") < 1) throw new IllegalArgumentException("WATERMARK reading missing edge_reading_id");
        jdbc.update("""
                INSERT INTO watermark_readings (device_id, gateway_device_eui, edge_reading_id, edge_sync_version, recorded_at,
                    f_cnt, device_data_id, frame_status, reject_reason, payload_hex, supply_mv, soil_temp_c, soil_temp_source,
                    die_temp_c, status_byte, channels, calibration_sync_version, conversion_version)
                VALUES (:device, :gw, :edgeId, :version, :recordedAt, :fCnt, :deviceDataId, :frameStatus, :rejectReason,
                    :payloadHex, :supplyMv, :soilTemp, :soilSource, :dieTemp, :statusByte, CAST(:channels AS jsonb),
                    :calVersion, :conversion)
                ON CONFLICT (device_id, recorded_at, edge_reading_id) DO UPDATE SET
                    gateway_device_eui = EXCLUDED.gateway_device_eui,
                    edge_sync_version = EXCLUDED.edge_sync_version,
                    frame_status = EXCLUDED.frame_status,
                    reject_reason = EXCLUDED.reject_reason,
                    channels = EXCLUDED.channels,
                    calibration_sync_version = EXCLUDED.calibration_sync_version,
                    conversion_version = EXCLUDED.conversion_version,
                    received_at = NOW()
                WHERE watermark_readings.edge_sync_version < EXCLUDED.edge_sync_version
                """, params);
    }

    private static String required(Map<String, Object> p, String key) {
        String v = SyncEventShapes.str(p, key);
        if (v == null || v.isBlank()) throw new IllegalArgumentException("WATERMARK reading missing " + key);
        return v.trim();
    }
}
```

`SyncEventShapes.str`, `numLong` and `normalizeGatewayDeviceEui` are the helpers `DeviceRevisionMirrorApplier` uses; if a helper is package-private, add a public static wrapper in `SyncEventShapes` rather than copying it.

- [ ] **Step 5: Write the applier test** `WatermarkReadingApplierTest.java` (Mockito, no Spring):

```java
package org.osi.server.sync;

@ExtendWith(MockitoExtension.class)
class WatermarkReadingApplierTest {

    @Mock WatermarkReadingMirror mirror;

    private EdgeSyncService.SyncEventRecord event(String key, long version, Map<String, Object> payload) {
        return new EdgeSyncService.SyncEventRecord("e1", "WATERMARK_READING", key, "WATERMARK_READING_APPENDED",
                version, "2026-10-01T06:00:01.000Z", payload);
    }

    private Map<String, Object> payload(long version) {
        return Map.of("device_eui", "A84041A171000001", "recorded_at", "2026-10-01T06:00:00.000Z",
                "edge_reading_id", 42, "sync_version", version);
    }

    @Test
    void appliesAConsistentEvent() {
        new WatermarkReadingApplier(mirror).apply("0016C001F1000002",
                event("A84041A171000001|2026-10-01T06:00:00.000Z|42", 1, payload(1)));
        verify(mirror).upsert(any(), eq("0016C001F1000002"));
    }

    @Test
    void rejectsAnAggregateKeyThatDoesNotMatchThePayload() {
        assertThatThrownBy(() -> new WatermarkReadingApplier(mirror).apply("0016C001F1000002",
                event("A84041A171000001|2026-10-01T06:00:00.000Z|43", 1, payload(1))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("aggregate key");
        verifyNoInteractions(mirror);
    }

    @Test
    void rejectsAVersionMismatchBetweenEnvelopeAndPayload() {
        assertThatThrownBy(() -> new WatermarkReadingApplier(mirror).apply("0016C001F1000002",
                event("A84041A171000001|2026-10-01T06:00:00.000Z|42", 2, payload(1))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("sync version");
    }
}
```

Check the `SyncEventRecord` constructor order in `EdgeSyncService.java` and adjust the `event(...)` helper to it.

- [ ] **Step 6: Write the applier and route the resource type.**

`backend/src/main/java/org/osi/server/sync/WatermarkReadingApplier.java`:

```java
package org.osi.server.sync;

import lombok.RequiredArgsConstructor;
import org.osi.server.watermark.WatermarkReadingMirror;
import org.springframework.stereotype.Component;

import java.util.Locale;
import java.util.Map;
import java.util.Set;

@Component
@RequiredArgsConstructor
class WatermarkReadingApplier implements SyncEventApplier {

    private final WatermarkReadingMirror mirror;

    @Override
    public Set<String> supportedOps() {
        return Set.of("WATERMARK_READING_APPENDED");
    }

    @Override
    public void apply(String gatewayDeviceEui, EdgeSyncService.SyncEventRecord event) {
        Map<String, Object> p = event.payload();
        String expectedKey = String.valueOf(p.get("device_eui")).toUpperCase(Locale.ROOT)
                + "|" + p.get("recorded_at") + "|" + p.get("edge_reading_id");
        if (event.aggregateKey() == null || !expectedKey.equalsIgnoreCase(event.aggregateKey())) {
            throw new IllegalArgumentException("WATERMARK reading aggregate key mismatch");
        }
        long payloadVersion = SyncEventShapes.numLong(p, "sync_version", "syncVersion", -1L);
        if (event.syncVersion() == null || payloadVersion != event.syncVersion()) {
            throw new IllegalArgumentException("WATERMARK reading sync version mismatch");
        }
        mirror.upsert(p, gatewayDeviceEui);
    }
}
```

In `EdgeSyncService.EventResourceRef.resourceTypeFromOp`, directly after the `CHAMELEON_READING_APPENDED` → `CHAMELEON_ROW` block and before phase 2's `WATERMARK_CALIBRATION_` mapping (R9):

```java
            // WATERMARK raw rows (osi-os 0063): one resource per edge row, keyed
            // deveui|recorded_at|edge id. Exact match, before any WATERMARK_ prefix
            // fallback, or the row would share the calibration's watermark slot.
            if ("WATERMARK_READING_APPENDED".equals(op)) {
                return "WATERMARK_ROW";
            }
```

In `resourceIdForType`, extend the first case to `case "DEVICE_DATA_ROW", "DENDRO_ROW", "CHAMELEON_ROW", "WATERMARK_ROW" ->`. In `EdgeOwnershipService`, extend the composite-id bucket to `case "DEVICE_DATA_ROW", "DENDRO_ROW", "CHAMELEON_ROW", "WATERMARK_ROW", "DENDRO_DAILY", …` and add a comment line saying WATERMARK rows resolve ownership through the device EUI prefix, like Chameleon rows.

- [ ] **Step 7: Run the sync suite.**

```bash
cd backend && ./gradlew test --tests 'org.osi.server.sync.*' --tests 'org.osi.server.watermark.*' --tests 'org.osi.server.security.*'
```
Expected: PASS, including `SyncOpCoverageTest` and the new IT. Then, from osi-os:

```bash
OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server-worktree>/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node <osi-os-worktree>/scripts/verify-sync-op-parity.js
```
Expected: it now reports `WATERMARK_READING_APPENDED` as server-handled while still listed `cloudDeferred`. If the script treats that as an error, that is the signal E11 acts on; record the exact message in the task report.

- [ ] **Step 8: Commit.**

```bash
git add -A backend/src
git commit -m "feat(sync): mirror WATERMARK_READING_APPENDED into watermark_readings (versioned upsert, WATERMARK_ROW ownership)"
```

---

### Task C3: Bootstrap readings and the device flag mirror

**Files:**
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java` (`EdgeBootstrapRequest` record at line ~2360, its constructors, the bootstrap loop at line ~284, the device upsert at line ~1323)
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java` (`DeviceResponse` record at line ~1365 and `from(...)`), `frontend/src/types/farming.ts`, `frontend/src/services/api.ts` (device normaliser at line ~630)
- Test: `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceBootstrapTest.java`, `EdgeSyncServiceDataPlaneTest.java` (add cases)

**Interfaces:**
- Consumes: `WatermarkReadingMirror.upsert` (C2).
- Produces: bootstrap key `watermark_readings` (list of E2-shaped payloads, sent by E8); `DeviceResponse.watermarkEnabled` (int); frontend `Device.watermark_enabled?: number`.

- [ ] **Step 1: Write the failing tests.**
  - `EdgeSyncServiceBootstrapTest`: copy the case that bootstraps `chameleonReadings` and assert that a request with one `watermark_readings` entry calls `watermarkReadingMirror.upsert(entry, "<gateway>")` once and counts it applied. The test class constructs `EdgeSyncService` with mocks; add a `@Mock WatermarkReadingMirror watermarkReadingMirror` and pass it in.
  - `EdgeSyncServiceDataPlaneTest`: copy the DEVICE event case that asserts `chameleon_enabled`, send `"watermark_enabled", 1`, and assert `device.getWatermarkEnabled() == 1`; a second event without the key leaves it unchanged.

Run: `cd backend && ./gradlew test --tests 'org.osi.server.sync.EdgeSyncServiceBootstrapTest' --tests 'org.osi.server.sync.EdgeSyncServiceDataPlaneTest'`
Expected: compile FAIL.

- [ ] **Step 2: Extend `EdgeBootstrapRequest`.** Append a last component after phase 2's `watermarkCalibrations` (R12), with the same alias treatment as `valve_actuations`:

```java
            // WATERMARK phase 3 (osi-os E8): the edge's sync-bootstrap-build /
            // sync-force-build send the last 30 days of watermark_readings, capped at
            // 500 rows, under the snake_case key, like valve_actuations.
            @com.fasterxml.jackson.annotation.JsonAlias("watermark_readings") List<Map<String, Object>> watermarkReadings
```

Add an overload with the signature phase 2 leaves (everything up to `watermarkCalibrations`) that delegates with `List.of()`, and in the compact constructor `watermarkReadings = watermarkReadings != null ? watermarkReadings : List.of();`. Every existing overload that calls the canonical constructor gains a trailing `List.of()`.

- [ ] **Step 3: Apply bootstrap rows.** Inject `WatermarkReadingMirror watermarkReadingMirror` into `EdgeSyncService` (constructor field). After the `chameleonReadings` loop:

```java
        for (Map<String, Object> reading : sortByInstant(request.watermarkReadings(), "recorded_at", "recordedAt", "timestamp")) {
            if (applyBootstrapItem("WATERMARK_ROW", str(reading, "device_eui", "deviceEui", "deveui"), rejected,
                    () -> { watermarkReadingMirror.upsert(reading, request.gatewayDeviceEui()); return null; })) {
                applied++;
            }
        }
```

Match `applyBootstrapItem`'s functional parameter type (the Chameleon call passes a supplier returning the saved row; return `null` or adapt).

- [ ] **Step 4: Mirror the flag.** In the device upsert, after the `chameleon_enabled` block (phase 2 adds no DEVICE field, R11, so this is the first WATERMARK key the DEVICE payload carries):

```java
        // The edge owns watermark_enabled (osi-os enable.js); the cloud only mirrors it.
        if (payload.containsKey("watermark_enabled") || payload.containsKey("watermarkEnabled")) {
            device.setWatermarkEnabled(bool(payload, "watermark_enabled", "watermarkEnabled",
                    isEnabled(device.getWatermarkEnabled())) ? 1 : 0);
        }
```

- [ ] **Step 5: Expose it.** Add `int watermarkEnabled` after `int chameleonEnabled` in `DeviceResponse` and pass `d.getWatermarkEnabled()` in `from(...)`. In `frontend/src/types/farming.ts` add `watermarkEnabled?: number; watermark_enabled?: number;` next to the Chameleon pair, and in `api.ts` add `watermark_enabled: d.watermarkEnabled ?? raw.watermark_enabled ?? 0,` next to line 630.

- [ ] **Step 6: Run the tests.**

```bash
cd backend && ./gradlew test --tests 'org.osi.server.sync.*' --tests 'org.osi.server.device.*'
```
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add -A backend/src frontend/src/types/farming.ts frontend/src/services/api.ts
git commit -m "feat(sync): bootstrap watermark_readings and mirror devices.watermark_enabled from DEVICE events"
```

---

### Task C4: Cloud retention for WATERMARK readings

**Files:**
- Create: `backend/src/main/java/org/osi/server/retention/WatermarkReadingRetentionJob.java`
- Create: `backend/src/test/java/org/osi/server/retention/WatermarkReadingRetentionJobTest.java`
- Modify: `backend/src/main/resources/application.yml` (document the property under the existing `osi.retention` block)

**Interfaces:**
- Produces: `WatermarkReadingRetentionJob.run(boolean dryRun)` → `Report(candidateCount, deletedCount, cutoff, dryRun)`; property `osi.retention.watermark-readings.days` (default 365), cron `osi.retention.watermark-readings.cron` (default `0 10 4 * * *`, ten minutes after telemetry).

- [ ] **Step 1: Write the test** (mirrors `TelemetryRetentionJobTest`, with a mocked `NamedParameterJdbcTemplate`):

```java
package org.osi.server.retention;

@ExtendWith(MockitoExtension.class)
class WatermarkReadingRetentionJobTest {

    @Mock NamedParameterJdbcTemplate jdbc;
    @InjectMocks WatermarkReadingRetentionJob job;

    @BeforeEach
    void setUp() {
        ReflectionTestUtils.setField(job, "retentionDays", 365);
    }

    @Test
    void dryRunCountsWithoutDeleting() {
        when(jdbc.queryForObject(startsWith("SELECT COUNT(*) FROM watermark_readings"), any(MapSqlParameterSource.class), eq(Long.class)))
                .thenReturn(12L);
        WatermarkReadingRetentionJob.Report report = job.run(true);
        assertThat(report.candidateCount()).isEqualTo(12L);
        assertThat(report.deletedCount()).isZero();
        verify(jdbc, never()).update(startsWith("DELETE"), any(MapSqlParameterSource.class));
    }

    @Test
    void liveRunDeletesRowsOlderThanTheCutoff() {
        when(jdbc.queryForObject(startsWith("SELECT COUNT(*) FROM watermark_readings"), any(MapSqlParameterSource.class), eq(Long.class)))
                .thenReturn(12L);
        when(jdbc.update(startsWith("DELETE FROM watermark_readings"), any(MapSqlParameterSource.class))).thenReturn(12);
        WatermarkReadingRetentionJob.Report report = job.run(false);
        assertThat(report.deletedCount()).isEqualTo(12L);
        assertThat(report.cutoff()).isBefore(Instant.now().minus(Duration.ofDays(364)));
    }

    @Test
    void aZeroOrNegativeSettingNeverDeletesEverything() {
        ReflectionTestUtils.setField(job, "retentionDays", 0);
        assertThat(job.run(true).cutoff()).isBefore(Instant.now().minus(Duration.ofHours(23)));
    }
}
```

Run: `cd backend && ./gradlew test --tests 'org.osi.server.retention.WatermarkReadingRetentionJobTest'`
Expected: compile FAIL.

- [ ] **Step 2: Write the job:**

```java
package org.osi.server.retention;

@Component
@RequiredArgsConstructor
@Slf4j
public class WatermarkReadingRetentionJob {

    private final NamedParameterJdbcTemplate jdbc;

    @Value("${osi.retention.watermark-readings.days:365}")
    private int retentionDays;

    public record Report(long candidateCount, long deletedCount, Instant cutoff, boolean dryRun) {}

    @Scheduled(cron = "${osi.retention.watermark-readings.cron:0 10 4 * * *}")
    @Transactional
    public Report runScheduled() {
        return run(false);
    }

    @Transactional
    public Report run(boolean dryRun) {
        Instant cutoff = Instant.now().minus(Duration.ofDays(Math.max(1, retentionDays)));
        MapSqlParameterSource params = new MapSqlParameterSource("cutoff", Timestamp.from(cutoff));
        Long candidates = jdbc.queryForObject(
                "SELECT COUNT(*) FROM watermark_readings WHERE recorded_at < :cutoff", params, Long.class);
        long count = candidates == null ? 0L : candidates;
        if (dryRun) {
            return new Report(count, 0, cutoff, true);
        }
        int deleted = jdbc.update("DELETE FROM watermark_readings WHERE recorded_at < :cutoff", params);
        if (deleted > 0) {
            log.info("Purged {} watermark_readings rows older than {} days", deleted, retentionDays);
        }
        return new Report(count, deleted, cutoff, false);
    }
}
```

- [ ] **Step 3: Run the test.** Same command; expected PASS.

- [ ] **Step 4: Commit.**

```bash
git add -A backend/src
git commit -m "feat(retention): 365-day cloud retention for watermark_readings"
```

---

### Task C5: `SET_WATERMARK_CONFIG` endpoint and the cloud side of D7

**Files:**
- Create: `backend/src/main/java/org/osi/server/watermark/WatermarkCommandTarget.java` (extracted from phase 2's `WatermarkCalibrationCommandService.target`, R10), `WatermarkConfigCommandService.java`
- Modify: `backend/src/main/java/org/osi/server/watermark/WatermarkCalibrationCommandService.java` (call the extracted target), `WatermarkCalibrationController.java` (new `PUT …/watermark/config` mapping, or a sibling `WatermarkConfigController` in the same style), `backend/src/main/java/org/osi/server/device/DeviceController.java` (Chameleon endpoint refusal), `backend/src/main/java/org/osi/server/command/DeviceCommandRepository.java` (stale-pending config list at lines ~305 and ~320), `backend/src/test/resources/sync-contract/sync-contract-golden.json` (`commandTypes.cloudIssuerEnabled`)
- Test: create `backend/src/test/java/org/osi/server/watermark/WatermarkConfigCommandServiceTest.java`; phase 2's `WatermarkCalibrationCommandServiceTest` must stay green after the extraction; add a case to the Chameleon controller test (find it with `grep -rln "setChameleonEnabled" backend/src/test`)

**Interfaces:**
- Consumes: `WatermarkCommandTarget.resolve(actor, deviceEui, Predicate<LinkedGatewayAccount> supported, String unsupportedMessage)` → `Target(device, gateway, eui, gatewayEui, localUserUuid)`; phase 2's calibration `current(t)` (made package-visible as `WatermarkCalibrationCommandService.currentVersion(Target)`); `DesiredStateService.request(...)`; `CanonicalResourceVersionReader.currentVersion(gatewayEui, "DEVICE", eui)`; `LinkedGatewayAccount.isWatermarkSchedulerSupported()` and `isWatermarkSupported()` (C1, R6); `Device.getWatermarkEnabled()`, `getChameleonEnabled()`.
- Produces: `PUT /api/v1/devices/{deviceEui}/watermark/config`, body `{ "enabled": boolean, "calibrationSyncVersion": number|null }` → 202 `DesiredStateView`. Errors in phase 2's style: 400 missing `enabled` or an enable without `calibrationSyncVersion`; 403 / 404 from the shared target rules; 409 `{ "error": "stale_sync_version", "currentSyncVersion": n }` when `calibrationSyncVersion` differs from the calibration's current version; 409 `{ "error": "chameleon_enabled" }` on an enable while the mirror shows Chameleon on; 409 `{ "error": "calibration_missing" }` on an enable with no live calibration mirror; 501 on a gateway without both `watermark_v1` and `watermark_scheduler_v1`.
- Command payload (R7): `command_type`, `command_id` (UUID), `device_eui`, `gateway_device_eui`, `actor_user_uuid` (the gateway's local actor), `requested_at` (UTC, ms), `enabled`, and `calibration_sync_version` on an enable. No `effect_key`.
- Ledger: resource `DEVICE` / EUI, `base` = the DEVICE watermark slot (`versions.currentVersion(gw, "DEVICE", eui)`), `desired = {"watermark_enabled": 1|0}` as `Integer` (the DEVICE payload's decorator writes an integer, so `IntNode` meets `IntNode`; phase 2's `wireNumber` note explains the trap), expiry 24 h.

The cloud checks are advisory. The edge re-checks every precondition when it applies the command and is the only place the flag changes. Known limit: an unrelated DEVICE event (a rename, a zone move) that reaches the cloud between the request and the edge's apply has a higher version and `watermark_enabled` still 0, so the ledger marks the operation `conflicted` / `mirror_diverged` although the edge then applies it. The mirror stays correct, and the GUI shows the mirrored flag next to the operation.

- [ ] **Step 1: Extract the target rules.** Move `Target` and `target(...)` from `WatermarkCalibrationCommandService` into `WatermarkCommandTarget` (a `@Component` with the same collaborators), parameterised by the capability predicate and the 501 message. `WatermarkCalibrationCommandService` calls `resolve(actor, eui, LinkedGatewayAccount::isWatermarkSupported, "Gateway does not support WATERMARK calibration commands")`. Make its version lookup `long currentVersion(Target t)` package-visible.

Run: `cd backend && ./gradlew test --tests 'org.osi.server.watermark.*'`
Expected: PASS (a pure refactor; phase 2's tests are the check).

- [ ] **Step 2: Write the failing service test** `WatermarkConfigCommandServiceTest` (Mockito; mock `WatermarkCommandTarget`, `WatermarkCalibrationCommandService`, `WatermarkCalibrationMirrorRepository`, `CanonicalResourceVersionReader`, `DesiredStateService`):

```java
package org.osi.server.watermark;

@ExtendWith(MockitoExtension.class)
class WatermarkConfigCommandServiceTest {

    @Mock WatermarkCommandTarget targets;
    @Mock WatermarkCalibrationCommandService calibrations;
    @Mock WatermarkCalibrationMirrorRepository mirrors;
    @Mock CanonicalResourceVersionReader versions;
    @Mock DesiredStateService desiredState;

    private final User actor = User.builder().id(7L).username("operator").build();
    private final Clock clock = Clock.fixed(Instant.parse("2026-10-02T06:00:00Z"), ZoneOffset.UTC);

    private WatermarkConfigCommandService service() {
        return new WatermarkConfigCommandService(targets, calibrations, mirrors, versions, desiredState, clock);
    }

    private WatermarkCommandTarget.Target target(int chameleon) {
        Device device = Device.builder().deviceEui("A84041A171000001").type("DRAGINO_LSN50").chameleonEnabled(chameleon).build();
        Device gateway = Device.builder().deviceEui("0016C001F1000002").build();
        return new WatermarkCommandTarget.Target(device, gateway, "A84041A171000001", "0016C001F1000002",
                "12345678-1234-4234-8234-123456789abc");
    }

    private void live(long calibrationVersion) {
        when(mirrors.findById("A84041A171000001")).thenReturn(Optional.of(
                WatermarkCalibrationMirror.builder().deviceEui("A84041A171000001").syncVersion(calibrationVersion).build()));
        when(calibrations.currentVersion(any())).thenReturn(calibrationVersion);
    }

    @Test
    void queuesTheContractPayloadThroughTheLedgerWithA24hExpiry() {
        when(targets.resolve(eq(actor), eq("A84041A171000001"), any(), any())).thenReturn(target(0));
        live(3L);
        when(versions.currentVersion("0016C001F1000002", "DEVICE", "A84041A171000001")).thenReturn(Optional.of(12L));
        service().request(actor, "A84041A171000001", new WatermarkConfigCommandService.ConfigRequest(true, 3L));
        ArgumentCaptor<DesiredStateService.Request> captor = ArgumentCaptor.forClass(DesiredStateService.Request.class);
        verify(desiredState).request(any(), eq(actor), captor.capture());
        DesiredStateService.Request r = captor.getValue();
        assertThat(r.commandType()).isEqualTo("SET_WATERMARK_CONFIG");
        assertThat(r.resourceType()).isEqualTo("DEVICE");
        assertThat(r.baseSyncVersion()).isEqualTo(12L);
        assertThat(r.desired()).containsEntry("watermark_enabled", 1);
        assertThat(r.effectKey()).isNull();
        assertThat(r.commandPayload()).containsEntry("device_eui", "A84041A171000001")
                .containsEntry("gateway_device_eui", "0016C001F1000002")
                .containsEntry("actor_user_uuid", "12345678-1234-4234-8234-123456789abc")
                .containsEntry("requested_at", "2026-10-02T06:00:00.000Z")
                .containsEntry("enabled", true).containsEntry("calibration_sync_version", 3L)
                .doesNotContainKey("effect_key");
        assertThat(r.expiresAt()).isEqualTo(Instant.parse("2026-10-03T06:00:00Z"));
    }

    @Test
    void aStaleCalibrationVersionIsRefusedBeforeQueueing() {
        when(targets.resolve(any(), any(), any(), any())).thenReturn(target(0));
        live(4L);
        assertThatThrownBy(() -> service().request(actor, "A84041A171000001", new WatermarkConfigCommandService.ConfigRequest(true, 3L)))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode().value()).isEqualTo(409));
        verify(desiredState, never()).request(any(), any(), any());
    }

    @Test
    void refusesEnableWhileTheMirrorShowsChameleonOn() {
        when(targets.resolve(any(), any(), any(), any())).thenReturn(target(1));
        live(3L);
        assertThatThrownBy(() -> service().request(actor, "A84041A171000001", new WatermarkConfigCommandService.ConfigRequest(true, 3L)))
                .hasMessageContaining("chameleon_enabled");
    }

    @Test
    void refusesEnableWithoutALiveCalibration() {
        when(targets.resolve(any(), any(), any(), any())).thenReturn(target(0));
        when(mirrors.findById("A84041A171000001")).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service().request(actor, "A84041A171000001", new WatermarkConfigCommandService.ConfigRequest(true, 3L)))
                .hasMessageContaining("calibration_missing");
    }

    @Test
    void disableNeedsNoCalibrationAndIgnoresChameleon() {
        when(targets.resolve(any(), any(), any(), any())).thenReturn(target(1));
        when(versions.currentVersion(any(), any(), any())).thenReturn(Optional.of(12L));
        service().request(actor, "A84041A171000001", new WatermarkConfigCommandService.ConfigRequest(false, null));
        verify(desiredState).request(any(), eq(actor), any());
    }

    @Test
    void theCapabilityPredicateNeedsBothWatermarkCapabilities() {
        when(targets.resolve(any(), any(), any(), any())).thenReturn(target(0));
        when(versions.currentVersion(any(), any(), any())).thenReturn(Optional.of(12L));
        service().request(actor, "A84041A171000001", new WatermarkConfigCommandService.ConfigRequest(false, null));
        ArgumentCaptor<Predicate<LinkedGatewayAccount>> predicate = ArgumentCaptor.forClass(Predicate.class);
        verify(targets).resolve(any(), any(), predicate.capture(), any());
        LinkedGatewayAccount only = new LinkedGatewayAccount();
        only.setWatermarkSupported(true);
        assertThat(predicate.getValue().test(only)).isFalse();
        only.setWatermarkSchedulerSupported(true);
        assertThat(predicate.getValue().test(only)).isTrue();
    }
}
```

Adjust builders to the real `User`, `Device`, `WatermarkCalibrationMirror` and `LinkedGatewayAccount` APIs (phase 2's tests show which exist).

Run: `cd backend && ./gradlew test --tests 'org.osi.server.watermark.WatermarkConfigCommandServiceTest'`
Expected: compile FAIL.

- [ ] **Step 3: Write the service:**

```java
package org.osi.server.watermark;

@Service
@RequiredArgsConstructor
public class WatermarkConfigCommandService {

    public static final String COMMAND_TYPE = "SET_WATERMARK_CONFIG";
    static final Duration EXPIRY = Duration.ofHours(24);
    private static final DateTimeFormatter UTC_MS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    public record ConfigRequest(Boolean enabled, Long calibrationSyncVersion) {}

    private final WatermarkCommandTarget targets;
    private final WatermarkCalibrationCommandService calibrations;
    private final WatermarkCalibrationMirrorRepository mirrors;
    private final CanonicalResourceVersionReader versions;
    private final DesiredStateService desiredState;
    private final Clock clock;

    @Transactional
    public DesiredStateView request(User actor, String deviceEui, ConfigRequest request) {
        if (request == null || request.enabled() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "enabled is required");
        }
        WatermarkCommandTarget.Target t = targets.resolve(actor, deviceEui,
                a -> a.isWatermarkSupported() && a.isWatermarkSchedulerSupported(),
                "Gateway does not support WATERMARK irrigation control");
        boolean enabled = request.enabled();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("command_type", COMMAND_TYPE);
        payload.put("command_id", UUID.randomUUID().toString());
        payload.put("device_eui", t.eui());
        payload.put("gateway_device_eui", t.gatewayEui());
        payload.put("actor_user_uuid", t.localUserUuid());
        payload.put("requested_at", UTC_MS.format(clock.instant()));
        payload.put("enabled", enabled);
        if (enabled) {
            Long quoted = request.calibrationSyncVersion();
            if (quoted == null || quoted < 1) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "calibrationSyncVersion is required to enable");
            }
            boolean live = mirrors.findById(t.eui()).filter(m -> m.getDeletedAt() == null).isPresent();
            if (!live) throw new ResponseStatusException(HttpStatus.CONFLICT, "calibration_missing");
            long current = calibrations.currentVersion(t);
            if (quoted != current) throw new StaleCalibrationVersionException(current); // phase 2's 409 body
            // Advisory D7 check; the edge refuses too.
            if (t.device().getChameleonEnabled() == 1) throw new ResponseStatusException(HttpStatus.CONFLICT, "chameleon_enabled");
            payload.put("calibration_sync_version", quoted);
        }
        long base = versions.currentVersion(t.gatewayEui(), "DEVICE", t.eui()).orElse(0L);
        return desiredState.request(t.gateway(), actor, new DesiredStateService.Request(
                "DEVICE", t.eui(), COMMAND_TYPE, DesiredStateMutationKind.CONFIG, base,
                Map.of("watermark_enabled", enabled ? 1 : 0), payload, null, clock.instant().plus(EXPIRY)));
    }
}
```

`StaleCalibrationVersionException` is phase 2's (C4); reuse it so both endpoints render `{ "error": "stale_sync_version", "currentSyncVersion": n }`. Render the other 409s in the same `{ "error": … }` shape through the controller's exception handling, matching phase 2.

- [ ] **Step 4: Controller, D7 refusal, expiry list, golden.**
  - Add `@PutMapping("/api/v1/devices/{deviceEui}/watermark/config")` in the phase 2 controller style (`UserService.findByUsername(principal.getUsername())`, `ResponseEntity.accepted().body(view)`).
  - `DeviceController.setChameleonEnabled`: if `request.enabled()` is true and the device's `watermarkEnabled == 1`, return 409 `{ "error": "watermark_enabled" }` before any write or command. Keep it above whatever D6 leaves in that method.
  - `DeviceCommandRepository`: add `'SET_WATERMARK_CONFIG'` to both `command_type IN (...)` lists at lines ~305 and ~320, so a stale pending command row expires like the Chameleon config command.
  - `sync-contract-golden.json`: add `"SET_WATERMARK_CONFIG"` to `commandTypes.cloudIssuerEnabled`.
  - MockMvc cases: 202 for a valid enable, 409 `stale_sync_version`, 501 on a gateway without `watermark_scheduler_v1`, 400 without `enabled`; Chameleon enable on a `watermarkEnabled = 1` device → 409 `watermark_enabled` and `deviceService.setChameleonEnabled` never called; Chameleon disable still works.

- [ ] **Step 5: Run the tests.**

```bash
cd backend && ./gradlew test --tests 'org.osi.server.watermark.*' --tests 'org.osi.server.device.*' --tests 'org.osi.server.command.*' --tests 'org.osi.server.desiredstate.*' --tests 'org.osi.server.sync.SyncContractVendorTest' --tests 'org.osi.server.ArchitectureTest'
```
Expected: PASS, including the Chameleon PR's controller-vs-contract command test (it must now see `SET_WATERMARK_CONFIG` in the vendored enum).

- [ ] **Step 6: Commit.**

```bash
git add -A backend/src
git commit -m "feat(watermark): SET_WATERMARK_CONFIG through the desired-state ledger; Chameleon enable refused while WATERMARK control is on"
```

---

### Task C6: Cloud GUI, the WATERMARK irrigation control

**Files:**
- Create: `frontend/src/components/farming/WatermarkSchedulerControl.tsx`, `frontend/src/components/farming/__tests__/WatermarkSchedulerControl.test.tsx`
- Modify: `frontend/src/components/farming/WatermarkCloudSection.tsx` (phase 2, R11: host the control under `WatermarkCalibrationPanel`), `frontend/src/components/farming/DraginoCard.tsx` (disable the Chameleon toggle), `frontend/src/services/api.ts` (`devicesAPI.setWatermarkConfig`), `frontend/src/contexts/gatewayCapabilities.ts` (`watermarkSchedulerSupported(state)`), the gateway type that carries `zoneDesiredStateSupported` (add `watermarkSchedulerSupported?: boolean`), `frontend/public/locales/*/devices.json` (all 7; `lg` mirrors `en`)

**Interfaces:**
- Consumes: `PUT /api/v1/devices/{eui}/watermark/config` (C5); `device.watermark_enabled`, `device.chameleon_enabled`; phase 2's calibration view with `syncVersion` (R11); `PendingStateNotice` (`frontend/src/components/sync/PendingStateNotice.tsx`).
- Produces: `devicesAPI.setWatermarkConfig(deviceEui: string, enabled: boolean, calibrationSyncVersion: number | null): Promise<DesiredStateOperation>` (C5 returns the view directly, like phase 2's calibration endpoints).

- [ ] **Step 1: Write the failing component test** `WatermarkSchedulerControl.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WatermarkSchedulerControl } from '../WatermarkSchedulerControl';

const base = {
  deviceEui: 'A84041A171000001',
  zoneName: 'Orchard 3',
  watermarkEnabled: false,
  chameleonEnabled: false,
  calibrationSyncVersion: 3 as number | null,
  supported: true,
  writable: true,
  operation: null,
  onSubmit: vi.fn().mockResolvedValue(undefined),
};

describe('WatermarkSchedulerControl', () => {
  it('asks for a second confirming click that names the zone before enabling', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<WatermarkSchedulerControl {...base} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /use for irrigation/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Orchard 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onSubmit).toHaveBeenCalledWith(true, 3);
  });

  it('is disabled and says why while Chameleon is on', () => {
    render(<WatermarkSchedulerControl {...base} chameleonEnabled />);
    expect((screen.getByRole('button', { name: /use for irrigation/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/turn off chameleon/i)).toBeTruthy();
  });

  it('is disabled without a saved calibration', () => {
    render(<WatermarkSchedulerControl {...base} calibrationSyncVersion={null} />);
    expect((screen.getByRole('button', { name: /use for irrigation/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the not-available state on a gateway without watermark_scheduler_v1', () => {
    render(<WatermarkSchedulerControl {...base} supported={false} />);
    expect(screen.queryByRole('button', { name: /use for irrigation/i })).toBeNull();
    expect(screen.getByText(/gateway update/i)).toBeTruthy();
  });

  it('turns off in one click with no preconditions', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<WatermarkSchedulerControl {...base} watermarkEnabled chameleonEnabled calibrationSyncVersion={null} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /stop using/i }));
    expect(onSubmit).toHaveBeenCalledWith(false, null);
  });
});
```

Run: `cd frontend && npm run test:unit -- WatermarkSchedulerControl`
Expected: FAIL (module not found). If the script does not pass a filter through, run the whole `npm run test:unit`.

- [ ] **Step 2: Write the component** `WatermarkSchedulerControl.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DesiredStateOperation } from '../../types/desiredState';
import { PendingStateNotice } from '../sync/PendingStateNotice';

export interface WatermarkSchedulerControlProps {
  deviceEui: string;
  zoneName: string | null;
  watermarkEnabled: boolean;
  chameleonEnabled: boolean;
  calibrationSyncVersion: number | null;
  supported: boolean;
  writable: boolean;
  operation: DesiredStateOperation | null;
  onSubmit: (enabled: boolean, calibrationSyncVersion: number | null) => Promise<void>;
}

export function WatermarkSchedulerControl(props: WatermarkSchedulerControlProps) {
  const { t } = useTranslation('devices');
  const [confirming, setConfirming] = useState(false);
  if (!props.supported) {
    return <p className="text-sm text-slate-600">{t('watermark.scheduler.unsupported', 'Needs a gateway update before this probe can drive irrigation.')}</p>;
  }
  const blockers: string[] = [];
  if (props.chameleonEnabled) blockers.push(t('watermark.scheduler.blockedChameleon', 'Turn off Chameleon SWT first.'));
  if (props.calibrationSyncVersion === null) blockers.push(t('watermark.scheduler.blockedCalibration', 'Save a calibration first.'));
  return (
    <div className="space-y-2">
      <p className="text-sm">
        {props.watermarkEnabled
          ? t('watermark.scheduler.on', 'This probe drives irrigation scheduling.')
          : t('watermark.scheduler.off', 'This probe does not drive irrigation scheduling.')}
      </p>
      <PendingStateNotice operation={props.operation} resourceLabel={t('watermark.scheduler.resource', 'WATERMARK irrigation control')} />
      {props.watermarkEnabled ? (
        <button type="button" disabled={!props.writable} onClick={() => props.onSubmit(false, null)}>
          {t('watermark.scheduler.disable', 'Stop using for irrigation')}
        </button>
      ) : confirming ? (
        <div role="group">
          <p className="text-sm">
            {t('watermark.scheduler.confirm', {
              defaultValue: 'This probe will start driving irrigation for {{zone}}. The circuit is experimental.',
              zone: props.zoneName ?? t('watermark.scheduler.noZone', 'its zone'),
            })}
          </p>
          <button type="button" onClick={() => { setConfirming(false); void props.onSubmit(true, props.calibrationSyncVersion); }}>
            {t('watermark.scheduler.confirmButton', 'Confirm')}
          </button>
          <button type="button" onClick={() => setConfirming(false)}>{t('common.cancel', 'Cancel')}</button>
        </div>
      ) : (
        <button type="button" disabled={!props.writable || blockers.length > 0} onClick={() => setConfirming(true)}>
          {t('watermark.scheduler.enable', 'Use for irrigation')}
        </button>
      )}
      {!props.watermarkEnabled && blockers.map((b) => <p key={b} className="text-sm text-amber-800">{b}</p>)}
      <p className="text-xs text-slate-600">{t('watermark.scheduler.edgeChecks', 'The gateway also needs a valid reading from the last 24 hours and refuses otherwise.')}</p>
    </div>
  );
}
```

Match the button and text classes to `WatermarkCalibrationPanel.tsx`; the test targets roles and text, not classes.

- [ ] **Step 3: Wire it.**
  - `api.ts`: `setWatermarkConfig: async (deviceEui, enabled, calibrationSyncVersion) => (await api.put(\`/api/v1/devices/${deviceEui}/watermark/config\`, { enabled, calibrationSyncVersion })).data`, normalising the response with `normaliseDesiredState` (line ~803).
  - `gatewayCapabilities.ts`: `export function watermarkSchedulerSupported(state: GatewayScopeState): boolean` returning false while loading or on error, and `state.activeGateway?.watermarkSchedulerSupported === true` otherwise (no cloud-local branch: a WATERMARK device only exists behind a gateway).
  - `WatermarkCloudSection.tsx`: render `WatermarkSchedulerControl` under `WatermarkCalibrationPanel`, passing the calibration view's `syncVersion` (null when `calibration` is null); keep the last returned `desiredState` in component state for `operation`. `DraginoCard.tsx`: in the sensor-toggle list, disable the `chameleon_enabled` toggle when `device.watermark_enabled === 1` and show `t('watermark.scheduler.chameleonBlocked', 'Turn off WATERMARK irrigation control first.')`; a 409 `watermark_enabled` from the server shows the same text.
  - Locales: add the `watermark.scheduler.*` keys to all 7 `devices.json` files; `lg` gets the English text.

- [ ] **Step 4: Run the tests and build once.**

```bash
cd frontend && npm run test:unit && npm run build
```
Expected: PASS, build succeeds. No other frontend build may run at the same time.

- [ ] **Step 5: Commit.**

```bash
git add -A frontend
git commit -m "feat(gui): WATERMARK irrigation control with confirmation, pending state and Chameleon exclusion"
```

---

## osi-os tasks, continued (after C1–C6)

### Task E4: The enable flag writer, revocation on delete, versioned backfill

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/enable.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/enable.test.js`
- Modify: `…/osi-watermark-helper/calibration.js` (export `httpError`, `normalizeDeveui`, `assertAccessibleLsn50`; revocation in phase 2's `deleteCalibrationInTransaction`, R3; `sync_version` bump in `backfillBatch`), `…/osi-watermark-helper/index.js`, `…/osi-watermark-helper/store.test.js`
- Modify: `deploy.sh` (`fetch_required` for `enable.js`, after the `ingest.js` block at line ~1654), and the same files under `conf/full_raspberrypi_bcm27xx_bcm2709/…` (byte copies)
- Modify: `.github/workflows/migrations.yml` (run `enable.test.js` next to `store.test.js`)

**Interfaces:**
- Consumes: `devices.watermark_enabled`, `watermark_readings.sync_version` (E2).
- Produces (exported through `index.js`):
  - `REASON_ORDER = ['device_not_found', 'not_lsn50', 'calibration_missing', 'calibration_changed', 'chameleon_enabled', 'no_recent_valid_reading']`
  - `readWatermarkConfig(db, deveuiUpper, { now?, calibrationSyncVersion? })` → `{ device, watermark_enabled, device_sync_version, calibration_sync_version, last_valid_reading_at, blocked_by: string[] }` (`blocked_by` ordered by `REASON_ORDER`)
  - `writeWatermarkEnabled(tx, deveuiUpper, { enabled, calibrationSyncVersion, now? })` → `{ deveui, watermark_enabled, sync_version, changed }`; throws `statusCode 409, code 'watermark_precondition_failed', reasons` when enabling is blocked. Runs inside the caller's transaction. It is the only function that may write `watermark_enabled = 1`.
  - `getWatermarkConfig(db, { deveui, userId, scoped })` and `setWatermarkEnabled(db, { deveui, userId, scoped, enabled, calibrationSyncVersion, now? })`: the HTTP-facing pair (access check + transaction + the functions above). E5 uses them.
  - `parseEnabled(value)` → `true | false`, throws 400 `invalid_enabled` otherwise (accepts `true`, `false`, `1`, `0`, `'true'`, `'false'`, `'1'`, `'0'`, like the Chameleon route).
- Changes: `deleteCalibrationInTransaction` (phase 2's seam, R3) also sets `watermark_enabled = 0` (bumping the device `sync_version`) and returns `watermark_enabled: 0, scheduler_revoked: boolean`. Because the REST `deleteCalibration` and phase 2's `DELETE_WATERMARK_CALIBRATION` applier both call the seam, both revoke. `backfillBatch` sets `sync_version = sync_version + 1` on every `watermark_readings` row it converts, in every batch (the first inside the save, the rest in `backfillRemaining`'s later transactions).

- [ ] **Step 1: Write the failing tests** `enable.test.js` (reuse `store.test.js`'s `facade`, `freshDb`, `frameB64`, `deps` and `CAL` by moving them into a small shared file `test-fixtures.js` in the same directory and requiring it from both tests; `freshDb` must also apply `0063` when the seed lacks `watermark_enabled`, the same way it applies `0060` today):

```js
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const wm = require('.');
const { freshDb, frameB64, deps, CAL, DEVEUI, USER_ID } = require('./test-fixtures');

const NOW = Date.parse('2026-10-02T06:00:00.000Z');
const HOURS_AGO = (h) => new Date(NOW - h * 3600e3).toISOString();
const OK_FRAME = () => frameB64([800, 3291], [71, 4058]); // ch1 ~10 kOhm ok, ch2 saturated
const OPEN_FRAME = () => frameB64([4093, 2], [4093, 2]);
const legacy = { deveui: DEVEUI, userId: USER_ID, scoped: false };

async function calibrated(ctx) {
  const saved = await wm.saveCalibration(ctx.db, Object.assign({}, legacy, { body: Object.assign({ expected_sync_version: 0 }, CAL) }));
  return saved.sync_version;
}
async function ingest(ctx, iso, b64) {
  return wm.ingestProfile3(ctx.db, { deveui: DEVEUI, recordedAt: iso, payloadB64: b64, fCnt: 1 }, deps);
}
const flag = (ctx) => ctx.native.prepare('SELECT watermark_enabled, sync_version FROM devices WHERE deveui = ?').get(DEVEUI);

describe('WATERMARK enable preconditions (spec section 8, OD-1)', () => {
  let ctx;
  beforeEach(() => { ctx = freshDb(); });

  it('enables with a live calibration, Chameleon off and a valid reading from the last 24 h under that calibration', async () => {
    const v = await calibrated(ctx);
    await ingest(ctx, HOURS_AGO(2), OK_FRAME());
    const before = flag(ctx).sync_version;
    const res = await wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: true, calibrationSyncVersion: v, now: NOW }));
    assert.equal(res.watermark_enabled, 1);
    assert.equal(flag(ctx).watermark_enabled, 1);
    assert.equal(flag(ctx).sync_version, before + 1, 'a flag write bumps the device sync_version');
  });

  it('refuses without a calibration and names the reason', async () => {
    await ingest(ctx, HOURS_AGO(2), OK_FRAME());
    await assert.rejects(
      wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: true, calibrationSyncVersion: 1, now: NOW })),
      (e) => e.statusCode === 409 && e.code === 'watermark_precondition_failed' && e.reasons.includes('calibration_missing'));
    assert.equal(flag(ctx).watermark_enabled, 0);
  });

  it('refuses with Chameleon on (D7, Review Focus 1)', async () => {
    const v = await calibrated(ctx);
    await ingest(ctx, HOURS_AGO(2), OK_FRAME());
    ctx.native.prepare('UPDATE devices SET chameleon_enabled = 1 WHERE deveui = ?').run(DEVEUI);
    await assert.rejects(
      wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: true, calibrationSyncVersion: v, now: NOW })),
      (e) => e.reasons.includes('chameleon_enabled'));
    assert.equal(flag(ctx).watermark_enabled, 0);
  });

  it('refuses when the only valid reading is older than 24 h', async () => {
    const v = await calibrated(ctx);
    await ingest(ctx, HOURS_AGO(25), OK_FRAME());
    await ingest(ctx, HOURS_AGO(1), OPEN_FRAME());
    await assert.rejects(
      wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: true, calibrationSyncVersion: v, now: NOW })),
      (e) => e.reasons.includes('no_recent_valid_reading'));
  });

  it('refuses when the recent valid reading was converted under an older calibration version (OD-1a)', async () => {
    await calibrated(ctx);
    await ingest(ctx, HOURS_AGO(2), OK_FRAME());
    const v2 = (await wm.saveCalibration(ctx.db, Object.assign({}, legacy, {
      body: Object.assign({}, CAL, { series_fwd_1_ohm: 131, expected_sync_version: 1 }) }))).sync_version;
    await assert.rejects(
      wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: true, calibrationSyncVersion: v2, now: NOW })),
      (e) => e.reasons.includes('no_recent_valid_reading'));
  });

  it('refuses a stale calibration_sync_version with calibration_changed (OD-1b, Review Focus 3)', async () => {
    const v = await calibrated(ctx);
    await ingest(ctx, HOURS_AGO(2), OK_FRAME());
    await assert.rejects(
      wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: true, calibrationSyncVersion: v + 1, now: NOW })),
      (e) => e.reasons.includes('calibration_changed'));
    assert.equal(flag(ctx).watermark_enabled, 0);
  });

  it('refuses an enable without calibration_sync_version as a bad request', async () => {
    await assert.rejects(
      wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: true, now: NOW })),
      (e) => e.statusCode === 400 && e.code === 'invalid_calibration_sync_version');
  });

  it('disabling needs no preconditions, and an unchanged value writes nothing', async () => {
    ctx.native.prepare('UPDATE devices SET watermark_enabled = 1, chameleon_enabled = 1 WHERE deveui = ?').run(DEVEUI);
    const before = flag(ctx).sync_version;
    await wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: false, now: NOW }));
    assert.equal(flag(ctx).watermark_enabled, 0);
    await wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: false, now: NOW }));
    assert.equal(flag(ctx).sync_version, before + 1, 'the no-op second write must not bump');
  });

  it('readWatermarkConfig lists every blocker in REASON_ORDER', async () => {
    ctx.native.prepare('UPDATE devices SET chameleon_enabled = 1 WHERE deveui = ?').run(DEVEUI);
    const state = await wm.readWatermarkConfig(ctx.db, DEVEUI, { now: NOW });
    assert.deepEqual(state.blocked_by, ['calibration_missing', 'chameleon_enabled', 'no_recent_valid_reading']);
  });
});

describe('revocation and versioned backfill (spec section 8, OD-2)', () => {
  let ctx;
  beforeEach(() => { ctx = freshDb(); });

  it('a DELETE through the transaction seam (the command path) revokes too', async () => {
    const v = await calibrated(ctx);
    await ingest(ctx, HOURS_AGO(2), OK_FRAME());
    await wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: true, calibrationSyncVersion: v, now: NOW }));
    await ctx.db.transaction((tx) => wm.deleteCalibrationInTransaction(tx, Object.assign({}, legacy, { expectedSyncVersion: v })));
    assert.equal(flag(ctx).watermark_enabled, 0);
  });

  it('deleting the calibration clears the flag in the same transaction', async () => {
    const v = await calibrated(ctx);
    await ingest(ctx, HOURS_AGO(2), OK_FRAME());
    await wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: true, calibrationSyncVersion: v, now: NOW }));
    const res = await wm.deleteCalibration(ctx.db, Object.assign({}, legacy, { expectedSyncVersion: v }));
    assert.equal(res.scheduler_revoked, true);
    assert.equal(flag(ctx).watermark_enabled, 0);
  });

  it('a failed delete (stale version) leaves the flag on', async () => {
    const v = await calibrated(ctx);
    await ingest(ctx, HOURS_AGO(2), OK_FRAME());
    await wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: true, calibrationSyncVersion: v, now: NOW }));
    await assert.rejects(wm.deleteCalibration(ctx.db, Object.assign({}, legacy, { expectedSyncVersion: v + 5 })));
    assert.equal(flag(ctx).watermark_enabled, 1);
  });

  it('updating the calibration keeps the flag (Review Focus 2)', async () => {
    const v = await calibrated(ctx);
    await ingest(ctx, HOURS_AGO(2), OK_FRAME());
    await wm.setWatermarkEnabled(ctx.db, Object.assign({}, legacy, { enabled: true, calibrationSyncVersion: v, now: NOW }));
    await wm.saveCalibration(ctx.db, Object.assign({}, legacy, { body: Object.assign({}, CAL, { series_fwd_1_ohm: 131, expected_sync_version: v }) }));
    assert.equal(flag(ctx).watermark_enabled, 1);
  });

  it('a first-calibration backfill bumps sync_version on the rows it converts only', async () => {
    await ingest(ctx, HOURS_AGO(3), OK_FRAME());
    await ingest(ctx, HOURS_AGO(2), OPEN_FRAME());
    await calibrated(ctx);
    const rows = ctx.native.prepare('SELECT ch1_status, sync_version FROM watermark_readings ORDER BY id').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ ch1_status: 'ok', sync_version: 1 }, { ch1_status: 'open', sync_version: 0 }]);
  });
});
```

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/enable.test.js`
Expected: FAIL (`wm.setWatermarkEnabled is not a function`).

- [ ] **Step 2: Write `enable.js`:**

```js
'use strict';

// WATERMARK scheduler admission (spec section 8, decisions D1 and D7, plan
// OD-1/OD-2). writeWatermarkEnabled is the only writer of watermark_enabled = 1;
// scripts/verify-watermark-chameleon-exclusion.js holds that line.

const calibration = require('./calibration');

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const RECENT_WINDOW_MS = 24 * 3600e3;
const REASON_ORDER = ['device_not_found', 'not_lsn50', 'calibration_missing', 'calibration_changed',
  'chameleon_enabled', 'no_recent_valid_reading'];

function parseEnabled(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw calibration.httpError(400, 'invalid_enabled', 'enabled must be a boolean');
}

function parseCalibrationVersion(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1) {
    throw calibration.httpError(400, 'invalid_calibration_sync_version', 'calibration_sync_version must be a positive integer');
  }
  return n;
}

async function readWatermarkConfig(db, deveui, { now = Date.now(), calibrationSyncVersion = null } = {}) {
  const device = await db.get(
    'SELECT deveui, type_id, COALESCE(chameleon_enabled, 0) AS chameleon_enabled, ' +
      'COALESCE(watermark_enabled, 0) AS watermark_enabled, COALESCE(sync_version, 0) AS sync_version ' +
      'FROM devices WHERE UPPER(deveui) = ? AND deleted_at IS NULL',
    [deveui]
  );
  if (!device) {
    return { device: null, watermark_enabled: 0, device_sync_version: null, calibration_sync_version: null,
      last_valid_reading_at: null, blocked_by: ['device_not_found'] };
  }
  const reasons = new Set();
  if (device.type_id !== 'DRAGINO_LSN50') reasons.add('not_lsn50');
  const cal = await db.get(
    'SELECT sync_version FROM watermark_calibrations WHERE deveui = ? AND deleted_at IS NULL', [device.deveui]);
  if (!cal) reasons.add('calibration_missing');
  else if (calibrationSyncVersion !== null && calibrationSyncVersion !== cal.sync_version) reasons.add('calibration_changed');
  if (device.chameleon_enabled === 1) reasons.add('chameleon_enabled');
  const since = new Date(now - RECENT_WINDOW_MS).toISOString();
  // A valid reading proves the calibration being accepted produces kPa, so it
  // must have been converted under that calibration (OD-1a).
  const recent = cal ? await db.get(
    "SELECT recorded_at FROM watermark_readings WHERE deveui = ? AND frame_status = 'accepted' " +
      'AND recorded_at >= ? AND calibration_sync_version = ? ' +
      "AND (ch1_status IN ('ok', 'saturated') OR ch2_status IN ('ok', 'saturated')) " +
      'ORDER BY recorded_at DESC, id DESC LIMIT 1',
    [device.deveui, since, cal.sync_version]
  ) : null;
  if (!recent) reasons.add('no_recent_valid_reading');
  return {
    device,
    watermark_enabled: device.watermark_enabled,
    device_sync_version: device.sync_version,
    calibration_sync_version: cal ? cal.sync_version : null,
    last_valid_reading_at: recent ? recent.recorded_at : null,
    blocked_by: REASON_ORDER.filter((r) => reasons.has(r)),
  };
}

// Runs inside the caller's transaction (HTTP writer or command applier).
async function writeWatermarkEnabled(tx, deveui, { enabled, calibrationSyncVersion = null, now = Date.now() }) {
  const state = await readWatermarkConfig(tx, deveui, { now, calibrationSyncVersion: enabled ? calibrationSyncVersion : null });
  if (!state.device) throw calibration.httpError(404, 'device_not_found', 'Device not found');
  if (enabled && state.blocked_by.length) {
    throw calibration.httpError(409, 'watermark_precondition_failed', 'WATERMARK irrigation control cannot be enabled',
      { reasons: state.blocked_by });
  }
  const target = enabled ? 1 : 0;
  if (state.watermark_enabled === target) {
    return { deveui: state.device.deveui, watermark_enabled: target, sync_version: state.device_sync_version, changed: false };
  }
  await tx.run(
    'UPDATE devices SET watermark_enabled = ?, sync_version = COALESCE(sync_version, 0) + 1, updated_at = ' + NOW_SQL +
      ' WHERE deveui = ? AND deleted_at IS NULL',
    [target, state.device.deveui]
  );
  return { deveui: state.device.deveui, watermark_enabled: target, sync_version: state.device_sync_version + 1, changed: true };
}

async function getWatermarkConfig(db, { deveui, userId, scoped, now }) {
  const key = await calibration.assertAccessibleLsn50(db, calibration.normalizeDeveui(deveui), { userId, scoped });
  const state = await readWatermarkConfig(db, key, { now });
  return {
    deveui: key,
    watermark_enabled: state.watermark_enabled,
    device_sync_version: state.device_sync_version,
    calibration_sync_version: state.calibration_sync_version,
    last_valid_reading_at: state.last_valid_reading_at,
    blocked_by: state.blocked_by,
  };
}

async function setWatermarkEnabled(db, { deveui, userId, scoped, enabled, calibrationSyncVersion, now }) {
  const key = calibration.normalizeDeveui(deveui);
  const on = parseEnabled(enabled);
  const version = on ? parseCalibrationVersion(calibrationSyncVersion) : null;
  return db.transaction(async (tx) => {
    const stored = await calibration.assertAccessibleLsn50(tx, key, { userId, scoped });
    return writeWatermarkEnabled(tx, stored, { enabled: on, calibrationSyncVersion: version, now });
  });
}

module.exports = {
  REASON_ORDER,
  parseEnabled,
  parseCalibrationVersion,
  readWatermarkConfig,
  writeWatermarkEnabled,
  getWatermarkConfig,
  setWatermarkEnabled,
};
```

Make `calibration.httpError` accept a fourth `extra` argument (it already does) and add `httpError`, `normalizeDeveui` and `assertAccessibleLsn50` to `calibration.js`'s `module.exports`. In `index.js` add `const enable = require('./enable');` and include it in the `Object.assign`.

- [ ] **Step 3: Revocation in `deleteCalibrationInTransaction`.** After the tombstone `UPDATE` (phase 2 moved it into this seam; `deleteCalibration` only wraps it in `db.transaction`):

```js
    // Spec section 8: deleting a calibration revokes scheduler admission in the
    // same transaction. Updating a calibration does not (the person entering the
    // values is the one accepting them).
    const device = await tx.get('SELECT COALESCE(watermark_enabled, 0) AS watermark_enabled FROM devices WHERE deveui = ?', [key]);
    const revoked = Boolean(device && device.watermark_enabled === 1);
    if (revoked) {
      await tx.run(
        'UPDATE devices SET watermark_enabled = 0, sync_version = COALESCE(sync_version, 0) + 1, updated_at = ' + NOW_SQL +
          ' WHERE deveui = ?',
        [key]
      );
    }
    return { deveui: key, sync_version: current.sync_version + 1, calibration: null, watermark_enabled: 0, scheduler_revoked: revoked };
```

- [ ] **Step 4: Version the backfill.** In `backfillBatch` (phase 1, on main as `ca08dcc13`), the `UPDATE watermark_readings SET …` statement gains `, sync_version = sync_version + 1`. The loop updates a row once per `calibration_required` channel, so bump only in the first channel's statement for that row, or restructure to one `UPDATE` per row; the Step 1 test pins `sync_version: 1`, not 2. Add a case with more than 500 waiting readings (the batch size) and assert every converted row has `sync_version: 1` after `saveCalibration` returns, so rows converted in `backfillRemaining`'s later transactions are versioned too.

- [ ] **Step 5: Run the helper tests.**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/enable.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/store.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/conversion.test.js
```
Expected: all pass.

- [ ] **Step 6: Deploy coverage and mirror.** Add the `fetch_required "osi-watermark-helper enable.js"` block (and `test-fixtures.js` is test-only: not fetched) to `deploy.sh` after `ingest.js`. Copy every changed helper file to the bcm2709 tree.

```bash
bash -c 'for f in enable.js enable.test.js test-fixtures.js calibration.js index.js store.test.js; do cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/$f conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-watermark-helper/$f; done'
node scripts/verify-module-file-deploy-coverage.js && node scripts/verify-helper-registration.js && node scripts/verify-profile-parity.js
```
Expected: all exit 0.

- [ ] **Step 7: Commit.**

```bash
git add -A conf deploy.sh .github
git commit -m "feat(edge): WATERMARK enable writer with section 8 preconditions; delete revokes; backfill bumps the row version"
```

---

### Task E5: Edge route, Chameleon refusal, exclusion verifier

**Files:**
- Modify: both `flows.json` profiles. New nodes `watermark-config-get-http` (GET `/api/devices/:deveui/watermark/config`), `watermark-config-put-http` (PUT, same URL), handler `watermark-config-fn`; `scoped-device-config-guard` (`routeTable` entry index 27, `outputs` 29, `wires`); `put-chameleon-enabled-auth-fn` (D7 refusal)
- Create: `scripts/test-watermark-config-routes.js`, `scripts/verify-watermark-chameleon-exclusion.js`
- Modify: `scripts/test-scoped-access-writes.js` (`DEVICE_CONFIG_ROUTES`; the IB1 error-output index `wires[27]` → `wires[28]`), `scripts/verify-sync-flow.js` (`requiredHttpRoutes`), `scripts/verify-flows-size-ratchet-allowances.json`, `.github/workflows/verify-sync-flow.yml`

**Interfaces:**
- Consumes: `getWatermarkConfig`, `setWatermarkEnabled` (E4).
- Produces:
  - `GET /api/devices/:deveui/watermark/config` → 200 `{ deveui, watermark_enabled, device_sync_version, calibration_sync_version, last_valid_reading_at, blocked_by }` (account-wide read in scoped mode, owner in legacy mode).
  - `PUT` same URL, body `{ enabled, calibration_sync_version }` → 200 `{ deveui, watermark_enabled, sync_version, changed }`; 409 `{ code: 'watermark_precondition_failed', reasons: [...] }`; 400 for a bad body; 405 for any method other than GET/PUT.
  - `PUT /api/devices/:deveui/chameleon` with `enabled: 1` on a device with `watermark_enabled = 1` → 409 `{ code: 'watermark_enabled' }`, nothing written.

- [ ] **Step 1: Write the route test** `scripts/test-watermark-config-routes.js` by copying `scripts/test-watermark-calibration-routes.js` (same harness, fixture users A/B/V/R, `ENV_OFF` / `ENV_SCOPED`, the chain walker that follows real `wires`). Replace the routes with `/watermark/config` and the cases with:
  - legacy owner: GET before calibration lists `calibration_missing` and `no_recent_valid_reading`; PUT enable → 409 with those reasons; after saving a calibration and ingesting an `ok` frame through the helper, PUT `{ enabled: true, calibration_sync_version: <v> }` → 200 and the device row has `watermark_enabled = 1`.
  - PUT with a stale `calibration_sync_version` → 409 `calibration_changed`, flag unchanged.
  - legacy non-owner B → 404, flag unchanged; viewer V in scoped mode → 403 from the guard; assigned researcher B in scoped mode → 200 (same access as calibration writes).
  - scoped PUT injected straight into `watermark-config-fn` without `actor_user_uuid` → 401 without a bearer, 403 with one.
  - HEAD and DELETE → 405, flag unchanged, in both modes.
  - Chameleon: with `watermark_enabled = 1`, `PUT /chameleon {enabled: true}` → 409 `watermark_enabled`, `chameleon_enabled` stays 0; `{enabled: false}` → 200.

Run: `node scripts/test-watermark-config-routes.js`
Expected: FAIL (route nodes missing).

- [ ] **Step 2: Write the exclusion verifier** `scripts/verify-watermark-chameleon-exclusion.js`:

```js
#!/usr/bin/env node
'use strict';

// D7 (spec 2026-09-25): Chameleon and WATERMARK scheduler admission never both
// on. Every place that writes devices.chameleon_enabled or
// devices.watermark_enabled must be a known writer carrying its guard. A new,
// unlisted writer fails here, so it cannot land without a guard and a review.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FLOWS = ['conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'];
const HELPERS = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red';

// writer id -> substrings its source must contain
const KNOWN_WRITERS = {
  'flows:put-chameleon-enabled-auth-fn': ['COALESCE(watermark_enabled, 0) = 0'],
  'helper:osi-watermark-helper/enable.js': ['readWatermarkConfig(tx', "'chameleon_enabled'"],
  'helper:osi-watermark-helper/calibration.js': ['UPDATE devices SET watermark_enabled = 0'],
  // Add the D6 SET_CHAMELEON_CONFIG applier here when it lands (plan A9), with
  // the guard substring it uses.
};

const WRITE = /UPDATE\s+devices\s+SET[\s\S]{0,400}?\b(chameleon_enabled|watermark_enabled)\s*=|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+devices\s*\([^)]*\b(chameleon_enabled|watermark_enabled)\b/i;

function sources() {
  const out = [];
  for (const rel of FLOWS) {
    for (const node of JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
      if (typeof node.func === 'string') out.push({ id: 'flows:' + node.id, text: node.func, where: rel });
    }
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js') || entry.name === 'test-fixtures.js') continue;
      out.push({ id: 'helper:' + path.relative(path.join(ROOT, HELPERS), full), text: fs.readFileSync(full, 'utf8'), where: full });
    }
  };
  walk(path.join(ROOT, HELPERS));
  return out;
}

const problems = [];
const seen = new Set();
for (const src of sources()) {
  if (!WRITE.test(src.text)) continue;
  seen.add(src.id);
  const guards = KNOWN_WRITERS[src.id];
  if (!guards) { problems.push(`${src.id} (${src.where}) writes a D7 flag but is not a known guarded writer`); continue; }
  for (const g of guards) if (!src.text.includes(g)) problems.push(`${src.id} lost its guard: missing ${JSON.stringify(g)}`);
}
for (const id of Object.keys(KNOWN_WRITERS)) if (!seen.has(id)) problems.push(`known writer ${id} no longer writes a D7 flag; remove it from KNOWN_WRITERS`);
if (problems.length) {
  console.error('verify-watermark-chameleon-exclusion: FAIL');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`verify-watermark-chameleon-exclusion: OK (${seen.size} guarded writers)`);
```

`sync-init-fn` does not match `WRITE` (its DDL is `ADD COLUMN`, not `SET` or `INSERT INTO devices (…)`); if the regex catches its `devices_new` copy, exclude exactly that node id with a comment saying the boot rebuild copies values and cannot flip one.

Run: `node scripts/verify-watermark-chameleon-exclusion.js`
Expected: FAIL, `flows:put-chameleon-enabled-auth-fn lost its guard`.

- [ ] **Step 3: Mutate the flows** (one Node script in the scratchpad, roundtrip-guarded, both profiles):
  - `put-chameleon-enabled-auth-fn`: replace the `const changes = await run(...)` line and the `if (!changes)` line with:

```js
  const get = (sql) => new Promise((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row)));
  // D7: Chameleon cannot be enabled while WATERMARK irrigation control is on.
  const guard = enabled === 1 ? ' AND COALESCE(watermark_enabled, 0) = 0' : '';
  const changes = await run('UPDATE devices SET chameleon_enabled = ' + enabled + ", updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), sync_version = COALESCE(sync_version, 0) + 1 WHERE deveui = " + s(deveui) + ' AND user_id = ' + auth.userId + " AND type_id = 'DRAGINO_LSN50' AND deleted_at IS NULL" + guard);
  if (!changes && enabled === 1) {
    const blocked = await get('SELECT 1 AS b FROM devices WHERE deveui = ' + s(deveui) + ' AND user_id = ' + auth.userId + " AND type_id = 'DRAGINO_LSN50' AND deleted_at IS NULL AND COALESCE(watermark_enabled, 0) = 1");
    if (blocked) { await close(); return respond(409, { message: 'Turn off WATERMARK irrigation control first', code: 'watermark_enabled' }); }
  }
  await close();
  if (!changes) return respond(404, { message: 'Device not found' });
```
  (the original `await close();` line before `if (!changes)` is replaced by the one above).
  - `scoped-device-config-guard`: append `{"method":"PUT","suffix":"/watermark/config","index":27}` to `routeTable`; set `outputs` to 29; insert `["watermark-config-fn"]` into `wires` at index 27 so the error output `["device-response"]` moves to index 28.
  - New nodes, in the guard's tab (`z` copied from `watermark-cal-put-http`), with fresh 16-hex ids only if the slug form clashes (the slugs below are new):
    - `watermark-config-get-http`: `http in`, `url: "/api/devices/:deveui/watermark/config"`, `method: "get"`, wires `[["watermark-config-fn"]]`.
    - `watermark-config-put-http`: `http in`, same URL, `method: "put"`, wires `[["scoped-device-config-guard"]]`.
    - `watermark-config-fn`: function, `libs` identical to `watermark-cal-fn`'s (`crypto`, `osiDb` → `osi-db-helper`, `osiLib` → `osi-lib`), `outputs: 1`, wires `[["device-response"]]`. Its `func` is `watermark-cal-fn`'s text with three changes: `sourceId` strings become `'watermark-config-fn'`; the method whitelist is `GET` and `PUT` only; and the dispatch block becomes:

```js
  const access = { deveui: msg.req.params.deveui, userId: auth ? auth.userId : null, scoped: scopedOn };
  const wm = helperRes.value;
  const body = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
  const result = method === 'GET'
    ? await wm.getWatermarkConfig(db, access)
    : await wm.setWatermarkEnabled(db, Object.assign(access, { enabled: body.enabled, calibrationSyncVersion: body.calibration_sync_version }));
```
    and the error body adds `reasons: e.reasons || null`.

  Diff the new node's auth prelude against `watermark-cal-fn` after the edit: only the `sourceId` strings may differ.

- [ ] **Step 4: Update the pins.** `scripts/test-scoped-access-writes.js`: append `['PUT', '/watermark/config'],` to `DEVICE_CONFIG_ROUTES`; change the IB1 error-output lookup from `guard.wires[27]` to `guard.wires[28]` (the error output moved). `scripts/verify-sync-flow.js`: add `'/api/devices/:deveui/watermark/config'` to `requiredHttpRoutes`. Ratchet: a `new_node_ceilings` entry for `watermark-config-fn` at its measured size, and per-profile `node_allowances` for the guard and `put-chameleon-enabled-auth-fn`, each with a reason naming this task. `.github/workflows/verify-sync-flow.yml`: run `test-watermark-config-routes.js` and `verify-watermark-chameleon-exclusion.js`.

- [ ] **Step 5: Run the gates.**

```bash
node scripts/test-watermark-config-routes.js
node scripts/verify-watermark-chameleon-exclusion.js
node scripts/test-watermark-calibration-routes.js
node --test scripts/test-scoped-access-writes.js && node scripts/verify-scoped-access.js
node scripts/verify-auth-flag-off-hermetic.js && node --test scripts/verify-auth-flag-off-hermetic.test.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-flows-output-arity.js
node scripts/verify-no-new-silent-catch.js && node scripts/flows-bare-require-scan.js && node scripts/test-flows-wiring.js
node scripts/verify-sync-flow.js && node scripts/verify-profile-parity.js
```
Expected: all exit 0. (`verify-scoped-access.test.js` has three subtests red on `origin/main` since before phase 1; do not count them, and do not add new ones.)

- [ ] **Step 6: Commit.**

```bash
git add -A conf scripts .github
git commit -m "feat(api): WATERMARK irrigation control route; Chameleon enable refused while it is on; D7 writer verifier"
```

---

### Task E6: Command applier, registry, capability

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.js` and `commands.test.js` (phase 2, R4), bcm2709 copies
- Modify: both `flows.json` profiles: `cmd-type-registry` and `reject-indefinite-open`'s `COMMAND_TYPES_FALLBACK` (R5); `al-link-build-req`, `sync-bootstrap-build`, `sync-force-build` (`syncCapabilities`, R6); `watermark-calibration-command-apply-fn` only if it filters on a hard-coded type list rather than `WATERMARK_COMMAND_TYPES`; the D6 `SET_CHAMELEON_CONFIG` applier (A9)
- Modify: `scripts/fixtures/sync-contract-staging.json` (remove `SET_WATERMARK_CONFIG` from `commands.edgeDeferred`), `scripts/test-entity-name-command-path.js` (capability regex, ~line 545), `scripts/test-journal-bootstrap.js` (`EXPECTED_CAPABILITIES`), phase 2's `scripts/test-watermark-calibration-command-path.js` (one end-to-end case), `scripts/verify-watermark-chameleon-exclusion.js` (`KNOWN_WRITERS` for the D6 applier), `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces:**
- Consumes: `writeWatermarkEnabled(tx, deveui, { enabled, calibrationSyncVersion, now })` and `REASON_ORDER` (E4); phase 2's `parse`-time envelope checks, `authorize(tx, parsed, gateway, runtime)`, `queueAck`, the `applied_commands` replay check (R4).
- Produces: `applyWatermarkCalibrationCommand` also handles `SET_WATERMARK_CONFIG` (`WATERMARK_COMMAND_TYPES` gains it, so the flow node picks it up). Acks:
  - applied → `result: 'APPLIED'`, `appliedSyncVersion` = the device `sync_version` after the write (unchanged if the flag already had the requested value);
  - `calibration_changed` among the blockers → `result: 'CONFLICT'`, `reason: 'stale_sync_version'`, `appliedSyncVersion` = the live calibration version (R7; phase 2's stale convention);
  - any other blocker → `REJECTED_PERMANENT` with `reason` = the first blocker in `REASON_ORDER` (`calibration_missing`, `chameleon_enabled`, `no_recent_valid_reading`, …);
  - a bad payload → `REJECTED_PERMANENT malformed_command`; actor, device, gateway and scope refusals exactly as phase 2 (`actor_missing_or_disabled`, `device_not_found`, `gateway_mismatch`, `forbidden`).

- [ ] **Step 1: Write the failing tests.** Append to phase 2's `commands.test.js` (its `fresh`, `runtime`, `envelope`, `ACTOR`, `GATEWAY`, `DEVEUI` helpers; `fresh()` must now also apply `0063`):

```js
describe('SET_WATERMARK_CONFIG (phase 3)', () => {
  let ctx;
  beforeEach(() => { ctx = fresh(); });

  const NOW = Date.now();
  const cfg = (enabled, calibrationSyncVersion) => Object.assign({
    command_type: 'SET_WATERMARK_CONFIG',
    command_id: '6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b',
    actor_user_uuid: ACTOR,
    requested_at: '2026-10-02T06:00:00.000Z',
    device_eui: DEVEUI,
    gateway_device_eui: GATEWAY,
    enabled,
  }, calibrationSyncVersion === undefined ? {} : { calibration_sync_version: calibrationSyncVersion });
  const flag = () => ctx.native.prepare('SELECT watermark_enabled FROM devices WHERE deveui = ?').get(DEVEUI).watermark_enabled;

  async function ready() {
    const v = (await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: 1, scoped: false,
      body: Object.assign({ expected_sync_version: 0 }, CAL) })).sync_version;
    await wm.ingestProfile3(ctx.db, { deveui: DEVEUI, recordedAt: new Date(NOW - 3600e3).toISOString(),
      payloadB64: frameB64([800, 3291], [71, 4058]), fCnt: 1 }, deps);
    return v;
  }

  it('applies an enable that meets every precondition', async () => {
    const v = await ready();
    const res = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(301, cfg(true, v)), runtime);
    assert.equal(res.ack.result, 'APPLIED');
    assert.equal(res.ack.effectKey, null);
    assert.equal(flag(), 1);
  });

  it('acks CONFLICT stale_sync_version for a stale calibration version (Review Focus 3)', async () => {
    const v = await ready();
    const res = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(302, cfg(true, v + 1)), runtime);
    assert.equal(res.ack.result, 'CONFLICT');
    assert.equal(res.ack.reason, 'stale_sync_version');
    assert.equal(res.ack.appliedSyncVersion, v);
    assert.equal(flag(), 0);
  });

  it('rejects a late enable after the calibration was deleted (Review Focus 4)', async () => {
    const v = await ready();
    await wm.deleteCalibration(ctx.db, { deveui: DEVEUI, userId: 1, scoped: false, expectedSyncVersion: v });
    const res = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(303, cfg(true, v)), runtime);
    assert.equal(res.ack.result, 'REJECTED_PERMANENT');
    assert.equal(res.ack.reason, 'calibration_missing');
    assert.equal(flag(), 0);
  });

  it('rejects with chameleon_enabled while Chameleon is on (D7)', async () => {
    const v = await ready();
    ctx.native.prepare('UPDATE devices SET chameleon_enabled = 1 WHERE deveui = ?').run(DEVEUI);
    const res = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(304, cfg(true, v)), runtime);
    assert.equal(res.ack.reason, 'chameleon_enabled');
  });

  it('rejects a malformed payload and an effect_key, writing nothing', async () => {
    for (const [i, payload] of [cfg('yes', 1), cfg(true), Object.assign(cfg(false), { effect_key: 'watermark_config:x' })].entries()) {
      const res = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(310 + i, payload), runtime);
      assert.equal(res.ack.result, 'REJECTED_PERMANENT');
      assert.equal(res.ack.reason, 'malformed_command');
    }
    assert.equal(flag(), 0);
  });

  it('applies a disable with no preconditions, and a replay returns the stored ack without a second write', async () => {
    ctx.native.prepare('UPDATE devices SET watermark_enabled = 1, chameleon_enabled = 1 WHERE deveui = ?').run(DEVEUI);
    const first = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(320, cfg(false)), runtime);
    assert.equal(first.ack.result, 'APPLIED');
    const version = ctx.native.prepare('SELECT sync_version FROM devices WHERE deveui = ?').get(DEVEUI).sync_version;
    const replay = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(320, cfg(false)), runtime);
    assert.deepEqual(replay.ack, first.ack);
    assert.equal(ctx.native.prepare('SELECT sync_version FROM devices WHERE deveui = ?').get(DEVEUI).sync_version, version);
  });

  it('refuses a non-owner in legacy mode like the calibration commands', async () => {
    const v = await ready();
    const res = await wm.applyWatermarkCalibrationCommand(ctx.db,
      envelope(330, Object.assign(cfg(true, v), { actor_user_uuid: OTHER })), runtime);
    assert.equal(res.ack.reason, 'forbidden');
    assert.equal(flag(), 0);
  });
});
```

`CAL`, `frameB64` and `deps` come from E4's `test-fixtures.js`; require it at the top of `commands.test.js`. `OTHER` is phase 2's second user.

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.test.js`
Expected: the new cases FAIL (`handled: false` for the unknown type).

- [ ] **Step 2: Extend `commands.js`.** Four edits to phase 2's module:

```js
const enable = require('./enable');

// TYPES maps a type to its effect-key prefix. SET_WATERMARK_CONFIG has none
// (R7): a flag has no physical effect, and a constant key would make a second
// enable look like a replay of the first (the osi-entity-name rule).
const TYPES = {
  SET_WATERMARK_CALIBRATION: 'watermark_calibration',
  DELETE_WATERMARK_CALIBRATION: 'watermark_calibration_delete',
  SET_WATERMARK_CONFIG: null,
};
```

In `parse`, replace the `base_sync_version` and `effect_key` checks with a branch, keeping every check before them (command id, actor, requested_at, device EUI) and the gateway check after them:

```js
  let base = null;
  let config = null;
  if (type === 'SET_WATERMARK_CONFIG') {
    if (payload.effect_key != null) throw reject('malformed_command', 'SET_WATERMARK_CONFIG carries no effect_key');
    if (typeof payload.enabled !== 'boolean') throw reject('malformed_command', 'enabled must be a boolean');
    let calibrationSyncVersion = null;
    if (payload.enabled) {
      try { calibrationSyncVersion = enable.parseCalibrationVersion(payload.calibration_sync_version); }
      catch (e) { throw reject('malformed_command', e.message); }
    }
    config = { enabled: payload.enabled, calibrationSyncVersion };
  } else {
    base = payload.base_sync_version;
    if (!Number.isSafeInteger(base) || base < 0) throw reject('malformed_command', 'base_sync_version must be a non-negative integer');
    if (String(payload.effect_key || '') !== TYPES[type] + ':' + deveui + ':' + base) throw reject('malformed_command', 'effect_key does not bind this device and base version');
  }
```

and return `{ actor, deveui, base, values, config, effectKey: payload.effect_key == null ? null : payload.effect_key }`.

In the transaction, after `authorize`, add the branch before the calibration writer branches:

```js
        if (type === 'SET_WATERMARK_CONFIG') {
          try {
            const written = await enable.writeWatermarkEnabled(tx, parsed.deveui, {
              enabled: parsed.config.enabled, calibrationSyncVersion: parsed.config.calibrationSyncVersion });
            appliedSyncVersion = written.sync_version;
          } catch (error) {
            if (!error || error.code !== 'watermark_precondition_failed') throw error;
            if (error.reasons.includes('calibration_changed')) {
              const live = await tx.get('SELECT sync_version FROM watermark_calibrations WHERE deveui = ? AND deleted_at IS NULL', [parsed.deveui]);
              const conflict = rejection('CONFLICT', 'stale_sync_version', error.message);
              conflict.currentSyncVersion = live ? live.sync_version : null;
              throw conflict;
            }
            throw reject(error.reasons[0], error.message);
          }
        } else if (type === 'SET_WATERMARK_CALIBRATION') {
```

(the existing `if (type === 'SET_WATERMARK_CALIBRATION') { … } else { … }` becomes the `else if` / `else` of this chain). `authorize` already refuses a non-owner in legacy mode and checks scoped access, so the flag follows the same rules as a calibration command. `module.exports` is unchanged: `WATERMARK_COMMAND_TYPES` now lists three types.

- [ ] **Step 3: Registry, capability, D6 guard** (one roundtrip-guarded flows script, both profiles):
  - In `cmd-type-registry` and in `reject-indefinite-open`'s `COMMAND_TYPES_FALLBACK`, after phase 2's `DELETE_WATERMARK_CALIBRATION` line: `    SET_WATERMARK_CONFIG:         { dispatch: 'watermark_calibration_apply', actuator: false,   requires_duration: false  },`. If `write-strega-expectation` also carries a copy of the table (it does on main at `ca08dcc13`), edit it only if phase 2 did.
  - In `al-link-build-req`, `sync-bootstrap-build`, `sync-force-build`: replace `'watermark_v1'];` with `'watermark_v1', 'watermark_scheduler_v1'];`, asserting exactly one match per node. Update the capability regex in `scripts/test-entity-name-command-path.js` and `EXPECTED_CAPABILITIES` in `scripts/test-journal-bootstrap.js` (and its `slice(0, 6)` → `slice(0, 7)`).
  - D6 applier (A9): add `AND COALESCE(watermark_enabled, 0) = 0` to its `chameleon_enabled = 1` write and turn zero changes on a WATERMARK-enabled device into a `REJECTED_PERMANENT` ack with reason `watermark_enabled`; add it to `KNOWN_WRITERS` in `scripts/verify-watermark-chameleon-exclusion.js` with that guard string. If D6 has not landed, record that in the task report and leave `KNOWN_WRITERS` as is.
  - `scripts/fixtures/sync-contract-staging.json`: remove `SET_WATERMARK_CONFIG` from `commands.edgeDeferred` (the registry now carries it); keep it in `cloudDeferred` until E11.
  - Add one end-to-end case to phase 2's `scripts/test-watermark-calibration-command-path.js`: a `SET_WATERMARK_CONFIG` pending command travels the real chain to `watermark-calibration-command-apply-fn` and produces an `APPLIED` ack on the `9d5e3035c3d069c4` output.
  - Ratchet allowances per profile for every grown node, each with this task's reason.

- [ ] **Step 4: Run the gates.**

```bash
for t in commands enable store conversion; do node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/$t.test.js || exit 1; done
node scripts/test-watermark-calibration-command-path.js && node scripts/test-entity-name-command-path.js && node scripts/test-journal-bootstrap.js
node scripts/verify-sync-contract.js && node scripts/test-contract-schemas.js
OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server-worktree>/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node scripts/verify-sync-op-parity.js
node scripts/verify-watermark-chameleon-exclusion.js && node scripts/verify-auth-flag-off-hermetic.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-flows-fn-parse.js && node scripts/test-flows-wiring.js
node scripts/verify-profile-parity.js && node scripts/verify-sync-flow.js
```
Expected: all exit 0.

- [ ] **Step 5: Commit.**

```bash
git add -A conf scripts
git commit -m "feat(sync): apply SET_WATERMARK_CONFIG with apply-time preconditions; advertise watermark_scheduler_v1"
```

---

### Task E7: Scheduler admission (replaces the phase 1 interlock)

**Files:**
- Modify: both `flows.json` profiles, node `d0b2b1c1a937e16d` ("Build mean query (last hour, all datapoints)")
- Modify: `scripts/test-watermark-ingest-flow.js` (replace cases (f) and (g)), `scripts/verify-flows-size-ratchet-allowances.json` (replace the phase 1 entry for this node with the new measured delta)

**Interfaces:**
- Consumes: `devices.watermark_enabled` (E2), `watermark_calibrations.sync_version` and `deleted_at` (phase 1), `watermark_readings.calibration_sync_version` and `device_data_id` (phase 1).
- Produces: for `SWT_1`, `SWT_2`, `SWT_3`, `SWT_AVG` and the `SWT_WM*` aliases, the SWT query counts a `device_data` row when its device is KIWI, TEKTELIC_CLOVER or DRAGINO_SDI12 (unchanged); or an LSN50 with `chameleon_enabled = 1` and the row is **not** a WATERMARK observation (phase 1 interlock, kept for this branch); or an LSN50 with `watermark_enabled = 1` and the row **is** a WATERMARK observation converted under the live calibration version. `DENDRO` is unchanged.

The query below was run while writing this plan against `seed-blank.sql` + the E2 migration in `node:sqlite`: neither flag → 0 points; Chameleon on → the Chameleon row only; WATERMARK on → only the row at the live calibration version (the older-version row excluded); calibration tombstoned → 0 points. `EXPLAIN QUERY PLAN` uses `idx_devices_irrigation_zone_id`, `idx_device_data_deveui_recorded_at` and `idx_watermark_readings_device_data`.

- [ ] **Step 1: Write the failing safety matrix.** In `scripts/test-watermark-ingest-flow.js`, replace the scheduler section (from `const SCHEDULER_QUERY_ID` through case (g)) with:

```js
// ------------------------------------------------------- scheduler cases --
// Phase 3 (spec section 8, plan OD-2): explicit, per-row admission.

const SCHEDULER_QUERY_ID = 'd0b2b1c1a937e16d';

// One zone, one DRAGINO_LSN50, calibration at sync_version 2, three device_data
// rows in the last hour: A (swt_1 60, WATERMARK at calibration v2), B (swt_1 50,
// WATERMARK at the older v1), C (swt_1 30, Chameleon, no WATERMARK row).
function schedulerDb({ chameleon = 0, watermark = 0, tombstone = false } = {}) {
  const native = freshDb();
  const zoneId = Number(native.prepare(
    "INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z WM', 1, 'z-wm', 'UTC', 'local')"
  ).run().lastInsertRowid);
  native.prepare('UPDATE devices SET irrigation_zone_id = ?, chameleon_enabled = ?, watermark_enabled = ? WHERE deveui = ?')
    .run(zoneId, chameleon, watermark, DEVEUI);
  native.prepare(
    'INSERT INTO watermark_calibrations (deveui, pullup_1_ohm, pulldown_1_ohm, series_fwd_1_ohm, series_rev_1_ohm, ' +
    'pullup_2_ohm, pulldown_2_ohm, series_fwd_2_ohm, series_rev_2_ohm, sync_version, deleted_at) ' +
    'VALUES (?, 41670, 41260, 130, 112, 42530, 42070, 46, 27, 2, ?)'
  ).run(DEVEUI, tombstone ? new Date().toISOString() : null);
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60e3).toISOString();
  const insertDd = native.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, ?)');
  const rowA = Number(insertDd.run(DEVEUI, at(40), 60).lastInsertRowid);
  const rowB = Number(insertDd.run(DEVEUI, at(30), 50).lastInsertRowid);
  insertDd.run(DEVEUI, at(20), 30);
  const insertWr = native.prepare(
    "INSERT INTO watermark_readings (deveui, recorded_at, device_data_id, payload_hex, frame_status, conversion_version, calibration_sync_version) " +
    "VALUES (?, ?, ?, 'a203', 'accepted', 'wm-lsn50-p3-v1', ?)");
  insertWr.run(DEVEUI, at(40), rowA, 2);
  insertWr.run(DEVEUI, at(30), rowB, 1);
  return { native, zoneId };
}

async function schedulerTopic(node, zone) {
  const out = await executeFunction(node, { msg: { payload: zone } });
  assert.deepEqual(out.errors, []);
  assert.ok(out.result && typeof out.result.topic === 'string', 'scheduler query node built no topic');
  return out.result.topic;
}

async function points(flags, metric = 'SWT_1') {
  const { native, zoneId } = schedulerDb(flags);
  const [row] = rows(native, await schedulerTopic(headNode(SCHEDULER_QUERY_ID), { zone_id: zoneId, trigger_metric: metric }));
  native.close();
  return { n: row.n_points, mean: row.mean_kpa };
}

const MATRIX = [
  ['S1 neither flag: nothing from this LSN50 counts', {}, { n: 0, mean: null }],
  ['S2 Chameleon on (a reflashed board, Review Focus 1): only the Chameleon row', { chameleon: 1 }, { n: 1, mean: 30 }],
  ['S3 WATERMARK on: only the WATERMARK row at the live calibration version', { watermark: 1 }, { n: 1, mean: 60 }],
  ['S4 WATERMARK on, calibration tombstoned: nothing counts', { watermark: 1, tombstone: true }, { n: 0, mean: null }],
  ['S6 both flags (writers bypassed, Review Focus 5): each row once, through its own branch', { chameleon: 1, watermark: 1 }, { n: 2, mean: 45 }],
];
for (const metric of ['SWT_1', 'SWT_AVG']) {
  for (const [name, flags, expected] of MATRIX) {
    CASES.push({
      name: '(f) scheduler ' + metric + ' ' + name,
      async run() { assert.deepEqual(await points(flags, metric), expected); },
    });
  }
}

CASES.push({
  name: '(f) scheduler S5: a KIWI device in the same zone is untouched by either flag',
  async run() {
    const { native, zoneId } = schedulerDb();
    native.prepare("INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES ('A84041A1710000AA', 'k', 'KIWI_SENSOR', 1, ?, ?, ?)")
      .run(zoneId, new Date().toISOString(), new Date().toISOString());
    native.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, 44)').run('A84041A1710000AA', new Date(Date.now() - 600e3).toISOString());
    const [row] = rows(native, await schedulerTopic(headNode(SCHEDULER_QUERY_ID), { zone_id: zoneId, trigger_metric: 'SWT_1' }));
    assert.equal(row.n_points, 1);
    assert.equal(row.mean_kpa, 44);
    native.close();
  },
});

CASES.push({
  name: '(f) scheduler S7: end to end through the helper -- enable admits, delete revokes',
  async run() {
    const native = freshDb();
    const db = realOsiDb(native);
    const zoneId = Number(native.prepare("INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z', 1, 'z-e2e', 'UTC', 'local')").run().lastInsertRowid);
    native.prepare('UPDATE devices SET irrigation_zone_id = ? WHERE deveui = ?').run(zoneId, DEVEUI);
    const access = { deveui: DEVEUI, userId: 1, scoped: false };
    const saved = await watermarkHelper.saveCalibration(db, Object.assign({}, access, { body: Object.assign({ expected_sync_version: 0 }, BENCH_CAL) }));
    await runIngest(ingestMsg(profile3Bytes(), new Date(Date.now() - 600e3).toISOString()), native);
    const count = async () => rows(native, await schedulerTopic(headNode(SCHEDULER_QUERY_ID), { zone_id: zoneId, trigger_metric: 'SWT_1' }))[0].n_points;
    assert.equal(await count(), 0, 'kPa is written (D1) but not admitted before the enable');
    await watermarkHelper.setWatermarkEnabled(db, Object.assign({}, access, { enabled: true, calibrationSyncVersion: saved.sync_version }));
    assert.equal(await count(), 1);
    await watermarkHelper.deleteCalibration(db, Object.assign({}, access, { expectedSyncVersion: saved.sync_version }));
    assert.equal(await count(), 0);
    native.close();
  },
});

CASES.push({
  name: '(g) scheduler query shape: the admission block is present for every SWT metric and absent for DENDRO',
  async run() {
    for (const metric of ['SWT_1', 'SWT_2', 'SWT_3', 'SWT_AVG', 'SWT_WM1', 'SWT_WM2', 'SWT_WM3', 'DENDRO']) {
      const topic = await schedulerTopic(headNode(SCHEDULER_QUERY_ID), { zone_id: 7, trigger_metric: metric });
      const has = (s) => topic.includes(s);
      const swt = metric !== 'DENDRO';
      assert.equal(has('COALESCE(ds.watermark_enabled,0) = 1'), swt, metric + ': WATERMARK branch');
      assert.equal(has('wr.calibration_sync_version = wc.sync_version'), swt, metric + ': live-version join');
      assert.equal(has('wc.deleted_at IS NULL'), swt, metric + ': tombstone check');
      assert.equal(has("COALESCE(ds.chameleon_enabled,0) = 1\n         AND NOT EXISTS"), swt, metric + ': Chameleon branch keeps the interlock');
    }
  },
});
```

`BENCH_CAL`, `ingestMsg` and `realOsiDb` are the names this file already uses for the calibration fixture, the ingest message builder and the facade (check the helpers section; if the calibration constant has another name, use it). S6 expects 2 points averaging 45 because row A counts through the WATERMARK branch, row C through the Chameleon branch, and row B (older calibration version) through neither.

Run: `node scripts/test-watermark-ingest-flow.js`
Expected: FAIL on S3 (0 points) and on (g).

- [ ] **Step 2: Mutate `d0b2b1c1a937e16d`** (roundtrip-guarded script, both profiles). Replace the comment block and the `msg.topic = \`…\`` SWT assignment that follows `const cutoffIso = …` with:

```js
// WATERMARK phase 3 (spec 2026-09-25 section 8): admission per row. A WATERMARK
// observation counts only for a device with watermark_enabled = 1 and only if
// it was converted under the live calibration version, so a deleted or edited
// calibration stops old rows at once. Chameleon rows keep the phase 1
// interlock: a reflashed board still flagged chameleon_enabled never feeds
// WATERMARK rows through the Chameleon branch.
msg.topic = `
  SELECT
    AVG(${expr}) AS mean_kpa,
    COUNT(${expr}) AS n_points,
    MIN(dd.recorded_at) AS min_recorded_at,
    MAX(dd.recorded_at) AS max_recorded_at

  FROM devices ds
  INNER JOIN device_data dd
    ON dd.deveui = ds.deveui

  WHERE ds.irrigation_zone_id = ${zoneId}
    AND (
      ds.type_id IN ('KIWI_SENSOR', 'TEKTELIC_CLOVER', 'DRAGINO_SDI12')
      OR (ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.chameleon_enabled,0) = 1
         AND NOT EXISTS (SELECT 1 FROM watermark_readings wr WHERE wr.device_data_id = dd.id))
      OR (ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.watermark_enabled,0) = 1
         AND EXISTS (SELECT 1 FROM watermark_readings wr
                       JOIN watermark_calibrations wc ON wc.deveui = wr.deveui AND wc.deleted_at IS NULL
                      WHERE wr.device_data_id = dd.id AND wr.frame_status = 'accepted'
                        AND wr.calibration_sync_version = wc.sync_version))
    )
    AND ${expr} IS NOT NULL
    AND dd.recorded_at >= '${cutoffIso}';
`.trim();
```

The `(g)` case matches `"COALESCE(ds.chameleon_enabled,0) = 1\n         AND NOT EXISTS"` as an exact string, so keep the line break and the nine-space indent exactly as written.

- [ ] **Step 3: Ratchet.** Replace this node's phase 1 `node_allowances` entry with the new measured per-profile delta against `origin/main` and a reason naming phase 3 admission.

- [ ] **Step 4: Run the gates.**

```bash
node scripts/test-watermark-ingest-flow.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-flows-fn-parse.js
node scripts/test-flows-wiring.js && node scripts/verify-sync-flow.js && node scripts/verify-profile-parity.js
```
Expected: all exit 0; the ingest test prints `PASS:` with the new case count.

- [ ] **Step 5: Commit.**

```bash
git add -A conf scripts
git commit -m "feat(scheduler): WATERMARK rows drive irrigation only when enabled and converted under the live calibration"
```

---

### Task E8: Bootstrap coverage, device flag in bootstrap, outbox pruning class

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/sync-rows.js`, `sync-rows.test.js`
- Modify: `…/osi-watermark-helper/index.js`; both `flows.json` profiles: `sync-bootstrap-build`, `sync-force-build` (devices `SELECT` gains `d.watermark_enabled`; payload gains `watermark_readings`), `prune-sync-outbox` (`TELEMETRY` gains `'WATERMARK_READING'`)
- Modify: `scripts/test-outbox-retention.js` (`TELEMETRY` constant), `scripts/test-watermark-sync-triggers.js` (payload parity case), `deploy.sh`, bcm2709 copies, `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces:**
- Consumes: the E2 trigger payload shape (the source of truth for keys and order).
- Leaves alone: phase 2's MQTT liveness publish in `watermark-ingest-fn` (R13, OD-4). This task adds no MQTT output.
- Produces: `toSyncPayload(row, gatewayEui)` → the exact object the trigger's `json_object` builds for that row; `bootstrapReadings(q, gatewayEui, now = Date.now())` → up to 500 payloads from the last 30 days, oldest first, where `q(sql, params)` is the node's own query helper. C3 consumes the `watermark_readings` bootstrap key.

- [ ] **Step 1: Write the failing tests.**
  - `sync-rows.test.js`: seed a DB (E4 fixtures), insert 3 readings at 40, 20 and 1 days ago; `bootstrapReadings` returns the two within 30 days, oldest first; with 600 recent rows it returns exactly 500, the newest 500 in ascending order.
  - In `scripts/test-watermark-sync-triggers.js`, a case "toSyncPayload equals the trigger payload": insert a fully populated row while linked, read the outbox payload, read the row back with `SELECT *`, and `assert.deepEqual(helper.toSyncPayload(row, GW), JSON.parse(outboxPayload))`.
  - In `scripts/test-outbox-retention.js`, add `'WATERMARK_READING'` to `TELEMETRY`; its existing drop-order assertions then cover the new type.

Run the three; expected FAIL.

- [ ] **Step 2: Write `sync-rows.js`:**

```js
'use strict';

// Bootstrap and force-sync rows for watermark_readings, in exactly the shape
// the 0063 outbox trigger emits (keep the two in step: test-watermark-sync-triggers.js
// compares them). Plan OD-4: last 30 days, at most 500 rows, like chameleon_readings.

const BOOTSTRAP_DAYS = 30;
const BOOTSTRAP_LIMIT = 500;
const CHANNEL_KEYS = ['flags', 'fwd_early', 'fwd', 'rev_early', 'rev', 'r_fwd', 'r_rev', 'r_solved', 'offset_mv',
  'r_upper_bound', 'kpa_upper_bound', 'status', 'kpa'];

const v = (x) => (x === undefined ? null : x);

function toSyncPayload(row, gatewayEui) {
  const channel = (n) => Object.fromEntries(CHANNEL_KEYS.map((k) => [k, v(row['ch' + n + '_' + k])]));
  return {
    contract_version: 1,
    device_eui: row.deveui,
    edge_reading_id: row.id,
    device_data_id: v(row.device_data_id),
    recorded_at: row.recorded_at,
    f_cnt: v(row.f_cnt),
    frame_status: row.frame_status,
    reject_reason: v(row.reject_reason),
    payload_hex: row.payload_hex,
    supply_mv: v(row.supply_mv),
    soil_temp_c: v(row.soil_temp_c),
    soil_temp_source: v(row.soil_temp_source),
    die_temp_c: v(row.die_temp_c),
    status_byte: v(row.status_byte),
    channels: [channel(1), channel(2)],
    calibration_sync_version: v(row.calibration_sync_version),
    conversion_version: row.conversion_version,
    sync_version: row.sync_version || 0,
    gateway_device_eui: row.gateway_device_eui || gatewayEui || null,
  };
}

async function bootstrapReadings(q, gatewayEui, now = Date.now()) {
  const since = new Date(now - BOOTSTRAP_DAYS * 86400e3).toISOString();
  const rows = await q(
    'SELECT wr.*, d.gateway_device_eui AS gateway_device_eui FROM watermark_readings wr ' +
      'LEFT JOIN devices d ON d.deveui = wr.deveui AND d.deleted_at IS NULL ' +
      'WHERE wr.recorded_at >= ? ORDER BY wr.recorded_at DESC, wr.id DESC LIMIT ' + BOOTSTRAP_LIMIT,
    [since]
  );
  return rows.slice().reverse().map((row) => toSyncPayload(row, gatewayEui));
}

module.exports = { toSyncPayload, bootstrapReadings, BOOTSTRAP_DAYS, BOOTSTRAP_LIMIT };
```

Export both from `index.js`. If the trigger test shows a key-order or null difference (`deepEqual` ignores key order; nulls must match), fix `toSyncPayload`, never the trigger.

- [ ] **Step 3: Mutate the flows** (roundtrip-guarded, both profiles):
  - `sync-bootstrap-build` and `sync-force-build`: in the devices `SELECT`, insert `d.watermark_enabled, ` after `d.chameleon_swt3_depth_cm, `. After the `const chameleonReadings = chameleonReadingsRows.slice().reverse();` line:

```js
  const watermarkLoad = osiLib.require('watermark-helper');
  let watermarkReadings = [];
  if (watermarkLoad.ok) watermarkReadings = await watermarkLoad.value.bootstrapReadings(q, identity.deviceEui);
  else node.warn('Bootstrap: WATERMARK helper unavailable, readings skipped: ' + watermarkLoad.error);
```
    and in the payload object add `watermark_readings: watermarkReadings,` directly after phase 2's `watermark_calibrations` entry (R12). Check that the node's query helper is named `q` and takes `(sql, params)`, and that `identity` is in scope at that point, in each node separately (the force node's indentation differs).
  - `prune-sync-outbox`: `const TELEMETRY = new Set([..., 'ZONE_RECOMMENDATION', 'WATERMARK_READING']);`.
  - Ratchet allowances for the three nodes.

- [ ] **Step 4: Extend the bootstrap test.** Copy the harness of `scripts/test-valve-actuation-bootstrap.js` into a case in `scripts/test-watermark-sync-triggers.js` (or a new `scripts/test-watermark-bootstrap.js` wired into CI) that executes `sync-bootstrap-build` against a seeded DB with one WATERMARK reading and a device with `watermark_enabled = 1`, and asserts `msg.payload.watermark_readings.length === 1` and `msg.payload.devices[0].watermark_enabled === 1`.

- [ ] **Step 5: Run the gates.**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/sync-rows.test.js
node scripts/test-watermark-sync-triggers.js && node --test scripts/test-outbox-retention.js
node scripts/test-valve-actuation-bootstrap.js && node scripts/test-journal-bootstrap.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-flows-fn-parse.js && node scripts/flows-bare-require-scan.js
node scripts/verify-module-file-deploy-coverage.js && node scripts/verify-sync-flow.js && node scripts/verify-profile-parity.js
```
Expected: all exit 0.

- [ ] **Step 6: Commit.**

```bash
git add -A conf scripts deploy.sh .github
git commit -m "feat(sync): bootstrap and force sync carry watermark_readings and watermark_enabled; WATERMARK_READING is droppable telemetry"
```

---

### Task E9: Edge GUI, irrigation control and D7 in the settings modal

**Files:**
- Create: `web/react-gui/src/components/farming/WatermarkSchedulerSection.tsx`, `web/react-gui/src/components/farming/__tests__/WatermarkSchedulerSection.test.tsx`
- Modify: `web/react-gui/src/components/farming/DraginoSettingsModal.tsx`, `web/react-gui/src/services/api.ts` (`lsn50API`), `web/react-gui/src/types/farming.ts` (`Device.watermark_enabled`, `WatermarkConfigState`), `web/react-gui/public/locales/en/devices.json`

**Interfaces:**
- Consumes: `GET`/`PUT /api/devices/:deveui/watermark/config` (E5); `PUT /api/devices/:deveui/chameleon` 409 `watermark_enabled` (E5).
- Produces: `lsn50API.getWatermarkConfig(deveui): Promise<WatermarkConfigState>`, `lsn50API.setWatermarkEnabled(deveui, enabled: boolean, calibrationSyncVersion: number | null)`; type `WatermarkConfigState = { deveui: string; watermark_enabled: 0 | 1; device_sync_version: number | null; calibration_sync_version: number | null; last_valid_reading_at: string | null; blocked_by: string[] }`.

- [ ] **Step 1: Write the failing component test** `WatermarkSchedulerSection.test.tsx`. It mocks `lsn50API` with `vi.mock('../../../services/api', …)` the way `DraginoTempCard.test.tsx` mocks its API calls:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WatermarkSchedulerSection } from '../WatermarkSchedulerSection';
import { lsn50API } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  lsn50API: { getWatermarkConfig: vi.fn(), setWatermarkEnabled: vi.fn() },
}));

const ready = {
  deveui: 'A84041A171000001', watermark_enabled: 0 as const, device_sync_version: 4,
  calibration_sync_version: 3, last_valid_reading_at: '2026-10-02T05:00:00.000Z', blocked_by: [] as string[],
};

describe('WatermarkSchedulerSection', () => {
  beforeEach(() => vi.mocked(lsn50API.getWatermarkConfig).mockReset());

  it('enables only after the confirming click, quoting the calibration version it showed', async () => {
    vi.mocked(lsn50API.getWatermarkConfig).mockResolvedValue(ready);
    vi.mocked(lsn50API.setWatermarkEnabled).mockResolvedValue(undefined as never);
    render(<WatermarkSchedulerSection deveui="A84041A171000001" zoneName="Orchard 3" />);
    fireEvent.click(await screen.findByRole('button', { name: /use for irrigation/i }));
    expect(lsn50API.setWatermarkEnabled).not.toHaveBeenCalled();
    expect(screen.getByText(/Orchard 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(lsn50API.setWatermarkEnabled).toHaveBeenCalledWith('A84041A171000001', true, 3));
  });

  it('lists every blocker by name and disables the button', async () => {
    vi.mocked(lsn50API.getWatermarkConfig).mockResolvedValue(
      Object.assign({}, ready, { calibration_sync_version: null, blocked_by: ['calibration_missing', 'chameleon_enabled', 'no_recent_valid_reading'] }));
    render(<WatermarkSchedulerSection deveui="A84041A171000001" zoneName={null} />);
    expect(await screen.findByText(/save a calibration/i)).toBeTruthy();
    expect(screen.getByText(/turn off chameleon/i)).toBeTruthy();
    expect(screen.getByText(/valid reading in the last 24 hours/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /use for irrigation/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the server reasons when the gateway refuses (409)', async () => {
    vi.mocked(lsn50API.getWatermarkConfig).mockResolvedValue(ready);
    vi.mocked(lsn50API.setWatermarkEnabled).mockRejectedValue({ response: { status: 409, data: { code: 'watermark_precondition_failed', reasons: ['calibration_changed'] } } });
    render(<WatermarkSchedulerSection deveui="A84041A171000001" zoneName="Z" />);
    fireEvent.click(await screen.findByRole('button', { name: /use for irrigation/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(await screen.findByText(/calibration changed/i)).toBeTruthy();
  });

  it('turns off in one click', async () => {
    vi.mocked(lsn50API.getWatermarkConfig).mockResolvedValue(Object.assign({}, ready, { watermark_enabled: 1 as const }));
    vi.mocked(lsn50API.setWatermarkEnabled).mockResolvedValue(undefined as never);
    render(<WatermarkSchedulerSection deveui="A84041A171000001" zoneName="Z" />);
    fireEvent.click(await screen.findByRole('button', { name: /stop using/i }));
    await waitFor(() => expect(lsn50API.setWatermarkEnabled).toHaveBeenCalledWith('A84041A171000001', false, null));
  });
});
```

Add a case to the existing `DraginoSettingsModal` test (or create `__tests__/DraginoSettingsModal.watermark.test.tsx`): with `device.watermark_enabled = 1`, the "Chameleon SWT" toggle is disabled and the text "Turn off WATERMARK irrigation control first" is shown.

Run: `cd web/react-gui && npm run test:unit`
Expected: FAIL (component missing).

- [ ] **Step 2: Write the section and the API.**
  - `api.ts` (`lsn50API`): `getWatermarkConfig: async (deveui) => (await api.get(\`/api/devices/${deveui}/watermark/config\`)).data`, `setWatermarkEnabled: async (deveui, enabled, calibrationSyncVersion) => { await api.put(\`/api/devices/${deveui}/watermark/config\`, { enabled, calibration_sync_version: calibrationSyncVersion }); }`.
  - `WatermarkSchedulerSection.tsx`: loads the state on mount and after every submit; renders the on/off sentence, the blockers (reason code → translated sentence: `calibration_missing` → "Save a calibration first.", `calibration_changed` → "The calibration changed since this page loaded. Check it and try again.", `chameleon_enabled` → "Turn off Chameleon SWT first.", `no_recent_valid_reading` → "Needs a valid reading in the last 24 hours under the current calibration."), the two-step enable (the confirm text names the zone and says the circuit is experimental, OD-8), a one-click disable, and a 409's `reasons` in place of the loaded blockers. Keys live under `watermark.scheduler.*` in `devices.json`; follow `WatermarkCalibrationSection.tsx` for layout tokens (`SettingsSection`, `--border`, `--card`) and focus rings.
  - `DraginoSettingsModal.tsx`: render `<WatermarkSchedulerSection deveui={device.deveui} zoneName={…} />` right after `WatermarkCalibrationSection`, whenever that section renders or `device.watermark_enabled === 1` (so the control can always be turned off). In the `SENSOR_OPTIONS` rendering, disable the `chameleon_enabled` toggle when `device.watermark_enabled === 1` and show `t('watermark.scheduler.chameleonBlocked', 'Turn off WATERMARK irrigation control first.')`; a 409 with `code === 'watermark_enabled'` from `setChameleonEnabled` shows the same text.
  - `types/farming.ts`: `watermark_enabled?: number;` on `Device` next to `chameleon_enabled`, and `WatermarkConfigState`.

- [ ] **Step 3: Run the tests.**

```bash
cd web/react-gui && npm run test:unit && npm run typecheck
```
Expected: PASS. (No build here; E11 builds once.)

- [ ] **Step 4: Commit.**

```bash
git add -A web/react-gui/src web/react-gui/public/locales/en/devices.json
git commit -m "feat(gui): WATERMARK irrigation control with named blockers and confirmation; Chameleon toggle locked while it is on"
```

---

### Task E10 (conditional): Unsettled acceptance envelope from the bench

Run this task only if the bench run's `summary.json` says `"verdict": "PASS"` and `"envelope"` is a number. If the verdict is PASS with a null envelope, record "E10 skipped, envelope null" and the `summary.json` sha256 in the execution ledger and go to E11. If the verdict is not PASS, stop: the owner decides (bench protocol §7).

**Files:**
- Modify: `…/osi-watermark-helper/conversion.js`, `…/osi-watermark-helper/conversion.test.js` (and the bcm2709 copies)
- Modify: tests that pin `'wm-lsn50-p3-v1'` as the current version (find them with `grep -rn "wm-lsn50-p3-v1" scripts conf web/react-gui/src --include=*.js --include=*.ts --include=*.tsx`); literals used only as stored DB fixture values stay

**Interfaces:**
- Consumes: `envelope` (a relative drift, e.g. `0.02`) from the bench `summary.json`.
- Produces: `CONVERSION_VERSION = 'wm-lsn50-p3-v2'`; `UNSETTLED_MAX_REL_DRIFT` exported. Stored readings keep the version that produced them; nothing is rewritten.

- [ ] **Step 1: Write the failing tests** in `conversion.test.js`, using three frames from the bench run's `readings.csv` (one unsettled with `rho` ≤ envelope, one unsettled with `rho` above it, one settled). Copy their `payload_hex` from the exported `drydown.csv` as literal goldens with the date of the run in a comment:

```js
describe('unsettled envelope (bench YYYY-MM-DD, summary.json sha256 <hash>)', () => {
  const CAL_ROW = { pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
    pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27, sync_version: 1 };
  const convert = (hex) => wm.convertFrame(wm.parseProfile3(Buffer.from(hex, 'hex')).frame, CAL_ROW);

  it('accepts an unsettled reading within the envelope', () => {
    const ch = convert('<hex of the accepted unsettled frame>').channels[0];
    assert.equal(ch.status, 'ok');
    assert.ok(ch.kpa > 0);
  });
  it('keeps an unsettled reading beyond the envelope without kPa', () => {
    const ch = convert('<hex of the rejected unsettled frame>').channels[0];
    assert.equal(ch.status, 'unsettled');
    assert.equal(ch.kpa, null);
  });
  it('records the new conversion version', () => {
    assert.equal(convert('<hex of the settled frame>').conversion_version, 'wm-lsn50-p3-v2');
  });
});
```

Replace each `<…>` with the literal from the bench files before running; the task is not startable without them, which is why it is conditional.

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/conversion.test.js`
Expected: FAIL on the first and third cases.

- [ ] **Step 2: Change `conversion.js`.** Set `CONVERSION_VERSION = 'wm-lsn50-p3-v2'`. Add after `SOURCE_DS18B20`:

```js
// Bench dry-down YYYY-MM-DD (docs/superpowers/plans/2026-09-26-watermark-dry-down-bench-protocol.md,
// summary.json sha256 <hash>): an unsettled reading whose early/late joint-solve
// resistances differ by at most this fraction still gets kPa.
var UNSETTLED_MAX_REL_DRIFT = <envelope from summary.json>;

function unsettledWithinEnvelope(probe, cal, supplyMv, rLate) {
  if (probe.fwd_early <= 0 || probe.rev_early >= ADC_FULL) return false;
  var early = resistanceFromCodes(probe.fwd_early, probe.rev_early, cal, supplyMv).r;
  return isFinite(early) && rLate > 0 && Math.abs(early - rLate) / rLate <= UNSETTLED_MAX_REL_DRIFT;
}
```

and in `convertChannel` change the unsettled line to:

```js
    if ((probe.flags & FLAG_UNSETTLED) && solved.r > SATURATED_MAX_OHM &&
        !unsettledWithinEnvelope(probe, cal, supplyMv, solved.r)) { out.status = 'unsettled'; return out; }
```

Export `UNSETTLED_MAX_REL_DRIFT`. Update the tests that pin the current version string.

- [ ] **Step 3: Run the gates.**

```bash
for t in conversion store enable commands sync-rows; do node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/$t.test.js || exit 1; done
node scripts/verify-lsn50-watermark-codec.js && node scripts/test-watermark-ingest-flow.js && node --test scripts/watermark-drydown-analysis.test.js
node scripts/test-contract-schemas.js && node scripts/verify-profile-parity.js
```
Expected: all exit 0. The contract's `conversion_version` pattern already accepts `v2`.

- [ ] **Step 4: Commit.**

```bash
git add -A conf scripts
git commit -m "feat(watermark): accept unsettled readings within the bench envelope (conversion wm-lsn50-p3-v2)"
```

---

### Task E11: Locales, docs, contract activation, full gate sweep

**Files:**
- Modify: `web/react-gui/public/locales/{de-CH,fr,it,es,pt,lg}/devices.json`, `web/react-gui/tests/watermarkLocales.test.ts` (phase 1 locale test: new keys join its sets), `docs/i18n/pending-luganda-translations.md`
- Modify: `AGENTS.md` (sync tables: the new event, command and capability; the scheduler admission rule in one sentence), `scripts/fixtures/sync-contract-staging.json` and `scripts/verify-sync-op-parity.js` (activation), `docs/superpowers/specs/2026-09-25-watermark-lsn50-design.md` (§8: note the plan decisions OD-1 to OD-6 as adopted, one line each, only if the owner approved them)

- [ ] **Step 1: Locales.** Translate the `watermark.scheduler.*` keys into `de-CH` (Swiss spelling, no "ß"), `fr`, `it`, `es`, `pt` with each locale's existing glossary term for soil water tension (phase 1 ruling); keep "WATERMARK" and "Chameleon" untranslated; copy English into `lg` and add a `## devices.json — WATERMARK irrigation control` section to `docs/i18n/pending-luganda-translations.md` in the existing format. Extend the phase 1 locale test's key collection to include `watermark.scheduler.*` (it already walks the whole `watermark` group; confirm the new keys appear in its `PENDING_HUMAN_LUGANDA` set).

Run: `cd web/react-gui && npx tsx --test tests/watermarkLocales.test.ts`
Expected: PASS.

- [ ] **Step 2: Activate the contract.** Remove `SET_WATERMARK_CONFIG` from `commands.cloudDeferred` and `WATERMARK_READING_APPENDED` from `eventOps.cloudDeferred` in `scripts/fixtures/sync-contract-staging.json`, and from `EXACT_CLOUD_DEFERRED_EVENT_OPS` / the matching command list in `scripts/verify-sync-op-parity.js`, with a comment naming the osi-server branch `feat/watermark-phase3` commits from C2 and C5.

```bash
OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server-worktree>/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node scripts/verify-sync-op-parity.js
bash -c 'for f in events.schema.json resources.schema.json commands.schema.json; do cmp docs/contracts/sync-schema/$f <osi-server-worktree>/backend/src/test/resources/sync-contract/$f || exit 1; done; echo mirror-identical'
```
Expected: exit 0, then `mirror-identical`.

- [ ] **Step 3: Docs.** In `AGENTS.md`, add `WATERMARK_READING_APPENDED` (SQL-owned, migration 0063) to the event list, `SET_WATERMARK_CONFIG` to the command list, `watermark_scheduler_v1` to the capability list, and one sentence to the scheduler section: "A WATERMARK `device_data` row reaches the scheduler only for a `DRAGINO_LSN50` with `watermark_enabled = 1`, and only if it was converted under the device's live calibration version (`d0b2b1c1a937e16d`)." Run `node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md docs/i18n/pending-luganda-translations.md`.

- [ ] **Step 4: Full edge gate sweep** from the worktree root:

```bash
for f in conversion store enable commands sync-rows; do node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/$f.test.js || exit 1; done
node --test scripts/watermark-drydown-analysis.test.js
node scripts/verify-lsn50-watermark-codec.js && node scripts/verify-lsn50-chameleon-codec.js && node scripts/verify-codec-robustness.js
node scripts/test-watermark-ingest-flow.js && node scripts/test-watermark-calibration-routes.js && node scripts/test-watermark-config-routes.js
node scripts/test-watermark-sync-triggers.js && node scripts/verify-watermark-chameleon-exclusion.js
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-seed-db-ledger.js
node scripts/verify-db-schema-consistency.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-no-stray-ddl.js
node scripts/verify-devices-rebuild-fence.js && node --test scripts/rehearse-devices-rebuild.test.js && node scripts/gen-devices-columns.js --check
node scripts/verify-helper-registration.js && node scripts/verify-module-file-deploy-coverage.js && node scripts/verify-osi-lib-db-caller-binding.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-flows-output-arity.js
node scripts/verify-scoped-access.js && node --test scripts/test-scoped-access-writes.js && node scripts/test-flows-wiring.js
node scripts/verify-auth-flag-off-hermetic.js && node --test scripts/verify-auth-flag-off-hermetic.test.js
node scripts/verify-no-new-silent-catch.js && node scripts/flows-bare-require-scan.js && bash scripts/check-mqtt-topics.sh
node scripts/verify-sync-contract.js && node scripts/test-contract-schemas.js && node --test scripts/test-outbox-retention.js
node scripts/test-entity-name-command-path.js && node scripts/test-valve-actuation-bootstrap.js
node scripts/verify-sync-flow.js && node scripts/verify-profile-parity.js
node --test lib/osi-migrate/__tests__/*.test.js && node --test scripts/reconcile-ledger-numbering.test.js
```
Expected: every command exits 0. Report the real output of any failure; do not pipe through `tail`.

- [ ] **Step 5: GUI suite, then one build.**

```bash
cd web/react-gui && npm run test:unit && npm run typecheck && npm run build
```
Expected: all pass. No other frontend build may run at the same time.

- [ ] **Step 6: Commit.**

```bash
git add -A web/react-gui docs AGENTS.md scripts
git commit -m "feat(i18n,docs): WATERMARK irrigation control strings; activate the phase 3 contract; AGENTS.md sync tables"
```

---

## Self-review (done while writing)

**Spec coverage (§8 and §11 "Phase 3").**

| Spec requirement | Task |
|---|---|
| `devices.watermark_enabled`, writer refuses without live calibration, with Chameleon on, without an ok/saturated reading in 24 h | E2, E4 (tests for each), E5, E6 |
| Chameleon writer refuses while WATERMARK is on (D7) | E5 (edge route + verifier), E6 (D6 applier), C5 (cloud endpoint) |
| Delete clears the flag in the same transaction; update keeps it | E4 |
| Scheduler clause for `DRAGINO_LSN50` with `watermark_enabled = 1`; `trigger_metric` unchanged | E7 (the clause is stricter than the spec's one-liner: it is per row and version-checked, OD-2) |
| `SET_WATERMARK_CONFIG {enabled}`, device resource `watermark_enabled` (§7) | E3, E6, C3, C5 |
| `WATERMARK_READING_APPENDED` mirroring `CHAMELEON_READING_APPENDED`, cloud mirror table, retention | E2, E3, E8, C1, C2, C3, C4 |
| Bench gate before field use; unsettled envelope | bench protocol, E1, E10 |
| Tests: flag preconditions, revocation on delete, scheduler admission | E4, E6, E7 (matrix S1–S7) |
| Cloud deploys first | Execution order; E11 activation only after C2/C5 |

**Deliberately not in this phase.** The cloud prediction inputs (`PredictionInputAssembler`, `TerraDeviceAnchorService`) do not consult `watermark_enabled`; they are advisory, not irrigation. They get a follow-up issue so a WATERMARK probe is not counted as a Terra anchor before it is enabled. Unclaiming a device does not clear `watermark_enabled`; like every other device flag it stays with the device. The owner may ask for that, in which case it becomes one more revocation line in E4.

**Placeholder scan.** The only unfilled values are in E10, whose literals come from the bench run and whose task text says it cannot start without them. The phase 2 dependencies are named in the assumptions table, not left open.

**Type consistency.** Names used across tasks: `writeWatermarkEnabled` / `setWatermarkEnabled` / `getWatermarkConfig` / `readWatermarkConfig` / `REASON_ORDER` (E4 → E5, E6, E7); `applyWatermarkCalibrationCommand` handling `SET_WATERMARK_CONFIG` (phase 2 module, E6); `toSyncPayload` / `bootstrapReadings` (E8); `WatermarkReadingMirror.upsert` (C2 → C3); `WatermarkCommandTarget.resolve` and `WatermarkConfigCommandService.request(actor, deviceEui, ConfigRequest)` (C5); request field `calibration_sync_version` on the edge and in the contract, `calibrationSyncVersion` in the cloud JSON body; resource type `WATERMARK_ROW`; capability `watermark_scheduler_v1`, cloud flag `watermarkSchedulerSupported`.
