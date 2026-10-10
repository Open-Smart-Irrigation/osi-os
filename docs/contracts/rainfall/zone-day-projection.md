# Zone-day rainfall projection contract

This contract defines the rain fields of a `zone_daily_environment` row as the edge projects them and as the cloud receives them. A zone day carries a rainfall amount only when one selected gauge measured that whole farm day; every other day carries the reason it is not certified. Five optional payload fields carry that quality: `rain_coverage`, `rain_selected_deveui`, `rain_policy_version`, `rain_quality_reasons` and `rain_received_mm`.

The measurement rules for each instrument stay in that instrument's contract (`lorain.md` for the LoRain gauge, see `README.md` in this directory). This document covers what happens after them: how instrument days are formed, which gauge a zone uses, what reaches the projection, and how a late correction converges on the cloud.

## Status and rollout

The fields are additive. `contract_version` stays `1`: `events.schema.json` lets an event payload carry additional properties, and it defines no payload for `ZONE_ENVIRONMENT_APPENDED`, so the schema files do not change. Policy version 1 (`RAIN_POLICY_VERSION = 1`) is the first version that writes these fields.

The cloud receiver ships first. Before it, the cloud reads a payload `rainfall_mm: null` as "keep the previous value", and a new row as 0 mm; an edge that sends certified nulls to such a receiver would leave stale or zero rain on the cloud. Deploy the receiver of this contract to a cloud before any gateway linked to it emits the fields.

## Payload fields

The fields appear on every path that carries a `zone_daily_environment` row to the cloud: the `ZONE_ENVIRONMENT_APPENDED` event (insert and update triggers), the `zoneEnvironments` items of the bootstrap and force-sync snapshots, and the `zone_daily_environment` rows of history sync. The aggregate key stays `zone_uuid|date`. History sync sends each row whole (`SELECT zde.*`), so its rows carry the five fields and `sync_version` without a change to the history code; the section "History rows" below says what must stay fixed there.

| Field | Type | Values |
|---|---|---|
| `rainfall_mm` (existing) | number or null | The selected gauge's amount for the farm day, in millimetres. Non-null only when `rain_coverage` is `complete`. |
| `rain_source` (existing) | string | `aquascope_lorain`, `sensecap_s2120` or `local_gauge` for the selected gauge's type; `none` when no gauge is selected. |
| `rain_coverage` | string or null | `complete`, `complete_so_far`, `partial`, `unknown`. Null only on a row written before policy version 1. |
| `rain_selected_deveui` | string or null | The selected gauge, 16 uppercase hex digits. Null when the zone has no gauge or its gauges are ambiguous. |
| `rain_policy_version` | integer or null | The policy that computed the row; `1` for this contract. Null on a legacy row. |
| `rain_quality_reasons` | array of strings, JSON text, or null | Reason codes without duplicates: the instrument's codes first, then the zone's own. An empty array means no reason applies. Events and snapshot items carry a JSON array, never a string that contains one; history rows carry the stored JSON text. Receivers accept both forms. |
| `rain_received_mm` | number or null | Sum of the selected gauge's accepted amounts received during the farm day. "Received in this period", never a measured day total. Null when no gauge is selected. |

### Coverage values

| `rain_coverage` | Meaning | `rainfall_mm` | `rain_received_mm` |
|---|---|---|---|
| `complete` | The day has ended, and the selected gauge's accepted intervals cover all of it with every boundary allocation proven. | The measured amount | The amount received during the day. It differs from `rainfall_mm` only when a frame received exactly at one of the two midnights measured a window on the other side |
| `complete_so_far` | The day has not ended. The intervals cover it from midnight up to the observed cutoff (the latest accepted frame), and nothing breaks the chain so far. Reason `ongoing`. | null | The amount measured up to the cutoff |
| `partial` | Interval evidence is usable, but a known part of the day is uncovered (a frame gap, a session reset, a day still in progress after a gap). | null | The amount received; the day's rain can be higher |
| `unknown` | Measurement bounds, boundary allocation, continuity, overlap, the timezone or the source cannot be established. Also every day of a zone with no gauge or with ambiguous gauges. | null | As received, or null without a selected gauge |

`unknown` wins over `partial` when both apply. A `complete` row may still carry reason codes that do not block certification, such as `timezone_abbreviation`. Any coverage value outside this table is read as `unknown`.

`legacy_unvalidated` is the name the gateway's own read-side APIs may give a row whose `rain_coverage` is null. The edge never sends it as a payload value.

### Legacy rows and older gateways

**Legacy rule.** A row whose payload carries no `rain_policy_version` (key absent or null) is a legacy row. The cloud displays and uses it exactly as it did before this contract: the amount as received, no coverage label, and the same advice rules as before. Only a row that carries `rain_policy_version` follows the quality model of this document. The rule holds for the whole rollout, which deploys the cloud receiver before any edge emits the fields, and afterwards for every gateway that has not upgraded.

Rows written before policy version 1 get no bulk rewrite. The edge re-projects such a row at policy version 1 only when it accepts an observation for that zone and date after the upgrade, typically on the upgrade day, or when a flow-meter write for that date meets the condition in "Gauge selection"; until then the row keeps its stored values and stays legacy. Its five new fields are null, and its `rainfall_mm` is a value no coverage rule produced.

A payload from an older gateway lacks the five keys, and the receiver stores the row as legacy, as if the keys were present with null values. Only `rainfall_mm` tells an absent key from a present null:

| `rainfall_mm` in the payload | Receiver stores |
|---|---|
| Key present, value a number | The number |
| Key present, value null | Null. The day's rain is unknown now, even if an earlier version carried a number. |
| Key absent | The stored value, unchanged |

## Reason codes

`rain_quality_reasons` is an open vocabulary. A receiver stores and displays the codes it receives and never rejects a payload because of an unknown code. No consumer derives certification from the reasons; `rain_coverage` alone decides that.

The codes of an instrument's own contract pass through unchanged; for the LoRain gauge they are the reason-code table of `lorain.md` (for example `received_only`, `frame_gap`, `session_reset`, `build_unpinned`, `boundary_allocation`, `ongoing`). The projection adds these codes:

| Code | Effect on coverage | Meaning |
|---|---|---|
| `gauge_ambiguous` | `unknown` | Two or more gauges are eligible for the zone and the operator has selected none. |
| `no_gauge` | `unknown` | The zone has no eligible gauge. |
| `timezone_invalid` | `unknown` | The zone's stored timezone is not a valid IANA name; the day was computed in UTC and is never certified. |
| `timezone_abbreviation` | none | The zone's timezone is an abbreviation such as `CET`. Days stay certifiable, and the flag prompts the operator to choose a region name (owner decision D6). |
| `counter_reset` | `partial` at best | A cumulative rain register (S2120, LSN50 counter) restarted inside the day. |
| `late_counter_frame` | blocks `complete` | A cumulative-register frame arrived out of order, so the deltas around it cannot be trusted. |
| `frame_gap` (day bounds) | `partial` at best; `unknown` when the day has no frame at all | Besides the missing fCnt value of `lorain.md`: the day is not bounded yet. No frame of the instrument lies before its start, or the day has ended and no frame lies at or after its end. The edge recomputes the day when the bounding frame arrives. |
| `zone_reassigned` | `partial` at best; `unknown` when nothing was received under this zone | The selected gauge reported under another zone for part of the farm day (it was moved, or a weather-station link changed). The zone counts only the observations received under it: `rainfall_mm` is null and `rain_received_mm` is that share. |
| `ambiguous_identity` | `unknown` | A frame of the day arrived without an observation identity (no `deduplicationId`); its amount is not counted. |

Cumulative registers pass their sample status through as instrument reasons. `first_sample`, `cumulative_baseline` and `missing_previous_count` leave the day `partial` at best; `invalid_interval`, `intensity_only`, `out_of_order`, `duplicate_timestamp` and `legacy_intensity_window` make it `unknown`. The edge treats a code it does not classify as blocking certification.

## Instrument days

Coverage is first assessed per instrument and farm day, keyed by `(deveui, date, timezone)`. `date` is the farm day in the zone's IANA timezone, midnight to the next midnight, including 23- and 25-hour DST days. A gauge that serves zones in two timezones has a separate day in each.

The edge recomputes an instrument day from its accepted observations every time an observation for it is accepted, including a delayed one, and every time a re-assessment changes the status of an earlier observation (for example, when the first frame of a same-slot pair is withdrawn). It never increments a stored total. Two kinds of instrument exist:

- **Interval instruments** (LoRain). Each accepted frame covers a measurement interval. A day is `complete` only under the coverage rule of `lorain.md`: one fCnt-continuous chain in one session, a frame at or after the day end, a promoted device (configuration reply, continuity and a pinned build, owner decision D9), and proven allocation at both boundaries. A non-zero window that crosses midnight blocks certification of both days (`boundary_allocation`); a zero window splits exactly.
- **Cumulative instruments** (S2120 register, LSN50 tip counter). A day is `complete` when the register did not reset, no frame arrived out of order, frames exist on both sides of each boundary, and the deltas of the two frame pairs that straddle the boundaries are zero, or a frame lies exactly on the boundary.

A gauge without promotion evidence never produces a `complete` day. For a LoRain gauge that is not yet promoted, every day is `unknown` with `received_only`, `rainfall_mm` stays null, and `rain_received_mm` shows what arrived.

Each observation keeps the zone it was received under. A device moved to another zone leaves its earlier days in the earlier zone, and the new zone gets only observations received after the move. On the day of the move each zone counts only the observations received under its own zone, and neither zone certifies that day: its coverage is `partial` at best in both, with reason `zone_reassigned`.

## Gauge selection

A zone uses at most one gauge per day. Two gauges observing one field are never added, and arrival order never chooses between them (owner decision D1).

The candidates are the zone's devices of type `AQUASCOPE_LORAIN` or `SENSECAP_S2120`, its devices with `rain_gauge_enabled = 1`, and weather stations linked to the zone through `weather_station_zones`. The edge resolves the selection in this order:

1. The operator's explicit selection, while that device is still a candidate.
2. The only candidate, when there is exactly one.
3. Otherwise, with two or more candidates, the zone is ambiguous: `rain_source` is `none`, `rain_selected_deveui` and `rainfall_mm` are null, `rain_coverage` is `unknown` and the reasons contain `gauge_ambiguous`. The gateway GUI suggests a gauge, and the zone stays ambiguous until the operator confirms one.
4. With no candidate: `rain_source` `none`, coverage `unknown`, reason `no_gauge`.

The selection is gateway state. The cloud sees its result in `rain_selected_deveui` and cannot change it under contract version 1.

The zone day projects the selected gauge's instrument day for that date: its coverage, its reasons followed by the zone's own (timezone flags), its received amount, and its amount when coverage is `complete`. Every row the edge inserts at policy version 1 or later carries a non-null `rain_coverage`, including a row created by a flow-meter write, and so does every row whose rain fields the edge writes. A flow-meter write on a legacy row re-projects the row only when the projection keeps the row's `rain_source` (or the row has none) and its `rain_received_mm` is at least the row's stored `rainfall_mm`. Otherwise the write changes `flow_liters` alone and the row stays legacy.

## Versions and late corrections

`sync_version` belongs to the `(zone_uuid, date)` row and only increases. Every write that changes `rainfall_mm`, `flow_liters`, `rain_source`, `rain_coverage`, `rain_selected_deveui`, `rain_policy_version`, `rain_quality_reasons` or `rain_received_mm` increments it by one and writes a new `computed_at`, in the same statement. A rain recomputation that changes none of these leaves both alone and emits no event.

A late distinct observation can change a past day: it can close a frame gap or supply the frame after midnight that a `complete` day needs. The edge then recomputes the instrument day and the zone day, the projected fields change, `sync_version` increments once, and the update trigger emits one event with the new values. Re-delivering the same observation changes nothing and emits nothing.

The cloud converges by version, with a different rule for events than for the two paths that write the row directly.

Events pass the cloud's existing resource watermark for `ZONE_ENVIRONMENT|zone_uuid|date`. This contract does not change that path:

| Incoming event against the watermark | Cloud answer |
|---|---|
| Newer version | Applied; the watermark advances |
| Older version | Rejected `stale_sync_version` |
| Equal version, different payload | Rejected `equal_version_payload_conflict` |

Both rejection codes are permanent in `docs/contracts/sync-schema/rejection-recovery-v1.json`, so the edge outbox moves past them.

Bootstrap and force-sync `zoneEnvironments` items and history rows bypass the watermark. For them the receiver compares the row's `sync_version` with the stored one:

| Stored `sync_version` | Incoming `sync_version` | Receiver |
|---|---|---|
| null | any | Applies the row |
| n | ≥ n | Applies the row. An equal version carries the same rain and flow fields; `computed_at` may differ. |
| n | < n | Ignores the row without rejecting it |
| n | key absent | Applies the row, as before this contract. Only a row without the key takes this branch; current snapshot items and history rows carry it. |

### History rows

The history hash v1 of a `zone_daily_environment` row stays the six columns it covers today: `zone_uuid`, `date`, `rainfall_mm`, `flow_liters`, `rain_source` and `computed_at` (`scripts/lib/history-hash-v1.js`, golden vector `zone-environment-rain-and-flow` in `docs/sync/history-hash-v1-fixtures.json`). The five quality fields and `sync_version` travel in the row unhashed. The cloud recomputes the hash for each row and answers `hash_mismatch`, a permanent rejection that stops the batch, when the two sides disagree, so adding columns to the hash on one side would stall the history sync of every gateway on the other version.

The cloud also skips a history row whose hash equals the stored one as a duplicate. A change of coverage or reasons alone would therefore never reach the cloud through history if it left the hashed columns unchanged; the new `computed_at` written with every projected change prevents that.

For a row that carries `rain_policy_version`, advice that needs measured rain reads `rainfall_mm` only when `rain_coverage` is `complete`; a legacy row follows the legacy rule above. Whether an advice rule may use `rain_received_mm`, for example as a lower bound, is decided by that rule's own policy; this projection only labels the amount.

## Example payloads

A day completed by a late observation, emitted as the second event for that row. The device EUI is synthetic.

```json
{
  "contract_version": 1,
  "zone_uuid": "6f1c2a9e0b4d4e6f8a1b2c3d4e5f6a7b",
  "date": "2026-10-08",
  "rainfall_mm": 4.5,
  "flow_liters": 0,
  "rain_source": "aquascope_lorain",
  "rain_coverage": "complete",
  "rain_selected_deveui": "A840410000000001",
  "rain_policy_version": 1,
  "rain_quality_reasons": [],
  "rain_received_mm": 4.5,
  "sync_version": 4
}
```

A zone with two eligible gauges and no selection:

```json
{
  "contract_version": 1,
  "zone_uuid": "6f1c2a9e0b4d4e6f8a1b2c3d4e5f6a7b",
  "date": "2026-10-09",
  "rainfall_mm": null,
  "flow_liters": 120.5,
  "rain_source": "none",
  "rain_coverage": "unknown",
  "rain_selected_deveui": null,
  "rain_policy_version": 1,
  "rain_quality_reasons": ["gauge_ambiguous"],
  "rain_received_mm": null,
  "sync_version": 2
}
```

A LoRain gauge without promotion evidence, during the day:

```json
{
  "contract_version": 1,
  "zone_uuid": "6f1c2a9e0b4d4e6f8a1b2c3d4e5f6a7b",
  "date": "2026-10-10",
  "rainfall_mm": null,
  "flow_liters": 0,
  "rain_source": "aquascope_lorain",
  "rain_coverage": "unknown",
  "rain_selected_deveui": "A840410000000001",
  "rain_policy_version": 1,
  "rain_quality_reasons": ["received_only", "ongoing"],
  "rain_received_mm": 2.0,
  "sync_version": 7
}
```

The examples leave out `zone_id`, `computed_at` and `gateway_device_eui`, which the event carries as before.
