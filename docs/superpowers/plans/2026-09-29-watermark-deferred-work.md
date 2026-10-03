# WATERMARK on the LSN50: deferred work after Phase 1

Date: 2026-09-29 · Updated: 2026-10-03 · Baseline: `origin/main`

Phase 1 is on main. The current cloud-parity stack adds the edge-authoritative
calibration mirror, pending-first configuration commands, contact-only FPort 11
publishing, and Data-view source parity. It keeps every WATERMARK observation
out of the irrigation scheduler.

The approved cloud-parity architecture is
`docs/superpowers/specs/2026-09-30-watermark-cloud-parity-design.md`. The old
`2026-09-26-watermark-lsn50-phase2.md` and
`2026-09-26-watermark-lsn50-phase3.md` sketches are historical inputs. They are
not executable and must not be used to extend this implementation. This file
records the implemented parity boundary and the work that remains deferred.

## Implemented baseline

- Migration `0061__watermark_lsn50.sql` creates `watermark_calibrations` and
  `watermark_readings`. Migration `0068__watermark_cloud_parity.sql` adds
  calibration outbox events without syncing raw readings.
- `osi-watermark-helper` owns profile parsing, electrical conversion,
  calibration persistence, backfill, and ingest.
- FPort 11 reaches local WATERMARK ingest and publishes a contact-only message.
  The generic MQTT telemetry builder still drops its measurement payload.
- The local calibration API supports `GET`, `PUT`, and `DELETE`.
- The scheduler query excludes every row linked to `watermark_readings`.
- Canonical `swt_1`, `swt_2`, and external-temperature values already travel
  through ordinary device-data history sync.
- Bootstrap and force sync carry the retained calibration row or tombstone.
- The protected command route handles calibration set/delete, Chameleon
  configuration, and generic soil-depth writes with exact-base effect keys.
- Protected DEVICE commands use only the accepted DEVICE resource watermark as
  their base. Missing confirmation requires reconciliation and queues nothing.
- One protected DEVICE mutation can remain unresolved. Proven-unexposed
  same-type edits reuse its pair; exposed or cross-type overlap is refused.
- DEVICE desired-state convergence reads the retained canonical row, never the
  submitted event payload alone.

## Status index

| Item | Current decision | Phase | Owner |
|---|---|---|---|
| Edge-authoritative calibration parity | Implemented: `WATERMARK_CALIBRATION`, pending-first cloud writes, snapshots, retained tombstones, and cloud mirror, gated by `watermark_v1`. | Implemented | Cloud-parity design §§4–5 |
| Generic probe depths | Implemented on the `DEVICE` aggregate through exact-base `UPSERT_DEVICE_SOIL_DEPTHS`, gated by `device_soil_depth_commands_v1`. | Implemented | Cloud-parity design §5 |
| Chameleon command foundation | Implemented as pending-first exact-base `SET_CHAMELEON_CONFIG`, gated by `chameleon_config_commands_v1`. | Implemented | Cloud-parity design §5 |
| FPort 11 liveness | Implemented as contact only. `lastSeen` is contact time; `currentStateRecordedAt` is canonical measurement time. | Implemented | Cloud-parity design §7 |
| Cloud history labels | Implemented as neutral Soil tension 1/2 labels until immutable row-level provenance exists. Current calibration does not relabel history. | Implemented | Cloud-parity design §8 |
| Edge Data view | An assigned plain LSN50 is a soil source with SWT1/SWT2 before its first sample. Chameleon and SDI-12 keep SWT3. Unassigned devices do not enter a zone Data view. | Implemented | History helper and channel registry tests |
| Raw diagnostic sync | Declined and enforced. `watermark_readings` and all electrical diagnostics remain edge-local. | Not planned | Cloud-parity design §§2, 7–8 |
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

## Implemented cloud parity contract

The edge advertises `watermark_v1`, `chameleon_config_commands_v1`, and
`device_soil_depth_commands_v1`. `WATERMARK_CALIBRATION_UPSERTED` and
`WATERMARK_CALIBRATION_DELETED` carry the calibration mirror. Four protected
commands use these exact effect keys:

- `SET_WATERMARK_CALIBRATION`:
  `watermark_calibration:set:{gateway_eui}:{device_eui}:{base_sync_version}`;
- `DELETE_WATERMARK_CALIBRATION`:
  `watermark_calibration:delete:{gateway_eui}:{device_eui}:{base_sync_version}`;
- `SET_CHAMELEON_CONFIG`:
  `chameleon_config:set:{gateway_eui}:{device_eui}:{base_sync_version}`;
- `UPSERT_DEVICE_SOIL_DEPTHS`:
  `device_soil_depths:set:{gateway_eui}:{device_eui}:{base_sync_version}`.

Deploy cloud support before the edge release that advertises these tokens.
Applied cloud writes remain pending until both ACK and authoritative mirror
convergence arrive, in either order. A definitive non-application ACK settles
without mirror convergence. A pre-existing calibration must bootstrap before
its first cloud edit.
Calibration may start from base zero only when neither retained calibration nor
its resource watermark exists. Chameleon and soil-depth writes wait for a
confirmed DEVICE watermark; bootstrap state without that confirmation does not
authorize a guessed base.

Contact and measurement time remain distinct. Contact-only FPort 11 MQTT may
advance `lastSeen`; accepted canonical data may advance
`currentStateRecordedAt`. Raw diagnostics remain edge-local, and the scheduler
interlock remains active.

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
