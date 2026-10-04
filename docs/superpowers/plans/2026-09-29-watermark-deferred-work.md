# WATERMARK on the LSN50: deferred work after Phase 1

Date: 2026-09-29 · Updated: 2026-09-30 · Baseline: `origin/main`

Phase 1 is on main. It decodes, converts, and displays WATERMARK readings on
the edge, stores every profile 3 frame in `watermark_readings`, and keeps every
WATERMARK observation out of the irrigation scheduler.

The approved cloud-parity architecture is
`docs/superpowers/specs/2026-09-30-watermark-cloud-parity-design.md`. Older
Phase 2 and Phase 3 plans are historical inputs, not executable plans. This
file is the status index; it does not authorize implementation.

## Shipped baseline

- Migration `0061__watermark_lsn50.sql` creates `watermark_calibrations` and
  `watermark_readings` without outbox triggers.
- `osi-watermark-helper` owns profile parsing, electrical conversion,
  calibration persistence, backfill, and ingest.
- FPort 11 reaches local WATERMARK ingest. The generic MQTT telemetry builder
  drops it, so no FPort 11 liveness message leaves the gateway.
- The local calibration API supports `GET`, `PUT`, and `DELETE`.
- The scheduler query excludes every row linked to `watermark_readings`.
- Canonical `swt_1`, `swt_2`, and external-temperature values already travel
  through ordinary device-data history sync.

## Status index

| Item | Current decision | Phase | Owner |
|---|---|---|---|
| Edge-authoritative calibration parity | Add the `WATERMARK_CALIBRATION` resource, pending-first cloud writes, snapshots, and a mirror. Reserve edge migration `0068`; gate edits with `watermark_v1`. | Phase 2 | Cloud-parity design §§4–5 |
| Generic probe depths | Keep the fields on the `DEVICE` aggregate; cloud edits use `UPSERT_DEVICE_SOIL_DEPTHS`, exact-base handling, and `device_soil_depth_commands_v1`. | Phase 2 | Cloud-parity design §5 |
| Chameleon command foundation | Use pending-first `SET_CHAMELEON_CONFIG`, exact-base handling, and `chameleon_config_commands_v1`; align controller, contract, router, capability, and effect key. | Phase 2 prerequisite | Cloud-parity design §5; Chameleon command-fix plan must be rewritten |
| FPort 11 liveness | Publish contact only. Reuse `lastSeen` for contact and `currentStateRecordedAt` for canonical measurement age; add no timestamp column. | Phase 2 | Cloud-parity design §7 |
| Cloud history labels | Use Soil tension 1/2 until immutable row-level provenance exists. Current calibration must not relabel history. | Phase 2 | Cloud-parity design §8 |
| Raw diagnostic sync | Declined. `watermark_readings` and all electrical diagnostics remain edge-local. | Not planned | Cloud-parity design §§2, 7–8 |
| Calibration-fit wizard | Useful operator aid, but not a Phase 2 release gate; equivalent manual resistor evidence remains valid. | Later UX | Cloud-parity design §13 |
| Board diagnostics in cloud | Later UI may show status, supply, board temperature, and versions. Board temperature must never be labelled soil or ambient temperature. | Later UX | Cloud-parity design §13 |
| Bench electrical qualification | Validate both channels and polarities, cross-channel effects, ground state, supply, and installed lead length. These checks do not establish soil-tension accuracy. | Phase 2 non-blocker | Dry-down protocol |
| Independent-reference qualification | Compare against an independent soil-water-tension reference across the claimed range. Self-consistency is not accuracy evidence. | Phase 3 gate | Dry-down protocol; field qualification runbook |
| Temperature representativeness | Measure per depth or prove one DS18B20 represents both probe depths within a predeclared limit. | Phase 3 gate | Field qualification runbook |
| Validated applicability envelope | Version the accepted resistance/kPa, temperature, supply, cable, ground, channel, placement, and salinity/EC conditions. No smoothing may make an individual sample eligible. | Phase 3 gate | Cloud-parity design §9; field qualification runbook |
| Scheduler sampling policy | Fix per-channel freshness, minimum points, hysteresis, and re-arm rules before implementation. | Phase 3 gate | Future approved admission design |
| Calibration reacceptance | Changing any electrical coefficient revokes qualification. Fresh evidence and explicit human reacceptance are required; metadata-only edits do not revoke it. | Phase 3 gate | Cloud-parity design §9 |
| Scheduler admission | Remains disabled. No admission table or command is authorized by the cloud-parity design. | Phase 3 gate | Future approved admission design |
| Field records | Record reference method, conditioning/rewetting, placement, depth, cable/ground state, temperature arrangement, salinity/EC observations, monitoring, and requalification triggers. | Phase 2 non-blocker | `docs/operations/watermark-field-qualification.md` |

## Phase 1 field acceptance

Run these read-only on a gateway running main, with a profile 3 node registered
under the OSI Dragino LSN50 profile and unable to reach irrigation control.

| Check | Pass condition |
|---|---|
| Two FPort 11 uplinks | The two newest accepted `watermark_readings` rows have increasing frame counters. |
| Raw persistence | Each accepted row has a 54-character profile 3 payload and a non-null `device_data_id` naming a row for the same device and time. |
| Measured temperature source | `soil_temp_source = 2`, and canonical external temperature equals the raw row's soil temperature. |
| Calibrated display | After a local calibration save, a new uplink has an eligible channel status and kPa value, and the edge card shows it. |
| Zero scheduler eligibility | No row linked to `watermark_readings` passes the scheduler query, including if legacy device flags are set. |

A gateway that fails any check keeps the node outside irrigation control. The
record includes software and firmware versions but no credentials, database
copy, customer identifier, or network address.
