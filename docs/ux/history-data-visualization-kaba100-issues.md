# History Data Visualization Issues From Kaba100 Test

Date: 2026-06-01
Branch: `feat/history-data-visualization`
Deployed edge commit on kaba100: `840088f6`
Target: kaba100 Pi, `100.93.68.86`

This document records the first live-test issue cluster for the new OSI OS History UI. It focuses on the reported symptoms:

- Device names are gone from cards, so farmers cannot differentiate sensors.
- Zone B shows one card even though two sensors are assigned to the zone.
- Zone B appears to show no data.

## Resolution status

Status as of 2026-06-07 on local branch `feat/history-data-visualization`:

- Deployed kaba100 commit: `ebe565b2`.
- Served GUI assets after deploy: `assets/index-COEn1bSV.js`, `assets/index-DOU047vb.css`.
- Runtime deploy backup: `/data/db/backups/osi-os-20260607-001136/runtime-backup.tar.gz`.
- Node-RED status after deploy: `running`; MQTT uplink subscription restored on `application/+/device/+/event/up`.
- Zone B History API now returns one merged `Soil Moisture` card with `sourceDeviceCount: 2` and display-safe source names `Chameleon 1`, `Chameleon 2`.
- Fullscreen detail header now shows `Soil Moisture Zone B` and `2 sources: Chameleon 1, Chameleon 2`.
- Source menu exposes both `Chameleon 1` and `Chameleon 2`; raw `swt_*` and DevEUI labels were not visible in the Playwright smoke check.
- Soil line/profile API returns depth metadata for Zone B: `5 cm`, `10 cm`, `40 cm`.
- Post-deploy timing, Zone B, 7 measured runs after 2 warmups:
  - `zone-cards`: p50 14 ms, p95 19 ms.
  - `card-data-24h`: p50 26 ms, p95 29 ms.
  - `card-data-7d`: p50 110 ms, p95 153 ms.
  - `card-data-30d`: p50 41 ms, p95 44 ms.
- Remaining observability note: `[history-api] phaseMs` lines did not appear in `logread` on kaba100, even though endpoint timings are healthy. Follow up by confirming where Node-RED `node.log` output is routed on the OpenWrt image.

Status as of 2026-06-02 on local branch `feat/history-data-visualization`:

- Issue 1 is addressed for the merged-card UI: card summaries now carry display-safe source names/counts, and the carousel/card header render those names without showing DevEUI.
- Issue 2 is partially addressed: Zone B remains one merged Soil card, aligned with the thematic-card model, but the card now exposes `Chameleon 1` and `Chameleon 2` as visible sources. Splitting into two Soil cards remains a product decision because it changes card identity and workspace behavior.
- Issue 3 is addressed: the History API latest-row lookup now accepts normalized DevEUI strings, so Soil Profile can build profiles from latest valid data.
- Issue 4 is addressed for empty rollup tables: 30D/Season rollup reads now fall back to live `device_data` when rollups return no rows and source DevEUIs are available.
- Mobile fullscreen History verification passed on kaba100 after default active seasons were backfilled for existing zones.

## Mobile fullscreen redesign decisions

Decision: mobile overview layout = vertical card list
Decision: mobile detail route = HashRouter route-backed full screen
Decision: mobile live URL format = #/history/zones/:zoneId/cards/:encodedCardId
Decision: mobile comparison/workspaces = desktop-only in this redesign round
Decision: mobile header = compact title row plus overflow actions
Decision: mobile source filters = Soil and Environment merged cards only
Decision: gateway card mobile route = #/history/gateways/:gatewayEui/cards/:encodedCardId
Decision: pinch direction = pinch open narrows range; pinch close widens range
Decision: pull-to-refresh = overview refreshes zone/card lists; detail refreshes selected card data

## Findings

### Issue 1 - Card summaries hide all farmer-facing source labels

Severity: S1

The History card API returns static thematic titles and subtitles only. It does not expose a farmer-facing source name, source group label, or device count in the normal card summary payload.

Live evidence from Zone 3:

- Five dendro cards are returned.
- All five have title `Dendro - Growth Timeline`.
- All five have subtitle `Stem movement and recovery`.
- The card IDs differ internally, but the UI correctly does not show those raw IDs.
- The summary metadata has no display-safe sensor label.

Code evidence:

- `buildCardSummaries` in `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` builds `title: config.title` and `subtitle: config.subtitle` only.
- `HistoryCardSummary` in `web/react-gui/src/history/types.ts` has no typed field for a display-safe source label.
- `ThematicCardCarousel` renders only card type, `card.title`, `card.subtitle`, and coverage.

Root cause:

The redesign correctly hides raw physical device identity, but it overcorrects by also hiding farmer-facing names. `devices.name` is not a raw diagnostic identifier; it is the human label needed to distinguish sensors.

Required fix:

- Add a normal-mode, display-safe source identity contract to card summaries.
- Recommended fields:
  - `sourceLabel`: short label for single-source cards, for example `Chameleon 1`.
  - `sourceSummary`: compact label for merged cards, for example `2 sensors`.
  - `sourceDevices`: display-safe array with `name`, `typeId`, `role`, and optional `sourceStatus`; do not include DevEUI unless Advanced View is active.
- Render this label in `ThematicCardCarousel` and `HistoryCardFrame`.
- Keep DevEUI, firmware, raw channel IDs, RSSI/SNR, and payload data in Advanced View only.

Affected files:

- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- `conf/full_raspberrypi_bcm2709/files/usr/share/flows.json`
- `web/react-gui/src/history/types.ts`
- `web/react-gui/src/services/api.ts`
- `web/react-gui/src/components/history/ThematicCardCarousel.tsx`
- `web/react-gui/src/components/history/HistoryCardFrame.tsx`
- `web/react-gui/public/locales/*/history.json`

Acceptance criteria:

- Multiple dendro cards in one zone are distinguishable without exposing DevEUI.
- A merged soil card shows that it contains multiple sensor sources.
- Advanced View still exposes diagnostic identifiers separately.

### Issue 2 - Zone B has two soil-capable sensors but only one merged Soil card

Severity: S1

Zone B has two assigned sensors:

| DevEUI | Name | Type | Zone | Chameleon enabled |
| --- | --- | --- | --- | --- |
| `A84041A75D5E7CFB` | Chameleon 1 | `DRAGINO_LSN50` | Zone B | `1` |
| `A84041CE3F5ECF52` | Chameleon 2 | `DRAGINO_LSN50` | Zone B | `1` |

The History API returns one card:

```json
{
  "cardId": "5bf9d958-f886-4faf-8dcf-e84efe76163a:soil:root-zone",
  "title": "Soil - Root Zone",
  "subtitle": "Root-zone tension",
  "metadata": {
    "lastSeenAt": "2026-06-01T14:20:31.473Z",
    "calibrationStatus": "pending"
  },
  "availability": {
    "available": true,
    "reasons": []
  }
}
```

Code evidence:

- `deriveCardsForZone` in `osi-history-helper/index.js` merges soil sources with `pushMerged('soil', isSoilSource)`.
- The same helper creates per-device dendro cards, but not per-device soil cards.
- `sourceDeviceCount` exists internally on derived cards but is not propagated into the summary response.

Root cause:

This is current implementation behavior, not a missing device assignment. The design decision says soil is a thematic card, but the implementation does not provide a way to distinguish or inspect multiple soil sources inside that merged card.

Required product/UX decision:

Choose one of these before implementation:

1. Keep one merged Soil card per zone and expose a source selector/filter inside the card.
2. Keep one merged Soil card plus visible source chips for each sensor and source-labelled series.
3. Create one Soil card per logical soil source when a zone has multiple Chameleon arrays.

Recommended fix for MVP:

- Keep the merged Soil card to preserve the thematic-card model.
- Add source chips and source-labelled series/profile rows.
- Add `sourceDeviceCount` and display-safe `sourceDevices` to the card summary.
- Allow the Soil card to filter between `All`, `Chameleon 1`, and `Chameleon 2`.

Acceptance criteria:

- Zone B still has a Soil card, but it visibly indicates that two sensors contribute to it.
- The user can tell which readings come from Chameleon 1 versus Chameleon 2.
- No raw DevEUI is shown in normal mode.

### Issue 3 - Zone B default Soil Profile view appears empty because latest-row lookup is passed the wrong shape

Severity: S0 for the current deployed UI

Zone B has recent calibrated soil values for Chameleon 1:

| DevEUI | recorded_at | swt_1 | swt_2 | swt_3 |
| --- | --- | --- | --- | --- |
| `A84041A75D5E7CFB` | `2026-06-01T14:18:27.990Z` | `6.24` | `6.69` | `6.86` |

The API returns line-chart series for Zone B at `12h`, `24h`, and `7d`, but the default `soil-profile` view receives an empty `profiles` array:

```json
{
  "range": { "label": "24h" },
  "aggregation": {
    "level": "raw",
    "pointCount": 15
  },
  "profiles": [],
  "series": [
    { "id": "swt_1", "points": 5 },
    { "id": "swt_2", "points": 5 },
    { "id": "swt_3", "points": 5 }
  ]
}
```

Code evidence:

- `HistoryCardFrame` defaults selected view to `card.defaultView`.
- The Soil card default view is `soil-profile`.
- `SoilProfileView` shows its empty state when `profiles.length === 0`.
- `buildDeviceCardData` computes `const deveuis = uniqueDeveuis(sourceDevices)`, then incorrectly calls `getLatestDeviceDataRows(q, deveuis)`.
- `getLatestDeviceDataRows` calls `uniqueDeveuis` again and expects device objects, not strings. Passing strings causes it to return an empty latest-row set.
- `buildSoilProfiles` depends on those latest rows, so it returns `[]`.

Root cause:

The data endpoint has a shape mismatch between `buildDeviceCardData` and `getLatestDeviceDataRows` / `getLatestChameleonRows`. Summary cards pass device objects and work. Card data passes normalized DevEUI strings and loses latest rows.

Required fix:

- Make `uniqueDeveuis` accept both device objects and normalized DevEUI strings, or pass `sourceDevices` into `getLatestDeviceDataRows` and `getLatestChameleonRows`.
- Add tests for both call shapes.
- Add a live-style regression case where a Soil card has series points and must also produce profile rows.

Acceptance criteria:

- Zone B `24h` Soil Profile returns three profile points for Chameleon 1 when it has the latest valid SWT values.
- If the most recent device row has no SWT values, the profile builder falls back to the latest row with non-null SWT values within the selected freshness window instead of showing a false empty state.
- The empty state is reserved for true no-data conditions.

### Issue 4 - Zone B 30D view returns no data because the API forces empty rollups

Severity: S1

Zone B has `device_data` rows within 30 days, including non-null SWT values on several days. However, the 30D card data response returns no series:

```json
{
  "range": { "label": "30d" },
  "aggregation": {
    "level": "daily",
    "pointCount": 0,
    "coveragePct": null,
    "coverageConfidence": "unknown"
  },
  "freshness": {
    "dataAsOf": null
  },
  "series": []
}
```

Live DB evidence:

- `device_data` has Zone B rows in the last 30 days.
- `history_channel_rollups` has zero daily soil rows for Zone B.

Code evidence:

- `shouldUseHistoryRollups` returns `true` for every `30d` and `season` zone query.
- `aggregateDeviceData` reads `history_channel_rollups` when rollups are enabled.
- There is no fallback to live aggregation when rollups are empty.
- The repair script creates the rollup table and indexes, but it does not backfill rollups.

Root cause:

The API treats the rollup table as authoritative for 30D even when the table has not been populated. This creates a false no-data response.

Required fix:

- Either ship and schedule a rollup backfill/population job before enabling 30D/Season from rollups, or add a safe fallback:
  - try rollups;
  - if no buckets are returned and the range has raw rows, compute from `device_data`;
  - return source metadata showing `device_data_fallback`.
- Add observability for empty-rollup fallback events.

Acceptance criteria:

- Zone B 30D line chart shows daily soil values when raw data exists.
- The API never returns empty 30D series solely because rollups have not been populated.
- The response exposes whether it came from `history_channel_rollups` or fallback live aggregation.

### Issue 5 - Mobile History overview is too dense and does not use a true detail surface

Severity: S1

The mobile History page renders the compact carousel card and the full detail card inline. This duplicates title/source/status information, exposes chart controls before the user opens a card, and leaves no dedicated gesture surface for pinch, pan, long press, and pull-to-refresh.

Required direction:

- `/history` becomes a compact mobile overview.
- Tapping a thematic card opens `#/history/zones/:zoneId/cards/:cardId`.
- The full-screen detail route owns range controls, card view modes, source filters, visualization gestures, inspector sheet, and Advanced settings.
- Pinch open/close inside the visualization is core behavior for narrowing/widening the time range.

## Consolidated root causes

1. The card summary contract lacks farmer-facing source labels.
2. Soil card derivation deliberately merges all soil sources but does not expose the source count or labels.
3. Card data latest-row lookup passes DevEUI strings into helper functions that expect device objects.
4. 30D/Season rollup reads are enabled before rollup data is populated or backfilled.

## Recommended fix order

1. Fix latest-row lookup for card data. This restores the default Soil Profile view.
2. Add display-safe source labels and source counts to card summaries.
3. Add source-labelled profile/series handling for merged Soil cards.
4. Fix 30D rollup behavior with a backfill job or raw-data fallback.

## Verification commands

Run against kaba100 after fixes:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:1880/api/history/zones/12/cards"

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:1880/api/history/zones/12/cards/5bf9d958-f886-4faf-8dcf-e84efe76163a:soil:root-zone/data?range=24h&view=soil-profile"

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:1880/api/history/zones/12/cards/5bf9d958-f886-4faf-8dcf-e84efe76163a:soil:root-zone/data?range=30d&view=line-chart"
```

Expected:

- The card summary includes a display-safe indication of `Chameleon 1` and `Chameleon 2`.
- `24h` Soil Profile returns non-empty `profiles` when recent valid SWT values exist.
- `30d` returns non-empty daily series when raw data exists, even if rollups are not populated.

## Fullscreen mobile redesign verification

Date: 2026-06-02
Target: kaba100
Branch commit: `7cb57244`

Passed:

- `/gui/#/history` rendered compact mobile overview cards without inline visualization surfaces or timeline controls.
- Pull down on the mobile overview refreshed the selected zone card list.
- Zone B Soil showed `2 sources: Chameleon 1, Chameleon 2`.
- Zone B Soil opened `#/history/zones/12/cards/5bf9d958-f886-4faf-8dcf-e84efe76163a%3Asoil%3Aroot-zone`.
- `12h`, `24h`, `7D`, `30D`, and `Season` controls were visible and enabled.
- Pinch open narrowed the visible range and requested `range=custom&aggregation=auto`.
- Pinch close widened the visible range and requested `range=custom&aggregation=auto`.
- One-finger drag panned the time window.
- Double tap reset to the Soil card default `24h` range.
- Long press opened the inspector sheet with timestamp and metadata.
- Calendar rendered a monthly grid with weekday headers and colored day states.
- Horizontal swipe on a multi-card detail route switched thematic cards within the selected zone.
- Normal mobile UI did not render raw DevEUI-style identifiers.
- Advanced View requested the advanced endpoint and exposed diagnostic identifiers only there.
- Pull down in Advanced View refreshed the advanced diagnostics endpoint.
- Gateway card overview routes use the display-safe `gateway-hub` slug in unit coverage while keeping backend IDs internal.
- Back navigation returned to `#/history`.
- Desktop History rendered without a framework overlay.
- No relevant console errors or passive touch listener errors were observed.

Failed:

- None in the strict Slice 9 live gate.

Screenshots:

- `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/overview-mobile.png`
- `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/detail-mobile.png`
- `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/detail-after-pinch.png`
- `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/inspector-mobile.png`
- `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/desktop.png`

Live DB note:

- The deployed history API backfilled active `Current season` rows for Zone A and Zone B because the live `zone_seasons` table was empty.

## Fullscreen gesture redesign verification rerun

Date: 2026-06-02
Target: kaba100, `100.93.68.86`
Branch: `feat/history-data-visualization`
Deployed GUI commit: `e1803167`
Deployed History API alignment commit: `760b6118`
Served GUI asset: `assets/index-Db9tKwoc.js`
Live safety backup before flow deploy: `/data/db/backups/osi-os-20260602-092926`

Automated Playwright results at 390 x 844:

- Passed: login page fits without scrolling.
- Passed by screenshot review: language switcher is below the register link. The automated locator emitted a warning because it could not reliably locate both boxes.
- Passed: dashboard has one-row zone actions, exposes zone `Data` links, and no longer exposes a standalone `History` button.
- Passed: Zone B `Data` opens `#/history/zones/12`.
- Passed: fullscreen detail has no range chip row, view-mode chip row, or source-chip row.
- Passed: normal mode hides raw 16-hex DevEUI identifiers.
- Passed: Soil Profile renders `Soil layer 1`, `Soil layer 2`, and `Soil layer 3`.
- Passed: soil layer rows use the required status colours: blue below 22 kPa, green for 22-50 kPa, red above 50 kPa.
- Passed: vertical swipe inside the visualization changes card view mode.
- Passed: horizontal swipe inside the visualization changes thematic card where multiple cards exist.
- Passed: calendar renders a monthly overview with coloured day cells and no `mixed` state wording.
- Passed: Environment `Daily Min/Max` renders a real chart after the UI requests daily aggregation.
- Passed: Environment `Stress Events`, Irrigation `Irrigation Response`, and Gateway `Connectivity Timeline` are not selectable in normal mode.
- Passed: no passive touch event listener console errors were observed.

Screenshots and result artifacts:

- `/home/phil/playwright-osi/screenshots-fullscreen-gesture-2026-06-02/01-login.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-gesture-2026-06-02/02-dashboard.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-gesture-2026-06-02/03-zone-b-fullscreen-soil.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-gesture-2026-06-02/04-zone-b-line-chart.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-gesture-2026-06-02/05-zone-b-calendar.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-gesture-2026-06-02/06-zone-a-after-horizontal-swipe.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-gesture-2026-06-02/07-zone-a-env-daily-min-max.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-gesture-2026-06-02/results.json`
- `/home/phil/playwright-osi/screenshots-fullscreen-gesture-2026-06-02/console.log`

Manual verification still required:

- Playwright verified single-finger taps and swipes only. A real-device check by Phil is still required for pinch open, pinch close, and one-finger drag-pan before Slice 6/7 are considered fully accepted.

## Fullscreen polish verification

Date: 2026-06-02
Target: kaba100, `100.93.68.86`
Branch: `feat/history-data-visualization`
Deployed GUI commit: `b0892337`
Served GUI asset: `assets/index-C4qT_Lxd.js`
Verifier: `/home/phil/playwright-osi/tmp/history-fullscreen-polish-live.js`

Deployment:

- Built `web/react-gui` locally and deployed only the static GUI bundle to `/usr/lib/node-red/gui/` with the tar pipe.
- Confirmed the served `index-*.js` hash matched the local build: `index-C4qT_Lxd.js`.
- Created temporary local user `playwright` for browser verification, assigned Zones 3 and 12 plus their devices, then restored Zones 3 and 12 and all assigned devices to `user_id=2` and deleted the temporary user.
- Did not overwrite `/data/db/farming.db`.

Automated Playwright results:

- Passed: dashboard has no visible `History` button and exposes two zone `Data` links.
- Passed: Zone B `Data` routes to `#/history/zones/12`.
- Passed: detail view has no visible `History` or `Back to history` text.
- Passed: detail header has no inline source subtitle and normal mode hides raw 16-hex DevEUI identifiers.
- Passed: multi-source header shows the compact `⊟` source control and `...` settings control.
- Passed: no range or view-mode button rows were visible.
- Passed: the view-mode label is inside the visualization surface.
- Passed: portrait visualization surface occupied 91.8% of the viewport height.
- Passed: Soil Profile rendered `Soil layer 1`, `Soil layer 2`, and `Soil layer 3` rows with colour tinting.
- Passed: stripped soil line labels were absent (`Soil line chart`, `2 readings`, `Soil 1`, `Soil 2`, `Soil 3`).
- Passed: calendar rendered a monthly coloured day overview with 30 day cells and no `mixed` wording.
- Passed: Environment `Daily Min/Max` rendered a real chart.
- Passed: stripped environment labels were absent (`Environment trend`, `155 readings`, `External temperature`).
- Passed: Environment `Stress Events`, Irrigation `Irrigation Response`, and Gateway `Connectivity Timeline` were not selectable in normal UI.
- Passed: landscape detail had no page scroll, a 41.4 px thin header, and a wide chart surface (`844 x 348.6`).
- Passed: no passive touch event listener console errors were observed.

Screenshots and result artifacts:

- `/home/phil/playwright-osi/screenshots-fullscreen-polish-2026-06-02/01-portrait-dashboard.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-polish-2026-06-02/02-portrait-zone-b-soil-profile.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-polish-2026-06-02/03-portrait-zone-b-line-chart.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-polish-2026-06-02/04-portrait-zone-b-calendar.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-polish-2026-06-02/05-portrait-zone-a-daily-minmax.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-polish-2026-06-02/06-landscape-zone-b-soil-profile.png`
- `/home/phil/playwright-osi/screenshots-fullscreen-polish-2026-06-02/results.json`
- `/home/phil/playwright-osi/screenshots-fullscreen-polish-2026-06-02/console.log`

Manual verification still required:

- Playwright cannot honestly validate two-finger card swipe, live location-aware pinch, one-finger pan when zoomed, calendar inner-swipe month change, or native screen-edge back-swipe feel.
- Phil should verify those gestures on a real phone before the gesture-heavy slices are considered fully accepted.

## Smooth history visualization verification

Date: 2026-06-02
Target: kaba100, `100.93.68.86`
Branch: `feat/history-data-visualization`
Deployed GUI commit: `2b93ab15`
Served GUI asset: `assets/index-BOcN4r38.js`
Verifier: `/home/phil/playwright-osi/tmp/history-smooth-visualization-live.js`

Deployment:

- Built `web/react-gui` locally and deployed only the static GUI bundle to `/usr/lib/node-red/gui/` with the tar pipe.
- Confirmed the served `index-*.js` hash matched the local build: `index-BOcN4r38.js`.
- Created temporary local user `playwright`, assigned Zones 3 and 12 plus their devices for browser verification, then restored Zones 3 and 12 and all assigned devices to `user_id=2` and deleted the temporary user.
- Did not overwrite `/data/db/farming.db`.

Automated Playwright results:

- Passed: portrait visualization surface occupied 91.8% of the viewport height.
- Passed: normal mode hid raw 16-hex DevEUI identifiers.
- Passed: Soil Profile kept `Soil layer 1`, `Soil layer 2`, and `Soil layer 3` rows.
- Passed: Soil Profile colours remained intact; live Zone B rows were blue/wet for values below 22 kPa.
- Passed: vertical swipe reached Soil `Line Chart`.
- Passed: Soil line chart rendered with zero Recharts point dots and zero active draw animations.
- Passed: calendar rendered a monthly coloured day overview with 30 day cells and no `mixed` wording.
- Passed after fix: Environment `Daily Min/Max` rendered a chart with zero Recharts point dots and zero active draw animations.
- Passed: no passive touch event listener console errors were observed.
- Passed: landscape detail had no page scroll, a 41.4 px thin header, and a wide chart surface (`844 x 348.6`).

Live-found fix:

- First Playwright run failed because `Daily Min/Max` emitted three Recharts dot elements for a single daily bucket (`recharts-area-dot`, two `recharts-line-dot`).
- Root cause: Recharts forces dots when `Line` or `Area` receives exactly one point, even when `dot={false}`.
- Fix commit: `2b93ab15` expands a single daily bucket into a short flat segment before rendering so Recharts uses paths instead of forced dots.
- Regression coverage: `DailyMinMaxView.test.tsx` now asserts single-bucket expansion preserves min/max/mean values.

Screenshots and result artifacts:

- `/home/phil/playwright-osi/screenshots-smooth-history-2026-06-02/01-dashboard.png`
- `/home/phil/playwright-osi/screenshots-smooth-history-2026-06-02/02-zone-b-soil-profile.png`
- `/home/phil/playwright-osi/screenshots-smooth-history-2026-06-02/03-zone-b-line-chart.png`
- `/home/phil/playwright-osi/screenshots-smooth-history-2026-06-02/04-zone-b-calendar.png`
- `/home/phil/playwright-osi/screenshots-smooth-history-2026-06-02/05-zone-a-daily-minmax.png`
- `/home/phil/playwright-osi/screenshots-smooth-history-2026-06-02/06-landscape-zone-b.png`
- `/home/phil/playwright-osi/screenshots-smooth-history-2026-06-02/results.json`
- `/home/phil/playwright-osi/screenshots-smooth-history-2026-06-02/console.log`

Manual verification still required:

- Playwright verified static visual behavior and single-finger view swipes only.
- Phil still needs to verify real-device pinch open, pinch close, and one-finger drag-pan feel because Playwright cannot honestly judge two-finger continuous smoothness.

## Loading and label polish issues

Date opened: 2026-06-07
Target: kaba100, `100.93.68.86`
Branch: `feat/history-data-visualization`
Plan: `docs/superpowers/plans/2026-06-07-history-loading-and-label-polish.md`

### Issue HLOAD-1 - History API loading time needs measurement and targeted optimization

Observed:

- Zone B card summary API via local Node-RED measured about `0.88 s`.
- Zone B 24h soil line data via local Node-RED measured about `0.95 s`.
- Zone B 7D soil line data via local Node-RED measured about `1.07 s`.
- Raw indexed SQLite 7D two-device `device_data` range query measured about `0.01-0.02 s`.
- Current `getLatestChameleonRows` query measured about `1.10 s`; per-device latest lookup using `idx_chameleon_readings_deveui_time` measured about `0.01 s`.

Root issue:

- The primary confirmed delay is not the raw history range scan. The latest Chameleon row lookup is a candidate bottleneck used by soil card summary and data responses.
- Additional likely overhead exists in repeated schema guards, duplicate SWR request keys, and backend SQL sorting that is repeated in JavaScript.
- The current evidence has an ordering/methodology gap: direct SQLite timing for `getLatestChameleonRows` was slower than one observed full card-summary HTTP request, so it cannot by itself prove in-request dominance. Phase timing must be collected before applying the query rewrite.

Best solution:

- Add a repeatable API timing harness and per-phase History API Router logging first.
- If phase timing confirms latest Chameleon lookup is material, fix `getLatestChameleonRows` to use indexed per-device `ORDER BY recorded_at DESC, id DESC LIMIT 1`.
- Then reduce duplicate frontend refetches and remove avoidable helper SQL sorting.
- Treat performance targets as optimization targets; if they are missed, use phase evidence to choose the next bottleneck instead of adding speculative fixes.

### Issue HUX-1 - Line chart label overlaps/conflicts with Zone B context

Observed:

- The fullscreen header renders the zone name as a separate eyebrow.
- The visualization renders a top-left absolute view/range pill.
- On mobile this creates too much top-left label clutter around the line chart.

Root issue:

- Zone identity and visualization context are rendered as separate labels in adjacent top-left areas.

Best solution:

- Move zone identity into the main card title.
- Render the detail title as `Soil Moisture Zone B`.
- Keep the top-left visualization pill for view/range/month context only.
- Apply the zone-title pattern to all zone-scoped thematic card details; gateway cards keep their base title because they are not zone scoped.

### Issue HUX-2 - Soil Card title is still `Soil - Root Zone`

Observed:

- The History API Router card config still returns `title: 'Soil - Root Zone'`.
- Several frontend tests still use `Soil - Root Zone` fixtures.

Root issue:

- The old implementation title survived the fullscreen redesign and does not match the new farmer-facing naming.

Best solution:

- Rename the base Soil Card title to `Soil Moisture` in the backend card summary config and update affected frontend fixtures/tests.
- Do not add or edit `history.card.soil.title` locale keys in this slice; current detail UI reads the backend card summary title, while `history.cardType.soil` remains the generic type label.
- Compose the zone-specific detail title in the route/header layer, not by mutating card identity.

### Issue HUX-3 - Soil line chart uses `Soil 1`, `Soil 2`, `Soil 3` instead of depth labels

Observed:

- `SoilLineChartView` derives labels from `series.id` and `series.label`.
- `HistoryCardDataResponse.profiles` already carries `depthCm`, but the line chart does not use it.

Root issue:

- Soil depth metadata and line-series labels are disconnected in the frontend.

Best solution:

- Use `profiles[].depthCm` to label matching soil series as `5 cm`, `10 cm`, etc.
- Fall back to `Sensor 1`, `Sensor 2`, `Sensor 3` when depth is unavailable.
- If two visible series share the same depth, disambiguate with the sensor number, for example `5 cm - Sensor 1`.
- Continue hiding raw DevEUI and `swt_*` labels from normal UI.

### Issue HUX-4 - Calendar view month context is not visible enough

Observed:

- `HistoryMonthCalendarView` computes and renders a month heading inside the calendar section.
- The persistent fullscreen top-left pill shows only `Calendar` for calendar view.

Root issue:

- The month label is scoped to the grid content and can be visually lost in the compact fullscreen layout; the persistent context label does not include it.

Best solution:

- Add a shared calendar month-label helper.
- Use it in both `HistoryMonthCalendarView` and `HistoryCardDetailPage`.
- Render `Calendar - June 2026` in the persistent top-left context pill while keeping the accessible grid month heading.

## History rollups and nightly CSV export verification

Date: 2026-06-02
Target: kaba100, `100.93.68.86`
Branch: `feat/history-rollups-csv`
Deployed backend commit: `b08dd99b`

Deployment:

- Deployed only Node-RED runtime history files: `/srv/node-red/osi-history-helper/index.js` and `/srv/node-red/flows.json`.
- Created live backup before replacement: `/srv/node-red/backups/history-rollups-20260602-215459`.
- Restarted Node-RED and confirmed `node -e "require('/srv/node-red/osi-history-helper')"` exited successfully.
- Did not overwrite `/data/db/farming.db`.
- Created temporary local user `playwright`, assigned Zones 3 and 12 plus their devices for API verification, then restored Zones 3 and 12 and their devices to `user_id=2` and deleted the temporary user.

Manual rollup run:

- Endpoint: `POST /api/history/rollups/run`.
- Result: success.
- Job duration: `44202 ms` server-reported, `44291 ms` measured by curl.
- Summary: `zones=2`, `cardsProcessed=7`, `bucketsUpserted=8534`, `csvZonesWritten=2`, `csvRowsWritten=3359`, `errors=[]`.

Rollup table counts:

- `daily`: `1524`
- `hourly`: `6763`
- `weekly`: `247`

CSV export checks:

- Files existed under `/data/exports/<zoneUuid>/{raw,hourly}/2026-06-01.csv` and `/data/exports/<zoneUuid>/daily.csv` for both tested zones.
- Raw header matched tidy schema: `timestamp,timezone,zone,card,source,variable,depth_cm,value,unit`.
- Aggregate header matched tidy schema: `bucket_start,bucket_end,timezone,zone,card,source,variable,depth_cm,unit,n,coverage_pct,mean,min,max,median,latest`.
- Soil sample with depth:
  `2026-06-01T13:58:28.070Z,UTC,Zone B,soil,Chameleon 1,swt_1,5,6.24,kPa`

API verification:

- Zone B card summary returned one merged Soil thematic card with `sourceDeviceCount=2` and source labels `Chameleon 1`, `Chameleon 2`.
- `GET /api/history/zones/12/cards/.../data?range=30d&aggregation=auto` returned daily aggregated series with `78` total points and `3` points for `2026-06-02`, confirming today remained present.
- Public card-data payload currently does not expose the helper `source` field. Direct helper verification on the Pi against `/data/db/farming.db` returned `source="rollups+live"`, `aggregation="daily"`, `bucketCount=26`, first bucket `2026-05-04T00:00:00.118Z`, last bucket `2026-06-02T00:00:00.910Z`.
- `GET /api/devices/A84041A75D5E7CFB/sensor-history?field=swt_1&hours=720` returned `26` aggregated `{t,value}` points.
- `GET /api/devices/A84041A75D5E7CFB/sensor-history?field=swt_1&hours=24` returned `96` raw `{t,value}` points.
- `GET /api/devices/A8404101FD5ECF41/dendro-history?hours=24` returned `72` rows and preserved the legacy dendro fields: `position_raw_mm`, `position_mm`, `delta_mm`, `stem_change_um`, `adc_v`, `adc_ch0v`, `adc_ch1v`, `dendro_ratio`, `dendro_mode_used`, `saturated`, `saturation_side`, `valid`.

Follow-up noted:

- If the frontend or diagnostics needs to display whether a card-data response came from `history_channel_rollups`, `device_data`, or `rollups+live`, expose the helper `source` in the public card-data payload. The backend read path already computes it.
