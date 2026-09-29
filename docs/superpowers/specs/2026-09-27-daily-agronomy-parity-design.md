# Daily agronomy parity: Kc curve, hourly ET0, daily record sync

**Status:** Proposed for implementation (sub-project 4 of 4 of the provider-weather package), revised after the spec committee (2026-09-27). One branch name on both repos: `feat/daily-agronomy-parity` in osi-server and in osi-os, so each PR's CI pairs with its twin (D). The edge branch is stacked on `feat/weather-data-view` (sub-project 3), which is stacked on `feat/daily-agronomy` (sub-project 2). The cloud branch holds one commit on origin/main `cce3e8b6` today; the intended state is that it sits on the osi-server branch `feat/weather-data-view` once that branch carries sub-project 3's manifest and schema copies (D). Neither branch has been pushed. The work runs as seven plans, E1, CA, CB, CC, E2, E3 and E4 (section E).

**Decision:** Both sides compute one agronomy record per zone and completed local day, and the cloud shows the edge's row for a day when the edge has one. The crop coefficient follows the FAO-56 curve: a zone carries the date its current growth stage started, the catalogue carries one Table 11 stage length per stage and crop, and equation 66 places each day inside the development or late-season ramp, counting the start date as day 1; without a start date the stage keeps its table value. The edge's station tier becomes a sum of hourly FAO-56 Penman-Monteith values (equation 53), and both runtimes carry the same hourly function, proven against FAO-56 Example 19. The edge replicates `zone_daily_agronomy` to the cloud through one new outbox operation and the bootstrap snapshot; rows are never physically deleted, only retracted by an update. The cloud drops its own crop table and stage heuristic for the shared catalogue, writes its own daily rows from Open-Meteo's daily ET0 for every zone, and ports the edge's Water tab. After this sub-project the edge owns `weather_source` and `stage_started_on`; the cloud sends its edits of either field only to a gateway that advertised the matching capability. The cloud deploys before the edge.

## Intent

Phil wants the cloud to show the same daily crop demand the gateway computes, and wants that demand to follow the FAO-56 curve instead of a stage's flat table value. Today the cloud ignores the crop for every gateway zone (`ZoneEnvironmentService.java:1196-1211`), knows no daily ET0 at all, and draws today's demand on all seven days of its Water tab (`waterChart.ts:15-21`).

Success means:

- a gateway zone's completed days show on the cloud with the edge's `et0_mm`, Kc and demand, and the tooltip says the gateway calculated them;
- a zone without a gateway, or a day the edge has no value for, shows the cloud's own row from Open-Meteo, and the tooltip says the ET0 is model data and OSI Cloud applied the crop coefficient;
- a zone whose stage has a start date gets a Kc that moves along the FAO-56 ramp day by day, identical to two decimals on edge, cloud and both GUIs for all 1,335 contract vectors, and reproduces FAO Example 28's ramp values (0.77, 0.56);
- a stage left past its Table 11 length is flagged in the daily row, and the tooltip says the stage may be stale;
- the edge's station tier reproduces FAO-56 Example 19 hour by hour within 0.005 mm/h, and the Java port does the same;
- the cloud accepts the five FAO-56 stage keys, `dormancy` included, and every crop in the catalogue, from the edge and from its own settings form;
- no deployed edge sends an operation the cloud it talks to cannot apply.

## Decisions

| Topic | Decision | Source | Cost if wrong |
|---|---|---|---|
| Daily record authority | Both sides compute. The cloud reads the edge row for a date when it has a value, else its own. | Phil, 2026-09-26 | Two computations per gateway zone-day; the cloud's Open-Meteo calls cover zones the edge already serves. |
| ET0 method | Hourly FAO-56 Penman-Monteith (eq. 53) on both sides: the edge station tier sums it; the cloud carries the same function with the same vectors. | Phil, 2026-09-26 | On the synthetic clear summer day the hourly sum is 4.85 mm against 4.73 (daily equation, mean RH, as the edge computes it) and 4.98 (daily equation with RHmax and RHmin, eq. 17). The gap comes mostly from the daily vapour-pressure method, not from the hourly step; FAO-56 calls the forms "generally equivalent". |
| Hourly sum | Signed hourly values are summed; the day is clamped at 0 once. | Controller ruling R3 | None measurable: a per-hour clamp would add 0.1-0.18 mm (2-4 %) on a clear humid summer night. |
| Complete station hour | Mean temperature, RH, wind and radiation present, radiation ≥ 0, and `sample_count ≥ 3`. No minimum or maximum temperature required. | Controller ruling R8 | A station that reports fewer than three samples an hour never reaches the hourly tier and falls to the provider tier. |
| Kc | Strict FAO-56 curve now: stage start date on the zone, Table 11 lengths in the catalogue (one default row per crop), eq. 66 daily interpolation. | Phil, 2026-09-26 | Table 11 lengths are regional examples; a zone whose season differs gets the ramp at the wrong pace until the lengths are made editable. |
| Day position | `d` = whole days from the start date; FAO's day in the stage is `d + 1` (1 on the start date); `p = clamp((d + 1) / L, 0, 1)`. | Controller ruling R1 (FAO eq. 66 exactly) | None known: FAO Example 28 reproduces (day 40 = 0.77, day 95 = 0.56); the rejected `d / L` gave 0.73 and 0.60. |
| Stage day | `kc_stage_day` is FAO's 1-based day in the stage for all four FAO stages whenever a start date and that stage's length exist; `stage_overrun` records `kc_stage_day > L`. | Controller ruling R2 | A zone left in `initial` or `late_season` past its length is flagged, not corrected; the user still moves the stage. |
| No start date | The ramp stages keep the table value they end on (development `kc_mid`) or reach (late season `kc_end`). | Phil, 2026-09-26 | As before sub-project 4. |
| Stage advance | None. The stage is what the user set; the curve only places the day inside that stage. | Controller ruling | A user who forgets to move the stage keeps the end-of-stage Kc (clamped at p = 1); `stage_overrun` and the tooltip say so. FAO's automatic progression can be added later with the same lengths. |
| Start date on a stage change | Both GUIs pre-fill "Stage started on" with today's date when the user picks another stage (editable) and empty it when the stage is set to "Not set". | Controller ruling R5 | A user who changes the stage days late must correct the date by hand. |
| Sending the stage start date | Both forms send `stageStartedOn` whenever they send `phenologicalStage`, not only when the date field itself changed from the stored value: the cloud form sends `''` for an empty date, the edge form sends `null`; both mean no date. The cloud form sends the date at all only to a gateway that advertised the matching capability. | Review finding I1 / controller ruling F1 | Before this fix, a stage change with the pre-filled date emptied kept `stageStartedOn` unsent (the emptied value equalled the stored empty value), so the server's own stage-date default silently replaced "leave empty" with today; a second save was needed to get the empty date. |
| Clearing the date | A server clears `stage_started_on` only when a request changes the stage to unset compared with the stored stage, never on an unrelated save. | Controller ruling (cloud/sync I7) | A cloud save carrying a stale unset stage, sent before the edge's own stage change reached the cloud, clears the edge's stage and its new date. That last-writer race already exists for the stage. |
| Start date on a server-side stage change | When a request changes `phenological_stage` to a different set stage and carries no `stage_started_on`, the server sets the date to the change date (the zone-local today). A stage that becomes unset clears the date, an unchanged stage keeps it, and a supplied date always wins. Both servers apply it on every write path that takes a stage: the edge's `zone-config-fn`, the protected `UPSERT_ZONE`, "Build UPDATE SQL" (legacy `UPSERT_ZONE_CONFIG` and the flat `UPSERT_ZONE`) and the Terra `UPSERT_ZONE_CONFIG` path, and the cloud's `PUT config`. On the cloud's by-UUID route this default fires only for a cloud-only zone or a gateway that advertised `zone_config_stage_started_on_v1`; an incapable gateway's date stays as stored (review finding I3 / controller ruling F3). | Controller ruling (plan review E2 I2; narrowed by F3) | A stage set retroactively shows today's date until the user edits it; the field is visible and editable on both GUIs. Before F3, an incapable gateway's pending response also showed today's date, even though the command already stripped the field and the gateway never saw it. |
| Stage stored on write | `EdgeSyncService.upsertZone` stores the edge's `phenological_stage` text exactly as sent (bounded to 30 characters); it no longer rewrites a legacy key to its FAO equivalent on write. Every reader resolves the FAO stage itself through `CropKcCatalogue.normalizeStage`. | Review finding I2 / controller ruling F2 | Before this fix, a gateway that still held a legacy key (e.g. `veraison`) had it silently rewritten to `mid_season` on the cloud row by the next unrelated command (a rename, a notes edit), and that rewritten text was then sent back in a later command to a gateway whose own edge form has no option for it. |
| Crops without a Table 11 row | The 16 crops for which the reference names a closer row take it as their default (`verified: false`); `conifer` and `sisal` take all-null lengths (curve off); the other 21 keep their group default. | Controller rulings (b) and R4 | Every borrowed row is agronomic judgement; the README lists them for a signing agronomist. |
| Default-row swaps | `cantaloupe` takes Sweet melons, Mediterranean, May; `sugar_beet` takes its Idaho, April row; `almond` takes Deciduous Orchard, Calif. | Controller ruling R9 | Three ramps run at a different pace from the policy's pick. |
| Regional defaults | The default rows are European and Mediterranean; low-latitude rows for Uganda are a follow-up. README note only, no code. | Controller ruling R6 | Ugandan maize ramps on the Spanish season: at development day 21 Kc is 0.77 where the Nigeria row gives 0.84 and the East Africa row 0.68. |
| Heuristic crops | `other`, unknown or null crops keep the stage heuristic; no curve. | Controller ruling | None beyond today. |
| Dormancy | 0.25 for every catalogue crop on both sides; the cloud's `STAGE_KC_INDEX` sent it to `kc_end`. Dormancy stays offered for evergreens; the stage tooltip says what it is for. | Phil, 2026-09-26 (sub-project 2), aligned here; controller ruling | A dormant vineyard's cloud demand drops from `kc_end` × ET0 to 0.25 × ET0. |
| Frozen rows | A row keeps the crop, stage, start date and Kc current when it was first computed with a value, including backfilled rows. | Controller ruling R10 | A start date entered late does not reach the stored past days; the stage tooltip says changes apply to days calculated after them. |
| Station tier naming | `et0_tier` stays `station_fao56`; `et0_source` becomes `fao56_hourly`. | Controller ruling | Rows written before the change keep `station_fao56` as source; readers must not treat the source as the tier. |
| Record sync path | One outbox op `ZONE_AGRONOMY_UPSERTED` plus the bootstrap snapshot (last 30 days per zone, at most 1,000 rows per gateway); no history-batch table; no delete op. | Controller rulings (chair I5, cloud/sync B1) | A gateway whose rows the cloud missed for more than 30 days keeps the cloud's own rows for the older days. |
| Row versions | Rows are never physically deleted. `sync_version` starts at 1 on insert and grows by 1 on every change; a clock-ahead row is retracted by an update. | Controller ruling (cloud/sync B1) | A row removed by the `ON DELETE CASCADE` of a zone later re-created with the same UUID would be stale on the cloud; zone UUIDs are never reused. |
| Cloud daily source | Open-Meteo forecast endpoint with `past_days=7`, daily `et0_fao_evapotranspiration`; values inside the seven-day window are refreshed when Open-Meteo revises them. | Controller rulings (chair I3, R7) | The model's ET0 can differ from a station by 10-20 % on a single day; the tooltip says so. |
| Cloud MeteoSwiss zones | Use Open-Meteo this round. The cloud has no observed MeteoSwiss store. | Controller ruling | Cloud-only Swiss zones show Open-Meteo-based history until the ogd-smn hourly port lands; the tooltip names it. |
| WaterDay shape | The cloud emits sub-project 2's `demandMm` and `demandSource` (`calculated`, `forecast`, null) and the edge's other day fields, and adds `demandComputedBy` (`edge`, `cloud`, null) and `stageOverrun`. | Controller ruling (chair I2) | None on the edge: in shared mode the edge's union types stay valid for every row the cloud sends. |
| Stage vocabulary on the cloud | Controllers, dendro and shadow hydrology read the stored stage through `CropKcCatalogue.normalizeStage` (the edge's rule). The prediction engine keeps its own projection at its boundary: `dormancy` → `late_season`, unset → `mid_season`. A stage the user sets through a cloud form is always one of the five FAO keys; `upsertZone` no longer normalises the edge's own text on write (amended by F2, below), so the stored value can be the edge's legacy key for as long as that gateway holds one. | Controller ruling (cloud/sync I1); write-side amended by review finding I2 / controller ruling F2 | A zone whose stored stage was null now reaches the engine as `mid_season` instead of a planting-date stage. |
| Cloud crop list | Any catalogue id or `other`; the seven-crop prediction catalogue only gates the prediction advisor. | Controller ruling | A zone may carry a crop the advisor cannot predict; the advisor's tooltip says which crops it supports. |
| Rollout | Cloud before edge, on main and on every customer instance. | AGENTS.md "Deploy order and sync compatibility" | An edge ahead of its cloud gets terminal `unknown_op` rejections for every daily row (D). |
| `weather_source` ownership | The edge owns it after this sub-project. The cloud applies it from edge events and bootstrap, sends a cloud edit in `UPSERT_ZONE` / `UPSERT_ZONE_CONFIG` only to a gateway that advertised `zone_config_weather_source_v1`, and writes it straight to its own row only for a gateway without that capability. | Controller rulings (sub-project 3 data/sync B1, sub-project 4 cloud/sync B3); the incapable-gateway branch is a spec decision | A provider chosen on the cloud before the gateway's upgrade is replaced by the edge value at the first bootstrap that carries it and must be re-selected once (D). |
| Cloud-to-edge zone fields | The cloud sends `weatherSource` and `stageStartedOn` in `UPSERT_ZONE` and `UPSERT_ZONE_CONFIG` only to a gateway that advertised the matching capability, and always to such a gateway; every other command type carries neither. | Controller ruling (cloud/sync I4) | A gateway whose capability report has not reached the cloud yet cannot take a start date from the cloud; the form disables the input for such a zone (C9). |

## A. Contract v2

The edge's `docs/contracts/agronomy/` stays the only source. Its `crop-kc.json` moves to `"version": 2`; every copy (edge helper, edge GUI, cloud backend, cloud frontend) is a byte copy, checked on both sides.

### A1. `crop-kc.json` v2 shape

Every one of the 136 crops keeps its v1 fields and gains two: `stage_lengths_days` (the default Table 11 row the code uses, with its provenance inline) and `stage_length_alternatives` (every other Table 11 row for that crop, kept for the reviewer and for a later length picker; no code reads it). Maize, with its v1 fields as the file holds them:

```json
{
  "id": "maize",
  "group": "cereals",
  "label": "Maize (grain)",
  "kc_ini": 0.3,
  "kc_mid": 1.2,
  "kc_end": 0.35,
  "variant_of": null,
  "fao_row": "Maize, Field (grain) (field corn)",
  "stage_lengths_days": {
    "initial": 30,
    "development": 40,
    "mid_season": 50,
    "late_season": 30,
    "table11_row": "Maize (grain)",
    "plant_date": "April",
    "region": "Spain (spr, sum.); Calif.",
    "selection_rule": "European row ('Spain (spr, sum.); Calif.')",
    "verified": true
  },
  "stage_length_alternatives": [
    { "initial": 30, "development": 50, "mid_season": 60, "late_season": 40, "table11_row": "Maize (grain)", "plant_date": "April", "region": "East Africa (alt.)", "selection_rule": "alternative", "verified": true },
    { "initial": 25, "development": 40, "mid_season": 45, "late_season": 30, "table11_row": "Maize (grain)", "plant_date": "Dec/Jan", "region": "Arid Climate", "selection_rule": "alternative", "verified": true },
    { "initial": 20, "development": 35, "mid_season": 40, "late_season": 30, "table11_row": "Maize (grain)", "plant_date": "June", "region": "Nigeria (humid)", "selection_rule": "alternative", "verified": true },
    { "initial": 20, "development": 35, "mid_season": 40, "late_season": 30, "table11_row": "Maize (grain)", "plant_date": "October", "region": "India (dry, cool)", "selection_rule": "alternative", "verified": true },
    { "initial": 30, "development": 40, "mid_season": 50, "late_season": 50, "table11_row": "Maize (grain)", "plant_date": "April", "region": "Idaho, USA", "selection_rule": "alternative", "verified": true }
  ]
}
```

Field rules:

- The four lengths are positive integers or `null`. A `null` length switches the curve off for that stage only (A5). The provenance fields sit in the same object as the lengths (spec decision), so a reader that takes the object takes its source with it.
- `table11_row`, `plant_date` and `region` are the Table 11 cells as the FAO page prints them, footnote markers removed; `plant_date` is `""` where the row has none. For an all-null object (`conifer`, `sisal` and the ten tropical evergreens) the three cells are `""`.
- `selection_rule` is the reference's sentence saying why this row was chosen, verbatim (spec decision; the 95 prose rules do not reduce to a short enum without losing the reason). A group default reads `"group default (<group id>): no Table 11 row for this crop"`; a promoted proposal reads `"reference proposal (UNVERIFIED): <basis>"`; a row chosen in the agronomy review reads `"agronomy review 2026-09-27: <reason>"`.
- `verified` is `true` when the numbers are this crop's own Table 11 row (or the class row the reference assigns it) read from the fetched page, `false` for a row borrowed from another crop.
- `stage_length_alternatives` is an array of the same object shape, possibly empty. A crop whose default changed keeps the row it lost here.

The default row per crop follows the reference's selection policy: the first European row (Europe, Italy, Spain), else the first Mediterranean spring row (March to June), else the first temperate row (Continental, High or Mid Latitudes, 35-45 °L, Central USA, Idaho, Utah), else the first row. A catalogue variant takes the row whose label names it (winter wheat, frozen soils: the Idaho dormancy row; faba bean, dry: the "- dry" row; grapevine: the "(wine)" row). Class rows (Crucifers, Deciduous Orchard) apply where the crop has no own row or no European, Mediterranean or temperate one (broccoli, cabbage, cauliflower; apple, pear, cherry and the stone fruits). Three defaults then change after the agronomy review (ruling R9):

| Crop | Policy pick | Default now | Lengths | `verified` |
|---|---|---|---|---|
| `cantaloupe` | Cantaloupe, Calif., USA, Jan (a desert winter planting) | Sweet melons, Mediterranean, May | 25/35/40/20 | `false` (another crop's row) |
| `sugar_beet` | Sugarbeet, Mediterranean, May | Sugarbeet, Idaho, USA, April (closer to Swiss sowing and lifting) | 50/40/50/40 | `true` |
| `almond` | Deciduous Orchard, High Latitudes, March | Deciduous Orchard, Calif., USA, March (where almonds grow) | 30/50/130/30 | `true` |

Counts over the 136 crops: 95 have an own Table 11 row with four numbers (94 use it; `cantaloupe` now uses the Sweet melons row), 4 have an own row that prints no mid-season or late-season length (A4), 37 have no Table 11 row (A3).

The parsed Table 11 rows and the parse script move from the SDD scratch directory into `docs/contracts/agronomy/sources/` (`table11-stage-lengths.json`, `build_table11.py`, `parse_table11.py`, `hourly_et0.py`), so the transcription can be re-run from the tree (spec decision; sub-project 2's README had to admit its Table 12 check could not be reproduced). The raw HTML is not committed. `build_table11.py` applies the A3 promotions and the three swaps above, so the committed `crop-kc.json` is its output.

### A2. README changes

`docs/contracts/agronomy/README.md` gains:

- the v2 fields and the selection policy above, with the counts and the three agronomy-review swaps;
- the curve rule (A5) with equation 66 and FAO's day count: "`kc_stage_day` is FAO's day number within the stage, 1 on the start date, 0 or less before it; `stage_overrun` is true when it exceeds the stage's Table 11 length";
- the hourly ET0 chain (A7), the night rule, and three notes: clipping ω1 and ω2 to [−ωs, ωs] is ASCE-EWRI 2005 practice rather than FAO-56 text (on the synthetic day it moves the sum by 1.2·10⁻⁴ mm); the first and last daylight hours use a measured Rs/Rso that low sun angles make unreliable, bounded by the [0.3, 1.0] clamp; the night default 0.5 fits Switzerland and most of Uganda, while semi-arid north-eastern Uganda (Karamoja) sits in FAO's 0.7-0.8 class;
- the comparison of the hourly sum with the daily equation from the Decisions table, attributed to the vapour-pressure method;
- the statement that `et0_tier = 'station_fao56'` is an hourly sum since contract v2, with `et0_source = 'fao56_hourly'`;
- the regional note (ruling R6): the default rows are European and Mediterranean; Table 11 prints low-latitude or tropical rows for maize, sweet maize, barley, oats, wheat, sweet potato, soybean, groundnut, castor bean, grapes and the deciduous-orchard class, and a low-latitude default for Uganda is a follow-up; on frost-free sites `turf_warm` grows year round and reed swamp fits the Florida row (180/60/90/35);
- the table of crops without a Table 11 row (A3), the four rows without numbers (A4) and the three swaps, all marked for a signing agronomist; the caveats the agronomy review attached (winter rapeseed overwinters: set Initial at spring regrowth; forages restart Initial after each cut; an orchard with grassed alleys uses Kc 0.50-0.80 after leaf fall, FAO-56 Table 12 footnote 18, where dormancy's 0.25 assumes bare soil);
- the cloud copies in the copy list (replacing "later, a copy in osi-server"), and the rule that `verify-agronomy-contract.js` compares them when given an osi-server checkout.

### A3. Crops without a Table 11 row

The 37 crops below have no Table 11 row. Controller ruling (b), confirmed per crop by the agronomy review (ruling R4): where the reference proposes a closer row, that row is the default, with `verified: false` and `selection_rule: "reference proposal (UNVERIFIED): <basis>"`, and the group default moves into `stage_length_alternatives`. Where the proposal is "none: year-round" (`conifer`, `sisal`), all four lengths are `null`, which switches the curve off; a null is the no-harm default for an evergreen. `sudan_grass` takes only the first two lengths of its proposal (25/25/–/–): an averaged-cutting row is establishment, a ramp and then a flat averaged Kc, the treatment A4 gives `alfalfa_averaged`. The other 21 keep their group default. Lengths read initial/development/mid-season/late-season; a dash is `null`.

**For the agronomy reviewer.** Every number below is a verbatim Table 11 value; applying it to the crop is judgement, not FAO text. The basis column is the agronomy review's reason, carried into `selection_rule`.

| Crop | Group | Default used | Lengths | Moved to alternatives | Basis |
|---|---|---|---|---|---|
| `garlic` | small_vegetables | Onion (dry), Mediterranean, April | 15/25/70/40 | Crucifers, Mediterranean, April (20/30/20/10) | bulb allium, 150-day season |
| `parsnip` | roots_tubers | Carrots, Mediterranean, Feb/Mar | 30/40/60/20 | Potato, Europe, April (30/35/50/30) | Apiaceae taproot like carrot |
| `turnip` | roots_tubers | Beets, table, Mediterranean, Apr/May | 15/25/20/10 | Potato, Europe, April (30/35/50/30) | fresh root of 60-80 days |
| `chickpea` | legumes | Lentil, Europe, April | 20/30/60/40 | Peas, Europe, May (15/25/35/15) | cool-season grain legume harvested dry |
| `garbanzo` | legumes | Lentil, Europe, April | 20/30/60/40 | Peas, Europe, May (15/25/35/15) | same species as chickpea |
| `sisal` | fibre | none: year-round crop | –/–/–/– | Flax, Europe, April (25/35/50/40) | perennial agave without seasonal stages |
| `rapeseed` | oil_crops | Safflower, High Latitudes, Mar | 25/35/55/30 | Sunflower, Medit.; California, April/May (25/35/45/25) | spring-sown oil crop of the same group |
| `alfalfa_seed` | forages | Alfalfa, total season (frost window) | 10/30/–/– | Grass Pasture (10/20/–/–) | same species |
| `clover_hay` | forages | Alfalfa, total season (frost window) | 10/30/–/– | Grass Pasture (10/20/–/–) | multi-cut legume hay, averaged cuttings |
| `clover_hay_cutting` | forages | Alfalfa, 1st cutting cycle, Idaho, Apr | 10/30/25/10 | Grass Pasture (10/20/–/–) | consistent with the `alfalfa` default |
| `sudan_grass` | forages | Sudan, 1st cutting cycle, Calif. Desert, Apr, first two lengths | 25/25/–/– | Grass Pasture (10/20/–/–) | averaged cuttings, as `alfalfa_averaged` |
| `berries` | grapes_berries | Deciduous Orchard, High Latitudes, March | 20/70/90/30 | Grapes, High Latitudes, May (20/50/90/20) | deciduous shrubs leafing out in March-April |
| `blueberry` | grapes_berries | Deciduous Orchard, High Latitudes, March | 20/70/90/30 | Grapes, High Latitudes, May (20/50/90/20) | as berries |
| `raspberry` | grapes_berries | Deciduous Orchard, High Latitudes, March | 20/70/90/30 | Grapes, High Latitudes, May (20/50/90/20) | as berries |
| `avocado` | fruit_trees | Citrus, Mediterranean, Jan | 60/90/120/95 | Deciduous Orchard, High Latitudes, March (20/70/90/30) | evergreen subtropical tree, no concerted leaf drop |
| `conifer` | fruit_trees | none: year-round crop | –/–/–/– | Deciduous Orchard, High Latitudes, March (20/70/90/30) | evergreen with Kc 1.00 in every stage |
| `mint`, `strawberry` | perennial_vegetables | Grass Pasture (frost window) | 10/20/–/– | none | group default |
| `ryegrass_hay`, `turf_cool`, `turf_warm` | forages | Grass Pasture (frost window) | 10/20/–/– | none | group default |
| `cocoa`, `coffee`, `coffee_with_weeds`, `date_palm`, `mango`, `palm`, `papaya`, `rubber`, `tea`, `tea_shaded` | tropical_fruits | none: year-round crop | –/–/–/– | none | group default |
| `fig`, `hazelnut`, `kiwi`, `pomegranate` | fruit_trees | Deciduous Orchard, High Latitudes, March | 20/70/90/30 | none | group default |
| `reed_swamp_moist_soil`, `reed_swamp_standing_water` | wetlands | Wetlands (Cattails, Bulrush), Utah, killing frost, May | 10/30/80/20 | none | group default |

"Frost window" is the Grass Pasture row's season, 7 days before the last −4 °C in spring until 7 days after the first −4 °C in fall (Table 11 footnote 4). The reference gives the perennial-vegetable and forage group defaults no numbers at all; this spec takes the two lengths the Grass Pasture row prints (initial 10, development 20) and leaves mid-season and late season `null` (spec decision). The tropical group has no default row: FAO-56 describes these evergreens as growing year round with near-equal Kc values, so their curve never applies and every stage keeps its table value.

### A4. Rows without numbers

Four crops have an own Table 11 row that prints no mid-season or late-season length: `alfalfa_averaged` ("Alfalfa, total season": 10, 30, "var.", "var.") and `grass`, `pasture_extensive`, `pasture_rotated` ("Grass Pasture": 10, 20, "--", "--"). They get `stage_lengths_days` with the two printed numbers, `mid_season: null`, `late_season: null`, `verified: true` and the selection rule `"only row; Table 11 gives no numeric mid/late lengths"`. The development ramp follows the curve; the late season keeps `kc_end`. For these four `kc_end` is within 0.05 of `kc_mid`, so the missing late ramp costs nothing material (agronomy review).

### A5. Kc rule

Inputs: `cropType`, `phenologicalStage`, `stageStartedOn` (ISO date or null) and `date` (the day the Kc is for, ISO date or null). The stage is normalised first with the edge's rule (trim, lower-case, the five keys, the legacy map of the v1 README; anything else is unset); the crop is matched after trimming and lower-casing.

| Stage | Start date and length present | Otherwise |
|---|---|---|
| `initial` | `kc_ini`, `fao56_crop`, stage day set | `kc_ini`, `fao56_crop` |
| `development` | eq. 66 from `kc_ini` to `kc_mid`, `fao56_curve`, stage day set | `kc_mid`, `fao56_crop` |
| `mid_season` | `kc_mid`, `fao56_crop`, stage day set | `kc_mid`, `fao56_crop` |
| `late_season` | eq. 66 from `kc_mid` to `kc_end`, `fao56_curve`, stage day set | `kc_end`, `fao56_crop` |
| `dormancy` | 0.25, `fao56_crop` | 0.25, `fao56_crop` |
| unset | `kc_mid`, `fao56_crop_stage_unset` | `kc_mid`, `fao56_crop_stage_unset` |

A crop outside the catalogue keeps the heuristic (`initial` 0.45, `development` 0.70, `mid_season` 0.90, `late_season` 0.60, `dormancy` 0.25, unset 0.75, `heuristic_phenology`), start date or not.

FAO-56 equation 66, as printed:

```
Kc i = Kc prev + [ (i − Σ(L prev)) / L stage ] · (Kc next − Kc prev)
```

`i` is the day number within the growing season, counted from 1, `Σ(L prev)` the sum of the lengths of all previous stages, `L stage` the length of the current stage, `Kc prev` the Kc at the end of the previous stage and `Kc next` the Kc at the start of the next (`kc_end` for the late season). A stage that starts on date S has `i − Σ(L prev) = d + 1` on date S + d, so the contract computes:

```
d        = whole calendar days from stageStartedOn to date   (0 on the start date; negative before it)
stageDay = d + 1                                             (FAO's day in the stage: 1 on the start date)
L        = stage_lengths_days[stage]
p        = min(1, max(0, stageDay / L))                      (integer addition, then a double division)
kc       = prev + p * (next - prev)                          (development: prev = kc_ini, next = kc_mid;
                                                              late_season: prev = kc_mid, next = kc_end)
kc       = Math.round(kc * 100) / 100
```

- `d` is computed on calendar dates, never on instants: `Date.UTC` parts in JavaScript, `ChronoUnit.DAYS.between` in Java. Daylight saving never shifts it.
- On the stage's last day (`d = L − 1`) Kc equals `next`, as figure 25 draws it.
- The operation order is part of the contract: `prev + p * (next - prev)` in IEEE doubles, then `Math.round(kc * 100) / 100` (`Math.round` in Java and JavaScript both round half up for positive values). A half case therefore rounds by the binary value of `kc * 100`: maize late season at `d = 14` is 0.775 on paper and 0.77499999999999991 in doubles, so every runtime returns 0.77; tomato late season at `d = 0` is 1.135 on paper and exactly 113.5 after the multiplication, so every runtime returns 1.14 (spec decision; the vectors pin both directions).
- `kcSource` is `fao56_curve` whenever the ramp formula ran, including clamped days (before the start date, p = 0; past the length, p = 1).
- `kcStageDay` is `stageDay`, unclamped (0 or negative before the start date, larger than `L` past it), for each of the four FAO stages when the date, the start date and that stage's length are present; `null` for `dormancy`, unset, heuristic crops and a missing input (ruling R2).
- `stageOverrun` is `kcStageDay > L` when `kcStageDay` is set, else `null`. The daily row stores both as `kc_stage_day` and `stage_overrun`, so the flag keeps the lengths that were current when the row froze.
- A `null` date, a `null` start date, an unparseable one or a `null` length for the stage: the stage's table value, `fao56_crop`, `kcStageDay: null`, `stageOverrun: null`. A date parses only as `YYYY-MM-DD` with a four-digit year from 0100 on and a real calendar day; JavaScript's `Date.UTC` maps the years 0-99 to 1900-1999, so every runtime refuses them (plan review, edge E1).

The resolver returns `{ kc, kcSource, cropId, stage, kcStageDay, stageOverrun }` on every runtime. A separate pure function `kcRamp(prev, next, d, L)` holds the ramp arithmetic, so the FAO Example 28 golden test can run without a catalogue row (its Kc ini 0.15 and Kc mid 1.19 are climate-adjusted values no catalogue crop has): `kcRamp(0.15, 1.19, 14, 25) = 0.77` and `kcRamp(1.19, 0.35, 14, 20) = 0.56`, in every runtime.

### A6. `kc-vectors.json` v2

`scripts/build-kc-vectors.js` regenerates the file as one array. Every record has this shape:

```json
{ "cropType": "maize", "phenologicalStage": "development", "stageStartedOn": "2026-05-01", "date": "2026-05-21",
  "kc": 0.77, "kcSource": "fao56_curve", "cropId": "maize", "stage": "development", "kcStageDay": 21, "stageOverrun": false }
```

Every v1 vector gains `stageStartedOn: null`, `date: null` and the outputs `kcStageDay: null`, `stageOverrun: null`; the 1,252 v1 values do not change. Then 83 dated vectors follow (spec decision on the set), for a total of 1,335.

Five crops, start date `2026-05-01`, seven cases per ramp stage (`d = 0`, `d = ⌊L/2⌋`, `d = L − 1`, `d = L`, `d = L + 10`, `d = −5`, and no start date with `date = 2026-05-21`):

| Crop | Stage | L | d = 0 | ⌊L/2⌋ | L − 1 | L | L + 10 | −5 | no date |
|---|---|---|---|---|---|---|---|---|---|
| `maize` 0.30/1.20/0.35 | development | 40 | 0.32 | 0.77 (d 20) | 1.20 | 1.20 | 1.20 | 0.30 | 1.20 |
| `maize` | late_season | 30 | 1.17 | 0.75 (d 15) | 0.35 | 0.35 | 0.35 | 1.20 | 0.35 |
| `tomato` 0.60/1.15/0.70 | development | 40 | 0.61 | 0.89 (d 20) | 1.15 | 1.15 | 1.15 | 0.60 | 1.15 |
| `tomato` | late_season | 30 | 1.14 | 0.91 (d 15) | 0.70 | 0.70 | 0.70 | 1.15 | 0.70 |
| `potato` 0.50/1.15/0.75 | development | 35 | 0.52 | 0.83 (d 17) | 1.15 | 1.15 | 1.15 | 0.50 | 1.15 |
| `potato` | late_season | 30 | 1.14 | 0.94 (d 15) | 0.75 | 0.75 | 0.75 | 1.15 | 0.75 |
| `grapevine` 0.30/0.70/0.45 | development | 60 | 0.31 | 0.51 (d 30) | 0.70 | 0.70 | 0.70 | 0.30 | 0.70 |
| `grapevine` | late_season | 80 | 0.70 | 0.57 (d 40) | 0.45 | 0.45 | 0.45 | 0.70 | 0.45 |
| `apple` 0.45/0.95/0.70 | development | 70 | 0.46 | 0.71 (d 35) | 0.95 | 0.95 | 0.95 | 0.45 | 0.95 |
| `apple` | late_season | 30 | 0.94 | 0.82 (d 15) | 0.70 | 0.70 | 0.70 | 0.95 | 0.70 |

The dated cases carry `fao56_curve`, `kcStageDay = d + 1` and `stageOverrun` true for the `L` and `L + 10` columns, false otherwise; the no-date cases carry `fao56_crop` and nulls. The dates are `2026-05-01` plus `d` days (for example maize development `d = 50` is `2026-06-20`). The lengths are the A1 defaults (A6's five crops are unaffected by the swaps).

Thirteen more cases pin the edges of the rule:

| Case | Input | kc | kcSource | kcStageDay | stageOverrun |
|---|---|---|---|---|---|
| dormancy, dated (each of the five crops) | start 2026-05-01, date 2026-05-11 | 0.25 | `fao56_crop` | null | null |
| `grass` development (length 20) | start 2026-05-01, date 2026-05-11 | 0.96 | `fao56_curve` | 11 | false |
| `grass` late season (length null) | start 2026-05-01, date 2026-05-11 | 1.00 | `fao56_crop` | null | null |
| `maize` initial, dated | start 2026-05-01, date 2026-05-11 | 0.30 | `fao56_crop` | 11 | false |
| `maize` initial, past its length (30) | start 2026-05-01, date 2026-06-05 | 0.30 | `fao56_crop` | 36 | true |
| `maize` mid-season, dated | start 2026-05-01, date 2026-05-11 | 1.20 | `fao56_crop` | 11 | false |
| `maize` late season, half case | start 2026-05-01, date 2026-05-15 | 0.77 | `fao56_curve` | 15 | false |
| `maize` stage unset, dated | start 2026-05-01, date 2026-05-11 | 1.20 | `fao56_crop_stage_unset` | null | null |
| `other` development, dated | start 2026-05-01, date 2026-05-11 | 0.70 | `heuristic_phenology` | null | null |

The `grass` development value is 0.9550000000000001 before rounding. Every runtime reproduces every vector exactly (`kc` equal as a double after rounding, the three strings, `kcStageDay` and `stageOverrun` equal).

### A7. Hourly ET0: `fao56Et0Hourly`

`osi-agronomy-daily/et0.js` gains three exports; the Java `WeatherMath` gains their ports (C8).

```js
fao56HourlyTerms(input) → terms | null
fao56Et0Hourly(input) → number | null           // mm for the hour, signed, not rounded
fao56Et0HourlyDay({ hours, windHeightM, elevationM, latDeg, lonDeg, dayOfYear, priorRsRso })
  → { et0Mm, sumMm, lastRsRso, hourly } | null
```

`input` for the first two is `{ tMeanC, rhPct, windSpeedMs, windHeightM, solarRadMjM2h, elevationM, latDeg, lonDeg, dayOfYear, hourStartUtc, nightRsRso }`. `solarRadMjM2h` is the measured global radiation Rs for the hour (a station's mean W/m² × 0.0036). `hourStartUtc` is an ISO instant or epoch milliseconds. `lonDeg` is degrees east, positive. `elevationM` may be null (treated as 0). `nightRsRso` is optional (spec decision: Example 19 assumes 0.8 at night and could not be reproduced without it).

`hours` for the day function is an array of `{ hourStartUtc, tMeanC, rhPct, windSpeedMs, solarRadMjM2h }` in time order, one per hour of the local day (23, 24 or 25). No element and no field may be null; a null element, a null field or a failed hour makes the whole day null, so the caller decides completeness before calling.

`terms` holds, by these names: `u2`, `pressureKpa`, `gamma`, `es`, `delta`, `ea`, `declination`, `dr`, `omegaS`, `omega`, `omega1`, `omega2`, `ra`, `rso`, `rns`, `rsRso`, `rnl`, `rn`, `g`, `radTerm`, `aeroTerm`, `et0Mm` (signed), and three flags: `sunUp` (boolean), `rsRsoSource` (`measured`, `carried`, `prior` or `default`) and `carryCandidate` (true for a day hour whose ω lies in the night-rule window below).

The day function returns `sumMm` (the signed sum of the hourly values, unrounded), `et0Mm = Math.round(Math.max(0, sumMm) * 100) / 100` (ruling R3: the day is clamped, not the hour), `lastRsRso` (the carried ratio after the last hour) and `hourly`, one `{ hourStartUtc, et0Mm, sunUp, rsRsoSource }` per hour, for the vector file and for debugging.

The chain, symbol by symbol:

| Step | Formula | FAO-56 eq. |
|---|---|---|
| Wind at 2 m | `u2 = uz · 4.87 / ln(67.8 z − 5.42)`; `u2 = uz` at z = 2; null when z is missing, ≤ 0 or `67.8 z − 5.42 ≤ 1` (the existing `windAt2m`) | 47 |
| Pressure | `P = 101.3 · ((293 − 0.0065 z_elev) / 293)^5.26`, `z_elev = 0` when elevation is null | 7 |
| Psychrometric constant | `γ = 0.000665 · P` | 8 |
| Saturation vapour pressure | `e°(T) = 0.6108 · exp(17.27 T / (T + 237.3))` at `T = tMeanC` | 11 |
| Slope | `Δ = 4098 · e°(T) / (T + 237.3)²` | 13 |
| Actual vapour pressure | `ea = e°(T) · rhPct / 100` | 54 |
| Declination, distance, sunset angle | `δ = 0.409 sin(2πJ/365 − 1.39)`, `dr = 1 + 0.033 cos(2πJ/365)`, `ωs = arccos(−tan φ tan δ)` | 23-25 |
| Solar time angle at mid-hour | `b = 2π(J − 81)/364`, `Sc = 0.1645 sin 2b − 0.1255 cos b − 0.025 sin b`, `ω = π/12 · ((t_utc,mid + lonDeg/15 + Sc) − 12)` wrapped into (−π, π] | 31-33 |
| Extraterrestrial radiation | `Ra = (12·60/π) Gsc dr [(ω2 − ω1) sin φ sin δ + cos φ cos δ (sin ω2 − sin ω1)]`, `ω1,2 = ω ∓ π/24` clipped to [−ωs, ωs] (the existing `hourlyExtraterrestrialRadiation`; the clipping is ASCE-EWRI 2005 practice, recorded in the README) | 28-30 |
| Day or night | `sunUp = −ωs ≤ ω ≤ ωs` at mid-hour | FAO text on eq. 31 |
| Clear-sky radiation | `Rso = max(1e-4, (0.75 + 2·10⁻⁵ z_elev) · Ra)` | 37 |
| Net shortwave | `Rns = 0.77 · Rs` | 38 |
| Cloudiness ratio | day: `Rs/Rso` clamped to [0.3, 1.0]; night: the carried ratio (below) | 39 |
| Net longwave, hourly | `Rnl = σh · (T + 273.16)⁴ · (0.34 − 0.14 √ea) · (1.35 Rs/Rso − 0.35)`, `σh = 4.903e-9 / 24` written as that expression in every runtime | 39, hourly form |
| Net radiation | `Rn = Rns − Rnl` | 40 |
| Soil heat flux | `G = 0.1 Rn` when `sunUp`, else `G = 0.5 Rn` | 45, 46 |
| Reference ET | `radTerm = 0.408 Δ (Rn − G) / D`, `aeroTerm = γ · 37/(T + 273) · u2 · (e°(T) − ea) / D`, `D = Δ + γ (1 + 0.34 u2)`, `ET0 = radTerm + aeroTerm` | 53 |

`Gsc = 0.0820` MJ m⁻² min⁻¹, `φ = latDeg · π/180`, `J = dayOfYear`, `t_utc,mid` the hour's UTC midpoint in hours. The solar-time line is eq. 31 with `Lz = 0` (UTC) and `Lm = −lonDeg`; it equals the FAO form for every site because `0.06667 · (Lz − Lm)` is `lonDeg / 15`. The lower clamp at 0.3 for a day hour comes from the daily path (spec decision; FAO-56 writes that 0.3 "presumes total cloud cover" and bounds the ratio above at 1.0). An hour that straddles sunrise or sunset has `sunUp` false at its midpoint while its clipped Ra is above 0; it takes the night ratio and `G = 0.5 Rn`, as the Python reference does, and the synthetic day pins such an hour (A9).

Returns null when any of `tMeanC`, `rhPct`, `windSpeedMs`, `solarRadMjM2h`, `latDeg`, `lonDeg` is not finite, `rhPct` is outside [0, 100], wind or radiation is negative, `u2` is null, `dayOfYear` is outside 1-366, `hourStartUtc` is neither epoch milliseconds nor an ISO instant with `Z` or an offset (a time string without a zone is refused, as Java's `Instant.parse` refuses it), `nightRsRso` is given but outside [0.3, 1.0], or `D` is not positive. The day function returns null for a `priorRsRso` given outside [0.3, 1.0] (plan review, edge E1: a carried ratio is a clamped day ratio, so any other value is an input error). A non-null result is the signed ET0: FAO-56 chapter 11 reads a negative value as possible net condensation, and chapter 4 relies on hourly differences compensating each other within the day.

**Night rule.** FAO-56 chapter 4: at night "the ratio Rs/Rso can be set equal to the Rs/Rso calculated for a time period occurring 2-3 hours before sunset", identified as the hour whose ω lies in `[ωs − 0.79, ωs − 0.52]`; "as a more approximate alternative, one can assume Rs/Rso = 0.4 to 0.6 during nighttime periods in humid and subhumid climates". The contract implements both (spec decision):

- `fao56Et0HourlyDay` walks the hours in time order. A day hour whose ω lies in the window (`carryCandidate`) sets the carried ratio to its own clamped `Rs/Rso`; a night hour uses the carried ratio.
- Before any such hour on the day, the carried ratio is `priorRsRso` (`rsRsoSource: 'prior'`) when the caller passes one (B4 says where the edge finds it).
- Without either, the ratio is 0.5 (`default`), the middle of FAO's humid and subhumid range.
- `fao56Et0Hourly` called alone uses `nightRsRso` when given, else 0.5.

`dayOfYear` is the zone-local date's day of year for every hour of that day (spec decision; the one-day difference near midnight only touches night hours, whose Ra is 0).

The daily `fao56Et0` stays unchanged on the edge and remains the function the cloud's forecast tiers use.

### A8. Example 19: the golden vector

FAO-56 Example 19, fetched from the FAO page: N'Diaye, Senegal, 16°13'N 16°15'W, 8 m, 1 October (J = 274), hours 02:00-03:00 and 14:00-15:00 local standard time with `Lz = 15° W`. In contract terms: `latDeg = 16.21667`, `lonDeg = −16.25`, `elevationM = 8`, `windHeightM = 2`, `hourStartUtc` `2026-10-01T03:00:00Z` and `2026-10-01T15:00:00Z` (2026-10-01 is day 274).

| Quantity | 02-03 h published | 14-15 h published | Contract recomputed (02-03 / 14-15) |
|---|---|---|---|
| Inputs T, RH, u2, Rs | 28 °C, 90 %, 1.9 m/s, 0 | 38 °C, 52 %, 3.3 m/s, 2.450 MJ/m² | |
| Δ | 0.220 | 0.358 | 0.22008 / 0.35820 |
| γ | 0.0673 | 0.0673 | 0.06730 / 0.06730 |
| e°(T) | 3.780 | 6.625 | 3.77993 / 6.62476 |
| ea | 3.402 | 3.445 | 3.40194 / 3.44487 |
| ω | −2.46 | 0.682 | −2.45945 / 0.68215 |
| Ra | 0 | 3.543 | 0 / 3.54341 |
| Rso | 0 | 2.658 | 0 / 2.65813 |
| Rns | 0 | 1.887 | 0 / 1.88650 |
| Rs/Rso | 0.8 (assumed) | 0.922 | 0.8 / 0.92170 |
| Rnl | 0.100 | 0.137 | 0.10032 / 0.13728 |
| Rn | −0.100 | 1.749 | −0.10032 / 1.74922 |
| G | −0.050 | 0.175 | −0.05016 / 0.17492 |
| Radiation term | −0.01 | 0.46 | −0.01361 / 0.45922 |
| Aerodynamic term | 0.01 | 0.17 | 0.01796 / 0.16770 |
| ET0 (mm/h) | 0.00 | 0.63 | 0.00434 / 0.62693 |

The night hour passes `nightRsRso: 0.8`, as the example assumes. The book prints the night aerodynamic term truncated (0.01 for 0.018). Tolerance for the vector test: `|ET0 − 0.63| ≤ 0.005` at 14-15 h and `|ET0| ≤ 0.005` at 02-03 h; every intermediate the book prints within 0.001, except the two night eq. 53 terms (0.01).

### A9. Computed vectors

`et0-vectors.json` gains two groups; `provenance` names `hourly_et0.py` (stdlib Python, in `docs/contracts/agronomy/sources/`, with σ written as `4.903e-9 / 24`) and the JavaScript prototype that reproduced it. Site for the three Payerne cases: 46.8° N, 6.95° E, 490 m, wind at 2 m. Tolerance 1e-4 mm/h for single hours, exact equality after rounding for the day.

A `fao56Hourly` entry:

```json
{ "name": "fao56_example19_1400_1500",
  "input": { "tMeanC": 38, "rhPct": 52, "windSpeedMs": 3.3, "windHeightM": 2, "solarRadMjM2h": 2.45,
             "elevationM": 8, "latDeg": 16.21667, "lonDeg": -16.25, "dayOfYear": 274,
             "hourStartUtc": "2026-10-01T15:00:00Z", "nightRsRso": null },
  "et0Mm": 0.63, "tolerance": 0.005,
  "terms": { "delta": 0.358, "gamma": 0.0673, "es": 6.625, "ea": 3.445, "omega": 0.682, "ra": 3.543,
             "rso": 2.658, "rns": 1.887, "rsRso": 0.922, "rnl": 0.137, "rn": 1.749, "g": 0.175,
             "radTerm": 0.46, "aeroTerm": 0.17 },
  "termTolerance": { "default": 0.001, "radTerm": 0.005, "aeroTerm": 0.005 } }
```

`terms` lists only the intermediates the entry asserts; a runtime compares each named term of its own `terms` object. The two Example 19 entries assert the published values with the A8 tolerances (the night entry's `radTerm` and `aeroTerm` at 0.01); the computed entries assert their five-decimal values at 1e-4.

| Name | Input | ET0 (mm/h) |
|---|---|---|
| `fao56_example19_0200_0300` | A8, `nightRsRso: 0.8` | 0.00 ± 0.005 (computed 0.00434) |
| `fao56_example19_1400_1500` | A8 | 0.63 ± 0.005 (computed 0.62693) |
| `payerne_summer_noon` | J 200, `2026-07-19T11:00:00Z`, T 28, RH 45, u2 2.0, Rs 3.0 | 0.61171 (terms `ra` 4.27076, `rso` 3.24492, `rn` 2.07242, `g` 0.20724) |
| `payerne_summer_noon_10m` | as above, the same wind given at 10 m: 2.6739716893 m/s, `windHeightM: 10` | 0.61171 |
| `payerne_winter_night` | J 355, `2026-12-21T01:00:00Z`, T 1, RH 90, u2 1.0, Rs 0, `nightRsRso: 0.5` | −0.00210 (signed) |

The 10 m wind is `2 / (4.87 / ln(67.8 · 10 − 5.42))`, stored to 10 decimals; the result equals the 2 m case to 1e-5.

A `fao56HourlyDays` entry, one synthetic station day (`payerne_synthetic_2026_07_19`):

```json
{ "name": "payerne_synthetic_2026_07_19",
  "input": { "hours": [ { "hourStartUtc": "2026-07-18T22:00:00Z", "tMeanC": 14.93, "rhPct": 79.49,
                          "windSpeedMs": 2, "solarRadMjM2h": 0 }, "… 24 entries …" ],
             "windHeightM": 2, "elevationM": 490, "latDeg": 46.8, "lonDeg": 6.95, "dayOfYear": 200,
             "priorRsRso": null },
  "sumMm": 4.845356, "et0Mm": 4.85, "lastRsRso": 0.7897,
  "hourly": [ { "hourStartUtc": "2026-07-18T22:00:00Z", "et0Mm": 0.0123, "sunUp": false, "rsRsoSource": "default" },
              "… 24 entries …" ] }
```

The values inside `hours[0]` and `hourly[0]` above only show the shape; the generator writes the real numbers. The day covers the 24 hours of local day 2026-07-19 in Europe/Zurich (`2026-07-18T22:00:00Z` to `2026-07-19T21:00:00Z`). For hour index h = 0…23: `s = sin(2π(h − 9)/24)`, `T = 20 + 7s`, `RH = 65 − 20s`, wind 2.0 m/s at 2 m, `Rs = 0.6 · Ra_h` with `Ra_h` from the hourly extraterrestrial radiation, each stored to 4 decimals. `sumMm` is 4.845356 from those stored inputs (the unrounded inputs give 4.845367; both lie within the tolerance, and 4.845356 is 3.6e-4 from the 4.845 rounding boundary, so `et0Mm` is 4.85 in every runtime). A runtime matches `sumMm` within 1e-4, `et0Mm` exactly, and every `hourly` entry's `et0Mm` within 1e-4 with its `sunUp` and `rsRsoSource` equal. The first six hours use the default ratio 0.5; the 04:00 UTC hour is the first day hour (sunrise at 4.05 UTC); the hour starting 16:00 UTC is the only carry candidate and passes its ratio 0.7897 to the evening; the 19:00 UTC hour straddles sunset (19.22 UTC), so it pins the `sunUp`-false-with-Ra-above-0 case. No hour of this day is negative. The daily `fao56Et0` on the same day's minimum, maximum and mean gives 4.73.

## B. Edge changes (osi-os `feat/daily-agronomy-parity`)

Constraints that hold for every item: flows.json changes only through a `scripts/migrate-flows-*.js` script, applied to both profiles (bcm2712 and the bcm2709 mirror); schema only through ordered migrations, never in flows or `deploy.sh`, and never in the frozen `sync-init-fn`; a boot-node trigger body changes only in `scripts/sync-trigger-source.json` and through `node scripts/generate-sync-trigger-source.js --write`; bundled seeds rebuilt with `node scripts/build-seed-db.js` (seven DBs); GUI explanations in tooltips only; new strings in seven locales, `lg` in English and listed in `docs/i18n/pending-luganda-translations.md`; the flows size ratchet gets a measured allowance for every node that grows, and `scripts/verify-live-gateway-identity.js` `expectedGrowth` is re-pinned for `sync-bootstrap-build`, `sync-force-build` and `al-link-build-req` when they grow; the migrate-runner pin in `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js` lists 64 and 65. If the RAK branch's 0060 lands on main first, sub-project 1's 0060-0063 are renumbered and 0064 and 0065 move up with them.

### B1. `osi-crop-kc` and its copies (plan E1)

- `resolveKc({ cropType, phenologicalStage, stageStartedOn, date })` implements A5 and returns `{ kc, kcSource, cropId, stage, kcStageDay, stageOverrun }`. `stageLengths(cropId)` returns `{ initial, development, mid_season, late_season }` (numbers or null) or null for an unknown crop. `kcRamp(prev, next, d, L)` is exported. Exports otherwise unchanged.
- `web/react-gui/src/agronomy/cropKc.ts`: the same three functions with the same types; `KcSource` gains `'fao56_curve'`.
- `scripts/build-kc-vectors.js`: its own copy of the rule, the A6 vector set.
- `scripts/verify-agronomy-contract.js`: runs the v2 vectors against `osi-crop-kc` with all four inputs; runs the two Example 28 `kcRamp` cases; checks every crop has `stage_lengths_days` with the nine fields and `stage_length_alternatives` as an array; checks `version === 2`; runs the new `fao56Hourly` and `fao56HourlyDays` groups against `et0.js`; and, given an osi-server checkout as its first argument (spec decision, the same form as `verify-dendro-contract-mirror.js osi-server`), byte-compares the four cloud copies (C1). Without the argument it prints one line saying the cloud copies were not checked. `.github/workflows/migrations.yml` gains `node scripts/verify-agronomy-contract.js osi-server` next to the dendro mirror step (line 183).

### B2. Migration `0064__stage_started_on.sql` (plan E2)

```sql
-- risk: additive
ALTER TABLE irrigation_zones ADD COLUMN stage_started_on TEXT;      -- YYYY-MM-DD: the day the current stage began; NULL = not set
ALTER TABLE zone_daily_agronomy ADD COLUMN stage_started_on TEXT;   -- the zone's value when the row's Kc was frozen
ALTER TABLE zone_daily_agronomy ADD COLUMN kc_stage_day INTEGER;    -- FAO's day in the stage (A5), NULL when not computed
ALTER TABLE zone_daily_agronomy ADD COLUMN stage_overrun INTEGER;   -- 1 when kc_stage_day > the stage length, 0 when not, NULL when not computed
DROP TRIGGER IF EXISTS trg_sync_zones_outbox_au;
CREATE TRIGGER trg_sync_zones_outbox_au ...;                        -- the rendered body from sync-trigger-source.json, byte for byte
```

**Trigger ownership.** `trg_sync_zones_outbox_au` stays owned by the boot node (`sync-init-fn` drops and recreates it on every start; `scripts/sync-trigger-source.json` `owners[0]` statement 2). The same route as sub-project 3's 0063 and precedent #337 (0058): the body changes in `scripts/sync-trigger-source.json`, `node scripts/generate-sync-trigger-source.js --write` rewrites the boot node's `triggers` array in both profiles, and 0064 and `seed-blank.sql` carry the rendered body byte for byte. The migration-owned lists (`MIGRATION_OWNED_TRIGGERS` in `verify-runtime-schema-parity.js`, `MIGRATION_OWNED_TRIGGER_NAMES` in `verify-trigger-body-parity.js`) do not gain it.

The edit to the `sql` string of the `trg_sync_zones_outbox_au` entry, applied on top of 0063's body (which already carries `weather_source`), is three insertions:

1. in the `WHEN` list, after `OR COALESCE(NEW.phenological_stage,'') <> COALESCE(OLD.phenological_stage,'')`: ` OR COALESCE(NEW.stage_started_on,'') <> COALESCE(OLD.stage_started_on,'')`;
2. in the `CASE` branch that yields `'ZONE_CONFIG_UPSERTED'`, after its `COALESCE(NEW.phenological_stage,'') <> COALESCE(OLD.phenological_stage,'')` term: the same ` OR …` comparison, so a date change alone selects that op (a change of `deleted_at` or coordinates still wins, as the `CASE` order is kept);
3. in the payload `json_object(`, after `'phenological_stage', NEW.phenological_stage, `: `'stage_started_on', NEW.stage_started_on, `.

The payload then has 23 key-value pairs (46 arguments). `trg_sync_zones_outbox_ai` (0046) is not redefined: a new zone has no start date (spec decision, as sub-project 3 does for `weather_source`). `verify-sync-flow.js` gains pins for insertions 1 and 3 in "Sync Init Schema + Triggers" and in `seed-blank.sql`, beside sub-project 3's `weather_source` pins.

Follow-ups: `seed-blank.sql`, the seven bundled DBs, `CHECKSUMS.json`, `verify-db-schema-consistency.js` (`schemaContract` for both tables), `generate-sync-trigger-source.js --check`, and the Terra fixture `scripts/fixtures/terra-edge-selection/edge-selection-v1.json` with its `.sha256`, regenerated with `TERRA_EDGE_FIXTURE_OUT=scripts/fixtures/terra-edge-selection/edge-selection-v1.json node --test scripts/test-terra-selection-edge-acceptance.js` because its zone trigger payloads change.

### B3. Migration `0065__zone_daily_agronomy_sync.sql` (plan E4)

```sql
-- risk: additive
ALTER TABLE zone_daily_agronomy ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS trg_dp_zone_agronomy_outbox_ai;
CREATE TRIGGER trg_dp_zone_agronomy_outbox_ai AFTER INSERT ON zone_daily_agronomy FOR EACH ROW WHEN EXISTS ( SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1 ) AND EXISTS ( SELECT 1 FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL AND zone_uuid IS NOT NULL ) BEGIN INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui) VALUES (lower(hex(randomblob(16))), 'ZONE_AGRONOMY', (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id) || '|' || NEW.date, 'ZONE_AGRONOMY_UPSERTED', json_object('contract_version', 1, 'zone_id', NEW.zone_id, 'zone_uuid', (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id), 'date', NEW.date, 'et0_mm', NEW.et0_mm, 'et0_tier', NEW.et0_tier, 'et0_source', NEW.et0_source, 'et0_station_id', NEW.et0_station_id, 'location_key', NEW.location_key, 'kc', NEW.kc, 'kc_source', NEW.kc_source, 'kc_stage_day', NEW.kc_stage_day, 'stage_overrun', NEW.stage_overrun, 'crop_type', NEW.crop_type, 'phenological_stage', NEW.phenological_stage, 'stage_started_on', NEW.stage_started_on, 'etc_mm', NEW.etc_mm, 'hours_present', NEW.hours_present, 'expected_hours', NEW.expected_hours, 'null_reason', NEW.null_reason, 'computed_at', NEW.computed_at, 'gateway_device_eui', COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.zone_id), NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')), 'sync_version', NEW.sync_version ), NEW.sync_version, strftime('%Y-%m-%dT%H:%M:%fZ','now'), COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.zone_id), NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))); END;

DROP TRIGGER IF EXISTS trg_dp_zone_agronomy_outbox_au;
CREATE TRIGGER trg_dp_zone_agronomy_outbox_au AFTER UPDATE ON zone_daily_agronomy FOR EACH ROW WHEN EXISTS ( SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1 ) AND EXISTS ( SELECT 1 FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL AND zone_uuid IS NOT NULL ) AND COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0) BEGIN <the ai body, unchanged> END;
```

The two bodies follow `trg_dp_zone_env_outbox_ai/au` (0058) in structure, with one addition: the zone guard in `WHEN` (committee I6), so a zone without a UUID emits nothing and the aggregate key never needs the `zone-id:` fallback. The migration file writes the `au` body out in full. There is no `AFTER DELETE` trigger and no delete op: the writer never deletes a row (B4). The payload of `ZONE_AGRONOMY_UPSERTED`, as JSON:

```json
{ "contract_version": 1, "zone_id": 3, "zone_uuid": "…", "date": "2026-09-20",
  "et0_mm": 3.12, "et0_tier": "station_fao56", "et0_source": "fao56_hourly", "et0_station_id": "00000000…",
  "location_key": null, "kc": 0.75, "kc_source": "fao56_curve", "kc_stage_day": 16, "stage_overrun": 0,
  "crop_type": "maize", "phenological_stage": "late_season", "stage_started_on": "2026-09-05",
  "etc_mm": 2.34, "hours_present": 24, "expected_hours": 24, "null_reason": null,
  "computed_at": "2026-09-21T00:30:02.114Z", "gateway_device_eui": "00000000000000A1", "sync_version": 2 }
```

**Versions.** The writer inserts a row with `sync_version = 1`, and its upsert sets `sync_version = zone_daily_agronomy.sync_version + 1` whenever the `WHERE` finds a changed column (the 0015 rule), so `au` fires once per real change. A row is never deleted and re-inserted, so its version only grows, whatever the clock does (controller ruling on cloud/sync B1; the Unix-seconds scheme of the first draft is withdrawn). Rows that exist before 0065 keep version 0 until their first change; the bootstrap brings them over. A zone removed by a hard delete takes its rows with it through `ON DELETE CASCADE`; that emits nothing, the cloud learns of the zone through `ZONE_DELETED`, and a re-created zone has a new UUID and therefore new keys.

Follow-ups: seed, seven DBs, `CHECKSUMS.json`, `schemaContract`, `MIGRATION_OWNED_TRIGGERS` in `verify-runtime-schema-parity.js` (two entries, owner `0065__zone_daily_agronomy_sync.sql`; precedent 0046, 0056) and `MIGRATION_OWNED_TRIGGER_NAMES` in `verify-trigger-body-parity.js`. The triggers are migration-owned and absent from the boot node, so they do not join the `verify-sync-flow.js` loop at lines 1567-1581, which asserts `expectIncludes('Sync Init Schema + Triggers', …)`. `verify-sync-flow.js` gets seed-only pins instead: for each of the two names, `expectFileIncludes('seed-blank.sql', seedSqlSource, name, …)` and `expectTriggerIncludes('seed-blank.sql', seedSqlSource, name, "WHERE peer_node = 'cloud' AND linked = 1", 'cloud link gate')`, plus one `expectTriggerIncludes` for the zone guard.

### B4. Daily writer (`osi-agronomy-daily`)

- **Station tier (plan E3).** For each station day whose every hour is complete, the tier calls `fao56Et0HourlyDay` with one element per hour: `hourStartUtc = hour_start`, `tMeanC = air_temperature_c`, `rhPct = relative_humidity_pct`, `windSpeedMs = wind_speed_mps` at `catalogue.stationWindHeightM`, `solarRadMjM2h = global_radiation_wm2 × 0.0036`; elevation as today (gateway altitude, else from mean pressure, else null); latitude and longitude from the zone; `dayOfYear` of the local date. An hour is complete for this tier when those four fields are non-null, radiation is ≥ 0 and `sample_count ≥ 3` (ruling R8; the hourly path needs the hour's mean temperature, not its minimum and maximum). The hour-cache query in `runZones` (`index.js` 293) adds `air_temperature_c` and `sample_count` to its column list. The plausibility check (0.06 × Ra for the day, zero in a daylight hour) is unchanged. A zone without a longitude cannot run the hourly tier and falls to the provider tier (spec decision; hourly Ra needs the longitude). The row gets `et0_tier = 'station_fao56'`, `et0_source = 'fao56_hourly'`. Tier 3 (Hargreaves) keeps its minimum and maximum temperature inputs.
- **`priorRsRso` (plan E3).** From the same station's cached hours in the 24 hours before the day's first hour, the writer takes the latest complete hour for which `fao56HourlyTerms(...).carryCandidate` is true and passes its `rsRso` term. No such hour: `priorRsRso` is null and the day's leading night hours use 0.5 (the hour cache already spans 94 days, so no new query).
- **Kc (plan E2).** The zone query gains `iz.stage_started_on`. The snapshot resolves `resolveKc({ cropType, phenologicalStage, stageStartedOn, date })` with the row's date and freezes `kc`, `kc_source`, `crop_type`, `phenological_stage`, `stage_started_on`, `kc_stage_day` and `stage_overrun` together, under the sub-project 2 rule (a row with a non-null `kc` keeps its snapshot; backfilled days follow the same rule, ruling R10). The stored-snapshot `SELECT` (`index.js` 332) gains the three columns.
- **Upsert (plan E2 for the columns, E4 for versions).** `ROW_COLUMNS` gains `stage_started_on`, `kc_stage_day` and `stage_overrun`. In E4 the insert values gain `sync_version = 1` and `DO UPDATE SET` gains `sync_version = zone_daily_agronomy.sync_version + 1`; the `WHERE` that suppresses unchanged rows stays, so an unchanged day neither bumps nor emits.
- **Retraction (plan E4).** The `DELETE … WHERE date >= today` at `index.js` 331 becomes an update that nulls the values of rows a clock that ran ahead wrote:

  ```sql
  UPDATE zone_daily_agronomy
     SET et0_mm = NULL, et0_source = NULL, et0_tier = NULL, et0_station_id = NULL, location_key = NULL,
         hours_present = NULL, expected_hours = NULL, kc = NULL, kc_source = NULL, kc_stage_day = NULL,
         stage_overrun = NULL, crop_type = NULL, phenological_stage = NULL, stage_started_on = NULL,
         etc_mm = NULL, null_reason = 'retracted', computed_at = ?, sync_version = sync_version + 1
   WHERE zone_id = ? AND date >= ? AND null_reason IS NOT 'retracted'
  RETURNING date
  ```

  The count joins `summary.retracted` (renamed from `deleted`). A retracted row has a null `kc`, so the next computation of that date takes a fresh snapshot, and the upsert overwrites it with the next version. The cloud receives the retraction as an ordinary `ZONE_AGRONOMY_UPSERTED` and falls back to its own row for that date (C8).
- The first run after the E3 deploy recomputes the last seven station days (their `et0_mm` and `et0_source` change); after E4 each changed row emits one `ZONE_AGRONOMY_UPSERTED`.

Vectors: `index.test.js` gains a station day built from the A9 synthetic inputs (with `sample_count = 6` per hour), whose row carries `et0_mm = 4.85`.

### B5. Zone setting, GUI and write paths (plan E2)

- **GUI.** `ZoneConfigModal` shows a date input "Stage started on" beside the stage select. It is enabled only when a stage is chosen. When the user picks a different stage, the input is pre-filled with today's date in the browser's local time, and stays editable (ruling R5); when the stage is set to "Not set" the input is emptied. The value is saved with the other changed fields through `irrigationZonesAPI.updateConfig` as `stageStartedOn` (`YYYY-MM-DD` or `null`), sent whenever `phenologicalStage` is sent too (`null` for an empty field), and alone when only the date itself changed. The HelpTip text (agronomy review, with `{{days}}` from `stageLengths(crop)[stage]`): "The date the current stage began (day 1). In the development and late-season stages Kc moves along the FAO-56 curve from this date; in the other stages it stays at the stage's value. The stage never advances by itself: after the typical length for this crop ({{days}} days) Kc stays at the stage's end value until you choose the next stage. After leaf fall or harvest choose Dormancy (Kc 0.25, bare soil); in spring choose Initial with the green-up date. Changes to crop, stage or start date apply to days calculated after the change. Leave empty to use the stage's table value." Keys (`devices` namespace): `zoneConfig.stageStartedOn` ("Stage started on"), `zoneConfig.stageStartedOnHelpLabel` ("About the stage start date"), `zoneConfig.stageStartedOnHelp` (the text above), `zoneConfig.stageStartedOnHelpNoLength` (the same text without the parenthesis "({{days}} days)", used when the crop has no length for the stage). The existing `zoneConfig.stageHelp` already tells evergreen growers that Dormancy is for deciduous crops and rest periods (ruling on agronomy M7). `normaliseZone` in `services/api.ts` and `IrrigationZone` in `types/farming.ts` gain `stageStartedOn: string | null`.
- **`zone-config-fn`.** Accepts `stageStartedOn` (or `stage_started_on`): `null` or `''` clears, a valid calendar date `YYYY-MM-DD` sets, anything else answers 400 `{ error: 'stageStartedOn must be YYYY-MM-DD or null' }`. Clearing rule (controller ruling on cloud/sync I7): a request whose stage normalises to unset while the stored stage normalises to a stage also sets `stage_started_on = NULL`, whatever it says about the date; any other request leaves the date alone unless it carries the key. Stage-date default (controller ruling on plan review E2 I2): a request whose stage normalises to a set stage other than the stored one (a legacy stored key counts as its FAO stage) and that carries no date sets `stage_started_on` to today in the zone's timezone (the request's `timezone` when it carries one; UTC for an unknown zone id, as `osi-agronomy-daily` reads it); the same stage keeps the date; a supplied date wins. Both rules compare with the stored stage inside the `UPDATE` (a `CASE` on the stored stage); the ownership `SELECT` also reads `timezone`. The column comes from 0064 only; no inline `ALTER` is added (`verify-no-stray-ddl`). The re-select lists `stage_started_on`.
- **Reads.** `get-zones-query` and `get-zones-response` carry `stage_started_on`.
- **Bootstrap and force-sync zones snapshots.** The `zones` query and map of `sync-bootstrap-build` and `sync-force-build` gain `stage_started_on` (spec decision, beside sub-project 3's `weather_source`), so a cloud that missed the event learns the date within one bootstrap.
- **Legacy `UPSERT_ZONE_CONFIG`** ("Build UPDATE SQL", node `4f4a765f36cee6f3`): `var ssd = cmd.stageStartedOn !== undefined ? cmd.stageStartedOn : cmd.stage_started_on;` a present `null` or valid `YYYY-MM-DD` sets the column; any other value leaves it and warns once naming the zone UUID (spec decision: the legacy path has no rejection channel). An absent key leaves the column untouched, which is what an older cloud or an incapable gateway's cloud sends. The clearing rule and the stage-date default are the same as `zone-config-fn`'s. The node builds SQL text and never reads the row, so both rules are a `CASE` on the stored stage inside the `UPDATE` (SQLite evaluates every `SET` expression against the row before the update); the zone-local today uses the command's `timezone`, else UTC. The flat legacy `UPSERT_ZONE` carries the same rules in its `ON CONFLICT DO UPDATE` (a `CASE` on `irrigation_zones.phenological_stage`, today in `cmd.timezone || 'UTC'`, the timezone the node already writes); a create writes the supplied date or NULL.
- **Protected `UPSERT_ZONE`** (`osi-zone-commands`, `normalizedZone`): `stage_started_on` joins the optional fields of `exactObject` for `UPSERT_ZONE` (not `UPSERT_ZONE_LOCATION` or `DELETE_ZONE`); `null` or `''` (trimmed) reads as no date, a valid `YYYY-MM-DD` sets it, anything else non-empty is `malformed_command` (`REJECTED_PERMANENT`); `insertZone` writes it; `updateFullZone` (lines 1013-1069) applies the stage-date rule when the key is absent — the same default the other three write paths take on a stage change, with the same override that a change to unset always clears the date whatever the key said — and keeps the sent value when the key is present.
- **Terra `UPSERT_ZONE_CONFIG`**: the exact field list is unchanged, so a Terra command carrying `stageStartedOn` is refused as today. The Terra path never carries a date, so it applies the stage-date default (controller ruling on plan review E2 I2) to the row it already reads in its transaction: a change to a different set stage sets `stage_started_on` to today in the zone's timezone, a change to unset clears it, the same stage keeps it. `osi-zone-commands` takes `normalizeStage` from `osi-crop-kc`.
- **Capability.** The `syncCapabilities` array in `sync-bootstrap-build`, `al-link-build-req` and `sync-force-build` gains `zone_config_stage_started_on_v1`, and E2 makes sure `zone_config_weather_source_v1` (sub-project 3's) is present in all three whichever way that sub-project landed. The three nodes keep building the same list; `verify-sync-flow.js` (the `expectIncludesForEach` at lines 2068-2072), `test-journal-bootstrap.js` and `test-entity-name-command-path.js`, which contain the list, follow; the edge AGENTS.md list "Sync capabilities the edge reports" gains both names.
- **Contract.** `docs/contracts/sync-schema/resources.schema.json` Zone gains `"stage_started_on": {"type": ["string", "null"], "format": "date"}` next to sub-project 3's `weather_source`.

### B6. Daily record sync (plan E4)

- **Bootstrap.** `sync-bootstrap-build` adds `zoneAgronomy` (committee I5, ruled: 30 days per zone, 1,000 rows per gateway):

  ```sql
  SELECT za.zone_id, iz.zone_uuid, za.date, za.et0_mm, za.et0_tier, za.et0_source, za.et0_station_id,
         za.location_key, za.kc, za.kc_source, za.kc_stage_day, za.stage_overrun, za.crop_type,
         za.phenological_stage, za.stage_started_on, za.etc_mm, za.hours_present, za.expected_hours,
         za.null_reason, za.computed_at, za.sync_version
    FROM zone_daily_agronomy za
    JOIN irrigation_zones iz ON iz.id = za.zone_id
   WHERE za.date >= date('now', '-30 day') AND iz.deleted_at IS NULL AND iz.zone_uuid IS NOT NULL
   ORDER BY za.date DESC, za.zone_id ASC
   LIMIT 1000
  ```

  It is sent as `zoneAgronomy` next to `zoneEnvironments`. Up to 33 zones get all 30 days; a larger gateway gets the newest days of every zone first. `sync-force-build` is not extended (spec decision; a force sync posts no `zoneAgronomy`, the cloud treats the missing list as empty, and the next scheduled bootstrap carries it).
- **No history-batch table.** `osi-history-sync-helper` does not learn `zone_daily_agronomy`.
- **Contract.** `docs/contracts/sync-schema/events.schema.json`: the op enum gains `ZONE_AGRONOMY_UPSERTED`; `x-semantic-bindings` gains it with `{"sync_version_path": "payload.sync_version"}` and no `aggregate_key_path` (spec decision: the key is the composite `zone_uuid|date`, which no single payload path holds; `test-contract-schemas.js` checks the key only when the path is present, line 459). `test-contract-schemas.js`'s expected event bindings list gains the entry, and so does `EXACT_EVENT_SEMANTIC_BINDINGS` in `scripts/verify-sync-contract.js` (`ZONE_AGRONOMY_UPSERTED: { sync_version_path: 'payload.sync_version' }`), which `assertExactMetadata` compares with the schema's `x-semantic-bindings` exactly. The op enters the edge schema with the edge producer, in this PR; no staging entry is used (D).
- **Verifiers.** `verify-sync-op-parity.js`: the op joins `SQL_OWNED_EVENT_OPS` (lines 159-191) with the comment "Emitted by 0065__zone_daily_agronomy_sync.sql's trg_dp_zone_agronomy_outbox_* triggers, not by flows.json". `verify-sync-flow.js`: the bootstrap key list (line 1408) gains `zoneAgronomy`; the B3 seed-only trigger pins; the Build UPDATE SQL pin gains the `stage_started_on` line; the get-zones pins gain the column.

### B7. `osi-zone-env` (plan E2)

`buildAgronomic` and the forecast days resolve Kc with the zone's `stage_started_on` and each day's local date; `zone-env-fn`'s zone query gains `iz.stage_started_on` (ratchet allowance; no inline `ALTER`). `buildWaterDaily` carries two more fields per past day, `stageOverrun` (from `stage_overrun`, as a boolean or null) and `demandComputedBy` (`'edge'` when the day has a stored value, else null); today's row carries `stageOverrun` from the current resolution and `demandComputedBy: null`. `DEMAND_FIELDS` (line 754) gains both names, so in shared mode the gateway's own values replace the cloud's for every date the gateway has. The golden vectors under `docs/contracts/zone-env/` are re-captured with `capture-zone-env-vectors.js`, and one case gains a dated development stage.

### B8. Dendrometer

`osi-dendro-analytics`' `PHENO_MOD` is unchanged; it already keys on the FAO stages.

### B9. Edge Water tab (plan E2)

`web/react-gui/src/types/farming.ts` `WaterDay` gains `stageOverrun?: boolean | null` and `demandComputedBy?: 'edge' | 'cloud' | null`. The tooltip gains three lines, in seven locales:

- `environment.water.kcSource.fao56_curve`: "{{crop}}, {{stage}} (FAO-56 curve)";
- `environment.water.stageOverrun`: "Past this stage's typical length ({{days}} days, FAO-56 Table 11): the stage may be out of date; choose the next stage when the crop reaches it." Shown when `stageOverrun` is true; `{{days}}` from `stageLengths(cropType)[stage]`;
- `environment.water.computedBy.cloud` and `environment.water.modelAccuracyNote` (C10's texts), shown for a day with `demandComputedBy === 'cloud'`, which only a shared-mode day the gateway has no row for can carry.

No day number is shown (spec decision).

## C. Cloud changes (osi-server `feat/daily-agronomy-parity`)

Constraints: backend tests with `./gradlew test` and `./gradlew archTest` from `backend/`, with Testcontainers needing `api.version=1.44` in `~/.docker-java.properties`; frontend tests with `npm run test:unit` (never a bare `npx vitest run`) and `npx tsc --noEmit`; no frontend production build on the workstation (it runs out of memory); each Flyway file is renamed at merge time to a version above main's newest (AGENTS.md, Conventions); `lg` strings are the English mirror. Cloud paths below are relative to `backend/src/main/java/org/osi/server/` unless they say otherwise.

### C1. Catalogue copies (plan CA)

- `backend/src/main/resources/agronomy/crop-kc.json` and `frontend/src/agronomy/crop-kc.json`: byte copies of the edge v2 file.
- `backend/src/test/resources/agronomy/kc-vectors.json` and `backend/src/test/resources/agronomy/et0-vectors.json`: byte copies of the edge vector files (spec decision: one vendored copy each, read by the Java tests and by the frontend vector test).
- `backend/src/test/java/org/osi/server/agronomy/CropKcCatalogueContractTest.java` pins `EXPECTED_SHA256` of `crop-kc.json` and asserts both copies hash to it, reading the frontend copy from `../frontend/src/agronomy/crop-kc.json` relative to `user.dir` as `ChannelManifestTest` does (lines 78-80); `frontend/src/agronomy/__tests__/cropKc.parity.test.ts` pins the same SHA (the `channels.parity.test.ts` pattern).
- `frontend/src/agronomy/__tests__/cropKc.test.ts` reads the vectors with `readFileSync(new URL('../../../../backend/src/test/resources/agronomy/kc-vectors.json', import.meta.url))`, `node:fs` loaded through a dynamic import as `channels.parity.test.ts` loads `node:crypto`; vitest runs under Node with `frontend/` as its working directory, so the file outside `frontend/` is readable.
- The edge's `verify-agronomy-contract.js` compares all four files against the edge (B1).

### C2. `CropKcCatalogue` (plan CA)

New leaf package `org.osi.server.agronomy` (spec decision: it depends on Jackson and the JDK and on no other OSI package, so analytics, prediction, sync and zonemutation can all use it without an ArchUnit cycle).

```java
public final class CropKcCatalogue {
    public static final Set<String> STAGES = Set.of("initial", "development", "mid_season", "late_season", "dormancy");
    public static CropKcCatalogue shared();                       // loaded once from the classpath
    public static String normalizeStage(String value);            // FAO key, or null for unset
    public static double kcRamp(double prev, double next, long d, int length);
    public KcResult resolveKc(String cropType, String stage, LocalDate stageStartedOn, LocalDate date);
    public Optional<Crop> cropById(String id);                    // trimmed, lower-cased
    public Optional<StageLengths> stageLengths(String cropId);
    public boolean isCatalogueCropOrOther(String value);
    public List<Crop> crops();
    public record KcResult(double kc, String kcSource, String cropId, String stage, Integer kcStageDay, Boolean stageOverrun) {}
    public record Crop(String id, String group, String label, double kcIni, double kcMid, double kcEnd, String variantOf) {}
    public record StageLengths(Integer initial, Integer development, Integer midSeason, Integer lateSeason) {}
}
```

Lifecycle (spec decision, cloud/sync M14): a static holder, because `PredictionCropProfiles`, `DendroAnalyticsService` and `ClusteredShadowHydrologyService` call it from static code. `shared()` reads `agronomy/crop-kc.json` from the classpath on first use and throws when the file is missing or `version != 2`. A `@Component` `agronomy/CropKcCatalogueStartupCheck` calls `shared()` in a `@PostConstruct`, so a bad file fails the application start rather than the first request. Unit tests call `shared()` directly; nothing is injected.

`normalizeStage` is the edge's rule exactly (spec decision, cloud/sync M1): trim, lower-case, return the five keys as themselves, map `budbreak`, `bud_break` → `initial`; `fruitset`, `cell_division`, `cell_expansion` → `development`; `veraison`, `fruit_maturation` → `mid_season`; `harvest`, `post_harvest` → `late_season`; everything else (`default`, blank, unknown, `mid-season` with a hyphen) → null. `CropKcCatalogueTest` runs all 1,335 vectors and the two Example 28 ramp cases.

### C3. `ZoneEnvironmentService` (plan CA)

- Deleted: `CROP_KC` (lines 67-131), `STAGE_KC_INDEX` (135-150), `PHENO_KC` (153-168), `deriveCropCoefficient` (1196-1211) and `determineCropCoefficientSource` (1213-1221). `isGatewaySyncedZone` stays; it still picks the forecast provider.
- Every zone, gateway-backed or not, resolves Kc through `CropKcCatalogue.shared().resolveKc(zone.getCropType(), zone.getPhenologicalStage(), zone.getStageStartedOn(), day)` (`getStageStartedOn` arrives in CB; CA passes null). The current agronomic Kc uses the zone's local today; each forecast day uses its own date (spec decision: the curve moves across the five forecast days; line 753 used one Kc for all of them).
- `cropCoefficientSource` carries the contract strings: `fao56_crop`, `fao56_crop_stage_unset`, `fao56_curve`, `heuristic_phenology`.
- `ZoneEnvironmentServiceTest`: the case at line 200 (stage `bud_break`, no crop) keeps Kc 0.45 and `heuristic_phenology`, and is re-checked, not changed; the gateway case at 767-814 (tomato, `fruitset`) becomes Kc 1.15 with `fao56_crop` (tomato `kc_mid`; it was 0.70 from the heuristic). New cases: a dated development zone, a dormant catalogue crop (0.25), a gateway zone with a catalogue crop.

### C4. Stage and crop vocabulary (plan CA)

- `PredictionCropProfiles.normalizePhenologyStage(value)` becomes the engine's projection of the FAO key (controller ruling, cloud/sync I1): `CropKcCatalogue.normalizeStage(value)`, then `dormancy` → `late_season` and null (unset, `default`, blank) → `mid_season`; the four other keys pass through. `LEGACY_STAGE_MAP` is deleted. It is called only from `PredictionCropProfiles.resolve` and the engine-facing services (`PredictionConfigService`, `PredictionFieldStateService`, `CanonicalPredictionSelectionResolver`); no controller calls it any more.
- `zonemutation/IrrigationZoneController.normalizePhenologyStage` (1067-1080) and the legacy `zone/IrrigationZoneController.normalizePhenologyStage` (913, on an unmapped route) switch to `CropKcCatalogue.normalizeStage`: null → no change; `''` or `default` → clear the stage (stored as null, spec decision); a key `normalizeStage` maps → that key; anything else → 400.
- `normalizeCropType` (zonemutation 1052-1065 and the legacy twin): blank → null; `isCatalogueCropOrOther` → the lower-cased id; a value equal (case-insensitive) to the crop already stored on the zone → accepted as stored (spec decision: a legacy free-text crop must not block saving the other fields); anything else → 400 "Unsupported crop". The `predictionClient.fetchCatalog()` call in both config paths (lines 318 and 517) goes, because nothing needs it.
- `ClusteredShadowHydrologyService.cropCoefficient` (624-635) already trims, lower-cases and turns `-` and space into `_` before its switch; it gains the legacy-key mapping through `normalizeStage` and an explicit `case "dormancy" -> 0.9` (controller ruling: the shadow model keeps its own scale; committee M8). Its values stay (initial 0.72, development 0.88, mid_season 1.02, late_season 0.78, other 0.9). A legacy `veraison` now reads 1.02 instead of 0.9. A follow-up issue revisits that model's scale.
- `DendroAnalyticsService.PHENO_MODIFIER` (102-109) is re-keyed: `initial` 0.8, `development` 0.8, `mid_season` 1.0, `late_season` 1.3, `dormancy` 1.5, unset 1.0, the stage read through `normalizeStage` (line 153). `DendroCalibrationTest` pins `classify` with explicit modifiers, not this table, so the table gets its own test, `DendroPhenoModifierTest` (spec decision).
- Terra's stage check (`TerraSelectionOperationService.java` 383-393) is unchanged.

### C5. Flyway migrations (plans CB and CC)

Two files, each renumbered at its merge above main's newest (today `V2026_09_26_001__history_hash_v2_compatibility.sql`; committee M7):

`backend/src/main/resources/db/migration/V2026_09_28_001__zone_stage_started_on.sql` (plan CB; `feat/cloud-planner` already holds the 2026_09_27 numbers; renumbered at merge as AGENTS.md rules):

```sql
-- Sub-project 4: the zone's stage start date (FAO-56 Kc curve) and the capabilities the
-- edge reports for the two zone fields the cloud may send to it (C9).
ALTER TABLE irrigation_zones ADD COLUMN IF NOT EXISTS stage_started_on DATE;
ALTER TABLE linked_gateway_accounts
    ADD COLUMN IF NOT EXISTS zone_config_weather_source_supported BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS zone_config_stage_started_on_supported BOOLEAN NOT NULL DEFAULT FALSE;
```

`backend/src/main/resources/db/migration/V2026_09_28_002__zone_daily_agronomy.sql` (plan CC1):

```sql
-- Sub-project 4: the daily agronomy record, one row per zone, date and source
-- ('edge' mirrored from the gateway, 'cloud' written from Open-Meteo's daily ET0).
CREATE TABLE IF NOT EXISTS zone_daily_agronomy (
    id BIGSERIAL PRIMARY KEY,
    zone_id BIGINT NOT NULL REFERENCES irrigation_zones(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    source VARCHAR(8) NOT NULL CHECK (source IN ('edge', 'cloud')),
    et0_mm DOUBLE PRECISION,
    et0_tier VARCHAR(32),
    et0_source VARCHAR(40),
    et0_station_id VARCHAR(64),
    location_key VARCHAR(80),
    kc DOUBLE PRECISION,
    kc_source VARCHAR(32),
    kc_stage_day INTEGER,
    stage_overrun BOOLEAN,
    crop_type VARCHAR(60),
    phenological_stage VARCHAR(30),
    stage_started_on DATE,
    etc_mm DOUBLE PRECISION,
    hours_present INTEGER,
    expected_hours INTEGER,
    null_reason VARCHAR(32),
    computed_at TIMESTAMPTZ,
    sync_version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT uq_zone_daily_agronomy_zone_date_source UNIQUE (zone_id, date, source)
);
```

The unique constraint's index leads with `(zone_id, date)` and serves the read range, so no second index. Entity `analytics/ZoneDailyAgronomy.java` (Lombok, like `ZoneDailyEnvironment`; `LocalDate date`, `LocalDate stageStartedOn`, `Boolean stageOverrun`, `Instant computedAt`, `long syncVersion`). It has no `@PrePersist` default for `computed_at`: the edge's value, or null, must survive (committee M13). Repository `analytics/ZoneDailyAgronomyRepository.java`: `List<ZoneDailyAgronomy> findByZoneIdAndDateBetweenOrderByDateAsc(Long zoneId, LocalDate from, LocalDate to)`, `Optional<ZoneDailyAgronomy> findByZoneIdAndDateAndSource(Long zoneId, LocalDate date, String source)`, `List<ZoneDailyAgronomy> findByZoneIdAndSourceAndDateBetween(Long zoneId, String source, LocalDate from, LocalDate to)`. `IrrigationZone` gains `@Column(name = "stage_started_on") private LocalDate stageStartedOn` (CB); `LinkedGatewayAccount` gains `zoneConfigWeatherSourceSupported` and `zoneConfigStageStartedOnSupported` (CB). Retention is unbounded: two rows per gateway zone-day at most, 730 a year. Entity-to-Flyway agreement is proven by the `ddl-auto=validate` ITs (`ZoneProjectionReconciliationAspectIT`, `CommandProjectionReconciliationAspectIT`), which need Docker, and by a new `analytics/ZoneDailyAgronomyPersistenceIT` for the unique key and the cascade (precedent `settings/AppSettingsPersistenceIT`).

### C6. Sync: applier, resource ref, ownership, bootstrap, contract (plan CC, zone upsert in CB)

- **Applier.** `sync/ZoneAgronomyApplier`, package-private `@Component @RequiredArgsConstructor class ZoneAgronomyApplier implements SyncEventApplier`, shaped like `ZoneIrrigationCalibrationApplier`:

  ```java
  public Set<String> supportedOps() { return Set.of("ZONE_AGRONOMY_UPSERTED"); }   // a constant: SyncOpCoverageTest mocks with CALLS_REAL_METHODS
  public void apply(String gatewayDeviceEui, EdgeSyncService.SyncEventRecord event) {
      upsertFromMap(gatewayDeviceEui, SyncEventShapes.payloadWithOp(event));
  }
  void upsertFromMap(String gatewayDeviceEui, Map<String, Object> row);             // no transaction of its own
  ```

  `upsertFromMap` runs inside the caller's transaction (the event executor's per-event transaction, or the bootstrap's). Steps: `zone_uuid` required, else `IllegalArgumentException("Zone agronomy payload missing zone_uuid")` (terminal; the text must not start with "Zone not found", committee M4); bounded 36; zone by UUID through `IrrigationZoneRepository.findByZoneUuid`, never through `EdgeSyncService.resolveZone` (which falls back to the edge's integer id), else `IllegalArgumentException("Zone not found for zone agronomy sync: " + zoneUuid)`, which `SyncEventTxExecutor.isParentMissing` turns into a retryable `parent_missing`; ownership: when the zone's `gatewayDeviceEui` is null or differs (case-insensitive) from `gatewayDeviceEui`, an event gets `throw new OwnershipDeniedException("Gateway '…' may not write zone agronomy for zone '…'")`, a terminal denial (committee I3); in the bootstrap, a mis-owned or ownerless zone's agronomy item is recorded as rejected with a warning and the rest of the bootstrap applies (controller ruling, plan review CC I4): the applier's bootstrap entry throws an `IllegalArgumentException` whose text does not start with "Zone not found", which `applyBootstrapItem` (`EdgeSyncService.java` 360-368) records in `rejected[]`; `date` parsed as `LocalDate`; the `(zone, date, 'edge')` row found or built; skipped when `SyncEventShapes.isStale(incoming, stored)`; every payload field copied. Bounds (committee M3): `crop_type` through `EdgeStrings.fitFreeText(…, 60, …)` as `upsertZone` does (the edge allows 128 characters, so a long legacy crop must not dead-letter its rows); `phenological_stage` through `normalizeStage`; `et0_tier` 32, `et0_source` 40, `et0_station_id` 64, `location_key` 80, `kc_source` 32, `null_reason` 32 through `EdgeStrings.requireBounded`; `stage_started_on` parsed as a date (unparseable: null with one warning); `stage_overrun` from 0/1/true/false; `computed_at` as an instant; `sync_version` from the payload. A concurrent insert of the same key by an event and a bootstrap can still violate the unique key; that race exists for `zone_daily_environment` today and is accepted (spec decision, committee M18).
- **Resource ref.** `EdgeSyncService.EventResourceRef.resourceTypeFromOp`: `if (op.startsWith("ZONE_AGRONOMY_")) return "ZONE_AGRONOMY";` before the generic `ZONE_` fallback (line 2759). `resourceIdForType`: `case "ZONE_AGRONOMY" -> zone_uuid + "|" + date`, like `ZONE_ENVIRONMENT` (2709-2711).
- **Ownership.** `EdgeOwnershipService.resolveOwnerEui` gains `case "ZONE_AGRONOMY"`, identical to `ZONE_ENVIRONMENT` (the zone UUID before `|` → the zone's `gateway_device_eui`); `DEVICE_ZONE_BOOTSTRAP_ALLOWED` gains `ZONE_AGRONOMY`.
- **Bootstrap.** `EdgeSyncService.EdgeBootstrapRequest` (line 2359) gains `List<Map<String, Object>> zoneAgronomy` as its last component, null → `List.of()`; the older constructors pass `List.of()`. `EdgeSyncService` gains a constructor field `ZoneAgronomyApplier zoneAgronomyApplier` (spec decision; the two test sites that call `new EdgeSyncService(`, `EdgeSyncServiceGatewayPrecedenceTest` and `EdgeSyncServiceOwnershipIntegrationTest`, pass it, and `SyncOpCoverageTest.widestConstructor` tolerates the extra argument). `applyBootstrapItems` loops the list after `zoneEnvironments` (line 302) with `applyBootstrapItem("ZONE_AGRONOMY", zoneUuid + "|" + date, rejected, () -> zoneAgronomyApplier.upsertFromBootstrap(authenticatedGateway.deviceEui(), row))`; a mis-owned or ownerless zone throws from this bootstrap-only entry point, not from `upsertFromMap` (the event path throws `OwnershipDeniedException` instead), which is what lets the rest of the snapshot apply. The applier's own version check keeps an old snapshot from overwriting a newer event row.
- **Zone upsert (plan CB, amended by the review fix wave's F2).** Bootstrap zones and zone events take the same path: `applyBootstrapItems` line 216 calls `upsertZone(zone, authenticatedGateway)`, the method `ZONE_UPSERTED`, `ZONE_CONFIG_UPSERTED` and `ZONE_LOCATION_UPSERTED` reach. In `upsertZone` (1072): when the payload contains `phenological_stage`, the stage is stored exactly as the edge sent it, null included, bounded to 30 characters (review finding I2 / controller ruling F2: normalizing it here, as an earlier cut of this plan did, rewrote a legacy key like `veraison` to its FAO equivalent on the cloud row, so the next unrelated command sent that rewritten text back to a gateway whose own edge still expects the legacy key). Every reader of the stored stage — `CropKcCatalogue.resolveKc`, the dendrometer and shadow-hydrology modifiers, the prediction catalogue projection, the frontend's own `normalizeStage` — resolves the FAO stage on its own, so the edge's `'default'`, a blank or an unknown value still behaves as unset wherever a Kc is computed, without the cloud rewriting the stored text to `null` to get there. When the payload contains `stage_started_on`: a valid date sets it, `null` clears it, an unparseable value is ignored with one warning (spec decision: a bad date must not reject the whole zone event). Absent keys keep the stored values. `weather_source` stays applied from the same event (lines 1112-1114); after this sub-project that is the edge-owned value (C9).
- **Contract vendor files.** `backend/src/test/resources/sync-contract/events.schema.json` gains the op and its binding (as B6); `sync-contract-golden.json` lists it under `eventOperations.accepted`, `serverHandlerEnabled` and `edgeProducerEnabled` (spec decision, chair guess 8: the edge PR merges straight after the cloud PR, and `SyncContractVendorTest` only requires `edgeProducerEnabled ⊆ accepted`; the `staged` list is not used). `resources.schema.json` becomes the edge file byte for byte (Zone with `weather_source` and `stage_started_on`); it moves together with E2 (D). `SyncContractVendorTest`, `SyncEventContractTest` and `SyncOpCoverageTest` cover them.

### C7. Cloud daily writer (plan CC)

`analytics/ZoneDailyAgronomyService` with `analytics/ZoneDailyAgronomyScheduler`:

```java
@Scheduled(cron = "0 20 * * * *", zone = "UTC", scheduler = "agronomyDailyTaskScheduler")
void run();                                                    // no-op when the property is false
public RunSummary runOnce(Instant now);                         // ZoneDailyAgronomyService, the entry point tests call
public record RunSummary(int groups, int calls, int inserted, int updated, int unchanged, int failedGroups) {}
record LocationGroup(String locationKey, ZoneId timezone, double latitude, double longitude) {}
```

- **Schedule.** Every hour at minute 20 UTC, so each zone's yesterday is attempted within an hour of its local midnight, whatever its timezone. It runs on its own single-thread scheduler, bean `agronomyDailyTaskScheduler` from `analytics/ZoneDailyAgronomySchedulingConfig` (precedent `SoilProfileRefreshSchedulingConfig`), so a slow run cannot hold up `HistoryRollupScheduler` (:05) or `PredictionScheduler` (:10) (committee M5). `application.yml` gains `osi.agronomy.daily-writer.enabled: ${OSI_AGRONOMY_DAILY_WRITER_ENABLED:true}`, read like `osi.history.rollup.enabled`; the test `application.yml` sets it to `false`. The scheduler passes `Instant.now()`; tests pass fixed instants.
- **Zones.** Every zone with `deleted_at IS NULL`, gateway-backed or not. `ZoneEnvironmentService.resolveLocationContext(zone)` (public, line 231; same `analytics` package, so no new package edge) gives coordinates and `ResolvedLocationContext.timezone()`.
- **Days.** The seven completed local days before the zone's today (today − 7 … today − 1).
- **Location.** No coordinates → a `no_location` row per day with no fetch. Otherwise `location_key = "open_meteo:" + fixed2(lat) + ":" + fixed2(lon)`, the edge's key form, with `fixed2(x) = String.format(Locale.ROOT, "%.2f", Math.round(x * 100) / 100.0)` and `-0.00` written as `0.00` (committee M15: a de-CH default locale would print a comma).
- **Source (controller ruling, chair I3).** One call per `LocationGroup` per run to a new `OpenMeteoService.getDailyEt0PastDays(double lat, double lon, ZoneId tz, int pastDays)` → `List<DailyEt0Value>` (`analytics/DailyEt0Value`, `record DailyEt0Value(LocalDate date, Double et0Mm)`), which calls `FORECAST_URL` with `daily=et0_fao_evapotranspiration`, `past_days=7`, `forecast_days=1` and `timezone`, and returns `List.of()` on any error. This is the same model family as the edge's provider tier, which reads the same endpoint (`osi-weather-provider/index.js` 99), and it has yesterday the next morning, unlike the archive endpoint (reanalysis, days behind). A group is fetched when one of its zones has a day without a `cloud` row, or when its last successful fetch in this process is six hours old or older (spec decision, committee M6: refresh four times a day, not 24; a restart re-fetches). Every zone takes this path this round, MeteoSwiss zones included.
- **Row.** `source = 'cloud'`, `et0_mm` = the value rounded to 2 dp, `et0_tier = 'open_meteo_daily'`, `et0_source = 'provider_native'`, `et0_station_id`, `hours_present` and `expected_hours` null, `sync_version` 1 on insert and + 1 on every change. Kc through `CropKcCatalogue.resolveKc` with the zone's crop, stage, start date and the row's date, frozen under the edge's rule (a row with a non-null `kc` keeps `kc`, `kc_source`, `crop_type`, `phenological_stage`, `stage_started_on`, `kc_stage_day`, `stage_overrun`); `etc_mm = round2(et0_mm × kc)`.
- **Refresh (ruling R7).** When a fetched value differs from a stored `cloud` row's `et0_mm`, the writer updates `et0_mm` and `etc_mm` (with the frozen `kc`) and bumps `sync_version`; Open-Meteo revises its recent days, and the seven-day window follows. A fetched null never overwrites a stored value. An unchanged day is not written (committee M8: a `no_location` row is rewritten only when the zone gains a location).
- **Null reasons (spec decision).** `no_location` as above; `no_source` for a day the response does not carry or carries as null. The `pending` state of the first draft goes: the endpoint has every past day of the window, so there is nothing to wait for, and the committee noted `no_source` at today − 7 could never show on the chart (M7).
- **Failure.** An empty list writes nothing for that group; the next hour retries.
- **Transactions.** HTTP calls run first, outside any transaction; then one transaction per zone through a `TransactionTemplate`.

Load: at most 24 calls a day for a group with a missing day, four a day for a complete one; 100 distinct locations cost about 400-600 calls a day. Open-Meteo's free tier allows 10,000 a day for non-commercial use; whether an instance needs Open-Meteo's commercial terms does not depend on this writer, because the forecast tiers already call the same API.

### C8. Reads: `WaterDay`, `buildWaterHistory`, `WeatherMath` (plan CC; `WeatherMath` in CA)

`ZoneEnvironmentSummary.WaterDay` becomes the edge's day shape plus `demandComputedBy` (controller ruling, chair I2):

```java
public record WaterDay(
        LocalDate date, Double rainMm, Double irrigationLiters, Double irrigationNetMm, Double totalWaterMm,
        Double demandMm, String demandSource, String demandComputedBy,
        Double et0Mm, String et0Source, String et0Tier, String et0StationId, String et0StationName,
        Double kc, String kcSource, String cropType, String phenologicalStage, Boolean stageOverrun,
        Integer hoursPresent, Integer expectedHours, String nullReason) {
    public WaterDay(LocalDate date, Double rainMm, Double irrigationLiters, Double irrigationNetMm, Double totalWaterMm) {
        this(date, rainMm, irrigationLiters, irrigationNetMm, totalWaterMm,
             null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null);
    }
}
```

`demandSource` is `'calculated'`, `'forecast'` or null, with sub-project 2's meaning; `demandComputedBy` is `'edge'`, `'cloud'` or null. `et0StationName` is the cloud device row's name for a station deveui (`DeviceRepository.findByDeviceEui`), the id itself for any other id (a MeteoSwiss station code), null when there is no id. `WaterEnvironment` gains `String todayDate`, the zone's local date (the edge's water block has the field with the same meaning).

`buildWaterHistory` (568-590) reads `zoneDailyAgronomyRepository.findByZoneIdAndDateBetweenOrderByDateAsc(zoneId, today − 6, today − 1)` and picks per past date:

1. the `edge` row when its `etc_mm` is not null → `demandMm = etc_mm`, `demandSource = 'calculated'`, `demandComputedBy = 'edge'`;
2. else the `cloud` row when its `etc_mm` is not null → the same with `'cloud'`;
3. else the `edge` row (its `null_reason`, `retracted` included, explains the gap) → `demandMm` null, `demandSource` null, `demandComputedBy = 'edge'`;
4. else the `cloud` row → the same with `'cloud'`;
5. else all agronomy fields null.

The day fields (`et0Mm` … `nullReason`) come from the picked row. Today's row mirrors the edge's (`osi-zone-env` `buildWaterDaily`): `demandMm = waterNeededTodayMm`, `demandSource = 'forecast'` (null with `nullReason = 'demand_unknown'` when there is no forecast demand), `demandComputedBy` null, `et0Mm`, `kc`, `kcSource`, `cropType`, `phenologicalStage` and `stageOverrun` from the zone's current agronomic block; `waterNeededTodayMm` keeps coming from the forecast (line 421).

`WeatherMath`:

- `fao56Et0(tMinC, tMaxC, meanRhPct, windSpeedMs, windHeightM, solarRadMjM2, elevationM, latDeg, dayOfYear)`: the hard-coded 10 m at line 85 becomes `windAt2m(windSpeedMs, windHeightM)`, a port of the edge guard (null for a height missing, ≤ 0 or with `67.8 z − 5.42 ≤ 1`; the speed unchanged at 2 m). `Et0Resolver` passes `10.0`; its tier order (native → fao56 → hargreaves) is unchanged.
- `hourlyExtraterrestrialRadiation(double latDeg, int dayOfYear, Instant hourStartUtc, double lonDeg)`, `fao56HourlyTerms(HourlyInput input)`, `fao56Et0Hourly(HourlyInput input)` and `fao56Et0HourlyDay(List<HourInput> hours, Double windHeightM, Double elevationM, double latDeg, double lonDeg, int dayOfYear, Double priorRsRso)`: ports of A7 with the same null rules, the same term names in `record HourlyTerms(...)` and `record HourlyDay(double et0Mm, double sumMm, double lastRsRso, List<HourResult> hourly)`. They are package-private in `analytics` (committee cloud/sync M16), because no production caller uses them this round; the ogd-smn follow-up will.
- `WeatherMathEt0Test` runs the vendored `et0-vectors.json` groups `fao56`, `fao56Rejects`, `hargreaves`, `fao56Hourly` and `fao56HourlyDays` (spec decision: `luxToRadiation` and `elevationFromPressure` are edge-only helpers and are skipped).

### C9. Zone configuration round trip (plan CB)

- `zone/IrrigationZoneController.ZoneConfigRequest` (line 885) gains `String stageStartedOn` as its last component, with a compat constructor of the old shape: null keeps, `''` clears, `YYYY-MM-DD` sets, anything else 400 (spec decision: the empty string clears, as `variety` and `notes` already do through `nullableText`, because a Java record cannot tell an absent key from a null). The date travels as an ISO `YYYY-MM-DD` string in every DTO and command payload and as `LocalDate` only on the entity.
- `zonemutation/MutationDesiredState` gains `String stageStartedOn` as its last component, with a compat constructor of the old 22-argument shape passing null (committee M12), so the existing positional constructions (`MutationDesiredState.java` 31 and 40, `IrrigationZoneController.java` 186 and 937, `CommandProjectionReconciliationAspectIT.java` 1073) keep compiling and only the ones that must carry the value change: `copy` and `withZoneUuid` carry it, `withConfig` gains a `nextStageStartedOn` parameter (one caller, line 524), `desiredFromCanonical` (937) fills it from the entity. `documentVersion` stays 1.
- `zone/ZoneDesiredState` (the read-side twin that `ZoneProjectionService` deserialises) gains the same last component and compat constructor, so the six constructions in `IrrigationZoneControllerSyncTest` (lines 213, 422, 449, 472, 498, 549) and three in `ZoneProjectionServiceTest` keep compiling. `ZoneProjectionService.validateVersion1Document` checks the stored document against the exact set `DESIRED_DOCUMENT_FIELDS` (lines 29-34) and rejects any other key; `stageStartedOn` joins as an optional field (present or absent, a string or null), so documents stored before the upgrade still read.
- **Clearing rule (controller ruling, cloud/sync I7).** `updateConfigByUuid` and the cloud-only `updateConfig` clear the start date only when the request's stage normalises to unset while the stored (desired or entity) stage normalises to a stage. Any other request keeps the date unless it carries `stageStartedOn`.
- **Stage-date default (controller ruling, plan review E2 I2; narrowed by the review fix wave's F3).** On the same two paths, a request whose stage normalises to a set stage other than the stored one (a legacy stored key counts as its FAO stage) and that carries no `stageStartedOn` sets the date to today in the zone's timezone (the request's `timezone` when it carries one, else the stored one; UTC for a missing or unknown zone id): `ZoneConfigVocabulary.stageChangedToAnotherSetStage` and `zoneLocalToday`. The same stage keeps the date; a supplied date wins. For a cloud-only zone the default always applies. For a gateway zone `updateConfigByUuid` applies it only when the gateway advertised `zone_config_stage_started_on_v1` (review finding I3 / controller ruling F3): `commandPayload` already strips the field from an incapable gateway's command, but the desired document used to carry the default's date regardless, so the pending response and `ZoneProjectionReadModel.projectedResponse` kept showing today's date until the projection retired even though the gateway never saw it. An incapable gateway's desired date now stays exactly as stored, and the pending response reflects that.
- **`commandPayload(MutationDesiredState desired, User user, long version, String deviceEui, String commandType)`** (967-993). For `UPSERT_ZONE` and `UPSERT_ZONE_CONFIG` it keeps `weatherSource` when the gateway (`desired.gatewayDeviceEui()`) advertised `zone_config_weather_source_v1` and `stageStartedOn` when it advertised `zone_config_stage_started_on_v1`, and always keeps them for such a gateway (controller ruling, cloud/sync I4: the edge's full-replace path needs the field); for every other command type (`UPSERT_ZONE_LOCATION`, `UPSERT_SCHEDULE`, `DELETE_ZONE`) and for a gateway without the capability it removes both. Call sites: line 192 (create, `"UPSERT_ZONE"`), 785 (`mutateDesiredZone`, its `commandType` argument), 860 and 878 (delete, `"DELETE_ZONE"`). The comment above the removal is rewritten: the edge applies both fields from these releases on, and an older edge's protected `UPSERT_ZONE` path (`osi-zone-commands` `exactObject`) refuses a field it does not list.
- **`applyCloudOwnedFields`** (1016) writes `weatherSource` to the cloud row only when the gateway lacks `zone_config_weather_source_v1` (spec decision on top of the ruling that the edge owns the field). Such a gateway neither receives nor echoes the field, so the cloud row stays its only home, as today. For a capable gateway the command carries the value and the edge's `ZONE_CONFIG_UPSERTED` echo writes it back through `upsertZone`. The javadoc says so.
- **Capability gate.** Two capabilities, one per field, because sub-project 3's edge (which applies `weather_source`) can reach a gateway without sub-project 4's edge (which applies `stage_started_on`):

  | Capability | Advertised by | Cloud flag |
  |---|---|---|
  | `zone_config_weather_source_v1` | edge from sub-project 3 on (its committee ruled it into that sub-project; E2 makes sure it is there) | `linked_gateway_accounts.zone_config_weather_source_supported` |
  | `zone_config_stage_started_on_v1` | edge from sub-project 4 on | `linked_gateway_accounts.zone_config_stage_started_on_supported` |

  `LinkedGatewayAccountService.applyEdgeCapabilities` (lines 416-432) sets the two booleans with `hasCapability`, next to `zoneDesiredStateSupported`. It runs at link time and on every bootstrap per linked user; the edge's `sync-bootstrap-inject` fires 8 s after Node-RED starts, so an upgraded gateway reports within seconds, and every 6 hours after that. New lookups:

  ```java
  // LinkedGatewayAccountRepository
  boolean existsByGatewayDeviceEuiAndZoneConfigWeatherSourceSupportedTrue(String gatewayDeviceEui);
  boolean existsByGatewayDeviceEuiAndZoneConfigStageStartedOnSupportedTrue(String gatewayDeviceEui);
  @Query("select distinct a.gatewayDeviceEui from LinkedGatewayAccount a "
       + "where a.zoneConfigStageStartedOnSupported = true and a.gatewayDeviceEui in :euis")
  Set<String> findStageStartedOnCapableGatewayEuis(@Param("euis") Collection<String> euis);
  // LinkedGatewayAccountService
  public boolean supportsZoneConfigWeatherSource(String gatewayDeviceEui);   // upper-cases the EUI
  public boolean supportsZoneConfigStageStartedOn(String gatewayDeviceEui);
  public Set<String> stageStartedOnCapableGateways(Collection<String> gatewayDeviceEuis);
  ```

  Any account of the gateway counts, since one gateway runs one release for all its accounts (spec decision; cost: after a downgrade, an account row that no longer bootstraps keeps `true`, and the cloud may send a field the older edge ignores on the flat path). `LinkedGatewaySummary` does not expose the two flags this round.
- **`ZoneResponse`** gains `String stageStartedOn` and `Boolean stageStartedOnSupported` as its last two components; the compat constructors pass `null, null`, and `withStageStartedOnSupported(boolean)` returns a copy. `ZoneResponse.from` fills `stageStartedOn` from the entity; `ZoneProjectionReadModel.projectedResponse` (line 40, today on the 35-argument compat constructor) moves to the canonical constructor and passes `desired.stageStartedOn()`; `ZoneMutationResponseFactory` (five constructions) passes the desired or entity value. `stageStartedOnSupported` is computed once per request (committee I5): `zoneread/IrrigationZoneReadController.getAll` collects the gateway EUIs of the merged list, calls `stageStartedOnCapableGateways` once, and maps each response with `withStageStartedOnSupported(eui == null || capable.contains(eui))`; the zonemutation controller applies the wither to the one response it returns, with one `supportsZoneConfigStageStartedOn` call. The cloud form disables the date input when the value is false, and its HelpTip adds "This gateway's software does not accept a stage start date yet." A stripped `stageStartedOn` would otherwise vanish: the field is edge-owned, the edge never sees it, and the projection retires on the edge's applied version.
- `updateConfig` for a cloud-only zone sets `zone.setStageStartedOn` directly.

On main the cloud sends only the flat legacy `UPSERT_ZONE_CONFIG` and `UPSERT_ZONE` shapes, which "Build UPDATE SQL" reads key by key and an old edge therefore tolerates; the gate keeps any producer of the protected shape, now or later, from sending a field an old edge refuses.

### C10. Frontend (plan CA for the modal selects and the catalogue, CB for the date, CC for the Water tab)

| File | Change |
|---|---|
| `src/agronomy/crop-kc.json` | new byte copy (C1); imported only by `src/agronomy/cropKc.ts`, which only the modal and the environment tabs import (committee M17) |
| `src/agronomy/cropKc.ts` | port of the edge module with the v2 `resolveKc`, `stageLengths`, `kcRamp`; `PREDICTION_CROP_NAMES` comes from `predictionAPI.getCatalog()` instead of the edge's bundled JSON |
| `src/agronomy/stageLabels.ts` | port of the edge module |
| `src/components/farming/shared/HelpTip.tsx` | port of the edge component |
| `src/components/farming/cropKc.ts` | deleted; `environment/AgronomicTab.tsx` imports `src/agronomy/cropKc.ts` |
| `src/components/farming/ZoneConfigModal.tsx` | crop select: the full catalogue grouped by FAO group with variants under their crop, `other`, and a stored value outside the catalogue kept as its own option (lines 416-419, 473, 601 today); stage select: the five FAO stages labelled by crop family, "Not set"; the stage start date input with the B5 pre-fill and HelpTip, disabled with the extra line when `stageStartedOnSupported` is false; the crop and stage notes (`zoneConfigModal.crop.note`, `zoneConfigModal.phenology.note`) become HelpTips (spec decision: tooltips only, as on the edge). The modal renders the selects from the bundled catalogue without waiting for `predictionAPI.getCatalog()` (lines 229-241); that call still runs and only fills the advisor's crop list in the crop HelpTip, and its failure drops that list instead of emptying the crop select. `stageStartedOn` diverges from B5's "sent only when it differs" (review finding I1 / controller ruling F1): it is sent, even as `''`, whenever `phenologicalStage` is sent, so the server's own stage-date default never has to guess for a request the GUI already answered; outside a stage change it still goes out only when it changed on its own |
| `src/components/farming/environment/waterChart.ts` | port of the edge file `web/react-gui/src/components/farming/environment/waterChart.ts`: per-day demand from `day.demandMm`, today drawn as the forecast, `demandDrawMm`, `hasWaterTrendData` |
| `src/components/farming/environment/WaterTab.tsx` | port of the edge file of the same path: demand tick, dashed today tick and "Today" label, boundary line, grey dash for a null day, tooltip lines (demand, source, Kc line, overrun line, today note), legend keys, and `sourceText`, which maps `(et0Tier, et0Source)` to the label key exactly as the edge does (`station_fao56` → `et0Tier.station_fao56`, `hargreaves_station` → `et0Tier.hargreaves_station`, source `meteoswiss_hourly_sum` → `et0Tier.provider_meteoswiss`, source `open_meteo_hourly_sum` → `et0Tier.provider_open_meteo`, `demandSource === 'forecast'` → `et0Tier.forecast`) plus one cloud case, tier `open_meteo_daily` → `et0Tier.open_meteo_daily`. The cloud keeps its single irrigation series (spec decision: the cloud has no measured/estimated split). A `computedBy` line follows the source line |
| `src/types/farming.ts` | `WaterDay` (779-785) as in C8, `demandSource: 'calculated' \| 'forecast' \| null`, `demandComputedBy: 'edge' \| 'cloud' \| null`; `WaterEnvironment.todayDate`; `IrrigationZone.stageStartedOn`, `stageStartedOnSupported` |
| `src/services/api.ts` | `normaliseZone` and the config update carry `stageStartedOn` |
| `src/channels/channels.json` | arrives from the base branch `feat/weather-data-view` (D); not changed here |

New keys in the seven locale files under `public/locales/<lng>/devices.json` (`lg` = English):

- `zoneConfigModal.stageStartedOn.label` "Stage started on", `.helpLabel` "About the stage start date", `.help` and `.helpNoLength` (the B5 HelpTip texts), `.unsupported` "This gateway's software does not accept a stage start date yet.";
- `zoneConfigModal.stage.{unset,initial,development,mid_season,late_season,dormancy}` and `zoneConfigModal.stageLabel.{woody,annual}.{five stages}` (the edge's English);
- `zoneConfigModal.cropGroup.<15 group ids>`, `zoneConfigModal.crop.helpLabel` and `.help`, `zoneConfigModal.phenology.helpLabel` and `.help` (the edge's `cropHelp` and `stageHelp` texts); `zoneConfigModal.crop.note` and `zoneConfigModal.phenology.note` are removed from all seven files and from any locale test that lists them;
- `environment.water.`: `today`, `legendDemand`, `legendDemandTodayForecast`, `demandCalculated`, `demandForecast`, `demandNoData`, `demandNoLocation`, `demandPending` (for edge rows that carry `pending`), `demandNoSource`, `demandMixedStation`, `demandUnknownStation`, `demandUnknownToday`, `tooltipTodayNote`, `kcLine`, `et0Line`, `stageOverrun` (B9's text), `kcSource.{fao56_crop,fao56_crop_stage_unset,fao56_curve,heuristic_phenology}`, `et0Tier.{station_fao56,hargreaves_station,provider_open_meteo,provider_meteoswiss,forecast}`, `neededTodayHelpLabel`, `neededTodayHelp`, `lastSevenDaysHelpLabel`, `attribution.open_meteo`, `attributionHelpLabel`. Where the edge has the key, its English is reused verbatim.
- Cloud-only texts (ruling R7, agronomy review wording), added on the edge too for shared mode (B9):
  - `environment.water.et0Tier.open_meteo_daily`: "Open-Meteo weather model, daily FAO-56";
  - `environment.water.computedBy.edge`: "Calculated on the gateway";
  - `environment.water.computedBy.cloud`: "ET0 from the Open-Meteo weather model (not measured at this farm); OSI Cloud applies the crop coefficient";
  - `environment.water.modelAccuracyNote`: "Model-based ET0 can differ from a local station by 10-20 % on a single day, most on cloudy, windy or mountain days; weekly totals agree better." Shown under a `cloud` day;
  - `environment.water.meteoswissCloudNote`: "This zone uses MeteoSwiss on the gateway; OSI Cloud's own history uses Open-Meteo until MeteoSwiss history is available in the cloud." Shown under a `cloud` day of a zone whose `weatherSource` is `meteoswiss`.

The 10-20 % figure is the agronomy reviewer's reading of published ERA5-against-station comparisons, not FAO text.

## D. Rollout and landing

**Deploy order.** The cloud deploys before any edge that carries this branch, on main and on every customer instance. The new cloud accepts the FAO keys and `dormancy`, `stage_started_on` from zone events and bootstrap, the new op and the `zoneAgronomy` bootstrap list. It sends `weatherSource` and `stageStartedOn` only to a gateway that advertised the matching capability (C9), so its commands to an older edge keep today's shape. The sub-project 3 constraint holds in the same words in both specs: sub-project 3's edge must not be deployed to a cloud-linked gateway before the sub-project 4 cloud change that makes the field edge-owned; cost if violated: a cloud-chosen provider resets to the edge value once (and vice versa until the cloud lands).

**`weather_source` after the upgrade (controller ruling, cloud/sync B3).** The edge value wins from the first bootstrap that carries it. A provider chosen explicitly on the cloud before the gateway ran sub-project 3's edge is replaced by the edge's value (`auto` unless someone set it on the gateway) and must be re-selected once, on the cloud or on the gateway; the release notes and the customer handover say so. On the Swiss customer gateways the edge's deployment default (`OSI_WEATHER_PROVIDER_DEFAULT`) is `meteoswiss`, so `auto` already resolves to MeteoSwiss there.

**Branches.** One PR per repo, both from a branch named `feat/daily-agronomy-parity` (controller ruling, chair B3). The edge branch sits on sub-project 3's `feat/weather-data-view`; the cloud branch sits on osi-server `feat/weather-data-view`. The seven plans (E) are commit series on these two branches, not separate PRs. Both branches are pushed while either PR's CI runs, so each run pairs with its twin: osi-server `backend-ci.yml` (lines 68-103) checks out the same-named osi-os branch and byte-compares the vendored `resources.schema.json`, `effect-keys.md`, `canonicalization.md` and `rejection-recovery-v1.json` (`verify-edge-sync-contract-vendor.sh` lines 33-36; `events.schema.json` is excluded by design and may run ahead on the cloud); osi-os `migrations.yml` (lines 19-41, 163-210) checks out the same-named osi-server branch and runs `verify-sync-op-parity.js`, the channels byte check and, from this PR on, `verify-agronomy-contract.js osi-server`. Pushing stays Phil's call.

**Landing requirements, stated identically in the sub-project 3 spec.** osi-server `feat/weather-data-view` carries both `channels.json` copies, the SHA pins (`ChannelManifestTest.java`, `channels.parity.test.ts`, `scripts/verify-channel-manifest-sync.js`, `docs/channel-manifest.md`) and the vendored `resources.schema.json` with `weather_source`, and must be pushed before the sub-project 3 edge PR's CI can pass; the two merge in lockstep. Pushing stays Phil's call.

**Merge order (controller ruling, chair B3).**

1. Sub-project 3's edge PR (`feat/weather-data-view`, osi-os) and osi-server `feat/weather-data-view` (manifest and schema copies), in lockstep.
2. The cloud PR (`feat/daily-agronomy-parity`, osi-server).
3. The edge PR (`feat/daily-agronomy-parity`, osi-os), straight after 2, in the same sitting.

The two new contract items enter with the edge producer: `ZONE_AGRONOMY_UPSERTED` joins osi-os `events.schema.json` in the edge PR, and no entry goes into `scripts/fixtures/sync-contract-staging.json` (its arrays are checked against exact constants in `verify-sync-op-parity.js`, lines 90, 106 and 876-912, so the fixture cannot stage a non-journal op). Between steps 2 and 3 two gates are red for every other PR: osi-os PRs fail op parity against osi-server main ("server extra: ZONE_AGRONOMY_UPSERTED"), and osi-server PRs fail the vendor byte check because the cloud's `resources.schema.json` (with `stage_started_on`) is ahead of osi-os main. Both end with step 3; keep the window to one sitting. If the edge PR cannot follow at once, the fallback is the established SQL-owned-op route: the edge merges first with the op in the staging fixture's `cloudDeferred` list, which means extending `EXACT_CLOUD_DEFERRED_EVENT_OPS` in the verifier, then the cloud PR, then a cleanup PR. Merge order is not deploy order; deploy stays cloud first.

**Evidence for the merges.** GitHub Actions on osi-server is refused for billing, so the local gates in Testing, run with the two environment variables of the cross-repo block, are the merge evidence for the cloud PR; the edge PR's CI runs on osi-os.

**Customer branches.** A customer cloud runs from a customer branch, which is re-cut from main after the cloud PR merges and deployed before the edge of that customer's gateways is re-cut. A customer cloud whose branch lacks the appliers gets them first: no gateway linked to it may carry `ZONE_AGRONOMY_UPSERTED` until it does. The customer clouds and their deployed revisions are listed in the private SDD ledger, not here. Check each customer cloud's applier set against the edge before pointing the edge at it (AGENTS.md, "Deploy order and sync compatibility").

**The `unknown_op` hazard.** An edge that sends `ZONE_AGRONOMY_UPSERTED` to a cloud without the applier gets a terminal `unknown_op` rejection, recorded as inbox and dead-letter rows. A resend answers DUPLICATE, so requeueing never reaches the applier. After the cloud upgrades, the next bootstrap (8 s after a Node-RED start, then every 6 hours; last 30 days per zone, 1,000 rows at most) brings the rows over, because the bootstrap path does not consult the inbox; the dead letters stay until an operator clears them through the controlled replay (`SyncDeadLetterReplayService`).

**Old edge, new cloud.** An edge without this branch sends no daily rows; the cloud's own rows fill every day and the tooltip says the ET0 is model data. Its `ZONE_CONFIG_UPSERTED` carries no `stage_started_on`, so the cloud keeps whatever it has (null). Its stage keys are FAO keys after edge migration 0062, or legacy keys from an older edge, and both normalise. It advertises neither capability, so the cloud strips both fields from its commands and keeps writing `weatherSource` to its own row, exactly as today. Were a field to slip through, "Build UPDATE SQL" sets columns only for keys it knows and would ignore it; the protected `UPSERT_ZONE` path, whose `exactObject` would refuse it, is what the gate protects.

**Sub-project 3 edge, new cloud.** The gateway advertises `zone_config_weather_source_v1` and not the date capability: the cloud sends `weatherSource`, the edge applies and echoes it, and the date input on the cloud form is disabled for that gateway's zones.

**New edge, old cloud.** Forbidden by the order above. If it happens anyway: every daily row is rejected `unknown_op` as described; `stage_started_on` in zone events is ignored; the old cloud strips `weatherSource` and never sends `stageStartedOn`, so the edge keeps its local values; the old cloud's Water tab keeps the repeated-today demand.

**Edge first runs.** The first daily run after E3 recomputes the last seven station days with the hourly sum and rewrites their `et0_mm`; after E4 each changed row bumps its version and emits one event. Rows older than seven days keep their daily-equation values and `station_fao56` source.

**One writer per cluster (review, queue CC1 T6 follow-up).** `ZoneDailyAgronomySchedulingConfig`'s six-hour Open-Meteo fetch gate (`lastSuccessfulFetch`) is an in-process map, not a database row: several application nodes behind the same cloud each run their own hourly writer, and each one thinks it is the first to fetch and the first to write every location group. Rows stay correct (the unique `(zone_id, date, source)` key means only one insert per node wins, and the rest fail their own transaction with a logged `WARN`), but every node makes its own Open-Meteo calls and every day's first insert collides on every node but one. Run the writer on exactly one application node (`OSI_AGRONOMY_DAILY_WRITER_ENABLED=true`) and set `OSI_AGRONOMY_DAILY_WRITER_ENABLED=false` on the rest; this is the same shape as `OSI_HISTORY_ROLLUP_ENABLED` for `HistoryRollupScheduler`.

**A reseeded gateway's daily rows (review, queue follow-up).** `zone_daily_agronomy.sync_version` starts at 1 on a gateway's first row for a zone-day and grows by 1 on every edge-side change (Decisions, "Row versions"). A gateway whose database was reset (a backup restore without an identity migration, a fresh SD card) restarts its own per-day versions at 1 too, below whatever the cloud already holds for days it saw before the reset: `SyncEventShapes.isStale` and the applier's own version check answer `stale_sync_version` for every one of those rows, terminally, for as long as the reset gateway's version stays behind. This is the same limitation the rain and flow records already have after a reset (no new one here); the cloud's own rows for those days are untouched and still readable. Acceptance item 7 ("no `stale_sync_version` rows … during the rollout") assumes no gateway is reset mid-rollout; note this in the deployment handover rather than treating a reset gateway's rejections as a regression.

**Acceptance item 5 waits on a pre-existing route gap (review finding I5).** `ZoneConfigModal` always calls the by-UUID route (`PUT .../by-uuid/{zoneUuid}/config`), and `updateConfigByUuid`'s `mutateDesiredZone` answers 403 for a canonical zone that is not edge-backed — a cloud-only zone cannot save its configuration through that route today, on `main` already, before this branch. This sub-project's cloud-only `updateConfig` path (the clearing rule, the stage-date default, `withStageStartedOnSupported(true)`) is exercised by its own tests, not by the form. Until the by-UUID route is taught to fall back to the cloud-only path for a gateway-less zone (a separate, pre-existing fix, not part of this branch), run acceptance item 5's cloud-only zone through the id route or the API directly, not through the zone settings modal.

## E. Plans

The sub-project is too large for one plan per side (committee chair). Seven plans, executed in this order, each leaving both branches green and deployable if the work stopped there:

| Plan | Repo | Delivers | Why the state after it is deployable |
|---|---|---|---|
| E1, contract v2 | osi-os | A1-A9 and B1: `crop-kc.json` v2 with `sources/`, `kc-vectors.json` v2, `et0-vectors.json` groups, `osi-crop-kc.resolveKc`/`stageLengths`/`kcRamp`, `cropKc.ts`, `build-kc-vectors.js`, the three hourly functions in `et0.js` with tests, `verify-agronomy-contract.js` with the osi-server argument, README | No zone has a start date yet, so the curve never runs and the station tier is untouched: edge behaviour equals sub-project 3's. |
| CA, catalogue and maths | osi-server | C1-C4, C8's `WeatherMath` part, C10's catalogue, stage labels, HelpTip and the modal's crop and stage selects (no date input) | The cloud stops ignoring the crop for gateway zones and accepts FAO keys; nothing it sends to an edge changes (an older edge stores a stage key as text, as it does today). |
| CB, stage date and capability gate | osi-server | C5 first file; `IrrigationZone.stageStartedOn`; C6 zone-upsert part; C9 in full; C10 date input and `stageStartedOnSupported` | The cloud stores and shows the date and sends it only to gateways that advertised the capability; until E2 no gateway has, so the input is disabled for gateway zones. `weatherSource` now reaches sub-project 3 gateways, which is the intended change. |
| CC, daily record | osi-server | C5 second file; C6 applier, resource ref, ownership, bootstrap, `events.schema.json` and golden; C7; C8 `WaterDay`, `buildWaterHistory`, `todayDate`; C10 `waterChart.ts`, `WaterTab.tsx`, locale keys; the vendored `resources.schema.json` with `stage_started_on` | Every zone gets cloud rows; gateway zones get edge rows once E4 runs. The applier waits for an op no deployed edge sends yet. |
| E2, stage date round trip | osi-os | B2 (0064 through the trigger source), B4 Kc part and new columns, B5, B7, B9 | An old cloud ignores the unknown key and the unknown capability; a new cloud starts sending the date. |
| E3, hourly station tier | osi-os | B4 station tier and `priorRsRso`, README statement, `index.test.js` synthetic day | The cloud never reads `et0_source` semantically; the change is local to the edge's numbers. |
| E4, daily record sync | osi-os | B3 (0065, two triggers), B4 versions and retraction, B6 | Requires CC deployed on every cloud the edge talks to (D's `unknown_op` hazard); the only plan with a hard cross-repo deploy dependency. |

E2 and E3 may run before CB and CC without harm. The PR-level merge order is D's.

The plan reviews split two rows into two files each (controller rulings): CC runs as CC1 (backend) and CC2 (frontend); E2 runs as E2a (Tasks 1-5 of the table row: migration, write paths, writer, `osi-zone-env`; no cloud dependency) and E2b (the GUI, which embeds the cloud's texts from the CB and CC2 plan texts). The execution order the edge chair adopted is SP3, E1, CA, CB, CC1, CC2, a controller rebase onto sub-project 3's finished head, E2a, E2b, a re-vendor of `resources.schema.json` on the cloud branch, E3, E4.

## Error handling

- **Invalid start date.** From the edge GUI: 400 with a message, nothing saved. From the cloud form: 400. In a legacy command: ignored with one warning. In a protected command: `REJECTED_PERMANENT malformed_command`. In a zone event on the cloud: ignored with one warning, the rest of the zone applied. In a daily row on the cloud: stored as null with one warning.
- **Start date in the future.** Accepted. The curve clamps p at 0 and records `kc_stage_day ≤ 0`, so the row shows it.
- **Stage left past its length.** p clamps at 1 on a ramp stage; every FAO stage records `kc_stage_day > L` and `stage_overrun = 1`, and the tooltip says the stage may be out of date.
- **Crop without lengths.** The table value applies; nothing is logged per row.
- **Station hour incomplete (a field missing, fewer than three samples) or longitude missing.** The station tier fails for that day and the next tier runs, as today.
- **Night hours with no afternoon hour.** Ratio from the previous day's carry hour, else 0.5; the day is still computed.
- **Negative sum.** A day whose signed hourly sum is below 0 stores `et0_mm = 0`.
- **Open-Meteo down or rate-limited.** No row written for the affected group that hour; the next hour retries; a day the response lacks is `no_source`.
- **Daily row for a zone the cloud does not know yet.** Retryable `parent_missing`; the outbox retries with backoff until `ZONE_UPSERTED` has arrived.
- **Daily row naming another gateway's zone.** `OwnershipDeniedException`: a terminal rejection for an event, a denied bootstrap for a snapshot.
- **Clock ahead on the edge.** Rows dated today or later are retracted on the next valid run (values null, `null_reason = 'retracted'`, version + 1); the cloud shows its own row for those dates; the edge writes the date again, with the next version, once it completes.
- **Clock behind on the edge (an RTC-less Pi rebooted offline).** Up to the existing 24-hour `clock_behind_store` guard, the writer may retract real completed days that its stale clock calls today or later; they are recomputed with higher versions once the clock is right, and the cloud shows its own rows meanwhile. No version ever goes backwards.

## Testing

### Edge

| File | Behaviour |
|---|---|
| `osi-crop-kc/index.test.js` | all 1,335 vectors; the two Example 28 `kcRamp` cases; `stageLengths` for a verified crop, a promoted proposal (`garlic`), a swapped default (`sugar_beet`), `grass` (two nulls), `conifer` (all null), an unknown id |
| `web/react-gui/src/agronomy/__tests__/cropKc.test.ts` | the same vectors and ramp cases through the TypeScript |
| `osi-agronomy-daily/et0.test.js` | Example 19 both hours within the A8 tolerances, every published intermediate; the three computed hours at 1e-4; the 10 m wind equal to the 2 m case; the winter night −0.00210 (signed); the synthetic day's `sumMm`, `et0Mm` 4.85 and every `hourly` entry; a day whose signed sum is negative returns 0; the carry rule (the 16:00 UTC hour carries 0.7897 to the evening); `priorRsRso` used before the first carry; the default 0.5; each null rule |
| `osi-agronomy-daily/index.test.js` | the station tier writes `fao56_hourly` with the hourly sum; an hour missing `air_temperature_c` or with `sample_count = 2` fails the tier; a zone without longitude falls to the provider tier; `priorRsRso` from the previous day's carry hour; Kc frozen with `stage_started_on`, `kc_stage_day` and `stage_overrun`; insert version 1; a changed row bumps `sync_version` by 1, an unchanged run bumps nothing; a clock-ahead row is retracted once (a second run does not bump it) and later overwritten with the next version |
| `scripts/test-stage-started-on-migration.js` (new, the `test-gateway-eui-attribution.js` pattern: `node:sqlite` DB from `seed-blank.sql`) | 0064 applies on the seed and on a DB at 0063; `trg_sync_zones_outbox_au` emits `ZONE_CONFIG_UPSERTED` with `stage_started_on` when only the date changes; the migration's trigger body equals the boot node's rendered body |
| `scripts/test-zone-agronomy-sync-triggers.js` (new, same pattern) | 0065 applies; the two triggers emit nothing while unlinked and nothing for a zone without a UUID; `ai` and `au` payloads equal the B3 shape; `au` fires only on a version change; a retraction emits one event with null values |
| `scripts/test-zone-command-path.js` | protected `UPSERT_ZONE` with `zone.stage_started_on = '2026-05-01'` applied; `null` applied; the key absent keeps the stored value; `'05/01/2026'` and `'2026-02-30'` `REJECTED_PERMANENT` |
| `scripts/test-legacy-upsert-zone-config.js` (new, spec decision; the Build UPDATE SQL harness of `test-legacy-upsert-zone-name.js`) | `stageStartedOn: '2026-05-01'` sets; `null` clears; key absent leaves the column; `'2026-02-30'` leaves it and warns; snake-case key works; a stage change from `development` to `default` clears the date; a notes-only command with stage `default` on a zone already unset leaves the date; a change to another set stage without a date sets the command's zone-local today, the same stage keeps the date, a supplied date wins; the flat `UPSERT_ZONE` follows the same rules on conflict |
| `scripts/test-terra-zone-config-command-flow.js` | a Terra `UPSERT_ZONE_CONFIG` with `stageStartedOn` is refused (exact field list) |
| `scripts/test-zone-update-sync-version.js` (the suite that exercises `zone-config-fn`) | valid date set, `null` cleared, invalid 400, a change to unset clears the date, an unrelated save keeps it, a change to another set stage without a date sets the zone-local today (a UTC+14 zone), `veraison` to `mid_season` keeps the date, a supplied date wins |
| `scripts/test-terra-selection-edge-acceptance.js` | regenerated fixture passes; a Terra stage change sets the zone-local today (a Europe/Zurich zone at 22:30 UTC gets the next calendar day), the same stage keeps the date, unset clears it |
| GUI `ZoneConfigModal` tests | date input disabled without a stage; pre-filled with today on a stage change and editable; emptied when the stage is set to "Not set"; HelpTip text with and without a length; payload carries `stageStartedOn` only when changed; locale keys in seven files |
| GUI `WaterTab` tests | the `fao56_curve` source line; the overrun line; the `computedBy.cloud` and accuracy lines on a shared-mode cloud day |
| `capture-zone-env-vectors.js --verify` | re-captured cases plus the dated development case |
| gates | `verify-agronomy-contract.js` (with and without the osi-server argument), `verify-sync-flow.js`, `verify-sync-op-parity.js`, `verify-sync-contract.js`, `test-contract-schemas.js`, `verify-runtime-schema-parity.js`, `verify-trigger-body-parity.js`, `generate-sync-trigger-source.js --check`, `test-sync-trigger-source.js`, `verify-migrations`, `verify-seed-replay`, `verify-db-schema-consistency.js`, `verify-no-stray-ddl.js`, `verify-profile-parity.js`, `test-flows-wiring.js`, `verify-flows-size-ratchet.js`, `verify-live-gateway-identity.js`, the migrate-runner pin test, GUI `npm run typecheck` and `npm run test:unit`, and `slop-check.js` on every changed prose file |

### Cloud

| File | Behaviour |
|---|---|
| `agronomy/CropKcCatalogueTest` | all 1,335 vectors; the Example 28 ramp cases; `normalizeStage` for five keys, nine legacy keys, `default`, blank, `mid-season`, unknown; `shared()` fails on a missing file or version 1 |
| `agronomy/CropKcCatalogueContractTest` | both copies hash to the pinned SHA |
| `analytics/WeatherMathEt0Test` | the five vendored groups; the 10 m wind still gives the previous values for the old 10 m vectors |
| `analytics/Et0ResolverTest` | unchanged order; the resolver passes 10 m |
| `analytics/ZoneEnvironmentServiceTest` | C3 cases; the forecast days carry per-date Kc on a dated zone |
| `analytics/ZoneDailyAgronomyServiceTest` (new) | seven days per zone; one call per location group; a complete group re-fetched only after six hours; `no_location`; `no_source` for a missing day; a revised value updates `et0_mm` and `etc_mm` with the frozen Kc and bumps the version; a null never overwrites a value; a failed call writes nothing; Kc frozen across a stage change; `etc_mm` rounding; the location key in `Locale.ROOT` under a de-CH default; timezone boundary (Europe/Zurich and Africa/Kampala zones at 22:20 UTC); the property switches it off |
| `analytics/ZoneDailyAgronomyPersistenceIT` (new, Docker) | unique key, cascade on zone delete, `computed_at` kept as given |
| `analytics/ZoneWaterHonestyTest` and a new `ZoneWaterHistoryAgronomyTest` | the five-step read rule with edge and cloud rows in every combination, a retracted edge row included; `demandSource` and `demandComputedBy` values; today's row from the forecast; `todayDate` |
| `analytics/DendroPhenoModifierTest` (new) | the six values and legacy keys through `normalizeStage` |
| `prediction/ClusteredShadowHydrologyServiceTest` | a legacy key and `dormancy` (0.9) through the normalised switch |
| `prediction` tests of `PredictionCropProfiles` | `dormancy` → `late_season`, null and `default` → `mid_season`, FAO keys pass through |
| `sync/ZoneAgronomyApplierTest` (new) | upsert new, update, stale skip, equal version re-applied, parent missing, missing `zone_uuid` terminal, foreign gateway denied, long legacy crop fitted, cloud row untouched |
| `sync/EdgeSyncServiceDataPlaneTest` | the op through `applyEvent`; resource ref `ZONE_AGRONOMY` with id `zone_uuid|date` (not the shared `ZONE` slot); zone upsert: `phenological_stage: 'default'` clears the stage, `'veraison'` stores `mid_season`, `stage_started_on` set, cleared, kept when absent, ignored when unparseable |
| `sync/EdgeSyncServiceBootstrapTest`, `sync/EdgeBootstrapRequestDeserializationTest` | `zoneAgronomy` applied, absent list tolerated |
| `sync/EdgeSyncServiceOwnershipIntegrationTest`, `security/EdgeOwnershipServiceTest` | `ZONE_AGRONOMY` owner from the zone; bootstrap-allowed; a bootstrap row for another gateway's zone denied |
| `sync/SyncContractVendorTest`, `SyncEventContractTest`, `SyncOpCoverageTest` | the vendored enum equals `accepted`; the op dispatches |
| `zone/IrrigationZoneControllerSyncTest` | the test at lines 790-845 that pins "never sends weatherSource" is renamed and extended, not deleted: without the capability the payload has no `weatherSource` and the cloud row takes the value; with it the payload carries the value and the cloud row waits for the echo |
| zonemutation controller tests | `stageStartedOn` set, `''` clears, invalid 400; a change to unset clears the date, an unrelated save keeps it; a change to another set stage without a date sets the zone-local today on both config paths, the same stage keeps the date, a supplied date wins; `dormancy` accepted; `cell_division` stored as `development`; a catalogue crop outside the prediction catalogue accepted; the zone's own legacy crop accepted unchanged; an unknown crop 400; `commandPayload` keeps each field for `UPSERT_ZONE` and `UPSERT_ZONE_CONFIG` only with its capability, strips both for location, schedule and delete commands; `stageStartedOnSupported` in the response |
| `zone/ZoneProjectionServiceTest` | a stored document without `stageStartedOn` reads; one with it reads; an unknown key is still rejected |
| `zoneread` read controller test | one capability query per list, `stageStartedOnSupported` true for a cloud-only zone and a capable gateway |
| `user/LinkedGatewayAccountServiceTest` | `applyEdgeCapabilities` sets both new flags from the reported list and clears them when a later report omits them; the set lookup |
| `ChannelManifestTest`, `channels.parity.test.ts` | the new SHA (from the base branch) |
| frontend `waterChart.test.ts` | the "repeats today's demand" case (lines 43-47) replaced by per-day demand from `demandMm`, today from the forecast, null days, `hasWaterTrendData` |
| frontend `WaterTab.test.tsx`, `WaterTab.trend.test.tsx` | ticks, today dashed and labelled, tooltip lines including the `computedBy` line, the accuracy note, the MeteoSwiss note, the overrun line and the `open_meteo_daily` tier |
| frontend `ZoneConfigModal.locales.test.tsx`, new `ZoneConfigModal.cropCatalogue.test.tsx`, `ZoneConfigModal.stageStartedOn.test.tsx`; existing `ZoneConfigModal.weatherSource.test.tsx` | grouped catalogue, legacy value kept, five stages, the selects render before `getCatalog()` resolves and after it fails, date input rules and pre-fill, input disabled with the extra HelpTip line when `stageStartedOnSupported` is false, keys in seven locales, provider select unchanged |
| frontend `src/agronomy/__tests__/cropKc.test.ts`, `cropKc.parity.test.ts` | vectors and SHA |
| gates | `./gradlew test` (the `ddl-auto=validate` ITs need Docker), `./gradlew archTest`, `npm run test:unit`, `npx tsc --noEmit`, `sh scripts/verify-flyway-ordering.sh`, `node scripts/verify-channel-manifest-sync.js`, `sh scripts/verify-edge-sync-contract-vendor.sh` with `EDGE_CONTRACT_ROOT` |

### Cross-repo

```sh
EDGE_WT=<osi-os checkout of feat/daily-agronomy-parity>
CLOUD_WT=<osi-server checkout of feat/daily-agronomy-parity>

# in the cloud checkout: vendored sync contract against the edge branch
EDGE_CONTRACT_ROOT=$EDGE_WT sh scripts/verify-edge-sync-contract-vendor.sh

# in the edge checkout: edge ops against the cloud branch's EdgeSyncService and appliers
OSI_SERVER_EDGE_SYNC_SERVICE=$CLOUD_WT/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java \
  node scripts/verify-sync-op-parity.js

# in the edge checkout: agronomy catalogue and vector copies in the cloud branch
node scripts/verify-agronomy-contract.js $CLOUD_WT
```

`verify-sync-op-parity.js` pairs by worktree directory name when the environment variable is missing (lines 233-243), not by branch; the cloud checkout's directory is `daily-agronomy-cloud`, so the variable is mandatory for local runs. The channels byte check (`migrations.yml` lines 185-210) is run by hand with `sha256sum` on the edge file and the two copies on the osi-server branch `feat/weather-data-view`.

## Not in scope

- A MeteoSwiss observed store on the cloud (the ogd-smn hourly port); cloud MeteoSwiss zones use Open-Meteo.
- Automatic stage advance from the Table 11 lengths.
- Low-latitude default stage lengths for Uganda (README note; follow-up).
- Climate adjustment of `kc_mid` and `kc_end` (FAO-56 eq. 62 and 65); it needs a crop height the catalogue does not carry.
- A cloud data view of provider or station weather.
- History-batch replication of `zone_daily_agronomy`.
- Editable stage lengths per zone, and the picker over `stage_length_alternatives`.
- Olive's footnote-24 off-season Kc and the forage cutting cycles.
- Refreshing the cloud's Terra fixture copy (`backend/src/test/resources/contracts/terra-v2/edge-selection/`, pinned to osi-os commit `c7211074`); it can follow once E2 is on osi-os main.
- `resolveZone`'s fallback to the edge's integer `zone_id` against cloud ids (`EdgeSyncService.java` 2075-2086), a side finding of the committee ledgered for the handover; the new applier does not use it.

## Acceptance

1. All edge and cloud gates listed under Testing pass locally, with the three cross-repo commands green against the paired checkouts.
2. The agronomy reviewer's A3 rulings and the three swaps are in `crop-kc.json` and the README.
3. On a test gateway linked to a test cloud (after Phil's go for deployment, cloud first): setting a maize zone to development with a start date 20 days back shows Kc 0.77 in the edge's agronomic tab and on the cloud; the next completed day's row reaches the cloud's `zone_daily_agronomy` as `source = 'edge'` with `kc_source = 'fao56_curve'` and the same `kc_stage_day`.
4. On the same gateway, a station-served zone's rows carry `et0_source = 'fao56_hourly'`, and the cloud's Water tab shows six distinct past-day ticks whose tooltip says "Calculated on the gateway".
5. A cloud-only zone shows cloud rows for yesterday by the next morning, with the model-data line and the accuracy note.
6. Clearing the stage on the cloud reaches the edge as a cleared stage and a cleared start date, and the edge's echo leaves the cloud's zone unchanged; a notes-only save leaves the date alone.
7. The cloud's `sync_dead_letters` gains no `unknown_op` and no `stale_sync_version` rows for `ZONE_AGRONOMY_UPSERTED` during the rollout.
8. A config edit on the cloud for a zone of a gateway that has not reported `zone_config_stage_started_on_v1` produces an `UPSERT_ZONE_CONFIG` without `stageStartedOn` (and without `weatherSource` when `zone_config_weather_source_v1` is missing), and the form shows the start date input disabled.
9. On a gateway that reports `zone_config_weather_source_v1`, choosing MeteoSwiss on the cloud reaches the edge's `irrigation_zones.weather_source`, and the edge's echo keeps the cloud's value at `meteoswiss`.

## Review changes

The committee's three reports and the controller's rulings (`.superpowers/sdd/2026-09-27-daily-agronomy-parity/`) against the first draft (`2239f6fa`), one line per finding.

### Chair

| Id | How the spec handles it now |
|---|---|
| B1 | 0064's trigger change goes through `sync-trigger-source.json` and the generator; no migration-owned entries (B2). |
| B2 | The 0065 triggers get seed-only pins in `verify-sync-flow.js`, outside the boot-node loop (B3). |
| B3 | One branch name on both repos, one PR each, merge order and red window stated, staging route dropped, fallback named (Status, D). |
| B4 | `p = clamp((d + 1)/L)`; A5, A6, Decisions, README and Acceptance 3 follow (0.77). |
| B5 | The 16 reference proposals are defaults, `conifer` and `sisal` all-null (A3). |
| I1 | Withdrawn by the controller: rows are never deleted, versions start at 1 (B3, B4). |
| I2 | `demandMm` and `demandSource` kept, `demandComputedBy` added (C8, Decisions). |
| I3 | Forecast endpoint with `past_days=7`, refresh inside the window, hourly schedule, enable switch (C7). |
| I4 | Both capability names in both specs; E2 makes sure both are advertised (B5, C9). |
| I5 | Bootstrap `zoneAgronomy`: 30 days per zone, `LIMIT 1000` (B6). |
| I6 | `ai` and `au` carry the zone-UUID guard (B3). |
| M1 | `commandPayload` gains only the command type; the EUI is `desired.gatewayDeviceEui()` (C9). |
| M2 | Status states the intended base, not a done rebase. |
| M3 | The `zone-config-fn` suite is `test-zone-update-sync-version.js` (Testing). |
| M4 | Renumbering note for 0064 and 0065 (B constraints). |
| M5 | The synthetic day pins the hour that straddles sunset through its `hourly` entries (A7, A9). |
| M6 | The Water tab port maps `(et0Tier, et0Source)` as the edge's `sourceText` does (C10). |
| M7 | Two Flyway files, one per plan (C5). |
| M8 | Shadow hydrology gains the legacy mapping and an explicit `dormancy` case (C4). |
| Plan split | Section E, seven plans with their deployable states. |
| Guess 1 | Hour element shape and null rule (A7). |
| Guess 2 | `terms` field names (A7). |
| Guess 3 | JSON shapes of both new `et0-vectors.json` groups and of a `kc-vectors.json` v2 record (A6, A9). |
| Guess 4 | `priorRsRso` from the latest complete `carryCandidate` hour in the previous 24 hours of the hour cache (B4). |
| Guess 5 | The three insertions into the trigger source string (B2). |
| Guess 6 | `runOnce(Instant)`, `RunSummary`, `LocationGroup`, `resolveLocationContext` in the same package (C7). |
| Guess 7 | `apply` unwraps with `payloadWithOp` and calls package-private `upsertFromMap(gatewayEui, row)` (C6). |
| Guess 8 | The op sits in `accepted`, `serverHandlerEnabled` and `edgeProducerEnabled` (C6). |
| Guess 9 | Frontend vector path `new URL('../../../../backend/src/test/resources/agronomy/kc-vectors.json', import.meta.url)` (C1). |
| Guess 10 | Edge files ported and the tier mapping (C10). |
| Guess 11 | The modal renders without waiting for `getCatalog()`; the call only feeds the advisor list (C10). |
| Guess 12 | `test-stage-started-on-migration.js` and `test-zone-agronomy-sync-triggers.js` (Testing). |
| Guess 13 | `kc_stage_day` wording in A2 and A5. |
| Guess 14 | The writer's insert, update and retraction SQL (B3, B4). |
| Guess 15 | Bootstrap zones go through `upsertZone` at `applyBootstrapItems` line 216 (C6). |

### Agronomy

| Id | How the spec handles it now |
|---|---|
| B1 / R1 | FAO's `d + 1`, the regenerated A6 table with the `L − 1` column, both half cases, the Example 28 `kcRamp` test (A5, A6). |
| I1 / R3 | Signed hours summed, the day clamped; `payerne_winter_night` is −0.00210 (A7, A9). |
| I2 / R2 | `kc_stage_day` 1-based for all four stages, `stage_overrun` stored and synced, overrun tooltip line, the replacement HelpTip text (A5, B2, B5, B9). |
| I3 / R7 | Refresh inside the window, tier label, the model-data, accuracy and MeteoSwiss texts (C7, C10). |
| I4 / R4 | The 16 rows as ruled, `sudan_grass` 25/25/–/– (A3). |
| I5 / R6 | README regional note; no code (A2). |
| R5 | The GUIs pre-fill today's date on a stage change (B5, C10). |
| R8 | `sample_count ≥ 3` for a complete hour (B4). |
| R9 | Cantaloupe, sugar beet and almond swapped (A1). |
| R10 | Frozen rows unchanged; the HelpTip says changes apply to later days (B5). |
| M1 | σ written as `4.903e-9 / 24` everywhere (A7, A9). |
| M2 | Clipping kept and documented as ASCE-EWRI practice (A2, A7). |
| M3 | README sentence on low-sun hours (A2). |
| M4 | README sentence on the night default and Karamoja (A2). |
| M5 | Same as R9. |
| M6 | Ruled: the shadow model keeps 0.9 on its own scale (C4). |
| M7 | Ruled: Dormancy stays offered; the existing `stageHelp` text already covers evergreens; the grassed-alley note goes into the README (A2, B5). |
| M8 | Rounding note now names `kc * 100` (A5). |
| M9 | README note on forage cuts; cutting cycles stay out of scope (A2). |
| M10 | Same as R10. |
| M11 | Branch names corrected throughout. |
| M12 | The hourly-versus-daily explanation names the vapour-pressure method (Decisions, A2). |
| M13 | Same as R8. |
| M14 | Not applied (spec decision): a cloud-filled day on a gateway zone is told apart in the tooltip (`computedBy` line), not by a second tick style. |

### Cloud and sync

| Id | How the spec handles it now |
|---|---|
| B1 | No deletes, no delete op, no `ad` trigger; retraction by update; versions from 1 (B3, B4, C6). |
| B2 | Same as chair B3; the vendored `resources.schema.json` travels on osi-server `feat/weather-data-view` for sub-project 3 (D). |
| B3 | The edge owns `weather_source`; the capability is advertised from sub-project 3 on; the incapable-gateway branch of `applyCloudOwnedFields`; the one-time re-selection note (C9, D). |
| I1 | The prediction engine's stage projection stays at its boundary (C4, Decisions). |
| I2 | Same as chair I3. |
| I3 | The applier checks the zone's gateway against the authenticated one (C6). |
| I4 | A capable gateway always receives both fields in `UPSERT_ZONE`; the edge's full-replace path writes the date when present (B5, C9). |
| I5 | One capability query per list in `IrrigationZoneReadController` (C9). |
| I6 | Same as chair I5. |
| I7 | The date is cleared only on an explicit change to unset (B5, C9, Decisions). |
| M1 | Java `normalizeStage` is the edge's rule exactly (C2). |
| M2 | Golden lists decided (C6). |
| M3 | `fitFreeText` for the crop, `requireBounded` for enum-like fields (C6). |
| M4 | Missing `zone_uuid` text defined and gated out on the edge (B3, C6). |
| M5 | Own scheduler thread, HTTP outside transactions, fixed instants in tests, property name (C7). |
| M6 | Six-hour refresh per complete group (C7). |
| M7 | `pending` dropped; `no_source` for a missing day (C7). |
| M8 | Unchanged rows, `no_location` included, are not rewritten (C7). |
| M9 | Same as chair I2. |
| M10 | "Any account" kept with its cost; the bootstrap timing corrected to 8 s after start (C9). |
| M11 | Not applied (spec decision): force sync stays without `zoneAgronomy`; the scheduled bootstrap repairs within 6 hours (B6). |
| M12 | Compat constructors for both desired-state records and `ZoneConfigRequest`; the positional sites named (C9). |
| M13 | The `ddl-auto=validate` ITs named as the gate, a persistence IT added, no `@PrePersist` default (C5). |
| M14 | Static `CropKcCatalogue.shared()` plus a startup check; `supportedOps()` is a constant (C2, C6). |
| M15 | `EdgeBootstrapRequest`, `ResolvedLocationContext.timezone()`, `Locale.ROOT` key (C6, C7). |
| M16 | Hourly Java functions package-private (C8). |
| M17 | `crop-kc.json` imported only by the modal and the environment tabs (C10). |
| M18 | Accepted as the existing race (C6). |
| Guesses 1-10 | Covered by the chair's guesses above and by C2 (lifecycle), C7 (property), C9 (DTO types, `LinkedGatewaySummary` unchanged), C8 (`et0StationName` lookup), C5 (file names). |
| Gates | `IrrigationZoneControllerSyncTest.java:790-845` flipped, the positional desired-state constructions, the Docker-backed validate ITs, the Terra fixture, `verify-live-gateway-identity.js` pins (Testing, B2). |

### Plan review

| Id | How the spec handles it now |
|---|---|
| CC I4 | A bootstrap agronomy item for a mis-owned or ownerless zone is recorded as rejected with a warning and the rest of the bootstrap applies; the event path keeps the terminal denial. This replaces the earlier sentence that the bootstrap rethrows the denial by design (C6). |

### Plan review, edge (2026-09-27)

The edge plan committee (`plan-review-E1-E3.md`, `plan-review-E2-E4.md`, `plan-review-edge-chair.md`) and the controller's `rulings-edge-plans.md`.

| Id | How the spec handles it now |
|---|---|
| E1-E3 I1, controller ruling | Customer specifics left the spec: no live cloud hashes, no customer branch names, no named commercial instance; section D and C7 use generic wording, and the private SDD ledger keeps the details (C7, D). |
| E1-E3 minor 5 | A date parses only as `YYYY-MM-DD` with a four-digit year from 0100 on (A5). |
| E1-E3 minor 6 | `hourStartUtc` is epoch milliseconds or an ISO instant with a zone (A7). |
| E1-E3 minor 7 | `nightRsRso` and `priorRsRso` outside [0.3, 1.0] give null (A7). |
| E1-E3 minor 9, chair I4 | A9's `sumMm` is 4.845356, computed from the 4-decimal inputs (A9). |
| Chair I4 | "Build UPDATE SQL" builds SQL text and never reads the row; both rules are a `CASE` inside the `UPDATE` (B5). |
| Chair B1, E2-E4 B1 | `verify-sync-contract.js` `EXACT_EVENT_SEMANTIC_BINDINGS` gains the op (B6). |
| E2-E4 I2, controller ruling | Stage-date default on every server write path, both sides (Decisions, B5, C9, Testing). |
| Chair I3, controller ruling | E2 runs as E2a and E2b; the adopted execution order is stated (E). |

### Found while revising

- `ZoneProjectionService.validateVersion1Document` accepts only the exact field set `DESIRED_DOCUMENT_FIELDS`, so the first draft's claim that a stored document "reads the new field as null" was wrong in the other direction: a new document with `stageStartedOn` would have been rejected. The field joins as optional (C9).
- The positional constructions the cloud review counted as `MutationDesiredState` are `ZoneDesiredState`, the read-side twin; both records get the field (C9).
- A1's maize example now shows the v1 `label` and `fao_row` as the file holds them.
