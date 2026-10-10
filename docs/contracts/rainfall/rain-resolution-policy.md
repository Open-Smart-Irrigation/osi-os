# Rain-resolution policy for advice

This policy decides which rain amount an advice rule uses for one zone and one farm day, and what the rule may conclude from it. It is rain policy version 1 (`RAIN_POLICY_VERSION = 1`). The edge implements it in `osi-rain.resolveAdviceRain`; every cloud consumer that turns rain into advice applies the same steps in the same order to the mirrored zone day.

The policy replaces the rule that picked local rain only when it was positive. Under that rule a measured dry day fell through to provider rain, so a provider's 6 mm could start rain suppression on a day the zone's own gauge measured 0 mm. Here the evidence decides: which source measured the day, and how much of the day it covered. Whether an amount is positive never changes which source is selected.

The zone-day fields this policy reads (`rainfall_mm`, `rain_coverage`, `rain_selected_deveui`, `rain_received_mm`, `rain_quality_reasons`, `rain_policy_version`) and their coverage values are defined in [`zone-day-projection.md`](zone-day-projection.md). The instrument rules behind them are in the instrument contracts listed in [`README.md`](README.md).

## Inputs

`resolveAdviceRain(t, zoneId, date, provider)` reads, inside the caller's read transaction `t`:

- the zone's `zone_daily_environment` row for `date`, the farm day in the zone's IANA timezone;
- the zone's gauge selection for that day, so a reason such as `gauge_ambiguous` or `no_gauge` is known even when no row exists.

`provider` is the provider rain the consumer already holds for the same farm day, or null. It carries the amount in millimetres, a source label, the period the amount covers (the farm day, or a UTC day), and whether the provider reported precipitation for the whole period. The function makes no network call. A caller that fetches weather does so before or after the read, never inside a write transaction.

## The four steps

The steps run in order. The first step that yields an amount fills `amountMm` and ends the search for an amount; step 2 never fills `amountMm` and never ends the search. Steps 1 and 2 read only a zone row that carries `rain_policy_version`. A legacy row takes the legacy rule (see "Legacy rows") in their place, and steps 3 and 4 follow when it yields no amount.

### Step 1: certified local day

The zone's selected gauge certified the day:

- `rain_coverage = 'complete'`: `amountMm = rainfall_mm`, `coverage = 'complete'`.
- `rain_coverage = 'complete_so_far'` and `date` is the zone's current farm day: `amountMm = rain_received_mm`, the amount measured from midnight up to the cutoff, `coverage = 'complete_so_far'`.

`source` is `local_gauge` and `deveui` is `rain_selected_deveui`. A certified 0 mm is a measured dry day. It wins over any provider value, including a provider that reports rain for the same day.

A `complete_so_far` row for a date that is no longer the current farm day was not recomputed after midnight. Step 1 does not accept it; step 2 reads it as a partial day.

### Step 2: local lower bound

The zone has a selected gauge, its day is not certified (`partial`, `unknown`, or `complete_so_far` on a past date), and `rain_received_mm` is a number. Then `lowerBoundMm = rain_received_mm` and `deveui = rain_selected_deveui`. The reasons gain `local_partial` or `local_unknown`.

A received amount proves that at least that much rain fell, and nothing more. It has two permitted uses:

1. Entering rain suppression (owner decision D9 (a)): see "What a rule may conclude" below.
2. Display, labelled "received only" or "so far", never as the day's total.

It never proves a dry day, never fills a water balance, and never enters a rolling rain sum. A received 0 mm on an uncertified day is no rain evidence at all.

The search for `amountMm` continues with step 3.

### Step 3: provider rain

The consumer holds a provider value for the farm day. The tiers, in order:

1. A station-measured value (MeteoSwiss station rain), over the farm day.
2. A station-measured value over a UTC day. It is used and labelled with reason `utc_day_period`; it is never presented as the farm day.
3. A modelled value (forecast or archive, for example Open-Meteo or OpenAgri).

A consumer uses the tiers it has, in this order. A provider value counts only when the provider reported precipitation for every hour of its period, or delivered a daily total for that period. A provider period with missing hours is skipped with reason `provider_partial`, and its sum is not a lower bound. A temperature-only answer carries no rain.

`amountMm` is the provider amount, `coverage = 'complete'` (over the labelled period), and `source` is the provider's label, for example `meteoswiss_station` or `open_meteo`. A lower bound from step 2 stays in the result next to it.

### Step 4: unknown

No step yielded an amount: `amountMm = null`, `coverage = 'unknown'`, `source = 'none'`, and the reasons gain `rain_unknown`. `lowerBoundMm` keeps the value step 2 found, if any.

## Result

| Field | Value |
|---|---|
| `amountMm` | The day's rain from step 1 or step 3, in millimetres; null at step 4. |
| `lowerBoundMm` | The received amount of an uncertified local day (step 2); null when step 1 answered, when no gauge is selected, or when nothing was received. |
| `coverage` | Coverage of `amountMm`: `complete` or `complete_so_far` from step 1, `complete` from step 3, `legacy_unvalidated` from a legacy row, `unknown` at step 4. |
| `source` | `local_gauge` (step 1 or a legacy local amount), the provider label (step 3), or `none` (step 4). |
| `deveui` | The selected gauge whose day gave `amountMm` or `lowerBoundMm`; null when neither came from a gauge. |
| `reasons` | The zone day's `rain_quality_reasons` (or the selection's reason when no row exists), then the policy's codes below. No duplicates. |
| `policyVersion` | `1`. |

Every consumer stores `source`, `coverage` and `deveui` with the advice it derives, so a reader can tell which rain the advice used.

| Policy reason code | Added when |
|---|---|
| `local_partial` | Step 2 read a `partial` day, or a `complete_so_far` row on a past date. |
| `local_unknown` | The local day is `unknown`, or no zone row exists for the date while a gauge is selected. |
| `utc_day_period` | The provider amount covers a UTC day, not the farm day. |
| `provider_partial` | A provider period was skipped because hours were missing. |
| `legacy_row` | The zone row carries no `rain_policy_version`; see "Legacy rows". |
| `rain_unknown` | Step 4 answered. |

The vocabulary is open in the same way as `rain_quality_reasons`: a consumer stores and shows codes it does not know.

## What a rule may conclude

| Rule | Uses | Unknown rain (`amountMm` null) |
|---|---|---|
| Entering dendrometer rain suppression | The larger of `amountMm` and `lowerBoundMm`, ignoring nulls, compared with 5 mm; the same number picks the 72-hour timeout at 15 mm or more | Never starts suppression; a lower bound of 5 mm or more still does |
| Dendrometer rolling 7-day rain (heavy rain above 20 mm) | The sum of `amountMm` over the seven calendar days ending on the analytics date | The day is missing: it adds nothing and is not counted present |
| Zone water balance and verdict | `amountMm` | Owner decision D2, warn mode: the verdict is computed on the supply without rain and carries `rain_unknown`; it is answered `insufficient_data` / `rain_unknown` only when it still needs a missing forecast. Advice is never withheld for unknown rain alone |
| Prediction forcing rain | `amountMm` | Null; the prediction engine's own handling of a missing day applies |
| Stored recommendation `rainfall_mm` | `amountMm` | Stored as null, never 0 |

Dendrometer stress actions do not depend on rain and keep their behaviour when rain is unknown.

The larger-of rule exists because a provider can understate rain that a gauge partly received. With a partial local day that received 7 mm and a provider day of 2 mm, `amountMm` is 2 (water balance, rolling sum) and suppression starts on 7. The policy does not raise `amountMm` to the lower bound: a received amount is not a day total.

## Legacy rows

**Legacy rule.** A zone row without `rain_policy_version` (null, or the column or payload key absent) is a legacy row. Every consumer reads a legacy row exactly as its last release before policy version 1 did, with one exception that binds both sides: no consumer adds the rain of two gauges (owner decision D1). The result carries `coverage = 'legacy_unvalidated'` when a legacy amount is used, and reason `legacy_row` either way.

| Consumer | Reading of a legacy row |
|---|---|
| Edge dendrometer analytics | A local amount greater than 0 is the day's rain (`source = 'local_gauge'`). A local 0 or null is no evidence, and the search continues with step 3 |
| Edge zone water tile | `osi-zone-env.resolveRainTodayMm`: a non-zero amount from a gauge source is measured; an exact 0 counts only while a rain-measuring device is configured for the zone |
| Cloud zone water heuristic | The same evidence rule as the edge zone water tile |
| Cloud dendrometer analytics | Provider rain only, as before; the legacy row is not read |
| Cloud prediction forcing | One assigned weather station's own day, when exactly one is assigned; with two or more, no station rain (reason `gauge_ambiguous`) and the provider tier answers |

Rows get no bulk rewrite. A legacy row becomes a policy version 1 row when the edge re-projects it, which happens only when an observation for that zone and date arrives after the upgrade (see `zone-day-projection.md`). Until then the rolling 7-day window can mix legacy and version 1 days; each day is read by its own rule.

## Worked examples

Each example is one zone and one farm day. Device EUIs are synthetic.

### A certified dry day without provider rain

Zone row: `rain_policy_version = 1`, `rain_coverage = 'complete'`, `rainfall_mm = 0`, `rain_source = 'sensecap_s2120'`, `rain_selected_deveui = 'A840410000000001'`. The provider fetch failed.

Step 1 answers: `amountMm = 0`, `coverage = 'complete'`, `source = 'local_gauge'`, `deveui = 'A840410000000001'`, no `rain_unknown`. The dendrometer recommendation records the day as observed, without a warning, and counts it present in the rolling 7-day window. With a provider value of 6 mm on the same day the result is the same, and suppression does not start.

The same row without `rain_policy_version` is a legacy row. Edge dendrometer analytics then treats the 0 as no evidence, finds no provider value, and answers `rain_unknown`, as its 0.8.1 release did.

### A flow-only LSN50 day is not a dry day

An LSN50 in MOD 9 reports a flow delta but no valid rain delta. At policy version 1 its instrument day has no accepted rain interval for that part of the day, so the zone day is `partial` or `unknown` with `rainfall_mm = null`. Step 1 does not answer. Step 2 yields `lowerBoundMm` only if the gauge received rain earlier that day. Without a provider value step 4 answers `rain_unknown`.

Rows written before release 0.8.1 can carry `rain_source = 'local_gauge'` and `rainfall_mm = 0` for such a flow-only uplink. As legacy rows they never prove a dry day in dendrometer analytics: a legacy 0 is no evidence there.

### A partial day with a provider value

Zone row: `rain_coverage = 'partial'`, reasons `['frame_gap']`, `rain_received_mm = 7`. Provider (Open-Meteo, whole farm day): 2 mm.

Result: `amountMm = 2`, `lowerBoundMm = 7`, `coverage = 'complete'`, `source = 'open_meteo'`, `deveui = 'A840410000000001'`, reasons `['frame_gap', 'local_partial']`. Suppression starts on 7 mm, and the recommendation's reasoning cites the local lower bound. The rolling sum and the water balance use 2 mm.

### Two gauges, no selection

Zone row: `rain_coverage = 'unknown'`, reasons `['gauge_ambiguous']`, `rain_selected_deveui = null`. Provider: MeteoSwiss station, 3 mm over a UTC day.

Result: `amountMm = 3`, `lowerBoundMm = null`, `source = 'meteoswiss_station'`, `deveui = null`, reasons `['gauge_ambiguous', 'utc_day_period']`. The two gauges are never added and never chosen by arrival order.

## Cloud mirror obligation

The cloud receives the zone day through the projection contract and applies this policy to the mirrored row:

- The same four steps in the same order, with the same result fields (`amountMm`, `lowerBoundMm`, `coverage`, `source`, `deveui`, `reasons`, `policyVersion`) stored or exposed with each piece of advice.
- Step 1 reads the mirrored `rainfall_mm` only when `rain_coverage` is `complete` (and `rain_received_mm` for a `complete_so_far` current day); step 2 reads the mirrored `rain_received_mm`.
- The cloud's own provider tiers (MeteoSwiss station rain, archive or forecast) fill step 3, with `utc_day_period` on every UTC-day value.
- The rules in "What a rule may conclude", including D2 warn mode and the never-add rule, apply unchanged.
- Legacy rows follow the legacy rule above.

A change to the order, to a step, or to a conclusion increments `RAIN_POLICY_VERSION` on both sides together, and the edge and cloud implementations change in paired releases, the cloud first. Shared cases that pin both sides belong in `docs/contracts/dendro/` and `docs/contracts/zone-env/`.
