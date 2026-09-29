# Weather provider store — execution report

> **Migration numbers after landing.** origin/main took 0060
> (`add_rak10701_field_tester_type`) and 0061 (`watermark_lsn50`) while this
> stack was open, so the stack's six migrations were renumbered on the merge
> with main, content unchanged apart from the header comment:
> `0060__weather_provider_store` -> `0062`, `0061__daily_agronomy` -> `0063`,
> `0062__fao56_stage_keys` -> `0064`, `0063__zone_weather_source_sync` ->
> `0065`, `0064__stage_started_on` -> `0066`, `0065__zone_daily_agronomy_sync`
> -> `0067`. The numbers below are the ones in use when this report was
> written.

Sub-project 1 of the provider weather package adds an hourly weather store to
the edge. Migration 0060 creates `weather_provider_hours`, a per-location,
per-provider hourly table, plus the provider-resolution columns it depends on,
including `weather_source` on `irrigation_zones`; `database/seed-blank.sql` and
the seven bundled `farming.db` images were rebuilt from it. The
`osi-weather-provider` Node-RED module (`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider`)
fetches from Open-Meteo and MeteoSwiss, normalizes both into `hour_start`-keyed
rows in UTC, resolves which provider a location uses (zone override, then the
new `OSI_WEATHER_PROVIDER_DEFAULT` UCI key, then a `local` skip), and computes
the fetch window from the newest row already stored. A new inject/function
node pair on the dendro-analytics tab, `weather-provider-tick` and
`weather-provider-fn`, calls this on a 30-minute cycle through the real
`osi-db-helper` facade. Everything here is edge-only: no GUI reads the table
yet and no cloud sync carries it.

## Gate outputs

Twenty-six gates ran for this branch: the twenty-four in the task brief's
Step 1, plus `migrate-flows-journal-v2-replication.test.js` and
`verify-live-gateway-identity.js`, both named separately because Task 7
touched the pins they check. Twenty-five were run once, before the pin-fix
committed below, and stayed green throughout — none of them touch migration
counts. The remaining one, `lib/osi-migrate/__tests__/*.test.js`, failed on
that same run (122 pass, 1 fail) and is shown here after the fix, at 123 pass,
0 fail; the failing subtest and its standalone rerun are listed as their own
rows.

| Command | Pass line (verbatim) |
|---|---|
| `node --test .../osi-weather-provider/index.test.js` | `# tests 34` / `# pass 34` / `# fail 0` |
| `node --test .../osi-weather-provider/facade-contract.test.js` | `# tests 1` / `# pass 1` / `# fail 0` |
| `node --test .../osi-lib/index.test.js` | `# tests 6` / `# pass 6` / `# fail 0` |
| `node scripts/verify-migrations.js` | `verify-migrations: OK (60 migrations, checksum manifest OK, base immutability OK)` |
| `node scripts/verify-seed-replay.js` | `verify-seed-replay: OK` |
| `node scripts/verify-runtime-schema-parity.js` | `verify-runtime-schema-parity: OK (2 flows: devices CHECK + runtime trigger parity)` |
| `node scripts/verify-db-schema-consistency.js` | `DB schema consistency verification passed` |
| `node scripts/verify-seed-db-ledger.js` | `verify-seed-db-ledger: OK (7 images stamped at migration head 60)` |
| `node scripts/verify-sqlite-cli-limits.js` | `verify-sqlite-cli-limits: OK` |
| `node scripts/verify-no-stray-ddl.js` | `verify-no-stray-ddl: OK (HEAD total 694 <= origin/main total 694; committed baseline matches HEAD total 694)` |
| `node scripts/test-journal-schema.js` | `test-journal-schema: OK (catalog v1 semantics, semantic FKs, guarded replay, seven-DB data parity)` |
| `node scripts/verify-helper-registration.js` | `All helper-registration checks passed.` |
| `node scripts/verify-module-file-deploy-coverage.js` | `OK: all 103 runtime files in deploy.sh-shipped osi-* modules are fetched.` |
| `node scripts/verify-osi-lib-db-caller-binding.js` | `verify-osi-lib-db-caller-binding: OK` |
| `node scripts/verify-profile-parity.js` | `All parity checks passed.` |
| `node scripts/verify-flows-fn-parse.js` | `verify-flows-fn-parse: OK` |
| `node scripts/flows-bare-require-scan.js` | No stdout, exit 0. It exports `scanFunctionNodes` for `verify-sync-flow.js` to call; run alone it does nothing observable. |
| `node scripts/test-flows-wiring.js` | `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed` |
| `node scripts/verify-no-new-silent-catch.js` | `verify-no-new-silent-catch: OK` (`bcm2712: 87 empty catches across 304 function nodes (baseline 87)`; same for bcm2709) |
| `node scripts/verify-flows-size-ratchet.js` | `verify-flows-size-ratchet: OK (HEAD total 3162850 <= origin/main total 3160836; committed baseline not exceeded)` |
| `bash scripts/check-mqtt-topics.sh` | `OK: <path> — no UUID patterns in MQTT IN topics`, once per profile (bcm2712, bcm2709, bcm2708) |
| `node scripts/verify-communication-contract.js` | `Communication contract verification passed` |
| `node scripts/verify-sync-flow.js` | Ends `All parity checks passed.`, after chaining through the communication-contract, db-schema, size-ratchet-allowance, identityd-lifecycle, and live-gateway-identity checks; roughly ten minutes wall time |
| `node --test lib/osi-migrate/__tests__/*.test.js` (before the pin fix) | `# tests 123` / `# pass 122` / `# fail 1`, reproduced on two independent runs |
| `node --test lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js` (after the pin fix) | `# tests 2` / `# pass 2` / `# fail 0` |
| `node --test lib/osi-migrate/__tests__/*.test.js` (after the pin fix) | `# tests 123` / `# pass 123` / `# fail 0` |
| `node --test scripts/migrate-flows-journal-v2-replication.test.js` | `# tests 6` / `# pass 6` / `# fail 0` |
| `node scripts/verify-live-gateway-identity.js` | `Live gateway identity verification passed.` |

## Live probe output

Run from the workstation against both providers, read-only, no gateway
involved:

```
open_meteo rows 1510 first 2026-07-25T00:00:00Z last 2026-09-25T21:00:00Z
meteoswiss station PAY 1.4 rows 6430 last 2026-09-25T21:00:00Z
```

Open-Meteo returned 1,510 hours of real values out of its 92-day request,
ending at the previous complete UTC hour. MeteoSwiss resolved station `PAY` at
1.4 km and returned 6,430 rows, also ending at the last complete hour
published.

## Size-ratchet numbers

Measured per maintained profile (bcm2712 and bcm2709 stay byte-identical):

| Metric | Value |
|---|---|
| Base (origin/main) | 1,580,418 chars |
| Head (this branch) | 1,581,425 chars |
| Delta | +1,007 |
| Node id | `weather-provider-fn` |

The delta is exactly the `func` length of `weather-provider-fn`, the "Weather
provider: store hours" node on the dendro-analytics tab. Summed across both
maintained profiles, the tool reports `HEAD total 3162850 <= origin/main total
3160836`.

## Fixes made along the way

Task 5 stripped a UTF-8 byte-order mark before Windows-1252 decoding in
`decodeCsv`, which MeteoSwiss's CSV export carries on its first field. Task 6
added an overall request deadline and response error handling to `httpDeps`,
so a hung or erroring HTTP call can no longer block the tick indefinitely.
This task's own gate run turned up a third: `runner-preexisting-add-column-real.test.js`
pinned its expected migration list to "through 0059" and needed the same bump
to 0060 that migration 0059 itself received in an earlier commit (#351),
appending 60 to `result.applied` rather than replacing 59.

## What was left out

Out of scope for this sub-project: any GUI change, a zone selector for
picking a provider from the dashboard, the agronomy writer that will read
`weather_provider_hours` into `zone_daily_agronomy`, and any cloud change or
sync of provider rows. Separately, the customer branches (private
`osi-os-customers` repo) still need `meteoswiss` added to their own
`uci-defaults` overrides of `OSI_WEATHER_PROVIDER_DEFAULT` — this branch only
sets the mainline default to `open_meteo`.

Sub-project 2 must take the MeteoSwiss daily ET0 from `d_recent`'s
`erefaod0`, not from the sum of the hourly `erefaoh0`. At PAY over 17 to 23
September the hourly values summed to 22.37 mm against 20.0 mm in the daily
column, a ratio of 1.12.

The gap rule and the `h_recent` throttle came in with the final fix wave
rather than the original tasks. A tick now looks back 7 days for a missing
hour, for either provider, and starts its window there: MeteoSwiss rebuilds
`h_recent` once a day, so the previous day's hours can sit in neither file
until then. `h_recent` itself is read only on a first fetch or for such a
gap, at most once per station every 2 hours.

## Merge order

The unmerged `feat/rak10701-coverage` branch carries a different `0060`
(`0060__add_rak10701_field_tester_type.sql`), and that migration is already
applied on linked test gateways. If that branch merges first,
this branch renumbers its migration to `0061` before merging:

1. Rename `database/migrations/ordered/0060__weather_provider_store.sql` to
   `0061__weather_provider_store.sql` and regenerate
   `database/migrations/ordered/CHECKSUMS.json`.
2. Run `node scripts/build-seed-db.js` to restamp the seed images.
3. In `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`,
   append `61` to the expected `result.applied`, keeping `60` (the RAK
   migration then holds that number).
4. If flows.json moved, re-measure `total_allowance` in
   `scripts/verify-flows-size-ratchet-allowances.json` and its pin in
   `scripts/verify-live-gateway-identity.js`.

## Acceptance still needing a test gateway

One acceptance step from the spec's "Testing and acceptance" section needs a
gateway. After one tick with internet, `SELECT COUNT(*) FROM
weather_provider_hours WHERE air_temperature_c IS NOT NULL` is at least 1,400
for an Open-Meteo location (about 60 days of real values in the 92-day
request) and `last_error` is null; after pulling the uplink, the next tick
sets `last_error` and the count is unchanged.

Run it on a test gateway only, and only after
`sqlite3 /data/db/farming.db "SELECT MAX(version) FROM schema_migrations"`
prints `59`. The spec also names a different gateway, but that one already
carries the RAK branch's own `0060` and would refuse this migration with
`repair_required: checksum mismatch`.
