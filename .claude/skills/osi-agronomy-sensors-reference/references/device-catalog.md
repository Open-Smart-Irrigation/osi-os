# Device catalog

Part of the osi-agronomy-sensors-reference skill; read SKILL.md first.

## Device catalog and units quick-reference

| Device | ChirpStack app | Custom OSI decoder? | Primary `device_data` fields | Units |
|---|---|---|---|---|
| `KIWI_SENSOR` | Sensors | Vendor — `tektelic_agriculture_decoder.js` (upstream TEKTELIC agriculture codec, shared with CLOVER; a codec attached by hand is kept) | `swt_1`, `swt_2` (via legacy `swt_wm1/2` aliasing), `light_lux`, `ambient_temperature`, `relative_humidity` | kPa, lux, °C, %RH |
| `TEKTELIC_CLOVER` | Sensors | Vendor — `tektelic_agriculture_decoder.js` (upstream TEKTELIC agriculture codec, shared with KIWI) | same shape as KIWI; VWC is **typed but not populated** (see VWC note below) | °C, %RH; VWC not stored |
| `DRAGINO_LSN50` | Sensors | Yes — `dragino_lsn50_decoder.js` | `ext_temperature_c` (DS18B20), `adc_ch0v/adc_ch1v`, `bat_v`, plus MOD-specific: `dendro_position_mm`/`dendro_*` (dendrometer), `rain_*` (rain gauge), `flow_*` (flow meter), and Chameleon `swt_1/2/3` when a VIA Chameleon module is attached over I2C | °C, V, mm, µm, L |
| `SENSECAP_S2120` | Sensors | Yes — `sensecap_s2120_decoder.js` | `ambient_temperature`, `relative_humidity`, `light_lux`, `barometric_pressure_hpa`, wind speed/direction/gust, `uv_index`, `rain_mm_per_hour` (4113 intensity), `rain_gauge_cumulative_mm` (4213 counter) → `rain_mm_delta`/`rain_mm_today`, `bat_pct` | °C, %RH, hPa, m/s, deg, mm/h, mm |
| `AQUASCOPE_LORAIN` | Sensors | Yes — `aquascope_lorain_decoder.js` | `rain_mm_delta` (from raw 0.5 mm steps), `ambient_temperature`, `bat_v` | mm, °C, V |
| `STREGA_VALVE` | Actuators | Yes — `strega_gen1_decoder.js` | `devices.current_state` (not a `device_data` column), `bat_pct`/`bat_v`, plus Gen1-only `ambient_temperature`/`relative_humidity` (enclosure climate, see below) | °C, %RH |
| `MILESIGHT_UC512` | Actuators | Yes — `milesight_uc512_decoder.js` | `valve_1_state`/`valve_2_state` (text), `valve_1_pulse`/`valve_2_pulse` (integer), `pipe_pressure_kpa` (real) | —, counts, kPa |

File locations for all OSI-authored decoders:
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/` (list with `ls` there; as of 2026-09-14: aquascope_lorain, dragino_lsn50, milesight_uc512, sensecap_s2120, strega_gen1, strega_gen2).
The same directory also holds `agroscope_uplink_transform.js`, the edge→partner-institute IoT forwarding transform (osi-os PR #110) — it is not a device decoder.
`tektelic_agriculture_decoder.js` is the upstream TEKTELIC agriculture sensor codec (one codec for KIWI and CLOVER), vendored unmodified; the bootstrap attaches it to the `OSI KIWI Sensor` and `OSI CLOVER Sensor` profiles when they have no codec, and leaves a codec already there (for example one attached by hand) alone. Kiwi and Clover uplinks are decoded only by this profile codec; Node-RED has no decoder for them. It emits `input5_frequency`/`input6_frequency` for the KIWI watermark inputs, which Process Data accepts beside `watermark1_frequency`/`watermark2_frequency` (the names of the vendor's later decoder).

**VWC note (not implemented on the edge):** `web/react-gui/src/types/farming.ts` types a
`VWC` trigger metric as "planned; typed now", and `docs/channel-manifest.md`
records the canonical `vwc` manifest entry with `edgeField: null` — there is no
local osi-os telemetry column for VWC today. Do not assume `TEKTELIC_CLOVER`
populates a VWC column; treat the edge catalog's "VWC" label (below) as the intended
sensor capability, not a shipped field.

**Battery quirks (verified in code, not just docs):** the shared footer
(`web/react-gui/src/components/farming/shared/DeviceCardFooter.tsx` →
`deviceCardBattery.ts`, `buildDeviceFooterMeta`) prefers a real `bat_pct` and
**falls back to a voltage-derived percent from `bat_v`** using a fixed LSN50
discharge curve (`getBatteryPercentFromVoltage`, 2.1 V = 0%, 3.6 V = 100%,
clamped) when `bat_pct` is absent or not a valid finite 0-100 value. `DraginoTempCard.tsx` passes both
`batteryPercent={bat_pct}` and `batteryVoltage={bat_v}`, so `DRAGINO_LSN50`
devices that only report `bat_v` still show a footer percentage. This closed
GitHub issue #51 (`osi-os`); it supersedes any older note claiming the LSN50
battery footer is hidden — that was true before the voltage-fallback shipped
(commit `01dc45fa`, "derive lsn50 battery footer percent") and is stale now.

## Device catalog (edge reference)

Moved from `AGENTS.md` on 2026-10-22 (that file keeps a one-line type list and
the binding rule lines); this section carries the same authority as
`AGENTS.md`. It records the ChirpStack application and profile per device type
and the device-semantics paragraphs that used to sit under the catalog there.

| Device | ChirpStack app | Profile | Sensors |
|--------|----------------|---------|---------|
| KIWI_SENSOR | Sensors | OSI KIWI Sensor (Tektelic agriculture codec) | SWT, light, temp, humidity |
| TEKTELIC_CLOVER | Sensors | OSI CLOVER Sensor (Tektelic agriculture codec) | Ambient temp, humidity, light (VWC not stored) |
| DRAGINO_LSN50 | Sensors | LSN50 | Ext temp, ADC (dendrometer, rain, flow), WATERMARK or Chameleon SWT |
| DRAGINO_SDI12 | Sensors | OSI SDI-12 Soil Node | Probe-profile VWC, soil temp, soil EC, battery |
| SENSECAP_S2120 | Sensors | S2120 | Wind, rain, pressure, UV, temp/humidity |
| AQUASCOPE_LORAIN | Sensors | LoRain | Interval rain, ambient temp, battery |
| STREGA_VALVE | Actuators | OSI STREGA Valve / OSI STREGA Valve Gen2 | Valve state, battery |
| MILESIGHT_UC512 | Actuators | OSI Milesight UC512 | Two valve states, pulse counts, pipe pressure |
| RAK10701_FIELD_TESTER | Field Tester | OSI RAK Field Tester | Coverage probe (RSSI/SNR) |

**SWT canonicalization:** `device_data.swt_1`, `swt_2`, `swt_3` are canonical positive kPa magnitudes. Legacy `swt_wm1` / `swt_wm2` are read-only aliases. The shared hPa conversion is `pF = log10(abs(kPa)) + 1`, inverse magnitude `10 ** (pF - 1)`. Zero/non-finite input has no pF; finite negative pF is valid. Sensor adapters reject their own sentinels before conversion. Preserve calculated doubles without decimal rounding; round display strings only. Native Tensiomark pF tokens are retained in `tensiomark_observations.normalized_json` and mirrored to the cloud as observation provenance. Aggregate canonical kPa before deriving pF; the scheduler still uses kPa. Contract and cross-runtime vectors: [matric-potential/v1.md](../../../../docs/contracts/matric-potential/v1.md).

**Unified SWT estimates:** WATERMARK `wm-lsn50-p3-v3` copies a finite clipped estimate into canonical kPa while retaining raw clipping diagnostics. Ordinary cards and calculations use canonical values without a diagnostic-status gate. Shared GUI domain: finite 0..1,000,000 kPa for every source; zero remains unavailable in pF. The edge scheduler averages KIWI, SDI-12 (including Tensiomark) and Chameleon observations; the WATERMARK phase 1 interlock still keeps every WATERMARK-linked observation out of irrigation until the phase 3 explicit enable. Historical clipped nulls use the explicit backed-up correction tool, never replacement append events. See [unified soil tension](../../../../docs/operations/unified-soil-tension.md).

**Aqua-Scope LoRain:** `AQUASCOPE_LORAIN` is the Aqua-Scope LoRain / `RANLWE01` rain gauge, provisioned into ChirpStack `Sensors` as LoRaWAN 1.0.3 OTAA Class A. Public onboarding uses FPort `10`; the legacy firmware decoder uses FPort `2`, so `aquascope_lorain_decoder.js` accepts both. JoinEUI/AppEUI is `4943485448592021`; AppKey is retrieved from Aqua-Scope with DevEUI + email and must not be stored in this repo. Payload command `0x06 0x81` reports raw 0.5 mm steps: the decoder keeps vendor `rainlevel` as raw steps and exposes normalized `rain_mm_delta` in millimeters. LoRain rainfall is interval rainfall, not cumulative; duplicate or out-of-order timestamps must not aggregate twice. Assigned LoRain gauges update `zone_daily_environment` with `rain_source='aquascope_lorain'`.

**STREGA timed irrigation:** user-facing opens are `OPEN_FOR_DURATION`; normal close is the valve's own timed close, not a bare `CLOSE` command. Operator cancellation uses `POST /api/v1/valves/:deveui/cancel` and flushes the ChirpStack device queue. It marks the latest active `valve_actuation_expectations` row `CANCELLED` only when the open provably never reached ChirpStack; an open that was handed to ChirpStack is answered `handed_off` (a pre-flush queue read cannot prove it undelivered) and keeps fencing the valve until its bounded duration has passed. Actuation expectations store `commanded_at`, duration, `expected_close_at`, observed open/close timestamps, `reconciliation_state`, and optional `estimated_gross_liters`. Active states are `PENDING_OBSERVATION` and `OBSERVED_RUNNING`. `zone_irrigation_calibration` stores per-zone flow-rate measurements used for estimates; if it is absent on an older Pi, actuation rows still insert with null estimated volume. `zone_daily_environment.flow_liters` remains measured flow-meter data only; estimated valve-time volume stays separate. The reconciliation monitor reads STREGA state from `devices.current_state` and recent uplink time from `device_data.recorded_at`.

**Valve control (2026-08):** `ValveControlPanel` lists every STREGA valve across zones. Weekly schedules (`valve_schedules`, kind `WEEKLY`) are compiled by `osi-valve-control` into the valve's own scheduler (Gen1 FPort 14–20 one weekday per downlink, Gen2 FPort 25 day-mask; ≤ 4 windows per weekday) and pushed only on a user change or explicit re-send — never on a timer, so Bluetooth edits on an SV2 are not overwritten. Pushes leave through their own `mqtt out` node. Shared STREGA writer guards coordinate plan and actuation writes; conflicting manual opens can now return `valve_busy` while an earlier command remains active or unresolved. Push delivery is tracked in `valve_schedule_pushes`; `valve-ack-fn` reads the uplink ACK behind the same STREGA-profile gate `strega-process-fn` uses. Gen1 weekday ACKs arrive via `Schl_Port` 14–20; Gen2 daymask ACKs arrive via `Ack_Port` 25 (or the raw-byte fallback); scheduler-status ACKs arrive via `Schl_status_Port`/`Ack_Port` 21; clock ACKs arrive via `RTC_Port`/`Ack_Port` 12/13. One-time opens (kind `ONCE`) fire from a 60 s tick and are skipped, never fired late, once more than 10 min overdue; a second 60 s tick observes valve-fired runs. The gateway owns the valve clock (Gen1 FPort 12 local wall-clock), resynced by a 10-minute tick that covers the weekly cadence and DST transitions. Valve-fired opens land in `valve_actuation_expectations` with `trigger='on_valve_schedule'`. `valve_schedules` carries `schedule_uuid`/`sync_version`/`deleted_at`; migration 0077 adds its sync triggers and the paired server mirror. The legacy threshold scheduler is labelled "Trigger-based irrigation". Explicit conversion replaces its execution with the conditional policy described below.

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
[execution report](../../../../docs/superpowers/plans/2026-10-13-conditional-irrigation-execution-report.md)
for software evidence and unrun hardware gates.

The future opt-in dendrometer controller architecture is maintained outside this public repository. It is recommendation-only, edge-authoritative, and not current shipped behavior.

## LoRaWAN / ChirpStack model (as used here)

- **OTAA (Over-The-Air Activation):** the device negotiates session keys with
  the network at join time instead of shipping hardcoded session keys. All
  OSI device types join via OTAA.
- **DevEUI:** a device's globally unique 64-bit identifier (16 hex chars);
  primary key for `devices.deveui`.
- **JoinEUI / AppEUI:** identifies the join server a device should join
  through (older spec name is AppEUI, 1.1 renamed it JoinEUI). Aqua-Scope
  LoRain's is `4943485448592021` (public, already in the edge catalog above).
- **AppKey:** the root key used to derive OTAA session keys. Device-specific,
  never stored in this repo.
- **FPort:** the LoRaWAN application port number in an uplink/downlink,
  used here to distinguish payload formats/versions within a device family
  (LoRain FPort `10` vs legacy `2`; LSN50 FPort `2` sensor data vs FPort `5`
  config/status).
- **Uplink / downlink:** device→network and network→device LoRaWAN frames.
- **Class A:** the lowest-power LoRaWAN device class — the device only opens
  receive windows right after it transmits (no scheduled downlink reception
  otherwise). All OSI device types listed here are Class A.

**Device-type discrimination is never hardcoded** to a ChirpStack application
UUID (those are generated per-installation at bootstrap). It's done via
`CHIRPSTACK_PROFILE_*` env vars with a `deviceProfileName` fallback — the
exact env semantics belong to **osi-config-and-flags**, not here. All MQTT
uplink subscriptions use the wildcard topic `application/+/device/+/event/up`
(`scripts/check-mqtt-topics.sh` enforces this). ChirpStack apps are split
`Sensors` (all sensor device types), `Actuators` (`STREGA_VALVE`,
`MILESIGHT_UC512`) and `Field Tester` (`RAK10701_FIELD_TESTER`), per
`post-devices-insert` / `cs-reg-cloud-fn` in flows.json — device catalog
(edge reference) above.
