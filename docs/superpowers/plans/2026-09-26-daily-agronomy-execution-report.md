# Daily agronomy record — execution report (sub-project 2)

> **Migration numbers after landing.** origin/main took 0060
> (`add_rak10701_field_tester_type`) and 0061 (`watermark_lsn50`) while this
> stack was open, so the stack's six migrations were renumbered on the merge
> with main, content unchanged apart from the header comment:
> `0060__weather_provider_store` -> `0062`, `0061__daily_agronomy` -> `0063`,
> `0062__fao56_stage_keys` -> `0064`, `0063__zone_weather_source_sync` ->
> `0065`, `0064__stage_started_on` -> `0066`, `0065__zone_daily_agronomy_sync`
> -> `0067`. The numbers below are the ones in use when this report was
> written.

Sub-project 2 gives the edge its own reference evapotranspiration and crop
water demand. `osi-crop-kc` reads the FAO-56 crop catalogue and stage
vocabulary from `docs/contracts/agronomy/` (136 crops, 1,252 Kc vectors);
migrations 0061 and 0062 add `zone_daily_agronomy`'s agronomy columns,
`weather_station_hours`, and migrate legacy stage keys. `osi-weather-provider`
gained `zoneLocations` (shared coordinate/provider resolution) and
per-hour MeteoSwiss station provenance; `osi-station-hours` aggregates
SenseCAP S2120 uplinks into hourly means, minimums, maximums and summed
rain; `osi-agronomy-daily` (`et0.js` plus the writer) resolves ET0 through
three tiers — a station's own daily FAO-56 Penman-Monteith, the stored
provider hours summed, or Hargreaves-Samani from the station's daily
temperature spread — with a Kc snapshot from `osi-crop-kc` frozen the moment
a row first gets a non-null `et0_mm`. Two chained flow nodes
(`station-hours-fn`, `agronomy-daily-fn`) run off the existing 30-minute
weather tick. `osi-zone-env` gained `buildWaterDaily`, extracted from
`zone-env-fn`, adding demand and ET0 fields to each day of the Water tab's
history and an overlay rule for a linked gateway's stale cloud bundle. The
GUI's zone settings now offer the full FAO-56 catalogue and stage
vocabulary, and the Water tab's "Last 7 days" plot draws a demand tick per
day (today dashed, a null day a grey dash), with every explanation reachable
only through a tooltip or HelpTip. Task 12 added a read-only lux
calibration script and closed three documentation gaps carried from Tasks 1
and 3; the final fix wave after the committee review (below) closed the
queued review items and ran the whole branch's gate set fresh.

## Final fix wave

The committee review of Tasks 1 to 12 queued one fix wave (brief:
`.superpowers/sdd/2026-09-26-daily-agronomy/final-fix-brief.md`). It ran on
top of `74896a5cf` in eight commits:

| Commit | What it changes |
|---|---|
| `98611f019` | `WaterTabReasonLocale.test.tsx` calls the typed `t` with the `devices:` namespace; `npm run typecheck` exits 0 again |
| `5f2ed0c50` | `osi-zone-env`: a stale cloud bundle takes every "today" field from the gateway; `resolveWaterAction` answers `demand_unknown` when today's demand is null; today's row carries ET0, Kc, crop, stage and `nullReason: 'demand_unknown'`; `zone-env-fn` passes the demand and `agronomic.current` |
| `f0703c61c` | `osi-agronomy-daily`: provider-tier counts under a provider reason, the missing-table guard, masked warn dedupe, the run-owned `localDayWindow` memo, `summary.latestNull`, the tier 1 radiation plausibility check (new `hourlyExtraterrestrialRadiation`), the `windAt2m` guard |
| `f2f02e803` | flows: `weather-provider-fn` forwards a thrown error as `{ weatherFailed: true }`; `osi-station-hours` gains the clock guard, masked warn dedupe and post-COMMIT tallies; `station-hours-fn` forwards a clock skip as `stationSkipped`; status lines on all three nodes |
| `687524104` | `osi-dendro-analytics`: `PHENO_MOD` keyed by the FAO-56 stages, legacy keys through `normalizeStage` |
| `21c104be5` | late-season Kc is `(kc_mid + kc_end) / 2`; both stage means in whole hundredths rounded half up; `kc-vectors.json` regenerated |
| `3764cb9df` | `calibrate-lux-radiation.js` names its reference, skips days under 22 matched hours, recomputes station radiation from `light_lux` |
| `6a9b946c7` | GUI: the Water tab render rule, gated tooltip lines, ET0 and crop in the source line, the null-reason texts, the Weather tab credit without an hourly chart; zone settings accessibility, the stored-crop normalisation, the dormancy wording |

### Correction: Task 11's typecheck claim

Task 11's report said `npm run typecheck` was green. It was not: the
`instance.t('environment.water.lastSevenDaysHelpLabel')` call that Task 11
added to `WaterTabReasonLocale.test.tsx` fails the typed-key overload, and
`tsc --noEmit` has been red since `b6619ef71`. Vitest does not type-check,
so the test itself passed, which is why the claim went unnoticed. Task 12's
fresh gate run caught it and reported it as a blocked gate; `98611f019`
fixes it.

### The weather chain now forwards on failure

Until this wave `weather-provider-fn` returned `null` on a thrown error, and
Node-RED dropped the message: station hours and the daily writer skipped
that tick. The node now warns, turns its status red and forwards
`msg.payload = { weatherFailed: true }`, so both later nodes run on their
own guards. A skipped weather tick (`skipped: 'in_flight'`) still stops the
chain, because the run in flight continues it. `station-hours-fn` forwards
its own clock skip as `payload.stationSkipped`, so the daily writer, which
has its own clock guard, still runs.

### Kc rule change and frozen rows

The final fix wave changed the late-season Kc from `kc_end` to the stage
mean (kc_mid + kc_end) / 2 and the development value to (kc_ini + kc_mid) / 2.
Phil reversed both on 2026-09-26: FAO-56 tabulates no value for the ramp
stages, so the branch follows the table (development `kc_mid`, late season
`kc_end`, the cloud's rule) and the daily interpolation of figure 25, with a
stage start date and table 11 stage lengths, becomes a sub-project 4 item on
both sides. A row of `zone_daily_agronomy` keeps the Kc it was written with.

### Recorded for Phil, not fixed here

The station tier (daily FAO-56 from the S2120) reads 3 to 17 % below the
provider's hourly sum over the same hours: median ratio 0.97 in July, 0.83
to 0.87 in late September. The fix belongs to sub-project 4 (below).

## Gate outputs

Every gate below ran fresh at the head of the final fix wave (`6a9b946c7`,
plus this report). Package test files print `# tests`, `# pass` and
`# fail`; the other commands print their last line.

| Command | Pass line (verbatim) |
|---|---|
| `node --test .../osi-weather-provider/index.test.js` | `# tests 54` / `# pass 54` / `# fail 0` |
| `node --test .../osi-weather-provider/facade-contract.test.js` | `# tests 1` / `# pass 1` / `# fail 0` |
| `node --test .../osi-crop-kc/index.test.js` | `# tests 4` / `# pass 4` / `# fail 0` |
| `node --test .../osi-station-hours/index.test.js` | `# tests 9` / `# pass 9` / `# fail 0` |
| `node --test .../osi-station-hours/facade-contract.test.js` | `# tests 1` / `# pass 1` / `# fail 0` |
| `node --test .../osi-agronomy-daily/et0.test.js` | `# tests 7` / `# pass 7` / `# fail 0` |
| `node --test .../osi-agronomy-daily/index.test.js` | `# tests 27` / `# pass 27` / `# fail 0` |
| `node --test .../osi-agronomy-daily/facade-contract.test.js` | `# tests 1` / `# pass 1` / `# fail 0` |
| `node --test .../osi-zone-env/index.test.js` | `# tests 20` / `# pass 20` / `# fail 0` |
| `node --test .../osi-lib/index.test.js` | `# tests 6` / `# pass 6` / `# fail 0` |
| `node --test .../osi-dendro-analytics/index.test.js` | `# tests 8` / `# pass 8` / `# fail 0` |
| `node --test scripts/test-dendro-contract.js scripts/verify-dendro-contract-mirror.test.js` | `# tests 5` / `# pass 5` / `# fail 0` |
| `node scripts/verify-agronomy-contract.js` | `verify-agronomy-contract: OK (136 crops, copies byte-identical, vectors reproduced where implementations exist)` |
| `node scripts/capture-zone-env-vectors.js --verify` | Five `Verified zone-env vector <name>` lines, the last `Verified zone-env vector shared-server-stale` |
| `node scripts/capture-dendro-analytics-vectors.js --verify` | `Verified dendro analytics vectors` |
| `node scripts/verify-migrations.js` | `verify-migrations: OK (62 migrations, checksum manifest OK, base immutability OK)` |
| `node scripts/verify-seed-replay.js` | `verify-seed-replay: OK` |
| `node scripts/verify-runtime-schema-parity.js` | `verify-runtime-schema-parity: OK (2 flows: devices CHECK + runtime trigger parity)` |
| `node scripts/verify-db-schema-consistency.js` | `DB schema consistency verification passed` |
| `node scripts/verify-seed-db-ledger.js` | `verify-seed-db-ledger: OK (7 images stamped at migration head 62)` |
| `node scripts/verify-sqlite-cli-limits.js` | `verify-sqlite-cli-limits: OK` |
| `node scripts/verify-no-stray-ddl.js` | `verify-no-stray-ddl: OK (HEAD total 694 <= origin/main total 694; committed baseline matches HEAD total 694)` |
| `node scripts/test-journal-schema.js` | `test-journal-schema: OK (catalog v1 semantics, semantic FKs, guarded replay, seven-DB data parity)` |
| `node scripts/verify-helper-registration.js` | `All helper-registration checks passed.` |
| `node scripts/verify-module-file-deploy-coverage.js` | `OK: all 111 runtime files in deploy.sh-shipped osi-* modules are fetched.` |
| `node scripts/verify-osi-lib-db-caller-binding.js` | `verify-osi-lib-db-caller-binding: OK` |
| `node scripts/verify-profile-parity.js` | `All parity checks passed.` |
| `node scripts/verify-flows-fn-parse.js` | `verify-flows-fn-parse: OK` |
| `node scripts/flows-bare-require-scan.js` | No stdout, exit 0 |
| `node scripts/test-flows-wiring.js` | `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed` |
| `node scripts/verify-no-new-silent-catch.js` | `- bcm2709: 87 empty catches across 306 function nodes (baseline 87)`, exit 0 |
| `node scripts/verify-flows-size-ratchet.js` | `verify-flows-size-ratchet: OK (HEAD total 3169112 <= origin/main total 3160836; committed baseline not exceeded)` |
| `bash scripts/check-mqtt-topics.sh` | `OK: <path> — no UUID patterns in MQTT IN topics`, once per profile (bcm2712, bcm2709, bcm2708) |
| `node scripts/verify-communication-contract.js` | `Communication contract verification passed` |
| `node scripts/verify-live-gateway-identity.js` | `Live gateway identity verification passed.` |
| `node --test lib/osi-migrate/__tests__/*.test.js` | `# tests 123` / `# pass 123` / `# fail 0` |
| `node --test scripts/calibrate-lux-radiation.test.js` | `# tests 8` / `# pass 8` / `# fail 0` |
| `node scripts/verify-sync-flow.js` | Ends `All parity checks passed.`, exit 0 |
| `npm run typecheck` (`web/react-gui`) | `tsc --noEmit`, exit 0 |
| `npm run test:unit` (`web/react-gui`) | tsx suite `# tests 182` / `# pass 181` / `# fail 0` (1 skipped); vitest `Test Files 203 passed (203)`, `Tests 2141 passed (2141)` |
| `node .claude/skills/anti-slop-writing/slop-check.js <file>` on each prose file the wave touched | `slop-check: PASS (no tier-1 findings)` for each |

## Ratchet numbers

`scripts/verify-flows-size-ratchet-allowances.json`'s `total_allowance`,
measured with `verify-flows-size-ratchet`'s `totalChars` over both
byte-identical maintained profiles:

| Step | Base (origin/main) | HEAD | Delta | What moved |
|---|---:|---:|---:|---|
| Task 8 | 1,580,418 | 1,583,799 | +3,381 | `1007` (sub-project 1's still-unmerged `weather-provider-fn`, carried forward) + `1106` (`station-hours-fn`) + `1268` (`agronomy-daily-fn`) |
| Task 9 | 1,580,418 | 1,583,457 | +3,039 | `zone-env-fn` shrinks 41,848 → 41,506 chars (−342) as its per-day water transform moves into `osi-zone-env.buildWaterDaily` |
| Fix wave, `5f2ed0c50` | 1,580,418 | 1,583,430 | +3,012 | `zone-env-fn` 41,506 → 41,479 (−27): it passes today's demand and `agronomic.current` |
| Fix wave, `f2f02e803` | 1,580,418 | 1,584,556 | +4,138 | `weather-provider-fn` 1,007 → 1,467, `station-hours-fn` 1,106 → 1,525, `agronomy-daily-fn` 1,268 → 1,515 |

The allowance's reason text was rewritten to the measured facts (Q9): four
new nodes, together 4,507 characters, minus the 369 that `zone-env-fn`
shrank from origin/main, is 4,138. `verify-live-gateway-identity.js` pins
the same number, and `scripts/verify-flows-size-ratchet-baseline.json` was
refreshed to 1,584,556 per profile.

## Fix rounds

Two fix rounds ran on this branch. The first, on Task 10: the drawer's
cleared-stage save sent `null` on the wire, which the cloud's
`EdgeSyncService orElse()` drops, leaving the cloud's old stage in place.
Fixed to send `'default'`, together with the review's placeholder-wording
ruling ("Select prediction crop" → "Select crop"). The second is the final
fix wave above.

## Open follow-ups

Left open after the final fix wave:

- A `mixed_station` day never heals, because the weather tick refetches only absent hours, not a station-provenance gap once it falls outside the 7-day lookback (Task 7, accepted for this sub-project).
- The number of days per zone on the demo gateway that fall through both station tiers because a 60-minute uplink left an hour empty is unmeasured; run `SELECT null_reason, et0_tier, COUNT(*) FROM zone_daily_agronomy GROUP BY 1, 2` on a copy of the database and decide whether tier 1/3 need a tolerance for a single missing hour.
- `pecan` and the other eight cloud-value/not-FAO-56 crops (`fig`, `pomegranate`, `blueberry`, `raspberry`, `hazelnut`, `mango`, `papaya`, `grass`) await an agronomist's Table 12 ruling.
- The first tick after an upgrade refetches up to 7 days per MeteoSwiss location for station provenance; the PR needs a note (Task 4).
- An hour older than 48 hours is never re-aggregated on a late sample; the clock guard prevents the stale-clock case, not a late uplink. Pressure is stored at 1 dp against the plan's 2 dp wording; the station timestamp scan covers 5 days per station per tick (Task 5).
- The "by name" ET0 vector tests check the fixture file rather than `et0.js` directly (Task 6).
- The global oldest-hour bound gives a brand-new zone many `no_source` rows (spec-mandated, a read-only cost) (Task 7).
- `pick()` copies an explicit `null` over the cloud's past-day demand; a second `getCache` call per zone fetches `fetchedAt`; `evapotranspirationSource` is hard-coded to `'open_meteo'` (pre-existing); the `shared-server-stale` case name covers date rollover, not transport staleness (Task 9).
- "Crop development" reads awkwardly as an inline stage name (Task 10).
- The radiation plausibility thresholds (0.06 × Ra for the day, 1 MJ/m² extraterrestrial for an hour) are FAO-56-derived rulings; no field day has tested them yet. The re-review lowered the daily share from 0.15 after computing that a Zürich fog day in December (0.8–1.5 MJ/m² against an Ra of 9–10.5) would have fallen out of tier 1. A rejected station day carries the value of tier 2 or 3 and no null reason, and no log line, so the demo gateway's acceptance should query rows of zones with a station where `et0_tier <> 'station_fao56'` and check each against the sky that day.
- The drift between the station tier and the provider sum (above) is open until sub-project 4.
- Both clock guards (station hours and the daily writer) skip every run while the newest stored hour lies more than 24 hours ahead of the clock. A clock that once ran ahead and stamped a future hour therefore silences both until real time passes that hour; the warning names the hour, and the operator deletes the future rows from `weather_station_hours` or waits (re-review N4).
- `dendro-compute-fn` still reads `DA.PHENO_MOD[stage]`, served by a read-only Proxy over the FAO-56 table; at the next planned edit of that node, call `DA.phenoModFor(stage)` and export the plain frozen table (re-review N1).

## Left for sub-project 4

The chair's recommendations for the cloud, as the fix brief records them
(the chair's full text is not in this tree):

- copy `crop-kc.json`;
- `'default'`/legacy handling;
- `WaterDay` fields;
- wind-height parameter;
- authority before syncing `zone_daily_agronomy`;
- the overlay's unconditional `DEMAND_FIELDS` copy must become conditional once the cloud computes its own.

Added by this wave:

- The FAO-56 Kc curve of figure 25 on both sides: a stage start date on the zone (synced), table 11 stage lengths in `crop-kc.json`, daily linear interpolation (equation 66) through the development and late seasons. Until then both sides use the table values (`kc_mid` for development, `kc_end` for the late season), which `kc-vectors.json` pins.
- An hourly FAO-56 Penman-Monteith (equation 53) on both sides, so the station tier and the provider sum compare like with like; the demo gateway's acceptance compares the 7-day ET0 of the station tier against the provider sum, not only radiation.
- `osi-dendro-analytics` keys its stage modifier by the FAO-56 stages; the cloud's dendro analytics, if it carries a copy of that table, needs the same keys.

## What was left out

Out of scope for this sub-project, per the spec's "Scope boundaries": any
data-view change (`weather_station_hours`/`weather_provider_hours` as
history sources, an `et0_mm` channel), any cloud change (sub-project 4,
above), a zone-level weather-provider selector in the GUI, a stage-history
table (a day filled after an outage takes the crop and stage current at
fill time), and ET0 for a station type other than the SenseCAP S2120 (the
hour aggregator is written so a second station type is one mapping, but no
second type is wired in). Also out of scope: any GUI caption or note
outside a tooltip.

## Reversal of sub-project 1's `erefaod0` note

Sub-project 1's execution report said MeteoSwiss's daily ET0 should come
from `d_recent`'s `erefaod0` column rather than the sum of hourly
`erefaoh0` values, citing a 1.12 ratio (22.37 mm summed against 20.0 mm
daily) measured at Payerne over 17–23 September. This sub-project reverses
that: both providers' daily ET0 is the sum of their stored hourly values,
never the provider's own daily column. The spec's "Decisions" table records
why — `erefaod0` is MeteoSwiss's own daily formula, not a same-method
aggregate of the hourly figures, and reads 7 to 15 % lower than the hourly
sum at Payerne; Open-Meteo's own daily-vs-hourly-sum ratio, by contrast, is
1.000 to 1.005, because it is the same FAO-56 calculation at both grains.
Using each provider's daily column would silently switch formulas between
providers for no reason the GUI could explain; summing the hours already
computed for `weather_provider_hours` keeps one method throughout.

## Acceptance (quoted from the spec/plan)

Two steps, one per gateway, from the "Testing and acceptance" section
(spec) and the plan's runbook-specific restatement of it — neither run in
this task, which touched no gateway:

> Acceptance on a linked test gateway (MeteoSwiss default) ... following
> the `osi-live-ops-runbook` skill: `SELECT sqlite_version()` through the
> gateway's Node-RED `sqlite3` module is 3.35 or later (`RETURNING`); after
> two ticks, seven rows per zone.

> ... and the demo gateway (S2120 assigned, internet): on the demo gateway
> the station tier is chosen for zones with the station, and `node
> scripts/calibrate-lux-radiation.js <copy of farming.db>` shows the
> station's daily radiation sum within 15 % of Open-Meteo's (median over 7
> days), else `luxPerWm2` is corrected in the contract, the copies
> regenerated and re-verified; the Water tab shows seven distinct ticks with
> today dashed, and every explanation is reachable only through a HelpTip.

## Merge order

Settle the merge order before any gateway acceptance run on a linked test
gateway or the demo gateway; a gateway that recorded 0060–0062 under the old names stops every
later deploy with `repair_required: checksum mismatch` (runner.js) and needs
the ledger repair from the runbook. The runner's `repair_required` handling
and the rule never to edit a merged migration are in the
`osi-schema-change-control` skill.

`0061__daily_agronomy.sql` and `0062__fao56_stage_keys.sql` were numbered
assuming they land after sub-project 1's `0060__weather_provider_store.sql`.
The unmerged `feat/rak10701-coverage` branch carries its own, different
`0060` (`0060__add_rak10701_field_tester_type.sql`). Other test gateways
already carry RAK's 0060 and cannot take this branch before the
renumber. If the RAK branch merges before this one:

1. Rename `database/migrations/ordered/0060__weather_provider_store.sql` to
   `0061__weather_provider_store.sql`, and this sub-project's two files to
   `0062__daily_agronomy.sql` and `0063__fao56_stage_keys.sql` (the RAK
   migration keeps `0060`).
2. Edit the self-references before regenerating `CHECKSUMS.json`, since the
   checksum covers the file bytes:
   - `docs/operations/edge-history-retention.md`, the line that names
     `database/migrations/ordered/0061__daily_agronomy.sql`;
   - `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`,
     the test title "through 0062";
   - the header comment on line 2 of `0061__daily_agronomy.sql` ("-- 0061:")
     and of `0062__fao56_stage_keys.sql` ("-- 0062__fao56_stage_keys.sql:"),
     and line 2 of `0060__weather_provider_store.sql` ("-- 0060:"), which
     moves with its rename.
3. Regenerate `database/migrations/ordered/CHECKSUMS.json`.
4. Merge `database/seed-blank.sql`, then re-run `node scripts/verify-seed-replay.js`
   and `node scripts/verify-no-stray-ddl.js`.
5. Run `node scripts/build-seed-db.js` to restamp the seed images at the new
   head.
6. In `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`,
   append `61`, `62` and `63` to the expected `result.applied` alongside the
   existing `60` (the RAK migration).
7. Re-measure the flows size ratchet's `total_allowance` (currently 4,138,
   both profiles) and `verify-live-gateway-identity.js`'s pin against
   whatever `origin/main` measures once the RAK branch's own flow changes
   land, and re-run `node scripts/verify-agronomy-contract.js` and
   `node scripts/capture-zone-env-vectors.js --verify`. The identity pins
   reference node ids, not migration numbers, so they need re-measuring, not
   renaming.

Before the first gateway takes this branch:

- Swiss gateways set `osi-server.cloud.weather_provider_default=meteoswiss`.
- Customer clouds must accept FAO stage keys before an edge re-cut; a re-cut
  re-measures the ratchet and identity pins.
