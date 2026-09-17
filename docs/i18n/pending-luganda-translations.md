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

Tracked in code at
`web/react-gui/src/pages/__tests__/accountLinkLocaleValues.test.ts`
(`PENDING_HUMAN_TRANSLATION.lg`), which allows this key to be identical to
`en` without failing the locale-parity guard, and requires it to be removed
from that set once corrected.

## `devices.json` and `network.json` — water card, sensor gating, dates

| Keys | Reason |
|---|---|
| `zone.configure`, `zone.chips.*`, `zone.groups.*`, `zone.water.*` (title, tiles, action codes, insufficient-data and water-balance reasons, source modes, soil status with its channel and depth), `common.viewHistory`, `common.batteryEstimated`, `environment.soil.moisture*`, `environment.soil.temperature`, `environment.forecast.dayToday`/`dayTomorrow`/`etaToday`/`etaTomorrow`, `environment.generatedAt`, `environment.loading`/`loadFailed`, `environment.tabs.*`, the `kiwiSensor` depth editor (98 keys in `devices.json`); `network.loadingDevices`, `network.noDevices`, `network.loadingObservations` (3 keys in `network.json`) | New keys added when the irrigation zone card's water card, the zone chips and the date/time helpers were routed through `t()`. The English text is the source text; no Luganda has been authored for any of them yet, and the shipped `lg` value is the English fallback rather than a machine translation. |
| `environment.water.*` (10 keys in `devices.json`: `noData`, `rainToday`, `measuredIrrigationToday`, `estimatedIrrigationToday`, `waterNeededToday`, `balance`, `setupRequired`, `weeklyTrend`, `trendNote`, `nextRain`) | The zone environment card's Water tab called `t()` for these ten keys with a `defaultValue` but they existed in no locale file, so the tab shipped English in all seven languages (F59 sibling finding F35, overnight 2026-09-17). The five European locales were translated when the keys were added; no Luganda has been authored, so `lg` ships the English source text. |
| `zone.water.source.using_last_synced`, `zone.water.source.bundle_unavailable`, `zone.water.source.fallback_generic` (3 keys in `devices.json`) | Added so `IrrigationZoneCard.tsx` and `EnvironmentCard.tsx` could map `display.fallbackReason` (still plain English from the edge's zone-env-fn flow node, and sometimes from a linked gateway's cloud bundle) to a translated key instead of printing the sentence verbatim (F100/X-16, T13m, overnight 2026-09-17). The five European locales were translated when the keys were added; no Luganda has been authored, so `lg` ships the English source text. |

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
| `schedule.*` (trigger method, sensor, threshold helper, sensitivity, response mode, advanced settings — 21 keys); `zoneConfig.*` (title, crop, soil, irrigation method, area, efficiency, calibration, phenological stage, timezone, location, device GPS, notes, validation messages — 70 keys); `environment.water.effective`, `rainGaugeReporting`, `flowMeterReporting`, `tooltipRain`, `tooltipMeasuredEffective`, `tooltipEstimatedEffective` (6 keys) | New keys added when `ScheduleSection`'s two sub-forms and `ZoneConfigModal` were routed through `t()` — until then the only screen where a farmer sets the number that opens a valve, and the screen that sets every input to the water balance, rendered wholly in English inside every non-English screen — and when the Water tab's remaining hardcoded strings were keyed (E-21, E-22, F69, T13h, 2026-09-17). No native Luganda speaker has translated these yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received natural human-quality translations in the same change. |

Tracked in code at `web/react-gui/tests/zoneFormLocales.test.ts`, which asserts
each key's `lg` value is still byte-identical to `en`, the same mechanism
`waterCardLocales.test.ts` uses above. A human Luganda pass must drop the key
from that list and from the table above in the same change; the test fails
otherwise, so the two cannot drift apart.

## Related keys not listed here

Two other `accountLink.json` keys recovered from PR #150 in the same
PR #248 pass (`sync.running`, `reauth.running`: ellipsis glyph `…` vs `...`;
`reauth.description`: "issue a new" vs "mint a fresh" sync token) also show
English wording drift since the Luganda was authored, but the drift does not
change meaning — both are paraphrases of the same fact. They are not tracked
here.

## `settings.json` — module visibility switches

| Keys | Reason |
|---|---|
| `dataModule`, `networkModule`, `gatewayHub`, `journalModule`, `journalModuleSaveError` (5 keys in `settings.json`) | New Settings rows for the Data view, Network, Gateway and Field Journal modules, added when those four became switchable (owner decision, 2026-09-17). No native Luganda speaker has translated them yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received human-quality translations in the same change; `gatewayHub` deliberately stays "Gateway" in de-CH/it/es/pt, matching the loanword `devices.json` `systemPanel.title` already ships for those locales, and is "Passerelle" in fr. |

Tracked in code at `web/react-gui/tests/moduleVisibilityLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`, the same mechanism the sections above use. A human
Luganda pass must drop the key from that set and from the table above in the
same change; the test fails otherwise, so the two cannot drift apart.
