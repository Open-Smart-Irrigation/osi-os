---
name: osi-agronomy-sensors-reference
description: "Use when interpreting sensor values or payloads: SWT kPa/pF, Chameleon, dendrometer TWD/MDS, rain gauges, ET0, which device_data column a sensor writes, STREGA/UC512 valve semantics, or any decoder. Covers every supported device type."
---

# OSI Agronomy & Sensors Reference

## Overview

This skill is the domain model for how OSI OS represents soil, plant-water, and
weather measurements in the database, the scheduler, and the dashboard. It
answers "what does this number mean and where does it live", not general
agronomy theory. Claims are tied to the code or docs named next to them; when
using this skill for implementation, re-check drift-prone facts in the current
branch before treating them as completion evidence.

## When to use / When NOT to use

Use this skill when you need to:
- Interpret a stored SWT/kPa/pF value, or decide whether a number is "wet" or "dry".
- Understand Chameleon resistance-to-kPa calibration or the array_id lookup flow.
- Explain dendrometer MDS/TWD/TWD_rel output or find which side (edge vs cloud) computes it.
- Explain rain aggregation semantics for LoRain or S2120, or a "missing vs zero" rain question.
- Determine which `device_data` column a given sensor/device type populates.
- Explain STREGA valve command semantics (`OPEN_FOR_DURATION`, cancel).
- Answer whether a given STREGA generation reports temperature or humidity.
- Explain LoRaWAN join/uplink vocabulary (OTAA, FPort, DevEUI...) as used by this system.

Do NOT use this skill for (route instead):
- Debugging a symptom like `i2c_missing=1`, a data gap, or a stuck sync — **osi-debugging-playbook**.
- Deploying to or repairing a live Pi, backups, restart procedures — **osi-live-ops-runbook**.
- Mechanically editing `flows.json` (node shapes, wiring function nodes) — **osi-flows-json-editing**.
- Adding/altering a table, column, or migration — **osi-schema-change-control**.
- `CHIRPSTACK_PROFILE_*` env vars, device-profile provisioning, feature flags — **osi-config-and-flags**.
- Pure layout, spacing, copy, or styling changes that do not alter sensor
  semantics, units, decoder fields, thresholds, or displayed measurement meaning.

## Authority

Cross-reference AGENTS.md's "Device catalog" and "SWT history repairs"
sections, `docs/sync/chameleon-calibration.md`, and this skill's "Device
catalog (edge reference)" section, which holds the "Aqua-Scope LoRain",
"STREGA timed irrigation" and "Valve control" paragraphs moved from AGENTS.md
and carries its authority. The rest of this skill expands on those, it does
not override them. If they ever disagree, AGENTS.md and the moved section
win; file an issue to reconcile rather than silently trusting either.

## Binding rules kept here

These paragraphs are also in the reference files named after each block; the copies here carry the same authority.

From `references/device-catalog.md`, "Device catalog (edge reference)":

**Conditional irrigation:** `osi-irrigation-policy` owns SWT, VWC and DENDRO
conditions evaluated at scheduled opportunities. Without selected schedules, the
farmer chooses a daily start time. Crossing a threshold never starts an immediate
run. SWT preferences are Wet = 20 kPa, Moist = 30 kPa, Dry = 50 kPa; Custom retains
precision and the Moist help contains “Recommended”. Explanations use the existing
help disclosures.

Conversion clears the valve's fixed plan through the normal push path. Dispatch
waits for all required clear ACKs and the evidence, interval, allowance and
qualification checks; since the owner decision of 2026-10-24 it no longer needs an
NTP sync since boot (only a clock behind stored data is refused). A valve-scheduled open while conditionally managed records an
incident and blocks further conditional dispatch. Pause does not restore the fixed
plan; converting back to Always does. Legacy DENDRO hold and below-threshold days
skip after conversion, which the conversion preview explains.

The local resource is `/api/irrigation-zones/:id/irrigation-policy`, with `pause`,
`retry-valve` and `decisions` subroutes. Cloud edits use
`UPSERT_IRRIGATION_POLICY`, `PAUSE_IRRIGATION_POLICY` and
`RETRY_IRRIGATION_VALVE`; they stay pending until the edge applies them. Both peers
must advertise `conditional_irrigation_v1` for conditional replication. Unsupported
peers receive no conditional resource keys or conditional schedule rows; guarded
requests never fall back to legacy endpoints.

Production qualification remains false. Software fixtures cannot qualify a valve.
Release requires separate Gen1/Gen2 clear-ACK, expiry, delivery-latency, physical
close, clock-recovery and firmware-identity evidence. Shared STREGA transport
changes also affect ordinary commands. The SWT preference controls can ship
independently of conditional activation. See the
[execution report](../../../docs/superpowers/plans/2026-10-13-conditional-irrigation-execution-report.md)
for software evidence and unrun hardware gates.

LoRain rainfall is interval rainfall, not cumulative; duplicate or out-of-order timestamps must not aggregate twice.

From `references/strega-valves.md`, "STREGA valve semantics":

**Estimated vs measured volume — kept separate:** `zone_irrigation_calibration`
stores a per-zone `measured_flow_rate_lpm` (from a real flow-meter
measurement) used only to *estimate* `valve_actuation_expectations.estimated_gross_liters`
for a given commanded duration. `zone_daily_environment.flow_liters` is
reserved for actually-measured flow-meter data — the two must never be
merged into one column, so a farm without a flow meter never gets a
volume number that looks measured but isn't.

From `references/soil-water-tension.md`, "Soil water tension (SWT)" and "Chameleon sensor stack":

- `irrigation_schedules.threshold_kpa` is validated `0 < x ≤ 300` for
  non-DENDRO trigger metrics (`flows.json`, "Verify Zone Ownership" node); for
  `trigger_metric = 'DENDRO'` the same column instead holds an **encoded
  1-4 stress level** (1=mild … 4=severe), not a kPa value — do not treat
  `threshold_kpa` as kPa when the metric is DENDRO.

**Wiring rule (one line; the field incident summary lives elsewhere):** power the VIA
Chameleon I2C reader from the LSN50's own `VDD` rail (3.3-3.6 V) when SDA/SCL
are wired directly to the LSN50 STM32 I2C pins. Do not power it from switched
5 V without a proper bidirectional I2C level shifter plus power isolation —
the reader's pull-ups follow VCC and a switched-off 5 V rail can back-power
the board through SDA/SCL.

## Common mistakes

- Assuming SWT is negative or that lower kPa means drier — it is the
  opposite here: positive kPa, higher = drier, verified by the scheduler's
  own `meanKpa >= threshold` comparison.
- Treating `swt_wm1`/`swt_wm2` as writable in new code — they are read-only
  legacy aliases; write to `swt_1`/`swt_2`/`swt_3`.
- Confusing native pF provenance with canonical SWT: the observation mirror preserves native tokens, while the scheduler always compares kPa.
- Assuming `TWD_rel` is available on the edge dashboard — it's cloud-only
  (v6, osi-server); the edge still runs its own absolute-µm v5 TWD/MDS.
  Don't conflate the two TWD implementations.
- Treating the partner institute dendrometer controller doc as shipped behavior —
  it explicitly says "Draft design, not shipped behavior."
- Assuming `TEKTELIC_CLOVER` reports VWC today — it's typed for a future
  channel but has no populated edge field (`edgeField: null` in the channel
  manifest).
- Assuming ET0 is still cloud-only — the edge now computes it itself
  (`osi-agronomy-daily`, three tiers); see the "ET0" section above.
- Treating a day with zero rain samples as "0.0 mm" — that conflates
  "no data" with "confirmed dry"; only ingest that actually observed zero
  should write zero.
- Confusing LoRain's interval rain (`rain_mm_delta` computed directly from
  a raw step count, no history lookup needed) with S2120's cumulative-counter
  delta (`4213` differenced against the previous stored
  `rain_gauge_cumulative_mm` row from the device's `cumulative_baseline` on,
  with explicit `counter_reset`/`duplicate_timestamp` guards).
- Treating S2120 measurement `4113` as cumulative rain. It is intensity in
  mm/h (six times the rain of the past ten minutes); only `4213` is a counter.
- Sending a bare `CLOSE` to a STREGA valve for any reason, including test
  cleanup — always use a short `OPEN_FOR_DURATION` or the cancel endpoint.
- Assuming the DRAGINO_LSN50 battery footer is always hidden because the
  device only reports `bat_v` — the voltage-derived fallback (issue #51)
  means it now shows a computed percentage; this contradicts older notes
  that predate that fix.
- Treating `strega_model` and `strega_generation` as the same axis, or
  assuming one predicts the other. `strega_model` is hardware (STANDARD vs
  MOTORIZED); `strega_generation` is controller firmware/codec (GEN1 vs
  GEN2); they vary independently.
- Assuming a Gen2 (SV2) STREGA valve's temperature/humidity gap can be
  closed with a decoder change — the SV2 payload has no spare bits or
  bytes for it (manual pp. 51-53, 110); nothing the device transmits
  carries it.
- Reading `device_data.ambient_temperature` on a `STREGA_VALVE` row as zone
  air temperature — it is the valve's own enclosure (`box_temp`), and must
  never feed an agronomy calculation.

## References

- `references/device-catalog.md`: Read to find which `device_data` column a device writes, its decoder, units, battery quirks, the edge catalog paragraphs moved from AGENTS.md, and LoRaWAN vocabulary. Sections: "Device catalog and units quick-reference"; "Device catalog (edge reference)"; "LoRaWAN / ChirpStack model (as used here)".
- `references/soil-water-tension.md`: Read for SWT storage and sign convention, pF, and the Chameleon sensor stack. Sections: "Soil water tension (SWT)"; "pF (soil water tension, logarithmic)"; "Chameleon sensor stack".
- `references/dendrometry-and-et0.md`: Read for MDS/TWD ownership (edge v5 vs cloud v6) and the three ET0 tiers. Sections: "Dendrometry"; "ET0 (reference evapotranspiration)".
- `references/rain-semantics.md`: Read for LoRain interval rain, S2120 intensity vs counter, and `rain_delta_status`. Sections: "Rain semantics".
- `references/strega-valves.md`: Read for valve commands, the on-valve scheduler FPorts, model vs generation, and enclosure climate. Sections: "STREGA valve semantics"; "STREGA on-valve scheduler"; "`strega_model` and `strega_generation` are independent axes"; "Enclosure temperature and humidity: Gen1 only, and not field weather".
- `references/provenance.md`: Read to re-verify this skill against the repo. Sections: "Provenance and maintenance".
