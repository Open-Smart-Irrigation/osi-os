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

Status as of 2026-06-07 on desktop branch `feat/history-desktop-mode`:

- Deployed GUI-only asset on kaba100: `assets/index-aqwOWdjh.js`.
- Deployment method: static tar extract into `/usr/lib/node-red/gui/` only.
- Safety confirmation: `/data/db/farming.db`, DB sidecars, Node-RED flows, and Node-RED config were not touched during this desktop GUI deployment.
- Product decision: Zone B remains one merged `Soil Moisture` thematic card; desktop must expose `All` / per-source controls inside that card instead of splitting Soil into multiple cards.
- Desktop route under test: `http://100.93.68.86:1880/gui/#/history/zones/12` and `#/history/zones/3`.
- Browser QA artifacts:
  - `/home/phil/playwright-osi/screenshots-desktop-gui-2026-06-07/desktop-zone-b-focus.png`
  - `/home/phil/playwright-osi/screenshots-desktop-gui-2026-06-07/desktop-zone-b-compare.png`
  - `/home/phil/playwright-osi/screenshots-desktop-gui-2026-06-07/mobile-zone-b-history.png`
  - `/home/phil/playwright-osi/screenshots-desktop-debug-2026-06-07/zone-a-focus.png`

### Desktop issue 2026-06-07-A - Desktop has no card-specific view selector

Severity: S0 for desktop usability

Symptom:

- Zone B desktop detail only shows the default `Soil Profile` / soil layer view.
- There is no visible control to switch Soil to `Line Chart`, `Calendar`, `Irrigation Response`, or `Advanced`.
- The header contains only `Focus | Compare`, range presets, and zoom buttons.

Code evidence:

- `HistoryDesktopDetail` initializes the selected view but never exposes a setter:

```ts
const [selectedView] = useState<HistoryViewMode>(defaultView);
```

- The desktop header renders mode, range, and zoom controls only.
- `HistoryCardDetailPage` has mobile view-selection logic, but desktop does not reuse it.

Root cause:

Desktop mode treats `selectedView` as a fixed default instead of a card-specific user state. This conflicts with the UX spec, which requires card-specific view modes and no global view-mode selector.

Required fix:

- Add a desktop card-specific view selector to `HistoryDesktopDetail`.
- The selector must use `selectedCard.views`, filtered through the existing card definitions, and reset to the selected card default when the user changes cards.
- Wire `selectedView` into:
  - the card data request;
  - compare-panel defaults;
  - `HistoryCardVisualization`;
  - Advanced View data loading when `selectedView === 'advanced'`.

Acceptance criteria:

- Zone B Soil desktop exposes `Soil Profile`, `Line Chart`, `Calendar`, `Irrigation Response`, and `Advanced`.
- Switching views fetches/renders the matching card data without leaving the route.
- Changing cards resets the active view to the new card's default unless a saved preference is explicitly introduced.

### Desktop issue 2026-06-07-B - Recharts desktop views collapse to zero height

Severity: S0 for desktop chart visibility

Symptom:

- Zone A desktop detail appears blank, but there is no user-visible error and no console error.
- Compare mode panels can show headers but no chart content.
- Playwright DOM evidence for Zone A focus:
  - `desktop-chart-surface`: height `805px`.
  - chart region: height `20px`.
  - `.recharts-responsive-container`: height `0px`.
  - no `svg` and no Recharts wrapper are mounted.

Live API evidence:

- Zone A card data endpoints return valid series:
  - Dendro cards return 3-4 series and hundreds of points for 48h/7D.
  - Environment card returns `ext_temperature_c` series with hundreds of points.
- Therefore the blank view is not caused by missing backend data.

Code evidence:

- `HistoryDesktopDetail` renders the visualization directly inside a non-flex block container:

```tsx
<div data-testid="desktop-chart-surface" className="relative min-h-0 flex-1 ...">
  <HistoryCardVisualization ... />
</div>
```

- Recharts-based visualization roots use `flex-1` and nested `ResponsiveContainer height="100%"`, for example `DendroGrowthTimelineView`, `DendroLineChartView`, `EnvironmentLineChartView`, `DailyMinMaxView`, and `SoilLineChartView`.
- `flex-1` on a child has no useful effect when the parent is not a flex container, so the nested `ResponsiveContainer` receives zero height.

Root cause:

The desktop chart surface does not provide a flex/height contract that Recharts views require. Recharts silently renders no SVG when its responsive container has zero height, which explains the blank UI with no error.

Required fix:

- Make the desktop focus chart surface a flex column container.
- Wrap `HistoryCardVisualization` in a `min-h-0 flex-1` container, or make the surface itself provide the `flex flex-col` contract expected by chart views.
- Apply the same height contract to `HistoryCompareGrid` panel visualization wrappers.
- Do not paper over this by adding arbitrary fixed chart heights to each individual visualization unless a shared surface contract proves insufficient.

Acceptance criteria:

- On Zone A desktop focus, `.recharts-responsive-container` has non-zero height and a chart `svg` is mounted.
- Dendro Growth Timeline and Environment Line Chart render visible axes/series.
- Compare mode renders 2-4 nonblank panels when the selected cards have data.

### Desktop issue 2026-06-07-C - Desktop viewport bounds can exceed live data bounds

Severity: S1

Symptom:

- Zone B desktop 24h/Season can produce overview styles like `left=-176%` and `width=276%`.
- After clicking zoom in, the overview clamps to `left=0%`, `width=100%`.
- Zoom out and brush dragging then become no-ops.

Live evidence:

- Zone B data is recent but narrower than the requested display window.
- Initial viewport and preset ranges are based on `Date.now()`, while `effectiveBounds` is replaced by data-derived min/max when data loads.
- When the requested viewport is wider than the returned data extent, the overview math computes negative/oversized percentages.

Root cause:

`effectiveBounds` is allowed to shrink to the data extent, while `viewport` can remain the larger requested date range. The brush/zoom layer then receives inconsistent bounds and viewport state.

Required fix:

- Keep request-range bounds and visible viewport in one coherent model.
- Recommended MVP fix: compute `effectiveBounds` as the union of requested bounds and derived data bounds, not the derived data bounds alone.
- Clamp viewport only against bounds that include the selected requested window.
- Use the selected preset/viewport range consistently in the API request; do not let `bounds`, `viewport`, and `activePreset` diverge silently.

Acceptance criteria:

- Overview window percentages stay within `0..100%` for 24h, 7D, 30D, and Season.
- Zoom in, zoom out, reset, and brush drag all change state when a smaller-than-full viewport exists.
- No negative or greater-than-100% overview style is produced in normal operation.

### Desktop issue 2026-06-07-D - Zone B source state is not visible enough

Severity: S1

Symptom:

- Zone B has two assigned Chameleon sources, but desktop shows one `Soil Moisture` card and no source selector.
- The API returns `sourceDeviceCount: 2`, `sourceLabels: ["Chameleon 1", "Chameleon 2"]`, and source devices with display-safe names.
- Per-source data currently differs:
  - `Chameleon 1` returns SWT series/profiles.
  - `Chameleon 2` returns no SWT series/profiles in the sampled 7D range.

Live device evidence:

```json
{
  "name": "Chameleon 2",
  "last_seen": "2026-06-07T09:20:09.036Z",
  "calibration_status": "pending",
  "swt": [null, null, null],
  "chameleon_i2c_missing": 1,
  "chameleon_array_id": null
}
```

```json
{
  "name": "Chameleon 1",
  "last_seen": "2026-06-07T09:22:55.602Z",
  "calibration_status": "calibrated",
  "swt": [6.52, 7.23, 34.95],
  "chameleon_i2c_missing": 0,
  "chameleon_array_id": "289200D40F000091"
}
```

Root cause:

The backend is currently using a merged Soil card, which is acceptable for the thematic-card model, but the desktop UI does not expose the merged card's source list or source availability. The farmer sees one card and cannot tell that one contributing source is healthy while another is currently missing Chameleon/I2C data.

Required fix:

- Add a desktop source selector for multi-source cards:
  - `All`
  - `Chameleon 1`
  - `Chameleon 2`
- Pass the selected source's `sourceKey` to `useHistoryCardData`.
- Show source availability metadata next to each source option when available:
  - last seen;
  - data present / no current data;
  - calibration status;
  - Chameleon/I2C missing status when surfaced by the API.
- Keep raw DevEUI hidden in normal desktop mode.

Acceptance criteria:

- Zone B desktop makes both sources visible without showing raw DevEUI.
- Selecting `Chameleon 1` shows data.
- Selecting `Chameleon 2` shows an explicit no-soil-data / sensor-missing state instead of silently looking like the whole card is broken.

### Desktop issue 2026-06-07-E - Zone A cards are not distinguishable enough

Severity: S2

Symptom:

- Zone A returns five Dendro cards, but all appear as `Dendro - Growth Timeline` in the desktop rail.
- Source labels exist in the API (`Dendro1`, `Dendro 2`, `Dendro 3`, etc.), but the desktop rail/header does not include them.

Root cause:

The desktop rail uses `card.title` only. For single-source cards, `sourceLabel` is the farmer-facing differentiator and should be part of the normal-mode label.

Required fix:

- In the desktop rail, render a display-safe source label for single-source cards.
- Recommended label shape:
  - rail: `Dendro 3`
  - header: `Dendro 3 - Growth Timeline Zone A`
  - fallback when no source label exists: current card title.
- Do not expose DevEUI or `dendro-src-*` card tokens.

Acceptance criteria:

- Zone A's five Dendro cards are distinguishable in the left rail.
- The selected Dendro card title includes the farmer-facing source label.

## Desktop fix plan for next implementation pass

1. Fix chart height first.
   - Update `HistoryDesktopDetail` and `HistoryCompareGrid` so every desktop visualization is inside a flex column container with a non-zero `min-h-0 flex-1` contract.
   - Verify Zone A focus mounts a non-zero `.recharts-responsive-container` and an `svg`.

2. Fix viewport/bounds state.
   - Stop replacing requested bounds with narrower data-derived bounds.
   - Use a union/clamped model so the overview strip cannot produce negative or greater-than-100% percentages.
   - Verify range presets, zoom buttons, wheel zoom, reset, and brush drag after 24h/7D/30D/Season.

3. Add the desktop card-specific view selector.
   - Replace fixed `selectedView` state with a setter.
   - Render view options from `selectedCard.views`.
   - Wire Advanced View data separately.
   - Verify Zone B Soil can switch to Line Chart and Calendar.

4. Add desktop source visibility and filtering.
   - Show display-safe source labels in the rail/header.
   - Add `All` / per-source selection for multi-source cards.
   - Pass `sourceKey` into card data requests.
   - Show an explicit source-level no-data state for sources like Zone B `Chameleon 2`.

5. Improve desktop QA coverage.
   - Add component tests for view-selector state and source-selector requests.
   - Add Playwright live checks for:
     - Zone B Soil Profile -> Line Chart -> Calendar;
     - Zone A Dendro/Environment nonblank Recharts SVG;
     - no raw 16-hex DevEUI in normal mode;
     - source selector shows Chameleon names and filters data.

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
Tracking: this section is the active issue record; the transient implementation plan was removed during plan-file cleanup.

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

## Zone CSV range export verification

Date: 2026-06-03
Target: kaba100, `100.93.68.86`
Branch: `feat/zone-csv-range-export`
Deployed commits: through `a946120a`

Deployment:

- Deployed `/srv/node-red/osi-history-helper/index.js`, `/srv/node-red/flows.json`, and the GUI build under `/usr/lib/node-red/gui/`.
- Restarted Node-RED with `/etc/init.d/node-red restart`.
- Confirmed `node -e "require('/srv/node-red/osi-history-helper')"` printed `helper-ok`.
- Confirmed `/gui/` returned HTTP `200`.
- Confirmed served GUI asset `index-DbddF-7u.js` matched the local build asset.
- Did not overwrite `/data/db/farming.db`.

Temporary-user handling:

- Created temporary local user `playwright`, reassigned Zones 3 and 12 plus their devices for verification.
- Restored Zones 3 and 12 and their devices to `user_id=2`.
- Deleted the temporary `playwright` user.
- Restore check: `playwright_count=0`, Zone 3 and Zone 12 both `user_id=2`, devices in Zone 3 and Zone 12 both `user_id=2`.

Browser UI verification:

- Opened Zone B settings from the live dashboard.
- Confirmed the `Data export` settings section rendered.
- Confirmed the monthly range calendar rendered in the modal.
- Double-clicked `2026-06-02` and downloaded Raw CSV through the browser download path.
- Suggested filename: `zone-12-2026-06-02_2026-06-02-raw.csv`.
- Header: `timestamp,timezone,zone,card,source,variable,depth_cm,value,unit`.
- Row count: `333`.
- Soil sample with depth: `2026-06-02T13:58:22.382Z,UTC,Zone B,soil,Chameleon 1,swt_1,5,6.36,kPa`.
- Raw EUI scan: no `[A-F0-9]{16}` value found in the UI-downloaded CSV.

Endpoint verification:

- Pi clock during verification: `Tue Jun 2 23:08:50 UTC 2026`; Zone B timezone: `UTC`.
- `GET /api/history/zones/12/export.csv?from=2026-06-02&to=2026-06-02&granularity=raw` returned HTTP `200`.
- Today/local-current-day raw header matched: `timestamp,timezone,zone,card,source,variable,depth_cm,value,unit`.
- Today/local-current-day raw row count: `333`.
- Wide Raw export, `2026-05-01..2026-06-02`: `1,667,425` bytes.
- Wide Daily export, `2026-05-01..2026-06-02`: `10,414` bytes.
- Daily header matched: `bucket_start,bucket_end,timezone,zone,card,source,variable,depth_cm,unit,n,coverage_pct,mean,min,max,median,latest`.
- Oversized Raw export, `2026-01-01..2026-06-02`, returned HTTP `413`.
- 413 body: `{"error":"range too large for this granularity","suggestion":"choose a coarser granularity"}`.
- API Raw EUI scan: no raw 16-hex DevEUI found.
- Daily EUI scan: no raw 16-hex DevEUI found.

Observation:

- Daily aggregate rows for Zone B use display-safe `source=2 sources` because the Soil card merges both Chameleon devices. Those merged aggregate rows leave `depth_cm` blank; raw per-source soil rows include `depth_cm`.

Artifacts:

- `/tmp/kaba100-zone-export-dashboard.png`
- `/tmp/kaba100-zone-export-settings.png`
- `/tmp/kaba100-zone-export-after-download.png`
- `/tmp/kaba100-zone-b-2026-06-02-raw.csv`
- `/tmp/kaba100-zone-b-2026-06-02-raw-api.csv`
- `/tmp/kaba100-zone-b-wide-raw.csv`
- `/tmp/kaba100-zone-b-wide-daily.csv`

## Zone CSV per-source aggregate verification

Date: 2026-06-03
Target: kaba100, `100.93.68.86`
Branch: `feat/zone-csv-range-export`
Deployed commits: through `439b5b3a`

Deployment:

- Deployed only `/srv/node-red/osi-history-helper/index.js`.
- Restarted Node-RED with `/etc/init.d/node-red restart`.
- Confirmed `node -e "require('/srv/node-red/osi-history-helper')"` printed `helper-ok`.
- Confirmed `/gui/` returned HTTP `200`.
- Did not overwrite `/data/db/farming.db`.

Temporary-user handling:

- Created temporary local user `playwright`, reassigned Zones 3 and 12 plus their devices for verification.
- Restored Zones 3 and 12 and their devices to `user_id=2`.
- Deleted the temporary `playwright` user.
- Restore check: `playwright_count=0`, Zone 3 and Zone 12 both `user_id=2`, devices in Zone 3 and Zone 12 both `user_id=2`.

Requested live check:

- `GET /api/history/zones/12/export.csv?from=2026-06-01&to=2026-06-02&granularity=daily` returned HTTP `200`.
- The CSV contained `Chameleon 1` soil rows only.
- Root cause: live Zone B `Chameleon 2` has `device_data` rows in that range, but zero `swt_1`, `swt_2`, or `swt_3` values. Its historical soil values end on `2026-05-28T05:05:48.462Z`.
- This is a live-data limitation for the requested date range, not a remaining merged-export bug.

Per-source aggregate verification on overlapping live data:

- `GET /api/history/zones/12/export.csv?from=2026-05-27&to=2026-05-28&granularity=daily` returned HTTP `200`.
- Header matched: `bucket_start,bucket_end,timezone,zone,card,source,variable,depth_cm,unit,n,coverage_pct,mean,min,max,median,latest`.
- Soil sources found: `Chameleon 1`, `Chameleon 2`.
- No `source=2 sources` rows found.
- No blank `depth_cm` values found on soil rows.
- No raw 16-hex DevEUI found.
- Sample `Chameleon 1` row:
  `2026-05-27T00:00:00.000Z,2026-05-28T00:00:00.000Z,UTC,Zone B,soil,Chameleon 1,swt_1,5,kPa,288,,4.103,3.71,4.45,4.16,4.45`
- Sample `Chameleon 2` row:
  `2026-05-27T00:00:00.000Z,2026-05-28T00:00:00.000Z,UTC,Zone B,soil,Chameleon 2,swt_1,5,kPa,218,,1.621,1.01,2.18,1.65,1.01`

Raw/range guard regression checks:

- `GET /api/history/zones/12/export.csv?from=2026-05-27&to=2026-05-27&granularity=raw` returned Raw header `timestamp,timezone,zone,card,source,variable,depth_cm,value,unit`.
- Raw sources found: `Chameleon 1`, `Chameleon 2`.
- Raw soil rows had no blank `depth_cm` values and no raw 16-hex DevEUI.
- Oversized Raw export, `2026-01-01..2026-06-02`, still returned HTTP `413`.
- 413 body remained: `{"error":"range too large for this granularity","suggestion":"choose a coarser granularity"}`.

Artifacts:

- `/tmp/kaba100-zone-b-daily-per-source.csv`
- `/tmp/kaba100-zone-b-daily-per-source-overlap.csv`
- `/tmp/kaba100-zone-b-raw-per-source-overlap.csv`
- `/tmp/kaba100-zone-b-oversize-raw-per-source.json`

## Status After Desktop Live Fixes - 2026-06-07

Verified on kaba100 after GUI-only static deploy to `/usr/lib/node-red/gui/`.

- Served bundle: `/gui/assets/index-wPoYK-WG.js`.
- Zone B desktop title renders as `Soil Moisture Zone B`.
- Zone B remains one merged Soil Moisture card with `All`, `Chameleon 1`, and `Chameleon 2` source controls.
- Zone B Line Chart renders a nonblank Recharts SVG; responsive chart container measured `1216 x 783`.
- Zone A desktop rail exposes distinct Dendro labels from the API: `Dendro 4`, `Dendro1`, `Dendro 5`, `Dendro 3`, `Dendro 2`.
- Zone A focus view renders a nonblank Recharts SVG; responsive chart container measured `1216 x 763`.
- Compare mode renders 2 synchronized panels in the structural Playwright check.
- Normal desktop mode did not expose raw 16-hex DevEUI values.
- Mobile route still uses the fullscreen gesture detail instead of the desktop rail/control layout.
- Playwright reported no console errors and no page errors.
- Screenshots and machine-readable result: `/home/phil/playwright-osi/screenshots-desktop-live-fixes-2026-06-07/`.

Live verification notes:

- Mouse-wheel zoom feel, drag-pan feel, and crosshair smoothness still need a human on-device pass.
- The label `Dendro1` is preserved from the device name as provided by the API; spacing normalization can be handled as a later polish issue if desired.
