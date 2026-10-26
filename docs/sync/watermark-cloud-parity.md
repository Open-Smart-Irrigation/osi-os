# WATERMARK cloud parity (edge side)

Edge-side detail for the WATERMARK calibration resource and the four protected
exact-base commands that ship with it. It moved out of `AGENTS.md` on 2026-10-22;
`AGENTS.md` keeps the binding rule lines (pending until acknowledgement and
mirror convergence, cloud-before-edge deploy order, the scheduler interlock)
and this page carries the same authority. Contract:
`docs/contracts/sync-schema/README.md`.

## Resource and events

`WATERMARK_CALIBRATION` is an edge-authoritative resource keyed by uppercase
device EUI. Migration `0068__watermark_cloud_parity.sql` emits
`WATERMARK_CALIBRATION_UPSERTED` and `WATERMARK_CALIBRATION_DELETED`; bootstrap
and force sync carry the retained live row or tombstone. The cloud mirror changes
only after an event or snapshot arrives.

## Protected command effect keys

The four protected command effect keys are exact:

- `watermark_calibration:set:{gateway_eui}:{device_eui}:{base_sync_version}`
- `watermark_calibration:delete:{gateway_eui}:{device_eui}:{base_sync_version}`
- `chameleon_config:set:{gateway_eui}:{device_eui}:{base_sync_version}`
- `device_soil_depths:set:{gateway_eui}:{device_eui}:{base_sync_version}`

Protected bases come only from confirmed edge state. Chameleon and soil-depth
writes require the accepted `DEVICE` watermark; if it is absent, cloud issuance
returns `409 reconciliation_required`. Only one protected DEVICE mutation may be
unresolved, and DEVICE convergence is proven from the retained canonical row,
not from a submitted event payload. See `docs/contracts/sync-schema/README.md`.

## Deploy order

Deploy the cloud contract, appliers, pending-command support, and read-only UI
before an edge that advertises the three WATERMARK-related capabilities. After
the edge deploy, write controls remain capability-gated, and a pre-existing
calibration must reach the cloud through bootstrap before its first cloud edit.

## Telemetry and history

FPort 11 MQTT reports contact only. It advances cloud `lastSeen`; an accepted
canonical snapshot advances `currentStateRecordedAt`, even when a channel value
is null. Both timestamps are monotonic. `watermark_readings`, payload bytes, ADC
codes, channel flags, resistance, offset, supply, die temperature, and conversion
diagnostics stay on the edge. Canonical `device_data` history continues through
the ordinary history contract.

The scheduler interlock still rejects every `device_data` row linked to
`watermark_readings`, regardless of legacy device flags. Cloud parity and field
qualification records do not lift it.

## Data view soil sources

In the edge Data view, a `DRAGINO_LSN50` becomes a soil source only after it is
assigned to a zone. A plain LSN50 then exposes SWT1 and SWT2 before its first
sample. Chameleon-enabled LSN50 and `DRAGINO_SDI12` sources retain SWT3; mixed
zones filter SWT3 per device so a plain LSN50 cannot inherit another source's
third channel.

An assigned LSN50 is a soil source when it is a Chameleon device, or a WATERMARK
node, or none of `dendro_enabled`, `temp_enabled`, `rain_gauge_enabled` and
`flow_meter_enabled` is set. A WATERMARK node is an LSN50 with WATERMARK
evidence: a retained (not deleted) `watermark_calibrations` row or at least one
`watermark_readings` row. A WATERMARK frame always carries a temperature, so
`temp_enabled` does not remove the node from the Soil card; with that flag it
also feeds the Environment card. `dendro_enabled`, `rain_gauge_enabled` and
`flow_meter_enabled` still exclude it, because those modes use the same inputs.
Its soil channels are SWT1 and SWT2. `isSoilSource` in `osi-history-helper` is
the one implementation (the history router delegates to it), and the device
rows carry the evidence from one query per load (`annotateWatermarkEvidence`).
The cloud history view applies the same rule. A soil card reads raw
`device_data` instead of `history_channel_rollups` only when one of its sources
is an LSN50 without Chameleon, because a merged rollup may hold that device's
stale SWT3.
