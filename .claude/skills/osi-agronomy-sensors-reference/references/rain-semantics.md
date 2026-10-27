# Rain semantics

Part of the osi-agronomy-sensors-reference skill; read SKILL.md first.

## Rain semantics

**Cardinal rule (engineering playbook, Prime Directive 3 — applies to ALL
sensors, not just rain):** a day with zero *samples* is "no data", never
"0.0 mm dry". Ingest writes real zeros when it is actually dry; never
substitute a plausible default for an absent measurement. This repo once
shipped a `-42 kPa` fallback and a `rootVwcPct ?? 24` fallback — both looked
like real agronomy and misled operators before being caught. `null` must
propagate end to end and render as an explicit "unavailable" state, not a
guessed number (`docs/engineering-playbook.md`, "1. Prime directives", item 3).

**AQUASCOPE_LORAIN (Aqua-Scope LoRain / RANLWE01):** reports **interval**
rainfall, not cumulative. The vendor payload command `0x06 0x81` carries raw
0.5 mm tip-bucket steps; the decoder
(`aquascope_lorain_decoder.js`) keeps the vendor value as `rainlevel` /
`rain_tips_delta` and exposes a normalized `rain_mm_delta = rainlevel * 0.5`
in millimeters directly — there is no delta computation against a previous
reading because each uplink already reports the interval, not a running
total. Because each report is already a delta, duplicate or out-of-order
uplinks must not be aggregated twice (edge catalog above). Public onboarding
uses FPort `10`; the legacy firmware decoder path uses FPort `2` — the decoder
accepts both. JoinEUI/AppEUI `4943485448592021` is public (already in the
edge catalog above); AppKey is fetched from Aqua-Scope with DevEUI + email and must
never be stored in this repo. Assigned LoRain gauges update
`zone_daily_environment` with `rain_source='aquascope_lorain'`.

**SENSECAP_S2120:** two different rain quantities (SenseCAP S2120 user
guide, sections 10.2, 10.3.1 and 13.3):
- measurementId `4113` ("Rain Gauge", frame `02` before firmware v2.0, `4B`
  from v2.0) is rainfall **intensity** in mm/h, resolution 0.001. The device
  derives it as six times the rainfall of the past ten minutes. It is a
  rate, never a counter: a drop in intensity is not a reset.
- measurementId `4213` ("Rain Accumulation", frame `4C`, firmware v2.0 and
  later) is **cumulative** rainfall in mm.

`flows.json` node `s2120-ingest-fn` ("Ingest S2120", the one S2120 writer;
rules in `osi-rain`: `parseS2120Measurements`, `deriveS2120Counter`,
`deriveS2120Legacy`, `ingestS2120Uplink`) stores `4113` as
`device_data.rain_mm_per_hour` and `4213` as
`device_data.rain_gauge_cumulative_mm`, and derives the interval amount
`rain_mm_delta` (kept to 0.001 mm; round only for display):
- **4213 present:** counter differencing against the previous stored
  `rain_gauge_cumulative_mm` of that DevEUI. The first `4213` row of a device
  gets `rain_delta_status='cumulative_baseline'`; only rows from that marker
  on are a counter baseline, because older rows may hold `4113` values that
  ingest before this contract stored in `rain_gauge_cumulative_mm`. A lower
  `4213` is `counter_reset` and becomes the new baseline.
- **4213 absent (firmware before v2.0):** `rain_gauge_cumulative_mm` stays
  NULL. `4113 / 6` is the interval amount only when the time since the
  previous rain uplink of the device is the vendor's 10-minute window
  (600 s ± 60 s); then the windows tile without gap or overlap. Any other
  interval (lost uplink, 5/15/30/60-minute cadence) or the first uplink
  leaves the amount NULL with `intensity_only` or `first_sample`.
- A device that has a `cumulative_baseline` row never integrates intensity:
  an uplink without `4213` gets `intensity_only`, and the next `4213` uplink
  counts that rain once.

`rain_delta_status` values: `cumulative_baseline`, `first_sample`,
`counter_reset`, `intensity_only`, `duplicate_timestamp`/`out_of_order` (a
same-or-later rain row already exists), `invalid_interval`,
`ambiguous_identity` (no ChirpStack `deduplicationId`), or `ok`.
Only `ok` samples have a non-null `rain_mm_delta`/`rain_mm_per_10min`, and only
those reach `zone_daily_environment`: in the same transaction the zone day is
set to the device's `ok` total inside that zone's local day, with
`rain_source='sensecap_s2120'` (multi-zone via the `weather_station_zones`
junction table, since one S2120 can serve multiple zones; else the device's
own zone). A zero increment never takes over a day another source owns.
Every uplink also gets a `rain_observations` row (`instrument_type
'SENSECAP_S2120'`, `frame_kind` `counter`/`ordinary`/`status`); a repeated
delivery or a retransmission is a duplicate, and a counter frame older than
the latest rain row carries `late_counter_frame` and is never counted.
`rain_mm_today` is the device's day in its zone timezone (device zone, else
first weather-station zone, else UTC), never the gateway host day. S2120 totals stored before this contract (ingest that differenced
`4113`) are not validated measurements; `scripts/assess-s2120-rain-history.js`
reports them per device and day against a DB copy.
