# 05 — Farmer Dashboard (React GUI)

[← Edge database](04-edge-database.md) · [Index](README.md) · [→ Sync](06-edge-cloud-sync.md)

The dashboard is a single-page web app the farmer opens at
`http://<gateway>:1880/gui` on any phone, tablet, or laptop on the farm network.
It is fully local — no internet required — and is deliberately conservative
about data honesty: a missing reading renders as "unavailable", never as a
made-up number.

- Source: [web/react-gui/src/](../../../web/react-gui/src)
- Tech: React + TypeScript, built with Vite (`web/react-gui/vite.config.js`,
  base path `/gui/`), data fetching with SWR; the analysis workbench charts with
  ECharts, the history cards with purpose-built visualization components.
- Served by Node-RED as static files from `/usr/lib/node-red/gui/` on the Pi.
- Routing uses hash URLs (`/gui/#/dashboard`) so deep links work without any
  server-side routing.

## Pages (the screens)

All in [web/react-gui/src/pages/](../../../web/react-gui/src/pages), wired in
[App.tsx](../../../web/react-gui/src/App.tsx); protected pages sit behind
`components/PrivateRoute.tsx` (redirects to login without a valid session).

| Page | What the farmer sees / does |
|---|---|
| `Login.tsx` / `Register.tsx` | Sign in or create a local account on the gateway. |
| `FarmingDashboard.tsx` | The home screen: zone cards, live device cards, system panel, schedules — the day-to-day control room. |
| `HistoryDashboard.tsx` | "What happened?" — thematic history cards (soil, rain, climate, irrigation…) per zone or gateway, with calendar and timeline navigation; separate desktop and mobile layouts. |
| `HistoryCardDetailPage.tsx` | One history card blown up to full screen with advanced overlays and CSV export. |
| `AnalysisRoute.tsx` / `CrossZoneAnalysisPage.tsx` | "Compare anything": pick any measurement channels across zones, overlay them on one chart, correlate, save the view, export CSV. |
| `SettingsPage.tsx` | Global settings, including display preferences (e.g. soil tension shown as kPa or pF) and bulk schedule disable. |
| `AccountLink.tsx` | The cloud-pairing screen (link/unlink this gateway to an OSI Cloud account). |
| `SupportRequests.tsx` | File and track feedback/problem reports (the field→developer pipeline's front door). |

## Component families

Under [web/react-gui/src/components/](../../../web/react-gui/src/components):

### `farming/` — the dashboard building blocks

- **Device cards**: one card type per device family, showing latest readings
  and per-device actions: `KiwiSensorCard.tsx`, `DraginoTempCard.tsx` (LSN50;
  includes battery-percent fallback derived from voltage),
  `SenseCapWeatherCard.tsx` (weather station), `LoRainGaugeCard.tsx` (rain
  gauge), `StregaValveCard.tsx` (valve with open/cancel controls and
  confirmation states), plus shared pieces under `farming/shared/`
  (e.g. the battery footer logic in `deviceCardBattery.ts`).
- **Zone & schedule UI**: `IrrigationZoneCard.tsx` (a zone's status),
  `ScheduleSection.tsx` + `AdvancedScheduleDrawer.tsx` (edit watering rules),
  `ZoneConfigModal.tsx`, `CreateZoneModal.tsx`, `AssignDeviceModal.tsx`,
  `AddDeviceModal.tsx`, `ValveCancelButton.tsx`.
- **Monitors**: focused live views: `SensorMonitor.tsx` (soil),
  `RainMonitor.tsx`, `WindMonitor.tsx` + `WindRoseChart.tsx` (wind-direction
  rose), `DendrometerMonitor.tsx` and the `dendrometer/` subfolder (tree
  detail: daily indicators, stress badges, baseline reset).
- **Specialist panels**: `DraginoChameleonSwtSection.tsx` (soil-probe
  channels, depths, calibration status), `DraginoDendroCalibrationSection.tsx`,
  `DraginoSettingsModal.tsx` (remote device configuration),
  `IrrigationOutcomesPanel.tsx` (recent irrigations), `SystemPanel.tsx`
  (gateway health: CPU, memory, fan control), `DataExportSection.tsx` (CSV
  download), `environment/` (zone environment summary widgets),
  `RangeCalendar.tsx` (+ `rangeCalendarModel.ts`), crop coefficients in
  `cropKc.ts` + `predictionCropCatalog.json`.

### `history/` + `src/history/` — the history dashboard engine

Presentation in `components/history/` (`HistoryDesktopShell.tsx`,
`HistoryMobileShell.tsx`, `HistoryCardFrame.tsx`,
`HistoryCardVisualization.tsx`, `ThematicCardCarousel.tsx`, `CalendarView.tsx`,
`TimelineBrush.tsx`, `AdvancedViewPanel.tsx`, `InterpretationList.tsx`, plus
`desktop/`, `mobile/`, `visualizations/`). Logic in `src/history/`: card
definitions (`cardDefinitions.ts`), time-range and viewport models
(`rangeModel.ts`, `historyViewport.ts`, `useTimeViewport.ts`), gesture handling
for touch (`gestureModel.ts`, `useVisualizationGestures.ts`), data hooks
(`useHistoryCards.ts`, `useHistoryCardData.ts`,
`useHistoryCardAdvancedData.ts`), device/desktop detection, soil-status
interpretation (`soilStatus.ts`), and the feature-flag hook
(`useFeatureFlags.ts` — flags come from the gateway's
`GET /api/system/features`; everything defaults to *off* while loading).

### `analysis/` + `src/analysis/` — the cross-zone analysis engine

`components/analysis/` renders the workbench (`AnalysisChartPanel.tsx`,
`AnalysisControls.tsx`, `AnalysisSeriesTray.tsx`, `AnalysisChartLegend.tsx`,
`CorrelationPanel.tsx`, `AnalysisViewsMenu.tsx`, `AnalysisExportMenu.tsx`,
`MetricAcrossZonesPicker.tsx`, `EChart.tsx`). `src/analysis/` holds the brains:
the API client (`edgeAnalysisApi.ts`), series/catalog/views hooks, correlation
math (`correlation.ts`), unit grouping so axes make sense
(`unitGrouping.ts`), stable series colors (`seriesColors.ts`), CSV/download
helpers, and saved-view storage (`analysisWorkspaceStorage.ts`,
`workspaceModel.ts`).

### `channels/` — the shared measurement vocabulary

`src/channels/registry.ts` + `channels.json`: the GUI-side copy of the channel
manifest (every plottable measurement with unit and label). Kept in step with
the edge's `edge-channels.json` and the cloud by a parity verifier.

## Cross-cutting pieces

| Piece | Where | Plain-language job |
|---|---|---|
| API client | `src/services/api.ts` | Every REST call to the gateway backend goes through here; also normalizes naming differences and device IDs so components never worry about them. Auth token handling + logout-on-expiry live here with `src/contexts/AuthContext.tsx` and `src/services/authEvents.ts`. |
| Device location helper | `src/services/deviceLocation.ts` | Resolves gateway/device positions for display. |
| Types | `src/types/farming.ts` | The shared TypeScript dictionary of domain objects (Device, Zone, Schedule, readings…). |
| Unit & honesty helpers | `src/utils/swt.ts` (kPa↔pF conversion, wet/dry buckets), `src/utils/rain.ts` (no-data vs measured-zero), `src/utils/wind.ts`, `src/utils/forecastFormat.ts`, `src/utils/displayPreferences.ts` | Small, heavily-tested functions that keep units and missing-data semantics correct everywhere. |
| i18n | `src/i18n/config.ts` + `public/locales/<lang>/` | Translations (i18next). Language switcher in `components/LanguageSwitcher.tsx`. Coverage is still partial (issue #47). |
| Header/nav | `components/DashboardHeader.tsx`, `components/HeaderMenu.tsx` | Top bar and menu. |

## Building and testing

- `cd web/react-gui && npm run build` → static bundle, packaged into the
  firmware image (and tarred as `react_gui.tar.gz` for live deploys).
- `npm run test:unit` runs **two** suites: a tsx-based runner for
  `tests/**/*.test.ts` and Vitest for `src/**/__tests__` — both must pass.
- TypeScript work follows the repo rule overlays
  ([architect.yaml](../../../architect.yaml), [RULES.yaml](../../../RULES.yaml),
  workflow in [docs/agents/typescript-rule-overlays.md](../../agents/typescript-rule-overlays.md)).
