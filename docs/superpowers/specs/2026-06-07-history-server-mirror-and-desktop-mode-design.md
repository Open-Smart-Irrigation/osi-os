# History Server Mirror + Desktop Mode — Design

Date: 2026-06-07
Repos: `osi-os` and `osi-server`
Branch (both): `feat/history-data-visualization`
Status: Approved design, ready for implementation planning

## Goal

Two workstreams in one combined spec:

1. **W1 — Server parity mirror.** Bring the recent osi-os history polish (label/UX and the user-visible parts of the loading work) into osi-server so the two history UIs stay consistent.
2. **W2 — Desktop mode.** Add a mouse-native desktop history experience to **both** repos: scroll-to-zoom, drag-to-pan, hover crosshair, an overview/brush strip, and an ad-hoc Compare view. Designed once, implemented in each frontend.

### Full-branch parity scope (added 2026-06-07 after review)

The request is **full-branch parity to the server**, not just the recent polish. Audit result:

- **History API/contract:** osi-server **already** exposes every osi-os history route at `/api/v1/history` (cards, data, advanced, opened, preferences, gateway equivalents, workspaces CRUD). Rollups exist on both. The backend "new history view" is already adapted.
- **Frontend parity gaps (W1, expanded):** (G1) small contract drift — server `types.ts` lacks `HistoryCardPreference`, `HistoryCardSourceDevice`, `HistoryWorkspaceListResponse`; (G2) missing UX modules — `sourceLabels.ts`, `soilStatus.ts`, and the **mobile gesture surface** (`gestureModel.ts`, `useVisualizationGestures.ts`, `useOrientation.ts`) plus the fullscreen mobile detail. **Decision: full UX parity including mobile gestures.** Added as Phase 2 of the W1 plan.
- **CSV export (G3):** designed but **unbuilt everywhere** (osi-os has specs/plans only). **Decision: edge-first, then cloud.** Execute the existing osi-os edge CSV plans, then author a cloud CSV plan mirroring the edge result. Sequenced after W1/W2; tracked in the W1 plan header roadmap.

## Background and current state

The two repos share a common history ancestor but have **diverged**:

- **osi-os** received a mobile-first redesign: a route-backed fullscreen `HistoryCardDetailPage`, a `components/history/mobile/` dir, and a raw touch-gesture surface (pinch-zoom, pan, card/view swipe). Its `HistoryDesktopShell.tsx` (~259 lines) is the *older* workspace/comparison surface and did not receive the mobile polish.
- **osi-server** is the cloud/desktop-leaning side: a larger `HistoryDesktopShell.tsx` (~494 lines), a `TimelineBrush.tsx` mouse range-selector, `HistorySidebar.tsx`, cloud workspaces/comparison, and a full Java history backend (`org.osi.server.history.*`).

Because the frontends share component *names* but evolved separately, "mirror" means **porting behavior to differently-named components**, not copying files.

The recent osi-os work (commits `c780365c..b135fe40`) splits into:

- **Backend (Node-RED `flows.json` + `osi-history-helper`):** `getLatestChameleonRows` query fix, `ORDER BY deveui, recorded_at` change, cached schema guard, phase timing. These are **SQLite-on-Pi / Node-RED specific**.
- **Frontend (React):** "Soil Moisture" rename, soil depth labels, calendar month context, source names in detail header, SWR de-duplication, i18n across 7 locales.

### Verified facts (from code inspection)

- osi-server frontend has all mirror targets: `frontend/src/history/cardDefinitions.ts`, `i18nKeys.ts`, `components/history/CalendarView.tsx`, `components/history/visualizations/SoilProfileView.tsx`, `history/useHistoryCardData.ts`, `history/useHistoryCardAdvancedData.ts`, `history/types.ts` (with `sourceLabel`/`sourceDevices`), and `depthCm` already in types.
- osi-server backend `JdbcHistoryRawQueryRepository` uses a `channel_key` model with indexed `ORDER BY recorded_at ASC` and **no** `MAX(id)` latest-row join and **no** per-request schema guard (the cloud uses migrations). The edge perf fixes therefore do **not** port.
- Both frontends already depend on Recharts and SWR.

## W1 — Server parity mirror

### Scope: frontend-only port

| Change | osi-os source | osi-server target |
|---|---|---|
| "Soil Moisture" rename (was "Soil - Root Zone") | `web/react-gui/src/history/cardDefinitions.ts`, `flows.json` `CARD_CONFIG.soil`, 7 locale `history.json` | `frontend/src/history/cardDefinitions.ts`, `frontend/src/history/i18nKeys.ts`, server locale files |
| Soil **depth labels** (`5 cm`/`10 cm`/`30 cm`, fallback `Sensor N`, never DevEUI/`swt_*`) | `components/history/visualizations/SoilLineChartView.tsx` | osi-server soil view (`SoilProfileView.tsx` and/or its line view) using existing `depthCm` |
| **Calendar month** in persistent context | `history/calendarMonth.ts`, `components/history/visualizations/HistoryMonthCalendarView.tsx` | shared month helper + `components/history/CalendarView.tsx` |
| **Source names** in detail header | `components/history/mobile/HistoryDetailHeader.tsx` | osi-server header/shell using existing `sourceLabel`/`sourceDevices` |
| **SWR de-dup** (`revalidateOnFocus:false`, `dedupingInterval`, minute-canonical keys) | `history/useHistoryCardData.ts`, `history/useHistoryCardAdvancedData.ts` | same-named hooks in `frontend/src/history/` |

### Backend: parity verification only

- Confirm osi-server's soil/profile path has no `MAX(id)`-style latest-row hotspot and that ordering stays index-friendly. No Java code change is expected.
- Record in the implementation notes that the edge perf fixes (latest-row query, cached schema guard, helper `ORDER BY`, phase timing) are **intentionally not ported** because they target SQLite/Node-RED on the Pi, not the cloud JDBC stack.

## W2 — Desktop mode

### Layout: C — focused with ad-hoc Compare

- Desktop activates at a width breakpoint. Mobile keeps its current gesture detail page **unchanged**.
- Left rail: zone selector then thematic card list (Soil, Dendro, Environment, Irrigation, Gateway).
- Main area: one focused card with a large chart.
- **Compare toggle:** swaps the chart area for a 2–4 card grid from the current zone sharing one time window. **No persistence** (not the full saved-workspaces system).

### Interaction model: A — drag = pan

- **Wheel = zoom**, anchored at the cursor's time position, **time-axis only**. The handler calls `preventDefault` so the page does not scroll; the chart is a full-height focused surface.
- **Drag = pan** the time window.
- **Hover = crosshair + multi-series tooltip** at the hovered timestamp.
- **Overview/brush strip** below the chart: mini full-range view with a draggable window for fast long-range navigation.
- **Double-click = reset** to the card's default range. Range **presets** (24h/7D/30D/Season) remain.
- **Accessibility fallback:** `+`/`−` zoom buttons and keyboard (arrow keys pan, `+`/`−` zoom). Honor `prefers-reduced-motion`.

### Shared chart-interaction approach (key reuse decision)

Define one interaction contract, implemented per repo (no new shared package, no new charting library):

1. **Pure viewport reducer** — state `{ from, to }` with actions `zoomAt(timeAnchor, factor)`, `pan(deltaMs)`, `reset()`, `setRange(preset)`. No DOM; fully unit-testable. osi-os already has `useTimeViewport` to formalize; osi-server gets the same module.
2. **Pointer adapter** — a thin layer mapping wheel/drag/hover/dblclick to reducer actions. It sits **beside** osi-os's existing touch adapter so mobile gestures are untouched. osi-server adds the same adapter (it has no touch adapter to preserve).
3. **Rendering** — keep Recharts in both repos plus a custom overview strip. Carry over osi-os's existing performance patterns (numeric-time series, dots/animation off, memoized rows, commit-on-release viewport updates) into the mouse adapter.

### Retiring the old desktop shell

- osi-os: replace the legacy workspace `HistoryDesktopShell` with the focused+Compare model.
- osi-server: refactor its existing `HistoryDesktopShell`/`TimelineBrush` toward the same focused+Compare model and the shared viewport reducer, reusing `TimelineBrush` as the overview strip where it fits.

## Testing strategy

- **Unit:** viewport reducer (zoom-anchor math, pan clamping at data bounds, reset, preset switch) in both repos; mirror tests (depth-label helper, calendar month helper, "Soil Moisture" title, SWR minute-key stability).
- **Component (RTL):** left-rail navigation, Compare toggle (2–4 card grid, shared window), keyboard/`+`/`−` fallback. Keep Recharts render assertions light (osi-os already exports pure label helpers for this reason).
- **Live:** osi-os verified on kaba100 — desktop browser checks plus a mobile-gesture regression pass to prove the touch surface is intact. osi-server via its gradle backend suite (no expected change) and frontend unit suite.

## Rollout and flags

- osi-server history is already feature-flag gated; desktop is responsive **inside** the existing flag — no new flag.
- osi-os adds no new flag; desktop is a responsive breakpoint.
- Both workstreams stay on the current `feat/history-data-visualization` branch in each repo.

## Constraints and non-goals

- Do not replace `/data/db/farming.db` on live Pis.
- osi-os edits under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` must be mirrored to `bcm2709` and pass `scripts/verify-profile-parity.js`.
- Keep farmer-facing UI free of raw DevEUI / `swt_*` / channel IDs outside Advanced View.
- **Non-goals this round:** saved workspaces / cross-zone comparison in osi-os; porting edge perf fixes to the cloud backend; any new charting library; mobile redesign changes.

## Open items to resolve during planning

- Exact desktop breakpoint value and where it is detected (shared hook vs. CSS).
- Whether osi-server's `TimelineBrush` is reused as the overview strip or replaced for parity with osi-os.
- Precise osi-server locale file set for the "Soil Moisture" rename (match the 7 locales osi-os updated).
