# Pending human Luganda translations

Edge `lg` (Luganda) strings are human translation work product. A wrong
translation is worse than no translation: when no correct human Luganda text
exists for a key, the honest state is the English source text (a visible
fallback), never a machine translation and never a human translation left in
place after the English it translates has changed meaning underneath it.

This file tracks keys currently shipping the English fallback in
`web/react-gui/public/locales/lg/` for that reason, so they are not mistaken
for finished translation work. Each entry must be removed once a human
Luganda pass supplies correct text, and the corresponding test allowlist
entry (see below) removed in the same change.

## `accountLink.json`

| Key | Reason |
|---|---|
| `warning.message` | PR #150 (closed 2026-07-22, never merged) authored a human Luganda translation of this key against an older English string ("OSI OS keeps a secure offline copy of your linked login... so you can still sign in without internet"). The English has since changed to describe a different security mechanism ("OSI OS stores a gateway-specific offline verifier for linked login" — `bcrypt(password::DEVICE_EUI)`, not a synced credential copy; see `AGENTS.md` Security section). The old Luganda translation is a materially incorrect security disclosure against the current product and was replaced with the current English text in PR #248 pending a native-speaker pass. Flagged by Codex review, PR #248. |
| `rejected.title`, `rejected.count`, `rejected.lastReason`, `reauth.detected` | Added by the sync-health honesty change (branch `fix/sync-health-honesty`), which gave the account-link page two new states: a count of terminally rejected outbox events with the newest rejection reason, and an expired-sync-token banner that now appears without the operator first pressing "Force sync now". No human Luganda pass has seen these strings, and they carry operational meaning an operator acts on, so they ship the English source text rather than a machine translation. |
| `sync.outboxCounts.*` | Added to distinguish selected, applied, duplicate, retryable, rejected, protocol-error, and still-pending Force Sync outcomes, including rejected counts grouped by fixed code. No human Luganda pass has reviewed these nine operational strings, so they ship the English source text until that review occurs. |

Tracked in code at
`web/react-gui/src/pages/__tests__/accountLinkLocaleValues.test.ts`
(`PENDING_HUMAN_TRANSLATION.lg`), which allows this key to be identical to
`en` without failing the locale-parity guard, and requires it to be removed
from that set once corrected.

## `devices.json` and `network.json` — water card, sensor gating, dates

| Keys | Reason |
|---|---|
| `zone.configure`, `zone.chips.*`, `zone.groups.*`, `zone.water.*` (title, tiles, action codes, insufficient-data and water-balance reasons, source modes, soil status with its channel and depth), `common.viewHistory`, `common.batteryEstimated`, `environment.soil.moisture*`, `environment.soil.temperature`, `environment.forecast.dayToday`/`dayTomorrow`/`etaToday`/`etaTomorrow`, `environment.generatedAt`, `environment.loading`/`loadFailed`, `environment.tabs.*`, the `kiwiSensor` depth editor (98 keys in `devices.json`); `network.loadingDevices`, `network.noDevices`, `network.loadingObservations` (3 keys in `network.json`) | New keys added when the irrigation zone card's water card, the zone chips and the date/time helpers were routed through `t()`. The English text is the source text; no Luganda has been authored for any of them yet, and the shipped `lg` value is the English fallback rather than a machine translation. |
| `environment.water.*` (9 keys in `devices.json`: `noData`, `rainToday`, `measuredIrrigationToday`, `estimatedIrrigationToday`, `waterNeededToday`, `balance`, `setupRequired`, `trendNote`, `nextRain`; `weeklyTrend` was retired on 2026-09-26) | The zone environment card's Water tab called `t()` for these keys with a `defaultValue` but they existed in no locale file, so the tab shipped English in all seven languages (F59 sibling finding F35, overnight 2026-09-17). The five European locales were translated when the keys were added; no Luganda has been authored, so `lg` ships the English source text. |
| `zone.water.source.using_last_synced`, `zone.water.source.bundle_unavailable`, `zone.water.source.fallback_generic` (3 keys in `devices.json`) | Added so `IrrigationZoneCard.tsx` and `EnvironmentCard.tsx` could map `display.fallbackReason` (still plain English from the edge's zone-env-fn flow node, and sometimes from a linked gateway's cloud bundle) to a translated key instead of printing the sentence verbatim (F100/X-16, T13m, overnight 2026-09-17). The five European locales were translated when the keys were added; no Luganda has been authored, so `lg` ships the English source text. |
| `environment.water.lastSevenDays`, `tooltipDemand`, `stationCredit`, `today`, `legendDemand`, `legendDemandTodayForecast`, `demandCalculated`, `demandForecast`, `demandNoData`, `demandNoLocation`, `demandPending`, `tooltipTodayNote`, `kcLine`, `et0Tier.station_fao56`, `et0Tier.hargreaves_station`, `et0Tier.provider_open_meteo`, `et0Tier.provider_meteoswiss`, `et0Tier.forecast`, `attribution.open_meteo`, `attributionHelpLabel`, `neededTodayHelpLabel`, `neededTodayHelp`, `lastSevenDaysHelpLabel`, `setupRequiredHelpLabel`, `rainSourceHelpLabel`; `zone.water.rainFromStation`, `rainFromWeather`, `drivenByWaterBalanceFromWeather`, `drivenByWaterBalanceFromStation`, `zone.water.reason.rain_unknown`, `demand_unknown` (31 keys in `devices.json`) | Added by the Water tab's Last 7 days plot with per-day crop demand (2026-09-26); no human Luganda pass yet, so `lg` ships the English source text. |
| `environment.water.demandNoSource`, `demandMixedStation`, `demandUnknownStation`, `demandUnknownToday`, `et0Line`, `kcSourceByCrop` (6 keys in `devices.json`) | Added by the daily agronomy final fix wave (2026-09-26): the reasons a day has no crop demand, the day's ET0 and the crop beside a demand computed by the cloud or by this gateway. No human Luganda pass yet, so `lg` ships the English source text. The same wave rewrote the English `zoneConfig.stageHelp` (dormancy is for deciduous crops and annual rest periods), and `lg` carries the new English text. |
| `environment.water.kcSource.fao56_curve`, `stageOverrun`, `et0Tier.open_meteo_daily`, `computedBy.edge`, `computedBy.cloud`, `modelAccuracyNote`, `meteoswissCloudNote` (7 keys in `devices.json`) | Added by daily agronomy parity (the FAO-56 Kc curve, the stage-overrun flag and the days OSI Cloud computes in shared mode, 2026-09-27). The values are the cloud's translations, embedded from the cloud plans, so the two GUIs carry one translation of each key; `test-shared-agronomy-locales.js` keeps them equal. No human Luganda pass yet, so `lg` ships the English source text. |

Tracked in code at `web/react-gui/tests/waterCardLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`. A human Luganda pass must drop the key from that set
and from the table above in the same change; the test fails otherwise, so the
two cannot drift apart.

## `devices.json` — SystemPanel gateway card, and `common.json`

| Keys | Reason |
|---|---|
| `systemPanel.*` (27 keys in `devices.json`); `adminOnly` (1 key in `common.json`) | New keys added for the Gateway system-status card (SystemPanel.tsx) and the shared "Admin only" role-gating tooltip/hint (SystemPanel.tsx and SettingsPage.tsx), previously fully hardcoded English with no i18n at all (F32/F20, T13e, 2026-09-17). No native Luganda speaker has translated these yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. es/it/fr/de-CH/pt received natural human-quality translations in the same change. |

Tracked in code at `web/react-gui/tests/systemPanelLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`, the same mechanism `waterCardLocales.test.ts` uses
above. A human Luganda pass must drop the key from that set and from the
table above in the same change; the test fails otherwise, so the two cannot
drift apart.

## `settings.json` — access grants, and `devices.json` — dendrometer calibration, advanced schedule titles, LSN50 mode gating

| Keys | Reason |
|---|---|
| `grants.*` (22 keys in `settings.json`); `dendroCalibration.*` (58 keys), `advancedSchedule.section*` (9 keys), `lsn50Mode.*` (6 keys) in `devices.json` | New keys added for GrantsPage.tsx, DraginoDendroCalibrationSection.tsx, the 9 Section titles in AdvancedScheduleDrawer.tsx, and the MOD9/MOD3 sensor-gating captions in DraginoSettingsModal.tsx — all previously fully hardcoded English with no i18n at all (F37, T13f, 2026-09-17). No native Luganda speaker has translated these yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received natural human-quality translations in the same change. |

Tracked in code at `web/react-gui/tests/f37Locales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`, the same mechanism `waterCardLocales.test.ts` uses
above. A human Luganda pass must drop the key from that set and from the
table above in the same change; the test fails otherwise, so the two cannot
drift apart.

## `devices.json` — the two irrigation forms, and the Water tab's own keys

| Keys | Reason |
|---|---|
| `schedule.*` (trigger method, sensor, threshold helper, sensitivity, response mode, advanced settings — 21 keys); `zoneConfig.*` (title, crop, soil, irrigation method, area, efficiency, calibration, phenological stage, timezone, location, device GPS, notes, validation messages — 65 keys); `environment.water.effective`, `rainGaugeReporting`, `flowMeterReporting`, `tooltipRain`, `tooltipMeasuredEffective`, `tooltipEstimatedEffective` (6 keys) | New keys added when `ScheduleSection`'s two sub-forms and `ZoneConfigModal` were routed through `t()` — until then the only screen where a farmer sets the number that opens a valve, and the screen that sets every input to the water balance, rendered wholly in English inside every non-English screen — and when the Water tab's remaining hardcoded strings were keyed (E-21, E-22, F69, T13h, 2026-09-17). No native Luganda speaker has translated these yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received natural human-quality translations in the same change. |
| `zoneConfig.stage.unset`, `initial`, `development`, `mid_season`, `late_season`; `zoneConfig.stageLabel.woody.*` and `zoneConfig.stageLabel.annual.*` (5 stages each); `zoneConfig.stageHelpLabel`, `stageHelp`, `cropHelpLabel`, `cropHelp`, `cropOther`; `zoneConfig.cropGroup.*` (15 FAO-56 crop groups); `environment.agronomic.kcHelpLabel`, `kcHelp`; `environment.water.kcSource.fao56_crop`, `fao56_crop_stage_unset`, `heuristic_phenology`, `server`, `local`, and `environment.water.stageNotSet` (43 keys in `devices.json`) | Added by the daily agronomy record (FAO-56 crop and stage settings, 2026-09-26); no human Luganda pass yet, so `lg` ships the English source text. The same change retired `zoneConfig.stage.default`, `budbreak`, `fruitset`, `veraison` and `harvest`. The `zoneConfig.*` and `environment.agronomic.*` keys are listed in `zoneFormLocales.test.ts`, the `environment.water.*` keys in `waterCardLocales.test.ts`. |
| `zoneConfig.stageStartedOn`, `stageStartedOnHelpLabel`, `stageStartedOnHelp`, `stageStartedOnHelpNoLength` (4 keys in `devices.json`) | Added by daily agronomy parity (the stage start date of the FAO-56 Kc curve in the zone settings, 2026-09-27). The values are the cloud's `zoneConfigModal.stageStartedOn.*` texts, embedded from plan CB. No human Luganda pass yet, so `lg` ships the English source text. The keys are listed in `zoneFormLocales.test.ts`. |

Tracked in code at `web/react-gui/tests/zoneFormLocales.test.ts`, which asserts
each key's `lg` value is still byte-identical to `en`, the same mechanism
`waterCardLocales.test.ts` uses above. A human Luganda pass must drop the key
from that list and from the table above in the same change; the test fails
otherwise, so the two cannot drift apart.

## `devices.json` — zone and device rename

| Keys | Reason |
|---|---|
| `rename.zone`, `rename.device`, `rename.zoneInputLabel`, `rename.deviceInputLabel`, `rename.reason.name_empty`, `rename.reason.name_too_long`, `rename.reason.name_control_characters`, `rename.reason.name_invalid_unicode`, `rename.failed` (9 keys in `devices.json`) | New keys for the rename pencil on the zone card and the seven device surfaces, and for the four reason codes of the shared name rule. No native Luganda speaker has translated them yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received human-quality translations in the same change. |

Tracked in code at `web/react-gui/tests/renameLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`, the same mechanism the sections above use. A human
Luganda pass must drop the key from that set and from the table above in the
same change; the test fails otherwise, so the two cannot drift apart.

## `devices.json` and `common.json` — weather data view

| Keys | Reason |
|---|---|
| `zoneConfig.weatherProvider`, `weatherProviderHelpLabel`, `weatherProviderHelp`, `weatherProviderOption.auto`, `open_meteo`, `meteoswiss`, `local`, `weatherProviderCloud` (8 keys in `devices.json`); `analysis.aggregation.helpLabel`, `analysis.aggregation.help`, `analysis.tooltip.partialHours`, `analysis.tooltip.partialDays` (4 keys in `common.json`) | Added by the weather data view (the zone weather provider selector, the Data tab's aggregation tip and the partial-sum marker, 2026-09-27). No human Luganda pass yet, so `lg` ships the English source text. The `zoneConfig.*` keys are listed in `zoneFormLocales.test.ts`, the `analysis.*` keys in `analysis-locales.test.ts`. |

Tracked in code at `web/react-gui/tests/zoneFormLocales.test.ts` and
`web/react-gui/tests/analysis-locales.test.ts`, which assert each key's `lg`
value is still byte-identical to `en`. A human Luganda pass must drop the key
from the test's list (`KEYS` in `zoneFormLocales.test.ts`,
`PENDING_HUMAN_LUGANDA` in `analysis-locales.test.ts`) and from the table above
in the same change.

## Related keys not listed here

Two other `accountLink.json` keys recovered from PR #150 in the same
PR #248 pass (`sync.running`, `reauth.running`: ellipsis glyph `…` vs `...`;
`reauth.description`: "issue a new" vs "mint a fresh" sync token) also show
English wording drift since the Luganda was authored, but the drift does not
change meaning — both are paraphrases of the same fact. They are not tracked
here.

## `devices.json` — WATERMARK soil tension

| Keys | Reason |
|---|---|
| `watermark.*` (48 keys in `devices.json`: section title, probe labels, resistance/offset/temperature/supply readouts, the thirteen status codes, the probe-depth editor and the calibration form) | New keys added for the IRROMETER WATERMARK 200SS soil-tension probes on the LSN50 card — the probe section, the depth editor and the calibration form (`WatermarkProbeSection.tsx`, `WatermarkDepthSection.tsx`, `WatermarkCalibrationSection.tsx`, `DraginoTempCard.tsx`, `DraginoSettingsModal.tsx`). No native Luganda speaker has translated them yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received human-quality translations in the same change; "WATERMARK" stays untranslated as the product name, and `status.ok`, `wetUpTo`, and the two Ω-suffixed calibration field labels that are established electronics loanwords (`pullup`, `pulldown`) may legitimately match English since they are units, symbols, or "OK". `seriesFwd`/`seriesRev` ("Series, forward"/"Series, reverse") are plain English prose rather than loanwords and are translated in all five European locales, not exempted. |

Tracked in code at `web/react-gui/tests/watermarkLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which collects every leaf key under `devices.json`
→ `watermark` dynamically and asserts each key's `lg` value is still
byte-identical to `en`, the same mechanism the sections above use. A human
Luganda pass must drop the key from that set and from the table above in the
same change; the test fails otherwise, so the two cannot drift apart.

## `settings.json` — module visibility switches

| Keys | Reason |
|---|---|
| `dataModule`, `networkModule`, `gatewayHub`, `journalModule`, `moduleSaveError`, `experimentalOnly` (6 keys in `settings.json`) | New Settings rows for the Data view, Network, Gateway and Field Journal modules, added when those four became switchable and then promoted to gateway-level settings carrying an "experimental only" marker (owner decisions, 2026-09-17). No native Luganda speaker has translated them yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received human-quality translations in the same change; `gatewayHub` deliberately stays "Gateway" in de-CH/it/es/pt, matching the loanword `devices.json` `systemPanel.title` already ships for those locales, and is "Passerelle" in fr. |

Tracked in code at `web/react-gui/tests/moduleVisibilityLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`, the same mechanism the sections above use. A human
Luganda pass must drop the key from that set and from the table above in the
same change; the test fails otherwise, so the two cannot drift apart.

## `network.json` — the coverage walk view

| Keys | Reason |
|---|---|
| `coverage.title`, `coverage.window`, `coverage.windowLastHour`, `coverage.windowHours`, `coverage.windowDays`, `coverage.export`, `coverage.points_one`, `coverage.points_other`, `coverage.gateway`, `coverage.legendStrong`, `coverage.legendWeak`, `coverage.noPosition`, `coverage.noPoints`, `coverage.captureOff` (14 keys in `network.json`) | New keys for the coverage view NetworkPage gained for the RAK10701 field-test walk: the RSSI legend, the time-window picker, the GeoJSON/CSV export, and the three honest empty states (capture switched off, no gateway position, no positioned observation). No native Luganda speaker has translated them yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received human-quality translations in the same change; `coverage.gateway` deliberately stays "Gateway" in de-CH/it/pt, matching the loanword those bundles already use, and is "Passerelle" in fr and "Pasarela" in es, matching `network.noDevices` in that bundle. `coverage.points` carries plural forms, so Luganda holds English's two categories (`_one`, `_other`); fr/es/it/pt additionally carry `_many`, which their CLDR rules have and English does not, and which is therefore outside this list. |

Tracked in code at `web/react-gui/tests/coverageLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`, the same mechanism the sections above use. A human
Luganda pass must drop the key from that set and from the table above in the
same change; the test fails otherwise, so the two cannot drift apart.

## `network.json` — the observations show-all/show-fewer toggle

| Keys | Reason |
|---|---|
| `showAllObservations`, `showFewerObservations` (2 keys in `network.json`) | NetworkPage's Observations list rendered every fetched row (~500 on a coverage walk, ~20,000px tall) with no way to collapse it; these two keys drive a toggle that shows the most recent 20 by default. No native Luganda speaker has translated them yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received natural human-quality translations in the same change. |

Tracked in code at `web/react-gui/tests/coverageLocales.test.ts`
(`PENDING_HUMAN_LUGANDA_TOP_LEVEL`), which asserts each key's `lg` value is
still byte-identical to `en`, the same mechanism the sections above use. A
human Luganda pass must drop the key from that set and from the table above in
the same change; the test fails otherwise, so the two cannot drift apart.

## `devices.json` — the field tester card

| Keys | Reason |
|---|---|
| `fieldTester.badge`, `fieldTester.sectionHeading`, `fieldTester.openCoverageMap`, `fieldTester.readingsOnMap` (4 keys in `devices.json`) | New keys for `FieldTesterCard.tsx`: a registered RAK10701 field tester (type `RAK10701_FIELD_TESTER`) matched no `type_id` filter on the dashboard or an irrigation zone's device grid, so the "Unassigned Devices" section rendered its dashed box and subtitle with nothing inside and no way to see or remove the device — verified on real hardware ahead of the 2026-09-25 demo. A second finding on the same rehearsal: the edge never gives a field tester's uplinks a `last_seen` (they land in the radio store, not `device_data`, which is where `GET /api/devices` derives `last_seen` from), so the card's original last-seen line and online/offline pill were dropped before ship — `fieldTester.online`, `offline`, `lastSeen` and `neverSeen` no longer exist. The card is identity-only (name, badge, DevEUI, a link to the network map at `/network` shown only when the gateway's Network module is on, and a neutral footer line pointing at that map instead of a claimed recency). No native Luganda speaker has translated these yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received human-quality translations in the same change. |

Tracked in code at `web/react-gui/tests/fieldTesterLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`, the same mechanism the sections above use. A human
Luganda pass must drop the key from that set and from the table above in the
same change; the test fails otherwise, so the two cannot drift apart.
