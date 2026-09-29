# Weather in the data view — execution report

> **Migration numbers after landing.** origin/main took 0060
> (`add_rak10701_field_tester_type`) and 0061 (`watermark_lsn50`) while this
> stack was open, so the stack's six migrations were renumbered on the merge
> with main, content unchanged apart from the header comment:
> `0060__weather_provider_store` -> `0062`, `0061__daily_agronomy` -> `0063`,
> `0062__fao56_stage_keys` -> `0064`, `0063__zone_weather_source_sync` ->
> `0065`, `0064__stage_started_on` -> `0066`, `0065__zone_daily_agronomy_sync`
> -> `0067`. The numbers below are the ones in use when this report was
> written.

Sub-project 3 of the provider weather package puts provider hours, station
hours and the daily agronomy record into the analysis (data view) page and
gives a zone its own weather-provider choice. Ten tasks landed across two
repositories: Tasks 1–9 on `feat/weather-data-view` in this repository
(osi-os), based on `feat/daily-agronomy` at `8531f1dd1`, and Task 10 on the
paired branch `feat/weather-data-view` in osi-server. Tasks 1–8 are
committed; this report covers Task 9 (docs, whole-branch gates, this
report). Landing either branch to its own `main` needs the other pushed
first and merged in lockstep: gates 4 and 6 below pin the cloud copies of
`channels.json` and `resources.schema.json` that Task 10 vendors, and the
two repositories' CI compares each branch against the same-named branch of
the other (`docs/superpowers/specs/2026-09-27-weather-data-view-design.md`,
"Landing requirements").

## What was built

**Task 1** (`673bcb086`, 18 files, +1057/-2) adds three weather-only channels
to the manifest — `global_radiation_wm2`, `et0_mm`, `etc_mm` — and a
`DEVICE_EXCLUDED_CHANNELS` set that keeps them out of the device catalogue and
every card channel list. A pre-change device-catalogue snapshot fixture (28
device entries, captured before any source edit) pins the exclusion so a
later regression shows as exactly three extra rows, not a silent drift.

**Task 2** (`3dca94725`) gives `aggregateRows` in `osi-history-helper` a
bucket `sum` beside the existing mean, rounded the same way, `null` for an
empty bucket. It also lands Task 1's carried-over review item: the zone-export
test now seeds a `device_data` row for `et0_mm` and asserts no recorded SQL
names that column, proving the "no device query for a weather-only key"
behavior rather than assuming it.

**Task 3** (`13a0fc80c`) is the resolver change: `SOURCE_KINDS` and
`aggToPoints` in `analysis.js` add provider hours, station hours and the
`zone_daily_agronomy` record as data-view sources, grouped and capped at
30,000 rows total across device, provider and station groups. Open-Meteo's
instantaneous channels (temperature, humidity, wind) plot at `hour_start + 1h`
— the instant they describe — while accumulated and mean channels plot at
`hour_start`; a zone missing a `weather_locations` row simply carries no
provider entry in the catalogue (its agronomy entries are unaffected).
Final fix wave item A4 (final review finding I4, queue T3 M1) later added
the guard an earlier draft of this report wrongly claimed was already in
place at Task 3: when the `weather_locations` / `weather_provider_hours` /
`weather_station_hours` / `zone_daily_agronomy` tables themselves are
absent, the catalogue lists device sources only, logs one warning per
process, and a series request for a weather selector reports it under
`dropped` with reason `source_unavailable`; any other error still answers
500.

**Task 4** (`7e3b5fd5f`, 31 files) is the GUI half of Task 3: channel labels
for the three weather kinds, a device-only preset so a metric-across-zones
comparison never pulls in a provider series, a HelpTip beside the aggregation
badge, partial-bucket marks in the tooltip ("n of N h"), and zone-local dates
in the daily CSV export. English help text was copied byte-identical from the
spec into seven locale bundles.

**Task 5** (`2e8f9b96c`) adds migration 0063: the zone sync trigger
(`trg_sync_zones_outbox_au`) carries `weather_source` in its outbox payload,
and `seed-blank.sql`, the canonical trigger source, all seven bundled
`farming.db` images and the `sync-init-fn` ratchet/identity pins move
together. The work was written by an opus implementer who was cut off by a
rate limit before committing; a sonnet agent verified every artifact
byte-for-byte against the brief, ran the full gate list, and made the commit.
No content changed between the two agents' passes.

**Task 6** (`ef69fa022`) wires `weather_source` into the zone write and read
paths: `zone-config-fn` (the `PUT /api/irrigation-zones/:zone_id/config`
route) validates and stores it, `get-zones-query`/`get-zones-response` return
it with a `weather_source_default`, and both snapshot builders
(`sync-bootstrap-build`, `sync-force-build`) carry it in the zone payload. All
three capability builders — those two plus `al-link-build-req` — now
advertise `zone_config_weather_source_v1`.

**Task 7** (`f8937fcf9`) covers the two cloud-to-edge command paths: legacy
`UPSERT_ZONE_CONFIG`/`UPSERT_ZONE` in flow node `4f4a765f36cee6f3` ("Build
UPDATE SQL") store the field with the same `^[a-z_]{1,20}$` shape check, and
the protected `UPSERT_ZONE`/`UPSERT_ZONE_LOCATION` path in
`osi-zone-commands` accepts it on insert and full update.
`resources.schema.json`'s `Zone` definition gains `weather_source` with the
shape constraint only — no enum, since the cloud's provider set is wider than
the edge's.

**Task 8** (`8b1aea5fb`, 14 files) adds the provider selector to
`ZoneConfigModal`: auto plus the edge's three providers, with cloud-only
provider values shown as a disabled option when a zone already carries one,
save-only-on-change, and locale keys across all seven bundles plus the
Luganda pending-translations doc.

**Task 9** (this commit) updates `AGENTS.md`'s sync-capabilities paragraph and
provider-weather-store paragraph, adds a "Zone `weather_source`" section to
`docs/contracts/sync-schema/README.md`, runs every gate in the brief's Step 3,
and writes this report.

**Task 10** (`3c3fe5dc` on the osi-server branch `feat/weather-data-view`) is
the cloud-side channel manifest mirror this branch's edge changes require:
both `channels.json` copies and the vendored `resources.schema.json` hash to
the edge files' hashes (`7c3e70e6…f105` and `8ce1f95c…d61b`), the registry's
`hasStoredColumn` rule matches the edge rule with its own test (including
the `vwc` case, a server-only column that stays listed), and the three
manifest-parity pins (`ChannelManifestTest`, `channels.parity.test.ts`,
`verify-channel-manifest-sync.js`) carry the new hash. `docs/channel-manifest.md`
records it on both sides. Not pushed.

## Gates

Every command from the brief's Step 3 ran on this worktree with
`TMPDIR=/var/tmp/osi-weather-data-view` and, for the two commands that read
osi-server files, `OSI_SERVER_REJECTION_RECOVERY_CONTRACT` and
`OSI_SERVER_EDGE_SYNC_SERVICE` pointed at
`<osi-server>/.worktrees/weather-data-view`. All fifteen
passed.

| # | Command | Pass line (verbatim) |
|---|---|---|
| 1 | `node --test osi-history-helper/{index,analysis}.test.js osi-weather-provider/{index,facade-contract}.test.js osi-station-hours/index.test.js osi-agronomy-daily/index.test.js osi-lib/index.test.js osi-entity-name/*.test.js` | `# tests 197` / `# pass 197` / `# fail 0` |
| 2 | `node osi-history-router/index.test.js && node osi-journal/index.test.js` | `67 passed, 0 failed` / `PASS` (history-router), then `# tests 170` / `# pass 170` / `# fail 0` (journal) |
| 3 | `node scripts/test-history-helper.js && node scripts/capture-history-router-vectors.js --verify && node scripts/capture-zone-env-vectors.js --verify && node scripts/verify-history-api-contract.js` | `verify-history-api-contract: OK` (preceded by `[verify] 4/4 routes passed.` and `Verified zone-env vector shared-server-stale`) |
| 4 | `node scripts/verify-channel-manifest-parity.js` | `Channel manifest parity verification passed` |
| 5 | `node --test scripts/test-zone-weather-source.js scripts/test-zone-command-path.js scripts/test-zone-update-sync-version.js scripts/test-legacy-upsert-zone-name.js scripts/test-entity-name-command-path.js scripts/test-scoped-access-reads.js scripts/test-scoped-access-writes.js scripts/test-scoped-access-command-path.js scripts/test-terra-selection-edge-acceptance.js scripts/test-terra-zone-config-command-flow.js scripts/test-sync-trigger-source.js scripts/verify-trigger-body-parity.test.js scripts/verify-sync-op-parity.test.js` | `# tests 288` / `# pass 288` / `# fail 0` |
| 6 | `node scripts/test-journal-bootstrap.js && node scripts/test-contract-schemas.js && node scripts/verify-sync-contract.js && node scripts/test-rejection-recovery-contract.js` | `rejection recovery contract: OK (vendor <osi-server>/.worktrees/weather-data-view/backend/src/test/resources/sync-contract/rejection-recovery-v1.json)` |
| 7 | `node scripts/generate-sync-trigger-source.js --check` | `sync trigger source check passed (31 SQL definitions)` |
| 8 | `node scripts/verify-migrations.js && ... && node scripts/verify-no-stray-ddl.js && node scripts/test-journal-schema.js` | `test-journal-schema: OK (catalog v1 semantics, semantic FKs, guarded replay, seven-DB data parity)` |
| 9 | `node scripts/verify-helper-registration.js && node scripts/verify-module-file-deploy-coverage.js && node scripts/verify-osi-lib-db-caller-binding.js && node scripts/verify-profile-parity.js` | `All parity checks passed.` |
| 10 | `node scripts/verify-flows-fn-parse.js && node scripts/flows-bare-require-scan.js && node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/verify-flows-size-ratchet.js && bash scripts/check-mqtt-topics.sh` | `OK: conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json — no UUID patterns in MQTT IN topics` (third of three OK lines) |
| 11 | `node scripts/verify-live-gateway-identity.js && node scripts/verify-sync-flow.js` | `Live gateway identity verification passed.`, then `All parity checks passed.` |
| 12 | `node --test lib/osi-migrate/__tests__/*.test.js` | `# tests 123` / `# pass 123` / `# fail 0`, `duration_ms 988587.9` (16m29s) |
| 13 | `node --test scripts/reconcile-ledger-numbering.test.js` | `# tests 34` / `# pass 34` / `# fail 0`, `duration_ms 1069969.8` (17m50s) |
| 14 | `(cd web/react-gui && npm run test:unit && npm run typecheck)` | tsx `# tests 183` / `# pass 182` / `# fail 0` / `# skipped 1`; vitest `Test Files 203 passed (203)` / `Tests 2161 passed (2161)`; `npm run typecheck` exit 0, no diagnostics |
| 15 | `node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md docs/contracts/sync-schema/README.md docs/i18n/pending-luganda-translations.md docs/channel-manifest.md docs/superpowers/plans/2026-09-27-weather-data-view.md docs/superpowers/specs/2026-09-27-weather-data-view-design.md` | `slop-check: PASS (no tier-1 findings)` (one tier-2 note: `AGENTS.md` em-dash density 8.7/1000 words against an 8/1000 budget, pre-existing in the file, not raised by this task's two edits) |

Gates 12 and 13 are the ones the brief calls out by name. Task 5 measured
these same two suites at roughly 828s and 945s when it ran them concurrently
on 2026-09-27. This run also ran them concurrently, alongside the frontend
`test:unit`/`typecheck` pass and the rest of Step 3, on a workstation that
peaked at 8.7 load average and 18 GiB of swap in use; wall time came in at
988.6s and 1070.0s. Pass counts match Task 5's exactly (123/123, 34/34) —
slower, not different.

## Ratchet numbers

| Node | origin/main | HEAD | Δ |
|---|---|---|---|
| `sync-init-fn` | 81736 | 83130 | +1394 |
| `zone-config-fn` | 9706 | 10443 | +737 |
| `get-zones-query` | 4958 | 4977 | +19 |
| `get-zones-response` | 1807 | 2144 | +337 |
| `sync-bootstrap-build` | 44956 | 45106 | +150 |
| `sync-force-build` | 68992 | 69142 | +150 |
| `al-link-build-req` | 6709 | 6742 | +33 |
| `4f4a765f36cee6f3` | 19386 | 20873 | +1487 |
| **Total (both profiles)** | **1580418** | **1588863** | **+8445** |

The eight listed nodes sum to +4307; the remaining +4138 of the total is
carried forward from the still-unmerged base branch `feat/daily-agronomy`
(`weather-provider-tick` 0, `weather-provider-fn` 1467, `station-hours-fn`
1525, `agronomy-daily-fn` 1515, `zone-env-fn` -369), recorded as its own
`total_allowance` reason in `scripts/verify-flows-size-ratchet-allowances.json`
and re-verified, not re-measured, by this task's gates. The two additions are
disjoint node sets, so they sum rather than overlap.

`sync-init-fn`'s deltas are Task 5's (+212) and the final review's item B1
(+1182 more, to +1394 total): the zone sync trigger's payload changed from an
unconditional `weather_source` field to the object-spread/`CASE` form that
omits the key unless the stored value is not `auto` or changed in this
update. The other seven nodes' deltas are Tasks 6 and 7, except
`sync-bootstrap-build` and `sync-force-build`, whose own +96 also grew to
+150 under the same B1 fix (the zone snapshot spreads `weather_source` in
only when it is not `'auto'`, instead of always sending it). Three
`expectedGrowth` entries in `scripts/verify-live-gateway-identity.js` were
re-pinned rather than added fresh, because Tasks 6–7 grow nodes that a prior
branch had already grown by an amount now baked into `origin/main`:

- `sync-bootstrap-build`: 1373 → 150 (origin/main already carries the 1373 at
  44956 chars; this branch's own addition — the zone SELECT, the conditional
  zone-map spread, and the capability token — measures 44956 → 45106).
- `sync-force-build`: 3265 → 150 (origin/main already carries the 3265 at
  68992 chars; same three additions, 68992 → 69142).
- `al-link-build-req`: 2511 → 33 (origin/main already carries the 2511 at
  6709 chars; one capability token added, 6709 → 6742).

## Deviations from the spec

- No rebase was needed: the base `8531f1dd1` already carries `6e0ea32cd` and
  the frozen-snapshot fix.
- Both GUI channel registries (edge Task 1, cloud Task 10) leave a manifest
  channel with neither an edge nor a server column out of card channel lists
  — a plan-review decision; the spec's exclusion covered only the analysis
  device catalogue.
- The analysis chart's tooltip formatter replaces ECharts' default for every
  series, with the default layout copied — accepted in plan review, at the
  cost that a future ECharts upgrade restyling the default tooltip will not
  be picked up automatically.
- `test-entity-name-command-path.js` and `test-journal-bootstrap.js`
  capability pins were updated for `zone_config_weather_source_v1`, which the
  spec does not name directly (it follows from the capability existing at
  all).
- `channels.test.ts` accepts a `null` `serverField`, because the spec's three
  weather-channel manifest entries carry `null` there.
- The Terra fixture was regenerated in Task 5, where the zone payload gains
  `weather_source`.
- The osi-server frontend parity test's SHA pin is Task 10's, not named in
  this spec.

## Known red not owned here

None. Every gate in Step 3 passed on this run; no test or verifier failed for
a reason that predates this branch.

## Follow-ups

As Task 9 wrote it, before the final review and fix wave below resolved most
of the `final-fix-queue.md` items; see "Final review and fix wave" for the
current state and what remains.

From the spec:

- Store Open-Meteo's instantaneous values at their own instant rather than
  the bucket edge, if a future task needs that precision.
- Provider weather in the zone CSV export endpoint, if a user asks for it.
- The spec's "Paired cloud changes" items for sub-project 4, including the
  Terra fixture refresh on osi-server.

From `final-fix-queue.md` (deferred task-review findings, open for a final
fix wave before merge):

- T1 nit: `channels.test.ts` should pin the null-`serverField` set to exactly
  the three weather keys, not just accept `null`.
- T2 minor: the zone-export test should use `channels: 'et0_mm,swt_1'` so a
  real `device_data` query runs; `rollupRowsToResult` carries no `sum` —
  worth a comment or an explicit `sum: null`.
- T3 I1 (correctness): weekly buckets of the daily kind must be built from
  seven local dates, not a fixed 168-hour UTC span — a spring clock change
  otherwise produces an 8-day "week".
- T3 I2 (performance): cache `Intl.DateTimeFormat` per timezone (or build
  buckets once per group) in `aggregationBuckets`/`zoneDateStartIso`; a
  400-day, 13-series request measured 3.7s against a <1s target.
- T3 M1 (ruled, not yet implemented): a gateway missing the weather tables
  should degrade to the device-only catalogue with one warning, not fail the
  request with 500.
- T3 M2: add tests for the `OSI_WEATHER_PROVIDER_DEFAULT` fallback, the `15m`
  level on hourly kinds, and a raw hourly point with a stored `null`.
- T3 M3/N1–N4 (optional): one station query per zone instead of per-call;
  drop unused `SOURCE_KINDS` fields; dedupe the entry-literal/series-envelope
  construction; read the provider's extra hour only for Open-Meteo;
  `providerSourceName` explicit per provider.
- T3 advice: split `analysis.js` (currently one file covering device,
  provider and station resolution) into `analysis-sources.js` at roughly 300
  lines, alongside the I1 fix; add it to `deploy.sh` coverage and the bcm2709
  mirror.
- T4 M1: the code comment claiming "device series look as today" is false
  once the layout is stacked (one shared header, device series listed
  first); reword the comment — the behavior itself was accepted.
- T4 m2: loosen the `HelpTip` doc comment to leave final wording to the spec.
- T4 m3: give the zone container its own named `aria` group, so a screen
  reader does not announce two identical provider group names across zones.
- T4 m4: add a tray test asserting the provider group renders after the
  device groups.
- T4 n5/n6: re-indent the JSX touched in Task 4; fix de-CH "15-Minuten-,
  stündlicher, …" wording, it/es "momento" instead of "ora/hora della
  misura", and the it `partialDays` abbreviation "gg".

## Final review and fix wave

Reviewer: fable, 2026-09-28, edge head `7816e1257` (`final-review-fable.md`).
Verdict: READY WITH FIXES, no blockers. Four Important findings, thirteen
Minor findings, and a verdict on every deferred `final-fix-queue.md` item.
Fixed in a two-part wave (`final-fix-brief.md`), Part A backend/GUI first,
Part B sync/docs second, both sonnet implementers, both budgeted.

| Finding | What it found | Resolution | Commit(s) |
|---|---|---|---|
| I1 | Deploy-order risk understated: the trigger and both snapshots sent `weather_source` unconditionally (`auto` by column default), so any gateway on this branch would overwrite a cloud-chosen provider within one six-hour bootstrap cycle; AGENTS.md and the contract README described the cloud's capability-gated send in the present tense though it ships with sub-project 4 | B1: the trigger's payload and both snapshots carry the key only when the stored value is not `auto`, or (trigger only) when it changed in this update; migration 0063 rewritten in place; docs reworded to "from sub-project 4 on" with a Deploy order paragraph; the spec's Decisions table and "Ownership and deploy order" section record the ruling | `c8811dc9b`, `b092b9ca5`, `96443771e` |
| I2 | Daily/weekly means of a partial bucket carried no `expected`/`quality` mark (`sum` channels only, not `mean`), so the last point of most default-range views looked like a full-period mean | A3 (Part A) | `faece2e7f` |
| I3 | The measured performance remedy for queue T3 I2 reached about half the cost, and the real cost is an event-loop stall on a Pi 4, not just wall time; measured 5.4s for 399 d daily 13-series at load 6.6 | A1 (Part A): single-pass bucket assignment, per-call `Intl.DateTimeFormat` cache; benchmark 399 d × 13 series: 3.8s → 0.58s | `65f4d36f5` |
| I4 | Report: one false claim (device-only fallback attributed to Task 3, actually not implemented until A4), three omissions (lockstep landing requirement, Task 10, the ratchet total's carried-forward amount), two acceptance steps that cannot be carried out as written (step 7 needs the zone still on the changed provider; step 3 needs the CSV, not the one-decimal tooltip) | This report: opening paragraph, corrected Task 3 paragraph, Task 10 paragraph, ratchet clarification sentence, acceptance steps 3 and 6/7 | this edit |

A4 (queue T3 M1, tables-absent guard the Task 9 report wrongly claimed was
already live) and A2 (queue T3 I1, local-date weekly buckets for the daily
kind) landed in Part A alongside I2/I3, `faece2e7f`; A7 (splitting
`analysis.js` into `analysis-sources.js`) in `3523b04cc`; A8 (GUI polish:
named ARIA zone groups, tooltip/HelpTip comments, locale wording, the
`channels.test.ts` null-`serverField` pin) in `75a27f252`. A5/A6 (test
coverage for the env-default fallback and the `15m` level, and the cheap
N1–N4 cleanups) landed with A1–A4 in the same two commits.

**Minor findings.** M1 (customer-named hostname): fixed here and in the
spec, the linked test gateway's real hostname replaced by "the
MeteoSwiss-default test gateway".
M2 (migration number 0060 claimed by three branches, not two): recorded
below, not renumbered -- renumbering is a merge-order decision, not a fix
this wave makes unilaterally. M11 (protected-path `null` handling) needed no
change, already ruled and tested; sub-project 4 must send `'auto'`
explicitly to reset a provider on that path. M3–M10, M12 and M13 are real
but each is a logic, schema or GUI-feature change wider than a doc or
one-line fix (a new channel key or context-aware relabeling for M7, a new
CSV column for M8, surfaced coverage errors for M13, and so on); they stay
open, listed with the `final-fix-queue.md` items above.

**Handover: three branches claim migration 0060**, not two: this stack
(`0060__weather_provider_store`), `feat/rak10701-coverage`
(`0060__add_rak10701_field_tester_type`, which also lacks 0059) and
`feat/watermark-lsn50` (`0060__watermark_lsn50`). Settle the merge order and
renumber together before landing more than one of the three.

The fix wave's B1 rewrote the zone update trigger's payload as a `CASE`
whose `json_patch` branch adds `weather_source` conditionally, which left
`scripts/verify-sync-op-parity.js` red (`payload_json missing
contract_version` for both flows, the seed and the seven bundled databases)
and failed its unit test `accepts seed SQL trigger ops as a canonical
subset`; the verifier did not yet read into a `CASE` or treat `json_patch`
like `json_insert`. Fixed by the follow-up commit
`fix(verify): op parity reads the conditional zone payload`.

## Acceptance

Not run. It waits for the merge order of the RAK branch and the three
weather branches, and for the sub-project 4 cloud change to be live on each
gateway's cloud (spec "Ownership and deploy order"). The spec's eight
acceptance steps, copied here unticked:

- [ ] 0. Before deploying, save a view `device-baseline` with one soil series
      and one S2120 device series on the 7-day range, and note three values
      from each.
- [ ] 1. The Data tab lists under each located zone an `Open-Meteo …`
      (the demo gateway) or `MeteoSwiss …` (the MeteoSwiss-default test gateway) group
      with six channels, and a `<zone name> daily agronomy` group with two.
      Every tray button of these groups shows its channel name, not the
      source name.
- [ ] 2. Provider sums per local day: pick the 30-day range, select the
      provider's rain and ET0 channels, save the view as
      `weather-acceptance`. The tooltips of the last seven complete days
      match, within 0.1, the `weather_provider_hours` SQL sum in the spec. A
      day with `COUNT(*)` below 24 shows "(n of 24 h)"; the rain and ET0
      panels read `mm/d`.
- [ ] 3. ET0 against the daily record: for days with
      `et0_tier = 'provider_hourly_sum'`, compare through the CSV export (the
      chart tooltip's one-decimal display cannot resolve this): the provider
      ET0 daily points match `zone_daily_agronomy` within 0.01 (record N/A on
      the demo gateway if the station tier wins every day).
- [ ] 4. Station source on the demo gateway: a `<station name> (hourly)` group
      appears; the last three temperature points and the 30-day rain sums
      match `weather_station_hours` within the spec's tolerances.
- [ ] 5. Daily agronomy: the `et0_mm`/`etc_mm` points match
      `zone_daily_agronomy`; a null day shows as a gap, a valid day between
      two null days shows as a dot (record N/A if no null day exists); the
      CSV export carries `YYYY-MM-DD` dates and unit `mm/d`.
- [ ] 6. Provider change: the auto option's label names the gateway default;
      changing the zone's provider updates `irrigation_zones.weather_source`,
      emits exactly one new `ZONE_CONFIG_UPSERTED` outbox row, survives a
      Notes-only save unchanged, and the next weather tick (≤30 min) adds a
      `weather_locations` row for the new provider. Do not set the zone back
      yet -- step 7 needs it still on the changed provider, since the new
      `locationKey` (and `sourceKey = sha256(locationKey)`) only exists while
      the zone stays there; setting it back first makes step 7 vacuous (the
      saved view then reads the original, still-present location and drops
      nothing).
- [ ] 7. While the zone is still on the changed provider, open
      `weather-acceptance`: it reports the dropped provider series from
      before the change and keeps the rest. Then set the zone back to its
      original provider.
- [ ] 8. Open `device-baseline`: no dropped-series notice, and the noted
      values are unchanged.
