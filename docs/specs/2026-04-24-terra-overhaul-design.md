# Terra Intelligence Overhaul — Design Spec

Date: 2026-04-24
Status: Approved for planning

## Scope

Full structural overhaul of the Terra Intelligence frontend (`osi-server/prediction_animation_v2`) and targeted surgical fixes to the prediction backend (`osi-server/backend`). Addresses all 8 open Terra issues on `osi-server` (#8–#15), three major backend defects, and integrates five GUI enhancements (B1/B2/C1/C2/E1).

### In scope
- `osi-server/prediction_animation_v2` — full component extraction from `App.tsx`, CSS grid layout model, mobile layout, test harness
- `osi-server/backend` — three surgical Java fixes in `PredictionFieldStateService` and `PredictionRunService`
- `osi-server/frontend` — `PredictionCard.tsx` launch link update (returnUrl, #14)
- GUI enhancements: B1/B2 (forecast rail), C1/C2 (sensor anchor Mapbox layers), E1 (depth layer indicator)

### Out of scope
- `osi-server#9` (saved zone restoration) — closed as by-design. Demo-first launch contract is kept. `writeLiveConfig()` remains dead code.
- `osi-server#16` / `osi-server#17` — native Android/iOS wrappers. Deferred until the web app is stable.
- `osi-os` codebase — no changes.

---

## Launch contract (Bundle A)

The existing launch contract is preserved:
- Direct `/terra-intelligence` → demo mode always
- `/terra-intelligence?zoneId=<id>` → live mode, zone bound to that ID for the session

### Back navigation (#14)
`PredictionCard.tsx` appends `&returnUrl=<encoded-path>` to the Terra launch URL:
```
/terra-intelligence?zoneId=42&returnUrl=%2Fdashboard
```
`FieldScene` renders a back button (top-left, adjacent to brand HUD) when `window.location.search` contains `returnUrl`. Clicking navigates to the decoded URL. No `returnUrl` parameter → no button rendered. Demo mode always has no back button.

---

## Component architecture

`App.tsx` (currently 2259 lines) is split into focused files. The new structure:

```
prediction_animation_v2/src/
├── App.tsx                          # ~150 lines: entry mode, context provider, scene router
├── moistureModel.ts                 # unchanged + computeDemoDays() for B1/B2
├── terraLive.ts                     # unchanged + optional onAuthExpired callback
│
├── context/
│   └── TerraContext.tsx             # read-only shared state: dataMode, liveConfig, mode
│
├── hooks/
│   ├── useLiveData.ts               # all async live state + AbortController (Bundle E)
│   ├── useMapbox.ts                 # map init, all layer effects, draw map events
│   └── useDraw.ts                   # drawingMode, draftVertices, cursorVertex
│
├── components/
│   ├── FieldScene.tsx               # map stage + all field-mode overlays
│   ├── ProfileView.tsx              # soil profile section
│   ├── SensorAnchorPanel.tsx        # collapsible anchor editor (fixes #12, #13)
│   ├── DepthLayerIndicator.tsx      # E1: interactive depth thumbnail
│   ├── ForecastRail.tsx             # extracted + B1/B2 segmented stress track
│   ├── ToolBar.tsx                  # tool stack buttons
│   ├── FieldIntelligencePanel.tsx   # bottom-right recommendation card
│   └── Icon.tsx                     # all SVG icons
│
└── __tests__/
    ├── moistureModel.test.ts
    ├── terraLive.test.ts
    ├── useLiveData.test.ts
    └── interactions/
        ├── startupMode.test.tsx
        ├── drawClose.test.tsx
        ├── saveFlow.test.tsx
        ├── anchorPanel.test.tsx
        └── backButton.test.tsx
```

### State ownership

| State group | Owner |
|---|---|
| `mode` (field/diving/profile) | `App.tsx` |
| `dataMode`, `liveConfig` | `App.tsx` → `TerraContext` |
| catalog, fieldState, sensorAnchors, loading, errors | `useLiveData` |
| map ref, layer sources | `useMapbox` |
| drawingMode, draftVertices, cursorVertex | `useDraw` |
| forecastHour, selectedPoint, liveDepthView | `App.tsx` (passed as props) |
| demoSelection, liveSelectionDraft | `App.tsx` (passed as props) |

`TerraContext` exposes `dataMode`, `liveConfig`, and `mode` as read-only values. It does not carry actions or mutable state — actions are passed as explicit props to the components that need them. This keeps component test setup simple.

---

## Bug fixes

### Bundle B — Geometry editing (#10, #11)

**Problem:** Drawing and saving are a single implicit flow. `finalizePolygon()` calls `saveFieldGeometry()` directly, then `refreshLiveData()`. A post-save refresh error appears as a save failure. Polygon close relies on a fragile pixel-proximity check against the first point.

**Fix:**

`useDraw` manages the local polygon state only. `finalizePolygon()` closes the polygon in local state and exits draw mode — no backend call.

A separate "Save field" button in `FieldScene` calls `handleSaveFieldGeometry()`. This button is enabled when a finalized local polygon exists in `useDraw` state that has not yet been persisted to the backend (tracked as a `pendingSave: boolean` flag set by `finalizePolygon` and cleared on successful save).

Post-save flow:
1. `saveFieldGeometry()` → backend PATCH
2. On success: update `fieldGeometry` state, show inline "Saved" acknowledgment for 2 seconds
3. Then: call `refreshLiveData()` — any error from this step is shown as a separate non-blocking warning: "Field saved. Live state is refreshing." — not as a save failure

Polygon close (#11): when `draftVertices.length >= 3`, a **"Close polygon"** button appears in the draw hint overlay. Clicking it calls `finalizePolygon(draftVertices)`. The pixel-proximity close gesture is kept as an additional shortcut but is no longer the primary close mechanism.

### Bundle C — Panel collisions and anchor dismissal (#12, #13)

**Problem:** `SensorAnchorPanel` is always visible in live mode when launch config exists. The draw tool and anchor panel are placed independently with no mutual exclusion. The panel has no dismiss control.

**Fix:**

`SensorAnchorPanel` is a proper controlled component: `<SensorAnchorPanel open={anchorPanelOpen} onClose={() => setAnchorPanelOpen(false)} ... />`.

`anchorPanelOpen` starts as `false`. It opens explicitly when the user clicks the anchor sensor icon button in `ToolBar` (a new button added between the draw and water buttons, using a pin/marker icon). It also opens automatically when `activeAnchorKey` is set. It has a close (×) button in its header — always rendered, always operable (#13).

Draw mode and anchor panel are mutually exclusive: entering `drawingMode` closes the anchor panel; opening the anchor panel exits `drawingMode`. Both are enforced in `App.tsx` via the respective set-state calls.

### Bundle E — Live data orchestration (#8 partial)

**Problem:** `refreshLiveData()` has no request cancellation. Multiple overlapping refreshes can overwrite newer state with older responses. A successful sub-request (e.g. fieldState) clears errors from a failed sub-request (e.g. catalog) in the same cycle.

**Fix — `useLiveData`:**

```typescript
// Simplified interface
type LiveDataState = {
  catalog: PredictionCatalogResponse | null;
  fieldGeometry: FieldGeometryResponse | null;
  fieldState: FieldStateResponse | null;
  sensorAnchorInventory: SensorAnchorsResponse | null;
  loading: boolean;
  catalogError: string | null;
  stateError: string | null;
  anchorError: string | null;
  refresh: (config: LiveBootstrapConfig) => Promise<void>;
};
```

Each call to `refresh()` increments a request version counter and creates a new `AbortController`. The previous controller is aborted before the new fetch begins. Responses check whether their version matches the current counter before updating state — older responses are discarded silently.

Errors are tracked per-sub-request. A successful `fieldState` fetch does not clear `catalogError`. Each error field is only cleared when its own request succeeds.

`terraLive.ts` `fetchJson` accepts an optional `signal: AbortSignal` parameter. All fetch calls inside `useLiveData.refresh()` pass the abort signal.

**Auth expiry:** `terraLive.ts` accepts an optional `onAuthExpired?: () => void` callback. When any fetch returns HTTP 401, the callback is invoked. In standalone Terra mode the callback is not provided and auth expiry renders an error message. When Terra is embedded in the main frontend (future), the callback can trigger the shared logout flow.

---

## Backend fixes (Bundle F)

All three fixes are in `osi-server/backend`. No API contract changes.

### Fix 1 — `PredictionFieldStateService`: artifact-first serving

**Problem:** Catalog lookup happens before the stored Track A artifact check. A catalog outage causes Terra live mode to fail even when a renderable artifact already exists.

**Fix:** Reorder the method to check for a stored, renderable Track A artifact first. If one exists and the request does not explicitly force recompute, serve it immediately without touching the catalog. The catalog is only fetched when a fresh recompute is required.

### Fix 2 — `PredictionFieldStateService`: restore fallback logging

**Problem:** Both the live Track A path and the diagnostic fallback path contain `catch (Exception ignored)` blocks, removing all server-side evidence of live-state failures.

**Fix:** Replace both `catch (Exception ignored)` blocks with `log.error("...", e)`. No behaviour change — errors are still caught and handled as before, but now logged at ERROR level with the full exception.

### Fix 3 — `PredictionRunService`: stale-run completion guard

**Problem:** `completeRun()` marks a run `SUCCEEDED` without verifying it is still the active run for its zone. A long-running thread can resurrect a stale run after a newer replacement has already started.

**Fix:** In `completeRun()`, add a guard before the status update: query whether the run being completed is still the current (non-superseded) active run for its zone. If a newer run exists, log a warning and return without updating the stale run's status.

---

## CSS layout model and mobile (#15)

### Desktop layout

`.field-scene` is `position: relative` and uses CSS named grid for overlay component positioning. The map container is `position: absolute; inset: 0; z-index: 0` — it fills the scene behind all grid children.

```css
.field-scene {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr auto;
  grid-template-rows: auto 1fr auto auto;
  grid-template-areas:
    "brand-hud  .  depth-ind"
    "tool-bar   .  ."
    "tool-bar   .  intel-panel"
    "status-bar .  intel-panel";
}
.forecast-rail { grid-column: 1 / -1; }
.map-host { position: absolute; inset: 0; z-index: 0; }
```

Overlay grid children use `grid-area` names and `z-index > 0` to sit above the map. Field hints and draw hints remain `position: absolute` within `FieldScene` — they are contextual pop-ups, not persistent layout members. The tool bar is `position: absolute; left: 12px; top: 50%; transform: translateY(-50%)` on desktop (unchanged from current behaviour — it is a floating side column, not a flow element).

### Mobile breakpoint (< 640px)

On mobile the persistent overlay panels restack below the map. The tool bar stays absolutely positioned at the left edge (unchanged).

```css
@media (max-width: 639px) {
  .field-scene {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr auto auto auto;
    grid-template-areas:
      "brand-hud"
      "."
      "intel-panel"
      "depth-ind"
      "status-bar";
  }
}
```

`SensorAnchorPanel` renders as a bottom sheet on mobile (slides up from bottom edge, 80vh max height, scrollable). On desktop it remains a floating panel anchored to the right edge of `FieldScene`.

`ProfileView` stacks vertically on mobile: crop selector above, soil profile below, metrics in a 2-column grid at the bottom.

---

## GUI enhancements

### B1/B2 — Forecast rail segmented stress track

**`moistureModel.ts`** adds:
```typescript
export type DemoDay = { demandMm: number; stressClass: 'none' | 'mild' | 'moderate' | 'severe' };
export function computeDemoDays(cropId: CropId, stageId: PhenologyStageId, cultivarCode: string | null): DemoDay[];
```
Implementation: calls `getProfileMetrics` at `hour = day * 24 + 12` for days 0–6. Stress class derived from moisture: `< 0.25 → severe`, `< 0.45 → moderate`, `< 0.65 → mild`, else `none`.

**`App.tsx`** computes `railDays: DaySummary[]`:
- Live mode: mapped from `fieldState.aggregatedDays` (`irrigationDemandMm`, `stressClass`)
- Demo mode: from `computeDemoDays(selectedCropId, selectedStageId, cultivarCode)`
- While live is loading: falls back to demo days (no blank state)

**`ForecastRail`** receives `days: DaySummary[]` and `currentHour: number`. Renders 7 colour segments between the readout and the slider. Segment colours: `none → #3ed36f`, `mild → #fbbf24`, `moderate → #f97316`, `severe → #ef3b2d` at 55–90% opacity. The segment containing `Math.floor(currentHour / 24)` gets a white 1px inner border. Current day demand mm is appended to the readout: `"Day +1 · 4.2 mm"`.

### C1 — Anchor dot status colouring

`buildSensorAnchorDots` adds `status` and `eligibleForPrediction` to each GeoJSON feature's properties.

`ensureSensorAnchorLayers` replaces the static `circle-color` with a Mapbox `match` expression:
```
['match', ['get', 'status'],
  'valid',              '#3ed36f',
  'missing_depth',      '#fbbf24',
  'device_unassigned',  '#94a3b8',
  'inactive',           '#94a3b8',
  'outside_field',      '#ef3b2d',
  '#94a3b8'
]
```
The active (selected) anchor retains its existing white stroke ring.

### C2 — Observation freshness ring

A new `SENSOR_FRESHNESS_LAYER_ID` Mapbox circle layer sits below the main anchor dot layer. Each anchor feature gets a `freshnessScore` property (0–1):
- Computed by finding the nearest `spatialUnit` by lat/lng euclidean distance using the existing `fieldState.sampledPoints` → `spatialUnit` mapping
- `observationFreshnessHours` from `spatialDayStateForHour(unit.days, forecastHour)` for the current hour
- Score: `clamp(1 - freshnessHours / 48, 0, 1)` — 1 = ≤0h (fully fresh), 0 = ≥48h (fully stale)
- When no spatial unit within 0.005° lat/lng: `freshnessScore = 0`

Layer paint: `circle-radius: 10 + (1 - freshnessScore) * 8`, `circle-opacity: freshnessScore * 0.35`, `circle-color: '#3ed36f'`. Live mode only — layer visibility set to `none` in demo mode.

### E1 — Depth layer indicator (replaces dropdown)

`DepthLayerIndicator` is a new component rendered in `FieldScene`. Visible only when `dataMode === 'live' && liveConfigured`.

Renders 4 clickable bands stacked vertically (Root zone / Top / Middle / Deep). Active band is highlighted with `#3ed36f` background. Each band:
- Shows its name and approximate depth range
- Fires `onDepthChange(LiveDepthView)` on click
- Root zone depth hint uses `cropScenario.rootZoneCm` (e.g. "0–45 cm")
- Top/Middle/Deep show static hints: "0–15 cm", "15–40 cm", "40–100 cm"

The `<label>` for overlay depth is removed from the `SensorAnchorPanel`. The `<select>` for `liveDepthView` is removed entirely.

---

## Testing strategy

### Test harness setup
- Vitest + React Testing Library added to `prediction_animation_v2`
- Mapbox GL mocked at module level (`vi.mock('mapbox-gl', ...)`)
- `fetch` mocked via `vi.stubGlobal('fetch', ...)`
- Test files in `src/__tests__/`

### Unit tests

**`moistureModel.test.ts`**
- `computeDemoDays` returns 7 items, each with valid `demandMm ≥ 0` and a valid `stressClass`
- `moistureColor` returns a hex string for values 0, 0.5, 1
- `waterStatus` maps 0 → `'dry'`, 0.5 → `'balanced'`, 1 → `'wet'`
- `buildFieldCells` returns `GRID_COLUMNS * GRID_ROWS` cells

**`terraLive.test.ts`**
- `dayStateForHour` interpolates correctly between two days
- `spatialDayStateForHour` interpolates layerStates per depth
- `hasRenderableLiveSpatialHour` returns false when `liveSpatialStatus !== 'available'`
- `nearestSampleToNormalizedPoint` returns the closest sample
- `buildLiveFieldCells` returns empty array when no renderable spatial hour

**`useLiveData.test.ts`**
- Abort: two rapid `refresh()` calls → first is aborted, only second's state is applied
- Version guard: stale response arriving after a newer refresh → state not updated
- Partial failure: `catalog` 500, `fieldState` 200 → `catalogError` set, `stateError` null, `fieldState` populated
- Auth expiry: any fetch returning 401 → `onAuthExpired` callback invoked

### Interaction tests

**`startupMode.test.tsx`** — `readEntryMode()` with `?zoneId=42` → `'live'`; without → `'demo'`

**`drawClose.test.tsx`** — place 3 vertices → "Close polygon" button appears → click → draw mode exits, polygon local state set, no fetch called

**`saveFlow.test.tsx`** — geometry save success → "Saved" acknowledgment shown → refresh called → refresh error shown as warning, not as save error

**`anchorPanel.test.tsx`** — open anchor panel → click draw tool → panel closes; open panel with no sensors → close (×) button present and functional

**`backButton.test.tsx`** — `?returnUrl=%2Fdashboard` → back button rendered, href = `/dashboard`; no `returnUrl` → no back button

### Backend tests

**`PredictionFieldStateServiceTest`** — add: catalog fetch throws, stored artifact present → method returns artifact without re-throwing

**`PredictionRunServiceTest`** — add: `completeRun()` called for a run that has been superseded by a newer run → run status not updated to SUCCEEDED, warning logged

---

## Build sequencing

Each step is independently verifiable before the next starts.

| Step | Repo | What | Verification |
|---|---|---|---|
| 1 | osi-server/prediction_animation_v2 | Add Vitest + RTL, write unit tests for existing pure functions (no code changes) | `npm test` passes |
| 2 | osi-server/backend | Three Bundle F Java fixes + new backend test cases | `./gradlew test` passes |
| 3 | osi-server/prediction_animation_v2 | Extract `useLiveData` with AbortController + version guard | Unit tests pass; no visual change |
| 4 | osi-server/prediction_animation_v2 | Extract `useDraw` and `useMapbox` | No visual change |
| 5 | osi-server/prediction_animation_v2 | Bundle B fix: decouple draw from save, add Close polygon button | `saveFlow.test`, `drawClose.test` pass |
| 6 | osi-server/prediction_animation_v2 | Extract all components, add `TerraContext`, `App.tsx` → ~150 lines | Build passes, visual parity with before |
| 7 | osi-server/prediction_animation_v2 | CSS grid layout model, `SensorAnchorPanel` open/close, mobile breakpoint | `anchorPanel.test` passes; visual review on desktop + 375px |
| 8 | osi-server/prediction_animation_v2 | GUI enhancements: B1/B2 (`computeDemoDays`, `ForecastRail`), C1/C2 (Mapbox layers), E1 (`DepthLayerIndicator`) | Visual review; unit tests for `computeDemoDays` |
| 9 | osi-server/frontend | `PredictionCard.tsx`: append `returnUrl` to Terra launch link | `backButton.test` passes |
| 10 | osi-server/prediction_animation_v2 | Interaction tests for startup mode, draw, save, anchor panel, back button | All interaction tests pass |

---

## Regression risk and mitigations

| Risk | Mitigation |
|---|---|
| Component extraction breaks state flow | Step 3–4 extract hooks first (no visual change), step 6 extracts components against already-stable hooks |
| CSS grid breaks existing overlay positions | Step 7 done after components are stable; visual review at desktop + mobile viewport |
| `useLiveData` abort logic discards valid responses | Version counter unit test covers rapid successive calls |
| Backend fix 1 changes serving order | New test case covers catalog-fail / artifact-present path before fix ships |
| `PredictionRunService` guard introduces false discards | New test case verifies the guard only fires when a newer run actually exists |
| Mapbox layer changes (C1/C2) break existing anchor rendering | C1/C2 are additive: the existing layer gets a paint expression update; the freshness layer is new beneath it |

---

## Minor hygiene (included in step 6)

- `.gitignore`: replace `prediction_animation/` with `prediction_animation_v2/`
- Forecast rail `onWheel`: replace the JSX `onWheel` prop with a `useRef` + `useEffect` that attaches `addEventListener('wheel', handler, { passive: false })` directly on the rail element — JSX synthetic events cannot opt out of passive mode, which causes `preventDefault()` to be ignored in some browsers, letting page scroll compete with the hour scrubber
