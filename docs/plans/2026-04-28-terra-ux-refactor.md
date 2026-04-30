# Terra UX Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the Terra field-view UX: remove the "Concept forecast" intelligence panel, make the prediction grid always visible, replace the three data-related tool buttons with a single "Data" button and a dedicated two-step "Soil profile" button, and introduce mode-aware hint boxes that gate cell interaction.

**Architecture:** A named `CellInteractionMode = 'none' | 'data' | 'profile'` state replaces the field-view data booleans (`gridEnabled`, `demandEnabled`, `valuesEnabled`). The prediction grid layer is always visible when the water overlay is renderable; the Data button is a simple toggle that shows demand/VWC/kPa together, not a cycle button or menu. Clicking a field cell only acts if a mode is active — data mode updates the selected point and Data strip; profile mode dives into the soil profile. Both modes display a `.draw-hint` hint box until the user taps a cell.

**Tech Stack:** React 18, TypeScript, plain CSS — all within `terra-intelligence/`.

**Working directory for all commands:** `/home/phil/Repos/osi-server/.worktrees/terra-mobile-fixes/terra-intelligence/`

**Coordination note:** Execute `2026-04-28-terra-kpa-vwc-alignment.md` first. This UX refactor consumes the final physics values via `profileMetrics.rootVwcPct` and `profileMetrics.matrixPotentialKpa`, replacing the legacy per-cell VWC strip.

---

## Code Quality Guidelines

- **TypeScript strict** — no `any`; use `CellInteractionMode` as the named type everywhere; `noUnusedLocals` will catch removed states left behind
- **Named type over string literals** — `CellInteractionMode = 'none' | 'data' | 'profile'` is declared once; do not scatter `'none' | 'data' | 'profile'` inline across JSX props
- **State consistency** — a single `cellInteractionMode` state replaces three booleans; never re-introduce parallel booleans to work around it
- **One commit per task** — use the commit messages shown in each step; they follow Conventional Commits (`refactor(terra):`, `feat(terra):`, `fix(terra):`, `test(terra):`)
- **TDD** — write the failing test, confirm it fails, implement, confirm it passes; keep test and implementation commits paired

## Design Principles

- **Mutual exclusivity by construction** — a single string state (`cellInteractionMode`) enforces that data and profile modes cannot both be active; three booleans cannot enforce this
- **YAGNI** — the Data button is a simple toggle; it is not a cycle button, dropdown, or menu; do not add animation, transitions, or a popover
- **Single responsibility** — the click handler branches on `cellInteractionMode` only; it does not also toggle UI state; UI state is owned by the button handlers
- **Remove without replacement** — `gridEnabled`, `demandEnabled`, `valuesEnabled`, `WATER_STATUS_LEGEND`, and `.field-intelligence-panel` are fully deleted; no deprecated aliases or feature flags

---

## File Map

| File | Action | Summary |
|------|--------|---------|
| `src/App.tsx` | Modify | Remove `field-intelligence-panel` JSX + `WATER_STATUS_LEGEND`; remove `gridEnabled`, `demandEnabled`, `valuesEnabled` states; add `cellInteractionMode`; replace three tool buttons with Data button; change profile button to mode toggle; add hint boxes; update click handler; update layer visibility |
| `src/styles.css` | Modify | Remove `.field-intelligence-panel`, `.water-status-legend`, `.field-recommendation-card` rules (desktop + mobile); recalculate mobile stack variables; update 400px tool-stack to 2×2; update 760px tool-stack to `repeat(4, 44px)` |
| `src/__tests__/mobileControls.test.tsx` | Modify | Keep profile demand-callout regressions; update profile-opening helper for two-step profile mode; add data-mode strip and hint tests |
| `src/__tests__/mobileCss.test.ts` | Modify | Remove `.field-intelligence-panel` expectations; add mobile stack and 4-button tool-stack assertions |

---

## Phase 1: Remove Old Features
*Tasks 1–2 — delete `field-intelligence-panel`, `WATER_STATUS_LEGEND`, `gridEnabled`, and the grid tool button; verify nothing breaks*

---

## Task 1: Remove the field-intelligence-panel

**Files:**
- Modify: `terra-intelligence/src/App.tsx`
- Modify: `terra-intelligence/src/styles.css`

The `<aside class="field-intelligence-panel">` always renders and contains two children: `water-status-legend` and `field-recommendation-card`. Both go away entirely. The `WATER_STATUS_LEGEND` constant at line 162 is only used in this element — remove it too.

- [ ] **Step 1: Remove the JSX block**

Find and delete the entire `<aside className="field-intelligence-panel" ...>` block (currently lines 2099–2118). It looks like:

```tsx
        <aside className="field-intelligence-panel" aria-label="Agronomic field interpretation" onPointerEnter={handleFieldUiPointerEnter}>
          <div className="water-status-legend" aria-label="Water status legend">
            {WATER_STATUS_LEGEND.map((item) => (
              <span key={item.status}>
                <i style={{ '--status-color': item.color } as CSSProperties} aria-hidden="true" />
                {item.label}
              </span>
            ))}
          </div>
          <div className="field-recommendation-card" aria-label="Crop-aware irrigation recommendation">
            <span>{dataMode === 'live' ? 'Field-wide action' : `${profileMetrics.cropName} root-zone demand`}</span>
            <strong>{dataMode === 'live' && liveSpatialUnavailable ? 'Unavailable' : `${profileMetrics.irrigationDemandMm.toFixed(1)} mm`}</strong>
            <small>
              {dataMode === 'live' && liveSpatialUnavailable
                ? (liveSpatialNotice ?? 'Live spatial data unavailable')
                : `${profileMetrics.rootVwcPct.toFixed(1)}% VWC | ${profileMetrics.matrixPotentialKpa.toFixed(0)} kPa | ${profileMetrics.cropName}, ${profileMetrics.developmentStage}`}
            </small>
            <em>{dataMode === 'live' ? (fieldState?.status.message ?? 'Live advisor') : 'Concept forecast'}</em>
          </div>
        </aside>
```

Delete all of the above.

- [ ] **Step 2: Remove the `WATER_STATUS_LEGEND` constant**

Find and delete lines 162–167:
```typescript
const WATER_STATUS_LEGEND: Array<{ status: WaterStatus; label: string; color: string }> = [
  { status: 'dry', label: 'Dry', color: '#ef3b2d' },
  { status: 'deficit', label: 'Deficit', color: '#f29d28' },
  { status: 'balanced', label: 'Balanced', color: '#3ed36f' },
  { status: 'wet', label: 'Wet', color: '#2f8fff' },
];
```

- [ ] **Step 3: Remove unused `WaterStatus` import from moistureModel (if now unreferenced)**

Run TypeScript to check:
```bash
cd terra-intelligence && npx tsc --noEmit 2>&1 | grep "WaterStatus\|unused"
```
If `WaterStatus` is flagged as unused, remove it from the import line at the top of `App.tsx`.

- [ ] **Step 4: Remove CSS rules**

In `src/styles.css`, find and delete the following rule blocks completely. Search for each class name and delete its entire rule (opening brace to closing brace):

Delete:
```css
.field-intelligence-panel { ... }
.water-status-legend,
.field-recommendation-card { ... }
.water-status-legend { ... }
.water-status-legend span { ... }
.water-status-legend i { ... }
.field-recommendation-card { ... }
.field-recommendation-card span,
.field-recommendation-card small,
.field-recommendation-card em { ... }
.field-recommendation-card strong { ... }
.is-drawing .field-intelligence-panel { ... }
```

Also inside the `@media (max-width: 760px)` block, find and delete any rules that reference `.field-intelligence-panel` (there is one at approximately line 1912 that sets `bottom`, `right`, `left`, `width`, and `user-select`).

- [ ] **Step 5: Remove "Concept forecast" span from `field-value-strip`**

Find the last `<span>` inside the `field-value-strip` div:

```tsx
          <span>{dataMode === 'live' ? 'Sampled live field state' : 'Concept forecast'}</span>
```

Delete it.

- [ ] **Step 6: Verify TypeScript compiles and tests pass**

```bash
cd terra-intelligence && npx tsc --noEmit && npm test
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add terra-intelligence/src/App.tsx terra-intelligence/src/styles.css
git commit -m "refactor(terra): remove field-intelligence-panel and Concept forecast"
```

---

## Task 2: Make prediction grid always on — remove grid button and state

**Files:**
- Modify: `terra-intelligence/src/App.tsx`

The grid (`.field-intelligence-panel` is gone; the Mapbox line layer `MOISTURE_GRID_LAYER_ID`) was gated by `gridEnabled`. Now it's always active when the water layer is renderable. Remove the `gridEnabled` state variable and all references.

- [ ] **Step 1: Remove `gridEnabled` state declaration**

Find and delete:
```typescript
  const [gridEnabled, setGridEnabled] = useState(false);
```

- [ ] **Step 2: Update layer visibility call**

Find (in the `useEffect` that calls `setLayerVisibility`):
```typescript
    setLayerVisibility(map, MOISTURE_GRID_LAYER_ID, visible && gridEnabled && canRenderLiveOverlay);
```

Replace with:
```typescript
    setLayerVisibility(map, MOISTURE_GRID_LAYER_ID, visible && canRenderLiveOverlay);
```

- [ ] **Step 3: Update the dependency array of that useEffect**

Remove `gridEnabled` from the dependency array:

```typescript
  }, [activeAnchorKey, activeFieldPolygon, canRenderLiveOverlay, dataMode, fieldCells, liveFieldGeometry?.updatedAt, gridEnabled, mapReady, sensorAnchorDraft, waterEnabled]);
```

→

```typescript
  }, [activeAnchorKey, activeFieldPolygon, canRenderLiveOverlay, dataMode, fieldCells, liveFieldGeometry?.updatedAt, mapReady, sensorAnchorDraft, waterEnabled]);
```

- [ ] **Step 4: Remove the grid ToolButton**

Find and delete:
```tsx
          <ToolButton label="Prediction grid" icon="grid" active={gridEnabled} disabled={!canUseField || !canRenderLiveOverlay} onClick={() => setGridEnabled((value) => !value)} />
```

- [ ] **Step 5: Remove `setGridEnabled(false)` from `finalizePolygon` callback**

Find (in the `finalizePolygon` useCallback):
```typescript
    setGridEnabled(false);
```
Delete it.

- [ ] **Step 6: Remove the gridEnabled span from `field-value-strip`**

Find and delete:
```tsx
          {gridEnabled && <span>Prediction grid | {GRID_COLUMNS} x {GRID_ROWS} zones</span>}
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd terra-intelligence && npx tsc --noEmit
```

Expected: no errors (TypeScript `noUnusedLocals` will catch any remaining reference).

- [ ] **Step 8: Commit**

```bash
git add terra-intelligence/src/App.tsx
git commit -m "refactor(terra): prediction grid always on, remove grid button and state"
```

### Phase 1 Review Checkpoint

```bash
cd terra-intelligence && npx tsc --noEmit && npm test
```

No TypeScript errors. All existing tests pass. The grid still renders on the map (verify by eye if possible). Only then proceed to Phase 2.

---

## Phase 2: New Interaction Model
*Tasks 3–4 — introduce `cellInteractionMode`, Data button, profile mode toggle, and hint boxes*

---

## Task 3: Add `cellInteractionMode` — replace demand + values buttons with Data button

**Files:**
- Modify: `terra-intelligence/src/App.tsx`

Introduce a named `CellInteractionMode` state that replaces the two removed boolean states. Add a "Data" tool button. Simplify `field-value-strip` to show demand + VWC + kPa only when data mode is active. This button is a toggle-all control, not a cycle button and not a menu.

- [ ] **Step 1: Add `CellInteractionMode` type, add state, and remove old states**

Near the existing top-level type aliases in `src/App.tsx`, add:

```typescript
type CellInteractionMode = 'none' | 'data' | 'profile';
```

Find and delete:
```typescript
  const [demandEnabled, setDemandEnabled] = useState(false);
```
and:
```typescript
  const [valuesEnabled, setValuesEnabled] = useState(false);
```

Insert in their place:
```typescript
  const [cellInteractionMode, setCellInteractionMode] = useState<CellInteractionMode>('none');
```

- [ ] **Step 2: Add Data tool button, remove old demand and values buttons**

Find and delete the two old buttons:
```tsx
          <ToolButton label="Irrigation demand" icon="demand" active={demandEnabled} disabled={!canUseField} onClick={() => setDemandEnabled((value) => !value)} />
          <ToolButton label="Values" icon="values" active={valuesEnabled} disabled={!canUseField} onClick={() => setValuesEnabled((value) => !value)} />
```

Replace with a single Data button inserted before the Soil profile button:
```tsx
          <ToolButton label="Data" icon="values" active={cellInteractionMode === 'data'} disabled={!canUseField} onClick={() => setCellInteractionMode((m) => m === 'data' ? 'none' : 'data')} />
```

The full button order is now: Draw, Water, Data, Soil profile.

- [ ] **Step 3: Update `field-value-strip` visibility and content**

Find the current strip div and its contents:
```tsx
        <div className={`field-value-strip${valuesEnabled || demandEnabled || gridEnabled ? ' is-visible' : ''}`} aria-live="polite" onPointerEnter={handleFieldUiPointerEnter}>
          {gridEnabled && <span>Prediction grid | {GRID_COLUMNS} x {GRID_ROWS} zones</span>}
          {valuesEnabled && <span>{dataMode === 'live' && liveSpatialUnavailable ? 'Live spatial unavailable' : `Cell VWC ${Math.round(14 + selectedMoisture * 29)}%`}</span>}
          {demandEnabled && <span>{dataMode === 'live' && liveSpatialUnavailable ? 'No live spatial demand' : `Irrigation demand ${profileMetrics.irrigationDemandMm.toFixed(1)} mm`}</span>}
        </div>
```

Replace with:
```tsx
        <div className={`field-value-strip${cellInteractionMode === 'data' ? ' is-visible' : ''}`} aria-live="polite" onPointerEnter={handleFieldUiPointerEnter}>
          {cellInteractionMode === 'data' && (
            <>
              <span>{dataMode === 'live' && liveSpatialUnavailable ? 'Live spatial unavailable' : `${profileMetrics.irrigationDemandMm.toFixed(1)} mm demand`}</span>
              <span>{dataMode === 'live' && liveSpatialUnavailable ? '–' : `${profileMetrics.rootVwcPct.toFixed(1)}% VWC`}</span>
              <span>{dataMode === 'live' && liveSpatialUnavailable ? '–' : `${profileMetrics.matrixPotentialKpa.toFixed(0)} kPa`}</span>
            </>
          )}
        </div>
```

- [ ] **Step 4: Reset `cellInteractionMode` when drawing starts and when polygon finalization finishes**

Find `handleDrawToggle` (search for `handleDrawToggle`). Inside it, where drawing mode is being activated, add:
```typescript
    setCellInteractionMode('none');
```

Find `finalizePolygon`. In both the live-save success path and the demo path, add:

```typescript
        setCellInteractionMode('none');
```

For the live-save success path, place it next to `setMode('field')`. For the demo path, place it next to `setMode('field')` after `setWaterEnabled(true)`. This is defensive cleanup for double-click and close-polygon paths that bypass the draw button.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd terra-intelligence && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add terra-intelligence/src/App.tsx
git commit -m "feat(terra): add cellInteractionMode, replace demand/values buttons with Data button"
```

---

## Task 4: Change soil profile button to mode toggle + add hint boxes

**Files:**
- Modify: `terra-intelligence/src/App.tsx`

The profile button no longer immediately calls `beginProfileDive`. Instead it toggles `cellInteractionMode` to `'profile'`. When either mode is active, a `.draw-hint` hint box is shown. When the user returns from the profile view, mode resets to `'none'`.

- [ ] **Step 1: Change the Soil profile ToolButton**

Find:
```tsx
          <ToolButton label="Soil profile" icon="profile" active={mode === 'profile'} disabled={!canUseField || mode !== 'field'} onClick={() => beginProfileDive(selectedPoint)} />
```

Replace with:
```tsx
          <ToolButton label="Soil profile" icon="profile" active={cellInteractionMode === 'profile'} disabled={!canUseField || mode !== 'field'} onClick={() => setCellInteractionMode((m) => m === 'profile' ? 'none' : 'profile')} />
```

- [ ] **Step 2: Reset `cellInteractionMode` and `selectedSampleId` in `handleReturnToField`**

Find `handleReturnToField` (search for the function — it calls `setMode('field')`). Add both resets:
```typescript
    setCellInteractionMode('none');
    setSelectedSampleId(null);
```
Place them immediately before or after `setMode('field')`. Clearing `selectedSampleId` prevents a stale live-data sample from being highlighted when the user returns to the field and enters a different mode.

- [ ] **Step 3: Add hint boxes**

Find the existing draw-hint block:
```tsx
        {drawingMode && (
          <div className="draw-hint" aria-live="polite" onPointerEnter={handleFieldUiPointerEnter}>
            <strong>{draftVertices.length} point{draftVertices.length === 1 ? '' : 's'}</strong>
            <span>Click the first point or press the draw button to close.</span>
          </div>
        )}
```

Add the two new hint blocks immediately after it:
```tsx
        {cellInteractionMode === 'data' && !drawingMode && (
          <div className="draw-hint" aria-live="polite" onPointerEnter={handleFieldUiPointerEnter}>
            <strong>Zone data</strong>
            <span>Tap a zone · irrigation demand, VWC and kPa for the active root zone.</span>
          </div>
        )}

        {cellInteractionMode === 'profile' && !drawingMode && (
          <div className="draw-hint" aria-live="polite" onPointerEnter={handleFieldUiPointerEnter}>
            <strong>Soil profile</strong>
            <span>Tap a zone to open the soil profile.</span>
          </div>
        )}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd terra-intelligence && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add terra-intelligence/src/App.tsx
git commit -m "feat(terra): profile button toggles mode, hint boxes guide cell interaction"
```

### Phase 2 Review Checkpoint

```bash
cd terra-intelligence && npx tsc --noEmit && npm test
```

TypeScript must compile. All tests must pass. Manually verify: clicking Data shows the strip, clicking Soil profile shows the hint box (not the profile view). Only then proceed to Phase 3.

---

## Phase 3: Integration and CSS
*Tasks 5–6 — gate cell clicks on `cellInteractionMode`; update CSS for four tool buttons*

---

## Task 5: Update the Mapbox click handler

**Files:**
- Modify: `terra-intelligence/src/App.tsx`

The click handler must now gate `beginProfileDive` behind `cellInteractionMode === 'profile'`. In data mode, it updates `selectedPoint` without diving. If `cellInteractionMode === 'none'`, cell clicks do nothing (drawing and anchor editing still work as before).

- [ ] **Step 1: Rewrite the click handler's cell interaction section**

The current handler (inside the large `useEffect` for Mapbox events) has this structure after the drawing mode and anchor editing returns:

```typescript
      const normalizedPoint = normalizedPointForLngLat(clicked, activeFieldPolygon);
      if (dataMode === 'live' && liveSpatialHourRenderable && fieldState && fieldState.sampledPoints.length > 0) {
        const nearest = nearestSampleToNormalizedPoint(normalizedPoint, fieldState.sampledPoints);
        if (nearest) {
          setSelectedSampleId(nearest.id);
          beginProfileDive({ x: nearest.normalizedX, y: nearest.normalizedY });
          return;
        }
      }

      beginProfileDive(normalizedPoint);
```

Replace those lines with:
```typescript
      const normalizedPoint = normalizedPointForLngLat(clicked, activeFieldPolygon);

      if (cellInteractionMode === 'none') {
        return;
      }

      const liveNearest = dataMode === 'live' && liveSpatialHourRenderable && fieldState && fieldState.sampledPoints.length > 0
        ? nearestSampleToNormalizedPoint(normalizedPoint, fieldState.sampledPoints)
        : null;

      if (cellInteractionMode === 'profile') {
        if (liveNearest) {
          setSelectedSampleId(liveNearest.id);
          beginProfileDive({ x: liveNearest.normalizedX, y: liveNearest.normalizedY });
        } else {
          beginProfileDive(normalizedPoint);
        }
      } else if (cellInteractionMode === 'data') {
        if (liveNearest) {
          setSelectedSampleId(liveNearest.id);
          setSelectedPoint({ x: liveNearest.normalizedX, y: liveNearest.normalizedY });
        } else {
          setSelectedSampleId(null);
          setSelectedPoint(normalizedPoint);
        }
      }
```

- [ ] **Step 2: Add `cellInteractionMode` to the dependency array of the click handler useEffect**

Find the dependency array that currently ends with:
```typescript
  }, [activeAnchorKey, activeFieldPolygon, anchorOptions, beginProfileDive, canEditAnchors, dataMode, draftVertices, drawingMode, fieldState, finalizePolygon, liveSpatialHourRenderable, mapReady, mode]);
```

Add `cellInteractionMode`, `setSelectedPoint`, and `setSelectedSampleId`:
```typescript
  }, [activeAnchorKey, activeFieldPolygon, anchorOptions, beginProfileDive, canEditAnchors, cellInteractionMode, dataMode, draftVertices, drawingMode, fieldState, finalizePolygon, liveSpatialHourRenderable, mapReady, mode, setSelectedPoint, setSelectedSampleId]);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd terra-intelligence && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add terra-intelligence/src/App.tsx
git commit -m "feat(terra): gate cell click on cellInteractionMode — data or profile only"
```

---

## Task 6: Update CSS — remove panel stack and set 4-button grid

**Files:**
- Modify: `terra-intelligence/src/styles.css`
- Modify: `terra-intelligence/src/__tests__/mobileCss.test.ts`

The tool-stack went from 6 buttons to 4, and `.field-intelligence-panel` is removed. Update the mobile stack variables and CSS tests so the Data strip and hints sit above the tool stack without reserving space for the removed panel.

- [ ] **Step 1: Update the mobile stack variables**

Find this block inside `@media (max-width: 760px)`:

```css
  :root {
    --mobile-edge-gap: 14px;
    --mobile-rail-bottom: max(14px, env(safe-area-inset-bottom));
    --mobile-rail-height: 86px;
    --mobile-tool-height: 44px;
    --mobile-tool-gap: 8px;
    --mobile-panel-gap: 10px;
    --mobile-panel-estimated-height: 150px; /* conservative estimate — strip overflows upward if panel is taller */
    --mobile-stack-base: calc(var(--mobile-rail-bottom) + var(--mobile-rail-height));
    --mobile-tool-bottom: calc(var(--mobile-stack-base) + var(--mobile-tool-gap));
    --mobile-panel-bottom: calc(var(--mobile-tool-bottom) + var(--mobile-tool-height) + var(--mobile-panel-gap));
    --mobile-strip-bottom: calc(var(--mobile-panel-bottom) + var(--mobile-panel-estimated-height) + var(--mobile-panel-gap));
  }
```

Replace it with:

```css
  :root {
    --mobile-edge-gap: 14px;
    --mobile-rail-bottom: max(14px, env(safe-area-inset-bottom));
    --mobile-rail-height: 86px;
    --mobile-tool-height: 44px;
    --mobile-tool-gap: 8px;
    --mobile-panel-gap: 10px;
    --mobile-stack-base: calc(var(--mobile-rail-bottom) + var(--mobile-rail-height));
    --mobile-tool-bottom: calc(var(--mobile-stack-base) + var(--mobile-tool-gap));
    --mobile-panel-bottom: calc(var(--mobile-tool-bottom) + var(--mobile-tool-height) + var(--mobile-panel-gap));
    --mobile-strip-bottom: var(--mobile-panel-bottom);
  }
```

The removed `--mobile-panel-estimated-height` was only needed while `.field-intelligence-panel` occupied the lower mobile stack. The Data strip now uses the same stack level that the removed panel used.

- [ ] **Step 2: Update the 760px breakpoint tool-stack**

Find in `@media (max-width: 760px)`:
```css
  .tool-stack {
    ...
    display: grid;
    grid-template-columns: repeat(6, 44px);
  }
```

Change `repeat(6, 44px)` to `repeat(4, 44px)`. Drawing mode does not hide the grid; draw layers render above the field layers, and the Draw button remains the explicit drawing control.

- [ ] **Step 3: Update the 400px breakpoint tool-stack**

Find in `@media (max-width: 400px)`:
```css
  .tool-stack {
    grid-template-columns: repeat(3, 44px);
    grid-template-rows: repeat(2, 44px);
    gap: 4px;
  }
```

Replace with:
```css
  .tool-stack {
    grid-template-columns: repeat(2, 44px);
    grid-template-rows: repeat(2, 44px);
    gap: 4px;
  }
```

Also update `--mobile-tool-height` at 400px — 2 rows of 44px + 4px gap = 92px is still correct. No change needed there.

- [ ] **Step 4: Update mobile CSS tests**

In `src/styles.css`, find the mobile `.field-value-strip` rule inside `@media (max-width: 760px)`:

```css
  .field-value-strip {
    right: var(--mobile-edge-gap);
    bottom: var(--mobile-strip-bottom);
    left: var(--mobile-edge-gap);
    max-width: none;
    transform: translateY(12px);
  }
```

Add the two user-select declarations:

```css
  .field-value-strip {
    right: var(--mobile-edge-gap);
    bottom: var(--mobile-strip-bottom);
    left: var(--mobile-edge-gap);
    max-width: none;
    user-select: none;
    -webkit-user-select: none;
    transform: translateY(12px);
  }
```

In `src/__tests__/mobileCss.test.ts`, find:

```typescript
  it('prevents text selection on non-editable mobile HUD surfaces', () => {
    ['.brand-hud', '.tool-stack', '.forecast-rail', '.field-intelligence-panel'].forEach((selector) => {
      expect(mobileRuleFor(selector)).toContain('user-select: none');
      expect(mobileRuleFor(selector)).toContain('-webkit-user-select: none');
    });
  });
```

Replace it with:

```typescript
  it('prevents text selection on non-editable mobile HUD surfaces', () => {
    ['.brand-hud', '.tool-stack', '.forecast-rail', '.field-value-strip'].forEach((selector) => {
      expect(mobileRuleFor(selector)).toContain('user-select: none');
      expect(mobileRuleFor(selector)).toContain('-webkit-user-select: none');
    });
  });
```

Add the following tests to the same `mobile control CSS` describe block:

```typescript
  it('uses a four-button mobile tool grid', () => {
    expect(mobileRuleFor('.tool-stack')).toContain('grid-template-columns: repeat(4, 44px)');
  });

  it('uses a two-by-two tool grid on very narrow phones', () => {
    const mediaStart = styles.indexOf('@media (max-width: 400px)');
    expect(mediaStart).toBeGreaterThanOrEqual(0);
    const selectorStart = styles.indexOf('.tool-stack', mediaStart);
    expect(selectorStart).toBeGreaterThanOrEqual(0);
    const blockStart = styles.indexOf('{', selectorStart);
    const blockEnd = styles.indexOf('}', blockStart);
    const rule = styles.slice(blockStart + 1, blockEnd);

    expect(rule).toContain('grid-template-columns: repeat(2, 44px)');
    expect(rule).toContain('grid-template-rows: repeat(2, 44px)');
  });

  it('does not reserve a removed field-intelligence panel height in the mobile stack', () => {
    expect(styles).not.toContain('--mobile-panel-estimated-height');
    expect(mobileRuleFor('.field-value-strip')).toContain('bottom: var(--mobile-strip-bottom)');
  });
```

- [ ] **Step 5: Run tests**

```bash
cd terra-intelligence && npm test -- src/__tests__/mobileCss.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Run the full test suite**

```bash
cd terra-intelligence && npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add terra-intelligence/src/styles.css terra-intelligence/src/__tests__/mobileCss.test.ts
git commit -m "fix(terra): update mobile stack for four tool buttons"
```

### Phase 3 Review Checkpoint

```bash
cd terra-intelligence && npx tsc --noEmit && npm test
```

All tests pass. TypeScript compiles. Then do a full manual pass across the four phases: field loads, Draw works, Data strip appears with all three values, profile mode shows hint then opens on tap, mobile tool row is four buttons. Only then proceed to Phase 4.

---

## Phase 4: Tests and Browser Verification
*Tasks 7–8 — update and extend the test suite; verify across mobile viewports*

---

## Task 7: Update tests

**Files:**
- Modify: `terra-intelligence/src/__tests__/mobileControls.test.tsx`

The old tests assumed:
1. A mobile demand toggle button inside the profile view (still exists — don't touch that)
2. Desktop shows the profile-view irrigation demand callout by default
3. Mobile toggle shows/hides the demand callout (in the profile view — still exists)

The tests that need updating are the profile-opening helper and the tests for field-view buttons that no longer exist. Keep the desktop and wide-touch profile demand-callout regressions; they protect the desktop non-regression from the previous mobile round.

Read the current test file first to understand exactly which tests are affected, then update or remove them.

- [ ] **Step 1: Identify which tests to remove**

The following test categories become stale after Tasks 1–6 and must be deleted:
- Any `it(...)` that clicks a button named `'Irrigation demand'`, `'Values'`, or `'Prediction grid'` — these buttons are removed.
- Any `it(...)` that clicks `'Soil profile'` and immediately expects `mode === 'profile'` or the profile view to open — the profile button now toggles mode, not dives.
- Any helper function that calls `beginProfileDive` directly or reaches the profile view without first enabling profile mode.

Keep:
- `'keeps the irrigation demand callout visible by default on desktop'` — targets the profile-view demand callout (not the deleted panel).
- `'keeps the desktop demand callout on wide touch devices'` — same.
- `'uses a dedicated mobile toggle for the irrigation demand callout'` — same.

Find these tests in `src/__tests__/mobileControls.test.tsx` and delete the stale ones before proceeding to Step 2.

- [ ] **Step 2: Update the profile-opening helper**

Replace the existing `openProfile()` helper with a helper that toggles profile mode and then invokes the Mapbox click handler. This reflects the new two-step profile interaction.

```typescript
function lastMapClickHandler() {
  const clickCalls = mockMapInstance.on.mock.calls.filter(([event]) => event === 'click');
  const handler = clickCalls[clickCalls.length - 1]?.[1];
  if (typeof handler !== 'function') {
    throw new Error('Mapbox click handler was not registered');
  }
  return handler as (event: { lngLat: { lng: number; lat: number }; point: { x: number; y: number } }) => void;
}

async function openProfile() {
  const profileButton = screen.getByRole('button', { name: 'Soil profile' });
  await waitFor(() => expect(profileButton).not.toBeDisabled());
  fireEvent.click(profileButton);
  lastMapClickHandler()({
    lngLat: { lng: 7.92855, lat: 47.44362 },
    point: { x: 120, y: 120 },
  });
}
```

- [ ] **Step 3: Keep profile demand-callout regression tests**

Keep these existing tests, using the updated `openProfile()` helper:

- `'keeps the irrigation demand callout visible by default on desktop'`
- `'keeps the desktop demand callout on wide touch devices'`
- `'uses a dedicated mobile toggle for the irrigation demand callout'`

Do not remove the desktop callout test. It targets the profile view, not the deleted field-intelligence panel.

- [ ] **Step 4: Add Data/Profile mode tests**

```typescript
  it('data button makes field-value-strip visible with demand/VWC/kPa', async () => {
    mockMatchMedia({ '(max-width: 760px)': false, '(hover: none)': false, '(prefers-reduced-motion: reduce)': true });

    render(<App />);

    // Strip is hidden before data mode
    expect(document.querySelector('.field-value-strip.is-visible')).not.toBeInTheDocument();

    const dataButton = screen.getByRole('button', { name: 'Data' });
    await waitFor(() => expect(dataButton).not.toBeDisabled());
    fireEvent.click(dataButton);

    expect(document.querySelector('.field-value-strip.is-visible')).toBeInTheDocument();
    expect(screen.getByText(/mm demand/i)).toBeInTheDocument();
    expect(screen.getByText(/% VWC/i)).toBeInTheDocument();
    expect(screen.getByText(/kPa/i)).toBeInTheDocument();
  });

  it('profile button shows hint box instead of immediately opening profile', async () => {
    mockMatchMedia({ '(max-width: 760px)': false, '(hover: none)': false, '(prefers-reduced-motion: reduce)': true });

    render(<App />);

    const profileButton = screen.getByRole('button', { name: 'Soil profile' });
    await waitFor(() => expect(profileButton).not.toBeDisabled());
    fireEvent.click(profileButton);

    // Hint box appears
    expect(screen.getByText(/Tap a zone to open the soil profile/i)).toBeInTheDocument();
    // Profile view is NOT open yet
    expect(document.querySelector('.mode-profile')).not.toBeInTheDocument();
  });

  it('data and profile modes are mutually exclusive', async () => {
    mockMatchMedia({ '(max-width: 760px)': false, '(hover: none)': false, '(prefers-reduced-motion: reduce)': true });

    render(<App />);

    const dataButton = screen.getByRole('button', { name: 'Data' });
    const profileButton = screen.getByRole('button', { name: 'Soil profile' });
    await waitFor(() => expect(dataButton).not.toBeDisabled());

    fireEvent.click(dataButton);
    expect(screen.getByText(/Tap a zone · irrigation demand/i)).toBeInTheDocument();

    fireEvent.click(profileButton);
    expect(screen.queryByText(/Tap a zone · irrigation demand/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Tap a zone to open the soil profile/i)).toBeInTheDocument();
  });
```

- [ ] **Step 5: Run the updated tests**

```bash
cd terra-intelligence && npm test -- src/__tests__/mobileControls.test.tsx
```

Expected: all pass.

- [ ] **Step 6: Run the full test suite**

```bash
cd terra-intelligence && npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add terra-intelligence/src/__tests__/mobileControls.test.tsx
git commit -m "test(terra): update mobileControls tests for UX refactor"
```

---

## Task 8: Browser verification

**Files:**
- No source files; run verification commands only.

- [ ] **Step 1: Run the build**

```bash
cd terra-intelligence && npm run build
```

Expected: TypeScript and Vite build successfully. Existing Vite chunk-size warnings are acceptable.

- [ ] **Step 2: Run Playwright mobile checks**

Use the existing Terra Playwright runner or create a temporary runner under `/tmp` that opens the local preview/dev URL and checks these viewports:

- `320x740`, touch/mobile
- `390x844`, touch/mobile
- `430x932`, touch/mobile
- `844x390`, touch/mobile landscape
- `1024x768`, wide touch

For each viewport, verify:

- the four tool buttons are visible and do not overlap;
- Data mode shows demand, VWC, and kPa without opening profile view;
- Soil profile mode shows the hint first and opens profile only after tapping the field;
- profile demand callout is visible by default on desktop and wide touch;
- mobile profile uses the dedicated demand toggle;
- forecast rail remains draggable and does not intercept field/profile controls.

- [ ] **Step 3: Commit verification artifacts only if intentionally added**

Do not commit `/tmp` scripts or screenshots. If a reusable Playwright test is added under `terra-intelligence/src/__tests__` or `terra-intelligence/tests`, commit it with:

```bash
git add terra-intelligence
git commit -m "test(terra): add UX refactor browser coverage"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|-------------|------|
| Remove "Concept forecast" box (field-intelligence-panel) | Task 1 |
| Remove all traces of field-intelligence-panel (CSS, JS constant) | Task 1 |
| Enable soil grid by default | Task 2 (always on, no state needed) |
| Remove soil grid button, remove all traces | Task 2 |
| Combine irrigation demand + VWC + kPa into one Data button | Task 3 |
| Remove separate demand and values buttons | Task 3 |
| Data button shows demand/VWC/kPa for selected zone | Tasks 3 + 5 |
| Data button does not open soil profile | Task 5 |
| Data button has an explaining hint box | Task 4 |
| Soil profile button shows explaining hint box before opening profile | Task 4 |
| Cell click opens soil profile only if profile mode is enabled | Task 5 |
| Cell click shows data only if data mode is enabled | Task 5 |
| Data and profile modes are mutually exclusive | Tasks 3, 4 |
| Mode resets when returning from profile | Task 4 |
| Mode resets when drawing starts | Task 3 |
| Tool-stack grid CSS updated for 4 buttons | Task 6 |
| Tests updated and new behaviors covered | Task 7 |
| Browser verification across narrow, large, landscape, and wide-touch mobile cases | Task 8 |

**Placeholder scan:** None found. All code is concrete.

**Type consistency:**
- `CellInteractionMode` is a named type and `cellInteractionMode` uses it consistently across all tasks.
- `setSelectedPoint` and `setSelectedSampleId` are React state setters — they do not need to be declared in the `useCallback` pattern; they are stable references and safe to add to the dependency array.
- `beginProfileDive` is wrapped in `useCallback` and is already in the dependency array — no change needed.

**Note on `setSelectedSampleId`:** Confirm this setter exists by searching `App.tsx` for `setSelectedSampleId`. It should exist alongside `selectedSampleId` state. If it is named differently, adjust the dependency array in Task 5 accordingly.
