# 05 — Edge GUI

[← Edge database](04-edge-database.md) · [Index](README.md) · [→ Sync protocol](06-edge-cloud-sync.md)

Single-page React + TypeScript app, source at
[web/react-gui/src/](../../../web/react-gui/src), built with Vite
(`vite.config.js`, `base: '/gui/'`) and served by Node-RED as static files
from `/usr/lib/node-red/gui/`. Routing uses `HashRouter`, so deep links work
without server-side route handling. Data fetching uses SWR against the local
REST API. The app must run fully offline on gateway hardware.

Two rules dominate the codebase and its tests: missing telemetry renders as
an explicit unavailable state (never a substituted number; measured zeros
stay valid), and API-shape normalization stays in the service layer, never in
components.

## Routes and pages

[App.tsx](../../../web/react-gui/src/App.tsx) defines the route table;
authenticated routes wrap in `components/PrivateRoute.tsx`. Pages under
[src/pages/](../../../web/react-gui/src/pages):

| Route | Page | Function |
|---|---|---|
| `/login`, `/register` | `Login.tsx`, `Register.tsx` | Local account auth against the gateway. |
| `/dashboard` | `FarmingDashboard.tsx` | Primary control surface: zone cards, device cards, schedules, system panel. |
| `/history`, `/history/zones/:zoneId`, `…/cards/:cardId`, `/history/gateways/:gatewayEui/cards/:cardId` | `HistoryDashboard.tsx`, `HistoryCardDetailPage.tsx` | Thematic history cards with calendar/timeline navigation; split desktop and mobile shells. |
| `/analysis` | `AnalysisRoute.tsx` / `CrossZoneAnalysisPage.tsx` | Cross-zone channel overlay, correlation, saved views, CSV export. |
| `/settings` | `SettingsPage.tsx` | Display preferences (kPa/pF), bulk schedule disable. |
| `/account-link` | `AccountLink.tsx` | Cloud pairing UI over the account-link API. |
| `/support-requests` | `SupportRequests.tsx` | Work-request intake and status tracking. |

## Component layer

`src/components/farming/` implements the dashboard:

- Device cards per family: `KiwiSensorCard.tsx`, `DraginoTempCard.tsx`
  (passes both `bat_pct` and `bat_v`; the footer derives a percentage from
  voltage when `bat_pct` is absent, `shared/deviceCardBattery.ts`),
  `SenseCapWeatherCard.tsx`, `LoRainGaugeCard.tsx`, `StregaValveCard.tsx`
  with `ValveCancelButton.tsx`.
- Zone and schedule UI: `IrrigationZoneCard.tsx`, `ScheduleSection.tsx`,
  `AdvancedScheduleDrawer.tsx`, `ZoneConfigModal.tsx`, `CreateZoneModal.tsx`,
  `AssignDeviceModal.tsx`, `AddDeviceModal.tsx`.
- Monitors: `SensorMonitor.tsx`, `RainMonitor.tsx`, `WindMonitor.tsx` +
  `WindRoseChart.tsx`, `DendrometerMonitor.tsx` with the `dendrometer/`
  detail components.
- Device configuration and diagnostics: `DraginoSettingsModal.tsx`,
  `DraginoChameleonSwtSection.tsx` (channel values, depths, calibration
  status), `DraginoDendroCalibrationSection.tsx`.
- Panels: `SystemPanel.tsx` (health + fan), `IrrigationOutcomesPanel.tsx`,
  `DataExportSection.tsx`, `environment/` widgets, `RangeCalendar.tsx` with
  `rangeCalendarModel.ts`; crop coefficients in `cropKc.ts` and
  `predictionCropCatalog.json`.

`src/components/history/` + `src/history/` split presentation from logic:
shells (`HistoryDesktopShell.tsx`, `HistoryMobileShell.tsx`), card frame and
visualizations, `TimelineBrush.tsx`, `CalendarView.tsx`; models and hooks for
card definitions, range/viewport state, touch gestures, orientation, and
data (`useHistoryCards.ts`, `useHistoryCardData.ts`,
`useHistoryCardAdvancedData.ts`). `useFeatureFlags.ts` reads
`GET /api/system/features`; all flags default false until the response
arrives.

`src/components/analysis/` + `src/analysis/` implement the workbench: ECharts
wrapper (`EChart.tsx`, options in `echartsOptions.ts`), series tray, legend,
correlation panel (`correlation.ts`), export menu; API client
(`edgeAnalysisApi.ts`), catalog/series/views hooks, unit grouping for axis
assignment, deterministic series colors, workspace persistence.

`src/channels/registry.ts` + `channels.json` mirror the edge channel
manifest; `scripts/verify-channel-manifest-parity.js` keeps GUI, edge, and
cloud copies aligned.

## Cross-cutting

| Concern | Location | Contract |
|---|---|---|
| REST client | `src/services/api.ts` | Single entry point for HTTP; snake_case/camelCase bridging and EUI normalization live here. Auth token storage and expiry cleanup with `src/contexts/AuthContext.tsx`, `src/services/authEvents.ts`. |
| Types | `src/types/farming.ts` | Shared domain types (Device, Zone, Schedule, readings). |
| Unit helpers | `src/utils/swt.ts` (`kpaToPf = log10(kPa·10)`, null for non-positive input; wet/moderate/dry bucketing at 20/60 kPa), `src/utils/rain.ts` (no-sample vs measured-dry), `src/utils/wind.ts`, `displayPreferences.ts`, `forecastFormat.ts` | Unit conversions and missing-data semantics, each with tests under `src/utils/__tests__/`. |
| i18n | `src/i18n/config.ts`, `public/locales/<lng>/<ns>.json`, `components/LanguageSwitcher.tsx` | i18next with HTTP backend at `/gui/locales/…`; coverage incomplete (issue #47), new keys go to every locale directory. |

## Build and test

`npm run build` produces the static bundle packaged into firmware and into
`react_gui.tar.gz` for live deploys. `npm run test:unit` chains two suites:
a tsx runner for `tests/**/*.test.ts` and Vitest for `src/**/__tests__` plus
selected component test directories; both must pass. TypeScript edits follow
the repo overlays ([architect.yaml](../../../architect.yaml),
[RULES.yaml](../../../RULES.yaml),
[docs/agents/typescript-rule-overlays.md](../../agents/typescript-rule-overlays.md)).
CI runs the suite in `.github/workflows/typecheck.yml`.
