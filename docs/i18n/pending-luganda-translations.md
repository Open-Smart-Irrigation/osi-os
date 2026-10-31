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


## Release gate: Luganda before a Luganda-language release

Most pending keys above are new surfaces that never had Luganda. The keys in
this section are different: they replaced text that **was** human Luganda on
screen. Before the shared device card footer, the Kiwi and STREGA cards
rendered their whole last-seen line in Luganda (`kiwiSensor.lastSeen`,
`kiwiSensor.neverSeen`, `stregaValve.lastSeen`). The footer keeps that human
text for the minutes age and "never seen", but the tiers below are English in
`lg`, and a quiet device spends most of its time in them (every age of six
hours or more is the date line). Shipping them to a gateway whose interface
runs in Luganda is a visible regression.

**Gate:** an edge release that contains the shared footer is not deployed to
any gateway whose interface runs in Luganda until a human Luganda pass has
supplied these keys, or the owner has accepted the English in writing for
that release. The release checklist (`docs/versioning-workflow.md`,
Pre-flight) points here. Never fill them by machine translation.

| `devices.json` key | English source | Replaces human Luganda for |
|---|---|---|
| `deviceCard.footer.lastSeenJustNow` | "Last seen just now" | an age under one minute |
| `deviceCard.footer.lastSeenHours` | "Last seen {{count}} h ago" | ages from 1 to 6 hours |
| `deviceCard.footer.lastSeenAt` | "Last seen {{date}}" | every age of 6 hours or more |
| `deviceCard.footer.battery` | "Battery" | (spoken label of the battery slot) |
| `deviceCard.footer.batteryLow` | "Battery low" | (spoken label below 20 %) |
| `common.batteryEstimated` | "Estimated from battery voltage" | (now also spoken on an estimated percentage) |

When the pass lands, drop the key from `PENDING_HUMAN_LUGANDA` in
`web/react-gui/tests/soilTensionCardLocales.test.ts` (or `waterCardLocales.test.ts`
for `common.batteryEstimated`), remove its row here, and delete the old
`kiwiSensor.lastSeen`, `kiwiSensor.neverSeen` and `stregaValve.lastSeen` keys
once the reviewer confirms the move.

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
| `environment.noData` (1 key in `devices.json`) | Added by the environment card's data-driven default tab (#310 follow-up): the explicit state shown when no tab has usable content, so the card never opens on a silently blank tab. The five European locales were translated when the key was added; no Luganda has been authored, so `lg` ships the English source text. |
| `zone.water.source.using_last_synced`, `zone.water.source.bundle_unavailable`, `zone.water.source.fallback_generic` (3 keys in `devices.json`) | Added so `IrrigationZoneCard.tsx` and `EnvironmentCard.tsx` could map `display.fallbackReason` (still plain English from the edge's zone-env-fn flow node, and sometimes from a linked gateway's cloud bundle) to a translated key instead of printing the sentence verbatim (F100/X-16, T13m, overnight 2026-09-17). The five European locales were translated when the keys were added; no Luganda has been authored, so `lg` ships the English source text. |
| `environment.water.lastSevenDays`, `tooltipDemand`, `stationCredit`, `today`, `legendDemand`, `legendDemandTodayForecast`, `demandCalculated`, `demandForecast`, `demandNoData`, `demandNoLocation`, `demandPending`, `tooltipTodayNote`, `kcLine`, `et0Tier.station_fao56`, `et0Tier.hargreaves_station`, `et0Tier.provider_open_meteo`, `et0Tier.provider_meteoswiss`, `et0Tier.forecast`, `attribution.open_meteo`, `attributionHelpLabel`, `neededTodayHelpLabel`, `neededTodayHelp`, `lastSevenDaysHelpLabel`, `setupRequiredHelpLabel`, `rainSourceHelpLabel`; `zone.water.rainFromStation`, `rainFromWeather`, `drivenByWaterBalanceFromWeather`, `drivenByWaterBalanceFromStation`, `zone.water.reason.rain_unknown`, `demand_unknown` (31 keys in `devices.json`) | Added by the Water tab's Last 7 days plot with per-day crop demand (2026-09-26); no human Luganda pass yet, so `lg` ships the English source text. |
| `environment.water.demandNoSource`, `demandMixedStation`, `demandUnknownStation`, `demandUnknownToday`, `et0Line`, `kcSourceByCrop` (6 keys in `devices.json`) | Added by the daily agronomy final fix wave (2026-09-26): the reasons a day has no crop demand, the day's ET0 and the crop beside a demand computed by the cloud or by this gateway. No human Luganda pass yet, so `lg` ships the English source text. The same wave rewrote the English `zoneConfig.stageHelp` (dormancy is for deciduous crops and annual rest periods), and `lg` carries the new English text. |
| `environment.water.kcSource.fao56_curve`, `stageOverrun`, `et0Tier.open_meteo_daily`, `computedBy.edge`, `computedBy.cloud`, `modelAccuracyNote`, `meteoswissCloudNote` (7 keys in `devices.json`) | Added by daily agronomy parity (the FAO-56 Kc curve, the stage-overrun flag and the days OSI Cloud computes in shared mode, 2026-09-27). The values are the cloud's translations, embedded from the cloud plans, so the two GUIs carry one translation of each key; `test-shared-agronomy-locales.js` keeps them equal. No human Luganda pass yet, so `lg` ships the English source text. |
| `zone.water.soil.depthSuffix`, `zone.water.soil.lastReading`, `zone.water.soil.triggerProbeLastReading`, `zone.water.soil.triggerProbeInvalid` (4 keys in `devices.json`) | Added by the Water card's "Soil now" rework (owner decision 2026-10-21): the depth after the value and its pill, "({{depth}} cm)"; the age line "Last reading {{since}}", which replaces the card's use of `zone.water.soil.noReadingSince` ("No reading since 5 days ago" was ungrammatical; that key is now unused and its `lg` value was not touched); and the line "Trigger probe: last reading …" when current probes supply the figure while the probe on the irrigation-trigger channel has gone quiet. `triggerProbeInvalid` ("Trigger probe: invalid reading") replaces that line when a current probe reports the trigger channel faulted or out of range. No human Luganda pass yet, so `lg` ships the English source text. |

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

## `devices.json` — Advanced Schedule drawer copy

| Keys | Reason |
|---|---|
| `advancedSchedule.aggregationDescription`, `advancedSchedule.baseDuration`, `advancedSchedule.baselineR2`, `advancedSchedule.computedAt`, `advancedSchedule.diagnosticsUnavailable`, `advancedSchedule.dmaxWindow`, `advancedSchedule.dminWindow`, `advancedSchedule.insufficientData`, `advancedSchedule.lastTriggered`, `advancedSchedule.loadingRecommendations`, `advancedSchedule.localWindow`, `advancedSchedule.lowConfidenceTrees`, `advancedSchedule.method`, `advancedSchedule.never`, `advancedSchedule.noRecommendations`, `advancedSchedule.noSchedule`, `advancedSchedule.outlierFiltered`, `advancedSchedule.phenologyDescription`, `advancedSchedule.rainSuppressionDescription`, `advancedSchedule.recoveryDescription`, `advancedSchedule.responseModeOption.aggressive`, `advancedSchedule.responseModeOption.fixed`, `advancedSchedule.responseModeOption.proportional`, `advancedSchedule.rolling14DayR2`, `advancedSchedule.sdVpdDescription`, `advancedSchedule.sdVpdStatus.coupled`, `advancedSchedule.sdVpdStatus.decoupled`, `advancedSchedule.sdVpdStatus.insufficient_data`, `advancedSchedule.sdVpdStatusLabel`, `advancedSchedule.status`, `advancedSchedule.stepwiseEnvelope`, `advancedSchedule.stressLevel.conservative`, `advancedSchedule.stressLevel.high`, `advancedSchedule.stressLevel.low`, `advancedSchedule.stressLevel.medium`, `advancedSchedule.stressLevelOther`, `advancedSchedule.stressTriggerLevel`, `advancedSchedule.tabAnalysis`, `advancedSchedule.tabScheduling`, `advancedSchedule.timezoneExample`, `advancedSchedule.timezoneSaveFailed`, `advancedSchedule.twdDescription`, `advancedSchedule.usableTrees`, `advancedSchedule.vpdOverrideCounts`, `advancedSchedule.vpdOverrides`, `advancedSchedule.weatherControlled`, `advancedSchedule.zoneConfidence` (47 keys in `devices.json`) | The Advanced Schedule drawer previously hardcoded this scheduling and analysis copy in English. `lg` ships the English source text until a native Luganda speaker reviews and translates these keys. The de-CH, es, fr, it and pt values are localized, but still await human review. |

Tracked in code at `web/react-gui/tests/f37Locales.test.ts`
(`ADVANCED_SCHEDULE_PENDING_KEYS` within `PENDING_HUMAN_LUGANDA`), which
asserts each `lg` value is byte-identical to `en`. A native-speaker pass must
remove each key from the test set and this section in the same change.

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
| `watermark.*` (44 keys in `devices.json`: resistance/offset/temperature/supply readouts, the thirteen status codes, the probe-depth editor and the calibration form) | New keys added for the IRROMETER WATERMARK 200SS soil-tension probes on the LSN50 card — the probe status lines, the depth editor and the calibration form (`WatermarkProbeSection.tsx`, `WatermarkDepthSection.tsx`, `WatermarkCalibrationSection.tsx`, `DraginoTempCard.tsx`, `DraginoSettingsModal.tsx`). No native Luganda speaker has translated them yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received human-quality translations in the same change; "WATERMARK" stays untranslated as the product name, and `status.ok`, `wetUpTo`, and the two Ω-suffixed calibration field labels that are established electronics loanwords (`pullup`, `pulldown`) may legitimately match English since they are units, symbols, or "OK". `seriesFwd`/`seriesRev` ("Series, forward"/"Series, reverse") are plain English prose rather than loanwords and are translated in all five European locales, not exempted. |

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
| `coverage.title`, `coverage.window`, `coverage.windowLastHour`, `coverage.windowHours`, `coverage.windowDays`, `coverage.export`, `coverage.points_one`, `coverage.points_other`, `coverage.gateway`, `coverage.legendStrong`, `coverage.legendWeak`, `coverage.noPosition`, `coverage.noPoints`, `coverage.captureOff`, `coverage.noGpsFix`, `coverage.noGpsFixHint` (16 keys in `network.json`) | New keys for the coverage view NetworkPage gained for the RAK10701 field-test walk: the RSSI legend, the time-window picker, the GeoJSON/CSV export, and the three honest empty states (capture switched off, no gateway position, no positioned observation). No native Luganda speaker has translated them yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received human-quality translations in the same change; `coverage.gateway` deliberately stays "Gateway" in de-CH/it/pt, matching the loanword those bundles already use, and is "Passerelle" in fr and "Pasarela" in es, matching `network.noDevices` in that bundle. `coverage.points` carries plural forms, so Luganda holds English's two categories (`_one`, `_other`); fr/es/it/pt additionally carry `_many`, which their CLDR rules have and English does not, and which is therefore outside this list. |

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


## `valves.json` — valve panel schedule help

| Keys | Reason |
|---|---|
| `scheduleHelp`, `scheduleHelpLabel` (2 keys in `valves.json`) | The information button beside the valve panel heading and its tooltip ("Weekly schedules run on each valve."). They replace the retired `help` and `helpLabel`, whose English said "All zones." in front of the same sentence and named the button "About valve control". No human Luganda pass has seen the new wording, so `lg` ships the English source text. de-CH/es/fr/it/pt received human-quality translations in the same change. |
| `planLost`, `scheduleDialog.push.LOST` (2 keys in `valves.json`) | Added by the CMD-04 PR0 containment (owner decision Q02 c): a plan push the valve has not confirmed within 24 hours is no longer re-sent automatically, and the valve tile and the schedule badge say "Device may not hold this plan". The wording is shared with the conditional-scheduling branch and is not yet reviewed in any language, so every edge locale, `lg` included, ships the English source text (`PENDING_TRANSLATION` in the same test file). |
| `schedulerStatusLost` (1 key in `valves.json`) | Added after the CMD-04 PR0 review: a LOST scheduler-status push (pause, skip today, resume) gets its own tile line, "Device may not hold the latest pause, skip or resume", instead of the plan line. Same status as `planLost`: not yet reviewed in any language, so every edge locale, `lg` included, ships the English source text (`PENDING_TRANSLATION` in the same test file). |
| `cancelHelp`, `cancelHelpLabel`, `cancelOutcome.*` (4), `cancelCollateral.*` (8) (14 keys in `valves.json`) | The cancel control's help text (owner decision D04, verbatim: "Cancel deletes the pending command. It does not close a valve that is already open."), its help-button label, and the panel lines that report a cancel's outcome and the other queued items its queue flush removed (D19/Q01 = (a)), added in the night run 2026-10-19. Every locale ships the English source text until a translation pass; `lg` waits for a human Luganda pass. |
| `cancelCollateral.planStillRunning` (1 key in `valves.json`) | Owner ruling 2026-10-24 (conditional irrigation release review, R19 residual 1): when a cancel's whole-queue flush removed a pending plan change (a clear or a reduction), the cancel outcome says the valve still runs its previous program and that the schedule must be deleted or disabled again; nothing is replayed. de-CH, fr, it, es and pt are translated (native review pending); `lg` ships the English source text until a human Luganda pass. |
| `resumeRefusedClearPending` (1 key in `valves.json`) | The valve panel's explanation when Resume is refused on a conditional valve whose conditional clear is not confirmed yet (scheduling integration W29, 2026-10-21). de-CH, fr, it, es and pt are translated; `lg` ships the English source text until a human Luganda pass. |
| `irrigationPolicy.vwcDisabled` (1 key in `valves.json`) | The policy editor's notice that VWC conditions are turned off on this gateway (edge gate `conditional_irrigation_vwc_enabled`, default off; plan decision D18, R17 M1), so a VWC policy does not irrigate. Added by the scheduling integration W29, 2026-10-21. de-CH, fr, it, es and pt are translated; `lg` ships the English source text until a human Luganda pass. |
| `irrigationPolicy.*` (the other 83 keys) and `irrigationPreference.*` (16 keys) in `valves.json` | The conditional irrigation policy editor, its runtime status and conversion preview, and the wet/moist/dry irrigation preference picker, added by the conditional irrigation branch. de-CH, fr, it, es and pt carry translations. The texts decide when a valve opens, so no machine translation is shipped: `lg` ships the English source text until a human Luganda pass. |

Tracked in code at `web/react-gui/tests/valveControlLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`. A human Luganda pass must drop the key from that set
and from the table above in the same change.

## `common.json` — all-zones export messages and saved-view delete

| Keys | Reason |
|---|---|
| `analysis.export.allZonesCsvBusy`, `analysis.export.errors.tooLarge`, `busy`, `invalidRange`, `failed`; `analysis.views.confirmDelete` (6 keys in `common.json`) | Added with the analysis page's all-zones CSV export (its busy label and the messages for a refused or failed export) and the confirmation before a saved view is deleted. No human Luganda pass yet, so `lg` ships the English source text. de-CH/es/fr/it/pt were translated in the same change. |
| `analysis.export.allZonesCsv` | Restored in PR #422; available history does not establish a human Luganda author or speaker confirmation (#440). Ships the English source "Export all zones CSV" pending a human Luganda pass. Remove this row and its entry in the all-zones export test's `PENDING_HUMAN_LUGANDA` set together when a human supplies or confirms the translation. |

Tracked in code at `web/react-gui/tests/analysis-locales.test.ts`
(`PENDING_HUMAN_LUGANDA` in the all-zones export test), which asserts each
key's `lg` value is still byte-identical to `en`. A human Luganda pass must
drop the key from that set and from the table above in the same change.

## `common.json` — data source tray messages

| Keys | Reason |
|---|---|
| `analysis.tray.unassigned`, `emptySource`, `otherSupported`, `otherSupportedHelp`, `valveEvents`, `unsupportedType`, `openNetwork`, `networkDisabled`, `networkLoading` (9 keys in `common.json`) | Added by the data-device discovery view (Task 4, 2026-10-07). de-CH/es/fr/it/pt carry translations. No human Luganda pass has reviewed these source messages, so `lg` keeps the English source text. |

Tracked in code at `web/react-gui/tests/analysis-locales.test.ts` in the data
source test's `PENDING_HUMAN_LUGANDA` set. A human Luganda pass
must drop each key from that set and from this table in the same change.

## `common.json` — correlation suppression reasons for device sources

| Keys | Reason |
|---|---|
| `analysis.correlation.ambiguous`, `analysis.correlation.missingSource` (2 keys in `common.json`) | Added by the data-device discovery view (2026-10-07). de-CH/es/fr/it/pt carry translations. No human Luganda pass has reviewed them, so `lg` keeps the English source text. |

Tracked in code at `web/react-gui/tests/analysis-locales.test.ts` in the
correlation test's `PENDING_HUMAN_LUGANDA` set. A human Luganda pass must drop
each key from that set and from this table in the same change.

## `devices.json` and `common.json` — rain amounts on the LoRain card and in Data view

| Keys | Reason |
|---|---|
| `loRain.intervalRainfall`, `loRain.lastReport`, `loRain.tips_one`, `loRain.tips_other`, `loRain.tipsUnavailable` (5 keys in `devices.json`); `analysis.tray.showLegacy`, `analysis.legacyEstimate`, `analysis.tooltip.reportsReceived_one`, `analysis.tooltip.reportsReceived_other`, `analysis.export.qualityColumns` (5 keys in `common.json`) | Added when the LoRain card and the Data view started to present rain as amounts (the elapsed-time rate became a legacy estimate, offered on request) and the Data view CSV gained an opt-in version 2 with quality columns. de-CH/es/fr/it/pt carry translations. No human Luganda pass yet, so `lg` ships the English source text. |

Tracked in code at `web/react-gui/tests/lorainViewLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`. A human Luganda pass must drop the key from that set
and from the table above in the same change.

## `history.json` — mobile uPlot history

| Keys | Reason |
|---|---|
| `mobileUplot.ranges.*` (4), `mobileUplot.back`, `forward`, `latest`, `sensors`, `unitNotReported`, `loading`, `updating`, `noData`, `allHidden`, `unavailable`, `pinnedReading`, `close`, `aggregation`, `points`, `loadedRange`, `truncated`, `showDay`, `retry`, `failure`, `coverage`, `freshness`, `notLoaded`, `rangesGroup`, `visibleWindow`, `mobileUplot.seriesLegend.*` (6) (34 keys in `history.json`) | Added with the default-off mobile soil history preview and its compact series legend; `rangesGroup` and `visibleWindow` (the accessible names of the range buttons and the visible-window readout, formerly English literals in the package) after the #512 review. The `lg` values first shipped on the preview branch were written by implementation agents, not by a human translator, so they were replaced with the English source text. de-CH/es/fr/it/pt carry translations. |

Tracked in code at
`web/react-gui/src/history/__tests__/historyLocaleValues.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en` and that every `mobileUplot.*` key is listed. A human
Luganda pass must drop the key from that set and from the table above in the
same change.

## `history.json` — mobile water-tension history

| Keys | Reason |
|---|---|
| `history.mobileTension.*` (52 labels, including the `route.*` states and `seriesLegend.*`) | Added for the internal mobile water-tension history shell. The five European locales carry reviewed translations, while `lg` keeps the English source text until a human Luganda pass. |

Tracked in `web/react-gui/src/history/__tests__/historyLocaleValues.test.ts` (`PENDING_HUMAN_LUGANDA`), which asserts that every `history.mobileTension.*` leaf remains byte-identical to English. A human Luganda pass must remove each leaf from that set and this row together.

The presenter authorized machine-translated Luganda for the isolated
presentation simulator only; its overrides are under
`web/react-gui/demo/locales/lg-valves.json` and are excluded from production builds.
The conditional irrigation and CMD-04 valve keys listed under `valves.json`
above (`irrigationPolicy.*`, `irrigationPreference.*`, `planLost`,
`schedulerStatusLost`, `scheduleDialog.push.LOST`, `resumeRefusedClearPending`, `cancelHelp`,
`cancelHelpLabel`, `cancelOutcome.*`, `cancelCollateral.*`) get no demo
override: the simulator shows their English source text too.
`web/react-gui/demo/tests/valve-locale.test.ts` enforces this, and a human
Luganda pass removes the key from its pending list in the same change.

## `history.json` — source choice and recovery

| Keys | Reason |
|---|---|
| `history.sourceFilter.chooseOne`, `limitsTitle`, `recoveryRaw`, `recoveryPoint`, `shorterRange`, `coarserAggregation`, `availableSources` (7 keys) | Added with source-preserving history (#502): the prompt to choose one source on a multi-source calendar or soil-profile view, and the recovery panel shown when a request exceeds the point or raw-row budget. No human Luganda pass is on record for the `lg` values first written on the branch, so `lg` ships the English source text. de-CH/es/fr/it/pt carry translations. |

Tracked in `web/react-gui/src/history/__tests__/historyLocaleValues.test.ts` (`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still byte-identical to `en`. A human Luganda pass removes each key from that set and from this row together.

## `devices.json` — Tensiomark settings and SDI-12 card

| Keys | Reason |
|---|---|
| `sdi12.tensiomark.*` (all 27 keys in `devices.json`: `title`, `qualification`, `calibrationRange`, `addSensor`, `confirmation`, `confirmRequired`, `saved`, `address`, `channel`, `identity`, `depthCmLabel`, `addressAria`, `channelAria`, `identityAria`, `depthAria`, `identityExample`, `removeSensor`, `removeSensorAria`, and `errors.sensorCount`, `errors.addressInvalid`, `errors.channelInvalid`, `errors.identityInvalid`, `errors.depthInvalid`, `errors.calibrationInvalid`, `errors.duplicateAddress`, `errors.duplicateIdentity`, `errors.duplicateChannel`) | Added for the Tensiomark layout editor in the SDI-12 settings modal (labels, screen-reader labels, row removal, per-field validation errors and the pF/temperature-order confirmation). The card's address, depth and value labels moved to the shared soil tension keys below. de-CH/es/fr/it/pt carry translations. The confirmation sentence and the error texts carry operational meaning, so no machine translation is shipped: `lg` ships the English source text until a human Luganda pass. |

Tracked in code at `web/react-gui/tests/tensiomarkLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`. A human Luganda pass must drop the key from that set
and from the table above in the same change.

## `devices.json` — shared soil tension card, device card footer, SDI-12 card header

| Keys | Reason |
|---|---|
| `soilTension.*` (9 keys: `sectionTitle`, `channel`, `depthCm`, `soilTemp`, `soilTempSeries`, `invalidReading`, `noReadings`, `family.watermark`, `family.tensiomark`), `deviceCard.*` (9 keys pending: `footer.lastSeenJustNow`, `footer.lastSeenHours`, `footer.lastSeenAt`, `footer.battery`, `footer.batteryLow`, `settings`, `closeSettings`, `zones`, `noZones`), `sdi12Soil.badge`, `sdi12Soil.noProfile`, `sdi12Soil.detecting`, `sdi12Soil.invalidLayout`, `sdi12Soil.status.*` (5 keys) | Added when the WATERMARK card (`DraginoTempCard.tsx`, `WatermarkProbeSection.tsx`) and the Tensiomark card (`Sdi12SoilCard.tsx`) moved onto one shared soil tension layout (`SoilTensionReadings.tsx`), the same layout and text as the OSI Cloud cards, and their footers and headers lost their English literals. They replace `watermark.sectionTitle`, `watermark.probe`, `watermark.soilTemp`, `watermark.depthUnset` and `sdi12.tensiomark.addressDepth`/`depthUnknown`/`depthCm`/`swt`/`soilTemperature`, whose `lg` values were English too, so no human Luganda was dropped. de-CH/es/fr/it/pt carry the cloud's translations for the shared keys; the new strings (`soilTempSeries`, `invalidReading`, `deviceCard.settings`/`closeSettings`, the `sdi12Soil` header, notice and status texts) were drafted without a native speaker and need a review. `deviceCard.zones`/`noZones` ("Zones:", "No zones assigned") replaced the weather station card's English literals later, translated the same way. `lg` ships the English source text until a human Luganda pass. |

Tracked in code at `web/react-gui/tests/soilTensionCardLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`. A human Luganda pass must drop the key from that set
and from the table above in the same change.

The shared device card footer (owner decision 2026-10-21: battery and last
seen on every card) kept the human Luganda that already existed for the same
English meaning instead of adding English:

| `lg` key | State |
|---|---|
| `deviceCard.footer.lastSeenMinutes` | Human text kept: the Kiwi card's `kiwiSensor.lastSeen` ("Bwagulibwa omulundi gw'omuliko: {{minutes}} edakiika ewedde"; English "Last seen: N minutes ago", now "Last seen N min ago", the same meaning), with `{{minutes}}` renamed to `{{count}}`. |
| `deviceCard.footer.neverSeen` | Human text kept: `kiwiSensor.neverSeen` ("Tekalabikangako"). |
| `deviceCard.footer.lastSeenJustNow`, `lastSeenHours`, `lastSeenAt` ("Last seen {{date}}", from six hours on), `battery`, `batteryLow` | English placeholders, pending (rows above). Key names and the other locales' text are the cloud's (osi-server `6296119e5`). |
| `kiwiSensor.lastSeen`, `kiwiSensor.neverSeen`, `stregaValve.lastSeen` | Human text left in place, untouched. No card reads them any more; delete them only after the Luganda reviewer confirms the move. |
| `valves.lastSeen.*`, `valves.battery`, `loRain.lastReport` | English in `lg`; no card reads them any more (the valve tile and the LoRain card use the shared footer). |

`soilTensionCardLocales.test.ts` (`HUMAN_LUGANDA_REUSED`) asserts the two
kept keys still equal their human source strings.

## `common.json` — auto-stacked Data view chart

| Keys | Reason |
|---|---|
| `analysis.autoStack.note`, `analysis.autoStack.showOverlaid` (2 keys in `common.json`) | Added when an overlaid Data view chart whose unit axes leave too little room for the plot started to render stacked, with a short note and a session-only "Show overlaid anyway" toggle (ported from the cloud Analysis page, 2026-10-21). de-CH/es/fr/it/pt carry the cloud's translations, which still need a native-speaker review. No human Luganda pass yet, so `lg` ships the English source text. |

Tracked in code at `web/react-gui/tests/analysis-locales.test.ts` in the
auto-stack test's `PENDING_HUMAN_LUGANDA` set, which asserts each key's `lg`
value is still byte-identical to `en`. A human Luganda pass must drop each key
from that set and from this table in the same change.

## `devices.json` — valve removal notice

| Keys | Reason |
|---|---|
| `stregaValve.removedClearingScheduled`, `stregaValve.removedClearingFailed`, `stregaValve.removedNoticeOk` (3 keys in `devices.json`) | Added with the conditional irrigation release review (R19 finding 1): after a valve is removed, the card says whether its weekly plan is still being cleared or the clear failed, and waits for an OK. de-CH/es/fr/it/pt carry translations that still need a native-speaker review. The texts say whether a valve may keep watering, so no machine translation is shipped: `lg` ships the English source text until a human Luganda pass. |

Tracked in code at `web/react-gui/tests/devicesI18n.test.ts`
(`PENDING_HUMAN_LUGANDA` in the removal-notice test), which asserts each key's
`lg` value is still byte-identical to `en`. A human Luganda pass must drop the
key from that set and from this table in the same change.

## `devices.json` — LoRain housing temperature

| Keys | Reason |
|---|---|
| `loRain.temperature`, `loRain.temperatureHint` (2 keys in `devices.json`) | Added when the LoRain card started to name its temperature as the gauge housing temperature and to date it with the last report: the thermistor sits on the gauge's circuit board, and a dry gauge can show a value hours old. de-CH/es/fr/it/pt carry translations; `lg` ships the English source text until a human Luganda pass. |

Tracked in code at `web/react-gui/tests/lorainViewLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`, derived from its `KEYS`), which asserts each key's
`lg` value is still byte-identical to `en`. A human Luganda pass must drop the
key from that set and from this table in the same change.
