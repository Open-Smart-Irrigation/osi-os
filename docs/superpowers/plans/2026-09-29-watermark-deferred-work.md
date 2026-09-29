# WATERMARK on the LSN50: deferred work after phase 1

Date: 2026-09-29 · Baseline: osi-os main at `ca08dcc13` (#366)

Phase 1 is on main. It decodes, converts and displays WATERMARK readings on the
edge, stores every profile 3 frame in `watermark_readings`, and keeps WATERMARK
observations out of the irrigation scheduler. Everything else in the spec
(`docs/superpowers/specs/2026-09-25-watermark-lsn50-design.md`) is deferred. The
table lists each deferred item, what main does today, and the document that
owns it. None of the plans named here is executable as written.

## Shipped baseline the rows refer to

- Migration `0061__watermark_lsn50.sql` creates `watermark_calibrations` and
  `watermark_readings` with no outbox triggers. `0060` is the RAK10701
  field-tester migration.
- `osi-watermark-helper` (loaded through `osiLib.require('watermark-helper')`)
  exports the conversion core (`parseProfile3`, `resistanceFromCodes`,
  `tensionFromResistance`, `convertFrame`, `channelCalibration`), the
  calibration store (`validateCalibrationBody`, `getCalibration`,
  `saveCalibration`, `deleteCalibration`, `backfillBatch`, `backfillPending`)
  and `ingestProfile3`.
- `lsn50-decode-fn` sends FPort 11 to `watermark-ingest-fn`; `Build Telemetry`
  (`8809bb5239dfb3d4`) returns `null` for an LSN50 FPort 11 uplink, so no
  WATERMARK MQTT telemetry leaves the gateway.
- `GET`, `PUT` and `DELETE /api/devices/:deveui/watermark/calibration` go to
  `watermark-cal-fn`.
- The scheduler query node `d0b2b1c1a937e16d` carries
  `AND NOT EXISTS (SELECT 1 FROM watermark_readings wr WHERE wr.device_data_id = dd.id)`,
  so automated WATERMARK irrigation stays disabled whatever the device flags say.

## Deferred items

| Item | State on main | Owner document | Blocked by |
|---|---|---|---|
| Cloud: calibration sync and cloud GUI | `watermark_calibrations` changes stay on the gateway. No calibration events or commands exist in `docs/contracts/sync-schema/`, and the cloud has no calibration mirror, WATERMARK card section, calibration form or "WATERMARK 1/2" history labels. Calibrated `swt_1`/`swt_2` values reach the cloud only as ordinary LSN50 `device_data` rows. | Phase 2 plan (`2026-09-26-watermark-lsn50-phase2.md`), spec §7 and §13 | Phase 2 plan rewrite; the shared `DesiredStateService` rewrite guard; the Chameleon prerequisite |
| Cloud: MQTT liveness for WATERMARK boards | `Build Telemetry` drops FPort 11, so the cloud neither refreshes `last_seen` nor auto-creates a WATERMARK board from MQTT. | Phase 2 plan, decision P2-7 (Task E7) | Phase 2 plan rewrite |
| Cloud: raw-reading sync | `watermark_readings` is edge-local. Status, resistance, offset and supply per reading never leave the gateway. | Phase 3 plan (`2026-09-26-watermark-lsn50-phase3.md`), OD-4, OD-5; spec §8 | Phase 2 landing; phase 3 re-plan against main |
| Scheduler admission | No admission table, no enable writer and no D7 check against `chameleon_enabled`. The phase 1 interlock excludes every WATERMARK row. | Phase 3 plan, OD-1 to OD-3 and OD-9; spec §8 | Phase 3 re-plan against main; the dry-down bench gate below |
| Dry-down bench gate | The offline analyzer (phase 3 Task E1) is implemented. No real run has been accepted. | Bench protocol (`2026-09-26-watermark-dry-down-bench-protocol.md`) | The identity-bound run manifest (protocol §2.3); phase 1 deployed on the bench gateway |
| Field acceptance on a gateway | Phase 1 is on main but has not been accepted on a gateway. The checks are listed below. | This document | A gateway running main with a registered profile 3 node |
| Chameleon desired-state prerequisite (D6) | Not implemented. osi-server main (`c06f5d8c`) still issues `SET_CHAMELEON_ENABLED` from `DeviceController`; the edge registry lists `SET_CHAMELEON_CONFIG`, but Route Command (`934bf2bc19a8ce22`) has no branch for it, and no edge advertises `chameleon_config_commands_v1`. | Chameleon plan (`2026-09-26-chameleon-enabled-command-fix.md`), marked NOT EXECUTABLE; spec §10 | Its own rewrite around the desired-state ledger; it must land before phase 2 |

## Field acceptance checks for phase 1

Run these read-only on a gateway that runs main, with a profile 3 node
registered under the OSI Dragino LSN50 profile and not assigned to any
irrigation zone. `<device-eui>` is that node's DevEUI.

| Check | Pass condition |
|---|---|
| Two FPort 11 uplinks with an increasing frame counter | The two newest `watermark_readings` rows for `<device-eui>` are `accepted` and their `f_cnt` values increase. The F83 duplicate check in `lsn50-decode-fn` can drop an uplink that repeats a counter before ingest. |
| Raw persistence | Each accepted row has a 54-character `payload_hex` (27 bytes, tag `a2`, profile `03`) and a non-null `device_data_id` that names a `device_data` row of the same DevEUI and `recorded_at`. |
| Measured DS18B20 source | `soil_temp_source = 2`, and `device_data.ext_temperature_c` equals `watermark_readings.soil_temp_c` for the same observation. |
| Calibrated display | After a calibration save through the edge GUI or `PUT /api/devices/<device-eui>/watermark/calibration`, a new uplink has channel status `ok` or `saturated` with a kPa value, and the LSN50 card shows it in the WATERMARK section. |
| Zero scheduler eligibility | No `device_data` row that has a `watermark_readings` row passes the scheduler query of `d0b2b1c1a937e16d`, including when the device is placed in a zone and `chameleon_enabled = 1`. The phase 1 test `scripts/test-watermark-ingest-flow.js` case (f) pins the same rule offline. |

A gateway that fails any check keeps its WATERMARK node on the bench. Record
the result with the gateway's firmware commit, never with credentials or DB
copies.
