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

Tracked in code at
`web/react-gui/src/pages/__tests__/accountLinkLocaleValues.test.ts`
(`PENDING_HUMAN_TRANSLATION.lg`), which allows this key to be identical to
`en` without failing the locale-parity guard, and requires it to be removed
from that set once corrected.

## `devices.json` and `network.json` — water card, sensor gating, dates

| Keys | Reason |
|---|---|
| `zone.configure`, `zone.chips.*`, `zone.groups.*`, `zone.water.*` (title, tiles, action codes, source modes, soil status), `common.viewHistory`, `environment.soil.moisture*`, `environment.forecast.dayToday`/`dayTomorrow`/`etaToday`/`etaTomorrow`, `environment.generatedAt` (67 keys in `devices.json`); `network.loadingDevices`, `network.noDevices`, `network.loadingObservations` (3 keys in `network.json`) | New keys added when the irrigation zone card's water card, the zone chips and the date/time helpers were routed through `t()`. The English text is the source text; no Luganda has been authored for any of them yet, and the shipped `lg` value is the English fallback rather than a machine translation. |
| `environment.water.*` (10 keys in `devices.json`: `noData`, `rainToday`, `measuredIrrigationToday`, `estimatedIrrigationToday`, `waterNeededToday`, `balance`, `setupRequired`, `weeklyTrend`, `trendNote`, `nextRain`) | The zone environment card's Water tab called `t()` for these ten keys with a `defaultValue` but they existed in no locale file, so the tab shipped English in all seven languages (F59 sibling finding F35, overnight 2026-09-17). The five European locales were translated when the keys were added; no Luganda has been authored, so `lg` ships the English source text. |

Tracked in code at `web/react-gui/tests/waterCardLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`. A human Luganda pass must drop the key from that set
and from the table above in the same change; the test fails otherwise, so the
two cannot drift apart.

## Related keys not listed here

Two other `accountLink.json` keys recovered from PR #150 in the same
PR #248 pass (`sync.running`, `reauth.running`: ellipsis glyph `…` vs `...`;
`reauth.description`: "issue a new" vs "mint a fresh" sync token) also show
English wording drift since the Luganda was authored, but the drift does not
change meaning — both are paraphrases of the same fact. They are not tracked
here.
