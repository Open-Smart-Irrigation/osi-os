# Daily Agronomy Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every zone gets one stored row per completed local day with ET0 (from a local station, the provider hours, or Hargreaves), a frozen Kc from the FAO-56 catalogue, and ETc; the Water tab draws seven per-day demand ticks with today as a forecast; the crop and stage settings use the full FAO-56 vocabulary; every explanation is a tooltip.

**Architecture:** A contract directory (`docs/contracts/agronomy/`) holds the crop catalogue, stage vocabulary and vector files; copies in the edge helper `osi-crop-kc` and the GUI are byte-checked. Two new helpers (`osi-station-hours`, `osi-agronomy-daily`) hold all logic and are driven by two thin function nodes chained after the weather tick. `osi-zone-env` adopts the Kc resolver, gains `buildWaterDaily`, and extends the linked-gateway overlay. The GUI ports the cloud's "Last 7 days" chart with real per-day demand and swaps its crop and stage selectors.

**Tech Stack:** Node.js 22 (`node:test`, `node:sqlite` for tests), SQLite through the `osi-db-helper` facade, Node-RED function nodes via `osi-lib`, React + TypeScript + vitest + recharts 2.15 + i18next (7 locales), FAO-56 Table 12 and equations 6, 7, 47, 52; the cloud's `WeatherMath.java` compiled offline with `javac` for the reference vectors.

**Spec:** `docs/superpowers/specs/2026-09-26-daily-agronomy-design.md`

## Global Constraints

- Work in the worktree `.worktrees/daily-agronomy` on branch `feat/daily-agronomy` (stacked on `feat/weather-provider-store`, base `6462699ca`). Never `cd` to another checkout. Never bare `git stash`. Never write into `<osi-server>`; read it with `git -C <osi-server> show main:<path>` only.
- Schema changes only through ordered migrations `0061__daily_agronomy.sql` (`-- risk: additive`) and `0062__fao56_stage_keys.sql` (`-- risk: data`); bundled seeds rebuilt with `node scripts/build-seed-db.js`; `sync-init-fn` frozen; no DDL in flows.json or deploy.sh. The seed's `phenological_stage TEXT DEFAULT 'default'` stays.
- A value not delivered is `null`, never 0. A day is written with a `null_reason` when it cannot be summed; never a scaled or borrowed value. Today is never written. `null_reason` is one of `no_source`, `partial_day`, `mixed_station`, `unknown_station`, `pending`, `no_location`.
- `zone_daily_agronomy.et0_station_id` names the source of a day: the station deveui for `station_fao56` and `hargreaves_station`, the MeteoSwiss station id for a MeteoSwiss `provider_hourly_sum`, null for Open-Meteo.
- Stage keys stored: `initial`, `development`, `mid_season`, `late_season`, `dormancy`, or null/`'default'` meaning unset. Legacy keys accepted on read: `budbreak|bud_break → initial`, `fruitset|cell_division|cell_expansion → development`, `veraison|fruit_maturation → mid_season`, `harvest|post_harvest → late_season`, `dormancy → dormancy`, anything else → unset. The GUI writes `'default'` when the user picks "Not set".
- Kc rules: catalogue crop → `initial: kc_ini`, `development: (kc_ini + kc_mid) / 2`, `mid_season: kc_mid`, `late_season: kc_end`, `dormancy: 0.25`, unset: `kc_mid` with `kc_source = 'fao56_crop_stage_unset'`, else `kc_source = 'fao56_crop'`. Non-catalogue crop (`other`, unknown, null) → heuristic `initial .45, development .70, mid_season .90, late_season .60, dormancy .25, unset .75`, `kc_source = 'heuristic_phenology'`. Rounded to 2 decimals.
- ET0 tiers in order: `station_fao56`, `provider_hourly_sum` (`et0_source` `open_meteo_hourly_sum` | `meteoswiss_hourly_sum`), `hargreaves_station`. Each tier's daily result is clamped at 0 (the Java's `max(0, …)`); hourly rows stay as delivered. A daily radiation sum of 0 fails tier 1.
- Wind height is explicit: station `STATION_WIND_HEIGHT_M = 2`, providers 10 m; FAO-56 eq. 47 `u2 = uz × 4.87 / ln(67.8 z − 5.42)`. `windAt2m` returns null for a missing or non-positive height (no silent 2 m default), and `fao56Et0` then returns null. Radiation from lux with `LUX_PER_WM2 = 120`. Elevation: `gateway_locations.altitude_m`, else from the station's mean pressure `z = (293 / 0.0065) × (1 − (P_kPa / 101.3)^(1/5.26))`, else null (= 0 m in the formula).
- The JavaScript ET0 matches the cloud's Java: `rso = max(1e-4, (0.75 + 2e-5 z) Ra)`, `Rs/Rso` clamped to `[0.3, 1]`, null for a non-finite elevation, null when the denominator ≤ 0, Hargreaves checks the day of year. The Java is the reference wherever the two still differ.
- Completed local day = every hour of the day (23/24/25) with the tier's mandatory inputs non-null; MeteoSwiss days must be one `station_id`, a null `station_id` hour makes the day `unknown_station`. A zone with no coordinates (zone and gateway) gets `no_location` rows.
- Days: the 7 latest completed days plus any older day with no row or null `et0_mm`, bounded below by the oldest stored hour of any source and 92 days. Clock: skip the run when `now` is more than 24 h before the newest stored hour; on every valid run delete the zone's rows dated today or later (zone-local). A day that ended less than 3 h ago and is incomplete: `null_reason = 'pending'`.
- Kc snapshot frozen per row: initialised when `kc IS NOT NULL`; then `kc`, `kc_source`, `crop_type`, `phenological_stage` never change. `etc_mm = round(et0_mm × kc, 2)` computed in code. Upsert writes every column explicitly, `DO UPDATE ... WHERE` any stored value differs, `RETURNING zone_id` (daily) / `RETURNING deveui` (station hours); `written` counts returned rows, `unchanged = attempted − written`. One facade transaction per zone (daily) or per device (station hours).
- Inside a facade `transaction(executor)` only the scope argument is used, never the outer `db`: the facade runs every call through one queue and the open transaction holds it, so an outer call waits forever.
- Every file changed under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` is mirrored byte-for-byte to `conf/full_raspberrypi_bcm27xx_bcm2709/files/`. New function nodes stay under 1,500 chars, load helpers only through `osiLib.require`, and edit flows.json only by a one-shot script with the roundtrip guard.
- GUI: `npm ci` once in `web/react-gui` (installs, never builds); gates are `npm run test:unit` and `npm run typecheck` only. Tooltips use `web/react-gui/src/components/farming/shared/HelpTip.tsx`, never a `title` attribute; no captions or notes. New locale keys in en, de-CH, fr, it, es, pt, and English in lg, listed by hand in `tests/zoneFormLocales.test.ts` or `tests/waterCardLocales.test.ts` and in `docs/i18n/pending-luganda-translations.md`. The cloud's strings are reused verbatim: `environment.water.lastSevenDays`, `environment.water.tooltipDemand`, `environment.water.stationCredit`, `zone.water.rainFromStation`, `zone.water.rainFromWeather`, `zone.water.drivenByWaterBalanceFromWeather`, `zone.water.drivenByWaterBalanceFromStation`, and the cloud's `zone.waterReason.rainUnknown` / `demandUnknown` strings under the edge keys `zone.water.reason.rain_unknown` / `demand_unknown`. `environment.source.local` is not touched.
- Prose (docs, README, locale strings) passes `node .claude/skills/anti-slop-writing/slop-check.js`.

## Review Focus

1. **A station hour with samples but a null lux column** (S2120 frames without illumination): tier 1 must reject the day, tier 3 may accept it. Pinned in Task 7.
2. **A stage change after rows exist**: yesterday's row keeps its Kc; today's tile uses the new one. Pinned in Task 7 and Task 9.
3. **Offline across midnight**: today's demand is null, never yesterday's forecast. Pinned in Task 9.
4. **A clock that ran ahead for a day**: rows dated today or later are deleted on the next valid run; no future day survives. Pinned in Task 7.
5. **A legacy stage value arriving from the cloud (`veraison`) after the data migration**: read as `mid_season`, shown mapped in the selector, and not written back unless the user changes the stage. Pinned in Task 2 and Task 10.
6. **A MeteoSwiss day whose hours span a station change**: `mixed_station`, no value. Pinned in Task 7.
7. **Two ticks overlapping** (weather tick still running when the next fires): the chained nodes skip on `skipped: 'in_flight'` and the daily writer's own guard. Pinned in Task 7 and Task 8.
8. **A dead or covered light sensor reporting lux 0 all day**: the daily radiation sum is 0, tier 1 rejects the day, the provider tier or Hargreaves takes it; without the check tier 1 would write ET0 ≈ 0.17 mm. Pinned in Task 7.
9. **A station on a 60-minute uplink interval**: jitter leaves some hours without a sample, both station tiers reject such a day, the provider tier takes it, and without a provider the day is `partial_day` 23/24. Pinned in Task 5 and Task 7; Task 12 counts these days on the demo gateway.
10. **A zone with a null latitude and no gateway fix**: rows with `no_location`, never a guessed latitude; the tooltip says "no data (zone has no location)". Pinned in Task 7 and Task 11.

---

### Task 1: The agronomy contract directory

**Files:**
- Create: `docs/contracts/agronomy/README.md`, `docs/contracts/agronomy/crop-kc.json`, `docs/contracts/agronomy/kc-vectors.json`, `docs/contracts/agronomy/et0-vectors.json`
- Create: `scripts/build-kc-vectors.js` (generates `kc-vectors.json` from `crop-kc.json` and the rules; committed so the vectors are reproducible)
- Create: `scripts/verify-agronomy-contract.js` (byte parity of every copy; runs the vector files against the edge implementations once Tasks 2 and 6 exist)
- Scratch only (never committed): `/tmp/claude-1000/-home-phil-Repos-osi-os/79c61c41-97a5-40a5-97de-fe0acd82e63c/scratchpad/et0-java/` (Java reference run), `.../scratchpad/fao-t12.htm`, `.../scratchpad/cloud-crop-kc.json`
- The CI line for `verify-agronomy-contract.js` is not added here; Task 10 adds it once the GUI copy exists. Until then the verifier is run by hand and its `missing` lines are the expected output.

**Interfaces:**
- Produces: `crop-kc.json` = `{ version: 1, luxPerWm2: 120, stationWindHeightM: 2, stages: [{ id, order, label }], groups: [{ id, order, label, stageFamily }], crops: [{ id, group, label, kc_ini, kc_mid, kc_end, variant_of, fao_row }] }` with 136 crops; `kc-vectors.json` = `[{ cropType, phenologicalStage, kc, kcSource, cropId, stage }]`; `et0-vectors.json` = `{ provenance, fao56: [{ name, input: { tMinC, tMaxC, meanRhPct, windSpeedMs, windHeightM, solarRadMjM2, elevationM, latDeg, dayOfYear }, et0Mm }], fao56Rejects: [{ name, input, et0Mm: null }], hargreaves: [{ name, input: { tMinC, tMaxC, latDeg, dayOfYear }, et0Mm }], luxToRadiation: [{ lux, wm2 }], elevationFromPressure: [{ pressureKpa, elevationM }] }`.

- [ ] **Step 1: Extract the cloud's crop table (read-only)**

```bash
SCRATCH=/tmp/claude-1000/-home-phil-Repos-osi-os/79c61c41-97a5-40a5-97de-fe0acd82e63c/scratchpad
mkdir -p $SCRATCH
git -C <osi-server> show main:backend/src/main/java/org/osi/server/analytics/ZoneEnvironmentService.java | node -e "
const src=require('fs').readFileSync(0,'utf8');
const re=/Map\.entry\(\"([a-z_]+)\",\s*new double\[\]\{([\d.]+),\s*([\d.]+),\s*([\d.]+)\}\)/g; const out=[]; let m;
while((m=re.exec(src))) out.push({id:m[1],kc_ini:+m[2],kc_mid:+m[3],kc_end:+m[4]});
console.log(out.length); require('fs').writeFileSync('$SCRATCH/cloud-crop-kc.json', JSON.stringify(out,null,2));"
```
Expected: `56`. All 56 ids appear in the table of Step 2 (the table was checked against this list on 2026-09-26).

- [ ] **Step 2: Transcribe FAO-56 Table 12 with the row-to-id table**

Fetch the source: `curl -s https://www.fao.org/4/x0490e/x0490e0b.htm -o $SCRATCH/fao-t12.htm` and read Table 12 ("Single (time-averaged) crop coefficients, Kc, and mean maximum plant heights"). The agronomic decisions are already made; the transcriber writes the table below into `crop-kc.json` and cross-checks every number against the HTML. If a number in the HTML differs from the table below, stop and report; do not choose.

Traps in the HTML, each resolved in the table below:

1. **Initial Kc of a group.** The group header row carries the group's Kc ini, and about 60 leaf rows leave their ini cell empty and inherit it: a (small vegetables) 0.7, b (Solanum) 0.6, c (cucumber family) 0.5, d (roots and tubers) 0.5, e (legumes) 0.4, f (perennial vegetables) 0.5, g (fibre) 0.35, h (oil crops) 0.35, i (cereals) 0.3. The group header row itself is not an entry.
2. **Footnote digits glued to values.** Stripping tags naively turns a superscript into a digit: `1.052` = 1.05 (fn 2), `0.7018` = 0.70 (fn 18), `0.803` = 0.80 (fn 3), `0.754` = 0.75 (fn 4), `0.705` = 0.70 (fn 5), `0.957` = 0.95 (fn 7), `1.0512` = 1.05 (fn 12), `0.9513` = 0.95 (fn 13), `0.4014` = 0.40 (fn 14), `0.6525` = 0.65 (fn 25), `0.25-0.410` = 0.25–0.4 (fn 10), `0.60-0.3511` = 0.60–0.35 (fn 11), `1.0-1.159` = 1.0–1.15 (fn 9). The walnut row prints `0.6518` even with tags kept: 0.65 (fn 18).
3. **Range rows (14).** Resolved per row, reasons for the README: tomato end 0.70–0.90 → 0.70 (first value, the cloud's value); green gram and cowpeas end 0.60–0.35 → 0.35 (fn 6: second value is harvested dry, the grain crop); cotton mid 1.15–1.20 → 1.15 and end 0.70–0.50 → 0.70 (first values, the cloud's values); sisal mid 0.4–0.7 and end 0.4–0.7 → 0.40 (first value; fn 8 says it depends on density and managed stress); rapeseed, safflower, sunflower mid 1.0–1.15 → 1.15 (fn 9: the lower values are for rainfed crops with sparse stands, and these zones are irrigated); spring wheat, winter wheat on frozen soils, winter wheat on non-frozen soils end 0.25–0.4 → 0.25 (fn 10: the higher value is for hand-harvested crops); maize (field, grain) end 0.60–0.35 → 0.35 (fn 11: second value, harvest after field drying of the grain); sorghum (grain) mid 1.00–1.10 → 1.00 (first value, the cloud's value); rice end 0.90–0.60 → 0.90 (first value; the cloud's 0.75 is a midpoint of the range); rotated grazing pasture mid 0.85–1.05 → 0.85 (first value).
4. **Group p (open water).** The two "Open Water" rows have no Kc ini and are not crops; they are not transcribed (README says so). Group o (wetlands) is transcribed.
5. **Olives, fn 24.** The Spanish monthly Kc set in the footnote is not transcribed; `olive` uses the row (0.65/0.70/0.70).
6. **Rows backing several ids.** `pear` and `cherry` carry the "Apples, Cherries, Pears – no ground cover, killing frost" row; `plum` and `apricot` carry the "Apricots, Peaches, Stone Fruit – no ground cover, killing frost" row (fn 20 lists plums in the stone fruit category). They are default entries (`variant_of: null`); the ground-cover and frost variants exist once, under `apple` and `peach`.

Field rules: `id` as in the table; `group` = the table's group id; `label` as in the table; `kc_ini/kc_mid/kc_end` as in the table (two decimals in the JSON, e.g. `0.3`, `1.05`); `variant_of` as in the table (→ marks it), else `null`; `fao_row` = the row text with footnote markers removed, a sub-row joined to its parent with ` – ` (e.g. `"Apples, Cherries, Pears – no ground cover, killing frost"`, `"Maize, Field (grain) (field corn)"`), and `null` for the nine entries marked "(no row)", which keep the cloud's value and are listed in the README as "cloud value, not FAO-56".

Row-to-id table (136 entries; format `id` label ini/mid/end → variant_of):

| Group | Entries |
|---|---|
| `small_vegetables` | `broccoli` Broccoli 0.70/1.05/0.95; `brussels_sprouts` Brussels sprouts 0.70/1.05/0.95; `cabbage` Cabbage 0.70/1.05/0.95; `carrot` Carrot 0.70/1.05/0.95; `cauliflower` Cauliflower 0.70/1.05/0.95; `celery` Celery 0.70/1.05/1.00; `garlic` Garlic 0.70/1.00/0.70; `lettuce` Lettuce 0.70/1.00/0.95; `onion` Onion (dry) 0.70/1.05/0.75; `onion_green` Onion (green) 0.70/1.00/1.00 → `onion`; `onion_seed` Onion (seed) 0.70/1.05/0.80 → `onion`; `radish` Radish 0.70/0.90/0.85; `spinach` Spinach 0.70/1.00/0.95 |
| `vegetables_solanum` | `eggplant` Eggplant 0.60/1.05/0.90; `pepper` Sweet pepper 0.60/1.05/0.90; `tomato` Tomato 0.60/1.15/0.70 |
| `vegetables_cucumber` | `cantaloupe` Cantaloupe 0.50/0.85/0.60; `cucumber` Cucumber (fresh market) 0.60/1.00/0.75; `cucumber_machine_harvest` Cucumber (machine harvest) 0.50/1.00/0.90 → `cucumber`; `pumpkin` Pumpkin, winter squash 0.50/1.00/0.80; `sweet_melon` Sweet melon 0.50/1.05/0.75; `watermelon` Watermelon 0.40/1.00/0.75; `zucchini` Squash, zucchini 0.50/0.95/0.75 |
| `roots_tubers` | `cassava` Cassava (year 1) 0.30/0.80/0.30; `cassava_year_2` Cassava (year 2) 0.30/1.10/0.50 → `cassava`; `parsnip` Parsnip 0.50/1.05/0.95; `potato` Potato 0.50/1.15/0.75; `sugar_beet` Sugar beet 0.35/1.20/0.70; `sweet_potato` Sweet potato 0.50/1.15/0.65; `table_beet` Table beet 0.50/1.05/0.95; `turnip` Turnip, rutabaga 0.50/1.10/0.95 |
| `legumes` | `chickpea` Chickpea 0.40/1.00/0.35; `dry_bean` Dry bean, pulses 0.40/1.15/0.35; `faba_bean` Faba bean (fresh) 0.50/1.15/1.10; `faba_bean_dry` Faba bean (dry, seed) 0.50/1.15/0.30 → `faba_bean`; `garbanzo` Garbanzo 0.40/1.15/0.35; `green_bean` Green bean 0.50/1.05/0.90; `green_gram` Green gram, cowpea 0.40/1.05/0.35; `groundnut` Groundnut 0.40/1.15/0.60; `lentil` Lentil 0.40/1.10/0.30; `peas` Peas (fresh) 0.50/1.15/1.10; `peas_dry` Peas (dry, seed) 0.40/1.15/0.30 → `peas`; `soybean` Soybean 0.40/1.15/0.50 |
| `perennial_vegetables` | `artichoke` Artichoke 0.50/1.00/0.95; `asparagus` Asparagus 0.50/0.95/0.30; `mint` Mint 0.60/1.15/1.10; `strawberry` Strawberry 0.40/0.85/0.75 |
| `fibre` | `cotton` Cotton 0.35/1.15/0.70; `flax` Flax 0.35/1.10/0.25; `sisal` Sisal 0.35/0.40/0.40 |
| `oil_crops` | `castor_bean` Castor bean 0.35/1.15/0.55; `rapeseed` Rapeseed, canola 0.35/1.15/0.35; `safflower` Safflower 0.35/1.15/0.25; `sesame` Sesame 0.35/1.10/0.25; `sunflower` Sunflower 0.35/1.15/0.35 |
| `cereals` | `barley` Barley 0.30/1.15/0.25; `maize` Maize (grain) 0.30/1.20/0.35; `maize_sweet` Sweet corn 0.30/1.15/1.05 → `maize`; `millet` Millet 0.30/1.00/0.30; `oats` Oats 0.30/1.15/0.25; `rice` Rice 1.05/1.20/0.90; `sorghum` Sorghum (grain) 0.30/1.00/0.55; `sorghum_sweet` Sorghum (sweet) 0.30/1.20/1.05 → `sorghum`; `wheat` Wheat (spring) 0.30/1.15/0.25; `winter_wheat` Winter wheat (non-frozen soils) 0.70/1.15/0.25 → `wheat`; `winter_wheat_frozen` Winter wheat (frozen soils) 0.40/1.15/0.25 → `wheat` |
| `forages` | `alfalfa` Alfalfa hay (per cutting) 0.40/1.20/1.15; `alfalfa_averaged` Alfalfa hay (averaged cuttings) 0.40/0.95/0.90 → `alfalfa`; `alfalfa_seed` Alfalfa (seed) 0.40/0.50/0.50 → `alfalfa`; `bermuda` Bermuda grass hay 0.55/1.00/0.85; `bermuda_seed` Bermuda grass (seed) 0.35/0.90/0.65 → `bermuda`; `clover_hay` Clover hay, berseem (averaged cuttings) 0.40/0.90/0.85; `clover_hay_cutting` Clover hay, berseem (per cutting) 0.40/1.15/1.10 → `clover_hay`; `grass` Grass 0.90/1.00/1.00 (no row); `pasture_extensive` Pasture (extensive grazing) 0.30/0.75/0.75; `pasture_rotated` Pasture (rotated grazing) 0.40/0.85/0.85; `ryegrass_hay` Ryegrass hay 0.95/1.05/1.00; `sudan_grass` Sudan grass hay (averaged cuttings) 0.50/0.90/0.85; `sudan_grass_cutting` Sudan grass hay (per cutting) 0.50/1.15/1.10 → `sudan_grass`; `turf_cool` Turf grass (cool season) 0.90/0.95/0.95; `turf_warm` Turf grass (warm season) 0.80/0.85/0.85 |
| `sugar_cane` | `sugarcane` Sugarcane 0.40/1.25/0.75 |
| `tropical_fruits` | `banana` Banana (year 1) 0.50/1.10/1.00; `banana_year_2` Banana (year 2) 1.00/1.20/1.10 → `banana`; `cocoa` Cocoa 1.00/1.05/1.05; `coffee` Coffee (bare ground) 0.90/0.95/0.95; `coffee_with_weeds` Coffee (with weeds) 1.05/1.10/1.10 → `coffee`; `date_palm` Date palm 0.90/0.95/0.95; `mango` Mango 0.60/1.05/0.75 (no row); `palm` Palm trees 0.95/1.00/1.00; `papaya` Papaya 0.60/1.05/0.90 (no row); `pineapple` Pineapple (bare soil) 0.50/0.30/0.30; `pineapple_grass_cover` Pineapple (grass cover) 0.50/0.50/0.50 → `pineapple`; `rubber` Rubber trees 0.95/1.00/1.00; `tea` Tea (non-shaded) 0.95/1.00/1.00; `tea_shaded` Tea (shaded) 1.10/1.15/1.15 → `tea` |
| `grapes_berries` | `berries` Berries (bushes) 0.30/1.05/0.50; `blueberry` Blueberry 0.40/0.85/0.60 (no row); `grapes_table` Grapes (table, raisin) 0.30/0.85/0.45 → `grapevine`; `grapevine` Grapevine (wine) 0.30/0.70/0.45; `hops` Hops 0.30/1.05/0.85; `raspberry` Raspberry 0.40/1.05/0.85 (no row) |
| `fruit_trees` | `almond` Almond 0.40/0.90/0.65; `apple` Apple 0.45/0.95/0.70; `apple_cover_frost` Apple (active ground cover, killing frost) 0.50/1.20/0.95 → `apple`; `apple_cover_no_frost` Apple (active ground cover, no frost) 0.80/1.20/0.85 → `apple`; `apple_no_cover_no_frost` Apple (no ground cover, no frost) 0.60/0.95/0.75 → `apple`; `apricot` Apricot 0.45/0.90/0.65; `avocado` Avocado 0.60/0.85/0.75; `cherry` Cherry 0.45/0.95/0.70; `citrus` Citrus (70 % canopy, no ground cover) 0.70/0.65/0.70; `citrus_20_cover` Citrus (20 % canopy, active ground cover) 0.85/0.85/0.85 → `citrus`; `citrus_20_no_cover` Citrus (20 % canopy, no ground cover) 0.50/0.45/0.55 → `citrus`; `citrus_50_cover` Citrus (50 % canopy, active ground cover) 0.80/0.80/0.80 → `citrus`; `citrus_50_no_cover` Citrus (50 % canopy, no ground cover) 0.65/0.60/0.65 → `citrus`; `citrus_70_cover` Citrus (70 % canopy, active ground cover) 0.75/0.70/0.75 → `citrus`; `conifer` Conifer trees 1.00/1.00/1.00; `fig` Fig 0.50/1.15/0.85 (no row); `hazelnut` Hazelnut 0.45/1.05/0.65 (no row); `kiwi` Kiwi 0.40/1.05/1.05; `olive` Olive (40 to 60 % ground cover) 0.65/0.70/0.70; `peach` Peach 0.45/0.90/0.65; `peach_cover_frost` Peach (active ground cover, killing frost) 0.50/1.15/0.90 → `peach`; `peach_cover_no_frost` Peach (active ground cover, no frost) 0.80/1.15/0.85 → `peach`; `peach_no_cover_no_frost` Peach (no ground cover, no frost) 0.55/0.90/0.65 → `peach`; `pear` Pear 0.45/0.95/0.70; `pecan` Pecan 0.50/1.10/0.65 (no row); `pistachio` Pistachio 0.40/1.10/0.45; `plum` Plum 0.45/0.90/0.65; `pomegranate` Pomegranate 0.50/0.90/0.75 (no row); `walnut` Walnut 0.50/1.10/0.65 |
| `wetlands` | `cattails_frost` Cattails, bulrushes (killing frost) 0.30/1.20/0.30; `cattails_no_frost` Cattails, bulrushes (no frost) 0.60/1.20/0.60; `reed_swamp_moist_soil` Reed swamp (moist soil) 0.90/1.20/0.70; `reed_swamp_standing_water` Reed swamp (standing water) 1.00/1.20/1.00; `short_vegetation_wetland` Short vegetation (no frost) 1.05/1.10/1.10 |

Cloud values replaced by the table (Phil's decision to adopt the FAO-56 values fully; each gets a "corrected from cloud" line in the README): `grapevine` 0.30/0.85/0.45 → 0.30/0.70/0.45 (the cloud used the table-grape row; `grapevine` is wine grapes); `pear`, `cherry` 0.45/1.20/0.85 → 0.45/0.95/0.70; `peach`, `plum` 0.45/1.20/0.85 → 0.45/0.90/0.65; `apricot` 0.45/1.10/0.65 → 0.45/0.90/0.65; `pistachio` 0.40/1.00/0.45 → 0.40/1.10/0.45; `cabbage` 0.45/1.05/0.90 → 0.70/1.05/0.95; `wheat` 0.30/1.15/0.30 → 0.30/1.15/0.25; `rice` 1.05/1.20/0.75 → 1.05/1.20/0.90; `sunflower` 0.35/1.10/0.35 → 0.35/1.15/0.35; `coffee` 0.90/0.95/0.90 → 0.90/0.95/0.95; `bermuda` 0.55/0.85/0.75 → 0.55/1.00/0.85 (the cloud's triple matches no row). Cloud values kept without a row (`fao_row: null`, "cloud value, not FAO-56"): `fig`, `pomegranate`, `blueberry`, `raspberry`, `hazelnut`, `pecan` (fn 20 puts pecans in the stone fruit category; kept as the cloud's value until the agronomist decides), `mango`, `papaya`, `grass`. `berries` is a new default id, not a cloud id.

Top-level arrays of `crop-kc.json`:

```json
"stages": [
  { "id": "initial", "order": 1, "label": "Initial" },
  { "id": "development", "order": 2, "label": "Crop development" },
  { "id": "mid_season", "order": 3, "label": "Mid-season" },
  { "id": "late_season", "order": 4, "label": "Late season" },
  { "id": "dormancy", "order": 5, "label": "Dormancy" }
],
"groups": [
  { "id": "small_vegetables", "order": 1, "label": "Small vegetables", "stageFamily": "annual" },
  { "id": "vegetables_solanum", "order": 2, "label": "Tomato family", "stageFamily": "annual" },
  { "id": "vegetables_cucumber", "order": 3, "label": "Cucumber family", "stageFamily": "annual" },
  { "id": "roots_tubers", "order": 4, "label": "Roots and tubers", "stageFamily": "annual" },
  { "id": "legumes", "order": 5, "label": "Legumes", "stageFamily": "annual" },
  { "id": "perennial_vegetables", "order": 6, "label": "Perennial vegetables", "stageFamily": "annual" },
  { "id": "fibre", "order": 7, "label": "Fibre crops", "stageFamily": "annual" },
  { "id": "oil_crops", "order": 8, "label": "Oil crops", "stageFamily": "annual" },
  { "id": "cereals", "order": 9, "label": "Cereals", "stageFamily": "annual" },
  { "id": "forages", "order": 10, "label": "Forages", "stageFamily": "annual" },
  { "id": "sugar_cane", "order": 11, "label": "Sugarcane", "stageFamily": "annual" },
  { "id": "tropical_fruits", "order": 12, "label": "Tropical fruits and trees", "stageFamily": "annual" },
  { "id": "grapes_berries", "order": 13, "label": "Grapes and berries", "stageFamily": "woody" },
  { "id": "fruit_trees", "order": 14, "label": "Fruit trees", "stageFamily": "woody" },
  { "id": "wetlands", "order": 15, "label": "Wetlands", "stageFamily": "annual" }
]
```
`stageFamily` is `woody` for fruit trees, vines, berries, olives, citrus and hops (the two groups that hold them) and `annual` for everything else. Write `crop-kc.json` with 2-space indentation and a trailing newline, keys in the order of the Interfaces line, crops sorted by group order then id. Check the count: `node -e "console.log(require('./docs/contracts/agronomy/crop-kc.json').crops.length)"` prints `136`.

- [ ] **Step 3: Write the README**

`docs/contracts/agronomy/README.md` sections, in this order:
1. What the directory is: the single source; copies at `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json`, its bcm2709 mirror, `web/react-gui/src/agronomy/crop-kc.json`, and later osi-server; `scripts/verify-agronomy-contract.js` checks bytes and runs the vectors.
2. Stage vocabulary with the legacy mapping table (Global Constraints) and the two label families (`woody`, `annual`).
3. Kc rules (Global Constraints).
4. Variant defaults with reasons: `grapevine` = wine grapes; `apple`, `pear`, `cherry` = no ground cover, killing frost; `peach`, `plum`, `apricot` = stone fruit, no ground cover, killing frost; `citrus` = 70 % canopy, no ground cover; `olive` = 40 to 60 % ground cover (fn 24 monthly set not transcribed); `berries` = bushes; `alfalfa` = per cutting period (the cloud's value); `bermuda`, `clover_hay`, `sudan_grass` = averaged cuttings; `onion` = dry; `cucumber` = fresh market; `peas`, `faba_bean` = fresh; `cassava`, `banana` = year 1; `coffee` = bare ground; `pineapple` = bare soil; `tea` = non-shaded; `sorghum` = grain; `maize` = grain; `wheat` = spring wheat.
5. Transcription notes: the group-level Kc ini inheritance, the glued-footnote list and the excluded open-water rows (Step 2 traps 1, 2, 4).
6. "Range rows": the 14 resolutions of Step 2 trap 3 with their footnote reasons.
7. "Deviations from Table 12": one "corrected from cloud" line per replaced cloud value (the 13 ids of Step 2) and one "cloud value, not FAO-56" line per entry without a row (the 9 ids).
8. Constants: `luxPerWm2 = 120` (global daylight luminous efficacy is 95 to 130 lm/W, Littlefair 1985, Perez 1990; 120 may under-read by 5 to 10 %; provisional until the demo gateway's calibration of Task 12) and `stationWindHeightM = 2`.
9. ET0 formulas by FAO-56 equation number (6, 7, 47, 52), the two clamps (`Rso ≥ 1e-4`, `Rs/Rso` in `[0.3, 1]`), the day-level clamp at 0, and the vapour pressure rule: `ea` from mean relative humidity, as the cloud does. FAO-56 Example 18 (Brussels) derives `ea = 1.409 kPa` from RHmax/RHmin and gets 3.88 mm/day; the mean-RH method gives `ea = 1.468 kPa` and 3.79 mm/day. The 0.09 mm gap is the RH method, and the vector pins the cloud's 3.79.
10. Regeneration: `node scripts/build-kc-vectors.js`; the ET0 vectors' provenance (Step 6).

Run `node .claude/skills/anti-slop-writing/slop-check.js docs/contracts/agronomy/README.md`; expected `slop-check: PASS`.

- [ ] **Step 4: Generate the Kc vectors**

`scripts/build-kc-vectors.js`:
```js
#!/usr/bin/env node
'use strict';
// Regenerates docs/contracts/agronomy/kc-vectors.json from crop-kc.json and
// the Kc rules in the README. The edge helper and the GUI both run the
// result; it is the executable form of the contract.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'docs', 'contracts', 'agronomy');
const catalogue = JSON.parse(fs.readFileSync(path.join(dir, 'crop-kc.json'), 'utf8'));
const HEURISTIC = { initial: 0.45, development: 0.70, mid_season: 0.90, late_season: 0.60, dormancy: 0.25, unset: 0.75 };
const LEGACY = { budbreak: 'initial', bud_break: 'initial', fruitset: 'development', cell_division: 'development', cell_expansion: 'development', veraison: 'mid_season', fruit_maturation: 'mid_season', harvest: 'late_season', post_harvest: 'late_season', dormancy: 'dormancy' };
const STAGES = ['initial', 'development', 'mid_season', 'late_season', 'dormancy'];
function round2(v) { return Math.round(v * 100) / 100; }
function normalizeStage(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (STAGES.includes(s)) return s;
  return LEGACY[s] || null;
}
function resolve(cropType, stageIn) {
  const stage = normalizeStage(stageIn);
  const id = String(cropType == null ? '' : cropType).trim().toLowerCase();
  const crop = catalogue.crops.find((c) => c.id === id);
  if (!crop) return { kc: HEURISTIC[stage || 'unset'], kcSource: 'heuristic_phenology', cropId: null, stage };
  let kc; let kcSource = 'fao56_crop';
  if (stage === 'initial') kc = crop.kc_ini;
  else if (stage === 'development') kc = (crop.kc_ini + crop.kc_mid) / 2;
  else if (stage === 'mid_season') kc = crop.kc_mid;
  else if (stage === 'late_season') kc = crop.kc_end;
  else if (stage === 'dormancy') kc = 0.25;
  else { kc = crop.kc_mid; kcSource = 'fao56_crop_stage_unset'; }
  return { kc: round2(kc), kcSource, cropId: crop.id, stage };
}
const vectors = [];
for (const crop of catalogue.crops) {
  for (const stage of [...STAGES, null, 'default', 'budbreak', 'veraison']) {
    vectors.push({ cropType: crop.id, phenologicalStage: stage, ...resolve(crop.id, stage) });
  }
}
for (const cropType of ['other', 'unknown_crop', null, '']) {
  for (const stage of [...STAGES, null, 'harvest']) vectors.push({ cropType, phenologicalStage: stage, ...resolve(cropType, stage) });
}
fs.writeFileSync(path.join(dir, 'kc-vectors.json'), JSON.stringify(vectors, null, 2) + '\n');
console.log('kc-vectors:', vectors.length);
```
Run: `node scripts/build-kc-vectors.js`. Expected: `kc-vectors: 1252` (136 × 9 + 4 × 7).

- [ ] **Step 5: Run the cloud's Java offline in the scratchpad**

```bash
S=/tmp/claude-1000/-home-phil-Repos-osi-os/79c61c41-97a5-40a5-97de-fe0acd82e63c/scratchpad/et0-java
mkdir -p $S/src/org/osi/server/analytics
git -C <osi-server> show main:backend/src/main/java/org/osi/server/analytics/WeatherMath.java > $S/src/org/osi/server/analytics/WeatherMath.java
```
Write `$S/src/org/osi/server/analytics/Dump.java` (same package, because `WeatherMath` and its methods are package-private):
```java
package org.osi.server.analytics;

public final class Dump {
    // The 10 m wind that equals a wind measured at heightM (FAO-56 eq. 47 twice);
    // the Java takes a 10 m wind only.
    static double to10m(double speed, double heightM) {
        double u2 = Math.abs(heightM - 2.0) < 1e-9 ? speed : speed * 4.87 / Math.log(67.8 * heightM - 5.42);
        return u2 * Math.log(67.8 * 10.0 - 5.42) / 4.87;
    }
    static String num(Double v) { return v == null ? "null" : Double.toString(v); }
    static void fao(String name, double tMin, double tMax, double rh, double wind, double height, double rs, Double elev, double lat, int doy) {
        Double v = WeatherMath.fao56Et0(tMin, tMax, rh, to10m(wind, height), rs, elev, lat, doy);
        System.out.println("{\"name\":\"" + name + "\",\"input\":{\"tMinC\":" + tMin + ",\"tMaxC\":" + tMax + ",\"meanRhPct\":" + rh
            + ",\"windSpeedMs\":" + wind + ",\"windHeightM\":" + height + ",\"solarRadMjM2\":" + rs + ",\"elevationM\":" + (elev == null ? "null" : elev.toString())
            + ",\"latDeg\":" + lat + ",\"dayOfYear\":" + doy + "},\"java\":" + num(v) + "}");
    }
    static void harg(String name, double tMin, double tMax, double lat, int doy) {
        Double v = WeatherMath.hargreavesEt0(tMin, tMax, lat, doy);
        System.out.println("{\"name\":\"" + name + "\",\"input\":{\"tMinC\":" + tMin + ",\"tMaxC\":" + tMax + ",\"latDeg\":" + lat + ",\"dayOfYear\":" + doy + "},\"java\":" + num(v) + "}");
    }
    public static void main(String[] args) {
        fao("brussels_example_18", 12.3, 21.5, 73.5, 2.78, 10, 22.07, 100.0, 50.8, 187);
        fao("payerne_summer", 14, 29, 60, 1.5, 2, 27, 490.0, 46.81, 200);
        fao("payerne_winter", -2, 4, 85, 2.0, 10, 3.5, 490.0, 46.81, 15);
        fao("payerne_winter_rs_1", -2, 4, 85, 2.0, 10, 1.0, 490.0, 46.81, 15);
        fao("payerne_winter_rs_0", -2, 4, 85, 2.0, 10, 0.0, 490.0, 46.81, 15);
        fao("lat70_doy355_rs_0", -8, -3, 80, 3.0, 10, 0.0, 50.0, 70.0, 355);
        fao("kampala", 18, 29, 70, 1.2, 2, 20, 1190.0, 0.35, 100);
        fao("null_elevation", 14, 29, 60, 1.5, 2, 27, null, 46.81, 200);
        fao("zero_wind", 14, 29, 60, 0.0, 2, 27, 490.0, 46.81, 200);
        fao("wind_10m", 14, 29, 60, 3.0, 10, 27, 490.0, 46.81, 200);
        fao("wind_2m_equivalent", 14, 29, 60, 3.0 * 4.87 / Math.log(67.8 * 10 - 5.42), 2, 27, 490.0, 46.81, 200);
        fao("rs_above_rso", 14, 29, 60, 1.5, 2, 35, 490.0, 46.81, 200);
        fao("tmax_equals_tmin", 20, 20, 60, 1.5, 2, 15, 490.0, 46.81, 200);
        fao("rh_100", 14, 29, 100, 1.5, 2, 27, 490.0, 46.81, 200);
        fao("rh_100_wind_0", 14, 29, 100, 0.0, 2, 27, 490.0, 46.81, 200);
        fao("rh_0", 14, 29, 0, 1.5, 2, 27, 490.0, 46.81, 200);
        harg("payerne_summer", 14, 29, 46.81, 200);
        harg("payerne_winter", -2, 4, 46.81, 15);
        harg("kampala", 18, 29, 0.35, 100);
        harg("brussels", 12.3, 21.5, 50.8, 187);
        harg("tmax_equals_tmin", 20, 20, 46.81, 200);
        harg("lat70_doy355", -8, -3, 70.0, 355);
    }
}
```
Run:
```bash
cd $S && javac -d out src/org/osi/server/analytics/*.java && java -cp out org.osi.server.analytics.Dump > java-out.jsonl && cat java-out.jsonl
```
Expected: 22 lines; the first is `brussels_example_18 … "java":3.787436030198268`. Rounded to 2 decimals the FAO-56 values are 3.79, 5.29, 0.39, 0.27, 0.17, 0.25, 4.18, 5.23, 4.59, 5.58, 5.58, 6.62, 3.48, 4.42, 5.07, 5.78 and the Hargreaves values 5.71, 0.47, 4.77, 4.06, 0, 0 (checked 2026-09-26 against `osi-server` main `92d96d23`). The Brussels input is FAO-56 Example 18's wind of 10 km/h (2.78 m/s) measured at 10 m. The three dark-day cases (`payerne_winter_rs_1`, `payerne_winter_rs_0`, `lat70_doy355_rs_0`) have `Rs/Rso` below 0.3, where the Java's floor applies. `git -C <osi-server> status --short` must print nothing new.

- [ ] **Step 6: Write `et0-vectors.json`**

```bash
cd <osi-os>/.worktrees/daily-agronomy
node -e "
const fs=require('fs');
const rows=fs.readFileSync('$S/java-out.jsonl','utf8').trim().split('\n').map(JSON.parse);
const r2=(v)=>v==null?null:Math.round(v*100)/100;
const base={tMinC:14,tMaxC:29,meanRhPct:60,windSpeedMs:1.5,windHeightM:2,solarRadMjM2:27,elevationM:490,latDeg:46.81,dayOfYear:200};
const reject=(name,over)=>({name,input:{...base,...over},et0Mm:null});
const out={
  provenance:'Values from osi-server main 92d96d23 WeatherMath.fao56Et0 and hargreavesEt0, run offline with javac 17 on 2026-09-26 (Dump.java in the plan, Task 1 Step 5); a wind at another height was converted to the 10 m value the Java takes; outputs rounded to 2 decimals. fao56Rejects are contract rules, not Java output.',
  fao56:rows.filter((r)=>'meanRhPct' in r.input).map((r)=>({name:r.name,input:r.input,et0Mm:r2(r.java)})),
  fao56Rejects:[reject('tmax_below_tmin',{tMinC:20,tMaxC:10}),reject('rh_101',{meanRhPct:101}),reject('negative_wind',{windSpeedMs:-1}),reject('wind_height_missing',{windHeightM:null}),reject('wind_height_zero',{windHeightM:0}),reject('negative_radiation',{solarRadMjM2:-1}),reject('day_0',{dayOfYear:0}),reject('day_367',{dayOfYear:367})],
  hargreaves:rows.filter((r)=>!('meanRhPct' in r.input)).map((r)=>({name:r.name,input:r.input,et0Mm:r2(r.java)})),
  luxToRadiation:[{lux:0,wm2:0},{lux:120,wm2:1},{lux:100000,wm2:833.33}],
  elevationFromPressure:[{pressureKpa:101.3,elevationM:0},{pressureKpa:95.64,elevationM:490.04},{pressureKpa:88.002,elevationM:1190.01}]
};
fs.writeFileSync('docs/contracts/agronomy/et0-vectors.json', JSON.stringify(out,null,2)+'\n');
console.log(out.fao56.length, out.fao56Rejects.length, out.hargreaves.length);"
```
Expected: `16 8 6`.

- [ ] **Step 7: The verifier**

`scripts/verify-agronomy-contract.js`:
```js
#!/usr/bin/env node
'use strict';
// verify-agronomy-contract: docs/contracts/agronomy is the source; every copy
// must be byte-identical, and the edge modules must reproduce the vectors.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs', 'contracts', 'agronomy');
const source = fs.readFileSync(path.join(dir, 'crop-kc.json'));
const copies = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'web/react-gui/src/agronomy/crop-kc.json',
];
const failures = [];
for (const rel of copies) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { failures.push(rel + ': missing'); continue; }
  if (Buffer.compare(fs.readFileSync(abs), source) !== 0) failures.push(rel + ': differs from docs/contracts/agronomy/crop-kc.json');
}
const catalogue = JSON.parse(source.toString('utf8'));
const groups = new Set((catalogue.groups || []).map((g) => g.id));
for (const g of catalogue.groups || []) if (!['woody', 'annual'].includes(g.stageFamily)) failures.push('group ' + g.id + ': stageFamily must be woody or annual');
const ids = new Set();
for (const crop of catalogue.crops) {
  if (ids.has(crop.id)) failures.push('duplicate crop id ' + crop.id);
  ids.add(crop.id);
  if (!groups.has(crop.group)) failures.push(crop.id + ': unknown group ' + crop.group);
  for (const k of ['kc_ini', 'kc_mid', 'kc_end']) if (!(crop[k] > 0 && crop[k] < 2)) failures.push(crop.id + ': ' + k + ' out of range');
  if (crop.variant_of && !catalogue.crops.some((c) => c.id === crop.variant_of && c.group === crop.group && !c.variant_of)) failures.push(crop.id + ': variant_of must name a default entry of the same group');
}
if (catalogue.crops.length !== 136) failures.push('expected 136 crops, found ' + catalogue.crops.length);
const kcModulePath = path.join(root, copies[0], '..', 'index.js');
if (fs.existsSync(kcModulePath)) {
  const kc = require(kcModulePath);
  const vectors = JSON.parse(fs.readFileSync(path.join(dir, 'kc-vectors.json'), 'utf8'));
  let bad = 0;
  for (const v of vectors) {
    const r = kc.resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage });
    if (r.kc !== v.kc || r.kcSource !== v.kcSource || r.cropId !== v.cropId || r.stage !== v.stage) { bad += 1; if (bad <= 5) failures.push('kc vector mismatch: ' + JSON.stringify(v) + ' got ' + JSON.stringify(r)); }
  }
  if (bad > 5) failures.push('kc vector mismatches: ' + bad);
}
const et0ModulePath = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js');
if (fs.existsSync(et0ModulePath)) {
  const et0 = require(et0ModulePath);
  const vectors = JSON.parse(fs.readFileSync(path.join(dir, 'et0-vectors.json'), 'utf8'));
  const near = (got, want, tol) => (want == null ? got === null : typeof got === 'number' && Math.abs(got - want) <= tol);
  for (const v of [...vectors.fao56, ...vectors.fao56Rejects]) {
    const got = et0.fao56Et0(v.input);
    if (!near(got, v.et0Mm, 0.005)) failures.push('fao56 vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
  }
  for (const v of vectors.hargreaves) {
    const got = et0.hargreavesEt0(v.input);
    if (!near(got, v.et0Mm, 0.005)) failures.push('hargreaves vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
  }
  for (const v of vectors.luxToRadiation) {
    const got = et0.luxToWm2(v.lux, catalogue.luxPerWm2);
    if (!near(got, v.wm2, 0.01)) failures.push('lux vector ' + v.lux + ': expected ' + v.wm2 + ' got ' + got);
  }
  for (const v of vectors.elevationFromPressure) {
    const got = et0.elevationFromPressure(v.pressureKpa);
    if (!near(got, v.elevationM, 0.05)) failures.push('pressure vector ' + v.pressureKpa + ': expected ' + v.elevationM + ' got ' + got);
  }
}
if (failures.length) { console.error('verify-agronomy-contract: FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('verify-agronomy-contract: OK (' + catalogue.crops.length + ' crops, copies byte-identical, vectors reproduced where implementations exist)');
```

- [ ] **Step 8: Run the verifier and commit**

Run: `node scripts/verify-agronomy-contract.js`
Expected: exit 1 with exactly three lines, all `…: missing` (the two edge copies and the GUI copy). No CI line is added in this task.

```bash
git add docs/contracts/agronomy scripts/build-kc-vectors.js scripts/verify-agronomy-contract.js
git commit -m "feat(agronomy): FAO-56 crop catalogue, stage vocabulary and vector files as a contract"
```

---

### Task 2: `osi-crop-kc` helper

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/{package.json,index.js,index.test.js,crop-kc.json}` (the JSON is a byte copy of the contract: `cp docs/contracts/agronomy/crop-kc.json conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json`)
- Modify (registration): node-red `package.json` + `package-lock.json`, `osi-lib/index.js`, `osi-lib/index.test.js`, `etc/uci-defaults/98_osi_node_red_seed`, `deploy.sh`, `.github/workflows/migrations.yml`
- Mirror all of the above to bcm2709

**Interfaces:**
- Produces: `resolveKc({ cropType, phenologicalStage }) → { kc, kcSource, cropId, stage }`, `normalizeStage(value) → 'initial'|'development'|'mid_season'|'late_season'|'dormancy'|null`, `STAGES`, `catalogue` (the parsed JSON), `cropById(id) → crop|null`.

- [ ] **Step 1: Failing tests** (`index.test.js`)

```js
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const kc = require('./index');
const REPO = path.resolve(__dirname, '../../../../../../..');
const vectors = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/contracts/agronomy/kc-vectors.json'), 'utf8'));

test('normalizeStage accepts FAO keys, maps legacy keys, treats default/unknown/null as unset', () => {
  for (const s of ['initial', 'development', 'mid_season', 'late_season', 'dormancy']) assert.equal(kc.normalizeStage(s), s);
  assert.equal(kc.normalizeStage(' Mid_Season '), 'mid_season');
  assert.equal(kc.normalizeStage('budbreak'), 'initial');
  assert.equal(kc.normalizeStage('bud_break'), 'initial');
  assert.equal(kc.normalizeStage('fruitset'), 'development');
  assert.equal(kc.normalizeStage('cell_expansion'), 'development');
  assert.equal(kc.normalizeStage('veraison'), 'mid_season');
  assert.equal(kc.normalizeStage('harvest'), 'late_season');
  assert.equal(kc.normalizeStage('post_harvest'), 'late_season');
  assert.equal(kc.normalizeStage('default'), null);
  assert.equal(kc.normalizeStage(null), null);
  assert.equal(kc.normalizeStage('flowering'), null);
});

test('resolveKc reproduces every contract vector', () => {
  for (const v of vectors) {
    assert.deepEqual(kc.resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage }), { kc: v.kc, kcSource: v.kcSource, cropId: v.cropId, stage: v.stage }, JSON.stringify(v));
  }
});

test('resolveKc: maize by stage, unset stage, unknown crop, dormancy; grapevine is the wine row', () => {
  assert.deepEqual(kc.resolveKc({ cropType: 'maize', phenologicalStage: 'mid_season' }), { kc: 1.2, kcSource: 'fao56_crop', cropId: 'maize', stage: 'mid_season' });
  assert.equal(kc.resolveKc({ cropType: 'maize', phenologicalStage: 'development' }).kc, 0.75);
  assert.deepEqual(kc.resolveKc({ cropType: 'maize', phenologicalStage: 'default' }), { kc: 1.2, kcSource: 'fao56_crop_stage_unset', cropId: 'maize', stage: null });
  assert.deepEqual(kc.resolveKc({ cropType: 'other', phenologicalStage: 'mid_season' }), { kc: 0.9, kcSource: 'heuristic_phenology', cropId: null, stage: 'mid_season' });
  assert.equal(kc.resolveKc({ cropType: 'apple', phenologicalStage: 'dormancy' }).kc, 0.25);
  assert.equal(kc.resolveKc({ cropType: 'grapevine', phenologicalStage: 'veraison' }).kc, 0.7);
  assert.equal(kc.cropById('grapevine').variant_of, null);
  assert.equal(kc.cropById('grapes_table').variant_of, 'grapevine');
  assert.equal(kc.catalogue.crops.length, 136);
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/index.test.js`
Expected: `Cannot find module './index'` (the file does not exist yet).

- [ ] **Step 3: Implement**

`package.json`:
```json
{
  "name": "osi-crop-kc",
  "version": "1.0.0",
  "private": true,
  "main": "index.js"
}
```

`index.js`:
```js
'use strict';
// osi-crop-kc: the FAO-56 crop coefficient resolver. crop-kc.json here is a
// byte copy of docs/contracts/agronomy/crop-kc.json (verify-agronomy-contract).
const catalogue = require('./crop-kc.json');

const STAGES = Object.freeze(['initial', 'development', 'mid_season', 'late_season', 'dormancy']);
const LEGACY = Object.freeze({
  budbreak: 'initial', bud_break: 'initial',
  fruitset: 'development', cell_division: 'development', cell_expansion: 'development',
  veraison: 'mid_season', fruit_maturation: 'mid_season',
  harvest: 'late_season', post_harvest: 'late_season',
  dormancy: 'dormancy',
});
const HEURISTIC = Object.freeze({ initial: 0.45, development: 0.70, mid_season: 0.90, late_season: 0.60, dormancy: 0.25, unset: 0.75 });
const byId = new Map(catalogue.crops.map((crop) => [crop.id, crop]));

function round2(value) { return Math.round(value * 100) / 100; }

function normalizeStage(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (STAGES.includes(s)) return s;
  return LEGACY[s] || null;
}

function cropById(id) {
  return byId.get(String(id == null ? '' : id).trim().toLowerCase()) || null;
}

function resolveKc({ cropType, phenologicalStage }) {
  const stage = normalizeStage(phenologicalStage);
  const crop = cropById(cropType);
  if (!crop) return { kc: HEURISTIC[stage || 'unset'], kcSource: 'heuristic_phenology', cropId: null, stage };
  let kc;
  let kcSource = 'fao56_crop';
  if (stage === 'initial') kc = crop.kc_ini;
  else if (stage === 'development') kc = (crop.kc_ini + crop.kc_mid) / 2;
  else if (stage === 'mid_season') kc = crop.kc_mid;
  else if (stage === 'late_season') kc = crop.kc_end;
  else if (stage === 'dormancy') kc = 0.25;
  else { kc = crop.kc_mid; kcSource = 'fao56_crop_stage_unset'; }
  return { kc: round2(kc), kcSource, cropId: crop.id, stage };
}

module.exports = { catalogue, STAGES, normalizeStage, cropById, resolveKc };
```

- [ ] **Step 4: Run the tests and the verifier**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/index.test.js`
Expected: `# pass 3`.
Run: `node scripts/verify-agronomy-contract.js`
Expected: exit 1 with two `missing` lines (the bcm2709 copy until Step 6, and the GUI copy until Task 10); no `kc vector mismatch` line.

- [ ] **Step 5: Register on every delivery surface**

1. `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`: add `"osi-crop-kc": "file:osi-crop-kc",` in alphabetical position among the `osi-*` dependencies.
2. `package-lock.json` in the same directory: write `$SCRATCH/register-lock.js` and run `node $SCRATCH/register-lock.js osi-crop-kc` from the worktree root:
```js
'use strict';
// Adds a file: helper package to the node-red package-lock.json (bcm2712), keeping key order.
const fs = require('fs');
const name = process.argv[2];
if (!/^osi-[a-z0-9-]+$/.test(name || '')) throw new Error('usage: register-lock.js osi-<name>');
const file = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json';
function insertSorted(obj, key, value) {
  const out = {};
  let placed = false;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) continue;
    if (!placed && k !== '' && k > key) { out[key] = value; placed = true; }
    out[k] = v;
  }
  if (!placed) out[key] = value;
  return out;
}
const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
lock.packages[''].dependencies = insertSorted(lock.packages[''].dependencies, name, 'file:' + name);
lock.packages = insertSorted(lock.packages, 'node_modules/' + name, { resolved: name, link: true });
lock.packages = insertSorted(lock.packages, name, { version: '1.0.0' });
fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
console.log('registered', name);
```
3. `osi-lib/index.js`: add `'crop-kc': 'osi-crop-kc',` to `NAME_TO_PATH`.
4. `osi-lib/index.test.js`: the registered-names list is compared with `Object.keys(NAME_TO_PATH).sort()`; insert `'crop-kc',` between `'chirpstack',` and `'dendro-analytics',` (`'crop-kc'` sorts before `'dendro-analytics'`). Add `assert.equal(osiLib.NAME_TO_PATH['crop-kc'], 'osi-crop-kc');` next to the `weather-provider` assertion.
5. `etc/uci-defaults/98_osi_node_red_seed` line 42: append ` osi-crop-kc` to the `for module in ...` list, before `; do`.
6. `deploy.sh`: after the `osi-weather-provider index.js` block (around line 1406), add:
```bash
fetch_required "osi-crop-kc package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/package.json" \
    "/srv/node-red/osi-crop-kc/package.json"

fetch_required "osi-crop-kc index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/index.js" \
    "/srv/node-red/osi-crop-kc/index.js"

fetch_required "osi-crop-kc crop-kc.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json" \
    "/srv/node-red/osi-crop-kc/crop-kc.json"
```
7. `.github/workflows/migrations.yml`: after the `osi-weather-provider/facade-contract.test.js` line (98) add `      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/index.test.js`.

- [ ] **Step 6: Mirror, gates, commit**

```bash
P=conf/full_raspberrypi_bcm27xx_bcm2712/files; M=conf/full_raspberrypi_bcm27xx_bcm2709/files
rsync -a --delete $P/usr/share/node-red/osi-crop-kc/ $M/usr/share/node-red/osi-crop-kc/
for f in usr/share/node-red/package.json usr/share/node-red/package-lock.json usr/share/node-red/osi-lib/index.js usr/share/node-red/osi-lib/index.test.js etc/uci-defaults/98_osi_node_red_seed; do cp $P/$f $M/$f; done
node scripts/verify-helper-registration.js && node scripts/verify-module-file-deploy-coverage.js && node scripts/verify-profile-parity.js
node --test $P/usr/share/node-red/osi-lib/index.test.js
node scripts/verify-agronomy-contract.js
```
Expected: `All helper-registration checks passed.`; deploy coverage OK; `All parity checks passed.`; osi-lib tests pass; the verifier prints one line, `web/react-gui/src/agronomy/crop-kc.json: missing`.
```bash
git add $P/usr/share/node-red/osi-crop-kc $M/usr/share/node-red/osi-crop-kc $P/usr/share/node-red/package.json $P/usr/share/node-red/package-lock.json $M/usr/share/node-red/package.json $M/usr/share/node-red/package-lock.json $P/usr/share/node-red/osi-lib $M/usr/share/node-red/osi-lib $P/etc/uci-defaults/98_osi_node_red_seed $M/etc/uci-defaults/98_osi_node_red_seed deploy.sh .github/workflows/migrations.yml
git commit -m "feat(crop-kc): FAO-56 crop coefficient resolver as an edge helper"
```

---

### Task 3: Migrations 0061 and 0062, seeds, contract, runner pin

**Files:**
- Create: `database/migrations/ordered/0061__daily_agronomy.sql`, `database/migrations/ordered/0062__fao56_stage_keys.sql`
- Modify: `database/migrations/ordered/CHECKSUMS.json`, `database/seed-blank.sql`, `scripts/verify-db-schema-consistency.js` (`schemaContract`), `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js` (line 62 title "through 0062", line 77 list `[22, 23, 24, 25, 30, 54, 55, 56, 57, 58, 59, 60, 61, 62]`), the 7 bundled DBs (via `build-seed-db.js`), `docs/operations/edge-history-retention.md`

- [ ] **Step 1: Write 0061**

```sql
-- risk: additive
-- 0061: daily agronomy record (spec 2026-09-26-daily-agronomy-design): the
-- Kc snapshot and provenance columns on zone_daily_agronomy, the MeteoSwiss
-- station per provider hour, and the local weather station hourly aggregates.
-- et0_tier: 'station_fao56' | 'provider_hourly_sum' | 'hargreaves_station'.
-- et0_station_id: the station deveui for a station tier, the MeteoSwiss
-- station id for a MeteoSwiss provider day, NULL for Open-Meteo.
-- null_reason: 'no_source' | 'partial_day' | 'mixed_station' |
-- 'unknown_station' | 'pending' | 'no_location'.

ALTER TABLE zone_daily_agronomy ADD COLUMN crop_type TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN phenological_stage TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN et0_tier TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN et0_station_id TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN location_key TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN hours_present INTEGER;
ALTER TABLE zone_daily_agronomy ADD COLUMN expected_hours INTEGER;
ALTER TABLE zone_daily_agronomy ADD COLUMN null_reason TEXT;

ALTER TABLE weather_provider_hours ADD COLUMN station_id TEXT;

CREATE TABLE IF NOT EXISTS weather_station_hours (
  deveui                TEXT NOT NULL REFERENCES devices(deveui) ON DELETE CASCADE,
  hour_start            TEXT NOT NULL,
  air_temperature_c     REAL,
  air_temperature_min_c REAL,
  air_temperature_max_c REAL,
  relative_humidity_pct REAL,
  wind_speed_mps        REAL,
  pressure_hpa          REAL,
  light_lux             REAL,
  global_radiation_wm2  REAL,
  rain_mm               REAL,
  sample_count          INTEGER NOT NULL,
  computed_at           TEXT NOT NULL,
  PRIMARY KEY (deveui, hour_start)
);
```

- [ ] **Step 2: Write 0062**

```sql
-- risk: data
-- 0062__fao56_stage_keys.sql: legacy vine-flavoured stage keys become FAO-56
-- growth stages. Only live rows whose normalised value changes are touched,
-- and each of those gets a new sync_version and updated_at, because the zone
-- outbox trigger emits ZONE_CONFIG_UPSERTED for a stage change and the cloud
-- rejects a changed payload that carries a version it already holds.
UPDATE irrigation_zones
   SET phenological_stage = CASE lower(trim(phenological_stage))
         WHEN 'budbreak' THEN 'initial' WHEN 'bud_break' THEN 'initial'
         WHEN 'fruitset' THEN 'development' WHEN 'cell_division' THEN 'development' WHEN 'cell_expansion' THEN 'development'
         WHEN 'veraison' THEN 'mid_season' WHEN 'fruit_maturation' THEN 'mid_season'
         WHEN 'harvest' THEN 'late_season' WHEN 'post_harvest' THEN 'late_season'
       END,
       sync_version = sync_version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE lower(trim(COALESCE(phenological_stage,''))) IN
       ('budbreak','bud_break','fruitset','cell_division','cell_expansion','veraison','fruit_maturation','harvest','post_harvest')
   AND deleted_at IS NULL;
```

- [ ] **Step 3: Seed parity**

In `database/seed-blank.sql`: append the eight columns to `CREATE TABLE IF NOT EXISTS zone_daily_agronomy` after `computed_at` in 0061's order (`crop_type TEXT`, `phenological_stage TEXT`, `et0_tier TEXT`, `et0_station_id TEXT`, `location_key TEXT`, `hours_present INTEGER`, `expected_hours INTEGER`, `null_reason TEXT`); `station_id TEXT` after `fetched_at` in `weather_provider_hours`; and the `weather_station_hours` table of Step 1 after `zone_daily_agronomy`, under a banner comment in the file's style (`-- ---…`, `-- weather_station_hours`, `-- ---…`). The seed's `phenological_stage` default on `irrigation_zones` stays `'default'`.

- [ ] **Step 4: Checksums, bundled DBs, contract, runner pin, retention doc**

```bash
node -e "
const fs=require('fs'),crypto=require('crypto'),p='database/migrations/ordered/';
const m={};for(const f of fs.readdirSync(p).filter(f=>f.endsWith('.sql')).sort()){m[f]=crypto.createHash('sha256').update(fs.readFileSync(p+f)).digest('hex');}
fs.writeFileSync(p+'CHECKSUMS.json',JSON.stringify(m,null,2)+'\n');console.log(Object.keys(m).length,'entries');"
node scripts/build-seed-db.js
sqlite3 database/farming.db "SELECT MAX(version) FROM schema_migrations"
```
Expected: `62 entries`; one line per bundled DB path; `62`.

In `scripts/verify-db-schema-consistency.js` `schemaContract`: `zone_daily_agronomy` (line 972) gains `'crop_type', 'phenological_stage', 'et0_tier', 'et0_station_id', 'location_key', 'hours_present', 'expected_hours', 'null_reason'` after `'computed_at'`; `weather_provider_hours` (line 961) gains `'station_id'` after `'fetched_at'`; add after `zone_daily_agronomy`:
```js
  weather_station_hours: [
    'deveui', 'hour_start', 'air_temperature_c', 'air_temperature_min_c', 'air_temperature_max_c',
    'relative_humidity_pct', 'wind_speed_mps', 'pressure_hpa', 'light_lux', 'global_radiation_wm2',
    'rain_mm', 'sample_count', 'computed_at',
  ],
```
Bump the runner test pin (Files line). In `docs/operations/edge-history-retention.md` add two paragraphs: `zone_daily_agronomy` (one row per zone and local day, 365 rows per zone per year, unbounded, not synced) and `weather_station_hours` (one row per assigned station and hour, 8,760 per station per year, unbounded, not synced).

- [ ] **Step 5: Gates**

```bash
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-db-schema-consistency.js && node scripts/verify-seed-db-ledger.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-profile-parity.js && node scripts/test-journal-schema.js
node --test lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js
node .claude/skills/anti-slop-writing/slop-check.js docs/operations/edge-history-retention.md
```
Expected: every OK line (ledger at head 62), the pinned test 2/2, `slop-check: PASS`.

- [ ] **Step 6: Commit**

```bash
git add database lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js scripts/verify-db-schema-consistency.js docs/operations/edge-history-retention.md $(node -e "console.log(require('./scripts/seed-db-paths.js').SEED_DB_RELATIVE_PATHS.join(' '))")
git commit -m "feat(schema): daily agronomy snapshot columns, station hours, MeteoSwiss station per hour; FAO-56 stage key migration (0061, 0062)"
```
`SEED_DB_RELATIVE_PATHS` lists the seven bundled databases; `git status --short` afterwards shows none of them.

---

### Task 4: `osi-weather-provider` extensions

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/index.js`, `index.test.js`; mirror both to bcm2709.

**Interfaces:**
- Produces: `zoneLocations(db, deploymentDefault) → Promise<[{ zone: { id, timezone, crop_type, phenological_stage, gateway_device_eui }, provider: 'open_meteo'|'meteoswiss'|null, locationKey: string|null, latitude, longitude, timezone }]>`: every live zone with coordinates (zone, else gateway), coordinates rounded to 2 decimals, ordered by zone id; a zone with `weather_source = 'local'` has `provider: null, locationKey: null`; a zone with no coordinates is absent. `runTick` uses it and skips entries whose `provider` is null. MeteoSwiss rows carry `station_id`; the gap lookback treats a MeteoSwiss hour with a null `station_id` as missing.

- [ ] **Step 1: Failing tests** (append to `index.test.js`; `scratchDb`, `seedZone`, `meteoSwissDeps` exist in the file)

```js
test('zoneLocations returns every zone with coordinates, ordered by id; local zones carry no provider', async () => {
  const db = scratchDb();
  seedZone(db, { id: 2, name: 'B', lat: 46.7996, lon: 6.9501 });
  seedZone(db, { id: 1, name: 'A', lat: 46.8004, lon: 6.9499, weatherSource: 'meteoswiss' });
  seedZone(db, { id: 3, name: 'C', lat: 46.81, lon: 6.96, weatherSource: 'local' });
  seedZone(db, { id: 4, name: 'D', lat: null, lon: null });
  const rows = await wp.zoneLocations(db, 'open_meteo');
  assert.deepEqual(rows.map((r) => [r.zone.id, r.provider, r.locationKey, r.latitude, r.longitude]), [
    [1, 'meteoswiss', 'meteoswiss:46.80:6.95', 46.8, 6.95],
    [2, 'open_meteo', 'open_meteo:46.80:6.95', 46.8, 6.95],
    [3, null, null, 46.81, 6.96],
  ]);
  assert.equal(rows[0].zone.timezone, 'Europe/Zurich');
  assert.equal(rows[0].timezone, 'Europe/Zurich');
});

test('runTick stores station_id on MeteoSwiss hours and refetches an hour that lacks it', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'ms', lat: 46.8, lon: 6.95 });
  const key = 'meteoswiss:46.80:6.95';
  await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'meteoswiss', deps: { requestJson: async () => { throw new Error('no'); }, ...meteoSwissDeps([]) }, warn: () => {} });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM weather_provider_hours WHERE station_id = 'PAY'").get().n, db.raw.prepare('SELECT COUNT(*) AS n FROM weather_provider_hours').get().n);
  // The fixtures leave 2026-09-24T20:00-22:00 empty, which alone would move the
  // gap window back. Fill those hours so the null-station hour is the only gap.
  const fill = db.raw.prepare("INSERT INTO weather_provider_hours (location_key, hour_start, air_temperature_c, station_id, fetched_at) VALUES (?, ?, 15, 'PAY', '2026-09-25T15:20:00Z')");
  for (const h of ['2026-09-24T20:00:00Z', '2026-09-24T21:00:00Z', '2026-09-24T22:00:00Z']) fill.run(key, h);
  db.raw.prepare("UPDATE weather_provider_hours SET station_id = NULL WHERE hour_start = '2026-09-25T10:00:00Z'").run();
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:50:00Z', deploymentDefault: 'meteoswiss', deps: { requestJson: async () => { throw new Error('no'); }, ...meteoSwissDeps([]) }, warn: () => {} });
  assert.equal(summary.stored, 5, 'hours 10:00 to 14:00: the null-station hour moved the window back from 11:00');
  assert.equal(db.raw.prepare("SELECT station_id FROM weather_provider_hours WHERE hour_start = '2026-09-25T10:00:00Z'").get().station_id, 'PAY');
});
```
Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/index.test.js`. Expected: 2 failures (`wp.zoneLocations is not a function`; the second fails on `no such column: station_id` if Task 3 is missing, otherwise on `stored` 4 ≠ 5).

- [ ] **Step 2: Implement**

`ZONE_SQL` selects `iz.id, iz.latitude, iz.longitude, iz.timezone, iz.weather_source, iz.crop_type, iz.phenological_stage, iz.gateway_device_eui, gl.latitude AS gateway_latitude, gl.longitude AS gateway_longitude` (same FROM/JOIN/WHERE/ORDER BY). Add:
```js
async function zoneLocations(db, deploymentDefault) {
  const zones = await db.all(ZONE_SQL, []);
  const out = [];
  for (const zone of zones) {
    const coords = zoneCoordinates(zone);
    if (!coords) continue;
    const provider = resolveProvider(zone.weather_source, deploymentDefault);
    const timezone = String(zone.timezone || 'UTC').trim() || 'UTC';
    out.push({
      zone: { id: zone.id, timezone, crop_type: zone.crop_type == null ? null : zone.crop_type, phenological_stage: zone.phenological_stage == null ? null : zone.phenological_stage, gateway_device_eui: zone.gateway_device_eui || null },
      provider,
      locationKey: provider ? locationKey(provider, coords.latitude, coords.longitude) : null,
      latitude: Number(fixed2(coords.latitude)),
      longitude: Number(fixed2(coords.longitude)),
      timezone,
    });
  }
  return out;
}
```
In `runTickOnce` replace the zone loop with:
```js
  for (const entry of await zoneLocations(db, deploymentDefault)) {
    if (!entry.provider) continue;
    summary.zones += 1;
    if (!locations.has(entry.locationKey)) {
      locations.set(entry.locationKey, { key: entry.locationKey, provider: entry.provider, latitude: entry.latitude, longitude: entry.longitude, timezone: entry.timezone });
    }
  }
```
`UPSERT_HOUR_SQL` gains `station_id` as the tenth column (`VALUES (?, …, ?)` with ten placeholders; `station_id = excluded.station_id` in the update list); the call site passes `location.provider === 'meteoswiss' && result.station ? result.station.id : null` after `nowIso`. The gap query becomes:
```js
      const have = await db.all('SELECT hour_start FROM weather_provider_hours WHERE location_key = ? AND hour_start >= ? AND hour_start < ?' + (location.provider === 'meteoswiss' ? ' AND station_id IS NOT NULL' : ''), [location.key, lookbackStart, window.toUtc]);
```
Export `zoneLocations`.

- [ ] **Step 3: Tests, mirror, commit**

```bash
P=conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider
node --test $P/index.test.js && node --test $P/facade-contract.test.js
cp $P/index.js $P/index.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider/
node scripts/verify-profile-parity.js
git add $P conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider
git commit -m "feat(weather-provider): zoneLocations export, station provenance per hour"
```
Expected: `# pass 54`, the facade test passes, parity OK.

---

### Task 5: `osi-station-hours` helper

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-station-hours/{package.json,index.js,index.test.js,facade-contract.test.js}`
- Modify (registration): node-red `package.json` + `package-lock.json`, `osi-lib/index.js` (`'station-hours': 'osi-station-hours'`), `osi-lib/index.test.js`, `98_osi_node_red_seed`, `deploy.sh`, `.github/workflows/migrations.yml`; mirror all to bcm2709

**Interfaces:**
- Consumes: `require('../osi-weather-provider').hourStartIso` (returns the `…:00Z` form, e.g. `2026-09-25T13:00:00Z`), `require('../osi-crop-kc').catalogue.luxPerWm2`.
- Produces: `aggregateStationHours({ db, nowIso, warn }) → { devices, hours, written, unchanged }`; `hourlyAggregate(rows) → { air_temperature_c, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, pressure_hpa, light_lux, global_radiation_wm2, rain_mm, sample_count }` (pure; null for a field with no non-null sample; an hourly mean of lux is the W/m² mean because samples are evenly spaced). `weather_station_hours.hour_start` is stored in the `…:00Z` form, the same form as `weather_provider_hours.hour_start`; `device_data.recorded_at` is compared with bounds in the `…:00.000Z` form it is stored in.

- [ ] **Step 1: Failing tests** (`index.test.js`)

```js
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const sh = require('./index');

const REPO = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO, 'database/seed-blank.sql'), 'utf8');

// Same shape the flow node passes; inside transaction() only the scope may be
// used (the facade would deadlock on the outer db), so the outer calls throw.
function scratchDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  let inTx = false;
  const scope = {
    all: async (sql, params) => raw.prepare(sql).all(...(params || [])),
    run: async (sql, params) => { raw.prepare(sql).run(...(params || [])); },
  };
  const guard = () => { if (inTx) throw new Error('outer db used inside transaction()'); };
  return {
    raw,
    all: async (sql, params) => { guard(); return scope.all(sql, params); },
    run: async (sql, params) => { guard(); return scope.run(sql, params); },
    transaction: async (fn) => {
      raw.exec('BEGIN IMMEDIATE');
      inTx = true;
      try { const result = await fn(scope); raw.exec('COMMIT'); return result; } catch (error) { raw.exec('ROLLBACK'); throw error; } finally { inTx = false; }
    },
  };
}

function seedZone(db, id) {
  db.raw.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-09-25T00:00:00Z') ON CONFLICT DO NOTHING").run();
  db.raw.prepare("INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, zone_uuid) VALUES (?, 1, ?, 46.8, 6.95, 'Europe/Zurich', ?)").run(id, 'Z' + id, '00000000-0000-4000-8000-' + String(id).padStart(12, '0'));
}

// devices: deveui, name, type_id, created_at and updated_at are NOT NULL (seed-blank.sql, CREATE TABLE devices).
function seedStation(db, deveui, zoneId) {
  db.raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES (?, ?, 'SENSECAP_S2120', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')").run(deveui, 'S2120 ' + deveui.slice(-4));
  if (zoneId != null) db.raw.prepare('INSERT INTO weather_station_zones (deveui, zone_id) VALUES (?, ?)').run(deveui, zoneId);
}

function sample(db, deveui, recordedAt, t, lux) {
  db.raw.prepare('INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity, wind_speed_mps, barometric_pressure_hpa, light_lux, rain_mm_delta) VALUES (?, ?, ?, 50, 1, 960, ?, 0)').run(deveui, recordedAt, t, lux);
}

function hours(db) {
  return db.raw.prepare('SELECT hour_start, air_temperature_c, sample_count FROM weather_station_hours ORDER BY hour_start').all().map((r) => ({ ...r }));
}

test('hourlyAggregate: means, min/max, sums, counts; a field with no sample is null', () => {
  const rows = [
    { ambient_temperature: 20, relative_humidity: 60, wind_speed_mps: 1.0, barometric_pressure_hpa: 960, light_lux: 12000, rain_mm_delta: 0.2 },
    { ambient_temperature: 22, relative_humidity: 50, wind_speed_mps: 2.0, barometric_pressure_hpa: 962, light_lux: null, rain_mm_delta: null },
    { ambient_temperature: null, relative_humidity: 55, wind_speed_mps: null, barometric_pressure_hpa: null, light_lux: 24000, rain_mm_delta: 0.3 },
  ];
  assert.deepEqual(sh.hourlyAggregate(rows), {
    air_temperature_c: 21, air_temperature_min_c: 20, air_temperature_max_c: 22,
    relative_humidity_pct: 55, wind_speed_mps: 1.5, pressure_hpa: 961,
    light_lux: 18000, global_radiation_wm2: 150, rain_mm: 0.5, sample_count: 3,
  });
  assert.equal(sh.hourlyAggregate([{ ambient_temperature: 20 }]).light_lux, null);
  assert.equal(sh.hourlyAggregate([{ ambient_temperature: 20 }]).global_radiation_wm2, null);
});

test('aggregateStationHours writes one row per assigned station and completed UTC hour, idempotently', async () => {
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  for (const [ts, t, lux] of [['2026-09-25T13:05:00.000Z', 20, 10000], ['2026-09-25T13:35:00.000Z', 22, 30000], ['2026-09-25T14:10:00.000Z', 23, 40000], ['2026-09-25T15:05:00.000Z', 24, 50000]]) sample(db, 'S2120AAAA00000001', ts, t, lux);
  const first = await sh.aggregateStationHours({ db, nowIso: '2026-09-25T15:20:00Z', warn: () => {} });
  assert.deepEqual(first, { devices: 1, hours: 2, written: 2, unchanged: 0 }); // 15:00 is in progress
  assert.deepEqual(hours(db), [{ hour_start: '2026-09-25T13:00:00Z', air_temperature_c: 21, sample_count: 2 }, { hour_start: '2026-09-25T14:00:00Z', air_temperature_c: 23, sample_count: 1 }]);
  const computedAt = db.raw.prepare("SELECT computed_at FROM weather_station_hours WHERE hour_start = '2026-09-25T13:00:00Z'").get().computed_at;
  const second = await sh.aggregateStationHours({ db, nowIso: '2026-09-25T15:25:00Z', warn: () => {} });
  assert.deepEqual(second, { devices: 1, hours: 2, written: 0, unchanged: 2 });
  assert.equal(db.raw.prepare("SELECT computed_at FROM weather_station_hours WHERE hour_start = '2026-09-25T13:00:00Z'").get().computed_at, computedAt);
});

test('aggregateStationHours ignores stations assigned to no zone and hours with no sample', async () => {
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedStation(db, 'S2120BBBB00000002', null);
  sample(db, 'S2120AAAA00000001', '2026-09-25T13:05:00.000Z', 20, 1000);
  sample(db, 'S2120AAAA00000001', '2026-09-25T15:05:00.000Z', 22, 1000);
  sample(db, 'S2120BBBB00000002', '2026-09-25T13:05:00.000Z', 20, 1000);
  const summary = await sh.aggregateStationHours({ db, nowIso: '2026-09-25T16:20:00Z', warn: () => {} });
  assert.deepEqual(summary, { devices: 1, hours: 2, written: 2, unchanged: 0 });
  assert.deepEqual(hours(db).map((r) => r.hour_start), ['2026-09-25T13:00:00Z', '2026-09-25T15:00:00Z']);
});

test('a sample exactly on the hour belongs to that hour (bounds in the .000Z form of recorded_at)', async () => {
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  sample(db, 'S2120AAAA00000001', '2026-09-25T13:00:00.000Z', 20, 1000);
  sample(db, 'S2120AAAA00000001', '2026-09-25T14:00:00.000Z', 30, 1000);
  await sh.aggregateStationHours({ db, nowIso: '2026-09-25T15:20:00Z', warn: () => {} });
  assert.deepEqual(hours(db), [{ hour_start: '2026-09-25T13:00:00Z', air_temperature_c: 20, sample_count: 1 }, { hour_start: '2026-09-25T14:00:00Z', air_temperature_c: 30, sample_count: 1 }]);
});

test('a station on a 60-minute uplink leaves an hour without a row when jitter skips it', async () => {
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  for (const ts of ['2026-09-25T12:58:00.000Z', '2026-09-25T14:02:00.000Z', '2026-09-25T14:58:00.000Z']) sample(db, 'S2120AAAA00000001', ts, 20, 1000);
  const summary = await sh.aggregateStationHours({ db, nowIso: '2026-09-25T16:10:00Z', warn: () => {} });
  assert.equal(summary.hours, 2);
  assert.deepEqual(hours(db).map((r) => [r.hour_start, r.sample_count]), [['2026-09-25T12:00:00Z', 1], ['2026-09-25T14:00:00Z', 2]]);
});

test('an unaggregated hour older than 48 h but within 7 days is picked up; older samples are not', async () => {
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  sample(db, 'S2120AAAA00000001', '2026-09-23T03:10:00.000Z', 18, 0);   // 60 h before now
  sample(db, 'S2120AAAA00000001', '2026-09-16T03:10:00.000Z', 18, 0);   // 228 h before now
  await sh.aggregateStationHours({ db, nowIso: '2026-09-25T15:20:00Z', warn: () => {} });
  assert.deepEqual(hours(db).map((r) => r.hour_start), ['2026-09-23T03:00:00Z']);
});
```
Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-station-hours/index.test.js`. Expected: `Cannot find module './index'`.

- [ ] **Step 2: Implement**

`package.json`: as Task 2's with `"name": "osi-station-hours"`. `index.js`:
```js
'use strict';
// osi-station-hours: hourly aggregates of local weather station uplinks
// (SenseCAP S2120) for the daily agronomy writer. Spec:
// docs/superpowers/specs/2026-09-26-daily-agronomy-design.md, component 3.
// hour_start is stored as hourStartIso gives it ('…:00Z'), the form of
// weather_provider_hours; device_data.recorded_at is '…:00.000Z', so every
// bound compared with it is built with Date#toISOString().
const { hourStartIso } = require('../osi-weather-provider');
const { catalogue } = require('../osi-crop-kc');

const HOUR_MS = 3600000;
const RECENT_HOURS = 48;
const LOOKBACK_HOURS = 168;
const LUX_PER_WM2 = catalogue.luxPerWm2;

const STATIONS_SQL = "SELECT DISTINCT d.deveui FROM devices d JOIN weather_station_zones w ON w.deveui = d.deveui WHERE d.type_id = 'SENSECAP_S2120' AND d.deleted_at IS NULL ORDER BY d.deveui";
const SAMPLES_SQL = 'SELECT recorded_at, ambient_temperature, relative_humidity, wind_speed_mps, barometric_pressure_hpa, light_lux, rain_mm_delta FROM device_data WHERE deveui = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at';
const COLUMNS = ['air_temperature_c', 'air_temperature_min_c', 'air_temperature_max_c', 'relative_humidity_pct', 'wind_speed_mps', 'pressure_hpa', 'light_lux', 'global_radiation_wm2', 'rain_mm', 'sample_count'];
const UPSERT_SQL =
  'INSERT INTO weather_station_hours (deveui, hour_start, ' + COLUMNS.join(', ') + ', computed_at) VALUES (?, ?, ' + COLUMNS.map(() => '?').join(', ') + ', ?) ' +
  'ON CONFLICT(deveui, hour_start) DO UPDATE SET ' + COLUMNS.map((c) => c + ' = excluded.' + c).join(', ') + ', computed_at = excluded.computed_at ' +
  'WHERE ' + COLUMNS.map((c) => 'weather_station_hours.' + c + ' IS NOT excluded.' + c).join(' OR ') + ' ' +
  'RETURNING deveui';

function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
function round(v, decimals) { if (!finite(v)) return null; const f = 10 ** decimals; return Math.round(v * f) / f; }
function values(rows, key) { return rows.map((r) => r[key]).filter(finite); }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

function hourlyAggregate(rows) {
  const temps = values(rows, 'ambient_temperature');
  const rain = values(rows, 'rain_mm_delta');
  const lux = mean(values(rows, 'light_lux'));
  return {
    air_temperature_c: round(mean(temps), 2),
    air_temperature_min_c: temps.length ? round(Math.min(...temps), 2) : null,
    air_temperature_max_c: temps.length ? round(Math.max(...temps), 2) : null,
    relative_humidity_pct: round(mean(values(rows, 'relative_humidity')), 1),
    wind_speed_mps: round(mean(values(rows, 'wind_speed_mps')), 2),
    pressure_hpa: round(mean(values(rows, 'barometric_pressure_hpa')), 1),
    light_lux: round(lux, 0),
    global_radiation_wm2: lux == null ? null : round(lux / LUX_PER_WM2, 2),
    rain_mm: rain.length ? round(rain.reduce((a, b) => a + b, 0), 2) : null,
    sample_count: rows.length,
  };
}

// The window: the last 48 hours, moved back to the first hour of the last
// 7 days that has samples but no row (spec, component 3).
async function windowStartMs(db, deveui, currentHourMs) {
  const recentMs = currentHourMs - RECENT_HOURS * HOUR_MS;
  const lookbackMs = currentHourMs - LOOKBACK_HOURS * HOUR_MS;
  const sampled = await db.all('SELECT recorded_at FROM device_data WHERE deveui = ? AND recorded_at >= ? AND recorded_at < ?', [deveui, new Date(lookbackMs).toISOString(), new Date(recentMs).toISOString()]);
  if (!sampled.length) return recentMs;
  const stored = new Set((await db.all('SELECT hour_start FROM weather_station_hours WHERE deveui = ? AND hour_start >= ? AND hour_start < ?', [deveui, hourStartIso(new Date(lookbackMs)), hourStartIso(new Date(recentMs))])).map((r) => r.hour_start));
  let first = null;
  for (const row of sampled) {
    const hour = hourStartIso(row.recorded_at);
    if (hour && !stored.has(hour) && (!first || hour < first)) first = hour;
  }
  return first ? Date.parse(first) : recentMs;
}

async function aggregateStationHours({ db, nowIso, warn }) {
  const say = typeof warn === 'function' ? warn : () => {};
  const summary = { devices: 0, hours: 0, written: 0, unchanged: 0 };
  const currentHourMs = Math.floor(Date.parse(nowIso) / HOUR_MS) * HOUR_MS;
  for (const { deveui } of await db.all(STATIONS_SQL, [])) {
    summary.devices += 1;
    try {
      const startMs = await windowStartMs(db, deveui, currentHourMs);
      const samples = await db.all(SAMPLES_SQL, [deveui, new Date(startMs).toISOString(), new Date(currentHourMs).toISOString()]);
      const byHour = new Map();
      for (const s of samples) {
        const hour = hourStartIso(s.recorded_at);
        if (!hour) continue;
        if (!byHour.has(hour)) byHour.set(hour, []);
        byHour.get(hour).push(s);
      }
      const rows = [...byHour.entries()].map(([hour, list]) => [hour, hourlyAggregate(list)]);
      await db.transaction(async (tx) => {
        // Only `tx` inside the executor: the facade's queue is held by this transaction.
        for (const [hour, agg] of rows) {
          const returned = await tx.all(UPSERT_SQL, [deveui, hour, ...COLUMNS.map((c) => agg[c]), nowIso]);
          summary.hours += 1;
          summary.written += returned.length;
          summary.unchanged += 1 - returned.length;
        }
      });
    } catch (error) {
      say(deveui + ': ' + (error && error.message ? error.message : error));
    }
  }
  return summary;
}

module.exports = { hourlyAggregate, aggregateStationHours };
```
Run the tests. Expected: `# pass 6`.

- [ ] **Step 3: Facade-contract test**

`facade-contract.test.js` is a port of `osi-weather-provider/facade-contract.test.js`. Deltas:
- `const sh = require('./index');` instead of `wp`; the header comment names `aggregateStationHours` and `station-hours-fn`.
- `sqlite3Adapter()` and `loadOsiDbHelper()` copied verbatim.
- The seed inserts a user, zone 1, a `SENSECAP_S2120` device `S2120AAAA00000001` (`created_at`, `updated_at` set), its `weather_station_zones` row, and two `device_data` samples at `2026-09-25T13:05:00.000Z` and `2026-09-25T14:10:00.000Z`.
- The client is the node's shape: `{ all: (sql, params) => Promise.resolve(db.all(sql, params || [])), run: (sql, params) => Promise.resolve(db.run(sql, params || [])).then(() => undefined), transaction: (fn) => db.transaction(fn) }`.
- The call is `await sh.aggregateStationHours({ db: client, nowIso: '2026-09-25T15:20:00Z', warn: () => {} })`; assert `{ devices: 1, hours: 2, written: 2, unchanged: 0 }`, then a second call returns `written: 0, unchanged: 2` (the `RETURNING` rows reach the caller through the facade's `all`), then `SELECT COUNT(*) FROM weather_station_hours` = 2.

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-station-hours/facade-contract.test.js`. Expected: `# pass 1`.

- [ ] **Step 4: Register on every delivery surface**

1. node-red `package.json`: `"osi-station-hours": "file:osi-station-hours",` in alphabetical position.
2. `package-lock.json`: `node $SCRATCH/register-lock.js osi-station-hours` (the script's code is in Task 2 Step 5; write it again if the scratchpad was cleared).
3. `osi-lib/index.js`: `'station-hours': 'osi-station-hours',` in `NAME_TO_PATH`.
4. `osi-lib/index.test.js`: insert `'station-hours',` between `'sdi12-recipe',` and `'uc512-normalize',`; add `assert.equal(osiLib.NAME_TO_PATH['station-hours'], 'osi-station-hours');`.
5. `98_osi_node_red_seed` line 42: append ` osi-station-hours` before `; do`.
6. `deploy.sh`, after the `osi-crop-kc crop-kc.json` block:
```bash
fetch_required "osi-station-hours package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-station-hours/package.json" \
    "/srv/node-red/osi-station-hours/package.json"

fetch_required "osi-station-hours index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-station-hours/index.js" \
    "/srv/node-red/osi-station-hours/index.js"
```
7. `.github/workflows/migrations.yml`, after the `osi-crop-kc` line:
```yaml
      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-station-hours/index.test.js
      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-station-hours/facade-contract.test.js
```

- [ ] **Step 5: Mirror, gates, commit**

```bash
P=conf/full_raspberrypi_bcm27xx_bcm2712/files; M=conf/full_raspberrypi_bcm27xx_bcm2709/files
rsync -a --delete $P/usr/share/node-red/osi-station-hours/ $M/usr/share/node-red/osi-station-hours/
for f in usr/share/node-red/package.json usr/share/node-red/package-lock.json usr/share/node-red/osi-lib/index.js usr/share/node-red/osi-lib/index.test.js etc/uci-defaults/98_osi_node_red_seed; do cp $P/$f $M/$f; done
node scripts/verify-helper-registration.js && node scripts/verify-module-file-deploy-coverage.js && node scripts/verify-profile-parity.js && node --test $P/usr/share/node-red/osi-lib/index.test.js
git add $P/usr/share/node-red/osi-station-hours $M/usr/share/node-red/osi-station-hours $P/usr/share/node-red/package.json $P/usr/share/node-red/package-lock.json $M/usr/share/node-red/package.json $M/usr/share/node-red/package-lock.json $P/usr/share/node-red/osi-lib $M/usr/share/node-red/osi-lib $P/etc/uci-defaults/98_osi_node_red_seed $M/etc/uci-defaults/98_osi_node_red_seed deploy.sh .github/workflows/migrations.yml
git commit -m "feat(station-hours): hourly aggregates from local weather stations"
```

---

### Task 6: ET0 mathematics (`osi-agronomy-daily/et0.js`)

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/{package.json,et0.js,et0.test.js}` (`index.js` comes in Task 7; registration happens there)

**Interfaces:**
- Produces: `fao56Et0({ tMinC, tMaxC, meanRhPct, windSpeedMs, windHeightM, solarRadMjM2, elevationM, latDeg, dayOfYear }) → number|null`, `hargreavesEt0({ tMinC, tMaxC, latDeg, dayOfYear }) → number|null`, `windAt2m(speed, heightM) → number|null`, `luxToWm2(lux, luxPerWm2)`, `wm2HoursToMjPerDay(wm2Values)`, `extraterrestrialRadiation(latDeg, dayOfYear)`, `elevationFromPressure(pressureKpa) → number|null`. Results of `fao56Et0` and `hargreavesEt0` are rounded to 2 decimals.

- [ ] **Step 1: Failing tests** (`et0.test.js`)

```js
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const et0 = require('./et0');
const REPO = path.resolve(__dirname, '../../../../../../..');
const vectors = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/contracts/agronomy/et0-vectors.json'), 'utf8'));
const near = (got, want) => (want == null ? got === null : Math.abs(got - want) <= 0.005);

test('fao56Et0 reproduces every contract vector, including the dark days where Rs/Rso < 0.3', () => {
  for (const v of [...vectors.fao56, ...vectors.fao56Rejects]) assert.ok(near(et0.fao56Et0(v.input), v.et0Mm), v.name + ': expected ' + v.et0Mm + ' got ' + et0.fao56Et0(v.input));
  const byName = Object.fromEntries(vectors.fao56.map((v) => [v.name, v.et0Mm]));
  assert.equal(byName.brussels_example_18, 3.79);
  assert.equal(byName.payerne_winter_rs_1, 0.27);
  assert.equal(byName.payerne_winter_rs_0, 0.17);
  assert.equal(byName.lat70_doy355_rs_0, 0.25);
  assert.equal(byName.rh_100_wind_0, 5.07);
});

test('hargreavesEt0 reproduces every contract vector and checks the day of year', () => {
  for (const v of vectors.hargreaves) assert.ok(near(et0.hargreavesEt0(v.input), v.et0Mm), v.name);
  assert.equal(et0.hargreavesEt0({ tMinC: 10, tMaxC: 20, latDeg: 46.8, dayOfYear: 0 }), null);
  assert.equal(et0.hargreavesEt0({ tMinC: 10, tMaxC: 20, latDeg: 46.8, dayOfYear: 367 }), null);
  assert.equal(et0.hargreavesEt0({ tMinC: 20, tMaxC: 10, latDeg: 46.8, dayOfYear: 200 }), null);
});

test('windAt2m: FAO-56 eq. 47, null for a missing or non-positive height', () => {
  assert.ok(Math.abs(et0.windAt2m(3.4, 10) - 2.543) < 0.001);
  assert.equal(et0.windAt2m(2.78, 2), 2.78);
  assert.equal(et0.windAt2m(2.78, null), null);
  assert.equal(et0.windAt2m(2.78, undefined), null);
  assert.equal(et0.windAt2m(2.78, 0), null);
  assert.equal(et0.windAt2m(-1, 2), null);
});

test('elevation is null-tolerant but a non-finite elevation is rejected, as in the Java', () => {
  const base = vectors.fao56.find((v) => v.name === 'payerne_summer').input;
  assert.equal(et0.fao56Et0({ ...base, elevationM: null }), vectors.fao56.find((v) => v.name === 'null_elevation').et0Mm);
  assert.equal(et0.fao56Et0({ ...base, elevationM: NaN }), null);
  assert.equal(et0.fao56Et0({ ...base, elevationM: Infinity }), null);
  assert.equal(et0.fao56Et0({ ...base, dayOfYear: 200.5 }), null);
});

test('lux, radiation sums and pressure elevation', () => {
  assert.equal(et0.luxToWm2(120, 120), 1);
  assert.equal(et0.luxToWm2(null, 120), null);
  assert.equal(et0.wm2HoursToMjPerDay([500, 500]), 3.6);
  for (const v of vectors.luxToRadiation) assert.ok(Math.abs(et0.luxToWm2(v.lux, 120) - v.wm2) <= 0.01);
  for (const v of vectors.elevationFromPressure) assert.ok(Math.abs(et0.elevationFromPressure(v.pressureKpa) - v.elevationM) <= 0.05, String(v.pressureKpa));
  assert.equal(et0.elevationFromPressure(null), null);
  assert.equal(et0.elevationFromPressure(0), null);
});
```
Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.test.js`. Expected: `Cannot find module './et0'`.

- [ ] **Step 2: Implement**

`package.json`: as Task 2's with `"name": "osi-agronomy-daily"`. `et0.js`:
```js
'use strict';
// FAO-56 reference evapotranspiration (Allen et al. 1998): equation 6 (daily
// Penman-Monteith), 7 (pressure from elevation, inverted for the elevation),
// 47 (wind height), 52 (Hargreaves-Samani), 21-25 (extraterrestrial
// radiation). Vapour pressure from mean relative humidity, as the cloud's
// WeatherMath does; the Java is the reference and the contract vectors come
// from it (docs/contracts/agronomy/et0-vectors.json). Values in mm/day,
// rounded to 2 decimals.
const GSC = 0.0820;      // MJ m-2 min-1
const SIGMA = 4.903e-9;  // MJ K-4 m-2 day-1
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
function round2(v) { return Math.round(v * 100) / 100; }
function satVapourPressure(tC) { return 0.6108 * Math.exp((17.27 * tC) / (tC + 237.3)); }
function validDay(dayOfYear) { return Number.isInteger(dayOfYear) && dayOfYear >= 1 && dayOfYear <= 366; }
function windAt2m(speed, heightM) {
  if (!finite(speed) || speed < 0) return null;
  if (!finite(heightM) || heightM <= 0) return null;
  if (Math.abs(heightM - 2) < 1e-9) return speed;
  return speed * 4.87 / Math.log(67.8 * heightM - 5.42);
}
function extraterrestrialRadiation(latDeg, dayOfYear) {
  const phi = (Math.PI / 180) * latDeg;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI / 365) * dayOfYear);
  const delta = 0.409 * Math.sin((2 * Math.PI / 365) * dayOfYear - 1.39);
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta))));
  return (24 * 60 / Math.PI) * GSC * dr * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
}
function fao56Et0(input) {
  const { tMinC, tMaxC, meanRhPct, windSpeedMs, windHeightM, solarRadMjM2, elevationM, latDeg, dayOfYear } = input || {};
  if (![tMinC, tMaxC, meanRhPct, windSpeedMs, solarRadMjM2, latDeg].every(finite) || !validDay(dayOfYear)) return null;
  if (tMaxC < tMinC || meanRhPct < 0 || meanRhPct > 100 || windSpeedMs < 0 || solarRadMjM2 < 0) return null;
  if (elevationM != null && !finite(elevationM)) return null;
  const u2 = windAt2m(windSpeedMs, windHeightM);
  if (u2 == null) return null;
  const z = elevationM == null ? 0 : elevationM;
  const tMean = (tMaxC + tMinC) / 2;
  const slope = 4098 * satVapourPressure(tMean) / Math.pow(tMean + 237.3, 2);
  const pressure = 101.3 * Math.pow((293 - 0.0065 * z) / 293, 5.26);
  const gamma = 0.000665 * pressure;
  const es = (satVapourPressure(tMaxC) + satVapourPressure(tMinC)) / 2;
  const ea = es * meanRhPct / 100;
  const vpd = Math.max(0, es - ea);
  const ra = extraterrestrialRadiation(latDeg, dayOfYear);
  const rso = Math.max(1e-4, (0.75 + 2e-5 * z) * ra);
  const ratio = Math.max(0.3, Math.min(1, solarRadMjM2 / rso));
  const rns = 0.77 * solarRadMjM2;
  const rnl = SIGMA * ((Math.pow(tMaxC + 273.16, 4) + Math.pow(tMinC + 273.16, 4)) / 2) * (0.34 - 0.14 * Math.sqrt(Math.max(0, ea))) * (1.35 * ratio - 0.35);
  const rn = rns - rnl;
  const numerator = 0.408 * slope * rn + gamma * (900 / (tMean + 273)) * u2 * vpd;
  const denominator = slope + gamma * (1 + 0.34 * u2);
  if (!(denominator > 0)) return null;
  return round2(Math.max(0, numerator / denominator));
}
function hargreavesEt0(input) {
  const { tMinC, tMaxC, latDeg, dayOfYear } = input || {};
  if (![tMinC, tMaxC, latDeg].every(finite) || !validDay(dayOfYear) || tMaxC < tMinC) return null;
  const raMm = 0.408 * extraterrestrialRadiation(latDeg, dayOfYear);
  return round2(Math.max(0, 0.0023 * ((tMaxC + tMinC) / 2 + 17.8) * Math.sqrt(tMaxC - tMinC) * raMm));
}
function luxToWm2(lux, luxPerWm2) { return finite(lux) && finite(luxPerWm2) && luxPerWm2 > 0 ? lux / luxPerWm2 : null; }
function wm2HoursToMjPerDay(values) { return values.reduce((s, v) => s + (finite(v) ? v : 0), 0) * 3600 / 1e6; }
// FAO-56 eq. 7 solved for z: z = (293 / 0.0065) × (1 − (P / 101.3)^(1/5.26)).
function elevationFromPressure(pressureKpa) {
  if (!finite(pressureKpa) || pressureKpa <= 0) return null;
  return (293 / 0.0065) * (1 - Math.pow(pressureKpa / 101.3, 1 / 5.26));
}
module.exports = { fao56Et0, hargreavesEt0, windAt2m, luxToWm2, wm2HoursToMjPerDay, extraterrestrialRadiation, elevationFromPressure };
```
This code reproduced all 22 Java values and the 8 rejects on 2026-09-26. If a vector still disagrees beyond 0.005, the Java is the reference: read `WeatherMath.fao56Et0` line by line and match it, and note the alignment in the README's formula section.

- [ ] **Step 3: Run tests and the verifier, mirror, commit**

```bash
P=conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red; M=conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red
node --test $P/osi-agronomy-daily/et0.test.js
node scripts/verify-agronomy-contract.js
rsync -a --delete $P/osi-agronomy-daily/ $M/osi-agronomy-daily/
node scripts/verify-profile-parity.js
git add $P/osi-agronomy-daily $M/osi-agronomy-daily
git commit -m "feat(agronomy-daily): FAO-56 ET0 mathematics proven against the cloud's Java vectors"
```
Expected: `# pass 5`; the verifier prints only `web/react-gui/src/agronomy/crop-kc.json: missing` and no vector line; `All parity checks passed.` The package is registered in Task 7, once `index.js` exists.

---

### Task 7: `osi-agronomy-daily` writer

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/{index.js,index.test.js,facade-contract.test.js}`
- Modify (registration): node-red `package.json` + `package-lock.json`, `osi-lib/index.js` (`'agronomy-daily': 'osi-agronomy-daily'`), `osi-lib/index.test.js`, `98_osi_node_red_seed`, `deploy.sh` (package.json, index.js, et0.js), `.github/workflows/migrations.yml`; mirror the whole `osi-agronomy-daily` directory and the registration files to bcm2709

**Interfaces:**
- Consumes: `require('../osi-weather-provider').zoneLocations` (Task 4) and `.hourStartIso`; `require('../osi-crop-kc').resolveKc`, `.catalogue.stationWindHeightM`; `./et0` (Task 6).
- Produces: `localDayWindow(dateLocal, timezone) → { hourStarts: string[], fallback: boolean }` (hour starts in the `…:00Z` form); `completedLocalDays(nowIso, timezone, count) → string[]` (oldest first); `daysNeedingWork({ latestDays, existingRows, oldestHour, timezone, nowIso }) → string[]`; `sumDailyEt0(rows, hourStarts) → { et0Mm, hoursPresent, expectedHours, stationIds: Set }`; `stationDayInputs(rows, hourStarts) → { complete, tempComplete, radiationZero, tMinC, tMaxC, meanRhPct, windSpeedMs, solarRadMjM2, meanPressureKpa, hoursPresent, tempHoursPresent, anyHours, expectedHours }`; `resolveDay(args) → { et0Mm, et0Source, et0Tier, et0StationId, locationKey, hoursPresent, expectedHours, nullReason }`; `runDaily({ db, nowIso, deploymentDefault, warn }) → { zones, days, written, unchanged, deleted, nulls: [{ zoneId, date, reason, present, expected }], tzFallback: [zoneId], skipped? }`; `resetState()` for tests. `db` offers `all`, `run`, `transaction(executor)`; inside the executor only the scope argument is used.

- [ ] **Step 1: Failing tests** (`index.test.js`)

```js
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ad = require('./index');
const et0 = require('./et0');

const REPO = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO, 'database/seed-blank.sql'), 'utf8');
const TZ = 'Europe/Zurich';
const NOW = '2026-09-26T06:00:00Z'; // local 08:00 on 26 Sep; the latest completed day is 2026-09-25
const OM = 'open_meteo:46.80:6.95';
const MS = 'meteoswiss:46.80:6.95';

test.beforeEach(() => ad.resetState());

// Inside transaction() only the scope may be used; outer calls throw, the way the
// facade would hang (Global Constraints).
function scratchDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  let inTx = false;
  const scope = {
    all: async (sql, params) => raw.prepare(sql).all(...(params || [])),
    run: async (sql, params) => { raw.prepare(sql).run(...(params || [])); },
  };
  const guard = () => { if (inTx) throw new Error('outer db used inside transaction()'); };
  return {
    raw,
    all: async (sql, params) => { guard(); return scope.all(sql, params); },
    run: async (sql, params) => { guard(); return scope.run(sql, params); },
    transaction: async (fn) => {
      raw.exec('BEGIN IMMEDIATE');
      inTx = true;
      try { const result = await fn(scope); raw.exec('COMMIT'); return result; } catch (error) { raw.exec('ROLLBACK'); throw error; } finally { inTx = false; }
    },
  };
}

function seedZone(db, { id = 1, lat = 46.8, lon = 6.95, tz = TZ, weatherSource = 'auto', crop = 'maize', stage = 'mid_season', gatewayEui = null } = {}) {
  db.raw.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-09-01T00:00:00Z') ON CONFLICT DO NOTHING").run();
  db.raw.prepare('INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, weather_source, crop_type, phenological_stage, gateway_device_eui, zone_uuid) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'Z' + id, lat, lon, tz, weatherSource, crop, stage, gatewayEui, '00000000-0000-4000-8000-' + String(id).padStart(12, '0'));
}
function seedGateway(db, eui, altitudeM) {
  db.raw.prepare("INSERT INTO gateway_locations (gateway_device_eui, latitude, longitude, altitude_m, updated_at) VALUES (?, 46.8, 6.95, ?, '2026-09-01T00:00:00Z')").run(eui, altitudeM);
}
function seedStation(db, deveui, zoneId) {
  db.raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES (?, ?, 'SENSECAP_S2120', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')").run(deveui, 'S2120 ' + deveui.slice(-4));
  db.raw.prepare('INSERT INTO weather_station_zones (deveui, zone_id) VALUES (?, ?)').run(deveui, zoneId);
}
function seedProviderDay(db, key, date, { et0Mm = 0.2, stationId = null, skip = () => false } = {}) {
  const provider = key.split(':')[0];
  db.raw.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude, timezone) VALUES (?, ?, 46.8, 6.95, ?) ON CONFLICT DO NOTHING").run(key, provider, TZ);
  const insert = db.raw.prepare("INSERT INTO weather_provider_hours (location_key, hour_start, et0_mm, station_id, fetched_at) VALUES (?, ?, ?, ?, '2026-09-26T05:00:00Z')");
  ad.localDayWindow(date, TZ).hourStarts.forEach((h, i) => { if (!skip(h, i)) insert.run(key, h, typeof et0Mm === 'function' ? et0Mm(h, i) : et0Mm, typeof stationId === 'function' ? stationId(h, i) : stationId); });
}
// A clear day: 12 lit hours at 500 W/m² (21.6 MJ/m²), min 12 °C, max 22 °C, 70 %, 1.5 m/s, 955 hPa.
function stationHour(i) {
  const lit = i >= 6 && i < 18;
  return { air_temperature_min_c: 12, air_temperature_max_c: 22, relative_humidity_pct: 70, wind_speed_mps: 1.5, global_radiation_wm2: lit ? 500 : 0, pressure_hpa: 955 };
}
function seedStationDay(db, deveui, date, { row = stationHour, skip = () => false } = {}) {
  const insert = db.raw.prepare("INSERT INTO weather_station_hours (deveui, hour_start, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, global_radiation_wm2, pressure_hpa, sample_count, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 4, '2026-09-26T05:00:00Z')");
  ad.localDayWindow(date, TZ).hourStarts.forEach((h, i) => {
    if (skip(h, i)) return;
    const r = row(i);
    insert.run(deveui, h, r.air_temperature_min_c, r.air_temperature_max_c, r.relative_humidity_pct, r.wind_speed_mps, r.global_radiation_wm2, r.pressure_hpa);
  });
}
function days(from, to) { const out = []; for (let d = from; d <= to; d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) out.push(d); return out; }
function rows(db, zoneId = 1) { return db.raw.prepare('SELECT * FROM zone_daily_agronomy WHERE zone_id = ? ORDER BY date').all(zoneId).map((r) => ({ ...r })); }
function row(db, date, zoneId = 1) { return rows(db, zoneId).find((r) => r.date === date); }
const run = (db, nowIso = NOW, extra = {}) => ad.runDaily({ db, nowIso, deploymentDefault: 'open_meteo', warn: () => {}, ...extra });
const STATION_INPUTS = { tMinC: 12, tMaxC: 22, meanRhPct: 70, windSpeedMs: 1.5, windHeightM: 2, solarRadMjM2: 21.6, latDeg: 46.8, dayOfYear: 268 };

test('localDayWindow: DST days, Kampala, invalid timezone', () => {
  assert.equal(ad.localDayWindow('2026-03-29', TZ).hourStarts.length, 23);
  assert.equal(ad.localDayWindow('2026-10-25', TZ).hourStarts.length, 25);
  const k = ad.localDayWindow('2026-09-25', 'Africa/Kampala');
  assert.equal(k.hourStarts[0], '2026-09-24T21:00:00Z');
  assert.equal(k.hourStarts.length, 24);
  assert.equal(k.fallback, false);
  const m = ad.localDayWindow('2026-09-25', 'Mars/Olympus');
  assert.equal(m.fallback, true);
  assert.equal(m.hourStarts[0], '2026-09-25T00:00:00Z');
});

test('completedLocalDays: the latest completed day follows the zone clock', () => {
  assert.deepEqual(ad.completedLocalDays('2026-09-26T00:10:00Z', TZ, 7), days('2026-09-19', '2026-09-25'));
  assert.equal(ad.completedLocalDays('2026-09-25T21:50:00Z', TZ, 7).at(-1), '2026-09-24');
});

test('sumDailyEt0: all hours, one missing, two stations, a null station, the day clamp at 0', () => {
  const hs = ad.localDayWindow('2026-09-25', TZ).hourStarts;
  const full = hs.map((h) => ({ hour_start: h, et0_mm: 0.2, station_id: 'PAY' }));
  assert.deepEqual({ ...ad.sumDailyEt0(full, hs), stationIds: [...ad.sumDailyEt0(full, hs).stationIds] }, { et0Mm: 4.8, hoursPresent: 24, expectedHours: 24, stationIds: ['PAY'] });
  const gap = full.map((r, i) => (i === 5 ? { ...r, et0_mm: null } : r));
  assert.equal(ad.sumDailyEt0(gap, hs).et0Mm, null);
  assert.equal(ad.sumDailyEt0(gap, hs).hoursPresent, 23);
  assert.equal(ad.sumDailyEt0(full.map((r, i) => (i > 12 ? { ...r, station_id: 'GRE' } : r)), hs).stationIds.size, 2);
  assert.ok(ad.sumDailyEt0(full.map((r, i) => (i === 3 ? { ...r, station_id: null } : r)), hs).stationIds.has(null));
  assert.equal(ad.sumDailyEt0(hs.map((h) => ({ hour_start: h, et0_mm: -0.01, station_id: 'PAY' })), hs).et0Mm, 0);
});

test('stationDayInputs: null lux in 23 hours, lux 0 all day, a full day', () => {
  const hs = ad.localDayWindow('2026-09-25', TZ).hourStarts;
  const mk = (f) => hs.map((h, i) => ({ hour_start: h, ...stationHour(i), ...f(i) }));
  const oneLux = ad.stationDayInputs(mk((i) => ({ global_radiation_wm2: i === 12 ? 500 : null })), hs);
  assert.equal(oneLux.complete, false);
  assert.equal(oneLux.tempComplete, true);
  const dark = ad.stationDayInputs(mk(() => ({ global_radiation_wm2: 0 })), hs);
  assert.equal(dark.complete, false);
  assert.equal(dark.radiationZero, true);
  const full = ad.stationDayInputs(mk(() => ({})), hs);
  assert.equal(full.complete, true);
  assert.deepEqual([full.tMinC, full.tMaxC, full.meanRhPct, full.windSpeedMs, Math.round(full.solarRadMjM2 * 100) / 100, full.meanPressureKpa], [12, 22, 70, 1.5, 21.6, 95.5]);
});

test('provider tier: 8 full days give 8 rows (gap rule), snapshot and ETc; a second run writes nothing', async () => {
  const db = scratchDb();
  seedZone(db);
  for (const d of days('2026-09-18', '2026-09-25')) seedProviderDay(db, OM, d);
  const first = await run(db);
  assert.equal(first.written, 8);
  const r = row(db, '2026-09-25');
  assert.deepEqual([r.et0_mm, r.et0_source, r.et0_tier, r.et0_station_id, r.location_key, r.kc, r.kc_source, r.crop_type, r.phenological_stage, r.etc_mm, r.hours_present, r.expected_hours, r.null_reason],
    [4.8, 'open_meteo_hourly_sum', 'provider_hourly_sum', null, OM, 1.2, 'fao56_crop', 'maize', 'mid_season', 5.76, 24, 24, null]);
  assert.equal(rows(db).length, 8);
  const computedAt = r.computed_at;
  const second = await run(db, '2026-09-26T06:30:00Z');
  assert.equal(second.written, 0);
  assert.equal(second.unchanged, 7, 'the older day holds a value, so only the 7 latest days are revisited');
  assert.equal(row(db, '2026-09-25').computed_at, computedAt);
});

test('station tier wins over the provider; station deveui, 2 m wind, gateway altitude, else pressure elevation', async () => {
  const db = scratchDb();
  seedZone(db, { gatewayEui: 'GW1' });
  seedGateway(db, 'GW1', 490);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedProviderDay(db, OM, '2026-09-25');
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-25');
  await run(db);
  const r = row(db, '2026-09-25');
  assert.deepEqual([r.et0_tier, r.et0_source, r.et0_station_id, r.location_key], ['station_fao56', 'station_fao56', 'S2120AAAA00000001', null]);
  assert.equal(r.et0_mm, et0.fao56Et0({ ...STATION_INPUTS, elevationM: 490 }));
  db.raw.prepare('DELETE FROM gateway_locations').run();
  db.raw.prepare('DELETE FROM zone_daily_agronomy').run();
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_mm, et0.fao56Et0({ ...STATION_INPUTS, elevationM: et0.elevationFromPressure(95.5) }));
});

test('lux 0 all day fails tier 1: the provider takes the day, and without a provider Hargreaves does', async () => {
  const db = scratchDb();
  seedZone(db);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-25', { row: (i) => ({ ...stationHour(i), global_radiation_wm2: 0 }) });
  seedProviderDay(db, OM, '2026-09-25');
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_tier, 'provider_hourly_sum');
  db.raw.prepare('DELETE FROM weather_provider_hours').run();
  db.raw.prepare('DELETE FROM zone_daily_agronomy').run();
  await run(db);
  const r = row(db, '2026-09-25');
  assert.equal(r.et0_tier, 'hargreaves_station');
  assert.equal(r.et0_mm, et0.hargreavesEt0({ tMinC: 12, tMaxC: 22, latDeg: 46.8, dayOfYear: 268 }));
});

test('a station hour with samples but null lux: tier 1 rejects, Hargreaves accepts', async () => {
  const db = scratchDb();
  seedZone(db, { weatherSource: 'local' });
  seedStation(db, 'S2120AAAA00000001', 1);
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-25', { row: (i) => ({ ...stationHour(i), global_radiation_wm2: i === 9 ? null : stationHour(i).global_radiation_wm2 }) });
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_tier, 'hargreaves_station');
});

test('a 60-minute uplink station with one empty hour: both station tiers reject; provider, else partial_day 23/24', async () => {
  const db = scratchDb();
  seedZone(db);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-25', { skip: (h, i) => i === 14 });
  seedProviderDay(db, OM, '2026-09-25');
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_tier, 'provider_hourly_sum');
  db.raw.prepare('DELETE FROM weather_provider_hours').run();
  db.raw.prepare('DELETE FROM zone_daily_agronomy').run();
  await run(db);
  const r = row(db, '2026-09-25');
  assert.deepEqual([r.et0_mm, r.null_reason, r.hours_present, r.expected_hours], [null, 'partial_day', 23, 24]);
});

test('frozen snapshot: a stage change keeps stored rows; a day that becomes valid later gets the new Kc', async () => {
  const db = scratchDb();
  seedZone(db);
  seedProviderDay(db, OM, '2026-09-24');
  seedProviderDay(db, OM, '2026-09-25', { skip: (h, i) => i === 3 });
  await run(db);
  assert.equal(row(db, '2026-09-24').kc, 1.2);
  assert.equal(row(db, '2026-09-25').kc, null);
  db.raw.prepare("UPDATE irrigation_zones SET phenological_stage = 'late_season' WHERE id = 1").run();
  db.raw.prepare("INSERT INTO weather_provider_hours (location_key, hour_start, et0_mm, fetched_at) VALUES (?, ?, 0.2, '2026-09-26T06:00:00Z')").run(OM, ad.localDayWindow('2026-09-25', TZ).hourStarts[3]);
  await run(db, '2026-09-26T07:00:00Z');
  assert.deepEqual([row(db, '2026-09-24').kc, row(db, '2026-09-24').phenological_stage, row(db, '2026-09-24').etc_mm], [1.2, 'mid_season', 5.76]);
  assert.deepEqual([row(db, '2026-09-25').kc, row(db, '2026-09-25').phenological_stage, row(db, '2026-09-25').etc_mm], [0.35, 'late_season', 1.68]);
});

test('null reasons: no_source, partial_day, pending, mixed_station, unknown_station, no_location', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1 });
  seedZone(db, { id: 2, weatherSource: 'meteoswiss' });
  seedZone(db, { id: 3, weatherSource: 'meteoswiss' });
  seedZone(db, { id: 4, lat: null, lon: null });
  seedProviderDay(db, OM, '2026-09-24', { skip: (h, i) => i === 3 });
  seedProviderDay(db, MS, '2026-09-24', { stationId: (h, i) => (i < 12 ? 'PAY' : 'GRE') });
  await run(db);
  assert.equal(row(db, '2026-09-23', 1).null_reason, 'no_source');
  assert.equal(row(db, '2026-09-24', 1).null_reason, 'partial_day');
  assert.equal(row(db, '2026-09-24', 2).null_reason, 'mixed_station');
  assert.equal(row(db, '2026-09-24', 4).null_reason, 'no_location');
  assert.equal(rows(db, 4).length, 7);
  db.raw.prepare('DELETE FROM weather_provider_hours').run();
  seedProviderDay(db, MS, '2026-09-24', { stationId: (h, i) => (i === 7 ? null : 'PAY') });
  await run(db);
  assert.equal(row(db, '2026-09-24', 2).null_reason, 'unknown_station');
  seedProviderDay(db, OM, '2026-09-25', { skip: (h, i) => i === 23 });
  await run(db, '2026-09-26T00:30:00Z'); // the local day ended at 22:00Z, 2.5 h ago
  assert.equal(row(db, '2026-09-25', 1).null_reason, 'pending');
});

test('gap days: an older day without a row is written when hours exist; nothing before the oldest hour', async () => {
  const db = scratchDb();
  seedZone(db);
  for (const d of days('2026-09-15', '2026-09-25')) seedProviderDay(db, OM, d);
  await run(db);
  assert.equal(rows(db).length, 11);
  db.raw.prepare("DELETE FROM zone_daily_agronomy WHERE date = '2026-09-16'").run();
  const again = await run(db, '2026-09-26T06:30:00Z');
  assert.equal(again.written, 1);
  assert.equal(row(db, '2026-09-16').et0_mm, 4.8);
  assert.equal(row(db, '2026-09-14'), undefined);
});

test('clock: a run 25 h behind the newest stored hour is skipped; rows dated today or later are deleted', async () => {
  const db = scratchDb();
  seedZone(db);
  seedProviderDay(db, OM, '2026-09-25');
  const behind = await run(db, '2026-09-24T20:00:00Z');
  assert.equal(behind.skipped, 'clock_behind_store');
  assert.equal(rows(db).length, 0);
  const insert = db.raw.prepare("INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, computed_at) VALUES (1, ?, 3, '2026-09-30T00:00:00Z')");
  insert.run('2026-09-26');
  insert.run('2026-09-30');
  const summary = await run(db);
  assert.equal(summary.deleted, 2);
  assert.equal(rows(db).filter((r) => r.date >= '2026-09-26').length, 0);
});

test('MeteoSwiss negative hourly values: the day is clamped at 0, the hours stay as delivered', async () => {
  const db = scratchDb();
  seedZone(db, { weatherSource: 'meteoswiss' });
  seedProviderDay(db, MS, '2026-09-25', { et0Mm: -0.01, stationId: 'PAY' });
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_mm, 0);
  assert.equal(row(db, '2026-09-25').et0_station_id, 'PAY');
  assert.equal(db.raw.prepare('SELECT MIN(et0_mm) AS m FROM weather_provider_hours').get().m, -0.01);
});

test('warn on change only; tzFallback lists a zone with an invalid timezone', async () => {
  const db = scratchDb();
  seedZone(db, { tz: 'Mars/Olympus' });
  const warnings = [];
  const first = await run(db, NOW, { warn: (m) => warnings.push(m) });
  assert.deepEqual(first.tzFallback, [1]);
  const count = warnings.length;
  assert.ok(count >= 1);
  await run(db, '2026-09-26T06:30:00Z', { warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, count);
});

test('in-flight guard: a second concurrent run returns skipped', async () => {
  const db = scratchDb();
  seedZone(db);
  const [a, b] = await Promise.all([run(db), run(db)]);
  assert.equal(b.skipped, 'in_flight');
  assert.equal(a.skipped, undefined);
});
```
Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js`. Expected: `Cannot find module './index'`.

- [ ] **Step 2: Implement** (`index.js`)

```js
'use strict';
// osi-agronomy-daily: one row per zone and completed local day in
// zone_daily_agronomy (spec docs/superpowers/specs/2026-09-26-daily-agronomy-design.md,
// component 4): ET0 from three tiers, Kc frozen per row, explicit null reasons.
const { zoneLocations, hourStartIso } = require('../osi-weather-provider');
const { resolveKc, catalogue } = require('../osi-crop-kc');
const et0 = require('./et0');

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const LATEST_DAYS = 7;
const MAX_DAYS = 92;
const PENDING_HOURS = 3;
const CLOCK_SLACK_HOURS = 24;

const formatters = new Map();
function formatterFor(timezone) {
  const key = String(timezone || 'UTC');
  if (!formatters.has(key)) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' };
    let entry;
    try { entry = { fmt: new Intl.DateTimeFormat('en-US', { ...options, timeZone: key }), fallback: false }; }
    catch (_) { entry = { fmt: new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }), fallback: true }; }
    formatters.set(key, entry);
  }
  return formatters.get(key);
}
// formatToParts only: the Node build has English locale data only, and
// format() strings are not stable across builds.
function localDateOf(ms, fmt) {
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return p.year + '-' + p.month + '-' + p.day;
}
function addDays(dateIso, n) { return new Date(Date.parse(dateIso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10); }
function todayLocal(nowIso, timezone) { return localDateOf(Date.parse(nowIso), formatterFor(timezone).fmt); }
function dayOfYear(dateIso) { return Math.round((Date.parse(dateIso + 'T00:00:00Z') - Date.parse(dateIso.slice(0, 4) + '-01-01T00:00:00Z')) / DAY_MS) + 1; }
function round2(v) { return Math.round(v * 100) / 100; }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

function localDayWindow(dateLocal, timezone) {
  const { fmt, fallback } = formatterFor(timezone);
  const base = Date.parse(dateLocal + 'T00:00:00Z');
  const hourStarts = [];
  for (let ms = base - DAY_MS; ms < base + 2 * DAY_MS; ms += HOUR_MS) {
    if (localDateOf(ms, fmt) === dateLocal) hourStarts.push(hourStartIso(new Date(ms)));
  }
  return { hourStarts, fallback };
}

function completedLocalDays(nowIso, timezone, count = LATEST_DAYS) {
  const today = todayLocal(nowIso, timezone);
  const days = [];
  for (let i = count; i >= 1; i -= 1) days.push(addDays(today, -i));
  return days;
}

function daysNeedingWork({ latestDays, existingRows, oldestHour, timezone, nowIso }) {
  if (!oldestHour) return latestDays.slice();
  const today = todayLocal(nowIso, timezone);
  const oldestDay = todayLocal(oldestHour, timezone);
  const floor = [addDays(today, -MAX_DAYS), oldestDay].sort()[1];
  const byDate = new Map(existingRows.map((r) => [r.date, r]));
  const older = [];
  for (let d = floor; d < latestDays[0]; d = addDays(d, 1)) {
    const stored = byDate.get(d);
    if (!stored || stored.et0_mm == null) older.push(d);
  }
  return [...older, ...latestDays];
}

function sumDailyEt0(rows, hourStarts) {
  const byHour = new Map(rows.map((r) => [r.hour_start, r]));
  let sum = 0;
  let present = 0;
  const stationIds = new Set();
  for (const h of hourStarts) {
    const r = byHour.get(h);
    if (!r || r.et0_mm == null) continue;
    present += 1;
    sum += r.et0_mm;
    stationIds.add(r.station_id == null ? null : r.station_id);
  }
  const complete = present === hourStarts.length;
  return { et0Mm: complete ? Math.max(0, round2(sum)) : null, hoursPresent: present, expectedHours: hourStarts.length, stationIds };
}

const MANDATORY = ['air_temperature_min_c', 'air_temperature_max_c', 'relative_humidity_pct', 'wind_speed_mps', 'global_radiation_wm2'];
function stationDayInputs(rows, hourStarts) {
  const byHour = new Map(rows.map((r) => [r.hour_start, r]));
  const hours = hourStarts.map((h) => byHour.get(h) || null);
  const present = hours.filter(Boolean);
  const full = present.filter((r) => MANDATORY.every((k) => r[k] != null));
  const temp = present.filter((r) => r.air_temperature_min_c != null && r.air_temperature_max_c != null);
  const pressures = present.map((r) => r.pressure_hpa).filter((v) => v != null);
  const tempComplete = temp.length === hourStarts.length;
  const out = {
    complete: false, tempComplete, radiationZero: false,
    tMinC: tempComplete ? Math.min(...temp.map((r) => r.air_temperature_min_c)) : null,
    tMaxC: tempComplete ? Math.max(...temp.map((r) => r.air_temperature_max_c)) : null,
    meanRhPct: null, windSpeedMs: null, solarRadMjM2: null,
    meanPressureKpa: pressures.length ? round2(mean(pressures)) / 10 : null,
    hoursPresent: full.length, tempHoursPresent: temp.length, anyHours: present.length, expectedHours: hourStarts.length,
  };
  if (full.length !== hourStarts.length) return out;
  const solar = et0.wm2HoursToMjPerDay(full.map((r) => r.global_radiation_wm2));
  // A dead or covered light sensor reports 0 all day: that is not a measurement.
  if (!(solar > 0)) return { ...out, radiationZero: true };
  return { ...out, complete: true, meanRhPct: mean(full.map((r) => r.relative_humidity_pct)), windSpeedMs: mean(full.map((r) => r.wind_speed_mps)), solarRadMjM2: solar };
}

// Stations are ordered by deveui; a tie keeps the lower deveui.
function pickStation(stations, stationHours, hourStarts, key) {
  let best = null;
  for (const deveui of stations) {
    const inputs = stationDayInputs(stationHours.get(deveui) || [], hourStarts);
    if (!best || inputs[key] > best.inputs[key]) best = { deveui, inputs };
  }
  return best;
}

function resolveDay({ date, hourStarts, latitude, provider, locationKey, stations, stationHours, providerRows, gatewayAltitudeM, nowMs }) {
  const base = { et0Mm: null, et0Source: null, et0Tier: null, et0StationId: null, locationKey: null, hoursPresent: 0, expectedHours: hourStarts.length, nullReason: null };
  if (latitude == null) return { ...base, nullReason: 'no_location' };
  const doy = dayOfYear(date);
  const recent = nowMs - (Date.parse(hourStarts[hourStarts.length - 1]) + HOUR_MS) < PENDING_HOURS * HOUR_MS;
  let anyHours = false;
  let lastPresent = 0;
  let providerReason = null;
  if (stations.length) {
    const best = pickStation(stations, stationHours, hourStarts, 'hoursPresent');
    anyHours = anyHours || best.inputs.anyHours > 0;
    lastPresent = best.inputs.hoursPresent;
    if (best.inputs.complete) {
      const elevationM = gatewayAltitudeM != null ? gatewayAltitudeM : et0.elevationFromPressure(best.inputs.meanPressureKpa);
      const value = et0.fao56Et0({ tMinC: best.inputs.tMinC, tMaxC: best.inputs.tMaxC, meanRhPct: best.inputs.meanRhPct, windSpeedMs: best.inputs.windSpeedMs, windHeightM: catalogue.stationWindHeightM, solarRadMjM2: best.inputs.solarRadMjM2, elevationM, latDeg: latitude, dayOfYear: doy });
      if (value != null) return { ...base, et0Mm: value, et0Source: 'station_fao56', et0Tier: 'station_fao56', et0StationId: best.deveui, hoursPresent: best.inputs.hoursPresent };
    }
  }
  if (provider && locationKey) {
    const sum = sumDailyEt0(providerRows, hourStarts);
    anyHours = anyHours || sum.hoursPresent > 0;
    lastPresent = sum.hoursPresent;
    if (sum.et0Mm != null) {
      if (provider === 'meteoswiss' && sum.stationIds.has(null)) providerReason = 'unknown_station';
      else if (provider === 'meteoswiss' && sum.stationIds.size > 1) providerReason = 'mixed_station';
      else return { ...base, et0Mm: sum.et0Mm, et0Source: provider + '_hourly_sum', et0Tier: 'provider_hourly_sum', et0StationId: provider === 'meteoswiss' ? [...sum.stationIds][0] : null, locationKey, hoursPresent: sum.hoursPresent };
    }
  }
  if (stations.length) {
    const best = pickStation(stations, stationHours, hourStarts, 'tempHoursPresent');
    lastPresent = best.inputs.tempHoursPresent;
    if (best.inputs.tempComplete) {
      const value = et0.hargreavesEt0({ tMinC: best.inputs.tMinC, tMaxC: best.inputs.tMaxC, latDeg: latitude, dayOfYear: doy });
      if (value != null) return { ...base, et0Mm: value, et0Source: 'hargreaves_station', et0Tier: 'hargreaves_station', et0StationId: best.deveui, hoursPresent: best.inputs.tempHoursPresent };
    }
  }
  let nullReason;
  if (providerReason) nullReason = providerReason;
  else if (recent) nullReason = 'pending';
  else nullReason = anyHours ? 'partial_day' : 'no_source';
  return { ...base, hoursPresent: lastPresent, nullReason };
}

function snapshotFor(zone, computed, stored) {
  if (stored && stored.kc != null) return { kc: stored.kc, kcSource: stored.kc_source, cropType: stored.crop_type, stage: stored.phenological_stage };
  if (computed.et0Mm == null) return { kc: null, kcSource: null, cropType: null, stage: null };
  const r = resolveKc({ cropType: zone.crop_type, phenologicalStage: zone.phenological_stage });
  const crop = zone.crop_type == null ? null : (String(zone.crop_type).trim() || null);
  return { kc: r.kc, kcSource: r.kcSource, cropType: crop, stage: r.stage };
}

const ROW_COLUMNS = ['et0_mm', 'et0_source', 'et0_tier', 'et0_station_id', 'location_key', 'hours_present', 'expected_hours', 'null_reason', 'kc', 'kc_source', 'crop_type', 'phenological_stage', 'etc_mm'];
const UPSERT_SQL =
  'INSERT INTO zone_daily_agronomy (zone_id, date, ' + ROW_COLUMNS.join(', ') + ', computed_at) VALUES (?, ?, ' + ROW_COLUMNS.map(() => '?').join(', ') + ', ?) ' +
  'ON CONFLICT(zone_id, date) DO UPDATE SET ' + ROW_COLUMNS.map((c) => c + ' = excluded.' + c).join(', ') + ', computed_at = excluded.computed_at ' +
  'WHERE ' + ROW_COLUMNS.map((c) => 'zone_daily_agronomy.' + c + ' IS NOT excluded.' + c).join(' OR ') + ' ' +
  'RETURNING zone_id';

function rowParams(zone, date, computed, stored, nowIso) {
  const snap = snapshotFor(zone, computed, stored);
  const etc = computed.et0Mm != null && snap.kc != null ? round2(computed.et0Mm * snap.kc) : null;
  return [zone.id, date, computed.et0Mm, computed.et0Source, computed.et0Tier, computed.et0StationId, computed.locationKey, computed.hoursPresent, computed.expectedHours, computed.nullReason, snap.kc, snap.kcSource, snap.cropType, snap.stage, etc, nowIso];
}

let inFlight = null;
const lastReason = new Map();
function resetState() { inFlight = null; lastReason.clear(); formatters.clear(); }

async function runDailyOnce({ db, nowIso, deploymentDefault, warn }) {
  const say = typeof warn === 'function' ? warn : () => {};
  const nowMs = Date.parse(nowIso);
  const summary = { zones: 0, days: 0, written: 0, unchanged: 0, deleted: 0, nulls: [], tzFallback: [] };
  const bounds = (await db.all('SELECT MIN(o) AS oldest, MAX(n) AS newest FROM (SELECT MIN(hour_start) AS o, MAX(hour_start) AS n FROM weather_provider_hours UNION ALL SELECT MIN(hour_start), MAX(hour_start) FROM weather_station_hours)', []))[0] || {};
  if (bounds.newest && Date.parse(bounds.newest) - nowMs > CLOCK_SLACK_HOURS * HOUR_MS) {
    if (lastReason.get('clock') !== 'behind') say('clock behind the store: newest hour ' + bounds.newest + ' is more than 24 h after ' + nowIso);
    lastReason.set('clock', 'behind');
    return { ...summary, skipped: 'clock_behind_store' };
  }
  lastReason.delete('clock');
  const zones = await db.all('SELECT iz.id, iz.timezone, iz.crop_type, iz.phenological_stage, gl.altitude_m FROM irrigation_zones iz LEFT JOIN gateway_locations gl ON gl.gateway_device_eui = iz.gateway_device_eui WHERE iz.deleted_at IS NULL ORDER BY iz.id', []);
  const located = new Map((await zoneLocations(db, deploymentDefault)).map((e) => [e.zone.id, e]));
  const stationsByZone = new Map();
  for (const a of await db.all("SELECT w.zone_id, w.deveui FROM weather_station_zones w JOIN devices d ON d.deveui = w.deveui WHERE d.type_id = 'SENSECAP_S2120' AND d.deleted_at IS NULL ORDER BY w.zone_id, w.deveui", [])) {
    if (!stationsByZone.has(a.zone_id)) stationsByZone.set(a.zone_id, []);
    stationsByZone.get(a.zone_id).push(a.deveui);
  }
  // Hours are read once per (location key, station set, timezone) group, over a
  // span that covers the 92-day bound.
  const spanStart = hourStartIso(new Date(nowMs - (MAX_DAYS + 2) * DAY_MS));
  const spanEnd = hourStartIso(new Date(nowMs));
  const hourCache = new Map();
  async function hoursFor(entry, stations, tz) {
    const key = [entry ? entry.locationKey : '', stations.join(','), tz].join('|');
    if (!hourCache.has(key)) {
      const providerRows = entry && entry.locationKey
        ? await db.all('SELECT hour_start, et0_mm, station_id FROM weather_provider_hours WHERE location_key = ? AND hour_start >= ? AND hour_start < ?', [entry.locationKey, spanStart, spanEnd])
        : [];
      const stationHours = new Map();
      if (stations.length) {
        const list = await db.all('SELECT deveui, hour_start, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, global_radiation_wm2, pressure_hpa FROM weather_station_hours WHERE deveui IN (' + stations.map(() => '?').join(', ') + ') AND hour_start >= ? AND hour_start < ?', [...stations, spanStart, spanEnd]);
        for (const r of list) { if (!stationHours.has(r.deveui)) stationHours.set(r.deveui, []); stationHours.get(r.deveui).push(r); }
      }
      hourCache.set(key, { providerRows, stationHours });
    }
    return hourCache.get(key);
  }
  for (const zone of zones) {
    try {
      const entry = located.get(zone.id) || null;
      const tz = entry ? entry.timezone : (String(zone.timezone || 'UTC').trim() || 'UTC');
      if (formatterFor(tz).fallback) summary.tzFallback.push(zone.id);
      const today = todayLocal(nowIso, tz);
      const latestDays = completedLocalDays(nowIso, tz, LATEST_DAYS);
      const stations = stationsByZone.get(zone.id) || [];
      const existingRows = await db.all('SELECT date, et0_mm FROM zone_daily_agronomy WHERE zone_id = ? AND date < ?', [zone.id, today]);
      const days = entry ? daysNeedingWork({ latestDays, existingRows, oldestHour: bounds.oldest, timezone: tz, nowIso }) : latestDays;
      const hours = await hoursFor(entry, stations, tz);
      const decided = days.map((date) => ({ date, computed: resolveDay({ date, hourStarts: localDayWindow(date, tz).hourStarts, latitude: entry ? entry.latitude : null, provider: entry ? entry.provider : null, locationKey: entry ? entry.locationKey : null, stations, stationHours: hours.stationHours, providerRows: hours.providerRows, gatewayAltitudeM: zone.altitude_m, nowMs }) }));
      await db.transaction(async (tx) => {
        // Only `tx` inside the executor: the facade runs every call through one
        // queue and this transaction holds it; a call on `db` here never returns.
        summary.deleted += (await tx.all('DELETE FROM zone_daily_agronomy WHERE zone_id = ? AND date >= ? RETURNING date', [zone.id, today])).length;
        const stored = new Map((await tx.all('SELECT date, kc, kc_source, crop_type, phenological_stage FROM zone_daily_agronomy WHERE zone_id = ? AND date >= ? AND date <= ?', [zone.id, days[0], days[days.length - 1]])).map((r) => [r.date, r]));
        for (const { date, computed } of decided) {
          const returned = await tx.all(UPSERT_SQL, rowParams(zone, date, computed, stored.get(date), nowIso));
          summary.written += returned.length;
          summary.unchanged += 1 - returned.length;
        }
      });
      summary.zones += 1;
      summary.days += days.length;
      for (const { date, computed } of decided) {
        if (computed.et0Mm == null) summary.nulls.push({ zoneId: zone.id, date, reason: computed.nullReason, present: computed.hoursPresent, expected: computed.expectedHours });
      }
      const latest = decided[decided.length - 1].computed;
      const reason = (latest.nullReason || 'ok') + (formatterFor(tz).fallback ? '+tz_fallback' : '');
      if (lastReason.get(zone.id) !== reason) {
        if (reason !== 'ok' || lastReason.has(zone.id)) say('zone ' + zone.id + ': ' + (reason === 'ok' ? 'recovered' : reason + ' (' + latest.hoursPresent + '/' + latest.expectedHours + ' hours)'));
        lastReason.set(zone.id, reason);
      }
    } catch (error) {
      say('zone ' + zone.id + ' failed: ' + (error && error.message ? error.message : error));
    }
  }
  return summary;
}

async function runDaily(args) {
  if (inFlight) return { zones: 0, days: 0, written: 0, unchanged: 0, deleted: 0, nulls: [], tzFallback: [], skipped: 'in_flight' };
  inFlight = runDailyOnce(args);
  try { return await inFlight; } finally { inFlight = null; }
}

module.exports = { localDayWindow, completedLocalDays, daysNeedingWork, sumDailyEt0, stationDayInputs, resolveDay, runDaily, resetState };
```
Run the tests; expected `# pass 16`. A `mixed_station` day never heals (the weather tick refetches only absent hours), which is accepted for this sub-project; Task 12's execution report records it as a follow-up.

- [ ] **Step 3: Facade-contract test**

`facade-contract.test.js` is a port of `osi-weather-provider/facade-contract.test.js`. Deltas:
- `const ad = require('./index');` and the header comment names `runDaily` and `agronomy-daily-fn`.
- `sqlite3Adapter()` and `loadOsiDbHelper()` copied verbatim.
- The seed inserts a user, zone 1 (`latitude 46.8, longitude 6.95, timezone 'Europe/Zurich', crop_type 'maize', phenological_stage 'mid_season'`), a `weather_locations` row `open_meteo:46.80:6.95`, and 24 Open-Meteo hours with `et0_mm = 0.2` for the local day 2026-09-25 (hour starts `2026-09-24T22:00:00Z` to `2026-09-25T21:00:00Z`), so the zone's transaction writes.
- The client is the node's shape, including the transaction: `{ all: (sql, params) => Promise.resolve(db.all(sql, params || [])), run: (sql, params) => Promise.resolve(db.run(sql, params || [])).then(() => undefined), transaction: (fn) => db.transaction(fn) }`.
- The call is `await ad.runDaily({ db: client, nowIso: '2026-09-26T06:00:00Z', deploymentDefault: 'open_meteo', warn: () => {} })`, wrapped in a 10-second `Promise.race` timeout so a facade deadlock fails the test instead of hanging it. Assert `summary.written === 7`, then the row for `2026-09-25` has `et0_mm 4.8`, `kc 1.2`, `etc_mm 5.76`; a second call returns `written: 0, unchanged: 7`.

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/facade-contract.test.js`. Expected: `# pass 1`.

- [ ] **Step 4: Register on every delivery surface**

1. node-red `package.json`: `"osi-agronomy-daily": "file:osi-agronomy-daily",` in alphabetical position.
2. `package-lock.json`: `node $SCRATCH/register-lock.js osi-agronomy-daily` (code in Task 2 Step 5).
3. `osi-lib/index.js`: `'agronomy-daily': 'osi-agronomy-daily',` in `NAME_TO_PATH`.
4. `osi-lib/index.test.js`: insert `'agronomy-daily',` as the first list entry, before `'agroscope-uplink-transform',`; add `assert.equal(osiLib.NAME_TO_PATH['agronomy-daily'], 'osi-agronomy-daily');`.
5. `98_osi_node_red_seed` line 42: append ` osi-agronomy-daily` before `; do`.
6. `deploy.sh`, after the `osi-station-hours index.js` block:
```bash
fetch_required "osi-agronomy-daily package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/package.json" \
    "/srv/node-red/osi-agronomy-daily/package.json"

fetch_required "osi-agronomy-daily index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.js" \
    "/srv/node-red/osi-agronomy-daily/index.js"

fetch_required "osi-agronomy-daily et0.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js" \
    "/srv/node-red/osi-agronomy-daily/et0.js"
```
7. `.github/workflows/migrations.yml`, after the `osi-station-hours` lines:
```yaml
      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.test.js
      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js
      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/facade-contract.test.js
```

- [ ] **Step 5: Mirror, gates, commit**

```bash
P=conf/full_raspberrypi_bcm27xx_bcm2712/files; M=conf/full_raspberrypi_bcm27xx_bcm2709/files
rsync -a --delete $P/usr/share/node-red/osi-agronomy-daily/ $M/usr/share/node-red/osi-agronomy-daily/
for f in usr/share/node-red/package.json usr/share/node-red/package-lock.json usr/share/node-red/osi-lib/index.js usr/share/node-red/osi-lib/index.test.js etc/uci-defaults/98_osi_node_red_seed; do cp $P/$f $M/$f; done
node scripts/verify-helper-registration.js && node scripts/verify-module-file-deploy-coverage.js && node scripts/verify-profile-parity.js && node --test $P/usr/share/node-red/osi-lib/index.test.js && node scripts/verify-agronomy-contract.js
git add $P/usr/share/node-red/osi-agronomy-daily $M/usr/share/node-red/osi-agronomy-daily $P/usr/share/node-red/package.json $P/usr/share/node-red/package-lock.json $M/usr/share/node-red/package.json $M/usr/share/node-red/package-lock.json $P/usr/share/node-red/osi-lib $M/usr/share/node-red/osi-lib $P/etc/uci-defaults/98_osi_node_red_seed $M/etc/uci-defaults/98_osi_node_red_seed deploy.sh .github/workflows/migrations.yml
git commit -m "feat(agronomy-daily): daily ET0/ETc writer with three tiers, frozen Kc snapshots and explicit null reasons"
```
Expected before the commit: registration, deploy coverage and parity OK; the contract verifier prints only the GUI `missing` line.

---

### Task 8: Flow nodes and caller-binding policies

**Files:**
- Modify (by one-shot script): both `flows.json` (two new function nodes `station-hours-fn`, `agronomy-daily-fn`; `weather-provider-fn.wires = [['station-hours-fn']]`; `station-hours-fn.wires = [['agronomy-daily-fn']]`; `agronomy-daily-fn.wires = [[]]`)
- Modify: `scripts/verify-osi-lib-db-caller-binding.js`, `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/verify-flows-size-ratchet-baseline.json`, `scripts/verify-live-gateway-identity.js`
- Scratch: `$SCRATCH/flows-add-agronomy-nodes.js` (never committed)

**Interfaces:**
- Consumes: `runTick` (weather-provider-fn, unchanged text), `aggregateStationHours` (Task 5), `runDaily` (Task 7).

- [ ] **Step 1: Extend the caller-binding verifier first (it fails until the nodes exist)**

In `scripts/verify-osi-lib-db-caller-binding.js`:
1. Add `awaitedCall: /await\s+writerRes\.value\.writeDeviceData\s*\(/,` to the `device-writer` policy.
2. Add three policies:
```js
  'weather-provider': Object.freeze({
    moduleDir: 'osi-weather-provider',
    facadeTestFile: 'facade-contract.test.js',
    reviewedCallerNodeIds: Object.freeze(['weather-provider-fn']),
    requiredFacadeExports: Object.freeze(['runTick']),
    awaitedCall: /await\s+load\.value\.runTick\s*\(/,
  }),
  'station-hours': Object.freeze({
    moduleDir: 'osi-station-hours',
    facadeTestFile: 'facade-contract.test.js',
    reviewedCallerNodeIds: Object.freeze(['station-hours-fn']),
    requiredFacadeExports: Object.freeze(['aggregateStationHours']),
    awaitedCall: /await\s+load\.value\.aggregateStationHours\s*\(/,
  }),
  'agronomy-daily': Object.freeze({
    moduleDir: 'osi-agronomy-daily',
    facadeTestFile: 'facade-contract.test.js',
    reviewedCallerNodeIds: Object.freeze(['agronomy-daily-fn']),
    requiredFacadeExports: Object.freeze(['runDaily']),
    awaitedCall: /await\s+load\.value\.runDaily\s*\(/,
  }),
```
3. Replace `awaitsWriterCall(node)` with `awaitsPolicyCall(node, policy)` returning `policy.awaitedCall.test(node.func)` (false for a node without `func`), and make the failure text generic: `` `[${profile}] ${moduleName}: node ${id} (${node && node.name}) does not match ${policy.awaitedCall} -- against the real osiDb.Database facade the call returns a Promise, so an unawaited call drops its result silently (the PR-M bug)` ``.
4. The missing-facade-test message names `${policy.moduleDir}/${policy.facadeTestFile}` instead of "osi-device-writer's sibling path".

Run: `node scripts/verify-osi-lib-db-caller-binding.js`. Expected: FAIL with `station-hours: no function node found` and `agronomy-daily: no function node found` for both profiles; `OK` for `device-writer` and `weather-provider`.

- [ ] **Step 2: Write the one-shot editor**

`$SCRATCH/flows-add-agronomy-nodes.js`:
```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const REPO_ROOT = process.cwd();
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
function serialize(flows) { return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8'); }
function assertRoundtrip(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) throw new Error('roundtrip guard failed for ' + filePath);
  return parsed;
}
const flows = assertRoundtrip(CANONICAL);
assertRoundtrip(MIRROR);
if (flows.some((n) => n.id === 'station-hours-fn' || n.id === 'agronomy-daily-fn')) throw new Error('nodes already present');
const weather = flows.find((n) => n.id === 'weather-provider-fn');
if (!weather) throw new Error('weather-provider-fn not found');
const client = [
  "  const db = new osiDb.Database('/data/db/farming.db');",
  "  const client = {",
  "    all: (sql, params) => Promise.resolve(db.all(sql, params || [])),",
  "    run: (sql, params) => Promise.resolve(db.run(sql, params || [])).then(() => undefined),",
  "    transaction: (fn) => db.transaction(fn)",
  "  };",
  "  const close = () => new Promise((res) => db.close(() => res()));",
];
const STATION_FUNC = [
  "return (async () => {",
  "  if (msg && msg.payload && msg.payload.skipped) { return null; }",
  "  const load = osiLib.require('station-hours');",
  "  if (!load.ok) { node.error('station hours: module unavailable: ' + load.error); msg.payload = { stationHoursFailed: true }; return msg; }",
  ...client,
  "  try {",
  "    msg.payload = await load.value.aggregateStationHours({ db: client, nowIso: new Date().toISOString(), warn: (m) => node.warn('station hours: ' + m) });",
  "    return msg;",
  "  } catch (error) {",
  "    node.warn('station hours failed: ' + (error && error.message ? error.message : error));",
  "    msg.payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};",
  "    msg.payload.stationHoursFailed = true;",
  "    return msg;",
  "  } finally {",
  "    await close();",
  "  }",
  "})();",
].join('\n');
const DAILY_FUNC = [
  "return (async () => {",
  "  if (msg && msg.payload && msg.payload.skipped) { return null; }",
  "  const load = osiLib.require('agronomy-daily');",
  "  if (!load.ok) { node.error('agronomy daily: module unavailable: ' + load.error); return null; }",
  ...client,
  "  try {",
  "    const summary = await load.value.runDaily({ db: client, nowIso: new Date().toISOString(), deploymentDefault: env.get('OSI_WEATHER_PROVIDER_DEFAULT'), warn: (m) => node.warn('agronomy daily: ' + m) });",
  "    const nulls = summary.nulls ? summary.nulls.length : 0;",
  "    node.status({ fill: summary.skipped ? 'grey' : (nulls ? 'yellow' : 'green'), shape: 'dot', text: summary.skipped ? String(summary.skipped) : summary.days + ' days, ' + nulls + ' null' });",
  "    msg.payload = summary;",
  "    return msg;",
  "  } catch (error) {",
  "    node.warn('agronomy daily failed: ' + (error && error.message ? error.message : error));",
  "    return null;",
  "  } finally {",
  "    await close();",
  "  }",
  "})();",
].join('\n');
if (STATION_FUNC.length >= 1500 || DAILY_FUNC.length >= 1500) throw new Error('node over 1500 chars: ' + STATION_FUNC.length + ' / ' + DAILY_FUNC.length);
const fnNode = (id, name, func, y, wires) => ({
  id, type: 'function', z: weather.z, name, func, outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '',
  libs: [{ var: 'osiLib', module: 'osi-lib' }, { var: 'osiDb', module: 'osi-db-helper' }],
  x: 770, y, wires,
});
weather.wires = [['station-hours-fn']];
// Insert immediately before the journal-v2 replication cluster, as sub-project 1 did:
// migrate-flows-journal-v2-replication.test.js needs that cluster to stay the trailing block.
const at = flows.findIndex((n) => n.id === 'journal-v2-replication-tab');
if (at < 0) throw new Error('journal-v2-replication-tab not found');
flows.splice(at, 0,
  fnNode('station-hours-fn', 'Station hours: aggregate', STATION_FUNC, weather.y + 60, [['agronomy-daily-fn']]),
  fnNode('agronomy-daily-fn', 'Agronomy daily: write days', DAILY_FUNC, weather.y + 120, [[]]));
fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
assertRoundtrip(CANONICAL);
assertRoundtrip(MIRROR);
console.log('added 2 nodes; chars', STATION_FUNC.length, DAILY_FUNC.length);
```
Before running, compare the key set with `weather-provider-fn` (`node -e "const f=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');console.log(Object.keys(f.find(n=>n.id==='weather-provider-fn')))"`) and add any key it carries that `fnNode` omits, with the same value. The facade's `transaction(executor)` hands the executor a scope with `run`, `all`, `get`, `exec` (`osi-db-helper/index.js` `createTransactionScope`), so `transaction: (fn) => db.transaction(fn)` passes it through unchanged. Inside that executor the helpers use only the scope argument (Tasks 5 and 7): the facade runs every call through one queue and the open transaction holds it, so a call on the outer `db` or `client` from inside the executor would wait forever. The `RETURNING` rows of the conditional upserts come back through the scope's `all`, which is how `written` is counted.

Run: `node $SCRATCH/flows-add-agronomy-nodes.js`. Expected: `added 2 nodes; chars` with both numbers below 1500.

- [ ] **Step 3: Flows gate set**

```bash
node scripts/verify-profile-parity.js
node scripts/verify-flows-fn-parse.js
node scripts/flows-bare-require-scan.js
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-osi-lib-db-caller-binding.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-sync-flow.js
```
Expected: parity `All parity checks passed.`; `verify-flows-fn-parse: OK`; bare-require exit 0; wiring `PASS: …`; silent-catch exit 0; stray-DDL exit 0; caller binding `OK` for four modules and `verify-osi-lib-db-caller-binding: OK`; size ratchet: Step 4; sync flow ends `All parity checks passed.` (after Step 4's re-pin).

- [ ] **Step 4: Size ratchet and the identity pin**

```bash
node -e "
const {totalChars}=require('./scripts/flows-size-scan');
const {execFileSync}=require('child_process');
const head=JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','utf8'));
const base=JSON.parse(execFileSync('git',['show','origin/main:conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'],{maxBuffer:64*1024*1024}).toString());
console.log('base',totalChars(base),'head',totalChars(head),'delta',totalChars(head)-totalChars(base));"
```
Set `total_allowance.delta` in `scripts/verify-flows-size-ratchet-allowances.json` to the printed delta (the standing 1007 of `weather-provider-fn` plus the two new nodes' characters) and replace the reason with one sentence naming this feature, the node ids `weather-provider-tick`, `weather-provider-fn`, `station-hours-fn`, `agronomy-daily-fn`, the measured base and head totals, and the date. Run `node scripts/verify-flows-size-ratchet.js --write-baseline`, then `node scripts/verify-flows-size-ratchet.js` (exit 0). In `scripts/verify-live-gateway-identity.js` (the block at lines 1316–1330), change `delta === 1007` and its two messages to the new delta, add one `expectIncludes` line each for `'station-hours-fn'` and `'agronomy-daily-fn'`, and extend the comment above with one paragraph giving the measured numbers. Run `node scripts/verify-live-gateway-identity.js` and `node scripts/verify-sync-flow.js`; both pass.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-osi-lib-db-caller-binding.js scripts/verify-flows-size-ratchet-allowances.json scripts/verify-flows-size-ratchet-baseline.json scripts/verify-live-gateway-identity.js
git commit -m "feat(flows): station-hours and agronomy-daily nodes chained after the weather tick"
```

---

### Task 9: `osi-zone-env` and `zone-env-fn`

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.js`, `index.test.js`; `zone-env-fn` in both `flows.json` (by one-shot script `$SCRATCH/flows-zone-env-daily.js`); `scripts/capture-zone-env-vectors.js`; `docs/contracts/zone-env/MANIFEST.json` and `docs/contracts/zone-env/cases/*` (five cases); `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/verify-flows-size-ratchet-baseline.json`, `scripts/verify-live-gateway-identity.js`; mirror the module to bcm2709

**Interfaces:**
- Consumes: `require('../osi-crop-kc').resolveKc` (Task 2); the rows written by Task 7.
- Produces (module): `buildAgronomic(local, online, forecast, { cropType, phenologicalStage, todayIso, forecastFetchedAt, timezone })`; `buildForecastSection(forecastData, cacheState, expiresAt, { cropType, phenologicalStage }, nowIso)`; `buildWaterDaily({ envRows, estimatedByDate, agronomyRows, zone, todayIso, waterNeededTodayMm, kcSourceToday, stationNames }) → WaterDay[7]`; `mergeDailyIrrigationSplit(sharedDaily, localDaily, todayIso)`; `overlayLocalWaterIrrigationSplit(sharedWater, localWater, todayIso)`. `KC_BY_STAGE` and `deriveCropCoefficient` are deleted. `timezone` in `buildAgronomic`'s options is the zone's timezone, needed to compare `forecastFetchedAt` with `todayIso` in zone-local terms.
- Produces (summary): each `water.daily[]` row gains `demandMm`, `demandSource` (`'calculated'|'forecast'|null`), `et0Mm`, `et0Source`, `et0Tier`, `et0StationId`, `et0StationName`, `kc`, `kcSource`, `cropType`, `phenologicalStage`, `hoursPresent`, `expectedHours`, `nullReason`; a day without a `zone_daily_environment` row has `rainMm: null`. `water.todayDate` is today's zone-local date. `agronomic.current` gains `cropId` and `stage`.

- [ ] **Step 1: Failing tests** (append to `osi-zone-env/index.test.js`)

```js
const kcRows = (overrides = {}) => ({ date: '2026-09-24', et0_mm: 4, et0_source: 'station_fao56', et0_tier: 'station_fao56', et0_station_id: 'S2120AAAA00000001', kc: 1.2, kc_source: 'fao56_crop', crop_type: 'maize', phenological_stage: 'mid_season', etc_mm: 4.8, hours_present: 24, expected_hours: 24, null_reason: null, ...overrides });
const forecastFor = (dates, cacheStatus = 'live') => ({ available: true, cacheStatus, rainFocus: { daily: dates.map((date, i) => ({ date, et0MmDay: 3 + i })) } });

test('KC_BY_STAGE and deriveCropCoefficient are gone', () => {
  assert.equal(ZE.KC_BY_STAGE, undefined);
  assert.equal(ZE.deriveCropCoefficient, undefined);
});

test('buildAgronomic takes the forecast day dated today and the FAO-56 Kc', () => {
  const a = ZE.buildAgronomic(null, null, forecastFor(['2026-09-24', '2026-09-25']), { cropType: 'maize', phenologicalStage: 'mid_season', todayIso: '2026-09-25', forecastFetchedAt: '2026-09-25T05:00:00Z', timezone: 'Europe/Zurich' });
  assert.deepEqual([a.current.referenceEt0MmDay, a.current.cropCoefficientKc, a.current.cropCoefficientSource, a.current.etcMmDay, a.current.cropId, a.current.stage], [4, 1.2, 'fao56_crop', 4.8, 'maize', 'mid_season']);
});

test('offline across midnight: a stale forecast fetched yesterday gives no demand for today', () => {
  const a = ZE.buildAgronomic(null, null, forecastFor(['2026-09-24', '2026-09-25'], 'stale'), { cropType: 'maize', phenologicalStage: 'mid_season', todayIso: '2026-09-25', forecastFetchedAt: '2026-09-24T20:00:00Z', timezone: 'Europe/Zurich' });
  assert.equal(a.current.etcMmDay, null);
  assert.equal(a.current.evapotranspirationSource, 'unavailable');
  const fetchedToday = ZE.buildAgronomic(null, null, forecastFor(['2026-09-25'], 'stale'), { cropType: 'maize', phenologicalStage: 'mid_season', todayIso: '2026-09-25', forecastFetchedAt: '2026-09-24T22:30:00Z', timezone: 'Europe/Zurich' });
  assert.equal(fetchedToday.current.referenceEt0MmDay, 3, '22:30Z is 00:30 local on the 25th');
});

test('buildForecastSection: every day carries the resolved Kc', () => {
  const f = ZE.buildForecastSection({ days: [{ date: '2026-09-25', et0MmDay: 5 }], hours: [] }, 'live', null, { cropType: 'grapevine', phenologicalStage: 'veraison' }, '2026-09-25T08:00:00Z');
  assert.deepEqual([f.rainFocus.daily[0].cropCoefficientKc, f.rainFocus.daily[0].etcMmDay], [0.7, 3.5]);
});

test('buildWaterDaily: seven rows, null rain for a day without a row, calculated days, today as forecast', () => {
  const daily = ZE.buildWaterDaily({
    envRows: [{ date: '2026-09-24', rainfall_mm: 1.2, flow_liters: 0 }],
    estimatedByDate: {},
    agronomyRows: [kcRows(), kcRows({ date: '2026-09-23', et0_mm: null, etc_mm: null, kc: null, kc_source: null, crop_type: null, phenological_stage: null, et0_tier: null, et0_source: null, et0_station_id: null, hours_present: 20, null_reason: 'partial_day' }), kcRows({ date: '2026-09-22', et0_tier: 'provider_hourly_sum', et0_source: 'meteoswiss_hourly_sum', et0_station_id: 'PAY' })],
    zone: { area_m2: 100, irrigation_efficiency_pct: 80 },
    todayIso: '2026-09-25', waterNeededTodayMm: 4.1, kcSourceToday: 'fao56_crop',
    stationNames: { S2120AAAA00000001: 'demo-s2120' },
  });
  assert.equal(daily.length, 7);
  assert.equal(daily[0].date, '2026-09-19');
  const byDate = Object.fromEntries(daily.map((d) => [d.date, d]));
  assert.equal(byDate['2026-09-23'].rainMm, null);
  assert.equal(byDate['2026-09-24'].rainMm, 1.2);
  assert.deepEqual([byDate['2026-09-24'].demandMm, byDate['2026-09-24'].demandSource, byDate['2026-09-24'].et0StationId, byDate['2026-09-24'].et0StationName, byDate['2026-09-24'].kc], [4.8, 'calculated', 'S2120AAAA00000001', 'demo-s2120', 1.2]);
  assert.deepEqual([byDate['2026-09-22'].et0StationId, byDate['2026-09-22'].et0StationName], ['PAY', 'PAY']);
  assert.deepEqual([byDate['2026-09-23'].demandMm, byDate['2026-09-23'].demandSource, byDate['2026-09-23'].nullReason, byDate['2026-09-23'].hoursPresent], [null, null, 'partial_day', 20]);
  assert.deepEqual([byDate['2026-09-21'].demandMm, byDate['2026-09-21'].demandSource, byDate['2026-09-21'].nullReason], [null, null, null]);
  assert.deepEqual([byDate['2026-09-25'].demandMm, byDate['2026-09-25'].demandSource, byDate['2026-09-25'].kcSource], [4.1, 'forecast', 'fao56_crop']);
});

test('overlay: past days take the local demand fields; today keeps the cloud value only while the bundle is current', () => {
  const local = { available: true, waterNeededTodayMm: 4.1, todayDate: '2026-09-25', daily: ZE.buildWaterDaily({ envRows: [], estimatedByDate: {}, agronomyRows: [kcRows()], zone: {}, todayIso: '2026-09-25', waterNeededTodayMm: 4.1, kcSourceToday: 'fao56_crop', stationNames: {} }) };
  const cloudDays = (last) => Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.parse(last + 'T00:00:00Z') - (6 - i) * 86400000).toISOString().slice(0, 10), rainMm: 0.5 }));
  const current = ZE.overlayLocalWaterIrrigationSplit({ available: true, waterNeededTodayMm: 3.3, daily: cloudDays('2026-09-25') }, local, '2026-09-25');
  const today = current.daily.find((d) => d.date === '2026-09-25');
  assert.deepEqual([today.demandMm, today.demandSource, today.kcSource, current.waterNeededTodayMm, current.todayDate], [3.3, 'forecast', 'server', 3.3, '2026-09-25']);
  assert.equal(current.daily.find((d) => d.date === '2026-09-24').demandMm, 4.8);
  assert.equal(current.daily.find((d) => d.date === '2026-09-24').rainMm, 0.5);
  const stale = ZE.overlayLocalWaterIrrigationSplit({ available: true, waterNeededTodayMm: 3.3, daily: cloudDays('2026-09-24') }, local, '2026-09-25');
  assert.equal(stale.daily.length, 7);
  assert.equal(stale.daily.at(-1).date, '2026-09-25');
  assert.deepEqual([stale.daily.at(-1).demandMm, stale.daily.at(-1).demandSource, stale.daily.at(-1).kcSource, stale.waterNeededTodayMm], [4.1, 'forecast', 'local', 4.1]);
});
```
Two existing tests use the old signatures; rewrite them in this step:
- "forecast helpers preserve deterministic provider normalization": `assert.equal(ZE.deriveCropCoefficient('fruit_maturation'), 0.85);` becomes `assert.equal(ZE.deriveCropCoefficient, undefined);`; the `buildForecastSection(merged, 'live', '2026-07-11T10:15:00.000Z', 'fruit_maturation', …)` call passes `{ cropType: null, phenologicalStage: 'fruit_maturation' }` instead of the string, and its `cropCoefficientKc` expectation becomes `0.9` (no crop, legacy `fruit_maturation` = `mid_season`, heuristic 0.90).
- "agronomic and water helpers preserve current assembly behavior": the fixture forecast becomes `{ available: true, cacheStatus: 'live', rainFocus: { totalNext24hMm: 4.2, totalNext72hMm: 12.3, daily: [{ date: '2026-07-11', et0MmDay: 5 }] } }`, the call becomes `ZE.buildAgronomic(local, online, forecast, { cropType: null, phenologicalStage: 'fruit_maturation', todayIso: '2026-07-11', forecastFetchedAt: null, timezone: 'UTC' })`, and the expectations become `cropCoefficientKc 0.9`, `etcMmDay 4.5`. Its `mergeDailyIrrigationSplit` and `overlayLocalWaterIrrigationSplit` assertions stay as they are (fields the local row does not carry are not copied).

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.test.js`. Expected: the six new tests and the two rewritten ones fail until Step 2.

- [ ] **Step 2: Implement in the module**

In `osi-zone-env/index.js`:
- Delete `KC_BY_STAGE` (lines 17–25) and `deriveCropCoefficient` (429–433) and their exports. Add `const { resolveKc } = require('../osi-crop-kc');` at the top.
- `buildForecastSection(forecastData, cacheState, expiresAt, crop, nowIso)`: replace `const kc = deriveCropCoefficient(stage);` with `const kc = resolveKc(crop || {}).kc;`.
- `buildAgronomic(local, online, forecast, options)`:
```js
function buildAgronomic(local, online, forecast, { cropType = null, phenologicalStage = null, todayIso = null, forecastFetchedAt = null, timezone = 'UTC' } = {}) {
  // …temperature/humidity lines unchanged…
  // Today's ET0 is the forecast day dated today, and only from a forecast that
  // is live or was fetched today in the zone's timezone: offline across
  // midnight, today is unknown, never yesterday's value.
  const fresh = !!forecast && (forecast.cacheStatus === 'live' || (forecastFetchedAt != null && localDateIso(forecastFetchedAt, timezone) === todayIso));
  const days = fresh && forecast.rainFocus && Array.isArray(forecast.rainFocus.daily) ? forecast.rainFocus.daily : [];
  const todayRow = todayIso ? days.find((d) => d && d.date === todayIso) : null;
  const et0 = todayRow ? toFiniteNumber(todayRow.et0MmDay) : null;
  const resolved = resolveKc({ cropType, phenologicalStage });
  const kc = resolved.kc;
  // …return object as before, with:
  //   cropCoefficientSource: resolved.kcSource,
  //   cropId: resolved.cropId,
  //   stage: resolved.stage,
}
```
- Add `buildWaterDaily` (moved from the node's `buildWaterHistory`; the loop body is the node's, with the three changes marked):
```js
function buildWaterDaily({ envRows, estimatedByDate, agronomyRows, zone, todayIso, waterNeededTodayMm, kcSourceToday, stationNames }) {
  const startIso = addUtcDays(todayIso, -6) || todayIso;
  const byDate = {};
  for (const row of envRows || []) if (row && row.date) byDate[String(row.date)] = row;
  const agronomyByDate = {};
  for (const row of agronomyRows || []) if (row && row.date) agronomyByDate[String(row.date)] = row;
  const names = stationNames || {};
  const estimated = estimatedByDate || {};
  const daily = [];
  for (let dateIso = startIso; dateIso && dateIso <= todayIso; dateIso = addUtcDays(dateIso, 1)) {
    const row = byDate[dateIso] || null;
    // (1) A day without a rain row is null, never 0 (the cloud's F115 rule).
    const rainMm = row && row.rainfall_mm != null ? round(row.rainfall_mm, 2) : null;
    const measuredIrrigationLiters = round(row ? row.flow_liters : 0, 2) || 0;
    const estimatedIrrigationLiters = round(estimated[dateIso] || 0, 2) || 0;
    const measuredIrrigationNetMm = toEffectiveIrrigationMm(measuredIrrigationLiters, zone && zone.area_m2, zone && zone.irrigation_efficiency_pct);
    const estimatedIrrigationNetMm = toEffectiveIrrigationMm(estimatedIrrigationLiters, zone && zone.area_m2, zone && zone.irrigation_efficiency_pct);
    const day = {
      date: dateIso,
      rainMm,
      irrigationLiters: measuredIrrigationLiters,
      irrigationNetMm: measuredIrrigationNetMm,
      measuredIrrigationLiters,
      estimatedIrrigationLiters,
      measuredIrrigationNetMm,
      estimatedIrrigationNetMm,
      totalWaterMm: measuredIrrigationNetMm != null && rainMm != null ? round(rainMm + measuredIrrigationNetMm, 2) : null,
      estimatedTotalWaterMm: estimatedIrrigationNetMm != null && rainMm != null ? round(rainMm + estimatedIrrigationNetMm, 2) : null,
    };
    // (2) The demand fields of the stored day; (3) today is the forecast.
    const a = agronomyByDate[dateIso] || null;
    if (dateIso === todayIso) {
      Object.assign(day, { demandMm: waterNeededTodayMm != null ? round(waterNeededTodayMm, 2) : null, demandSource: waterNeededTodayMm != null ? 'forecast' : null, et0Mm: null, et0Source: null, et0Tier: null, et0StationId: null, et0StationName: null, kc: null, kcSource: kcSourceToday || null, cropType: null, phenologicalStage: null, hoursPresent: null, expectedHours: null, nullReason: null });
    } else {
      const stationId = a ? a.et0_station_id || null : null;
      Object.assign(day, {
        demandMm: a && a.etc_mm != null ? a.etc_mm : null,
        demandSource: a && a.etc_mm != null ? 'calculated' : null,
        et0Mm: a ? a.et0_mm : null, et0Source: a ? a.et0_source : null, et0Tier: a ? a.et0_tier : null,
        et0StationId: stationId, et0StationName: stationId ? (names[stationId] || stationId) : null,
        kc: a ? a.kc : null, kcSource: a ? a.kc_source : null, cropType: a ? a.crop_type : null, phenologicalStage: a ? a.phenological_stage : null,
        hoursPresent: a ? a.hours_present : null, expectedHours: a ? a.expected_hours : null, nullReason: a ? a.null_reason : null,
      });
    }
    daily.push(day);
    if (dateIso === todayIso) break;
  }
  return daily;
}
```
The station name is the `devices.name` of a deveui; a MeteoSwiss id has no `devices` row and shows as itself.
- `mergeDailyIrrigationSplit(sharedDaily, localDaily, todayIso)`:
```js
const DEMAND_FIELDS = ['demandMm', 'demandSource', 'et0Mm', 'et0Source', 'et0Tier', 'et0StationId', 'et0StationName', 'kc', 'kcSource', 'cropType', 'phenologicalStage', 'hoursPresent', 'expectedHours', 'nullReason'];
const SPLIT_FIELDS = ['irrigationLiters', 'irrigationNetMm', 'measuredIrrigationLiters', 'estimatedIrrigationLiters', 'measuredIrrigationNetMm', 'estimatedIrrigationNetMm', 'estimatedTotalWaterMm'];
function pick(row, fields) { const out = {}; for (const f of fields) if (row[f] !== undefined) out[f] = row[f]; return out; }
function mergeDailyIrrigationSplit(sharedDaily, localDaily, todayIso) {
  const localRows = Array.isArray(localDaily) ? localDaily : [];
  if (!Array.isArray(sharedDaily)) return localRows;
  const localByDate = {};
  for (const row of localRows) if (row && row.date) localByDate[String(row.date)] = row;
  const merged = sharedDaily.map((row) => {
    if (!row || !row.date) return row;
    const local = localByDate[String(row.date)];
    if (!local) return row;
    return { ...row, ...pick(local, SPLIT_FIELDS), ...pick(local, DEMAND_FIELDS) };
  });
  // A bundle that ends before today (stale across midnight) gets the local today row.
  if (todayIso && !merged.some((row) => row && row.date === todayIso) && localByDate[todayIso]) merged.push(localByDate[todayIso]);
  return merged.slice(-7);
}
```
- `overlayLocalWaterIrrigationSplit(sharedWater, localWater, todayIso)`:
```js
function overlayLocalWaterIrrigationSplit(sharedWater, localWater, todayIso) {
  if (!sharedWater || typeof sharedWater !== 'object') return localWater;
  if (!localWater || typeof localWater !== 'object') return sharedWater;
  const sharedDaily = Array.isArray(sharedWater.daily) ? sharedWater.daily : [];
  const last = sharedDaily.length ? sharedDaily[sharedDaily.length - 1] : null;
  const bundleCurrent = !!last && last.date === todayIso;
  const sharedToday = toFiniteNumber(sharedWater.waterNeededTodayMm);
  const daily = mergeDailyIrrigationSplit(sharedWater.daily, localWater.daily, todayIso).map((row) => {
    if (!row || row.date !== todayIso) return row;
    return bundleCurrent
      ? { ...row, demandMm: sharedToday, demandSource: sharedToday != null ? 'forecast' : null, kcSource: 'server' }
      : { ...row, kcSource: 'local' };
  });
  return {
    ...sharedWater,
    available: sharedWater.available || localWater.available,
    irrigationTodayLiters: localWater.irrigationTodayLiters,
    irrigationTodayNetMm: localWater.irrigationTodayNetMm,
    irrigationTodayMeasuredLiters: localWater.irrigationTodayMeasuredLiters,
    irrigationTodayEstimatedLiters: localWater.irrigationTodayEstimatedLiters,
    measuredIrrigationNetMm: localWater.measuredIrrigationNetMm,
    estimatedIrrigationNetMm: localWater.estimatedIrrigationNetMm,
    waterNeededTodayMm: bundleCurrent ? sharedWater.waterNeededTodayMm : localWater.waterNeededTodayMm,
    todayDate: todayIso,
    daily,
  };
}
```
- Export `buildWaterDaily`. Rewrite the existing tests that used the old signatures (Step 1 note). Run the package tests; expected all pass.

- [ ] **Step 3: Edit the node**

`$SCRATCH/flows-zone-env-daily.js` loads both flows.json files with the roundtrip guard (the `serialize`/`assertRoundtrip` pair from Task 8 Step 2), applies these exact string replacements to `zone-env-fn`'s `func`, throws if any `before` string is not found exactly once, writes both profiles and prints the old and new lengths:

1. Zone SELECT: `'SELECT iz.id,iz.name,iz.zone_uuid,iz.timezone,iz.latitude,iz.longitude,iz.gateway_device_eui,iz.phenological_stage,` → `'SELECT iz.id,iz.name,iz.zone_uuid,iz.timezone,iz.latitude,iz.longitude,iz.gateway_device_eui,iz.phenological_stage,iz.crop_type,`.
2. Forecast calls: in `resolveForecast` and `safeResolveForecast` rename the parameter `stage` to `crop` (`async function resolveForecast(zone, location, crop, nowIso)`, the three `ZE.buildForecastSection(…, stage, nowIso)` calls become `…, crop, nowIso)`, `async function safeResolveForecast(zone, location, crop, nowIso)` and its inner call `resolveForecast(zone, location, crop, nowIso)`).
3. Main block: `const localForecast = await safeResolveForecast(zone, location, zone.phenological_stage, nowIso);\n  const localAgronomic = ZE.buildAgronomic(local, localOnline, localForecast, zone.phenological_stage);` →
```js
  const crop = { cropType: zone.crop_type, phenologicalStage: zone.phenological_stage };
  const localForecast = await safeResolveForecast(zone, location, crop, nowIso);
  const fc = await getCache(zone.id, 'forecast');
  const localAgronomic = ZE.buildAgronomic(local, localOnline, localForecast, { ...crop, todayIso: ZE.localDateIso(nowIso, zone.timezone, Date.now()) || nowIso.slice(0, 10), forecastFetchedAt: fc ? fc.fetchedAt : null, timezone: zone.timezone });
```
(`getCache` already returns `fetchedAt` from `zone_weather_cache.fetched_at`; after a fresh fetch `putCache` has written `nowIso` there.)
4. Replace the whole `async function buildWaterHistory(zone, todayIso) { … }` with:
```js
async function buildWaterHistory(zone, todayIso, waterNeededTodayMm, kcSourceToday) {
  const startIso = ZE.addUtcDays(todayIso, -6) || todayIso;
  const w = ' WHERE zone_id=' + Number(zone.id) + ' AND date >= ' + s(startIso) + ' AND date <= ' + s(todayIso);
  const envRows = await q('SELECT date,rainfall_mm,flow_liters FROM zone_daily_environment' + w + ' ORDER BY date ASC');
  const agronomyRows = await q('SELECT date,et0_mm,et0_source,et0_tier,et0_station_id,kc,kc_source,crop_type,phenological_stage,etc_mm,hours_present,expected_hours,null_reason FROM zone_daily_agronomy' + w);
  const stationNames = {};
  for (const r of await q('SELECT deveui,name FROM devices WHERE deveui IN (SELECT et0_station_id FROM zone_daily_agronomy' + w + ')')) stationNames[r.deveui] = r.name;
  const estimatedByDate = await loadEstimatedIrrigationByLocalDate(zone, startIso, todayIso);
  return ZE.buildWaterDaily({ envRows, estimatedByDate, agronomyRows, zone, todayIso, waterNeededTodayMm, kcSourceToday, stationNames });
}
```
5. In `buildWaterEnvironment`'s return object: `    daily: await buildWaterHistory(zone, todayIso),` → `    todayDate: todayIso,\n    daily: await buildWaterHistory(zone, todayIso, waterNeededTodayMm != null ? ZE.round(waterNeededTodayMm, 2) : null, agronomic && agronomic.current ? agronomic.current.cropCoefficientSource : null),`.
6. Overlay: `ZE.overlayLocalWaterIrrigationSplit(sharedSummary.water, water)` → `ZE.overlayLocalWaterIrrigationSplit(sharedSummary.water, water, water.todayDate)`.

Run `node $SCRATCH/flows-zone-env-daily.js`. Expected: the new length below the old one (the extraction removes about 1,390 characters and the edits add about 790; net about −600).

- [ ] **Step 4: Golden vectors: per-case seeds and a cloud bundle stub**

Changes to `scripts/capture-zone-env-vectors.js`:
1. `CASES = ['local-openmeteo-water', 'provider-unavailable', 'crop-table-kc', 'shared-server', 'shared-server-stale']`.
2. Add `CASE_SEEDS`, keyed by case, each `{ zoneUpdate?: { column: value }, userUpdate?: { column: value }, rows: { <table>: [ {column: value} ] }, cloudBundle?: object }`:
   - `local-openmeteo-water`, `provider-unavailable`: `{ rows: {} }`.
   - `crop-table-kc`: `zoneUpdate: { crop_type: 'maize', phenological_stage: 'mid_season' }`; `rows.zone_daily_agronomy`: six rows for zone 1 dated `2026-07-05` to `2026-07-10`: 07-05 and 07-06 `open_meteo_hourly_sum` (`et0_mm` 4.6 and 4.2, `et0_tier 'provider_hourly_sum'`, `location_key 'open_meteo:46.80:8.20'`, `kc` 1.2, `kc_source 'fao56_crop'`, `crop_type 'maize'`, `phenological_stage 'mid_season'`, `etc_mm` 5.52 and 5.04, 24/24); 07-07 null (`null_reason 'partial_day'`, `hours_present` 20, `expected_hours` 24, snapshot columns null); 07-08 `station_fao56` with `et0_station_id 'S2120VECTOR0001'` (`et0_mm` 5.0, `etc_mm` 6.0); 07-09 `meteoswiss_hourly_sum` with `et0_station_id 'PAY'` (`et0_mm` 3.9, `kc` 0.75, `kc_source 'fao56_crop'`, `phenological_stage 'development'`, `etc_mm` 2.93); 07-10 null `pending` (`hours_present` 22, `expected_hours` 24); every row `computed_at '2026-07-11T08:00:00.000Z'`. `rows.weather_station_hours`: the 24 rows of the station day behind 07-08 (`deveui 'S2120VECTOR0001'`, hour starts `2026-07-08T00:00:00Z` … `23:00:00Z`, min 14, max 26, 60 %, 1.5 m/s, radiation 600 W/m² for hours 6–17 else 0, `sample_count` 4, `computed_at` as above), recorded as the source of that day.
   - `shared-server`: `userUpdate: { auth_mode: 'server', server_url: 'https://cloud.example.test', server_sync_token: 'vector-token' }`; `rows.zone_daily_agronomy`: the 07-08 station row of `crop-table-kc`; `cloudBundle`: `{ zoneId: 1, zoneName: 'Vector Zone', water: { available: true, waterNeededTodayMm: 3.1, rainTodayMm: 0.8, rainSource: 'gauge', daily: [seven rows dated 2026-07-05 … 2026-07-11, each { date, rainMm: 0.4, irrigationLiters: 0, irrigationNetMm: 0, totalWaterMm: 0.4 }] } }`; `rows.zone_shared_environment`: one row `{ zone_uuid: 'zone-env-vector-zone', zone_id: 1, gateway_device_eui: '0016C001F1000001', summary_json: JSON.stringify(cloudBundle), shared_generated_at: '2026-07-11T09:57:00.000Z', shared_observed_at: '2026-07-11T09:57:00.000Z', last_received_at: '2026-07-11T09:58:00.000Z' }` (two minutes old, so the node uses it without HTTP).
   - `shared-server-stale`: as `shared-server`, with the bundle's seven days dated `2026-07-04` … `2026-07-10`.
3. `seedDb(dbPath, seedRows)` runs the existing base seed, then `UPDATE users SET … WHERE id = 1` from `userUpdate`, `UPDATE irrigation_zones SET … WHERE id = 1` from `zoneUpdate`, then inserts every row of `rows` with a generic `INSERT INTO <table> (<keys>) VALUES (<sqlString(value)>…)` in the order `weather_station_hours`, `zone_daily_agronomy`, `zone_shared_environment`.
4. `inputFixture(caseName)` adds `seedRows: CASE_SEEDS[caseName]` to the object it returns, so each case's committed `input.json` carries its own rows.
5. `runCase(caseName, seedRows)` seeds from `seedRows`; `capture()` passes `CASE_SEEDS[caseName]`; `verify()` passes `readJson(<case>.input.json).seedRows`, so the committed input is what the check replays.
6. `responseFor(url)` answers the cloud bundle: `if (url.includes('/environment-bundles')) return [{ zoneUuid: 'zone-env-vector-zone', summary: currentBundle }];` where `currentBundle` is a module variable set by `runCase` from `seedRows.cloudBundle` (and `throw` as today when it is unset). `makeHttpStub(mode)` keeps `'fail'` for `provider-unavailable`.
7. The osiLib stub is unchanged: `osi-zone-env` reaches `osi-crop-kc` through a relative `require`.

The two existing cases change on re-capture: their zone's stage `fruit_maturation` is read as `mid_season` with no crop, so the Kc becomes the heuristic 0.90 (was 0.85), and days without a rain row now show `rainMm: null`. Run:
```bash
node scripts/capture-zone-env-vectors.js --capture
node scripts/capture-zone-env-vectors.js --verify
git diff --stat docs/contracts/zone-env
```
Expected: five `Captured` lines, five `Verified` lines; `MANIFEST.json` lists five cases. Read the `crop-table-kc` expected file: 07-08 has `et0StationName 'Weather Station'`, 07-09 has `et0StationId 'PAY'` and `et0StationName 'PAY'`, 07-07 `nullReason 'partial_day'`, 07-10 `nullReason 'pending'`, 07-11 `demandSource 'forecast'`, and `water.todayDate '2026-07-11'`. In `shared-server` today's row has `kcSource 'server'` and `demandMm 3.1`; in `shared-server-stale` it has `kcSource 'local'`.

- [ ] **Step 5: Re-measure the ratchet after the shrink**

Run the measuring one-liner of Task 8 Step 4. Set `total_allowance.delta` to the new printed delta and add to its reason the `zone-env-fn` shrink with the node's old and new lengths. If `zone-env-fn` is now shorter than at `origin/main`, no `node_allowances` entry is needed; if it is longer, add one with the exact delta. Then `node scripts/verify-flows-size-ratchet.js --write-baseline`, `node scripts/verify-flows-size-ratchet.js` (exit 0), re-pin `scripts/verify-live-gateway-identity.js` to the new delta (same block as Task 8 Step 4, one more comment paragraph), and run `node scripts/verify-live-gateway-identity.js`.

- [ ] **Step 6: Package tests, flows gates, commit**

```bash
P=conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red
node --test $P/osi-zone-env/index.test.js
cp $P/osi-zone-env/index.js $P/osi-zone-env/index.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-env/
node scripts/verify-profile-parity.js && node scripts/verify-flows-fn-parse.js && node scripts/flows-bare-require-scan.js && node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/verify-flows-size-ratchet.js && node scripts/verify-sync-flow.js && node scripts/capture-zone-env-vectors.js --verify
git add $P/osi-zone-env conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-env conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/capture-zone-env-vectors.js docs/contracts/zone-env scripts/verify-flows-size-ratchet-allowances.json scripts/verify-flows-size-ratchet-baseline.json scripts/verify-live-gateway-identity.js
git commit -m "feat(zone-env): FAO-56 Kc resolver, fresh-forecast gate, per-day demand rows and linked-gateway overlay"
```

---

### Task 10: GUI zone settings and the Kc module

**Files:**
- Create: `web/react-gui/src/agronomy/crop-kc.json` (byte copy: `cp docs/contracts/agronomy/crop-kc.json web/react-gui/src/agronomy/crop-kc.json`), `web/react-gui/src/agronomy/cropKc.ts`, `web/react-gui/src/agronomy/__tests__/cropKc.test.ts`, `web/react-gui/tests/agronomyKcVectors.test.ts`, `web/react-gui/src/components/farming/environment/__tests__/AgronomicTab.test.tsx`
- Delete: `web/react-gui/src/components/farming/cropKc.ts` (only `ZoneConfigModal.tsx` and `AgronomicTab.tsx` import it). Keep `predictionCropCatalog.json` and `scripts/verify-prediction-crop-catalog.js`.
- Modify: `web/react-gui/package.json` (`test:unit:vitest` list), `ZoneConfigModal.tsx`, `AdvancedScheduleDrawer.tsx`, `environment/AgronomicTab.tsx`, `src/components/farming/__tests__/ZoneConfigModal.test.tsx`, the seven `public/locales/*/devices.json`, `tests/zoneFormLocales.test.ts`, `tests/waterCardLocales.test.ts`, `docs/i18n/pending-luganda-translations.md`, `.github/workflows/migrations.yml` (the contract verifier line)

**Interfaces:**
- Produces (`src/agronomy/cropKc.ts`): `CATALOGUE`, `STAGES`, `type StageId`, `type StageFamily`, `type KcSource = 'fao56_crop'|'fao56_crop_stage_unset'|'heuristic_phenology'`, `normalizeStage(value) → StageId|null`, `cropById(id) → CropEntry|null`, `resolveKc({ cropType, phenologicalStage }) → { kc, kcSource, cropId, stage }`, `stageFamily(cropType) → StageFamily`, `CROP_OPTION_GROUPS: Array<{ group, crops: Array<{ crop, variants }> }>`, `PREDICTION_CROP_NAMES: string[]`.

- [ ] **Step 0: Install dependencies (no build)**

Run: `cd web/react-gui && npm ci` (from the worktree root; then return to the root for the remaining steps). Expected: exit 0. Never run `npm run build` on this workstation.

- [ ] **Step 1: Put the two test directories on the vitest list**

In `web/react-gui/package.json`, `test:unit:vitest` gets ` src/agronomy/__tests__ src/components/farming/environment/__tests__` appended to its directory list, before `--passWithNoTests`. Without this, vitest never sees the new tests.

- [ ] **Step 2: Failing tests**

`web/react-gui/tests/agronomyKcVectors.test.ts` (tsx runner; reads the contract the way `tests/analysis-locales.test.ts` reads locale files):
```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { resolveKc } from '../src/agronomy/cropKc.ts';

const contractDir = join(import.meta.dirname, '..', '..', '..', 'docs', 'contracts', 'agronomy');

test('the GUI resolver reproduces every contract Kc vector', () => {
  const vectors = JSON.parse(readFileSync(join(contractDir, 'kc-vectors.json'), 'utf8'));
  assert.equal(vectors.length, 1252);
  for (const v of vectors) {
    assert.deepEqual(resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage }), { kc: v.kc, kcSource: v.kcSource, cropId: v.cropId, stage: v.stage }, JSON.stringify(v));
  }
});

test('the GUI copy of crop-kc.json is byte-identical to the contract', () => {
  assert.equal(readFileSync(join(import.meta.dirname, '..', 'src', 'agronomy', 'crop-kc.json'), 'utf8'), readFileSync(join(contractDir, 'crop-kc.json'), 'utf8'));
});
```

`web/react-gui/src/agronomy/__tests__/cropKc.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CROP_OPTION_GROUPS, cropById, normalizeStage, resolveKc, stageFamily } from '../cropKc';

describe('cropKc', () => {
  it('groups the 136 crops into 15 FAO groups with variants under their default', () => {
    expect(CROP_OPTION_GROUPS).toHaveLength(15);
    const total = CROP_OPTION_GROUPS.reduce((n, g) => n + g.crops.reduce((m, c) => m + 1 + c.variants.length, 0), 0);
    expect(total).toBe(136);
    const grapes = CROP_OPTION_GROUPS.find((g) => g.group.id === 'grapes_berries')!.crops.find((c) => c.crop.id === 'grapevine')!;
    expect(grapes.variants.map((v) => v.id)).toEqual(['grapes_table']);
  });
  it('maps legacy stages and uses two label families', () => {
    expect(normalizeStage('veraison')).toBe('mid_season');
    expect(normalizeStage('default')).toBeNull();
    expect(stageFamily('grapevine')).toBe('woody');
    expect(stageFamily('citrus_50_cover')).toBe('woody');
    expect(stageFamily('maize')).toBe('annual');
    expect(stageFamily('banana')).toBe('annual');
    expect(stageFamily('other')).toBe('annual');
  });
  it('resolves grapevine at veraison to the wine row', () => {
    expect(resolveKc({ cropType: 'grapevine', phenologicalStage: 'veraison' })).toEqual({ kc: 0.7, kcSource: 'fao56_crop', cropId: 'grapevine', stage: 'mid_season' });
    expect(cropById('pear')?.kc_mid).toBe(0.95);
  });
});
```

`web/react-gui/src/components/farming/environment/__tests__/AgronomicTab.test.tsx`:
```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import enDevices from '../../../../../public/locales/en/devices.json';
import { AgronomicTab } from '../AgronomicTab';

function i18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', defaultNS: 'devices', ns: ['devices'], resources: { en: { devices: enDevices } }, interpolation: { escapeValue: false }, initImmediate: false });
  return instance;
}
const agronomic = { preferredSource: 'local', current: { thermodynamicSource: 'local', evapotranspirationSource: 'open_meteo', cropCoefficientSource: 'unavailable', airTemperatureC: 20, relativeHumidityPct: 60, vpdKpa: 0.9, dewPointC: 12, heatIndexC: 20, thi: 66, referenceEt0MmDay: 4, cropCoefficientKc: null, etcMmDay: null } };
afterEach(cleanup);

describe('AgronomicTab Kc', () => {
  it('resolves the FAO-56 Kc, labels its source with the kcSource keys, and keeps the explanation in a HelpTip', () => {
    render(<I18nextProvider i18n={i18n()}><AgronomicTab agronomic={agronomic as never} cropType="maize" phenologicalStage="veraison" /></I18nextProvider>);
    expect(screen.getByText('1.20')).toBeInTheDocument();
    expect(screen.getByText('Maize (grain), Mid-season')).toBeInTheDocument();
    expect(screen.queryByText(/FAO-56 Kc for Maize/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'About the crop coefficient' }));
    expect(screen.getByText('FAO-56 Kc for Maize (grain): initial 0.30, mid-season 1.20, end 0.35. Current stage: Mid-season.')).toBeInTheDocument();
  });
});
```

`ZoneConfigModal.test.tsx`: keep the existing case (a zone with no stored stage saves `{ notes }` only). Add, inside its `describe`:
```tsx
  it('shows a legacy stored stage mapped and does not write it back when only notes change', async () => {
    const onSaved = vi.fn();
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'grapevine', phenologicalStage: 'veraison' }, onClose: vi.fn(), onSaved }));
    const stage = screen.getByLabelText('Phenological stage') as HTMLSelectElement;
    expect(stage.value).toBe('mid_season');
    expect(stage.selectedOptions[0].textContent).toBe('Mid-season (fruit growth, ripening)');
    fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { notes: 'x' }));
  });

  it('writes the FAO key when the user picks a stage, and labels stages by crop family', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize' }, onClose: vi.fn(), onSaved: vi.fn() }));
    const stage = screen.getByLabelText('Phenological stage') as HTMLSelectElement;
    expect([...stage.options].map((o) => o.textContent)).toEqual(['Not set', 'Initial (sowing, emergence)', 'Development (canopy closing)', 'Mid-season (full cover, flowering)', 'Late season (ripening, harvest)', 'Dormancy (no crop)']);
    fireEvent.change(stage, { target: { value: 'late_season' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'late_season' }));
  });

  it('lists the whole catalogue in native groups and explains stages in a HelpTip', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone, onClose: vi.fn(), onSaved: vi.fn() }));
    const crop = screen.getByLabelText('Crop') as HTMLSelectElement;
    expect(crop.querySelectorAll('optgroup')).toHaveLength(15);
    expect(crop.querySelectorAll('option')).toHaveLength(1 + 136 + 1);
    expect(screen.queryByText(/FAO-56 growth stages set the crop coefficient/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'About growth stages' }));
    expect(screen.getByText(/FAO-56 growth stages set the crop coefficient/)).toBeInTheDocument();
  });
```
(`vi.clearAllMocks()` runs in the file's existing `beforeEach`; if the crop `<select>` has no accessible name, give it `aria-label` from the same `zoneConfig.crop` key in Step 3.)

Run: `cd web/react-gui && npm run test:unit`. Expected: the new tests fail (module `src/agronomy/cropKc` missing).

- [ ] **Step 3: Implement `src/agronomy/cropKc.ts`**

```ts
import catalogueJson from './crop-kc.json';
import predictionCropCatalog from '../components/farming/predictionCropCatalog.json';

/** The FAO-56 Kc resolver, the GUI copy of osi-crop-kc (same contract vectors). */
export type StageId = 'initial' | 'development' | 'mid_season' | 'late_season' | 'dormancy';
export type StageFamily = 'woody' | 'annual';
export type KcSource = 'fao56_crop' | 'fao56_crop_stage_unset' | 'heuristic_phenology';
export interface CropEntry { id: string; group: string; label: string; kc_ini: number; kc_mid: number; kc_end: number; variant_of: string | null; fao_row: string | null }
export interface CropGroupEntry { id: string; order: number; label: string; stageFamily: StageFamily }
interface Catalogue { version: number; luxPerWm2: number; stationWindHeightM: number; stages: Array<{ id: StageId; order: number; label: string }>; groups: CropGroupEntry[]; crops: CropEntry[] }

export const CATALOGUE = catalogueJson as Catalogue;
export const STAGES: StageId[] = ['initial', 'development', 'mid_season', 'late_season', 'dormancy'];
const LEGACY: Record<string, StageId> = {
  budbreak: 'initial', bud_break: 'initial',
  fruitset: 'development', cell_division: 'development', cell_expansion: 'development',
  veraison: 'mid_season', fruit_maturation: 'mid_season',
  harvest: 'late_season', post_harvest: 'late_season',
  dormancy: 'dormancy',
};
const HEURISTIC: Record<StageId | 'unset', number> = { initial: 0.45, development: 0.7, mid_season: 0.9, late_season: 0.6, dormancy: 0.25, unset: 0.75 };
const BY_ID = new Map(CATALOGUE.crops.map((crop) => [crop.id, crop]));
const round2 = (v: number) => Math.round(v * 100) / 100;

export function normalizeStage(value: unknown): StageId | null {
  const s = String(value ?? '').trim().toLowerCase();
  if ((STAGES as string[]).includes(s)) return s as StageId;
  return LEGACY[s] ?? null;
}

export function cropById(id: unknown): CropEntry | null {
  return BY_ID.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

export function resolveKc({ cropType, phenologicalStage }: { cropType: unknown; phenologicalStage: unknown }): { kc: number; kcSource: KcSource; cropId: string | null; stage: StageId | null } {
  const stage = normalizeStage(phenologicalStage);
  const crop = cropById(cropType);
  if (!crop) return { kc: HEURISTIC[stage ?? 'unset'], kcSource: 'heuristic_phenology', cropId: null, stage };
  let kc: number;
  let kcSource: KcSource = 'fao56_crop';
  if (stage === 'initial') kc = crop.kc_ini;
  else if (stage === 'development') kc = (crop.kc_ini + crop.kc_mid) / 2;
  else if (stage === 'mid_season') kc = crop.kc_mid;
  else if (stage === 'late_season') kc = crop.kc_end;
  else if (stage === 'dormancy') kc = 0.25;
  else { kc = crop.kc_mid; kcSource = 'fao56_crop_stage_unset'; }
  return { kc: round2(kc), kcSource, cropId: crop.id, stage };
}

export function stageFamily(cropType: unknown): StageFamily {
  const crop = cropById(cropType);
  return CATALOGUE.groups.find((g) => g.id === crop?.group)?.stageFamily ?? 'annual';
}

export const CROP_OPTION_GROUPS = [...CATALOGUE.groups].sort((a, b) => a.order - b.order).map((group) => ({
  group,
  crops: CATALOGUE.crops.filter((c) => c.group === group.id && !c.variant_of).map((crop) => ({ crop, variants: CATALOGUE.crops.filter((v) => v.variant_of === crop.id) })),
}));

export const PREDICTION_CROP_NAMES: string[] = (predictionCropCatalog as Array<{ displayName: string }>).map((c) => c.displayName);
```

- [ ] **Step 4: `ZoneConfigModal.tsx` and `AdvancedScheduleDrawer.tsx`**

`ZoneConfigModal.tsx`:
- Import `{ CROP_OPTION_GROUPS, PREDICTION_CROP_NAMES, STAGES, cropById, normalizeStage, stageFamily }` from `'../../agronomy/cropKc'` and `{ HelpTip }` from `'./shared/HelpTip'`; remove the `./cropKc` import and the `PHENOLOGICAL_STAGES` constant.
- State: `useState(normalizeStage(zone.phenologicalStage) ?? '')` and the same in the sync effect.
- Save: `const storedStage = normalizeStage(zone.phenologicalStage) ?? '';` then `if (storedStage !== phenologicalStage) payload.phenologicalStage = phenologicalStage || 'default';` (the normalised stored value is compared, so an untouched legacy value is never written).
- `hasLegacyCrop`: `Boolean(cropType && cropType !== 'other' && !cropById(cropType))`.
- Crop label row: `<div className="mb-2 flex flex-wrap items-center gap-2">` holding the existing `<label>` and `<HelpTip label={t('zoneConfig.cropHelpLabel', { defaultValue: 'About the crop list' })}>{t('zoneConfig.cropHelp', { crops: PREDICTION_CROP_NAMES.join(', '), defaultValue: 'Crop coefficients follow FAO-56 Table 12. The prediction advisor supports {{crops}} only.' })}</HelpTip>`.
- Crop `<select>` (native, so a typed letter jumps to the next crop):
```tsx
<option value="">{t('zoneConfig.selectCrop', { defaultValue: '— Select prediction crop —' })}</option>
{hasLegacyCrop && <option value={cropType}>{cropType}</option>}
{CROP_OPTION_GROUPS.map(({ group, crops }) => (
  <optgroup key={group.id} label={t(`zoneConfig.cropGroup.${group.id}`, { defaultValue: group.label })}>
    {crops.flatMap(({ crop, variants }) => [
      <option key={crop.id} value={crop.id}>{crop.label}</option>,
      ...variants.map((v) => <option key={v.id} value={v.id}>{' ' + v.label}</option>),
    ])}
  </optgroup>
))}
<option value="other">{t('zoneConfig.cropOther', { defaultValue: 'Other crop' })}</option>
```
- Stage field: label row as for the crop, with `<HelpTip label={t('zoneConfig.stageHelpLabel', { defaultValue: 'About growth stages' })}>{t('zoneConfig.stageHelp', { defaultValue: 'FAO-56 growth stages set the crop coefficient Kc: initial until about 10 % ground cover, development until full cover, mid-season until maturity starts, late season until harvest or leaf fall. Dormancy uses Kc 0.25.' })}</HelpTip>`; the options:
```tsx
<option value="">{t('zoneConfig.stage.unset', { defaultValue: 'Not set' })}</option>
{STAGES.map((id) => (
  <option key={id} value={id}>{t(`zoneConfig.stageLabel.${stageFamily(cropType)}.${id}`, { defaultValue: t(`zoneConfig.stage.${id}`, { defaultValue: id }) })}</option>
))}
```
The option carries no `title` attribute.

`AdvancedScheduleDrawer.tsx`: remove its `PHENOLOGICAL_STAGES`; state `normalizeStage(zone.phenologicalStage) ?? ''` (also in the sync effect); the `<select>` renders the same "Not set" option and `STAGES` options with `zoneConfig.stageLabel.${stageFamily(zone.cropType)}.${id}` labels; `onChange` saves `e.target.value || 'default'`. `AdvancedScheduleDrawer.test.tsx`: update any assertion on the old option texts to the new labels.

- [ ] **Step 5: `AgronomicTab.tsx`**

- Import `{ cropById, resolveKc }` from `'../../../agronomy/cropKc'` and `{ HelpTip }` from `'../shared/HelpTip'`; remove the `getCropKc`/`getCropEntry` import.
- In `ETSection`: `const resolved = resolveKc({ cropType, phenologicalStage }); const kc = serverKc ?? resolved.kc; const kcSource = serverKc != null ? serverKcSource : resolved.kcSource; const etc = serverEtc ?? (et0 != null ? et0 * kc : null); const crop = cropById(cropType);`.
- The Kc cell label row gets `<HelpTip label={t('environment.agronomic.kcHelpLabel', { defaultValue: 'About the crop coefficient' })}>` whose text is `t('environment.agronomic.kcHelp', { crop: crop.label, ini: crop.kc_ini.toFixed(2), mid: crop.kc_mid.toFixed(2), end: crop.kc_end.toFixed(2), stage: stageLabel, defaultValue: 'FAO-56 Kc for {{crop}}: initial {{ini}}, mid-season {{mid}}, end {{end}}. Current stage: {{stage}}.' })`, rendered only when `crop` is set; `stageLabel` is `resolved.stage ? t(\`zoneConfig.stage.${resolved.stage}\`) : t('environment.water.stageNotSet', { defaultValue: 'stage not set' })`.
- The Kc source label: `t(\`environment.water.kcSource.${kcSource}\`, { crop: crop?.label ?? '', stage: stageLabel, defaultValue: kcSource })` for the three resolver sources; a server-provided source keeps `SourceLabel` (`environment.source.*`, untouched).
- The caption paragraph "Kc is an FAO-56 estimate for …" (the `{kcSource === 'fao56_estimate' && cropEntry && (<p …>)}` block) is deleted; its content is the HelpTip above. The raw stage key is no longer printed.

- [ ] **Step 6: Locale keys (en value given; translate into de-CH, fr, it, es, pt; lg gets the English text)**

In `public/locales/<lang>/devices.json`, all seven files.

Removed (retired): `zoneConfig.stage.default`, `zoneConfig.stage.budbreak`, `zoneConfig.stage.fruitset`, `zoneConfig.stage.veraison`, `zoneConfig.stage.harvest`.

Kept: `zoneConfig.stage.dormancy` "Dormancy".

Added under `zoneConfig`:
- `stage.unset` "Not set"; `stage.initial` "Initial"; `stage.development` "Crop development"; `stage.mid_season` "Mid-season"; `stage.late_season` "Late season"
- `stageLabel.woody.initial` "Initial (bud break)"; `stageLabel.woody.development` "Development (flowering, fruit set)"; `stageLabel.woody.mid_season` "Mid-season (fruit growth, ripening)"; `stageLabel.woody.late_season` "Late season (after harvest, until leaf fall)"; `stageLabel.woody.dormancy` "Dormancy (winter rest)"
- `stageLabel.annual.initial` "Initial (sowing, emergence)"; `stageLabel.annual.development` "Development (canopy closing)"; `stageLabel.annual.mid_season` "Mid-season (full cover, flowering)"; `stageLabel.annual.late_season` "Late season (ripening, harvest)"; `stageLabel.annual.dormancy` "Dormancy (no crop)"
- `stageHelpLabel` "About growth stages"; `stageHelp` "FAO-56 growth stages set the crop coefficient Kc: initial until about 10 % ground cover, development until full cover, mid-season until maturity starts, late season until harvest or leaf fall. Dormancy uses Kc 0.25."
- `cropHelpLabel` "About the crop list"; `cropHelp` "Crop coefficients follow FAO-56 Table 12. The prediction advisor supports {{crops}} only."; `cropOther` "Other crop"
- `cropGroup.small_vegetables` "Small vegetables"; `cropGroup.vegetables_solanum` "Tomato family"; `cropGroup.vegetables_cucumber` "Cucumber family"; `cropGroup.roots_tubers` "Roots and tubers"; `cropGroup.legumes` "Legumes"; `cropGroup.perennial_vegetables` "Perennial vegetables"; `cropGroup.fibre` "Fibre crops"; `cropGroup.oil_crops` "Oil crops"; `cropGroup.cereals` "Cereals"; `cropGroup.forages` "Forages"; `cropGroup.sugar_cane` "Sugarcane"; `cropGroup.tropical_fruits` "Tropical fruits and trees"; `cropGroup.grapes_berries` "Grapes and berries"; `cropGroup.fruit_trees` "Fruit trees"; `cropGroup.wetlands` "Wetlands"

Added under `environment`:
- `agronomic.kcHelpLabel` "About the crop coefficient"; `agronomic.kcHelp` "FAO-56 Kc for {{crop}}: initial {{ini}}, mid-season {{mid}}, end {{end}}. Current stage: {{stage}}."
- `water.kcSource.fao56_crop` "{{crop}}, {{stage}}"; `water.kcSource.fao56_crop_stage_unset` "{{crop}}, stage not set"; `water.kcSource.heuristic_phenology` "no crop from the FAO-56 list, {{stage}}"; `water.kcSource.server` "OSI Cloud"; `water.kcSource.local` "this gateway"; `water.stageNotSet` "stage not set"

Crop names in the selector are the catalogue's English `label` values in every locale; translating 136 names is outside this sub-project.

Hand-listed tests:
- `tests/zoneFormLocales.test.ts` `KEYS`: remove the five retired `zoneConfig.stage.*` keys; add every `zoneConfig.*` key above and the two `environment.agronomic.*` keys.
- `tests/waterCardLocales.test.ts` `DEVICES_KEYS`: add the six `environment.water.kcSource.*` / `stageNotSet` keys; add to `REVIEWED_IDENTICAL` the pairs `<locale>:environment.water.kcSource.fao56_crop` and `<locale>:environment.water.kcSource.server` for de-CH, es, fr, it, pt (a pure placeholder string and a product name).
- `docs/i18n/pending-luganda-translations.md`: one row in the `devices.json` tables listing the new `zoneConfig.*`, `environment.agronomic.*` and `environment.water.kcSource.*` keys with the reason "Added by the daily agronomy record (FAO-56 crop and stage settings, 2026-09-26); no human Luganda pass yet, so `lg` ships the English source text", and the five retired stage keys removed from the `zoneConfig.*` row's count.

- [ ] **Step 7: CI line for the contract verifier**

`.github/workflows/migrations.yml`: after `      - run: node scripts/verify-helper-registration.js` (line 87) add `      - run: node scripts/verify-agronomy-contract.js`.

- [ ] **Step 8: Gates and commit**

```bash
git rm web/react-gui/src/components/farming/cropKc.ts
cd web/react-gui && npm run test:unit && npm run typecheck && cd ../..
node scripts/verify-agronomy-contract.js
node .claude/skills/anti-slop-writing/slop-check.js docs/i18n/pending-luganda-translations.md
git add web/react-gui/package.json web/react-gui/src/agronomy web/react-gui/tests/agronomyKcVectors.test.ts web/react-gui/src/components/farming web/react-gui/public/locales web/react-gui/tests/zoneFormLocales.test.ts web/react-gui/tests/waterCardLocales.test.ts docs/i18n/pending-luganda-translations.md .github/workflows/migrations.yml
git commit -m "feat(gui): FAO-56 crop catalogue and growth stages in zone settings"
```
Expected: `test:unit` green (tsx runner and vitest, including the three new vitest files), `typecheck` exit 0, `verify-agronomy-contract: OK (136 crops, …)`, slop PASS.

---

### Task 11: GUI Water tab (W53 port with per-day demand)

**Files:**
- Create: `web/react-gui/src/components/farming/environment/waterChart.ts`, `…/environment/__tests__/waterChart.test.ts`, `…/environment/__tests__/WaterTab.trend.test.tsx`
- Modify: `…/environment/WaterTab.tsx`, `…/environment/WeatherTab.tsx` (attribution HelpTip), `src/types/farming.ts`, `src/components/farming/IrrigationZoneCard.tsx` (rain tile and subtitle per the W53 brief), `tests/waterTab.test.ts`, the seven `devices.json`, `tests/waterCardLocales.test.ts`, `docs/i18n/pending-luganda-translations.md`

**Interfaces:**
- Consumes: the Task 9 summary fields; `cropById` (Task 10); `HelpTip`.
- Produces: `buildWaterChartRows(water) → WaterChartRow[]`, `waterChartSeries(water, rows, { hasRainGauge }) → { rain, measuredIrrigation, estimatedIrrigation, demand }`, `waterChartMaxMm(rows, keys: Array<'rainMm'|'measuredIrrigationNetMm'|'estimatedIrrigationNetMm'|'demandDrawMm'>) → number`, `WATER_CHART_MIN_MM`; from `WaterTab.tsx`: `WaterDayTooltip` (the tooltip body, exported for tests), `DemandTick` (the bar shape, exported for tests), `demandText`, `sourceText`.

- [ ] **Step 1: Types**

`src/types/farming.ts`:
```ts
export interface RainStation { id: string; name: string | null; distanceKm: number | null; network: string | null }
```
`WaterEnvironment` gains `todayDate?: string | null; rainSource?: 'gauge' | 'meteoswiss_station' | 'weather_service' | null; rainStation?: RainStation | null; dailyRainSource?: 'gauge' | 'meteoswiss_station' | null;`. `WaterDay` gains, all optional: `demandMm?: number | null; demandSource?: 'calculated' | 'forecast' | null; et0Mm?: number | null; et0Source?: string | null; et0Tier?: 'station_fao56' | 'provider_hourly_sum' | 'hargreaves_station' | null; et0StationId?: string | null; et0StationName?: string | null; kc?: number | null; kcSource?: string | null; cropType?: string | null; phenologicalStage?: string | null; hoursPresent?: number | null; expectedHours?: number | null; nullReason?: string | null;`.

- [ ] **Step 2: `waterChart.ts`, a port of `osi-server` `frontend/src/components/farming/environment/waterChart.ts` (read with `git -C <osi-server> show main:<path>`)**

Deltas from the cloud file:
- `WaterChartRow` adds `demandDrawMm: number` and takes `demandMm`, `demandSource`, `nullReason` from the day row; no `hasSetup` gate on demand; the doc comment says demand is per day.
- `buildWaterChartRows(water)` returns `water.daily.map((day) => ({ ...day, demandMm: finite(day.demandMm) ? day.demandMm : null, demandSource: day.demandSource ?? null, nullReason: day.nullReason ?? null, demandDrawMm: finite(day.demandMm) ? Math.max(0, day.demandMm) : 0 }))`; a null day draws at 0 so the tick shape can put the grey dash at the baseline, and a negative ET0 day draws at 0 while the tooltip shows the value.
- `waterChartMaxMm` keys are `'rainMm' | 'measuredIrrigationNetMm' | 'estimatedIrrigationNetMm' | 'demandDrawMm'`.
- `WaterChartSeries` is `{ rain, measuredIrrigation, estimatedIrrigation, demand }`; `waterChartSeries(water, rows, { hasRainGauge })`: `rain` = `(hasRainGauge || water.dailyRainSource === 'meteoswiss_station') && days.some(rainMm != null)`; `measuredIrrigation` = `hasSetup && days.some(measuredIrrigationNetMm != null && (flowMeterPresent || measuredIrrigationNetMm > 0))`; `estimatedIrrigation` = `hasSetup && days.some(estimatedIrrigationNetMm != null && estimatedIrrigationNetMm > 0)`; `demand` = `rows.some((row) => row.demandMm != null)`.

- [ ] **Step 3: Ported and new tests**

`__tests__/waterChart.test.ts`, a port of the cloud's 13 cases. Changes:
- Fixtures: `week()` rows carry `measuredIrrigationNetMm`/`estimatedIrrigationNetMm` instead of `irrigationNetMm`; `water()` drops cloud-only fields (`warningCodes`); `sensorHealth` is the edge's shape.
- Rewritten (their expectations flip): "repeats today's crop demand on every day of the week" → "takes each day's demand from its row" (rows with `demandMm` 1.1…4.4 give those values); "leaves the demand empty when area or efficiency are not set" → "keeps each day's demand without area or efficiency: demand needs no zone area"; "lists no demand series when the balance is undefined" → "lists the demand series whenever a day carries demand, balance or not".
- Adapted: `waterChartMaxMm` cases use the edge keys; `waterChartSeries` cases pass `{ hasRainGauge }` and assert the four-field shape (a flow meter makes `measuredIrrigation` true on a measured zero; an estimated amount above 0 makes `estimatedIrrigation` true).
- New (4): per-day demand from rows; today's row uses `waterNeededTodayMm` only through its own `demandMm` (a week whose other days are null keeps them null); a null day has `demandDrawMm 0`; a negative day (`demandMm -0.2`) has `demandDrawMm 0` and keeps `demandMm -0.2`.

`__tests__/WaterTab.trend.test.tsx`, a port of the cloud's 14 cases. Harness changes:
- Imports `enDevices` and `enCommon` from the edge locale files; no `formatDayMonth`, no `utils/number`.
- A `ResizeObserver` stub (as the cloud's), `vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 640, height: 288, top: 0, left: 0, right: 640, bottom: 288, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)` in `beforeEach`, restored in `afterEach`; `WaterTab` passes `initialDimension={{ width: 640, height: 288 }}` to `ResponsiveContainer`, so the chart renders its SVG in jsdom.
- `DEMAND_EXCEEDS_SUPPLY` reads `enDevices.zone.water.reason.demand_exceeds_supply`; the fixtures drop `warningCodes`.
- Rewritten (the credit line under the plot is gone; attribution lives in the tooltip): "plots the station rain and credits MeteoSwiss with the station and its distance" → the plot is drawn and `water-trend-station-credit` is absent, and `WaterDayTooltip` rendered for a station-rain day contains "Source: MeteoSwiss"; "does not credit MeteoSwiss under a plot that draws the zone's own gauge" → the tooltip of a gauge day contains no "Source: MeteoSwiss"; "labels modelled rain on the tile and never credits a station for it" → clicking the rain tile's HelpTip ("Where this rain value comes from") shows "From weather data (not measured)", and no credit anywhere; "keeps the plot hidden when the station has no value in the window" → the plot is hidden and no credit exists; "shows today's rain tile with the station behind it" / "falls back to the station id when the list carried no name" → the station sentence is inside the rain tile's HelpTip (click, then assert "Measured at MeteoSwiss Payerne (1.2 km away)" / "… PAY …").
- "keeps the verdict sentence and the next-24-h rain when the plot is hidden": the verdict sentence is now the HelpTip beside the plot heading; the test clicks the button named "About the last 7 days" and asserts the verdict, and asserts the next-24-h line as before.
- The other seven cases keep their assertions.
- New cases: a week with `demandMm` on six past days and `demandSource 'forecast'` today draws six `demand-tick` lines and one `demand-tick-forecast` line; the x-axis label for `todayDate` reads "Today"; a null past day draws `demand-tick-missing`; the chart renders for a zone with neither gauge nor meter when a demand day exists; the legend lists "Crop demand (calculated)" and "Crop demand today (forecast)"; `DemandTick` rendered directly inside `<svg>` with `{ x: 10, y: 50, width: 40, height: 100, payload: { demandMm: null } }` draws a dashed grey line at y 150; `WaterDayTooltip` rendered directly for a calculated station day shows "Crop demand: 4.8 mm (calculated)" and "Station demo-s2120 · FAO-56 · Kc 1.20 (Maize (grain), Mid-season)"; for today "Crop demand: 4.1 mm (forecast)" and "Rain and irrigation so far; demand is the forecast for the whole day"; for a `pending` day "Crop demand: pending"; for a `no_location` day "Crop demand: no data (zone has no location)"; for an Open-Meteo day the line "Weather data by Open-Meteo.com, CC BY 4.0"; and no element in the rendered tab carries a `title` attribute (`container.querySelectorAll('[title]').length === 0`).

`tests/waterTab.test.ts` (tsx runner): "hides the seven-day chart when no source feeds it" asserts `doesNotMatch(html, /Last 7 days/)`; add "draws the chart with demand only" (no gauge, no meter, no valve, `daily` with one `demandMm` 3.2 row, `todayDate` set) asserting `match(html, /Last 7 days/)`; the old expectation that a valve alone draws the chart is removed (a valve with no estimated amount and no demand draws nothing). The sentinel i18n resources gain `lastSevenDays: 'XX_LAST7'`.

Run: `cd web/react-gui && npm run test:unit`. Expected: the new and rewritten tests fail.

- [ ] **Step 4: `WaterTab.tsx`**

Keep the edge's tiles, source gating (`zoneHasRainGauge`, `zoneHasFlowMeter`, `zoneHasValve`), `ACTION_LABELS`/`REASON_LABELS` and `useDateFormat`. Changes:
- `REASON_LABELS` gains `rain_unknown: 'No rain measurement for today'` and `demand_unknown: 'No water demand estimate for today'`.
- Rain tile shown when `hasRainGauge || water.rainSource === 'meteoswiss_station' || water.rainSource === 'weather_service'`; its label row gets `<HelpTip label={t('environment.water.rainSourceHelpLabel', { defaultValue: 'Where this rain value comes from' })}>` with `t('zone.water.rainFromStation', { station, distance, defaultValue: 'Measured at MeteoSwiss {{station}} ({{distance}} km away)' })` for a station (name, else id; distance with one decimal, else "—") or `t('zone.water.rainFromWeather', { defaultValue: 'From weather data (not measured)' })`; no HelpTip for the zone's own gauge. There is no detail line under the value.
- Measured and estimated tiles: when `!hasSetup`, their label rows get `<HelpTip label={t('environment.water.setupRequiredHelpLabel', { defaultValue: 'Why effective irrigation is missing' })}>{t('environment.water.setupRequired', …)}</HelpTip>`; the amber `setupRequired` banner is deleted.
- "Water needed today" tile: label unchanged; its label row gets `<HelpTip label={t('environment.water.neededTodayHelpLabel', { defaultValue: 'About water needed today' })}>{t('environment.water.neededTodayHelp', { source: todaySource, defaultValue: 'Forecast for the whole day · {{source}}' })}</HelpTip>` where `todaySource = sourceText(t, todayRow) ?? t('environment.water.et0Tier.forecast', { defaultValue: 'Weather forecast' })`.
- Plot card: always rendered when `series.rain || series.measuredIrrigation || series.estimatedIrrigation || series.demand` or the forecast line exists. The header row: the title `t('environment.water.lastSevenDays', { defaultValue: 'Last 7 days' })` (only when the plot is drawn) with `<HelpTip label={t('environment.water.lastSevenDaysHelpLabel', { defaultValue: 'About the last 7 days' })}>{trendNote}</HelpTip>` beside it (`trendNote` is the existing verdict-or-note expression); the `<p>{trendNote}</p>` paragraph is deleted; the next-24-h line stays.
- The chart:
```tsx
<div className="mt-4 h-72" data-testid="water-trend-chart">
  <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 288 }}>
    <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
      <XAxis dataKey="date" tickFormatter={(date: string) => (date === todayDate ? t('environment.water.today', { defaultValue: 'Today' }) : fmt.date(parseCalendarDay(date)) ?? date)} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
      <XAxis xAxisId="demand" dataKey="date" hide />
      <YAxis domain={[0, yAxisMaxMm]} tickFormatter={(value: number) => `${value} mm`} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} width={52} />
      <Legend payload={legendPayload} wrapperStyle={{ fontSize: 11 }} iconSize={10} />
      <Tooltip content={({ active, payload, label }) => (active && payload?.length ? <WaterDayTooltip row={payload[0].payload as WaterChartRow} label={dayLabel(String(label))} water={water} isToday={String(label) === todayDate} /> : null)} />
      {series.rain && <Bar dataKey="rainMm" name={t('environment.water.tooltipRain', { defaultValue: 'Rain' })} fill="#38bdf8" radius={[6, 6, 0, 0]} />}
      {series.measuredIrrigation && <Bar dataKey="measuredIrrigationNetMm" name={t('environment.water.tooltipMeasuredEffective', { defaultValue: 'Measured effective' })} fill="#14b8a6" radius={[6, 6, 0, 0]} />}
      {series.estimatedIrrigation && <Bar dataKey="estimatedIrrigationNetMm" name={t('environment.water.tooltipEstimatedEffective', { defaultValue: 'Estimated effective' })} fill="#22c55e" radius={[6, 6, 0, 0]} />}
      {series.demand && <Bar xAxisId="demand" dataKey="demandDrawMm" name={t('environment.water.tooltipDemand', { defaultValue: 'Crop demand' })} shape={DemandTick} isAnimationActive={false} legendType="none" />}
      {todayDate && <ReferenceLine x={todayDate} position="start" stroke="var(--text-tertiary)" strokeDasharray="4 3" ifOverflow="visible" />}
    </BarChart>
  </ResponsiveContainer>
</div>
```
`todayDate = water.todayDate ?? null`; `chartData = buildWaterChartRows(water)`; `series = waterChartSeries(water, chartData, { hasRainGauge })`; `yAxisMaxMm = waterChartMaxMm(chartData, [...drawn keys])`. The second x-axis gives the demand bar a full-width band of its own, so its tick spans the day's slot whatever the other bars do.
- `legendPayload` (explicit, so the legend matches the drawing): one `{ id, value, type: 'square', color }` entry per drawn bar series (rain `#38bdf8`, measured `#14b8a6`, estimated `#22c55e`), then for demand `{ id: 'demand', value: t('environment.water.legendDemand', { defaultValue: 'Crop demand (calculated)' }), type: 'plainline', color: '#f97316', payload: { strokeDasharray: '0' } }` and `{ id: 'demand-today', value: t('environment.water.legendDemandTodayForecast', { defaultValue: 'Crop demand today (forecast)' }), type: 'plainline', color: '#f97316', payload: { strokeDasharray: '5 3' } }`.
- `DemandTick` (exported):
```tsx
export function DemandTick(props: { x?: number; y?: number; width?: number; height?: number; payload?: WaterChartRow }) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload) return null;
  if (payload.demandMm == null) {
    const baseline = y + height;
    return <line data-testid="demand-tick-missing" x1={x + width * 0.35} x2={x + width * 0.65} y1={baseline} y2={baseline} stroke="var(--text-tertiary)" strokeWidth={2} strokeDasharray="3 2" />;
  }
  const forecast = payload.demandSource === 'forecast';
  return <line data-testid={forecast ? 'demand-tick-forecast' : 'demand-tick'} x1={x + width * 0.1} x2={x + width * 0.9} y1={y} y2={y} stroke="#f97316" strokeWidth={3} strokeDasharray={forecast ? '5 3' : undefined} />;
}
```
- `demandText(t, row)` (exported): `demandForecast`/`demandCalculated` with `value: row.demandMm.toFixed(1)` when set; else `demandPending` for `pending`, `demandNoLocation` for `no_location`, `demandNoData` otherwise.
- `sourceText(t, row)` (exported): the ET0 part — `et0Tier.forecast` when `demandSource === 'forecast'`; `et0Tier.station_fao56` / `et0Tier.hargreaves_station` with `station = et0StationName ?? et0StationId`; `et0Tier.provider_meteoswiss` with the station for `meteoswiss_hourly_sum`; `et0Tier.provider_open_meteo` for `open_meteo_hourly_sum` — joined with " · " to the Kc part `t('environment.water.kcLine', { kc: row.kc.toFixed(2), source: t(\`environment.water.kcSource.${row.kcSource}\`, { crop: cropById(row.cropType)?.label ?? row.cropType ?? '', stage }) })` when `kc` is set, or `t('environment.water.kcSource.server')` for today's `server` row; `stage` is `t(\`zoneConfig.stage.${row.phenologicalStage}\`)` or `environment.water.stageNotSet`.
- `WaterDayTooltip({ row, label, water, isToday })` (exported, uses `useTranslation('devices')`): the date label; the supply lines as today (`tooltipRain`, measured and estimated litres, the two effective lines); `${t('environment.water.tooltipDemand')}: ${demandText(t, row)}`; `sourceText(t, row)` when not null; the attribution line — `t('environment.water.attribution.open_meteo', { defaultValue: 'Weather data by Open-Meteo.com, CC BY 4.0' })` for `open_meteo_hourly_sum`, `t('environment.water.stationCredit', { defaultValue: 'Source: MeteoSwiss' })` for `meteoswiss_hourly_sum` or when `water.dailyRainSource === 'meteoswiss_station'`; and for today `t('environment.water.tooltipTodayNote', { defaultValue: 'Rain and irrigation so far; demand is the forecast for the whole day' })`.
- No element gets a `title` attribute; no caption, note or banner remains.

- [ ] **Step 5: `WeatherTab.tsx` and `IrrigationZoneCard.tsx`**

`WeatherTab.tsx`: beside the `environment.forecast.hourlyTitle` heading, when `String(forecast.source ?? '').includes('open_meteo')`, render `<HelpTip label={t('environment.water.attributionHelpLabel', { defaultValue: 'About the weather data' })}>{t('environment.water.attribution.open_meteo', { defaultValue: 'Weather data by Open-Meteo.com, CC BY 4.0' })}</HelpTip>`.

`IrrigationZoneCard.tsx` (W53 brief; lines around 300 and 563 gate rain on a gauge only):
- `const rainSource = environmentSummary?.water.rainSource ?? null; const hasRainTile = hasRainGauge || rainSource === 'meteoswiss_station' || rainSource === 'weather_service';`; `waterTileCount` uses `hasRainTile`; the rain tile renders on `hasRainTile` and, for a station or weather-service source, carries the same HelpTip as the Water tab (`environment.water.rainSourceHelpLabel`, `zone.water.rainFromStation` / `zone.water.rainFromWeather`). `hasRainGauge` keeps its other uses.
- The "Driven by water balance" line (around line 620): `rainSource === 'meteoswiss_station'` → `t('zone.water.drivenByWaterBalanceFromStation', { station, defaultValue: 'Driven by water balance · rain measured at MeteoSwiss {{station}}' })`; `'weather_service'` → `t('zone.water.drivenByWaterBalanceFromWeather', { defaultValue: 'Driven by water balance · rain from weather data' })`; otherwise the existing `zone.water.drivenByBalance`.
- `scripts/verify-sync-flow.js` pins strings in this file (`{hasFlowMeter && (`, `summarizeZoneSoil(devices,`); keep them; run it in Step 7.

- [ ] **Step 6: Locale keys (en value given; translate into de-CH, fr, it, es, pt; lg gets the English text)**

Removed (retired): `environment.water.weeklyTrend`.

Added, the cloud's strings reused verbatim in English:
- `environment.water.lastSevenDays` "Last 7 days"; `environment.water.tooltipDemand` "Crop demand"; `environment.water.stationCredit` "Source: MeteoSwiss"
- `zone.water.rainFromStation` "Measured at MeteoSwiss {{station}} ({{distance}} km away)"; `zone.water.rainFromWeather` "From weather data (not measured)"
- `zone.water.reason.rain_unknown` "No rain measurement for today"; `zone.water.reason.demand_unknown` "No water demand estimate for today"
- `zone.water.drivenByWaterBalanceFromWeather` "Driven by water balance · rain from weather data"; `zone.water.drivenByWaterBalanceFromStation` "Driven by water balance · rain measured at MeteoSwiss {{station}}"

Added, new:
- `environment.water.today` "Today"
- `environment.water.legendDemand` "Crop demand (calculated)"; `environment.water.legendDemandTodayForecast` "Crop demand today (forecast)"
- `environment.water.demandCalculated` "{{value}} mm (calculated)"; `environment.water.demandForecast` "{{value}} mm (forecast)"; `environment.water.demandNoData` "no data (weather record incomplete)"; `environment.water.demandNoLocation` "no data (zone has no location)"; `environment.water.demandPending` "pending"
- `environment.water.tooltipTodayNote` "Rain and irrigation so far; demand is the forecast for the whole day"
- `environment.water.kcLine` "Kc {{kc}} ({{source}})"
- `environment.water.et0Tier.station_fao56` "Station {{station}} · FAO-56"; `environment.water.et0Tier.hargreaves_station` "Station {{station}} · Hargreaves"; `environment.water.et0Tier.provider_open_meteo` "Open-Meteo model"; `environment.water.et0Tier.provider_meteoswiss` "MeteoSwiss {{station}}"; `environment.water.et0Tier.forecast` "Weather forecast"
- `environment.water.attribution.open_meteo` "Weather data by Open-Meteo.com, CC BY 4.0"; `environment.water.attributionHelpLabel` "About the weather data"
- `environment.water.neededTodayHelpLabel` "About water needed today"; `environment.water.neededTodayHelp` "Forecast for the whole day · {{source}}"
- `environment.water.lastSevenDaysHelpLabel` "About the last 7 days"; `environment.water.setupRequiredHelpLabel` "Why effective irrigation is missing"; `environment.water.rainSourceHelpLabel` "Where this rain value comes from"

`environment.source.local` and the other `environment.source.*` keys are not touched.

Hand-listed tests: `tests/waterCardLocales.test.ts` `DEVICES_KEYS` drops `environment.water.weeklyTrend` and adds every key above; `REVIEWED_IDENTICAL` adds `<locale>:environment.water.kcLine` for de-CH, es, fr, it, pt, `de-CH:` and `fr:` for `environment.water.et0Tier.station_fao56` and `environment.water.et0Tier.hargreaves_station` ("Station" is the same word), and `es:`/`pt:` for `environment.water.et0Tier.provider_meteoswiss` (the product name "MeteoSwiss" is used in both), each only if the translator keeps the English form. `docs/i18n/pending-luganda-translations.md`: the `environment.water.*` row drops `weeklyTrend` from its list and count, and a new row lists the keys above with the reason "Added by the Water tab's Last 7 days plot with per-day crop demand (2026-09-26); no human Luganda pass yet, so `lg` ships the English source text".

- [ ] **Step 7: Gates and commit**

```bash
cd web/react-gui && npm run test:unit && npm run typecheck && cd ../..
node scripts/verify-sync-flow.js
node .claude/skills/anti-slop-writing/slop-check.js docs/i18n/pending-luganda-translations.md
git add web/react-gui/src web/react-gui/tests web/react-gui/public/locales docs/i18n/pending-luganda-translations.md
git commit -m "feat(gui): Last 7 days plot with per-day crop demand ticks, today as forecast, tooltips only"
```
Expected: `test:unit` green (the 13 + 14 ported cases, the new cases, the locale suites), `typecheck` exit 0, sync flow ends `All parity checks passed.`, slop PASS.

---

### Task 12: Docs, whole-branch gates, calibration script, execution report

**Files:**
- Create: `scripts/calibrate-lux-radiation.js`, `docs/superpowers/plans/2026-09-26-daily-agronomy-execution-report.md`
- Modify: `AGENTS.md` (the provider-weather paragraph gains two sentences on the daily record and the station tier), `.claude/skills/osi-agronomy-sensors-reference/SKILL.md` (the "ET0" section: the edge now computes it; the three tiers; the contract directory; the "cloud-only" statement removed)

- [ ] **Step 1: Calibration script**

`scripts/calibrate-lux-radiation.js <path-to-farming.db>`: opens the file read-only with `node:sqlite` (`new DatabaseSync(path, { readOnly: true })`); for each station in `weather_station_hours`, finds its zones (`weather_station_zones`) and their provider location (`weather_locations` by rounded coordinates, Open-Meteo only); joins `weather_station_hours.global_radiation_wm2` with `weather_provider_hours.global_radiation_wm2` on equal `hour_start` (`normalizeOpenMeteo` already stores Open-Meteo's preceding-hour value at `hour_start = stamp − 1 h`, so equal `hour_start` compares the same hour); prints per UTC day the two sums in MJ/m², the median ratio station/provider over the last 7 complete days, and the `luxPerWm2` that would make the median 1.0 (`120 × median`). It never writes. It is run on a copy of the demo gateway's database, never on the live file.

- [ ] **Step 2: Docs**

AGENTS.md and the skill as listed above. Run `node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md .claude/skills/osi-agronomy-sensors-reference/SKILL.md`; PASS.

- [ ] **Step 3: Whole-branch gates**

```bash
P=conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red
for t in osi-weather-provider/index.test.js osi-weather-provider/facade-contract.test.js osi-crop-kc/index.test.js osi-station-hours/index.test.js osi-station-hours/facade-contract.test.js osi-agronomy-daily/et0.test.js osi-agronomy-daily/index.test.js osi-agronomy-daily/facade-contract.test.js osi-zone-env/index.test.js osi-lib/index.test.js; do node --test $P/$t || echo "FAILED $t"; done
node scripts/verify-agronomy-contract.js
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-db-schema-consistency.js && node scripts/verify-seed-db-ledger.js && node scripts/verify-sqlite-cli-limits.js && node scripts/verify-no-stray-ddl.js && node scripts/test-journal-schema.js
node scripts/verify-helper-registration.js && node scripts/verify-module-file-deploy-coverage.js && node scripts/verify-osi-lib-db-caller-binding.js && node scripts/verify-profile-parity.js
node scripts/verify-flows-fn-parse.js && node scripts/flows-bare-require-scan.js && node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/verify-flows-size-ratchet.js
node scripts/verify-communication-contract.js && node scripts/verify-sync-flow.js && node scripts/verify-live-gateway-identity.js
node scripts/capture-zone-env-vectors.js --verify
node --test lib/osi-migrate/__tests__/*.test.js
cd web/react-gui && npm run test:unit && npm run typecheck && cd ../..
node .claude/skills/anti-slop-writing/slop-check.js docs/contracts/agronomy/README.md docs/operations/edge-history-retention.md docs/i18n/pending-luganda-translations.md AGENTS.md
```
Expected: no `FAILED` line; every verifier's pass line; five zone-env vectors verified; migration tests pass; GUI green.

- [ ] **Step 4: Execution report**

`docs/superpowers/plans/2026-09-26-daily-agronomy-execution-report.md`, in sub-project 1's shape: what was built per task; the gate table with verbatim pass lines; the ratchet numbers (Task 8 and Task 9 deltas, `zone-env-fn` before/after); fix rounds; what was left out. It records:
- This sub-project reverses sub-project 1's execution-report note to use MeteoSwiss's daily `erefaod0` column: both providers' daily ET0 is the sum of stored hourly values (spec "Decisions"; `erefaod0` is 7 to 15 % lower at Payerne and a different formula).
- Follow-up: a `mixed_station` day never heals, because the weather tick refetches only absent hours; accepted for this sub-project.
- Follow-up: the number of days per zone on the demo gateway that fall through both station tiers because a 60-minute uplink left an hour empty (query `SELECT null_reason, et0_tier, COUNT(*) FROM zone_daily_agronomy GROUP BY 1, 2` on a copy of the database), with a recommendation whether a tolerance is needed.
- Follow-up: `pecan` and the other eight cloud-only crops await the agronomist's decision on a Table 12 row.
- Acceptance on a linked test gateway (MeteoSwiss default) and the demo gateway (S2120 assigned, internet), following the `osi-live-ops-runbook` skill: `SELECT sqlite_version()` through the gateway's Node-RED `sqlite3` module is 3.35 or later (`RETURNING`); after two ticks, seven rows per zone; on the demo gateway the station tier is chosen for zones with the station, and `node scripts/calibrate-lux-radiation.js <copy of farming.db>` shows the station's daily radiation sum within 15 % of Open-Meteo's (median over 7 days), else `luxPerWm2` is corrected in the contract, the copies regenerated and re-verified; the Water tab shows seven distinct ticks with today dashed, and every explanation is reachable only through a HelpTip.

Run `node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-09-26-daily-agronomy-execution-report.md`; PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/calibrate-lux-radiation.js AGENTS.md .claude/skills/osi-agronomy-sensors-reference/SKILL.md docs/superpowers/plans/2026-09-26-daily-agronomy-execution-report.md
git commit -m "docs(agronomy): execution report for sub-project 2"
```
