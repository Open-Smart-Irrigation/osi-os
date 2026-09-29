# WATERMARK on the LSN50, Phase 2 (sync and cloud parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Review status (2026-09-27): REWRITE BEFORE EXECUTION.** P2-1 through P2-7
> are confirmed. The review found one correctness defect in C4: a metadata-only
> edit would be reported applied before the edge changed because metadata was
> omitted from desired-state convergence. The binding correction below includes
> the four explicit metadata fields. This plan also remains blocked on the
> reviewed Chameleon prerequisite plan, which must preserve edge authority and
> capability-gate its command.
>
> **Binding amendment:** Task C4's `wireNumber` ternary is also non-executable.
> Java applies binary numeric promotion to `Integer` and `Double` operands in a
> conditional expression, so the stated expression returns a `Double` even on
> its integral branch. Use explicit `if`/`return` branches and test the runtime
> `Number` subtype; otherwise whole-number calibration edits can still diverge
> in `DesiredStateService.containsDesired`.
>
> **Ledger prerequisite:** fix and test `DesiredStateService.canRewrite` before
> Task C4. It currently reuses an unleased same-type command even when the new
> request has a different base/effect key, but the rewrite method does not
> update the persisted command key. Reuse is allowed only when both base version
> and effect key match. A changed binding issues a new command and supersedes
> the prior operation.
>
> **Reconciled with main (2026-09-29).** Phase 1 is on main as `ca08dcc13`.
> Statements about phase 1 now describe that code: its migration is
> `0061__watermark_lsn50.sql`, so this plan's migration is `0062` and phase 3's
> is `0063`. The task bodies are otherwise unchanged and still need the rewrite
> above. Deferred work across the phases:
> `docs/superpowers/plans/2026-09-29-watermark-deferred-work.md`.

**Goal:** The edge-authored WATERMARK calibration syncs to the cloud, the cloud can propose a calibration change or a delete as a pending command that the edge applies with its own version check, and the cloud shows WATERMARK devices, probe readings and history with the right labels and depths.

**Architecture:**
- **Edge (osi-os).** Migration `0062` adds two migration-owned outbox triggers on `watermark_calibrations`, gated on a linked gateway. A new module file `osi-watermark-helper/commands.js` applies `SET_WATERMARK_CALIBRATION` / `DELETE_WATERMARK_CALIBRATION` in one transaction through the phase 1 writer. A thin flow node sits between `entity-name-command-apply-fn` and Route Command. Bootstrap and force sync carry a `watermark_calibrations` array. The edge advertises `watermark_v1`.
- **Cloud (osi-server).** A Flyway migration adds the calibration mirror, a derived `devices.watermark_calibrated` flag and the `watermark_supported` capability column. A `SyncEventApplier` mirrors both events; bootstrap rows go through the same applier, reload the retained mirror, and notify desired-state convergence. A command service queues commands through the existing desired-state ledger (pending / acknowledged / applied / conflicted / rejected). The history, analysis and zone-presence consumers learn WATERMARK. The LSN50 card gains a WATERMARK section and a calibration form.
- **Landing order:** phase 1, the shared `DesiredStateService` rewrite guard, the corrected Chameleon pair, then osi-server phase 2 **deployed**, then osi-os phase 2. The capability gate stops a cloud from sending WATERMARK commands to an edge that cannot apply them. Only deploy order stops an old cloud from dead-lettering the new events.

**Tech Stack:** Node-RED function nodes (Node 22), SQLite (`node:sqlite` in tests), the `osi-db-helper` facade, JSON Schema draft-07 contract files; Spring Boot 3 (Java 17 source), Flyway/Postgres, JUnit 5 + Mockito + AssertJ; React + TypeScript + Vitest, react-i18next.

**Spec:** `docs/superpowers/specs/2026-09-25-watermark-lsn50-design.md` — §2 (D1–D10), §7 (phase 2), and the §13 addendum this plan adds. The phase 1 plan `docs/superpowers/plans/2026-09-25-watermark-lsn50-phase1.md` is the reference for the helper, migration `0061`, the calibration route and the GUI.

---

## Confirmed owner decisions (2026-09-27)

The project owner accepted P2-1 through P2-7 as written. The final column records the cost of the rejected alternative; it is context, not an open choice.

| # | Question | Adopted decision | Rejected alternative impact |
|---|---|---|---|
| P2-1 | **(a) The cloud's WATERMARK indicator.** Calibration existence, or a synced device flag/field? | **Calibration existence.** The cloud derives `devices.watermark_calibrated` from a live mirror row, and the DEVICE event stays unchanged in phase 2. A synced edge device field would need a new `devices` column. That means regenerating `DEVICES_COLUMNS` in the frozen `sync-init-fn` (scripts/gen-devices-columns.js plus the boot-node merge gate) and a transition writer on both the FPort 11 and FPort 2 ingest paths. Phase 3 owns the separate calibration-bound scheduler-admission resource. **Consequences:** the cloud cannot see an *uncalibrated* WATERMARK board, so it offers the calibration form on every LSN50 whose gateway reports `watermark_v1` (collapsed until calibrated). A board reflashed back to Chameleon stays "WATERMARK" on the cloud until its calibration is deleted. | Add Task E3b: a `devices.watermark_observed_at` column through `gen-devices-columns.js` (boot-node gate: `verify-devices-rebuild-fence`, `rehearse-devices-rebuild.test.js`, `verify-runtime-schema-parity`, `verify-profile-parity`), a Sentek-style `trg_watermark_device_outbox_payload_ai` augmentation, and an ingest write that bumps `sync_version` only on a family change. Estimate: +2 tasks and a touch to the FPort 2 path that phase 1 kept byte-identical. |
| P2-2 | **(b) Event and command names and payloads.** | Events as in the spec: `WATERMARK_CALIBRATION_UPSERTED` / `WATERMARK_CALIBRATION_DELETED`, aggregateType `WATERMARK_CALIBRATION`, aggregateKey = device EUI, payload = the whole row including the tombstone (golden file below). Commands `SET_WATERMARK_CALIBRATION` / `DELETE_WATERMARK_CALIBRATION` carry the version as **`base_sync_version`** instead of the spec's `expected_sync_version`. `base_sync_version` is already a top-level contract property, and it is the field the cloud desired-state ledger computes and displays. The edge maps it onto the phase 1 writer's `expected_sync_version`. Effect keys: `watermark_calibration:<EUI>:<base>` and `watermark_calibration_delete:<EUI>:<base>`. A stale version is acked `result: CONFLICT`, `reason: stale_sync_version` (the ledger shows "conflicted"). Other refusals are `REJECTED_PERMANENT` with a stable reason. Replays are deduplicated by the delivery `commandId` in `applied_commands`. The spec's "dedup via `sync_inbox`" is a slip: `sync_inbox` deduplicates inbound *events*, not commands. | Rename `base_sync_version` → `expected_sync_version` in E1's `commands.schema.json` block, the golden file, `commands.js` parsing, and C4's payload builder. The cloud ledger still stores it as `baseSyncVersion`. |
| P2-3 | **(c) Does calibration metadata sync?** | **Yes:** `measured_at`, `method`, `worst_residual_pct` and `notes` travel in both events and in `SET_WATERMARK_CALIBRATION.values`. The phase 1 fix-round semantics carry through: an omitted key keeps the stored value, an explicit `null` clears it. The cloud form always sends all four keys, so a cloud edit is explicit. **Review correction:** desired-state convergence compares `op`, the eight resistor values, and all four explicit metadata fields. Otherwise a metadata-only edit is falsely APPLIED against the unchanged mirror. | Drop the four fields from the resource definition, both trigger payloads, the bootstrap SQL and the mirror table. The cloud form then shows coefficients only. |
| P2-4 | **(d) What the cloud shows for LSN50 `swt_*` history rows that are WATERMARK observations, before phase 3's raw sync.** | **Device-level classification, no per-row marker.** A DRAGINO_LSN50 with `watermark_calibrated = true` is a soil-tension source with channels `swt_1`/`swt_2`, labelled "WATERMARK 1/2", with depths from `soil_moisture_probe_depths_json`. WATERMARK wins over `chameleon_enabled`, matching the edge's phase 1 rule that a WATERMARK observation supersedes stale Chameleon state. No field is added to the `DEVICE_DATA` payload: that would change the v1 and v2 history hashes (#242) of every LSN50 row. The cloud card shows kPa and the DS18B20 soil temperature (`ext_temperature_c`); probe status, resistance, offset and supply stay gateway-only until phase 3 and are labelled as such. Known wrong case: history recorded before a Chameleon→WATERMARK reflash is labelled WATERMARK. | Per-row provenance needs phase 3's `WATERMARK_READING_APPENDED`; there is no cheaper correct option. |
| P2-5 | Bootstrap path on the cloud. | The edge sends a `watermark_calibrations` array. The cloud feeds each row to the same `WatermarkCalibrationApplier` as a synthetic event, so the applier is the one writer. After a successful apply, C3 reloads the retained mirror and calls `DesiredStateService.observeMirror` with that row. The reload matters when an older bootstrap item is ignored behind a newer mirror. Bootstrap does not touch `sync_resource_watermarks`, so the command service takes `base = max(mirror.sync_version, watermark slot)`. | — |
| P2-6 | Who may queue a calibration from the cloud. | Same rules as `DeviceRevisionCommandService` (enabled account, `scope.requireMutation()`, capability, local actor identity), with one addition. A device with no zone requires the cloud owner or a gateway ADMIN, because `canWriteZone("")` is always false and a bench board usually has no zone. | Keep the revision rule verbatim: unzoned boards are then edge-only. |
| P2-7 | **Cloud liveness and auto-create for WATERMARK boards.** Phase 1 (on main since `ca08dcc13`) made `Build Telemetry` (`8809bb5239dfb3d4`) drop LSN50 FPort 11 uplinks, so `MqttMessageRouter.handleTelemetry` → `DeviceService.upsertFromHeartbeat` never runs for a WATERMARK board. The cloud loses its `last_seen` refresh and its auto-create into the unclaimed pool. Options: (1) proper WATERMARK telemetry on MQTT; (2) liveness derived from synced `device_data` / calibration events. | **Option 1, emitted by `watermark-ingest-fn`, not by `Build Telemetry`.** After ingest, the node publishes one message to the existing `Telemetry → Cloud` MQTT out (`9b38464d56b05ae0`) carrying exactly what was stored: canonical `swt_1`/`swt_2` (kPa or null), `ext_temperature_c`, `bat_v: null` (D10), `supply_mv`, per-probe statuses. A frame from a DevEUI with no `devices` row, or a `frame_rejected` frame, publishes a liveness-only message (all values null), so the cloud still auto-creates and refreshes `last_seen`. One conversion, one source of truth; `Build Telemetry` keeps its phase 1 drop unchanged. **Why not option 2 (verified in code):** `SyncEventTxExecutor` answers `DEVICE_DATA_APPENDED` as `superseded_by_hash_v2` before any applier runs once a gateway's history hash v2 is active. `DeviceDataHistoryMapper` / `HistoryMirrorWriter` never touch `last_seen` or `current_state`. An unlinked gateway syncs nothing, and calibration events are rare. Option 2 would leave WATERMARK boards "offline" on v2 gateways and never auto-created behind unlinked ones. The cloud needs no change: for gateway-forwarded non-STREGA sensor telemetry, `MqttMessageRouter.handleTelemetry` returns after `heartbeatDevice`; it auto-creates/refreshes `last_seen` but does not call `updateCurrentState` or persist canonical values. C5 pins both sides of that boundary. | Option 2: drop Task E7; add a cloud task that bumps `last_seen` from mirrored WATERMARK rows. It does not cover v2-active or unlinked gateways. |

---

## Global Constraints

- **Worktrees and branches:** osi-os `<osi-os-worktree>` (`feat/watermark-phase2`); osi-server `<osi-server-worktree>` (`feat/watermark-phase2`, from `origin/main` `cce3e8b6`).
  - Never push, merge or touch a gateway or server.
  - Never use bare `git stash`.
  - The shell is fish: wrap multi-command lines in `bash -c '...'`.
- **Preconditions:**
  - Phase 1 is on main: squash-merged as `ca08dcc13` (#366). Its code is the phase 1 branch head `238e855a5` with the migration renumbered from `0060` to `0061__watermark_lsn50.sql`, because the RAK10701 field-tester migration took `0060` first. Start the rewritten plan from `origin/main`; the old `feat/watermark-phase2` branch was cut at `22973f4b7` and lacks the last six phase 1 commits.
  - Main therefore carries:
    - an omitted metadata field keeps its stored value; explicit `null` or `''` clears it (`saveCalibration` in `osi-watermark-helper/calibration.js`);
    - `backfillBatch` (exported) and `backfillRemaining` (module-private), 500 readings per transaction (`BACKFILL_BATCH_SIZE`), the first batch inside the save transaction, and `backfill_incomplete: true` on a save whose later batch failed;
    - `Build Telemetry` (`8809bb5239dfb3d4`) returns `null` for an LSN50 FPort 11 uplink.
  - This plan's E2, E4, E5 and E7 were written against `238e855a5`; the helper modules on main are identical to it; only their tests changed (the migration path `0061__watermark_lsn50.sql` and neutral fixture EUIs). Read the current code with `git show origin/main:<path>`.
  - Rebase both branches onto the merged Chameleon command-name PR pair (`SET_CHAMELEON_ENABLED` → `SET_CHAMELEON_CONFIG`, plus its controller-vs-contract command test).
- **Naming:** fully qualified names, never a bare `watermark` identifier (spec D3). This matters in osi-server, where `SyncResourceWatermark` / `x-watermark-key` already mean something else. Use `watermark_calibration*`, `WatermarkCalibration*`, `WATERMARK_CALIBRATION*`, and the capability `watermark_v1`.
- **Edge authority:** the cloud never writes `watermark_calibration_mirrors` from a user request, only from edge events and bootstrap. A cloud edit is a pending desired-state operation until the edge acks it and the mirror converges.
- **Contract home:** `docs/contracts/sync-schema/` in osi-os. **Byte-mirrored** into `osi-server/backend/src/test/resources/sync-contract/`:
  - `resources.schema.json`;
  - the new `watermark-calibration-v1-golden.json`.

  `events.schema.json`, `commands.schema.json` and `sync-contract-golden.json` are **not** byte copies. The server keeps its own formatting and "cloud ships ahead" staging (see `scripts/verify-edge-sync-contract-vendor.sh` header). Add the same ops and types there by hand; `SyncContractVendorTest` + `SyncOpCoverageTest` + osi-os `verify-sync-op-parity.js` hold them in agreement.
- **Calibration limits** (unchanged from phase 1): pull-ups and pull-downs 25 000–65 000 Ω; series 0–500 Ω; `worst_residual_pct` 0–100; `method` cut to 64 chars and `notes` to 500 chars (the phase 1 writer truncates them, it does not refuse them); `measured_at` ISO → canonical `YYYY-MM-DDTHH:MM:SS.mmmZ`.
- **Edge schema:**
  - The migration takes the next free number on main. On main at `ca08dcc13` that is **`0062`** (phase 1 is `0061`, RAK10701 is `0060`); phase 3 then takes `0063`. Renumber again if main moves before merge.
  - Do not edit the frozen `sync-init-fn`. Do not add a `devices` column (decision P2-1).
  - Keep the seed and all 7 bundled DBs in parity (`node scripts/build-seed-db.js`).
- **Cloud schema:** one Flyway file `V2026_09_27_001__watermark_calibration_mirror.sql`, **re-dated at merge time** to sort after `origin/main`'s newest (`sh scripts/verify-flyway-ordering.sh`). The concurrent phase 3 plan must not reuse the date.
- **Flows editing:** load `.claude/skills/osi-flows-json-editing/SKILL.md` first.
  - Edit with a Node script: parse → mutate → `JSON.stringify(flows, null, 2) + '\n'`.
  - Prove a no-op roundtrip byte-identical first.
  - Write both profiles; `node scripts/verify-profile-parity.js` must pass.
  - The size ratchet is per profile: record exact measured deltas in `scripts/verify-flows-size-ratchet-allowances.json`, carrying the prior `total_allowance.reason` forward (phase 1 precedent).
- **Pi 4 mirror:** every file created or changed under `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/` is copied byte-for-byte to the `bcm2709` tree in the same commit.
- **Auth hermeticity:** with `OSI_SCOPED_ACCESS` unset, no edge path may call `osiLib.require('scope')` (`node scripts/verify-auth-flag-off-hermetic.js`). The new helper file must not `require` the scope helper at module level; the flow node passes it in only in scoped mode.
- **Numbers on the wire:** SQLite renders a REAL `41670` as `41670.0`. The edge outbox builder then `JSON.parse`s and re-`stringify`s every payload, so the cloud receives `41670` (Jackson `Integer`) and `0.6` (`Double`).
  - `DesiredStateService.containsDesired` compares `JsonNode`s, and `IntNode(41670)` is not equal to `DoubleNode(41670.0)`.
  - So the cloud's `desired` map must hold integral values as `Integer` and fractional ones as `Double` (`WatermarkCalibrationValues.wireNumber`). Tested in C4.
- **Builds:**
  - Never run two frontend builds at once (the workstation OOMs). One `npm run build` in C7 only.
  - No full `./gradlew build`. Run targeted `./gradlew test --tests ...` per task and one `./gradlew test` in C8.
- Commit after every task with a conventional message. Do not amend.
- **Code marked *untested sketch*** was written without being run. The executor makes it pass its step's test and must not assume it is correct as written. The SQL in Task E3 was run against `seed-blank.sql` + the phase 1 migration (then numbered `0060`, now `0061`) in `node:sqlite` while planning (output recorded in that task); everything else is a sketch.

## Review Focus

Inputs the spec implies but no happy-path test covers. Each line names the owning task, where its test lives.

1. **A cloud edit whose values are whole numbers** (every bench calibration). After the edge applies it and the mirror arrives, the ledger should show *applied*, not *conflicted*. The trap: the `IntNode`/`DoubleNode` mismatch in `containsDesired`. Owner: C4 (real `DesiredStateService` + golden payload test).
2. **A metadata-only edit.** It must stay pending/acknowledged until the edge
   mirror contains the requested `measured_at`, `method`,
   `worst_residual_pct`, and `notes` values, including explicit nulls. Omitting
   metadata from `desired` makes the unchanged mirror look converged. Owner: C4.
3. **Two cloud edits on the same base version, or a cloud edit racing a gateway edit.** The second must be acked `CONFLICT stale_sync_version` and leave the edge row untouched. The cloud then shows the edge's values, and a retry from the refreshed form succeeds. Owner: E4 (applier), C4 (early cloud-side 409 and ledger).
4. **A calibration saved while the gateway was unlinked, or before its device reached the cloud.** Linking or bootstrap must deliver it. An event that beats its DEVICE event is retried, not dead-lettered. Owner: E6 (bootstrap rows), C2 (`Device not found …` → retryable; ownership bootstrap-allow), C3.
5. **A `SET_WATERMARK_CALIBRATION` replayed after the edge crashed between commit and MQTT ack.** It must return the stored ack and apply nothing twice. A replay after the first answer was `CONFLICT` returns the same `CONFLICT`. Owner: E4.
6. **A gateway that never advertised `watermark_v1`, or a viewer or unassigned researcher.** The cloud refuses before queueing (501 / 403 / 404), and nothing reaches `device_commands`. Owner: C4. On the edge in scoped mode, an unassigned actor is acked `REJECTED_PERMANENT forbidden`. Owner: E4.
7. **A second calibration edit arrives before the first unleased command is
   delivered, after the mirror/base advanced.** The ledger must issue a new
   command with the new effect key, not rewrite the old payload while retaining
   its old persisted key. Owner: C4 prerequisite
   (`DesiredStateServiceTest` plus the calibration service test).
8. **An APPLIED ACK arrives but the normal event is lost and the calibration
   returns only in bootstrap.** The authoritative bootstrap row must complete
   the desired-state operation. An older bootstrap row must notify with the
   newer retained mirror, never regress or conflict against the stale incoming
   payload. Owner: C3.

---

## File map

**osi-os**

| File | Change |
|---|---|
| `docs/contracts/sync-schema/events.schema.json` | 2 ops, 2 semantic bindings, 2 `allOf` blocks |
| `docs/contracts/sync-schema/commands.schema.json` | 2 command types, 2 `allOf` blocks |
| `docs/contracts/sync-schema/resources.schema.json` | `WatermarkCalibration`, `WatermarkCalibrationValues` definitions |
| `docs/contracts/sync-schema/watermark-calibration-v1-golden.json` | new: golden events + commands |
| `docs/contracts/sync-schema/README.md` | resource phasing row, command note |
| `scripts/test-contract-schemas.js`, `scripts/verify-sync-contract.js` | golden vectors, file list |
| `…/osi-watermark-helper/calibration.js` | transaction-scoped seam (E2) |
| `…/osi-watermark-helper/commands.js` (+`commands.test.js`) | new command applier (E4) |
| `…/osi-watermark-helper/index.js` | export `commands` |
| `database/migrations/ordered/0062__watermark_calibration_sync.sql` | new outbox triggers |
| `database/seed-blank.sql`, 7 bundled `farming.db`, `CHECKSUMS.json` | parity |
| `scripts/verify-runtime-schema-parity.js`, `scripts/verify-trigger-body-parity.js`, `scripts/verify-db-schema-consistency.js`, `scripts/verify-sync-op-parity.js`, `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`, `scripts/reconcile-ledger-numbering.test.js` | migration-owned trigger registration, version lists |
| `scripts/rehearse-watermark-calibration-sync.test.js` | new (E3) |
| both `flows.json` | new node `watermark-calibration-command-apply-fn`, registry + fallback, 3 capability builders, bootstrap + force-sync arrays |
| `scripts/test-watermark-calibration-command-path.js`, `scripts/test-watermark-calibration-bootstrap.js` | new |
| `scripts/test-entity-name-command-path.js`, `scripts/test-flows-wiring.js`, `scripts/verify-sync-flow.js`, `scripts/test-journal-bootstrap.js` | pinned wiring and capability lists |
| `scripts/verify-flows-size-ratchet-allowances.json` | measured deltas |
| `deploy.sh` | fetch `commands.js` |
| `…/osi-watermark-helper/ingest.js`, `watermark-ingest-fn` in both `flows.json`, `scripts/test-watermark-ingest-flow.js` | WATERMARK MQTT telemetry for cloud liveness (E7, decision P2-7) |
| `AGENTS.md`, `.claude/skills/osi-sync-contract-awareness/SKILL.md` | command/capability/trigger docs |

**osi-server**

| File | Change |
|---|---|
| `backend/src/main/resources/db/migration/V2026_09_27_001__watermark_calibration_mirror.sql` | new |
| `backend/src/main/java/org/osi/server/watermark/*` | new package: `WatermarkCalibrationMirror`, `…Repository`, `WatermarkCalibrationValues`, `WatermarkCalibrationCommandService`, `WatermarkCalibrationController`, `WatermarkCalibrationView` |
| `…/sync/WatermarkCalibrationApplier.java` | new |
| `…/sync/EdgeSyncService.java` | `EventResourceRef` cases; `EdgeBootstrapRequest.watermarkCalibrations`; bootstrap loop |
| `…/security/EdgeOwnershipService.java` | `WATERMARK_CALIBRATION` resource |
| `…/device/Device.java`, `…/device/DeviceController.java` (`DeviceResponse`) | `watermarkCalibrated` |
| `…/user/LinkedGatewayAccount.java`, `…/user/LinkedGatewayAccountService.java`, `…/user/LinkedGatewaySyncService.java` | `watermark_v1` capability |
| `…/history/HistoryCardService.java`, `…/analysis/AnalysisCatalogService.java` | WATERMARK consumers |
| `backend/src/test/resources/sync-contract/*` | vendored contract + golden |
| `scripts/verify-edge-sync-contract-vendor.sh`, `…/sync/SyncContractVendorTest.java` | new edge-owned file |
| `frontend/src/types/farming.ts`, `frontend/src/services/api.ts`, `frontend/src/contexts/gatewayCapabilities.ts`, `frontend/src/components/farming/zoneSensorPresence.ts`, `frontend/src/channels/registry.ts` | data layer |
| `frontend/src/components/farming/WatermarkCloudSection.tsx`, `WatermarkCalibrationPanel.tsx`, `DraginoCard.tsx` | UI |
| `frontend/public/locales/*/devices.json` | 7 locales (`lg` = `en`, cloud rule) |

---

# Part E — osi-os (edge)

### Task E1: Contract — events, commands, resource, golden file

**Files:**
- Modify: `docs/contracts/sync-schema/events.schema.json`, `docs/contracts/sync-schema/commands.schema.json`, `docs/contracts/sync-schema/resources.schema.json`, `docs/contracts/sync-schema/README.md`
- Create: `docs/contracts/sync-schema/watermark-calibration-v1-golden.json`
- Modify: `scripts/test-contract-schemas.js`, `scripts/verify-sync-contract.js` (only if its file list or checks need the golden file; see Step 5)

**Interfaces:**
- Produces:
  - op strings `WATERMARK_CALIBRATION_UPSERTED`, `WATERMARK_CALIBRATION_DELETED`; aggregateType `WATERMARK_CALIBRATION`;
  - command types `SET_WATERMARK_CALIBRATION`, `DELETE_WATERMARK_CALIBRATION`;
  - definitions `resources.schema.json#/definitions/WatermarkCalibration` and `#/definitions/WatermarkCalibrationValues`;
  - the golden file every later task (E3, E4, E6, C2, C4) tests against.

- [ ] **Step 1: Write the golden file** `docs/contracts/sync-schema/watermark-calibration-v1-golden.json`. Numbers are written as the cloud receives them: the edge outbox builder re-stringifies the payload, so `41670.0` from SQLite arrives as `41670`.

```json
{
  "format": 1,
  "description": "WATERMARK calibration sync v1 (osi-os spec 2026-09-25 section 7 and section 13). events: the payload as the cloud receives it from POST /api/v1/sync/edge/events (after the edge outbox builder's JSON round trip). commands: pending-command payloads the cloud issues.",
  "events": [
    {
      "op": "WATERMARK_CALIBRATION_UPSERTED",
      "aggregateType": "WATERMARK_CALIBRATION",
      "aggregateKey": "A84041A171000001",
      "syncVersion": 3,
      "payload": {
        "contract_version": 1,
        "device_eui": "A84041A171000001",
        "gateway_device_eui": "0016C001F1000001",
        "pullup_1_ohm": 41670,
        "pulldown_1_ohm": 41260,
        "series_fwd_1_ohm": 130,
        "series_rev_1_ohm": 112,
        "pullup_2_ohm": 42530,
        "pulldown_2_ohm": 42070,
        "series_fwd_2_ohm": 46,
        "series_rev_2_ohm": 27,
        "measured_at": "2026-09-20T08:00:00.000Z",
        "method": "bench_resistors",
        "worst_residual_pct": 0.6,
        "notes": "bench 2026-09-20, 0.996/9.97/29.95 kOhm",
        "sync_version": 3,
        "updated_at": "2026-09-26T10:00:00.000Z",
        "deleted_at": null
      }
    },
    {
      "op": "WATERMARK_CALIBRATION_DELETED",
      "aggregateType": "WATERMARK_CALIBRATION",
      "aggregateKey": "A84041A171000001",
      "syncVersion": 4,
      "payload": {
        "contract_version": 1,
        "device_eui": "A84041A171000001",
        "gateway_device_eui": "0016C001F1000001",
        "pullup_1_ohm": 41670,
        "pulldown_1_ohm": 41260,
        "series_fwd_1_ohm": 130,
        "series_rev_1_ohm": 112,
        "pullup_2_ohm": 42530,
        "pulldown_2_ohm": 42070,
        "series_fwd_2_ohm": 46,
        "series_rev_2_ohm": 27,
        "measured_at": "2026-09-20T08:00:00.000Z",
        "method": "bench_resistors",
        "worst_residual_pct": 0.6,
        "notes": "bench 2026-09-20, 0.996/9.97/29.95 kOhm",
        "sync_version": 4,
        "updated_at": "2026-09-26T11:00:00.000Z",
        "deleted_at": "2026-09-26T11:00:00.000Z"
      }
    }
  ],
  "commands": [
    {
      "command_type": "SET_WATERMARK_CALIBRATION",
      "command_id": "5b0f6c0e-4a7d-4c55-9f31-2f0d3c7e9a11",
      "effect_key": "watermark_calibration:A84041A171000001:4",
      "device_eui": "A84041A171000001",
      "gateway_device_eui": "0016C001F1000001",
      "actor_user_uuid": "12345678-1234-4234-8234-123456789abc",
      "requested_at": "2026-09-26T12:00:00.000Z",
      "base_sync_version": 4,
      "values": {
        "pullup_1_ohm": 41670,
        "pulldown_1_ohm": 41260,
        "series_fwd_1_ohm": 130,
        "series_rev_1_ohm": 112,
        "pullup_2_ohm": 42530,
        "pulldown_2_ohm": 42070,
        "series_fwd_2_ohm": 46,
        "series_rev_2_ohm": 27,
        "measured_at": "2026-09-20T08:00:00.000Z",
        "method": "bench_resistors",
        "worst_residual_pct": 0.6,
        "notes": null
      }
    },
    {
      "command_type": "DELETE_WATERMARK_CALIBRATION",
      "command_id": "8d2c1f7a-1b3e-4f6a-8c9d-0e1f2a3b4c5d",
      "effect_key": "watermark_calibration_delete:A84041A171000001:3",
      "device_eui": "A84041A171000001",
      "gateway_device_eui": "0016C001F1000001",
      "actor_user_uuid": "12345678-1234-4234-8234-123456789abc",
      "requested_at": "2026-09-26T12:05:00.000Z",
      "base_sync_version": 3
    }
  ]
}
```

- [ ] **Step 2: Write the failing contract tests.** In `scripts/test-contract-schemas.js`:
  - Add `WATERMARK_CALIBRATION_UPSERTED: 'device_eui'` and `WATERMARK_CALIBRATION_DELETED: 'device_eui'` to a new `WATERMARK_EVENT_KEY_FIELDS` map, spread into `EXPECTED_EVENT_SEMANTIC_BINDINGS` exactly like `ZONE_CALIBRATION_WEATHER_EVENT_KEY_FIELDS`.
  - Add `'SET_WATERMARK_CALIBRATION'` and `'DELETE_WATERMARK_CALIBRATION'` nowhere else. Both carry `device_eui`, so they are not in `DEVICE_EUI_EXEMPT_COMMANDS`.
  - Append these vectors before `if (!ok) process.exit(1);`:

```js
// WATERMARK calibration sync v1 (spec 2026-09-25 section 7/13): golden vectors.
const watermarkGolden = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs/contracts/sync-schema/watermark-calibration-v1-golden.json'), 'utf8'));
for (const event of watermarkGolden.events) {
    expectValid(`golden ${event.op} event`, eventSchema, Object.assign({ eventUuid: 'e-' + event.op.toLowerCase() }, event));
}
for (const command of watermarkGolden.commands) {
    expectValid(`golden ${command.command_type} command`, cmdSchema, command);
}
const wmUpsert = watermarkGolden.events[0];
const wmSet = watermarkGolden.commands[0];
const wmDelete = watermarkGolden.commands[1];
expectInvalid('WATERMARK_CALIBRATION_UPSERTED with a pull-up below 25000 ohm', eventSchema,
    Object.assign({ eventUuid: 'e1' }, wmUpsert, { payload: Object.assign({}, wmUpsert.payload, { pullup_1_ohm: 24999 }) }),
    /pullup_1_ohm.*(?:minimum|less)/);
expectInvalid('WATERMARK_CALIBRATION_UPSERTED with a lowercase device_eui', eventSchema,
    Object.assign({ eventUuid: 'e2' }, wmUpsert, { payload: Object.assign({}, wmUpsert.payload, { device_eui: 'a84041a171000001' }) }),
    /device_eui.*(?:match|pattern)/);
expectInvalid('WATERMARK_CALIBRATION_UPSERTED with the wrong aggregateType', eventSchema,
    Object.assign({ eventUuid: 'e3' }, wmUpsert, { aggregateType: 'DEVICE' }),
    /aggregateType/);
expectInvalid('SET_WATERMARK_CALIBRATION without base_sync_version', cmdSchema,
    (() => { const v = Object.assign({}, wmSet); delete v.base_sync_version; return v; })(),
    /base_sync_version.*required/);
expectInvalid('SET_WATERMARK_CALIBRATION missing a resistor value', cmdSchema,
    Object.assign({}, wmSet, { values: (() => { const v = Object.assign({}, wmSet.values); delete v.series_rev_2_ohm; return v; })() }),
    /series_rev_2_ohm.*required/);
expectInvalid('SET_WATERMARK_CALIBRATION with an unknown values key', cmdSchema,
    Object.assign({}, wmSet, { values: Object.assign({}, wmSet.values, { pullup_3_ohm: 40000 }) }),
    /pullup_3_ohm|additional/);
expectValid('SET_WATERMARK_CALIBRATION with metadata omitted (edge keeps stored values)', cmdSchema,
    Object.assign({}, wmSet, { values: (() => { const v = Object.assign({}, wmSet.values); for (const k of ['measured_at', 'method', 'worst_residual_pct', 'notes']) delete v[k]; return v; })() }));
expectInvalid('DELETE_WATERMARK_CALIBRATION without device_eui', cmdSchema,
    (() => { const v = Object.assign({}, wmDelete); delete v.device_eui; return v; })(),
    /device_eui.*required/);
expectInvalid('SET_WATERMARK_CALIBRATION with a malformed effect_key', cmdSchema,
    Object.assign({}, wmSet, { effect_key: 'watermark_calibration:A84041A171000001' }),
    /effect_key.*(?:match|pattern)/);
```

  Check how this file names `eventSchema` and `cmdSchema`, and whether it already imports `fs`/`path`; use its existing names.

- [ ] **Step 3: Run it to verify it fails.**

Run: `node scripts/test-contract-schemas.js`
Expected: FAIL. The golden events are rejected (op not in the enum) and the golden commands are rejected (`command_type` not in the enum).

- [ ] **Step 4: Add the schema entries.**

  `resources.schema.json`: add the two definitions after `ValveSettings`. Keep the file's style: 4-space indent, short arrays inline.

```json
        "WatermarkCalibrationValues": {
            "type": "object",
            "description": "WATERMARK 200SS on the Dragino LSN50: board-specific pull and series resistances (spec 2026-09-25 section 5.1). Limits match migration 0061's CHECK constraints.",
            "required": ["pullup_1_ohm", "pulldown_1_ohm", "series_fwd_1_ohm", "series_rev_1_ohm", "pullup_2_ohm", "pulldown_2_ohm", "series_fwd_2_ohm", "series_rev_2_ohm"],
            "additionalProperties": false,
            "properties": {
                "pullup_1_ohm": {"type": "number", "minimum": 25000, "maximum": 65000},
                "pulldown_1_ohm": {"type": "number", "minimum": 25000, "maximum": 65000},
                "series_fwd_1_ohm": {"type": "number", "minimum": 0, "maximum": 500},
                "series_rev_1_ohm": {"type": "number", "minimum": 0, "maximum": 500},
                "pullup_2_ohm": {"type": "number", "minimum": 25000, "maximum": 65000},
                "pulldown_2_ohm": {"type": "number", "minimum": 25000, "maximum": 65000},
                "series_fwd_2_ohm": {"type": "number", "minimum": 0, "maximum": 500},
                "series_rev_2_ohm": {"type": "number", "minimum": 0, "maximum": 500},
                "measured_at": {"$ref": "#/definitions/NullableCanonicalUtcTimestamp"},
                "method": {"type": ["string", "null"], "maxLength": 64},
                "worst_residual_pct": {"type": ["number", "null"], "minimum": 0, "maximum": 100},
                "notes": {"type": ["string", "null"], "maxLength": 500}
            }
        },
        "WatermarkCalibration": {
            "type": "object",
            "description": "Edge-authored WATERMARK calibration row (osi-os watermark_calibrations), emitted by migration 0062's triggers and by bootstrap. deleted_at non-null is a tombstone; a later save clears it and bumps sync_version.",
            "required": ["contract_version", "device_eui", "gateway_device_eui", "pullup_1_ohm", "pulldown_1_ohm", "series_fwd_1_ohm", "series_rev_1_ohm", "pullup_2_ohm", "pulldown_2_ohm", "series_fwd_2_ohm", "series_rev_2_ohm", "measured_at", "method", "worst_residual_pct", "notes", "sync_version", "updated_at", "deleted_at"],
            "additionalProperties": false,
            "properties": {
                "contract_version": {"type": "integer", "const": 1},
                "device_eui": {"$ref": "#/definitions/Eui64"},
                "gateway_device_eui": {"$ref": "#/definitions/Eui64"},
                "pullup_1_ohm": {"type": "number", "minimum": 25000, "maximum": 65000},
                "pulldown_1_ohm": {"type": "number", "minimum": 25000, "maximum": 65000},
                "series_fwd_1_ohm": {"type": "number", "minimum": 0, "maximum": 500},
                "series_rev_1_ohm": {"type": "number", "minimum": 0, "maximum": 500},
                "pullup_2_ohm": {"type": "number", "minimum": 25000, "maximum": 65000},
                "pulldown_2_ohm": {"type": "number", "minimum": 25000, "maximum": 65000},
                "series_fwd_2_ohm": {"type": "number", "minimum": 0, "maximum": 500},
                "series_rev_2_ohm": {"type": "number", "minimum": 0, "maximum": 500},
                "measured_at": {"$ref": "#/definitions/NullableCanonicalUtcTimestamp"},
                "method": {"type": ["string", "null"], "maxLength": 64},
                "worst_residual_pct": {"type": ["number", "null"], "minimum": 0, "maximum": 100},
                "notes": {"type": ["string", "null"], "maxLength": 500},
                "sync_version": {"type": "integer", "minimum": 1},
                "updated_at": {"$ref": "#/definitions/CanonicalUtcTimestamp"},
                "deleted_at": {"$ref": "#/definitions/NullableCanonicalUtcTimestamp"}
            }
        },
```

  **Bootstrap caveat:** the bootstrap SQL in E6 reads `updated_at` exactly as stored. Phase 1 writes it with `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, which is canonical. Check `NullableCanonicalUtcTimestamp` accepts `null` (`"type": ["string","null"]`).

  `events.schema.json`:
  - Add both ops to `properties.op.enum`.
  - Add both to `x-semantic-bindings` as `{"aggregate_key_path": "payload.device_eui", "sync_version_path": "payload.sync_version"}`.
  - Append two `allOf` entries in the compact style this file uses:

```json
        {
            "if": {"properties": {"op": {"enum": ["WATERMARK_CALIBRATION_UPSERTED", "WATERMARK_CALIBRATION_DELETED"]}}, "required": ["op"]},
            "then": {
                "properties": {
                    "aggregateType": {"const": "WATERMARK_CALIBRATION"},
                    "aggregateKey": {"$ref": "resources.schema.json#/definitions/Eui64"},
                    "payload": {"$ref": "resources.schema.json#/definitions/WatermarkCalibration"}
                }
            }
        },
        {
            "if": {"properties": {"op": {"const": "WATERMARK_CALIBRATION_DELETED"}}, "required": ["op"]},
            "then": {"properties": {"payload": {"required": ["deleted_at"], "properties": {"deleted_at": {"$ref": "resources.schema.json#/definitions/CanonicalUtcTimestamp"}}}}}
        }
```

  `commands.schema.json`:
  - Add both types to `properties.command_type.enum`.
  - Top-level `base_sync_version`, `actor_user_uuid`, `requested_at`, `gateway_device_eui`, `device_eui`, `effect_key` and `values` already exist. Confirm with `python3 -c "import json;print(sorted(json.load(open('docs/contracts/sync-schema/commands.schema.json'))['properties']))"`. Do not add top-level properties.
  - Append:

```json
        {
            "if": {"properties": {"command_type": {"const": "SET_WATERMARK_CALIBRATION"}}, "required": ["command_type"]},
            "then": {
                "required": ["command_id", "effect_key", "device_eui", "gateway_device_eui", "actor_user_uuid", "requested_at", "base_sync_version", "values"],
                "properties": {
                    "effect_key": {"type": "string", "pattern": "^watermark_calibration:[0-9A-F]{16}:(?:0|[1-9][0-9]*)$"},
                    "base_sync_version": {"type": "integer", "minimum": 0},
                    "values": {"$ref": "resources.schema.json#/definitions/WatermarkCalibrationValues"}
                }
            }
        },
        {
            "if": {"properties": {"command_type": {"const": "DELETE_WATERMARK_CALIBRATION"}}, "required": ["command_type"]},
            "then": {
                "required": ["command_id", "effect_key", "device_eui", "gateway_device_eui", "actor_user_uuid", "requested_at", "base_sync_version"],
                "properties": {
                    "effect_key": {"type": "string", "pattern": "^watermark_calibration_delete:[0-9A-F]{16}:(?:[1-9][0-9]*)$"},
                    "base_sync_version": {"type": "integer", "minimum": 1}
                }
            }
        }
```

  If the existing top-level `base_sync_version` definition conflicts (for example a different `minimum`), keep the top-level one and let the `then` narrow it.

  `README.md`:
  - Add a table row: `WATERMARK_CALIBRATION` | `WATERMARK_CALIBRATION_UPSERTED` / `_DELETED` | "Phase 2: edge triggers (0062) + cloud mirror ship as a lockstep pair; cloud deploys first."
  - Add a short "WATERMARK calibration commands" paragraph:
    - `base_sync_version` is compared with the edge row's `sync_version`, the tombstone included;
    - a mismatch is acked `CONFLICT` / `stale_sync_version`;
    - in `values`, an omitted metadata key keeps the stored value and `null` clears it.

- [ ] **Step 5: Run the contract gates.**

```bash
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
```
Expected:
- `test-contract-schemas.js` prints `PASS: contract schema checks pass`.
- `verify-sync-contract.js` must be judged on its own output. If it fails because the registry lacks the two command types, that is expected until E5. In that case record the failure text, add both types to `scripts/fixtures/sync-contract-staging.json` → `commands.edgeDeferred` and to `EXACT_EDGE_DEFERRED_JOURNAL_COMMANDS`-style lists **only if** the verifier's own messages ask for that, and remove them again in E5.
- If the verifier enumerates contract files (`V2_CONTRACT_FILES`-style list) and fails on an unknown file, register `watermark-calibration-v1-golden.json` there.

- [ ] **Step 6: Commit.**

```bash
git add docs/contracts/sync-schema scripts/test-contract-schemas.js scripts/verify-sync-contract.js scripts/fixtures/sync-contract-staging.json
git commit -m "feat(contract): WATERMARK calibration events, commands and golden vectors"
```

---

### Task E2: Calibration writer — transaction-scoped seam

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/calibration.js` (+ bcm2709 copy)
- Test: `…/osi-watermark-helper/store.test.js` (+ bcm2709 copy)

**Why:** the command applier must write the calibration, its `applied_commands` row and its `command_ack_outbox` row in **one** transaction, as `osi-entity-name` does. `saveCalibration` and `deleteCalibration` on main (phase 1, `ca08dcc13`) each open their own `db.transaction`. A nested `db.transaction` inside a transaction scope is not supported: the harness facade passes `this` as the scope, so a nested `BEGIN` fails.

**Interfaces:**
- Consumes (main at `ca08dcc13`, read with `git show origin/main:…/calibration.js`):
  - `validateCalibrationBody` (partial metadata: an omitted key is absent from `meta`; `null` or `''` clears it);
  - `assertAccessibleLsn50`, `readRow`, `publicCalibration`;
  - `backfillBatch(tx, deveui, calibrationRow, cursor)` → `{ converted, cursor, more }`;
  - `backfillRemaining(db, deveui, calibrationRow, first)` → `{ converted, error }` (not exported today).
- Produces (exported; `index.js` spreads them):
  - `saveCalibrationInTransaction(tx, { deveui, userId, scoped, body })` → `{ row, first }`. It is the body of today's `saveCalibration` transaction, unchanged: access check, `stale_sync_version` 409 with `currentSyncVersion`, metadata keep/clear, upsert, version bump, and **the first backfill batch inside the transaction**. It rejects `dry_run: true` with 400 `invalid_body`, because a command is never a preview.
  - `deleteCalibrationInTransaction(tx, { deveui, userId, scoped, expectedSyncVersion })` → `{ deveui, sync_version, calibration: null }`: the body of today's `deleteCalibration` transaction.
  - `backfillRemaining`, now exported.
  - `saveCalibration` / `deleteCalibration` keep their exact REST behaviour and response shape, including `backfilled` and `backfill_incomplete`:
    - `saveCalibration` = dry-run branch unchanged, **or** `db.transaction(tx => saveCalibrationInTransaction(tx, args))` then `backfillRemaining(db, key, saved.row, saved.first)`;
    - `deleteCalibration` = `db.transaction(tx => deleteCalibrationInTransaction(tx, args))`.

- [ ] **Step 1: Write the failing tests** (append to `store.test.js`; reuse its `freshDb`, `CAL`, `DEVEUI`, `USER_ID`, `ingestAt`, `frameB64`, `T1`):

```js
describe('transaction-scoped calibration seam (phase 2)', () => {
  let ctx;
  beforeEach(() => { ctx = freshDb(); });

  it('saveCalibrationInTransaction saves and converts the first batch inside the caller transaction', async () => {
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058]));
    const res = await ctx.db.transaction((tx) => wm.saveCalibrationInTransaction(tx, {
      deveui: DEVEUI, userId: USER_ID, scoped: false, body: { ...CAL, expected_sync_version: 0 }
    }));
    assert.equal(res.row.sync_version, 1);
    assert.equal(res.first.converted, 1);
    assert.equal(res.first.more, false);
    assert.notEqual(ctx.native.prepare('SELECT ch1_status FROM watermark_readings').get().ch1_status, 'calibration_required');
  });

  it('when the caller transaction fails after the save, calibration and first batch roll back together', async () => {
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058]));
    await assert.rejects(ctx.db.transaction(async (tx) => {
      await wm.saveCalibrationInTransaction(tx, { deveui: DEVEUI, userId: USER_ID, scoped: false, body: { ...CAL, expected_sync_version: 0 } });
      throw new Error('ack insert failed');
    }), /ack insert failed/);
    assert.equal(ctx.native.prepare('SELECT count(*) c FROM watermark_calibrations').get().c, 0);
    assert.equal(ctx.native.prepare('SELECT ch1_status FROM watermark_readings').get().ch1_status, 'calibration_required');
  });

  it('a stale expected_sync_version throws 409 with currentSyncVersion', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, scoped: false, body: { ...CAL, expected_sync_version: 0 } });
    await assert.rejects(
      ctx.db.transaction((tx) => wm.saveCalibrationInTransaction(tx, { deveui: DEVEUI, userId: USER_ID, scoped: false, body: { ...CAL, expected_sync_version: 0 } })),
      (e) => e.statusCode === 409 && e.code === 'stale_sync_version' && e.currentSyncVersion === 1
    );
  });

  it('saveCalibrationInTransaction refuses a dry run', async () => {
    await assert.rejects(
      ctx.db.transaction((tx) => wm.saveCalibrationInTransaction(tx, { deveui: DEVEUI, userId: USER_ID, scoped: false, body: { ...CAL, dry_run: true } })),
      (e) => e.statusCode === 400
    );
  });

  it('deleteCalibrationInTransaction tombstones and bumps the version', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, scoped: false, body: { ...CAL, expected_sync_version: 0 } });
    const res = await ctx.db.transaction((tx) => wm.deleteCalibrationInTransaction(tx, { deveui: DEVEUI, userId: USER_ID, scoped: false, expectedSyncVersion: 1 }));
    assert.equal(res.sync_version, 2);
    const row = ctx.native.prepare('SELECT deleted_at, sync_version FROM watermark_calibrations').get();
    assert.ok(row.deleted_at);
    assert.equal(row.sync_version, 2);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/store.test.js`
Expected: FAIL — `wm.saveCalibrationInTransaction is not a function`.

- [ ] **Step 3: Implement the seam** (*untested sketch*, a mechanical extraction of the phase 1 code on main):

```js
async function saveCalibrationInTransaction(tx, { deveui, userId, scoped, body }) {
  const key = normalizeDeveui(deveui);
  const input = validateCalibrationBody(body);
  if (input.dryRun) throw httpError(400, 'invalid_body', 'A dry run is not a save');
  // --- moved verbatim from saveCalibration's transaction body ---
  await assertAccessibleLsn50(tx, key, { userId, scoped });
  const current = await readRow(tx, key);
  const currentVersion = current ? current.sync_version : 0;
  if (input.expectedSyncVersion !== currentVersion) {
    throw httpError(409, 'stale_sync_version', 'Calibration changed since it was loaded', { currentSyncVersion: currentVersion });
  }
  const live = current && !current.deleted_at ? current : null;
  const cols = VALUE_FIELDS.concat(META_FIELDS);
  const vals = cols.map((c) => {
    if (c in input.values) return input.values[c];
    if (c in input.meta) return input.meta[c];
    return live && live[c] != null ? live[c] : null;
  });
  await tx.run(/* the same INSERT … ON CONFLICT statement */);
  const row = await readRow(tx, key);
  const first = await backfillBatch(tx, key, row, null);
  return { row, first };
}

async function saveCalibration(db, args) {
  const key = normalizeDeveui(args.deveui);
  const input = validateCalibrationBody(args.body);
  if (input.dryRun) { /* unchanged dry-run branch */ }
  const saved = await db.transaction((tx) => saveCalibrationInTransaction(tx, args));
  const rest = await backfillRemaining(db, key, saved.row, saved.first);
  const result = {
    deveui: key, sync_version: saved.row.sync_version, calibration: publicCalibration(saved.row),
    backfilled: saved.first.converted + rest.converted
  };
  if (rest.error) result.backfill_incomplete = true;
  return result;
}
```

  `deleteCalibrationInTransaction(tx, …)` is the body of today's `deleteCalibration` transaction, keyed with `normalizeDeveui` and `parseExpectedVersion`. `deleteCalibration` wraps it in `db.transaction`. Export `saveCalibrationInTransaction`, `deleteCalibrationInTransaction`, `backfillRemaining`. Copy the file and the test to the bcm2709 tree.

- [ ] **Step 4: Run the helper tests and the route tests.**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/
node --test scripts/test-watermark-calibration-routes.js
node scripts/verify-profile-parity.js
```
Expected: all pass. The route suite and the fix round's batching tests are unchanged; they prove the REST shape and the batching did not move.

- [ ] **Step 5: Commit.**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-watermark-helper
git commit -m "refactor(watermark): transaction-scoped calibration writer for the command applier"
```

---

### Task E3: Migration 0062 — calibration outbox triggers

**Files:**
- Create: `database/migrations/ordered/0062__watermark_calibration_sync.sql`
- Modify: `database/migrations/ordered/CHECKSUMS.json`, `database/seed-blank.sql`, the 7 bundled `farming.db` (via `scripts/build-seed-db.js`)
- Modify: `scripts/verify-runtime-schema-parity.js` (`MIGRATION_OWNED_TRIGGERS`), `scripts/verify-trigger-body-parity.js` (`MIGRATION_OWNED_TRIGGER_NAMES`), `scripts/verify-db-schema-consistency.js` (`requiredTriggerSqlFragments`), `scripts/verify-sync-op-parity.js` (`SQL_OWNED_EVENT_OPS`), `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`, `scripts/reconcile-ledger-numbering.test.js`
- Create: `scripts/rehearse-watermark-calibration-sync.test.js`
- Modify: `.github/workflows/migrations.yml` (add the rehearsal test next to `rehearse-weather-station-zone-sync.test.js`, or wherever that test runs; grep for it)

**Interfaces:**
- Consumes: `watermark_calibrations` (0061), `sync_link_state(peer_node, linked, gateway_device_eui)`, `sync_outbox`.
- Produces:
  - triggers `trg_watermark_calibrations_outbox_ai` and `trg_watermark_calibrations_outbox_au`;
  - one outbox row per calibration write while linked: aggregate `WATERMARK_CALIBRATION`, key = deveui, `sync_version` = row version;
  - a payload that equals `WatermarkCalibration` (E1).

- [ ] **Step 1: Write the rehearsal test** `scripts/rehearse-watermark-calibration-sync.test.js`. It builds the DB from the seed, applies `0062` if the seed does not yet carry it, and exercises the triggers through the real phase 1 writer:

```js
#!/usr/bin/env node
'use strict';
// WATERMARK phase 2: migration 0062's outbox triggers, exercised through the
// real osi-watermark-helper writer. Run: node --test scripts/rehearse-watermark-calibration-sync.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const NR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const wm = require(path.join(NR, 'osi-watermark-helper'));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/sync-schema/watermark-calibration-v1-golden.json'), 'utf8'));
const MIGRATION = path.join(ROOT, 'database/migrations/ordered/0062__watermark_calibration_sync.sql');
const DEVEUI = 'A84041A171000001';
const GATEWAY = '0016C001F1000001';
const CAL = {
  pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
  pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27,
  measured_at: '2026-09-20T08:00:00.000Z', method: 'bench_resistors', worst_residual_pct: 0.6,
  notes: 'bench 2026-09-20, 0.996/9.97/29.95 kOhm'
};

function facade(native) {
  const scope = {
    get: async (sql, p) => native.prepare(sql).get(...(p || [])),
    all: async (sql, p) => native.prepare(sql).all(...(p || [])),
    run: async (sql, p) => { native.prepare(sql).run(...(p || [])); return undefined; }
  };
  return Object.assign({}, scope, {
    async transaction(fn) {
      native.exec('BEGIN IMMEDIATE');
      try { const r = await fn(scope); native.exec('COMMIT'); return r; } catch (e) { native.exec('ROLLBACK'); throw e; }
    }
  });
}

function fresh({ linked }) {
  const native = new DatabaseSync(':memory:');
  native.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  if (!native.prepare("SELECT 1 FROM sqlite_master WHERE name='trg_watermark_calibrations_outbox_au'").get()) {
    native.exec(fs.readFileSync(MIGRATION, 'utf8'));
  }
  const now = new Date().toISOString();
  native.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1,'operator','x',?)").run(now);
  native.prepare("INSERT INTO devices (deveui,name,type_id,user_id,created_at,updated_at) VALUES (?, 'WM', 'DRAGINO_LSN50', 1, ?, ?)").run(DEVEUI, now, now);
  if (linked) {
    native.prepare("INSERT OR REPLACE INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) VALUES('cloud',1,?,?)").run(GATEWAY, now);
  }
  return { native, db: facade(native) };
}
const outbox = (native) => native.prepare("SELECT op, aggregate_type, aggregate_key, sync_version, gateway_device_eui, payload_json FROM sync_outbox WHERE aggregate_type='WATERMARK_CALIBRATION' ORDER BY rowid").all();
const save = (db, v) => wm.saveCalibration(db, { deveui: DEVEUI, userId: 1, scoped: false, body: { ...CAL, expected_sync_version: v } });
const del = (db, v) => wm.deleteCalibration(db, { deveui: DEVEUI, userId: 1, scoped: false, expectedSyncVersion: v });

test('unlinked gateway: calibration writes emit nothing', async () => {
  const { native, db } = fresh({ linked: false });
  await save(db, 0);
  await del(db, 1);
  assert.equal(outbox(native).length, 0);
});

test('linked: first save, delete and re-save emit UPSERTED, DELETED, UPSERTED with the row version', async () => {
  const { native, db } = fresh({ linked: true });
  await save(db, 0);
  await del(db, 1);
  await save(db, 2);
  const rows = outbox(native);
  assert.deepEqual(rows.map((r) => [r.op, r.sync_version, r.aggregate_key, r.gateway_device_eui]), [
    ['WATERMARK_CALIBRATION_UPSERTED', 1, DEVEUI, GATEWAY],
    ['WATERMARK_CALIBRATION_DELETED', 2, DEVEUI, GATEWAY],
    ['WATERMARK_CALIBRATION_UPSERTED', 3, DEVEUI, GATEWAY],
  ]);
  const deleted = JSON.parse(rows[1].payload_json);
  assert.match(deleted.deleted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(JSON.parse(rows[2].payload_json).deleted_at, null);
});

test('linked: the payload has exactly the golden key set and golden values (JSON round trip)', async () => {
  const { native, db } = fresh({ linked: true });
  await save(db, 0);
  const payload = JSON.parse(outbox(native)[0].payload_json);
  const golden = GOLDEN.events[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(golden).sort());
  for (const k of Object.keys(golden)) {
    if (['sync_version', 'updated_at'].includes(k)) continue;
    assert.deepEqual(payload[k], golden[k], k);
  }
});

test('an UPDATE that does not bump sync_version emits nothing (every writer path bumps)', async () => {
  const { native, db } = fresh({ linked: true });
  await save(db, 0);
  native.prepare("UPDATE watermark_calibrations SET notes = 'hand edit' WHERE deveui = ?").run(DEVEUI);
  assert.equal(outbox(native).length, 1);
});

test('backfill updates device_data through the dirty-key path, not as calibration events', async () => {
  const { native, db } = fresh({ linked: true });
  // one accepted frame waiting for calibration, then a save that backfills it
  const writer = require(path.join(NR, 'osi-device-writer'));
  const manifest = JSON.parse(fs.readFileSync(path.join(NR, 'edge-channels.json'), 'utf8'));
  writer.resetColumnCache();
  const w = (v) => [(v >> 8) & 255, v & 255];
  const frame = Buffer.from([0xA2, 3, ...w(3300), ...w(1988), ...w(2146), 2, 0x20,
    ...w(800), ...w(800), ...w(3291), ...w(3291), 0x20, ...w(71), ...w(71), ...w(4058), ...w(4058)]).toString('base64');
  await wm.ingestProfile3(db, { deveui: DEVEUI, recordedAt: new Date(Date.now() - 3600e3).toISOString(), payloadB64: frame, fCnt: 1 },
    { clampRecordedAt: writer.clampRecordedAt, writeDeviceData: (tx, nr) => writer.writeDeviceData(tx, manifest, nr, { deveui: DEVEUI }, {}) });
  await save(db, 0);
  assert.equal(outbox(native).length, 1, 'one calibration event only');
  assert.equal(native.prepare("SELECT count(*) c FROM sync_outbox WHERE op = 'DEVICE_DATA_APPENDED'").get().c, 1, 'the insert event only');
  assert.ok(native.prepare('SELECT count(*) c FROM sync_history_dirty_keys').get().c >= 1, 'the backfill UPDATE travels as a dirty key');
});
```

  Two tests adapt to what the executor finds:
  - The last test assumes `sync_history_dirty_keys` exists in the seed and `trg_sync_device_data_dirty_au` fires while linked. If the seed does not carry that boot-owned trigger, create it from `sync-init-fn`'s text in the test the way `scripts/test-watermark-ingest-flow.js` does, or drop that assertion and keep the event-count assertions.
  - The golden `updated_at` differs per run, so the key-set check skips it. `gateway_device_eui` comes from `sync_link_state` because the fixture device has none.

- [ ] **Step 2: Run to verify failure.**

Run: `node --test scripts/rehearse-watermark-calibration-sync.test.js`
Expected: FAIL — `ENOENT … 0062__watermark_calibration_sync.sql`.

- [ ] **Step 3: Write the migration** `database/migrations/ordered/0062__watermark_calibration_sync.sql`. This SQL was run while planning: seed-blank + 0061 + this file in `node:sqlite`. Unlinked → 0 rows. Linked → UPSERTED v2, DELETED v3, UPSERTED v4. A non-bumping UPDATE → nothing. Payload values render as `41670.0`.

```sql
-- risk: additive
-- 0062: WATERMARK phase 2 (spec 2026-09-25 section 7) -- mirror
-- watermark_calibrations to the cloud. Migration-owned outbox triggers, gated
-- on a linked gateway (0047 precedent). Every write through
-- osi-watermark-helper bumps sync_version, so UPDATE emits on a version change
-- only; a tombstone (deleted_at set) emits WATERMARK_CALIBRATION_DELETED.

CREATE TRIGGER trg_watermark_calibrations_outbox_ai
AFTER INSERT ON watermark_calibrations
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
  AND COALESCE(
        NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
        NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
      ) IS NOT NULL
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'WATERMARK_CALIBRATION',
    NEW.deveui,
    CASE WHEN NEW.deleted_at IS NOT NULL THEN 'WATERMARK_CALIBRATION_DELETED' ELSE 'WATERMARK_CALIBRATION_UPSERTED' END,
    json_object(
      'contract_version', 1,
      'device_eui', NEW.deveui,
      'gateway_device_eui', COALESCE(
        NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
        NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')),
      'pullup_1_ohm', NEW.pullup_1_ohm,
      'pulldown_1_ohm', NEW.pulldown_1_ohm,
      'series_fwd_1_ohm', NEW.series_fwd_1_ohm,
      'series_rev_1_ohm', NEW.series_rev_1_ohm,
      'pullup_2_ohm', NEW.pullup_2_ohm,
      'pulldown_2_ohm', NEW.pulldown_2_ohm,
      'series_fwd_2_ohm', NEW.series_fwd_2_ohm,
      'series_rev_2_ohm', NEW.series_rev_2_ohm,
      'measured_at', NEW.measured_at,
      'method', NEW.method,
      'worst_residual_pct', NEW.worst_residual_pct,
      'notes', NEW.notes,
      'sync_version', NEW.sync_version,
      'updated_at', NEW.updated_at,
      'deleted_at', NEW.deleted_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    COALESCE(
      NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), ''))
  );
END;

CREATE TRIGGER trg_watermark_calibrations_outbox_au
AFTER UPDATE ON watermark_calibrations
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
  AND COALESCE(NEW.sync_version, 0) <> COALESCE(OLD.sync_version, 0)
  AND COALESCE(
        NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
        NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
      ) IS NOT NULL
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'WATERMARK_CALIBRATION',
    NEW.deveui,
    CASE WHEN NEW.deleted_at IS NOT NULL THEN 'WATERMARK_CALIBRATION_DELETED' ELSE 'WATERMARK_CALIBRATION_UPSERTED' END,
    json_object(
      'contract_version', 1,
      'device_eui', NEW.deveui,
      'gateway_device_eui', COALESCE(
        NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
        NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')),
      'pullup_1_ohm', NEW.pullup_1_ohm,
      'pulldown_1_ohm', NEW.pulldown_1_ohm,
      'series_fwd_1_ohm', NEW.series_fwd_1_ohm,
      'series_rev_1_ohm', NEW.series_rev_1_ohm,
      'pullup_2_ohm', NEW.pullup_2_ohm,
      'pulldown_2_ohm', NEW.pulldown_2_ohm,
      'series_fwd_2_ohm', NEW.series_fwd_2_ohm,
      'series_rev_2_ohm', NEW.series_rev_2_ohm,
      'measured_at', NEW.measured_at,
      'method', NEW.method,
      'worst_residual_pct', NEW.worst_residual_pct,
      'notes', NEW.notes,
      'sync_version', NEW.sync_version,
      'updated_at', NEW.updated_at,
      'deleted_at', NEW.deleted_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    COALESCE(
      NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), ''))
  );
END;
```

- [ ] **Step 4: Checksum, seed, lists, verifier registrations.**
  1. Checksum (the phase 1 Task 2 recipe with `file="0062__watermark_calibration_sync.sql"`):
     ```bash
     node -e 'const crypto=require("crypto"),fs=require("fs");const dir="database/migrations/ordered/";const file="0062__watermark_calibration_sync.sql";const m=JSON.parse(fs.readFileSync(dir+"CHECKSUMS.json","utf8"));m[file]=crypto.createHash("sha256").update(fs.readFileSync(dir+file)).digest("hex");fs.writeFileSync(dir+"CHECKSUMS.json",JSON.stringify(m,null,2)+"\n");'
     ```
  2. Append both `CREATE TRIGGER` statements verbatim to `database/seed-blank.sql`, directly after the `watermark_readings` indexes added by 0061.
  3. `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`: `through 0061` → `through 0062`, and append `62` to the applied list that now ends `…, 59, 60, 61]`. `scripts/reconcile-ledger-numbering.test.js`: append `62` to every list ending `…, 59, 60, 61]`.
  4. `scripts/verify-runtime-schema-parity.js` `MIGRATION_OWNED_TRIGGERS`: add both names → `'0062__watermark_calibration_sync.sql'`, with a two-line comment in the file's style.
  5. `scripts/verify-trigger-body-parity.js` `MIGRATION_OWNED_TRIGGER_NAMES`: add both names.
  6. `scripts/verify-db-schema-consistency.js` `requiredTriggerSqlFragments`:
     ```js
     trg_watermark_calibrations_outbox_ai: [
       "where peer_node = 'cloud' and linked = 1",
       "'watermark_calibration_deleted'",
       "'watermark_calibration_upserted'",
       "'series_rev_2_ohm', new.series_rev_2_ohm",
       "'deleted_at', new.deleted_at",
     ],
     trg_watermark_calibrations_outbox_au: [
       "where peer_node = 'cloud' and linked = 1",
       'coalesce(new.sync_version, 0) <> coalesce(old.sync_version, 0)',
       "'watermark_calibration_deleted'",
       "'series_rev_2_ohm', new.series_rev_2_ohm",
     ],
     ```
     The verifier lower-cases and normalises whitespace. If a fragment does not match, print the normalised SQL with the verifier's own normaliser and copy the fragment from it.
  7. `scripts/verify-sync-op-parity.js` `SQL_OWNED_EVENT_OPS`: add both ops with the comment `// Emitted by 0062__watermark_calibration_sync.sql's trg_watermark_calibrations_outbox_ai/_au triggers, not by flows.json.`

- [ ] **Step 5: Rebuild the bundled DBs.**

Run: `node scripts/build-seed-db.js`
Expected: all 7 `farming.db` written, `verifyHead` OK at 62.

- [ ] **Step 6: Run the gates.**

```bash
node --test scripts/rehearse-watermark-calibration-sync.test.js
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-seed-db-ledger.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
node --test lib/osi-migrate/__tests__/*.test.js
node --test scripts/reconcile-ledger-numbering.test.js
OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server-worktree>/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node scripts/verify-sync-op-parity.js
```
Expected:
- All exit 0, except `verify-sync-op-parity.js`, which **fails** until osi-server Task C2 adds the applier: it reports the two ops missing from `server`. Record that output here.
- The two long-running tests (`runner-preexisting-add-column-real`, `reconcile-ledger-numbering`) take ~15 min each; run them once, in the background.

- [ ] **Step 7: Commit.**

```bash
git add -A database scripts lib conf web/react-gui/farming.db .github
git commit -m "feat(schema): migration 0062 WATERMARK calibration outbox triggers (linked-gated)"
```

---

### Task E4: Command applier module

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.js`, `…/commands.test.js`
- Modify: `…/osi-watermark-helper/index.js` (spread `require('./commands')`)
- Modify: `deploy.sh` (after the `ingest.js` fetch_required block, line ~1654):
  ```sh
  fetch_required "osi-watermark-helper commands.js" \
      "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.js" \
      "/srv/node-red/osi-watermark-helper/commands.js"
  ```
- Mirror all of the above to the bcm2709 tree.

**Interfaces:**
- Consumes: E2's `saveCalibrationInTransaction` (→ `{ row, first }`), `deleteCalibrationInTransaction`, `VALUE_FIELDS`; tables `users(user_uuid, id, disabled_at)`, `devices`, `applied_commands`, `command_ack_outbox`; in scoped mode `runtime.scope_helper.assertFreshDeviceAccess(tx, actorUuid, deveui, { scopedMode: true })` and `.canMutate(role)`.
- Produces: `applyWatermarkCalibrationCommand(db, envelope, runtime)` → `{ handled: false }` or `{ handled: true, ack, backfill }`.
  - `envelope = { commandId: <positive safe integer>, commandType, payload }`.
  - `runtime = { gateway_device_eui, scopedMode, scope_helper }`.
  - `ack = { commandId, commandType, effectKey, gatewayDeviceEui, status: 'ACKED'|'CONFLICT'|'NACKED', result: 'APPLIED'|'CONFLICT'|'REJECTED_PERMANENT', reason, duplicate: false, appliedSyncVersion, appliedAt, target }`.
  - `backfill` is `{ deveui, row, first }` when an applied SET's first in-transaction batch reported `first.more === true`, otherwise `null`. The flow node passes it to `backfillRemaining(db, deveui, row, first)` after the ack.
  - Throws (no ack, command stays pending) on a bad envelope id, a missing runtime gateway EUI, scoped mode without a scope helper, or an SQLite error.

- [ ] **Step 1: Write the failing tests** `commands.test.js` (runs against the real seed + 0062, using the `store.test.js` facade):

```js
'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const NR = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(NR, '../../../../../..');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs/contracts/sync-schema/watermark-calibration-v1-golden.json'), 'utf8'));
const wm = require('.');
const scope = require(path.join(NR, 'osi-scope-helper'));

const DEVEUI = 'A84041A171000001';
const GATEWAY = '0016C001F1000001';
const ACTOR = '12345678-1234-4234-8234-123456789abc';
const OTHER = '99999999-1234-4234-8234-123456789abc';
const SET = GOLDEN.commands[0];
const DEL = GOLDEN.commands[1];

function facade(native) { /* same as store.test.js */ }
function fresh() {
  const native = new DatabaseSync(':memory:');
  native.exec(fs.readFileSync(path.join(REPO_ROOT, 'database/seed-blank.sql'), 'utf8'));
  const now = new Date().toISOString();
  native.prepare("INSERT INTO users (id, username, password_hash, created_at, user_uuid) VALUES (1,'operator','x',?,?)").run(now, ACTOR);
  native.prepare("INSERT INTO users (id, username, password_hash, created_at, user_uuid) VALUES (2,'other','x',?,?)").run(now, OTHER);
  native.prepare("INSERT INTO devices (deveui,name,type_id,user_id,gateway_device_eui,created_at,updated_at) VALUES (?, 'WM', 'DRAGINO_LSN50', 1, ?, ?, ?)").run(DEVEUI, GATEWAY, now, now);
  return { native, db: facade(native) };
}
const runtime = { gateway_device_eui: GATEWAY, scopedMode: false, scope_helper: null };
const envelope = (commandId, payload) => ({ commandId, commandType: payload.command_type, payload });
const withBase = (cmd, base) => Object.assign({}, cmd, {
  base_sync_version: base,
  effect_key: (cmd.command_type === 'SET_WATERMARK_CALIBRATION' ? 'watermark_calibration:' : 'watermark_calibration_delete:') + DEVEUI + ':' + base
});

describe('applyWatermarkCalibrationCommand', () => {
  let ctx;
  beforeEach(() => { ctx = fresh(); });

  it('ignores other command types', async () => {
    assert.deepEqual(await wm.applyWatermarkCalibrationCommand(ctx.db, { commandId: 1, commandType: 'UPSERT_DEVICE_NAME', payload: {} }, runtime), { handled: false });
  });

  it('SET at the current version applies, acks APPLIED with the new version and queues the ack; no backfill left over', async () => {
    const res = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(11, withBase(SET, 0)), runtime);
    assert.equal(res.handled, true);
    assert.equal(res.ack.result, 'APPLIED');
    assert.equal(res.ack.status, 'ACKED');
    assert.equal(res.ack.appliedSyncVersion, 1);
    assert.equal(res.ack.target, DEVEUI);
    assert.equal(res.backfill, null, 'no waiting readings, so the first in-transaction batch finished everything');
    const row = ctx.native.prepare('SELECT pullup_1_ohm, method, notes, sync_version FROM watermark_calibrations').get();
    assert.deepEqual({ ...row }, { pullup_1_ohm: 41670, method: 'bench_resistors', notes: null, sync_version: 1 });
    assert.equal(ctx.native.prepare("SELECT result FROM applied_commands WHERE command_id='11'").get().result, 'APPLIED');
    assert.equal(ctx.native.prepare("SELECT count(*) c FROM command_ack_outbox WHERE command_id='11'").get().c, 1);
  });

  it('SET with omitted metadata keeps the stored metadata (fix-round semantics)', async () => {
    await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(11, withBase(SET, 0)), runtime);
    const values = Object.assign({}, SET.values); for (const k of ['measured_at', 'method', 'worst_residual_pct', 'notes']) delete values[k];
    await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(12, Object.assign(withBase(SET, 1), { values })), runtime);
    assert.equal(ctx.native.prepare('SELECT method FROM watermark_calibrations').get().method, 'bench_resistors');
  });

  it('SET at a stale version acks CONFLICT stale_sync_version with the current version and changes nothing', async () => {
    await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(11, withBase(SET, 0)), runtime);
    const stale = Object.assign(withBase(SET, 0), { values: Object.assign({}, SET.values, { pullup_1_ohm: 50000 }) });
    const res = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(12, stale), runtime);
    assert.equal(res.ack.result, 'CONFLICT');
    assert.equal(res.ack.status, 'CONFLICT');
    assert.equal(res.ack.reason, 'stale_sync_version');
    assert.equal(res.ack.appliedSyncVersion, 1);
    assert.equal(res.backfill, null);
    assert.equal(ctx.native.prepare('SELECT pullup_1_ohm FROM watermark_calibrations').get().pullup_1_ohm, 41670);
  });

  it('a replayed delivery id returns the stored ack and applies nothing twice', async () => {
    const first = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(11, withBase(SET, 0)), runtime);
    const again = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(11, withBase(SET, 0)), runtime);
    assert.deepEqual(again.ack, first.ack);
    assert.equal(again.backfill, null);
    assert.equal(ctx.native.prepare('SELECT sync_version FROM watermark_calibrations').get().sync_version, 1);
  });

  it('DELETE tombstones; DELETE without a live calibration is REJECTED_PERMANENT calibration_not_found', async () => {
    const none = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(20, withBase(DEL, 1)), runtime);
    assert.equal(none.ack.result, 'REJECTED_PERMANENT');
    assert.equal(none.ack.reason, 'calibration_not_found');
    await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(21, withBase(SET, 0)), runtime);
    const ok = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(22, withBase(DEL, 1)), runtime);
    assert.equal(ok.ack.result, 'APPLIED');
    assert.equal(ok.ack.appliedSyncVersion, 2);
  });

  it('rejects out-of-range values as invalid_calibration without writing', async () => {
    const bad = Object.assign(withBase(SET, 0), { values: Object.assign({}, SET.values, { series_fwd_1_ohm: 501 }) });
    const res = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(30, bad), runtime);
    assert.equal(res.ack.result, 'REJECTED_PERMANENT');
    assert.equal(res.ack.reason, 'invalid_calibration');
    assert.equal(ctx.native.prepare('SELECT count(*) c FROM watermark_calibrations').get().c, 0);
  });

  it('rejects a malformed effect key, another gateway, an unknown device and a disabled or non-owner actor', async () => {
    const cases = [
      [Object.assign(withBase(SET, 0), { effect_key: 'watermark_calibration:' + DEVEUI + ':9' }), 'malformed_command'],
      [Object.assign(withBase(SET, 0), { gateway_device_eui: 'FFFFFFFFFFFFFFFF' }), 'gateway_mismatch'],
      [Object.assign(withBase(SET, 0), { device_eui: 'AAAAAAAAAAAAAAAA', effect_key: 'watermark_calibration:AAAAAAAAAAAAAAAA:0' }), 'device_not_found'],
      [Object.assign(withBase(SET, 0), { actor_user_uuid: OTHER }), 'forbidden'],
    ];
    let id = 40;
    for (const [payload, reason] of cases) {
      const res = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(id++, payload), runtime);
      assert.equal(res.ack.result, 'REJECTED_PERMANENT', reason);
      assert.equal(res.ack.reason, reason);
    }
    ctx.native.prepare("UPDATE users SET disabled_at = '2026-01-01' WHERE id = 1").run();
    const disabled = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(id++, withBase(SET, 0)), runtime);
    assert.equal(disabled.ack.reason, 'actor_missing_or_disabled');
    assert.equal(ctx.native.prepare('SELECT count(*) c FROM watermark_calibrations').get().c, 0);
  });

  it('scoped mode: an unassigned actor is forbidden, and the scope helper is required', async () => {
    await assert.rejects(wm.applyWatermarkCalibrationCommand(ctx.db, envelope(50, withBase(SET, 0)), { gateway_device_eui: GATEWAY, scopedMode: true, scope_helper: null }));
    const res = await wm.applyWatermarkCalibrationCommand(ctx.db, envelope(51, Object.assign(withBase(SET, 0), { actor_user_uuid: OTHER })),
      { gateway_device_eui: GATEWAY, scopedMode: true, scope_helper: scope });
    assert.equal(res.ack.result, 'REJECTED_PERMANENT');
    assert.ok(['forbidden', 'actor_missing_or_disabled'].includes(res.ack.reason));
  });

  it('a runtime without a valid gateway EUI throws before writing anything', async () => {
    await assert.rejects(wm.applyWatermarkCalibrationCommand(ctx.db, envelope(60, withBase(SET, 0)), { gateway_device_eui: 'UNKNOWN' }));
    assert.equal(ctx.native.prepare('SELECT count(*) c FROM applied_commands').get().c, 0);
  });
});
```

  The scoped-mode `OTHER` case depends on how `osi-scope-helper` treats a user with no role or grants. If it answers 404 (no access), the reason is `forbidden`. The test accepts either stable reason. Pin whichever the helper produces in a comment.

- [ ] **Step 2: Run to verify failure.**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.test.js`
Expected: FAIL — `wm.applyWatermarkCalibrationCommand is not a function`.

- [ ] **Step 3: Implement `commands.js`** (*untested sketch*, modelled line for line on `osi-entity-name/commands.js`):

```js
'use strict';
// osi-watermark-helper/commands.js -- receiver for SET_WATERMARK_CALIBRATION and
// DELETE_WATERMARK_CALIBRATION (spec 2026-09-25 section 7 and 13). Modelled on
// osi-entity-name/commands.js: ONE transaction covers the replay check,
// parsing, authorization, the calibration write (with the first backfill
// batch, as the REST save does), the applied_commands row and the
// command_ack_outbox row. Any further backfill batches run after commit
// (calibration.backfillRemaining), one transaction each.
//
// The scope helper is never required here: the flow node passes it in only in
// scoped mode, so the flag-off path stays hermetic
// (scripts/verify-auth-flag-off-hermetic.js).
const calibration = require('./calibration');

const TYPES = {
  SET_WATERMARK_CALIBRATION: 'watermark_calibration',
  DELETE_WATERMARK_CALIBRATION: 'watermark_calibration_delete',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EUI = /^[0-9A-F]{16}$/;
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const META_FIELDS = ['measured_at', 'method', 'worst_residual_pct', 'notes'];
const VALUE_KEYS = new Set(calibration.VALUE_FIELDS.concat(META_FIELDS));

function rejection(result, reason, message) {
  const error = new Error(message);
  error.code = 'watermark_command_rejected';
  error.result = result;
  error.reason = reason;
  return error;
}
const reject = (reason, message) => rejection('REJECTED_PERMANENT', reason, message);
const canonicalEui = (v) => String(v == null ? '' : v).trim().toUpperCase();
const canonicalUuid = (v) => String(v == null ? '' : v).trim().toLowerCase();

function parse(type, payload, gateway) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw reject('malformed_command', 'payload must be an object');
  if (String(payload.command_type || '') !== type) throw reject('malformed_command', 'payload command_type differs from the envelope');
  if (!UUID.test(canonicalUuid(payload.command_id))) throw reject('malformed_command', 'command_id must be a canonical UUID');
  const actor = canonicalUuid(payload.actor_user_uuid);
  if (!UUID.test(actor)) throw reject('malformed_command', 'actor_user_uuid must be a canonical UUID');
  const requestedAt = String(payload.requested_at == null ? '' : payload.requested_at).trim();
  if (!UTC_MS.test(requestedAt) || !Number.isFinite(Date.parse(requestedAt))) throw reject('malformed_command', 'requested_at must be a UTC timestamp with milliseconds');
  const deveui = canonicalEui(payload.device_eui);
  if (!EUI.test(deveui)) throw reject('malformed_command', 'device_eui must be 16 upper-case hex digits');
  const base = payload.base_sync_version;
  if (!Number.isSafeInteger(base) || base < 0) throw reject('malformed_command', 'base_sync_version must be a non-negative integer');
  if (String(payload.effect_key || '') !== TYPES[type] + ':' + deveui + ':' + base) throw reject('malformed_command', 'effect_key does not bind this device and base version');
  if (canonicalEui(payload.gateway_device_eui) !== gateway) throw reject('gateway_mismatch', 'command names another gateway');
  let values = null;
  if (type === 'SET_WATERMARK_CALIBRATION') {
    values = payload.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw reject('malformed_command', 'values must be an object');
    const extra = Object.keys(values).filter((k) => !VALUE_KEYS.has(k));
    if (extra.length) throw reject('malformed_command', 'unknown values keys: ' + extra.join(','));
  }
  return { actor, deveui, base, values, effectKey: payload.effect_key };
}

async function authorize(tx, parsed, gateway, runtime) {
  const actor = await tx.get('SELECT id, disabled_at FROM users WHERE user_uuid = ? LIMIT 1', [parsed.actor]);
  if (!actor || actor.disabled_at) throw reject('actor_missing_or_disabled', 'actor account is missing or disabled');
  const device = await tx.get(
    "SELECT deveui, user_id, gateway_device_eui FROM devices WHERE deveui = ? AND type_id = 'DRAGINO_LSN50' AND deleted_at IS NULL LIMIT 1",
    [parsed.deveui]
  );
  if (!device) throw reject('device_not_found', 'LSN50 device not found');
  const bound = canonicalEui(device.gateway_device_eui);
  if (bound && bound !== gateway) throw reject('gateway_mismatch', 'device belongs to another gateway');
  if (runtime.scopedMode === true) {
    const helper = runtime.scope_helper;
    if (!helper || typeof helper.assertFreshDeviceAccess !== 'function') {
      const error = new Error('scoped mode without a scope helper');
      error.code = 'invalid_watermark_command_runtime';
      throw error; // not a rejection: the command stays pending for retry
    }
    let access;
    try {
      access = await helper.assertFreshDeviceAccess(tx, parsed.actor, parsed.deveui, { scopedMode: true });
    } catch (error) {
      const status = Number(error.statusCode || error.status);
      if (status === 403) throw reject('actor_missing_or_disabled', error.message);
      if (status === 404) throw reject('forbidden', error.message);
      throw error;
    }
    if (!helper.canMutate(access.role)) throw reject('forbidden', 'actor may not change this calibration');
    return { scoped: true, userId: null };
  }
  if (device.user_id == null || Number(device.user_id) !== Number(actor.id)) throw reject('forbidden', 'actor does not own this device');
  return { scoped: false, userId: actor.id };
}

// Writer errors -> acknowledgement. Anything unmapped is rethrown and the
// command stays pending (retryable), exactly like osi-entity-name.
function fromWriterError(error) {
  if (error && error.code === 'stale_sync_version') {
    const conflict = rejection('CONFLICT', 'stale_sync_version', error.message);
    conflict.currentSyncVersion = Number.isSafeInteger(error.currentSyncVersion) ? error.currentSyncVersion : null;
    return conflict;
  }
  if (error && [400, 404].includes(Number(error.statusCode))) return reject(String(error.code || 'invalid_calibration'), error.message);
  return null;
}

async function queueAck(tx, ack) {
  await tx.run('DELETE FROM command_ack_outbox WHERE command_id = ? AND delivered_at IS NULL', [String(ack.commandId)]);
  await tx.run('INSERT INTO command_ack_outbox(command_id, payload_json, created_at) VALUES (?, ?, ?)', [String(ack.commandId), JSON.stringify(ack), ack.appliedAt]);
}

async function applyWatermarkCalibrationCommand(db, envelope, runtime = {}) {
  const type = String((envelope && envelope.commandType) || '');
  if (!Object.prototype.hasOwnProperty.call(TYPES, type)) return { handled: false };
  const id = envelope.commandId;
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error('invalid protected delivery envelope');
    error.code = 'invalid_watermark_command';
    throw error;
  }
  const gateway = canonicalEui(runtime.gateway_device_eui);
  if (!EUI.test(gateway)) {
    const error = new Error('runtime gateway EUI is missing or invalid');
    error.code = 'invalid_watermark_command';
    throw error;
  }
  return db.transaction(async (tx) => {
    const previous = await tx.get('SELECT result_detail FROM applied_commands WHERE command_id = ?', [String(id)]);
    if (previous) {
      const stored = JSON.parse(previous.result_detail);
      await queueAck(tx, stored);
      return { handled: true, ack: stored, backfill: null };
    }
    let result = 'APPLIED';
    let reason = null;
    let target = null;
    let effectKey = null;
    let appliedSyncVersion = null;
    let backfill = null;
    try {
      const parsed = parse(type, envelope.payload, gateway);
      target = parsed.deveui;
      effectKey = parsed.effectKey;
      const access = await authorize(tx, parsed, gateway, runtime);
      try {
        if (type === 'SET_WATERMARK_CALIBRATION') {
          const saved = await calibration.saveCalibrationInTransaction(tx, {
            deveui: parsed.deveui, userId: access.userId, scoped: access.scoped,
            body: Object.assign({}, parsed.values, { expected_sync_version: parsed.base })
          });
          appliedSyncVersion = saved.row.sync_version;
          if (saved.first && saved.first.more) backfill = { deveui: parsed.deveui, row: saved.row, first: saved.first };
        } else {
          const deleted = await calibration.deleteCalibrationInTransaction(tx, {
            deveui: parsed.deveui, userId: access.userId, scoped: access.scoped, expectedSyncVersion: parsed.base
          });
          appliedSyncVersion = deleted.sync_version;
        }
      } catch (writerError) {
        const mapped = fromWriterError(writerError);
        if (!mapped) throw writerError;
        throw mapped;
      }
    } catch (error) {
      if (error.code !== 'watermark_command_rejected') throw error;
      result = error.result;
      reason = error.reason;
      if (error.currentSyncVersion != null) appliedSyncVersion = error.currentSyncVersion;
    }
    const ack = {
      commandId: id,
      commandType: type,
      effectKey,
      gatewayDeviceEui: gateway,
      status: result === 'APPLIED' ? 'ACKED' : (result === 'CONFLICT' ? 'CONFLICT' : 'NACKED'),
      result,
      reason,
      duplicate: false,
      appliedSyncVersion,
      appliedAt: new Date().toISOString(),
      target,
    };
    await tx.run(
      'INSERT INTO applied_commands(command_id, device_eui, command_type, effect_key, applied_at, result, result_detail, originator) VALUES (?,?,?,?,?,?,?,?)',
      [String(id), gateway, type, effectKey, ack.appliedAt, result, JSON.stringify(ack), 'cloud']
    );
    await queueAck(tx, ack);
    return { handled: true, ack, backfill: result === 'APPLIED' ? backfill : null };
  });
}

module.exports = { applyWatermarkCalibrationCommand, WATERMARK_COMMAND_TYPES: Object.keys(TYPES) };
```

  Notes for the implementer:
  - The phase 1 writer's `assertAccessibleLsn50` already re-checks the device and owner inside the same transaction; the checks here fix the ack reason.
  - `effect_key` is stored in `applied_commands`. The shared ledger (`osi-command-ledger.validNonJournalEffectBinding`) does not recognise the `watermark_calibration:` grammar, so `command-dedupe-dispatch` passes these commands through. Dedup is the `command_id` check above, the same as `osi-entity-name`.
  - Update `index.js`: `module.exports = Object.assign({}, conversion, calibration, ingest, require('./commands'));`.

- [ ] **Step 4: Run the helper tests and the registration gates.**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/
node scripts/verify-helper-registration.js
node scripts/verify-profile-parity.js
bash -n deploy.sh
```
Expected: all pass. `verify-helper-registration.js` may require new files to be listed in `deploy.sh`; it passes because of the fetch line added above.

- [ ] **Step 5: Commit.**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-watermark-helper deploy.sh
git commit -m "feat(watermark): SET/DELETE_WATERMARK_CALIBRATION command applier"
```

---

### Task E5: Flows — applier node, registry, capability `watermark_v1`

**Files:**
- Modify: both `flows.json` (bcm2712 canonical, bcm2709 mirror)
- Create: `scripts/test-watermark-calibration-command-path.js`
- Modify: `scripts/test-entity-name-command-path.js` (wiring + capability regex), `scripts/test-flows-wiring.js` (entity-name wires; add the new applier check), `scripts/verify-sync-flow.js` (wire expectations, lines ~2098–2100), `scripts/test-journal-bootstrap.js` (`EXPECTED_CAPABILITIES`, `slice(0, 5)` → `slice(0, 6)`), `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: `scripts/fixtures/sync-contract-staging.json` and `scripts/verify-sync-contract.js` if E1 had to stage the command types as edge-deferred. Unstage them now.
- Modify: `.github/workflows/verify-sync-flow.yml` (or the workflow that runs `test-entity-name-command-path.js`): add the new test file.

**Interfaces:**
- Consumes: E4's `applyWatermarkCalibrationCommand`; E2's `backfillRemaining`; osi-lib names `osi-db-helper`, `watermark-helper`, `scope`.
- Produces:
  - node `watermark-calibration-command-apply-fn` ("Apply WATERMARK Calibration Command"), wired `entity-name-command-apply-fn` out 0 → it; its out 0 → `934bf2bc19a8ce22` (Route Command); its out 1 → `9d5e3035c3d069c4` (Command ACK → Cloud);
  - registry entries `SET_WATERMARK_CALIBRATION` / `DELETE_WATERMARK_CALIBRATION` → `{ dispatch: 'watermark_calibration_apply', actuator: false, requires_duration: false }` in both `cmd-type-registry` and the `COMMAND_TYPES_FALLBACK` of `reject-indefinite-open`;
  - capability string `'watermark_v1'` appended after `'entity_name_commands_v1'` in `al-link-build-req`, `sync-bootstrap-build`, `sync-force-build`.

- [ ] **Step 1: Write the failing test** `scripts/test-watermark-calibration-command-path.js`. It runs the shipped node source through the harness with the real helper and a seeded DB:

```js
#!/usr/bin/env node
'use strict';
// Command path for SET/DELETE_WATERMARK_CALIBRATION: pins the registry, the
// fallback table, the three capability builders and the wiring, and runs the
// shipped watermark-calibration-command-apply-fn with the real helper.
// Run: node --test scripts/test-watermark-calibration-command-path.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction } = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const GATEWAY = '0016C001F1000001';
const DEVEUI = 'A84041A171000001';
const ACTOR = '12345678-1234-4234-8234-123456789abc';
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/sync-schema/watermark-calibration-v1-golden.json'), 'utf8'));
const loadFlows = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_' + p + '/files/usr/share/flows.json'), 'utf8'));

function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, username, password_hash, created_at, user_uuid) VALUES (1,'operator','x',?,?)").run(now, ACTOR);
  db.prepare("INSERT INTO devices (deveui,name,type_id,user_id,gateway_device_eui,created_at,updated_at) VALUES (?, 'WM', 'DRAGINO_LSN50', 1, ?, ?, ?)").run(DEVEUI, GATEWAY, now, now);
  return db;
}
function message(commandId, payload) {
  return { _commandTypeRecognized: true, payload: { commandId, commandType: payload.command_type, command_type: payload.command_type, _pendingCommandEnvelope: { commandId, commandType: payload.command_type, payload } } };
}
const set0 = Object.assign({}, GOLDEN.commands[0], { base_sync_version: 0, effect_key: 'watermark_calibration:' + DEVEUI + ':0' });

test('registry and fallback list both command types, on both profiles', () => {
  for (const p of PROFILES) {
    const flows = loadFlows(p);
    for (const id of ['cmd-type-registry', 'reject-indefinite-open']) {
      const func = flows.find((n) => n.id === id).func;
      for (const type of ['SET_WATERMARK_CALIBRATION', 'DELETE_WATERMARK_CALIBRATION']) {
        assert.match(func, new RegExp(type + ":\\s*\\{\\s*dispatch:\\s*'watermark_calibration_apply'"), p + ' ' + id + ' ' + type);
      }
    }
  }
});

test('all three capability builders advertise watermark_v1 after entity_name_commands_v1', () => {
  for (const p of PROFILES) {
    const flows = loadFlows(p);
    for (const id of ['sync-bootstrap-build', 'al-link-build-req', 'sync-force-build']) {
      assert.match(flows.find((n) => n.id === id).func,
        /const syncCapabilities = \['linked_auth_sync_v1', 'force_edge_sync_v1', 'installation_recovery_v1', 'installation_locations_v1', 'entity_name_commands_v1', 'watermark_v1'\];/, p + ' ' + id);
    }
  }
});

test('the applier sits between entity-name and Route Command', () => {
  for (const p of PROFILES) {
    const flows = loadFlows(p);
    const upstream = flows.find((n) => n.id === 'entity-name-command-apply-fn');
    const applier = flows.find((n) => n.id === 'watermark-calibration-command-apply-fn');
    assert.deepEqual(upstream.wires, [['watermark-calibration-command-apply-fn'], ['9d5e3035c3d069c4']], p);
    assert.deepEqual(applier.wires, [['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']], p);
    assert.deepEqual(applier.libs, [{ var: 'osiLib', module: 'osi-lib' }], p);
    assert.equal(applier.outputs, 2, p);
    assert.equal(applier.z, upstream.z, p);
  }
});

test('flag off: a SET applies, sends one ack, never loads the scope helper, passes other types through', async () => {
  const node = loadFlows('bcm2712').find((n) => n.id === 'watermark-calibration-command-apply-fn');
  const db = seeded();
  const loaded = [];
  const sent = [];
  const realHelper = require(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper'));
  const out = await executeFunction(Object.assign({}, node, { func: node.func.replace(/node\.send\(/g, '__send(') }), {
    msg: message(101, set0), db, env: { DEVICE_EUI: GATEWAY },
    osiLibModules: { 'watermark-helper': realHelper },
    globals: {},
    libOverrides: {},
  });
  // Note: if the harness exposes no hook for node.send, assert on command_ack_outbox instead (below).
  assert.deepEqual(out.errors, []);
  assert.equal(db.prepare("SELECT result FROM applied_commands WHERE command_id='101'").get().result, 'APPLIED');
  assert.equal(db.prepare("SELECT count(*) c FROM command_ack_outbox WHERE command_id='101'").get().c, 1);
  const passthrough = await executeFunction(node, { msg: message(102, { command_type: 'UPSERT_DEVICE_NAME' }), db, env: { DEVICE_EUI: GATEWAY } });
  assert.ok(Array.isArray(passthrough.result) && passthrough.result[0] && passthrough.result[1] === null);
});
```

  The harness's `node` object has no `send`. Extend `scripts/lib/scoped-access-harness.js` `executeFunction` with an optional `sent` array (`send: (m) => sent.push(m)`). That is a one-line, backward-compatible change. Then assert exactly one MQTT ack message with topic `devices/0016C001F1000001/command_ack` and `JSON.parse(payload).result === 'APPLIED'`. Remove the `replace(/node\.send…/)` workaround above once the harness supports it.

- [ ] **Step 2: Run to verify failure.**

Run: `node --test scripts/test-watermark-calibration-command-path.js`
Expected: FAIL — the registry assertion (no `SET_WATERMARK_CALIBRATION`).

- [ ] **Step 3: Edit both flows with a one-shot script** in the scratchpad (skeleton from `osi-flows-json-editing`: roundtrip guard, mutate, write canonical, write mirror, re-guard). The mutations:
  1. Push the new node (`type: 'function'`, `z` = `entity-name-command-apply-fn`'s `z`, `x` +200, `y` = the entity-name node's `y`, `outputs: 2`, `libs: [{ var: 'osiLib', module: 'osi-lib' }]`, `wires: [['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']]`) with this `func` (*untested sketch*; keep it under the 4096-char new-node ceiling):

```js
return (async () => {
  let cmd;
  try {
    cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.error('WATERMARK command parse failed closed: ' + String(parseError && parseError.message ? parseError.message : parseError), msg);
    return [null, null];
  }
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    node.error('WATERMARK command has no protected delivery envelope', msg);
    return [null, null];
  }
  const commandType = String(envelope.commandType || '').trim().toUpperCase();
  if (commandType !== 'SET_WATERMARK_CALIBRATION' && commandType !== 'DELETE_WATERMARK_CALIBRATION') return [msg, null];
  // Scope helper only in scoped mode: the flag-off path must never load it.
  const scopedMode = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  const loads = [osiLib.require('osi-db-helper'), osiLib.require('watermark-helper')];
  if (scopedMode) loads.push(osiLib.require('scope'));
  const failed = loads.filter(function(load) { return !load.ok; });
  if (failed.length) {
    node.error('WATERMARK command helpers unavailable: ' + failed.map(function(load) { return load.error; }).join('; '), msg);
    return [null, null];
  }
  const helper = loads[1].value;
  const gatewayEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
  const db = new loads[0].value.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const result = await helper.applyWatermarkCalibrationCommand(db, envelope, {
      gateway_device_eui: gatewayEui,
      scopedMode: scopedMode,
      scope_helper: scopedMode ? loads[2].value : null
    });
    if (!result.handled) return [msg, null];
    // The ack leaves before any remaining backfill batches: they run one
    // transaction each and must not hold the cloud's answer.
    node.send([null, { topic: 'devices/' + gatewayEui + '/command_ack', payload: JSON.stringify(result.ack), qos: 1 }]);
    if (result.backfill) {
      try {
        const rest = await helper.backfillRemaining(db, result.backfill.deveui, result.backfill.row, result.backfill.first);
        if (rest && rest.error) node.warn('WATERMARK backfill incomplete after a cloud calibration; the next save converts the rest: ' + String(rest.error.message || rest.error));
      } catch (backfillError) {
        node.warn('WATERMARK backfill after a cloud calibration failed: ' + String(backfillError && backfillError.message ? backfillError.message : backfillError));
      }
    }
    return [null, null];
  } catch (error) {
    node.error('WATERMARK command apply failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('WATERMARK command DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();
```

  2. `entity-name-command-apply-fn.wires[0]` → `['watermark-calibration-command-apply-fn']`.
  3. In `cmd-type-registry` and in `reject-indefinite-open`'s `COMMAND_TYPES_FALLBACK`, insert after the `UPSERT_ZONE_NAME` line:
     ```
         SET_WATERMARK_CALIBRATION:    { dispatch: 'watermark_calibration_apply', actuator: false,   requires_duration: false  },
         DELETE_WATERMARK_CALIBRATION: { dispatch: 'watermark_calibration_apply', actuator: false,   requires_duration: false  },
     ```
     Use string replacement on the `func` text inside the script, asserting exactly one match each.
  4. In `al-link-build-req`, `sync-bootstrap-build`, `sync-force-build`: replace `'entity_name_commands_v1'];` with `'entity_name_commands_v1', 'watermark_v1'];`, asserting exactly one match per node.

- [ ] **Step 4: Update the pinned tests.**
  - `scripts/test-entity-name-command-path.js:556`: `applier.wires` → `[['watermark-calibration-command-apply-fn'], ['9d5e3035c3d069c4']]`; its capability regex (line ~545) gains `, 'watermark_v1'`.
  - `scripts/test-flows-wiring.js` (entity-name block ~line 460): expected wires become `[['watermark-calibration-command-apply-fn'], ['9d5e3035c3d069c4']]`. Add an equivalent block for the new node using `requireOsiLibContract(node, [OSI_DB_BINDING, <watermark binding>], 'WATERMARK calibration commands: applier', 'WATERMARK command helpers unavailable:')`. Define the binding constant the way `OSI_ENTITY_NAME_BINDING` is defined; grep it.
  - `scripts/verify-sync-flow.js` ~2098: replace `expectWireById('entity-name-command-apply-fn', '934bf2bc19a8ce22', …)` with two lines:
    ```js
    expectWireById('entity-name-command-apply-fn', 'watermark-calibration-command-apply-fn', 'routes non-name commands through the WATERMARK calibration applier');
    expectWireById('watermark-calibration-command-apply-fn', '934bf2bc19a8ce22', 'falls through other commands to the existing router');
    expectWireById('watermark-calibration-command-apply-fn', '9d5e3035c3d069c4', 'publishes atomically persisted WATERMARK calibration ACKs');
    ```
  - `scripts/test-journal-bootstrap.js`: `EXPECTED_CAPABILITIES` gains `'watermark_v1'` after `'entity_name_commands_v1'`; `EXPECTED_CAPABILITIES.slice(0, 5)` → `slice(0, 6)`.
  - `AGENTS.md` is updated in E8.

- [ ] **Step 5: Measure the size ratchet and record allowances.**

Run: `node scripts/verify-flows-size-ratchet.js --base-ref origin/main`
Expected before the edit: FAIL, with per-node growth for:
- `cmd-type-registry`, `reject-indefinite-open`, `al-link-build-req`, `sync-bootstrap-build`, `sync-force-build`, `entity-name-command-apply-fn` (wires);
- the new node (under 4096, so no ceiling entry);
- the per-profile total.

Add or raise `node_allowances` entries with the exact measured deltas. Where a node already has an entry, replace it with the new cumulative delta and keep its reason. Raise `total_allowance.delta` by the exact per-profile growth, prepending a reason and carrying the prior one forward (phase 1 precedent). Re-run: PASS.

- [ ] **Step 6: Run the gates.**

```bash
node --test scripts/test-watermark-calibration-command-path.js
node --test scripts/test-entity-name-command-path.js
node scripts/test-flows-wiring.js
node --test scripts/test-journal-bootstrap.js
node scripts/verify-sync-flow.js
node scripts/verify-sync-contract.js
node scripts/verify-auth-flag-off-hermetic.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js --base-ref origin/main
node scripts/verify-live-gateway-identity.js
node scripts/verify-profile-parity.js
```
Expected: all pass. `verify-sync-flow.js` ends `Sync flow verification passed` and `All parity checks passed.`. `verify-auth-flag-off-hermetic.js` reports 0 nodes reaching `scope`.

- [ ] **Step 7: Commit.**

```bash
git add conf scripts .github
git commit -m "feat(flows): apply WATERMARK calibration commands; advertise watermark_v1"
```

---

### Task E6: Bootstrap and force sync carry `watermark_calibrations`

**Files:**
- Modify: both `flows.json` (`sync-bootstrap-build`, `sync-force-build`)
- Create: `scripts/test-watermark-calibration-bootstrap.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`, the workflow that runs `test-valve-actuation-bootstrap.js` (add the new test beside it)

**Interfaces:**
- Consumes: `watermark_calibrations`, `devices`, `sync_link_state`; each node's `q(sql)` SELECT runner (the `test-valve-actuation-bootstrap.js` precedent).
- Produces: a bootstrap payload top-level key `watermark_calibrations` (snake_case, like `valve_settings`): an array of `WatermarkCalibration` objects, tombstones included, only for devices that are not deleted. Consumed by osi-server C3.

- [ ] **Step 1: Write the failing test** `scripts/test-watermark-calibration-bootstrap.js`. It extracts the block between markers from both nodes on both profiles (the `test-valve-actuation-bootstrap.js` pattern) and runs it against a seeded DB with 0062 applied and the gateway linked. It asserts:
  - (a) one element per calibration row, tombstones included, none for a soft-deleted device;
  - (b) for the same row, the bootstrap element deep-equals `JSON.parse` of the `payload_json` the 0062 trigger wrote. This is the one-shape rule;
  - (c) the key set equals the golden event payload's key set.

  Markers:
  - start `const watermarkCalibrationRows = await q(`
  - end `const watermarkCalibrations = watermarkCalibrationRows.map((r) => Object.assign({ contract_version: 1 }, r));`

  The runner:
  ```js
  const runner = new Function('q', `return (async () => {\n${block}\n  return watermarkCalibrations;\n})();`);
  ```

- [ ] **Step 2: Run to verify failure.**

Run: `node --test scripts/test-watermark-calibration-bootstrap.js`
Expected: FAIL — `watermarkCalibrationRows query not found in node func`.

- [ ] **Step 3: Edit both nodes** (one-shot script, both profiles). Insert this block after the `valveActuations` block in each node. The key order matches the trigger's `json_object`:

```js
  const watermarkCalibrationRows = await q("SELECT wc.deveui AS device_eui, COALESCE(NULLIF(trim(d.gateway_device_eui), ''), NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')) AS gateway_device_eui, wc.pullup_1_ohm, wc.pulldown_1_ohm, wc.series_fwd_1_ohm, wc.series_rev_1_ohm, wc.pullup_2_ohm, wc.pulldown_2_ohm, wc.series_fwd_2_ohm, wc.series_rev_2_ohm, wc.measured_at, wc.method, wc.worst_residual_pct, wc.notes, wc.sync_version, wc.updated_at, wc.deleted_at FROM watermark_calibrations wc JOIN devices d ON d.deveui = wc.deveui AND d.deleted_at IS NULL ORDER BY wc.deveui");
  const watermarkCalibrations = watermarkCalibrationRows.map((r) => Object.assign({ contract_version: 1 }, r));
```

  Add `watermark_calibrations: watermarkCalibrations,` to the `msg.payload = { … }` object after `valve_actuations`. In `sync-bootstrap-build` that object currently ends with `irrigationEvents`; check `sync-force-build`'s equivalent literal and add it there too.
  - `node:sqlite` returns REAL columns as JS numbers, and the request body is `JSON.stringify`'d, so `41670.0` becomes `41670`, the same as the event path.
  - The `gateway_device_eui` COALESCE matches the trigger. A row whose gateway resolves to null still ships; the cloud rejects that item alone (bootstrap `RejectedItem`), and the edge logs it.
  - This block is DDL-free, so `verify-no-stray-ddl.js` is unaffected. Confirm by running it.

- [ ] **Step 4: Measure the ratchet** (Task E5 Step 5 procedure) for the two nodes, and update allowances.

- [ ] **Step 5: Run the gates.**

```bash
node --test scripts/test-watermark-calibration-bootstrap.js
node --test scripts/test-valve-actuation-bootstrap.js
node --test scripts/test-journal-bootstrap.js
node scripts/verify-sync-flow.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-flows-size-ratchet.js --base-ref origin/main
node scripts/verify-profile-parity.js
```
Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add conf scripts .github
git commit -m "feat(sync): bootstrap and force sync carry watermark_calibrations"
```

---

### Task E7: WATERMARK MQTT telemetry from the ingest node (decision P2-7)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/ingest.js` (+ bcm2709 copy): return the stored values.
- Modify: `…/osi-watermark-helper/store.test.js` (+ bcm2709 copy)
- Modify: both `flows.json`: `watermark-ingest-fn` gains one output wired to `9b38464d56b05ae0` ("Telemetry → Cloud").
- Modify: `scripts/test-watermark-ingest-flow.js` (new cases), `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces:**
- Consumes: `ingestProfile3` on main (phase 1, `ca08dcc13`). Today it returns:
  - `{ accepted: true, recordedAt, statuses }`
  - `{ accepted: false, reason, recordedAt }`
  - `unknown_device` → no rows.
- Produces:
  - `ingestProfile3` additionally returns, on an accepted frame, `telemetry: { swt_1, swt_2, ext_temperature_c, supply_mv, statuses }`, the exact values written to `device_data` and the raw row.
  - `watermark-ingest-fn` emits on output 0 `{ topic: 'devices/<DEVICE_EUI>/telemetry', payload: <JSON string> }`, where `payload` = `{ deviceEui, deviceType: 'DRAGINO_LSN50', timestamp: recordedAt, swt_1, swt_2, ext_temperature_c, bat_v: null, supply_mv, watermark_statuses }`.
    - A `frame_rejected` or `unknown_device` frame emits the same message with every value `null` and `watermark_statuses: null`: liveness and auto-create only.
    - A thrown ingest error emits nothing.
- `Build Telemetry` is not touched. Its phase 1 FPort 11 drop and its pinned cases (j)/(k) stay.

- [ ] **Step 1: Write the failing tests.**
  - `store.test.js`: extend the first `ingestProfile3` test so that, after calibration (or with `CAL` pre-inserted), `res.telemetry` deep-equals `{ swt_1: <kPa as stored in device_data>, swt_2: …, ext_temperature_c: 19.88, supply_mv: 3300, statuses: [...] }`. The test reads the expected values back from `device_data` and `watermark_readings`, not from literals, so it pins "telemetry = what was stored".
  - A rejected frame returns no `telemetry` key.
  - `scripts/test-watermark-ingest-flow.js`: new cases (m)–(o) running the shipped `watermark-ingest-fn`:
    - (m) an accepted FPort 11 frame yields exactly one output message with the topic above and `JSON.parse(payload)` matching the stored row: `deviceType 'DRAGINO_LSN50'`, `bat_v === null`, `timestamp === device_data.recorded_at`;
    - (n) a frame from an unregistered DevEUI yields one liveness-only message (all values null) and writes no rows;
    - (o) a malformed 26-byte frame yields one liveness-only message and one `frame_rejected` raw row.

    Use the harness this test file already uses to run function nodes; extend it to capture the node's return value if it does not already.

- [ ] **Step 2: Run to verify failure.**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/store.test.js
node scripts/test-watermark-ingest-flow.js
```
Expected: FAIL — `res.telemetry` undefined; case (m) finds no output (the node has `outputs: 0` and returns `null`).

- [ ] **Step 3: Implement** (*untested sketch*).

  In `ingest.js`, the accepted branch's return becomes:

```js
    const telemetry = {
      swt_1: result.channels[0].kpa,
      swt_2: result.channels[1].kpa,
      ext_temperature_c: measuredSoilTemperature(parsed.frame),
      supply_mv: parsed.frame.supply_mv,
      statuses: result.channels.map((c) => c.status)
    };
    return { accepted: true, recordedAt, statuses: telemetry.statuses, telemetry };
```

  In `watermark-ingest-fn` (one-shot flows script, both profiles; `outputs: 1`, `wires: [['9b38464d56b05ae0']]`), replace the tail so the node returns a telemetry message:

```js
let out = null;
const piEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
const liveness = (recordedAt) => ({ deviceEui: String(d.devEui || '').trim().toUpperCase(), deviceType: 'DRAGINO_LSN50',
  timestamp: recordedAt || d.timestamp || new Date().toISOString(), swt_1: null, swt_2: null,
  ext_temperature_c: null, bat_v: null, supply_mv: null, watermark_statuses: null });
try {
  const res = await helperRes.value.ingestProfile3(db, { /* unchanged */ }, { /* unchanged */ });
  /* unchanged node.status / node.warn lines */
  const body = res.accepted
    ? Object.assign(liveness(res.recordedAt), {
        swt_1: res.telemetry.swt_1, swt_2: res.telemetry.swt_2,
        ext_temperature_c: res.telemetry.ext_temperature_c, supply_mv: res.telemetry.supply_mv,
        watermark_statuses: res.telemetry.statuses })
    : liveness(res.recordedAt);
  // Cloud liveness and auto-create (osi-os spec section 13, decision P2-7).
  // Gateway-forwarded sensor telemetry is not persisted canonically by the
  // cloud (MqttMessageRouter); it refreshes last_seen and creates an unknown
  // board in the unclaimed pool.
  if (/^[0-9A-F]{16}$/.test(piEui)) out = { topic: 'devices/' + piEui + '/telemetry', payload: JSON.stringify(body) };
} catch (e) {
  node.error('WATERMARK ingest failed for ' + d.devEui + ': ' + e.message);
} finally {
  await new Promise((resolve) => db.close(() => resolve()));
}
return out;
```

  Check how `Build Telemetry` derives `piEui` (`env.get('DEVICE_EUI')` or a flow context value) and use the same source, so both telemetry publishers name the same gateway topic.

- [ ] **Step 4: Measure the ratchet** (Task E5 Step 5 procedure) for `watermark-ingest-fn`, and update its allowance or ceiling entry.

- [ ] **Step 5: Run.**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/
node scripts/test-watermark-ingest-flow.js
node scripts/verify-sync-flow.js
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js --base-ref origin/main
node scripts/verify-profile-parity.js
```
Expected: all pass. Phase 1's cases (a)–(l) stay green (on main, (l) pins complete device-list objects): FPort 2 and `Build Telemetry` are unchanged.

- [ ] **Step 6: Commit.**

```bash
git add conf scripts
git commit -m "feat(flows): WATERMARK MQTT telemetry from the ingest node for cloud liveness"
```

---

### Task E8: Docs and the edge gate sweep

**Files:**
- Modify: `AGENTS.md`:
  - the command list (line ~53) gains `SET_WATERMARK_CALIBRATION`, `DELETE_WATERMARK_CALIBRATION`;
  - a paragraph after the entity-name one: applied by `watermark-calibration-command-apply-fn`, sent only to a gateway that reported `watermark_v1`, stale version → `CONFLICT stale_sync_version`;
  - the capability list gains `watermark_v1`;
  - the migration-owned trigger list, if AGENTS.md keeps one, gains `0062`.
- Modify: `.claude/skills/osi-sync-contract-awareness/SKILL.md`: one "Verified sources" bullet for `watermark-calibration-v1-golden.json` (byte-mirrored to osi-server).
- Modify: `docs/contracts/sync-schema/README.md` if not already done in E1.

- [ ] **Step 1: Write the docs** (load the `anti-slop-writing` skill first; plain declarative sentences).

- [ ] **Step 2: Full edge gate sweep** (run each and paste real output into the execution report):

```bash
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server-worktree>/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node scripts/verify-sync-op-parity.js
node scripts/verify-sync-flow.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/
node --test scripts/rehearse-watermark-calibration-sync.test.js
node --test scripts/test-watermark-calibration-command-path.js
node --test scripts/test-watermark-calibration-bootstrap.js
node --test scripts/test-watermark-calibration-routes.js
node scripts/test-watermark-ingest-flow.js   # includes E7's cases (m)-(o)
node --test scripts/test-entity-name-command-path.js
node scripts/test-flows-wiring.js
node --test scripts/test-journal-bootstrap.js
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-seed-db-ledger.js
node scripts/verify-db-schema-consistency.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-trigger-body-parity.js
node scripts/verify-devices-rebuild-fence.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-profile-parity.js
node scripts/verify-auth-flag-off-hermetic.js && node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js --base-ref origin/main
node scripts/verify-helper-registration.js
```

  Expected:
  - Every gate exits 0.
  - `verify-sync-op-parity.js` is green only against the osi-server branch after C2. Against osi-server `main` it reports the two ops missing from `server`; that is the expected pre-merge state and is why the cloud lands first.
  - The run ends with the mirror byte check:
    ```bash
    bash -c 'S=<osi-server-worktree>/backend/src/test/resources/sync-contract; for f in resources.schema.json watermark-calibration-v1-golden.json effect-keys.md canonicalization.md rejection-recovery-v1.json; do cmp docs/contracts/sync-schema/$f $S/$f && echo "same $f"; done'
    ```
    Expected: five `same …` lines. This passes only after osi-server C2 has vendored the files.

- [ ] **Step 3: Commit.**

```bash
git add AGENTS.md .claude/skills docs/contracts/sync-schema/README.md
git commit -m "docs: WATERMARK calibration sync, commands and the watermark_v1 capability"
```

---

# Part C — osi-server (cloud)

All paths are relative to `<osi-server-worktree>`. Backend test command per task: `cd backend && ./gradlew test --tests '<pattern>'`. If Testcontainers ITs fail to start locally, set `api.version=1.44` in `~/.docker-java.properties` (AGENTS.md).

### Task C1: Flyway, entities and the `watermark_v1` capability

**Files:**
- Create: `backend/src/main/resources/db/migration/V2026_09_27_001__watermark_calibration_mirror.sql`
- Create: `backend/src/main/java/org/osi/server/watermark/WatermarkCalibrationMirror.java`, `WatermarkCalibrationMirrorRepository.java`
- Modify: `backend/src/main/java/org/osi/server/device/Device.java` (`watermarkCalibrated`)
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewayAccount.java` (`watermarkSupported`), `LinkedGatewayAccountService.java` (`WATERMARK_V1 = "watermark_v1"`, set in `applyEdgeCapabilities`), `LinkedGatewaySyncService.java` (`LinkedGatewaySummary.watermarkSupported`, passed in `summary(...)`)
- Test: `backend/src/test/java/org/osi/server/user/LinkedGatewayAccountServiceTest.java` (or the test class that covers `applyEdgeCapabilities`; grep `setWeatherStationZonesDesiredStateSupported` in tests)

**Interfaces:**
- Produces:
  - table `watermark_calibration_mirrors` and entity `WatermarkCalibrationMirror` (`deviceEui` @Id, `gatewayEui`, 8 `Double` values, `measuredAt Instant`, `method`, `worstResidualPct Double`, `notes`, `syncVersion long`, `edgeUpdatedAt Instant`, `deletedAt Instant`, `mirroredAt Instant`);
  - `WatermarkCalibrationMirrorRepository extends JpaRepository<WatermarkCalibrationMirror, String>`;
  - `Device.isWatermarkCalibrated()` / `setWatermarkCalibrated(boolean)`;
  - `LinkedGatewayAccount.isWatermarkSupported()`;
  - `LinkedGatewaySummary.watermarkSupported`.

- [ ] **Step 1: Write the failing capability test.** Next to the existing capability tests, assert that `syncCapabilities = ["linked_auth_sync_v1", "WATERMARK_V1 "]` sets `account.isWatermarkSupported()` to `true`, and that an empty list leaves it `false`. Follow the existing test's construction of the service and account exactly.

- [ ] **Step 2: Run to verify failure.**

Run: `cd backend && ./gradlew test --tests 'org.osi.server.user.LinkedGatewayAccountServiceTest'`
Expected: compilation FAIL (`isWatermarkSupported` missing).

- [ ] **Step 3: Implement.** Migration:

```sql
-- WATERMARK 200SS on the Dragino LSN50, phase 2 (osi-os spec 2026-09-25 section 7):
-- the mirror of the edge-authored calibration, the device-level indicator the
-- cloud derives from it (osi-os spec section 13, decision P2-1), and the
-- gateway capability that gates SET/DELETE_WATERMARK_CALIBRATION.
CREATE TABLE watermark_calibration_mirrors (
    device_eui          VARCHAR(32)      PRIMARY KEY,
    gateway_eui         VARCHAR(32)      NOT NULL,
    pullup_1_ohm        DOUBLE PRECISION NOT NULL,
    pulldown_1_ohm      DOUBLE PRECISION NOT NULL,
    series_fwd_1_ohm    DOUBLE PRECISION NOT NULL,
    series_rev_1_ohm    DOUBLE PRECISION NOT NULL,
    pullup_2_ohm        DOUBLE PRECISION NOT NULL,
    pulldown_2_ohm      DOUBLE PRECISION NOT NULL,
    series_fwd_2_ohm    DOUBLE PRECISION NOT NULL,
    series_rev_2_ohm    DOUBLE PRECISION NOT NULL,
    measured_at         TIMESTAMPTZ,
    method              VARCHAR(64),
    worst_residual_pct  DOUBLE PRECISION,
    notes               VARCHAR(500),
    sync_version        BIGINT           NOT NULL,
    edge_updated_at     TIMESTAMPTZ      NOT NULL,
    deleted_at          TIMESTAMPTZ,
    mirrored_at         TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX idx_watermark_calibration_mirrors_gateway ON watermark_calibration_mirrors (gateway_eui);

ALTER TABLE devices ADD COLUMN watermark_calibrated BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE linked_gateway_accounts ADD COLUMN watermark_supported BOOLEAN NOT NULL DEFAULT FALSE;
```

  Entity: Lombok `@Entity @Table(name = "watermark_calibration_mirrors") @Data @Builder @NoArgsConstructor @AllArgsConstructor`, in the `WeatherStationZoneSyncState` style. `Device`:
  ```java
  @Column(name = "watermark_calibrated", nullable = false)
  @Builder.Default
  private boolean watermarkCalibrated = false;
  ```
  Copy the `soilMoistureProbeDepthsConfigured` style. `LinkedGatewayAccount`: the same shape as `weatherStationZonesDesiredStateSupported`.

- [ ] **Step 4: Run.**

Run: `cd backend && ./gradlew test --tests 'org.osi.server.user.*' --tests 'org.osi.server.ArchitectureTest'`, then `sh scripts/verify-flyway-ordering.sh`
Expected: PASS; ordering OK (re-date the file if `origin/main` moved).

- [ ] **Step 5: Commit.**

```bash
git add backend
git commit -m "feat(watermark): calibration mirror table, device indicator and watermark_v1 capability"
```

---

### Task C2: Contract vendoring, event applier, resource ref, ownership

**Files:**
- Copy byte-for-byte from osi-os: `docs/contracts/sync-schema/resources.schema.json` → `backend/src/test/resources/sync-contract/resources.schema.json`; `docs/contracts/sync-schema/watermark-calibration-v1-golden.json` → `backend/src/test/resources/sync-contract/watermark-calibration-v1-golden.json`
- Modify (server-owned copies, server formatting): `backend/src/test/resources/sync-contract/events.schema.json` (2 ops, 2 bindings, the two `allOf` blocks from E1 re-indented), `…/commands.schema.json` (2 types, 2 `allOf` blocks), `…/sync-contract-golden.json`:
  - both ops in `eventOperations.accepted`, `edgeProducerEnabled`, `serverHandlerEnabled`;
  - both types in `commandTypes.accepted`, `cloudIssuerEnabled`;
  - a capability `{"name": "watermark_v1", "schemaAccepted": true, "edgeProducerEnabled": true, "cloudIssuerEnabled": true}`.
- Modify: `scripts/verify-edge-sync-contract-vendor.sh` (`files` += `watermark-calibration-v1-golden.json`), `backend/src/test/java/org/osi/server/sync/SyncContractVendorTest.java` (`EDGE_OWNED_FILES` += the golden file)
- Create: `backend/src/main/java/org/osi/server/sync/WatermarkCalibrationApplier.java`, `backend/src/test/java/org/osi/server/sync/WatermarkCalibrationApplierTest.java`
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java` (`EventResourceRef.resourceTypeFromOp`, `resourceIdForType`), `backend/src/main/java/org/osi/server/security/EdgeOwnershipService.java`
- Test: `EdgeOwnershipServiceTest`, the `EventResourceRef` test (grep `resourceTypeFromOp` in tests), `SyncOpCoverageTest`, `SyncContractVendorTest`

**Interfaces:**
- Consumes: C1 entities; the golden file; `SyncEventShapes` helpers (`payloadWithOp`, `str`, `numLong`, `numDoubleObj`, `parseNullableInstant`, `nullableStr`, `isStale`); `EdgeStrings.requireBounded`.
- Produces:
  - `WatermarkCalibrationApplier implements SyncEventApplier` (package-private, `@Component`) with `supportedOps() = {WATERMARK_CALIBRATION_UPSERTED, WATERMARK_CALIBRATION_DELETED}`;
  - resource type `WATERMARK_CALIBRATION` whose resource id is the upper-case device EUI;
  - an ownership rule that resolves through the device row, with bootstrap-allow when the device is absent. The applier's `Device not found …` then makes the event retryable.

- [ ] **Step 1: Write the failing applier test** (Mockito, `ValveActuationApplierTest` style):

```java
package org.osi.server.sync;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.osi.server.device.Device;
import org.osi.server.device.DeviceRepository;
import org.osi.server.watermark.WatermarkCalibrationMirror;
import org.osi.server.watermark.WatermarkCalibrationMirrorRepository;

import java.io.InputStream;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class WatermarkCalibrationApplierTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String GW = "0016C001F1000001";
    private static final String EUI = "A84041A171000001";

    @Mock private WatermarkCalibrationMirrorRepository mirrors;
    @Mock private DeviceRepository devices;

    private EdgeSyncService.SyncEventRecord golden(int index) throws Exception {
        try (InputStream in = getClass().getClassLoader().getResourceAsStream("sync-contract/watermark-calibration-v1-golden.json")) {
            JsonNode e = MAPPER.readTree(in).path("events").get(index);
            @SuppressWarnings("unchecked")
            Map<String, Object> payload = MAPPER.convertValue(e.path("payload"), LinkedHashMap.class);
            return new EdgeSyncService.SyncEventRecord("evt-" + index, e.path("aggregateType").asText(), e.path("aggregateKey").asText(),
                    e.path("op").asText(), e.path("syncVersion").asLong(), "2026-09-26T10:00:00.000Z", payload);
        }
    }
    private Device lsn50() { return Device.builder().deviceEui(EUI).type("DRAGINO_LSN50").gatewayDeviceEui(GW).build(); }

    @Test void upsertMirrorsEveryFieldAndMarksTheDeviceCalibrated() throws Exception {
        WatermarkCalibrationApplier applier = new WatermarkCalibrationApplier(mirrors, devices);
        Device device = lsn50();
        when(devices.findByDeviceEui(EUI)).thenReturn(Optional.of(device));
        when(mirrors.findById(EUI)).thenReturn(Optional.empty());
        applier.apply(GW, golden(0));
        ArgumentCaptor<WatermarkCalibrationMirror> saved = ArgumentCaptor.forClass(WatermarkCalibrationMirror.class);
        verify(mirrors).save(saved.capture());
        WatermarkCalibrationMirror m = saved.getValue();
        assertThat(m.getPullup1Ohm()).isEqualTo(41670.0);
        assertThat(m.getSeriesRev2Ohm()).isEqualTo(27.0);
        assertThat(m.getWorstResidualPct()).isEqualTo(0.6);
        assertThat(m.getMeasuredAt()).isEqualTo(Instant.parse("2026-09-20T08:00:00.000Z"));
        assertThat(m.getSyncVersion()).isEqualTo(3L);
        assertThat(m.getDeletedAt()).isNull();
        assertThat(m.getGatewayEui()).isEqualTo(GW);
        assertThat(device.isWatermarkCalibrated()).isTrue();
        verify(devices).save(device);
    }

    @Test void deleteKeepsTheValuesAsATombstoneAndClearsTheIndicator() throws Exception {
        WatermarkCalibrationApplier applier = new WatermarkCalibrationApplier(mirrors, devices);
        Device device = lsn50(); device.setWatermarkCalibrated(true);
        when(devices.findByDeviceEui(EUI)).thenReturn(Optional.of(device));
        when(mirrors.findById(EUI)).thenReturn(Optional.empty());
        applier.apply(GW, golden(1));
        assertThat(device.isWatermarkCalibrated()).isFalse();
    }

    @Test void anOlderVersionThanTheMirrorIsIgnored() throws Exception {
        WatermarkCalibrationApplier applier = new WatermarkCalibrationApplier(mirrors, devices);
        when(devices.findByDeviceEui(EUI)).thenReturn(Optional.of(lsn50()));
        when(mirrors.findById(EUI)).thenReturn(Optional.of(WatermarkCalibrationMirror.builder().deviceEui(EUI).syncVersion(9L).build()));
        applier.apply(GW, golden(0));
        verify(mirrors, never()).save(any());
    }

    @Test void aMissingDeviceIsTheRetryableParentMiss() throws Exception {
        WatermarkCalibrationApplier applier = new WatermarkCalibrationApplier(mirrors, devices);
        when(devices.findByDeviceEui(EUI)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> applier.apply(GW, golden(0)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageStartingWith("Device not found");
    }

    @Test void aNonLsn50DeviceAndAnOpDeletedAtMismatchAreTerminal() throws Exception {
        WatermarkCalibrationApplier applier = new WatermarkCalibrationApplier(mirrors, devices);
        when(devices.findByDeviceEui(EUI)).thenReturn(Optional.of(Device.builder().deviceEui(EUI).type("KIWI_SENSOR").gatewayDeviceEui(GW).build()));
        assertThatThrownBy(() -> applier.apply(GW, golden(0))).isInstanceOf(IllegalArgumentException.class)
                .satisfies(e -> assertThat(e.getMessage()).doesNotStartWith("Device not found"));
        EdgeSyncService.SyncEventRecord upsert = golden(0);
        Map<String, Object> wrong = new LinkedHashMap<>(upsert.payload()); wrong.put("deleted_at", "2026-09-26T11:00:00.000Z");
        when(devices.findByDeviceEui(EUI)).thenReturn(Optional.of(lsn50()));
        assertThatThrownBy(() -> applier.apply(GW, new EdgeSyncService.SyncEventRecord("x", upsert.aggregateType(), EUI, upsert.op(), 3L, null, wrong)))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
```

  Add to the `EventResourceRef` test (or a new small test) that `EventResourceRef.from(GW, golden(0))` → `("WATERMARK_CALIBRATION", "A84041A171000001")`. Add to `EdgeOwnershipServiceTest`:
  - `WATERMARK_CALIBRATION` for a device owned by `GW` → `requireMutate` passes;
  - owned by another gateway → `OwnershipDeniedException`;
  - absent device → allowed (bootstrap-allow).

- [ ] **Step 2: Vendor the contract and run to verify failure.**

```bash
bash -c 'O=<osi-os-worktree>/docs/contracts/sync-schema; S=backend/src/test/resources/sync-contract; cp $O/resources.schema.json $S/; cp $O/watermark-calibration-v1-golden.json $S/'
cd backend && ./gradlew test --tests 'org.osi.server.sync.WatermarkCalibrationApplierTest' --tests 'org.osi.server.sync.SyncOpCoverageTest' --tests 'org.osi.server.sync.SyncContractVendorTest'
```
Expected: compile FAIL (`WatermarkCalibrationApplier` missing). After it compiles but before dispatch exists, `SyncOpCoverageTest` fails naming both ops as undispatched.

- [ ] **Step 3: Implement the applier** (*untested sketch*):

```java
package org.osi.server.sync;

import lombok.RequiredArgsConstructor;
import org.osi.server.device.Device;
import org.osi.server.device.DeviceRepository;
import org.osi.server.device.DeviceType;
import org.osi.server.watermark.WatermarkCalibrationMirror;
import org.osi.server.watermark.WatermarkCalibrationMirrorRepository;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Mirrors the edge-authored WATERMARK calibration (osi-os migration 0062,
 * spec 2026-09-25 section 7). One row per device; a DELETED event keeps the
 * values and sets deleted_at (tombstone). The edge is authoritative: this is
 * the only writer of watermark_calibration_mirrors and of
 * devices.watermark_calibrated (bootstrap rows come through here too).
 *
 * <p>"Device not found" is matched literally by SyncEventTxExecutor.isParentMissing,
 * so a calibration that beats its DEVICE event is retried, not dead-lettered.
 */
@Component
@RequiredArgsConstructor
class WatermarkCalibrationApplier implements SyncEventApplier {

    static final String UPSERTED = "WATERMARK_CALIBRATION_UPSERTED";
    static final String DELETED = "WATERMARK_CALIBRATION_DELETED";

    private final WatermarkCalibrationMirrorRepository mirrorRepository;
    private final DeviceRepository deviceRepository;

    @Override
    public Set<String> supportedOps() {
        return Set.of(UPSERTED, DELETED);
    }

    @Override
    public void apply(String gatewayDeviceEui, EdgeSyncService.SyncEventRecord event) {
        Map<String, Object> payload = SyncEventShapes.payloadWithOp(event);
        String raw = SyncEventShapes.str(payload, "device_eui", "deviceEui");
        if (raw == null || raw.isBlank()) {
            throw new IllegalArgumentException("WATERMARK calibration payload missing device_eui");
        }
        String eui = EdgeStrings.requireBounded(raw.trim().toUpperCase(Locale.ROOT), 32, "watermark_calibration.device_eui");
        Device device = deviceRepository.findByDeviceEui(eui).orElseThrow(() ->
                new IllegalArgumentException("Device not found for WATERMARK calibration sync: " + eui));
        if (!DeviceType.DRAGINO_LSN50.equalsIgnoreCase(device.getType())) {
            throw new IllegalArgumentException("WATERMARK calibration names a non-LSN50 device: " + eui);
        }
        long incoming = SyncEventShapes.numLong(payload, "sync_version", "syncVersion", -1L);
        if (incoming < 1) {
            throw new IllegalArgumentException("WATERMARK calibration sync_version must be >= 1");
        }
        WatermarkCalibrationMirror mirror = mirrorRepository.findById(eui)
                .orElseGet(() -> WatermarkCalibrationMirror.builder().deviceEui(eui).build());
        if (mirror.getSyncVersion() != null && SyncEventShapes.isStale(incoming, mirror.getSyncVersion())) {
            return;
        }
        Instant deletedAt = SyncEventShapes.parseNullableInstant(payload, "deleted_at", "deletedAt");
        if (DELETED.equals(event.op()) != (deletedAt != null)) {
            throw new IllegalArgumentException("WATERMARK calibration op and deleted_at disagree");
        }
        mirror.setPullup1Ohm(required(payload, "pullup_1_ohm"));
        mirror.setPulldown1Ohm(required(payload, "pulldown_1_ohm"));
        mirror.setSeriesFwd1Ohm(required(payload, "series_fwd_1_ohm"));
        mirror.setSeriesRev1Ohm(required(payload, "series_rev_1_ohm"));
        mirror.setPullup2Ohm(required(payload, "pullup_2_ohm"));
        mirror.setPulldown2Ohm(required(payload, "pulldown_2_ohm"));
        mirror.setSeriesFwd2Ohm(required(payload, "series_fwd_2_ohm"));
        mirror.setSeriesRev2Ohm(required(payload, "series_rev_2_ohm"));
        mirror.setMeasuredAt(SyncEventShapes.parseNullableInstant(payload, "measured_at", "measuredAt"));
        mirror.setMethod(EdgeStrings.requireBounded(SyncEventShapes.nullableStr(payload, "method"), 64, "watermark_calibration.method"));
        mirror.setWorstResidualPct(SyncEventShapes.numDoubleObj(payload, "worst_residual_pct", "worstResidualPct"));
        mirror.setNotes(EdgeStrings.requireBounded(SyncEventShapes.nullableStr(payload, "notes"), 500, "watermark_calibration.notes"));
        mirror.setGatewayEui(EdgeStrings.requireBounded(SyncEventShapes.normalizeGatewayDeviceEui(
                Optional.ofNullable(device.getGatewayDeviceEui()).orElse(gatewayDeviceEui)), 32, "watermark_calibration.gateway_eui"));
        mirror.setSyncVersion(incoming);
        mirror.setEdgeUpdatedAt(Optional.ofNullable(SyncEventShapes.parseNullableInstant(payload, "updated_at", "updatedAt")).orElse(Instant.now()));
        mirror.setDeletedAt(deletedAt);
        mirror.setMirroredAt(Instant.now());
        mirrorRepository.save(mirror);
        device.setWatermarkCalibrated(deletedAt == null);
        deviceRepository.save(device);
    }

    private static Double required(Map<String, Object> payload, String key) {
        Double value = SyncEventShapes.numDoubleObj(payload, key);
        if (value == null || !Double.isFinite(value)) {
            throw new IllegalArgumentException("WATERMARK calibration payload missing " + key);
        }
        return value;
    }
}
```

  Check each `SyncEventShapes` helper's exact signature (`numDoubleObj(Map, String...)`, `numLong(Map, String, String, long)`, `nullableStr(Map, String...)`) and adapt.

  `EdgeSyncService.EventResourceRef`:
  - `resourceTypeFromOp`: before the `DEVICE_` fallback, add
    ```java
    if (op.startsWith("WATERMARK_CALIBRATION_")) {
        return "WATERMARK_CALIBRATION";
    }
    ```
    Nothing else starts with `WATERMARK_`, but without this case the op would fall to `"EVENT"`, get no ownership case, and dead-letter.
  - `resourceIdForType`: add `case "WATERMARK_CALIBRATION" ->` to the `"DEVICE", "DEVICE_DATA", "VALVE_SETTINGS"` arm (device_eui, else aggregateKey).

  `EdgeOwnershipService`:
  - add `"WATERMARK_CALIBRATION"` to the `case "DEVICE", "DEVICE_DATA", …` arm of `resolveOwnerEui`;
  - add it to `DEVICE_ZONE_BOOTSTRAP_ALLOWED`, with a javadoc paragraph mirroring the VALVE_SETTINGS one: opening it grants nothing, because the applier throws `Device not found …` (retryable) and never creates a device.

- [ ] **Step 4: Update the server-owned contract copies and golden fixture** (lists in **Files** above), then run:

```bash
cd backend && ./gradlew test --tests 'org.osi.server.sync.*' --tests 'org.osi.server.security.EdgeOwnershipServiceTest' --tests 'org.osi.server.ArchitectureTest'
EDGE_CONTRACT_ROOT=<osi-os-worktree> sh scripts/verify-edge-sync-contract-vendor.sh
sh scripts/verify-edge-sync-contract-vendor.test.sh
```
Expected: PASS; the vendor script prints `verify-edge-sync-contract-vendor: OK`. Then re-run osi-os's `verify-sync-op-parity.js` (E3 Step 6 command). It now prints `verify-sync-op-parity: OK`.

- [ ] **Step 5: Commit.**

```bash
git add backend scripts
git commit -m "feat(sync): mirror WATERMARK calibration events; ownership and resource ref"
```

---

### Task C3: Bootstrap rows through the applier

**Files:**
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`:
  - `EdgeBootstrapRequest`: a new trailing component `@JsonAlias("watermark_calibrations") List<Map<String, Object>> watermarkCalibrations`, null-defaulted in the compact constructor. Add a new "pre-watermarkCalibrations" overload that delegates with `List.of()`, the same pattern as `valveActuations`, and keep every older overload compiling;
  - the bootstrap loop.
- Modify: tests that call the canonical `EdgeBootstrapRequest` constructor: `grep -rln "new EdgeSyncService.EdgeBootstrapRequest(\|new EdgeBootstrapRequest(" backend/src/test`.
- Test: `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceBootstrapTest.java`

**Interfaces:**
- Consumes: E6's `watermark_calibrations`; C2's applier through `appliersByOp`.
- Produces: bootstrap items of type `WATERMARK_CALIBRATION` (applied or
  `RejectedItem`). After each successful item, it reloads the retained
  `WatermarkCalibrationMirror` and calls
  `DesiredStateService.observeMirror(gatewayEui, "WATERMARK_CALIBRATION",
  deviceEui, retained.syncVersion, retained canonical payload)`. Directly
  invoking the applier does not pass through `SyncEventTxExecutor`, so that
  notification is required for desired-state convergence.

- [ ] **Step 1: Write the failing test** in `EdgeSyncServiceBootstrapTest`. A bootstrap request whose `watermarkCalibrations` holds the golden UPSERTED payload results in:
  - an already-ACKNOWLEDGED desired-state operation becoming APPLIED after the
    bootstrap mirror arrives, even when no normal event was processed;
  - an incoming bootstrap v2 behind an already retained v3 notifying
    convergence with v3 and its payload, never v2;
  - the applier being invoked (a mocked `SyncEventApplier` registered for `WATERMARK_CALIBRATION_UPSERTED`, matching how the test class provides appliers), **or**, if the class builds the real service, the mirror repository mock receiving `save`;
  - a golden DELETED payload being routed to the DELETED op;
  - a row whose applier throws `IllegalArgumentException` surfacing as `RejectedItem("WATERMARK_CALIBRATION", "A84041A171000001", …)` while the other items still apply.

- [ ] **Step 2: Run to verify failure.**

Run: `cd backend && ./gradlew test --tests 'org.osi.server.sync.EdgeSyncServiceBootstrapTest'`
Expected: compile FAIL (no `watermarkCalibrations` component).

- [ ] **Step 3: Implement** (*untested sketch*). After the `valveActuations` loop (it must stay after the devices loop: the MUST-stay-after-devices ordering rule):

```java
        // WATERMARK phase 2: calibration rows parent on devices like valve_settings,
        // same MUST-stay-after-devices ordering. Routed through the event applier so
        // there is one writer of watermark_calibration_mirrors / devices.watermark_calibrated.
        for (Map<String, Object> row : request.watermarkCalibrations()) {
            String key = str(row, "device_eui", "deviceEui");
            boolean deleted = row.get("deleted_at") != null;
            String op = deleted ? "WATERMARK_CALIBRATION_DELETED" : "WATERMARK_CALIBRATION_UPSERTED";
            if (applyBootstrapItem("WATERMARK_CALIBRATION", key, rejected, () -> {
                SyncEventApplier applier = appliersByOp.get(op);
                if (applier == null) {
                    throw new IllegalStateException("no applier for " + op);
                }
                applier.apply(request.gatewayDeviceEui(), new SyncEventRecord(
                        null, "WATERMARK_CALIBRATION", key, op,
                        numLong(row, "sync_version", "syncVersion", 0L), null, row));
            })) {
                applied++;
            }
        }
```

  Use this class's own `numLong` / `str` helper names. Ownership is checked the way the other bootstrap items are; check how `upsertValveSettings` guards the gateway (for example `AuthenticatedGateway` or a device-owner comparison) and apply the same guard before calling the applier. A bootstrap must not write another gateway's device calibration.

- [ ] **Step 4: Run.**

Run: `cd backend && ./gradlew test --tests 'org.osi.server.sync.*'`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add backend
git commit -m "feat(sync): bootstrap watermark_calibrations through the WATERMARK applier"
```

---

> **C4 rewrite gate:** do not execute the retained C4 sketch until its tests and
> implementation include all metadata fields, explicit `wireNumber` returns,
> and the shared desired-state same-binding rewrite guard described above.

### Task C4: Command service, controller, desired-state convergence

**Files:**
- Create: `backend/src/main/java/org/osi/server/watermark/WatermarkCalibrationValues.java`, `WatermarkCalibrationCommandService.java`, `WatermarkCalibrationController.java`, `WatermarkCalibrationView.java`
- Test: `backend/src/test/java/org/osi/server/watermark/WatermarkCalibrationCommandServiceTest.java`, `WatermarkCalibrationConvergenceTest.java`, `WatermarkCalibrationControllerTest.java` (only if the device package has a controller-test pattern worth copying; otherwise the service tests suffice)

**Interfaces:**
- Consumes:
  - `DesiredStateService.request(Device gateway, User actor, Request)`;
  - `DesiredStateService.findLatestForResource(gw, "WATERMARK_CALIBRATION", eui)`;
  - `CanonicalResourceVersionReader.currentVersion(gw, "WATERMARK_CALIBRATION", eui)`;
  - `GatewayScopeService.resolve(actor, gatewayEui)` → `GatewayScope` (`requireMutation()`, `canWriteZone`, `isAdmin()`, `localUserUuid()`);
  - `LinkedGatewayAccountRepository.findByUserIdAndGatewayDeviceEui`;
  - C1 `WatermarkCalibrationMirrorRepository`.
- Produces:
  - `GET /api/v1/devices/{deviceEui}/watermark/calibration` → `WatermarkCalibrationView { deviceEui, syncVersion, calibration (map or null), supported (boolean), desiredState (DesiredStateView or null) }`;
  - `PUT` same path, body `{ values: {8 numbers + 4 nullable meta}, baseSyncVersion }` → 202 `DesiredStateView`;
  - `DELETE` same path `?baseSyncVersion=N` → 202 `DesiredStateView`.
  - Errors:
    - 400 invalid values;
    - 403 viewer or disabled account;
    - 404 device not visible, or no live calibration on DELETE;
    - 409 `stale_sync_version` when `baseSyncVersion` ≠ the current version (message body `{ "error": "stale_sync_version", "currentSyncVersion": n }`);
    - 409 non-LSN50 device;
    - 501 gateway without `watermark_v1`.
  - `WatermarkCalibrationValues.wireNumber(double)` → `Integer` when integral within int range, else `Double`.

- [ ] **Step 1: Write the failing tests.** Service test: Mockito, `DeviceRevisionCommandServiceTest` structure. Cases:
  1. **Capability off** → throws with "support" (501), `verifyNoInteractions(desiredStateService)`.
  2. **Viewer** → "read-only" (403), nothing queued.
  3. **Researcher without the device's zone** → "Device not found" (404), nothing queued.
  4. **Unzoned device, cloud owner** → queued. **Unzoned device, researcher who is not the owner** → 404 (decision P2-6).
  5. **Stale base** (mirror version 3, request base 2) → 409 with `currentSyncVersion` 3, nothing queued.
  6. **Base = max(mirror, watermark)**: mirror 3 and watermark slot 4 → base 3 is stale; base 4 queues.
  7. **Out-of-range value** (`pullup_1_ohm` 24999) → 400 before any repository call.
  8. **Enabled SET** captures the `DesiredStateService.Request`:
     - `resourceType "WATERMARK_CALIBRATION"`, `resourceId "A84041A171000001"`, `commandType "SET_WATERMARK_CALIBRATION"`, `CONFIG`, `baseSyncVersion 4`;
     - `effectKey "watermark_calibration:A84041A171000001:4"`;
     - `commandPayload` equals the golden SET command except `command_id` / `requested_at` (assert those are a canonical lower-case UUID and a `…\.\d{3}Z` timestamp) and `actor_user_uuid` (= `scope.localUserUuid()`);
     - `desired` = `{op: "WATERMARK_CALIBRATION_UPSERTED", pullup_1_ohm: Integer 41670, …, measured_at, method, worst_residual_pct, notes}`. Every explicit metadata key is present, including nulls, and `desired.get("pullup_1_ohm")` is an `Integer`.
  9. **DELETE with no live mirror** → 404. **DELETE** at base 3 → `effectKey "watermark_calibration_delete:A84041A171000001:3"`, `desired {op: "WATERMARK_CALIBRATION_DELETED"}`.

  Convergence test, with the real `DesiredStateService`, a mocked `DesiredStateOperationRepository` and `CommandService`, and a real `ObjectMapper`:
  - build the operation the service would create (`desired` from `WatermarkCalibrationValues.desiredFor(golden SET values)`, base 2, target 3, status PENDING, a command with id 7);
  - stub `findFirstByCommandIdAndStatusInOrderByCreatedAtDesc` and `findFirstByGatewayEuiAndResourceTypeAndResourceIdOrderByCreatedAtDesc` to return it;
  - call `observeAck(command, "APPLIED", null, now, 3L)`, then `observeMirror(GW, "WATERMARK_CALIBRATION", EUI, 3L, goldenUpsertPayloadWithOp)`. The payload map is Jackson-parsed from the golden file, so the whole numbers are `Integer`s;
  - assert the operation status is `APPLIED`, not `CONFLICTED`. This is Review Focus 1.
  - A second case feeds a mirror payload with `pullup_1_ohm` 50000 and asserts `CONFLICTED` / `mirror_diverged`.
  - A third case changes only `notes` (including a clear to `null`) and proves
    the old mirror is not converged while the matching edge mirror is. This is
    Review Focus 2.

- [ ] **Step 2: Run to verify failure.**

Run: `cd backend && ./gradlew test --tests 'org.osi.server.watermark.*'`
Expected: compile FAIL.

- [ ] **Step 3: Implement** (*untested sketch*; the service body):

```java
@Service
@RequiredArgsConstructor
public class WatermarkCalibrationCommandService {
    public static final String RESOURCE_TYPE = "WATERMARK_CALIBRATION";
    private final DeviceRepository devices;
    private final GatewayScopeService scopes;
    private final LinkedGatewayAccountRepository accounts;
    private final WatermarkCalibrationMirrorRepository mirrors;
    private final CanonicalResourceVersionReader versions;
    private final DesiredStateService desiredState;
    private final Clock clock;   // use the injected Clock bean if one exists; otherwise Clock.systemUTC()

    public record SetRequest(Map<String, Object> values, Long baseSyncVersion) {}

    @Transactional
    public DesiredStateView requestSet(User actor, String deviceEui, SetRequest request) {
        Map<String, Object> values = WatermarkCalibrationValues.validate(request == null ? null : request.values()); // 400 on any violation
        Target t = target(actor, deviceEui);
        long base = requireBase(t, request.baseSyncVersion());
        Map<String, Object> payload = commandPayload(t, "SET_WATERMARK_CALIBRATION", "watermark_calibration:", base);
        payload.put("values", values);
        return desiredState.request(t.gateway(), actor, new DesiredStateService.Request(
                RESOURCE_TYPE, t.eui(), "SET_WATERMARK_CALIBRATION", DesiredStateMutationKind.CONFIG, base,
                WatermarkCalibrationValues.desiredFor(values), payload, (String) payload.get("effect_key"), null));
    }

    @Transactional
    public DesiredStateView requestDelete(User actor, String deviceEui, Long baseSyncVersion) {
        Target t = target(actor, deviceEui);
        WatermarkCalibrationMirror live = mirrors.findById(t.eui()).filter(m -> m.getDeletedAt() == null)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "No WATERMARK calibration to delete"));
        long base = requireBase(t, baseSyncVersion);
        Map<String, Object> payload = commandPayload(t, "DELETE_WATERMARK_CALIBRATION", "watermark_calibration_delete:", base);
        return desiredState.request(t.gateway(), actor, new DesiredStateService.Request(
                RESOURCE_TYPE, t.eui(), "DELETE_WATERMARK_CALIBRATION", DesiredStateMutationKind.CONFIG, base,
                Map.of("op", "WATERMARK_CALIBRATION_DELETED"), payload, (String) payload.get("effect_key"), null));
    }

    @Transactional(readOnly = true)
    public WatermarkCalibrationView read(User actor, String deviceEui) { /* scope read rules as DeviceRevisionCommandService.read; supported = account.isWatermarkSupported(); calibration = mirror map (null if absent or tombstoned); syncVersion = current(t); desiredState = findLatestForResource(...).orElse(null) */ }

    private record Target(Device device, Device gateway, String eui, String gatewayEui, String localUserUuid) {}

    private Target target(User actor, String deviceEui) {
        if (actor == null || actor.getId() == null || !actor.isEnabled())
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "account disabled or unavailable");
        Device device = devices.findByDeviceEui(String.valueOf(deviceEui).trim().toUpperCase(Locale.ROOT))
                .filter(d -> d.getDeletedAt() == null)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found"));
        if (!DeviceType.DRAGINO_LSN50.equalsIgnoreCase(device.getType()))
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Device is not a Dragino LSN50");
        GatewayScope scope = scopes.resolve(actor, device.getGatewayDeviceEui());
        scope.requireMutation();
        String zoneUuid = device.getIrrigationZone() == null ? null : device.getIrrigationZone().getZoneUuid();
        boolean allowed = zoneUuid != null
                ? scope.canWriteZone(zoneUuid)
                : scope.isAdmin() || (device.getClaimedBy() != null && actor.getId().equals(device.getClaimedBy().getId()));
        if (!allowed) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found");
        LinkedGatewayAccount account = accounts.findByUserIdAndGatewayDeviceEui(actor.getId(), device.getGatewayDeviceEui())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Gateway account not found"));
        if (!account.isWatermarkSupported())
            throw new ResponseStatusException(HttpStatus.NOT_IMPLEMENTED, "Gateway does not support WATERMARK calibration commands");
        if (scope.localUserUuid() == null || scope.localUserUuid().isBlank())
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Gateway local actor identity is unavailable");
        Device gateway = devices.findByDeviceEui(device.getGatewayDeviceEui())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT, "Gateway binding for device is missing"));
        return new Target(device, gateway, device.getDeviceEui().toUpperCase(Locale.ROOT),
                device.getGatewayDeviceEui().toUpperCase(Locale.ROOT), scope.localUserUuid().toLowerCase(Locale.ROOT));
    }

    private long current(Target t) {
        long mirror = mirrors.findById(t.eui()).map(WatermarkCalibrationMirror::getSyncVersion).orElse(0L);
        long slot = versions.currentVersion(t.gatewayEui(), RESOURCE_TYPE, t.eui()).orElse(0L);
        return Math.max(mirror, slot);   // bootstrap updates the mirror but not the slot (decision P2-5)
    }

    private long requireBase(Target t, Long requested) {
        long current = current(t);
        if (requested == null || requested != current) {
            throw new StaleCalibrationVersionException(current);  // mapped to 409 {error: stale_sync_version, currentSyncVersion}
        }
        return current;
    }

    private Map<String, Object> commandPayload(Target t, String type, String effectPrefix, long base) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("command_type", type);
        p.put("command_id", UUID.randomUUID().toString());
        p.put("effect_key", effectPrefix + t.eui() + ":" + base);
        p.put("device_eui", t.eui());
        p.put("gateway_device_eui", t.gatewayEui());
        p.put("actor_user_uuid", t.localUserUuid());
        p.put("requested_at", DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC).format(clock.instant()));
        p.put("base_sync_version", base);
        return p;
    }
}
```

  `WatermarkCalibrationValues`:
  - `validate(Map)`: requires the 8 numbers within the limits and allows only the 4 meta keys:
    - `measured_at`: parseable ISO → re-emitted with millisecond `Z` formatting;
    - `method`: ≤ 64 chars;
    - `worst_residual_pct`: 0–100;
    - `notes`: ≤ 500 chars;
    - `null` allowed for each meta key.

    It returns a `LinkedHashMap` in golden key order, with every number passed through `wireNumber`.
  - `desiredFor(values)`: `op`, the 8 resistor values, and the 4 explicit
    metadata values. The cloud form always sends all four metadata keys, so
    omitted-key keep semantics are not ambiguous on this path.
  - `wireNumber(double v)` uses explicit control flow, not a conditional
    expression:

    ```java
    if (v == Math.rint(v) && Math.abs(v) <= Integer.MAX_VALUE) {
        return Integer.valueOf((int) v);
    }
    return Double.valueOf(v);
    ```

    A comment explains both the `IntNode`/`DoubleNode` convergence trap and
    Java conditional-expression numeric promotion. The test asserts that
    `wireNumber(41670.0)` is an `Integer` equal to `41670`, while
    `wireNumber(0.6)` is a `Double` equal to `0.6`; value-only assertions are
    insufficient.

  `StaleCalibrationVersionException`: a small `ResponseStatusException` subclass (CONFLICT), or a `@ExceptionHandler` in the controller that renders `{error, currentSyncVersion}`. Check how `DeviceController` renders `Map.of("error", …)` bodies and match it.

  Controller: `@RestController @RequestMapping("/api/v1/devices/{deviceEui}/watermark/calibration")`, the `DeviceRevisionCommandController` style (`UserService.findByUsername(principal.getUsername())`). PUT and DELETE return `ResponseEntity.accepted().body(view)`.

- [ ] **Step 4: Run.**

Run: `cd backend && ./gradlew test --tests 'org.osi.server.watermark.*' --tests 'org.osi.server.desiredstate.*' --tests 'org.osi.server.ArchitectureTest'`, plus the controller-vs-contract command test added by the Chameleon PR (find it with `grep -rln "command_type/enum\|commandTypes/accepted" backend/src/test`).
Expected: PASS. The Chameleon PR's test must see both new command types in the vendored enum; they were added in C2.

- [ ] **Step 5: Commit.**

```bash
git add backend
git commit -m "feat(watermark): queue calibration commands through the desired-state ledger"
```

---

### Task C5: Backend consumers and the device response

**Files:**
- Modify: `backend/src/main/java/org/osi/server/history/HistoryCardService.java` (`isSoilSourceDevice`, `soilChannelsForDevice`)
- Modify: `backend/src/main/java/org/osi/server/analysis/AnalysisCatalogService.java` (`soilDepthCm`, display name in `addSoilDeviceEntries`)
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java` (`DeviceResponse` gains `boolean watermarkCalibrated` as the **last** component; `from(...)` passes `d.isWatermarkCalibrated()`)
- Test: `HistoryCardServiceTest` (grep for the class covering `soilChannelsForDevice`), `AnalysisCatalogServiceTest`, `DeviceResponseMapperTest`, and any test calling `new DeviceResponse(` (`grep -rn "new DeviceController.DeviceResponse(\|new DeviceResponse(" backend/src/test`)
- Test (pin only, no production change expected): `backend/src/test/java/org/osi/server/mqtt/MqttMessageRouterTest.java` (or the test class covering `handleTelemetry`). Decision P2-7 relies on it.

**Interfaces:**
- Produces:
  - `HistoryCardService.isWatermarkDevice(Device)` = LSN50 && `isWatermarkCalibrated()`;
  - WATERMARK is a soil source with channels `["swt_1","swt_2"]`, taking precedence over `chameleonEnabled`;
  - `AnalysisCatalogService.soilDepthCm` reads `soilMoistureProbeDepthsJson.get(channelKey)` first for WATERMARK devices, never the Chameleon depth columns;
  - display name `"WATERMARK 1"` / `"WATERMARK 1 (20 cm)"`;
  - JSON `DeviceResponse.watermarkCalibrated`.

- [ ] **Step 1: Write the failing tests:**
  - An LSN50 with `watermarkCalibrated = true`, `chameleonEnabled = 1` and Chameleon depths 10/20/30 → `isSoilSourceDevice` true, channels `[swt_1, swt_2]`.
  - `soilDepthCm(device, "swt_1")` returns the generic depth 25 from `{swt_1: 25}` and **null** for `swt_2` when the generic map has no `swt_2`. It does not fall back to the Chameleon 20.
  - A catalog entry's display name contains `WATERMARK 1 (25 cm)`.
  - An LSN50 with neither flag is still not a soil source.
  - The device response JSON has `watermarkCalibrated: true`.
  - **MQTT pin (P2-7):** a telemetry message on `devices/0016C001F1000001/telemetry` with payload `{deviceEui: "A84041A171000001", deviceType: "DRAGINO_LSN50", timestamp, swt_1: 12.3, swt_2: null, ext_temperature_c: 19.88, bat_v: null, supply_mv: 3300, watermark_statuses: ["ok","open"]}`, for an EUI the cloud has never seen:
    - `upsertFromHeartbeat` is called with type `DRAGINO_LSN50` (auto-create, `last_seen` refreshed);
    - `sensorDataRepository.upsertSensorData` is **not** called (gateway-forwarded, no canonical persistence).
    - `deviceService.updateCurrentState` is **not** called; current state and
      canonical values still arrive through the existing history/DEVICE paths.

    The same payload with every value null behaves the same. If the router already behaves this way, the test passes on first run: it is a regression pin, not a TDD red step. Say so in the execution report.

- [ ] **Step 2: Run to verify failure.**

Run: `cd backend && ./gradlew test --tests 'org.osi.server.history.*' --tests 'org.osi.server.analysis.*' --tests 'org.osi.server.device.*' --tests 'org.osi.server.mqtt.*'`
Expected: FAIL on the new history, analysis and device assertions. The MQTT pin may already pass; see above.

- [ ] **Step 3: Implement** (*untested sketch*):

```java
    public static boolean isWatermarkDevice(Device device) {
        return "DRAGINO_LSN50".equalsIgnoreCase(device.getType()) && device.isWatermarkCalibrated();
    }

    public static boolean isSoilSourceDevice(Device device) {
        return "KIWI_SENSOR".equalsIgnoreCase(device.getType())
                || "TEKTELIC_CLOVER".equalsIgnoreCase(device.getType())
                || isWatermarkDevice(device)
                || device.getChameleonEnabled() == 1;
    }

    public static List<String> soilChannelsForDevice(Device device) {
        // A WATERMARK calibration supersedes a stale chameleon_enabled after a reflash
        // (osi-os spec 2026-09-25 section 13, decision P2-4; the edge's phase 1 rule).
        if (isWatermarkDevice(device)) {
            return List.of("swt_1", "swt_2");
        }
        if (device.getChameleonEnabled() == 1) {
            return List.of("swt_1", "swt_2", "swt_3");
        }
        // unchanged below
    }
```

  `AnalysisCatalogService.soilDepthCm`: add at the top

```java
        if (HistoryCardService.isWatermarkDevice(device)) {
            Integer depth = device.getSoilMoistureProbeDepthsJson() == null ? null
                    : device.getSoilMoistureProbeDepthsJson().get(channelKey);
            return depth == null ? null : depth.doubleValue();
        }
```

  In `addSoilDeviceEntries`, compute the display name through a small helper:

```java
    static String soilDisplayName(Device device, String channelKey, Double depthCm, ChannelRegistry registry) {
        if (HistoryCardService.isWatermarkDevice(device)) {
            String n = channelKey.substring(channelKey.lastIndexOf('_') + 1);
            return depthCm == null ? "WATERMARK " + n
                    : "WATERMARK " + n + " (" + java.math.BigDecimal.valueOf(depthCm).stripTrailingZeros().toPlainString() + " cm)";
        }
        return registry.displayName(channelKey, depthCm);
    }
```

  `HistoryRollupMaintenanceService` calls both static methods and needs no change. Its existing test must stay green.

- [ ] **Step 4: Run.**

Run: the Step 2 command, plus `--tests 'org.osi.server.history.HistoryRollupMaintenanceServiceTest'` if present.
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add backend
git commit -m "feat(history): WATERMARK devices are soil-tension sources with generic depths"
```

---

### Task C6: Frontend data layer

**Files:**
- Modify: `frontend/src/types/farming.ts`:
  - `Device.watermark_calibrated?: boolean`;
  - `watermarkCalibrated?: boolean`;
  - the linked-gateway type gains `watermarkSupported?: boolean`;
  - new `WatermarkCalibrationValues` and `WatermarkCalibrationView` types.
- Modify: `frontend/src/services/api.ts`:
  - `normaliseDevice` maps `watermark_calibrated: d.watermarkCalibrated ?? raw.watermark_calibrated ?? false`;
  - new `watermarkCalibrationAPI.get(deviceEui)`, `.set(deviceEui, values, baseSyncVersion)`, `.remove(deviceEui, baseSyncVersion)`, calling `/api/v1/devices/{eui}/watermark/calibration`.
- Modify: `frontend/src/contexts/gatewayCapabilities.ts`: `watermarkCommandsSupported(state)` (fail-closed like `zoneMutationsSupported`; cloud-local accounts → `false`, because there is no edge to command).
- Modify: `frontend/src/components/farming/zoneSensorPresence.ts`:
  - `reportsSoilTension` accepts an LSN50 with `watermark_calibrated`;
  - `collectDepthsCm` uses `soil_moisture_probe_depths_json.swt_1/swt_2` for WATERMARK devices and the Chameleon fields otherwise;
  - update the file's comment block about `DRAGINO_LSN50`.
- Modify: `frontend/src/channels/registry.ts`: `ChannelSourceContext.watermarkCalibrated?: boolean`; `cardChannelsForSource('soil', { watermarkCalibrated: true })` → `['swt_1','swt_2']`, checked before `chameleonEnabled`.
- Test: `frontend/src/components/farming/__tests__/zoneSoilSummary.test.ts` (or the file testing `zoneSensorPresence`), `frontend/src/channels/__tests__/registry.test.ts`, and a `watermarkCommandsSupported` case in the existing capability test file (grep `zoneMutationsSupported` in `__tests__`).

**Interfaces:**
- Produces: `watermarkCalibrationAPI`, `watermarkCommandsSupported`, and the `Device.watermark_calibrated` field used by C7.

- [ ] **Step 1: Write the failing tests:**
  - `reportsSoilTension({ type: 'DRAGINO_LSN50', watermark_calibrated: true, latest_data: {} })` → true; the same device without the flag and without readings → false.
  - `summariseZoneSoil` on a WATERMARK device with `latest_data {swt_1: 12, swt_2: 40}`, `soil_moisture_probe_depths_json {swt_1: 20, swt_2: 45}`, stale `chameleon_swt1_depth_cm: 10` → `contributingDepthsCm [20, 45]`.
  - `cardChannelsForSource('soil', { watermarkCalibrated: true, chameleonEnabled: true })` → `['swt_1','swt_2']`.
  - `watermarkCommandsSupported`: loading → false; active gateway `watermarkSupported: true` → true; no linked gateways → false.

- [ ] **Step 2: Run to verify failure.**

Run: `cd frontend && npx vitest run --environment jsdom --dir src src/components/farming/__tests__/zoneSoilSummary.test.ts src/channels/__tests__/registry.test.ts` (the vitest half of `npm run test:unit`; never a bare `npx vitest run` without these flags)
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** the edits listed under **Files**. In `LinkedGatewaySyncService.LinkedGatewaySummary` (backend, C1), the field is `watermarkSupported`; the frontend reads `activeGateway?.watermarkSupported === true`.

- [ ] **Step 4: Run.**

Run: the Step 2 command, plus `npx tsc --noEmit -p .` from `frontend/`.
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src
git commit -m "feat(frontend): WATERMARK device indicator, zone presence, channels and API client"
```

---

### Task C7: Frontend UI and locales

**Files:**
- Create: `frontend/src/components/farming/WatermarkCloudSection.tsx`, `frontend/src/components/farming/WatermarkCalibrationPanel.tsx`
- Modify: `frontend/src/components/farming/DraginoCard.tsx`:
  - render `WatermarkCloudSection` when `device.watermark_calibrated`;
  - gate `DraginoChameleonSwtSection` and `getDraginoCardVisibility().chameleonCardVisible` on `!device.watermark_calibrated`;
  - render `WatermarkCalibrationPanel` inside `ConfigPanel` for every LSN50 when `watermarkCommandsSupported(gatewayState)`;
  - the panel starts collapsed unless calibrated (decision P2-1).
- Modify: `frontend/public/locales/{en,de-CH,fr,it,es,pt,lg}/devices.json`: a `watermark` group; `lg` byte-identical to `en` (cloud rule c, `localeParity.test.ts`).
- Test: `frontend/src/components/farming/__tests__/WatermarkCloudSection.test.tsx`, `WatermarkCalibrationPanel.test.tsx`, and an addition to `DraginoCard.modeAction.test.tsx` or a new `DraginoCard.watermark.test.tsx`.

**Interfaces:**
- Consumes: C6's API and capability helper; `PendingStateNotice` (`components/sync/PendingStateNotice.tsx`); `formatSwtValue`, `useDisplayPreferences`.
- Produces: the user-visible surfaces.
  - **Probe tiles:** "WATERMARK 1" / "WATERMARK 2" with depth, kPa via `formatSwtValue` (honours the pF preference), and "Soil temperature" from `ext_temperature_c`.
  - **Hint line:** `watermark.gatewayOnlyStatus` ("Probe status, resistance and supply voltage are shown on the gateway.").
  - **Calibration form:**
    - 8 numeric fields and 4 metadata fields, all sent every time; a blank metadata field sends `null`;
    - `PendingStateNotice` for the latest operation;
    - a 409 `stale_sync_version` reloads the view and shows `watermark.calibration.conflict`;
    - 501 is never reachable, because the panel is capability-gated;
    - a delete button with confirm.

- [ ] **Step 1: Write the failing tests** (Testing Library, the existing `DraginoCard.modeAction.test.tsx` setup):
  - The probe section shows "WATERMARK 1 (20 cm)" and `12.0 kPa`, and in pF mode the pF value (`log10(12*10)` → `2.08`).
  - The Chameleon section is absent when `watermark_calibrated` and `chameleon_enabled` are both set.
  - The panel is absent when `watermarkSupported` is false.
  - The panel submits all 12 value keys with `baseSyncVersion` equal to the loaded `syncVersion`. A mocked 409 `{error:'stale_sync_version', currentSyncVersion: 5}` triggers a reload and the conflict text.
  - A pending operation renders `PendingStateNotice`'s pending text.
  - Client validation blocks `pullup_1_ohm = 24999` with a translated message and sends nothing.

- [ ] **Step 2: Run to verify failure.**

Run: `cd frontend && npx vitest run --environment jsdom --dir src src/components/farming/__tests__/WatermarkCloudSection.test.tsx src/components/farming/__tests__/WatermarkCalibrationPanel.test.tsx`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** the two components and the `DraginoCard` changes. Reuse the edge's phase 1 `WatermarkCalibrationSection.tsx` as the structural model: field list, draft/validation, the pF-aware preview wording. Leave out the dry-run preview: the cloud has no raw frames until phase 3. Take the `en` strings from the edge `devices.json` `watermark.*` group where the meaning is identical, so the two GUIs read the same.

  For `de-CH`, `fr`, `it`, `es`, `pt`, copy the edge's human-reviewed translations for identical keys. Phase 1 settled the glossary: de-CH Bodenwasserspannung, fr Tension de l'eau du sol, it tensione idrica del suolo, es tensión hídrica del suelo, pt tensão hídrica do solo. New cloud-only keys (`gatewayOnlyStatus`, pending wording) are translated in the same style. `lg` = `en` verbatim.

- [ ] **Step 4: Run the frontend gates (one build only).**

```bash
cd frontend && npm run test:unit
cd frontend && npm run build
```
Expected: all unit tests pass, including `localeParity.test.ts` and `missingKeyScan.test.ts`; the build succeeds. Do not run any other frontend build concurrently.

- [ ] **Step 5: Commit.**

```bash
git add frontend
git commit -m "feat(frontend): WATERMARK probe section and cloud calibration form with pending states"
```

---

### Task C8: Cloud docs and gate sweep

**Files:**
- Modify: `AGENTS.md` (osi-server): a "WATERMARK calibration (LSN50)" subsection after "Chameleon calibration":
  - the mirror table, the `watermark_calibrated` indicator and its meaning (decision P2-1);
  - the endpoints, the capability gate, and "edge authoritative; commands via desired state".

- [ ] **Step 1: Write the docs** (`anti-slop-writing` skill).

- [ ] **Step 2: Gate sweep** (paste real output into the execution report):

```bash
cd backend && ./gradlew test
EDGE_CONTRACT_ROOT=<osi-os-worktree> sh scripts/verify-edge-sync-contract-vendor.sh
sh scripts/verify-flyway-ordering.sh
bash -c 'O=<osi-os-worktree>/docs/contracts/sync-schema; S=backend/src/test/resources/sync-contract; for f in resources.schema.json watermark-calibration-v1-golden.json effect-keys.md canonicalization.md rejection-recovery-v1.json; do cmp $O/$f $S/$f && echo "same $f"; done'
```
Expected:
- the full backend suite is green;
- `verify-edge-sync-contract-vendor: OK`;
- the Flyway ordering is OK;
- five `same …` lines.

- [ ] **Step 3: Commit.**

```bash
git add AGENTS.md
git commit -m "docs: WATERMARK calibration mirror, commands and capability"
```

---

## Paired-PR landing order and rollout

1. **Chameleon command-name PR pair** merges (both repos). Rebase both phase 2 branches onto it and re-run E5 Step 6 and C4 Step 4.
2. **osi-os phase 1** merged to main as `ca08dcc13` (#366), fix round included. Start the rewritten phase 2 branch from `main`. Migration `0062` must still be the next number; if anything else took `0062`, renumber this migration **before** merge and redo E3 Steps 4–6.
3. **osi-server phase 2 PR merges and deploys** to every cloud host that has linked gateways which might receive the edge change. At minimum: the test host, and each customer cloud before its gateways are re-cut.
   - It is additive: a new table, two new columns, a new applier, and new endpoints that answer 501 until a gateway advertises `watermark_v1`.
   - Re-date the Flyway file at merge (`verify-flyway-ordering.sh`).
4. **osi-os phase 2 PR merges**; the edge deploys through `deploy.sh`, whose migration runner applies `0062` before the new flows run.
   - **Why this order:** an edge with `0062` on a cloud without the applier sends events the old cloud dead-letters as `unknown_op`, and a resend of the same `event_uuid` is answered DUPLICATE.
   - **If that happens anyway:** check whether the controlled rejection replay from osi-server #240 can re-drive those dead letters before relying on it. The edge-side recovery is a fresh save, which bumps the version and emits a new event.
5. **Capability gate:** the cloud issues `SET/DELETE_WATERMARK_CALIBRATION` only when the account row says `watermark_supported`, which only a phase-2 edge reports. An old edge never receives them. A downgraded edge stops advertising at its next bootstrap or link, and the cloud stops offering the form.

**PR bodies** (cross-repo rule): contract files changed; mirror required (yes: `resources.schema.json` and the golden file byte-copied; events/commands/golden fixture edited in the server's own copies); where the paired PR lands; the edge and server verification commands run, with output.

---

## Self-review notes (for the reviewer)

- **Spec §7 coverage:**
  - contract (E1, C2);
  - linked-gated migration-owned triggers (E3);
  - DEVICE event augmentation: *not needed* under decision P2-1, recorded in the spec addendum;
  - appliers through the phase 1 writer with a stale check and dedup (E2, E4);
  - bootstrap and force sync (E6, C3);
  - cloud Flyway (C1);
  - event appliers (C2);
  - ownership with a retryable dependency (C2);
  - controller + pending/stale/applied (C4, C7);
  - capability (E5, C1, C4, C6);
  - consumers: `zoneSensorPresence` (C6), `HistoryCardService` / `AnalysisCatalogService` / `soilDepthCm` (C5);
  - frontend parity and locales (C7);
  - rollout (section above);
  - no new rate-limit bucket: none added.
- **Phase 1 follow-up carried in:** WATERMARK boards lost cloud MQTT liveness and auto-create when `Build Telemetry` began dropping FPort 11 (on main since `ca08dcc13`). Decision P2-7 restores both through E7 (edge) and C5's router pin (cloud).
- **Not in scope, flagged:**
  - `TerraDeviceAnchorService.isProbeDevice` / `probes` still ignore WATERMARK. Adding it changes the Terra anchor fingerprint, so it is a follow-up issue.
  - The cloud has no dry-run preview (no raw frames before phase 3).
- **Chameleon consumers not touched:** `TerraDeviceAnchorService`, `ZoneAnchorInventoryJdbcRepository` (follow-up above), and the MQTT `MqttMessageRouter`, which already skips WATERMARK canonical persistence (phase 1 external review).
