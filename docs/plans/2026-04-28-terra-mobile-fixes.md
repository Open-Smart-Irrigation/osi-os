# Terra Intelligence — Mobile Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all confirmed mobile layout breakages, interaction failures, and UX deficiencies in Terra Intelligence (`terra-intelligence`) and the embedded `PredictionCard` in the dashboard frontend.

**Primary repo:** `osi-server` (`terra-intelligence/`, `frontend/`)
**Scope of changes:** CSS only for most items; targeted JS/TSX changes for slider event fix, irrigation demand toggle, and prefers-reduced-motion guard.
**Relationship to overhaul plan:** `docs/plans/2026-04-24-terra-overhaul.md` plans a full component extraction and CSS-grid layout refactor. Tasks here fix confirmed breakages that block mobile use _now_. The overhaul will supersede the CSS changes in Tasks 6 and 8 when it lands; the JS fixes (Tasks 1, 3, 7) remain valid either way.

---

## Source Legend

Each issue below is tagged with which sources confirmed it:

| Tag | Source |
|---|---|
| **[F]** | Frontend code / static analysis |
| **[P]** | Playwright Chromium mobile audit (320×568, 360×740, 390×844, 430×932) |
| **[H]** | Human browser testing |
| **[D]** | Draft implementation plan (agent 3) |

Three-source confirmation = fix unconditionally. One-source = still fix if cost is low; defer if high.

---

## P0 — Critical (must fix before mobile use is viable)

### Task 1: Fix forecast rail slider — event blocking and touch ergonomics

**Confirmed by: [P] [H] [F] — all three independent sources**

The slider is completely non-functional on mobile. Playwright touch-drag tests returned `9 → 9` with zero `input` events. After disabling `.rail-marker { pointer-events: auto }` in-page, the same drag produced `9 → 159` with continuous events. The `.rail-marker` overlay in `App.tsx:1186` physically covers the `<input type="range">` and absorbs all touch events. Thumb size (24px vs 44px minimum) is a secondary issue that compounds the problem once event blocking is resolved.

**Files:**
- Modify: `terra-intelligence/src/styles.css`
- Modify: `terra-intelligence/src/App.tsx` (marker DOM order only)

- [ ] **Step 1.1: Disable pointer events on rail markers within the mobile breakpoint**

In `styles.css`, inside `@media (max-width: 760px)`, add:

```css
.rail-markers {
  pointer-events: none;
}

.rail-marker {
  pointer-events: none;
  min-height: 44px;
  min-width: 36px;
}

.rail-marker span {
  display: block;        /* restore D+0..D+6 labels, hidden since line 1867 */
  font-size: 0.6rem;
  position: absolute;
  bottom: 100%;
  margin-bottom: 2px;
  white-space: nowrap;
  pointer-events: none;
}
```

Rationale: labels were hidden (`display: none`) to save space, but the invisible tap targets remained active and covered the slider. Restoring labels as pointer-events-none visual anchors is better than invisible 44px ghost buttons.

- [ ] **Step 1.2: Enlarge slider thumb and add touch-action**

In `styles.css`, inside `@media (max-width: 760px)`, replace the existing rail-slider thumb rules:

```css
.rail-slider {
  width: 100%;
  height: 56px;          /* was 46px — accommodates 44px thumb + track */
  cursor: ew-resize;
  direction: ltr;
  writing-mode: horizontal-tb;
  touch-action: pan-x;   /* prevents vertical scroll hijack during scrub */
}

.rail-control {
  width: 100%;
  height: 56px;
  min-height: 56px;      /* was 46px */
}

.rail-slider::-webkit-slider-runnable-track {
  width: 100%;
  height: 4px;
  background: linear-gradient(90deg, rgba(48, 170, 255, 0.82), rgba(82, 245, 152, 0.82), rgba(255, 72, 88, 0.82));
}

.rail-slider::-webkit-slider-thumb {
  width: 44px;           /* was 24px */
  height: 44px;
  margin-top: -20px;     /* re-center in 4px track: -(44-4)/2 */
  margin-left: 0;
  appearance: none;
  border: 1px solid rgba(243, 255, 249, 0.92);
  border-radius: 50%;
  background: #f3fff8;
  box-shadow: 0 0 18px rgba(83, 255, 199, 0.76);
}

.rail-slider::-moz-range-track {
  width: 100%;
  height: 4px;
  background: linear-gradient(90deg, rgba(48, 170, 255, 0.82), rgba(82, 245, 152, 0.82), rgba(255, 72, 88, 0.82));
}

.rail-slider::-moz-range-thumb {
  width: 44px;           /* was 24px */
  height: 44px;
  border: 1px solid rgba(243, 255, 249, 0.92);
  border-radius: 50%;
  background: #f3fff8;
  box-shadow: 0 0 18px rgba(83, 255, 199, 0.76);
}
```

- [ ] **Step 1.3: Add step=1 attribute for mobile**

In `App.tsx`, inside the `ForecastRail` component render (~line 1176), conditionally set step based on a mobile media-query match or add a second CSS-only solution. The simplest approach is to change the step in the component to detect touch capability:

```tsx
// At the top of ForecastRail component
const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;

// On the input element
<input
  aria-label="Forecast hour"
  className="rail-slider"
  type="range"
  min="0"
  max={TOTAL_HOURS - 1}
  step={isTouchDevice ? 1 : 0.25}   // coarser steps on touch
  value={hour}
  onChange={handleChange}
/>
```

- [ ] **Step 1.4: Acceptance check**

Playwright touch-drag test on `.rail-slider` at 390×844: confirm `forecastHour` value changes continuously from initial value during a horizontal drag across 60% of the slider width. Confirm `.rail-marker` elements do not appear in the element returned by `elementFromPoint` at the slider midpoint.

---

### Task 2: Fix profile view not scrollable on short phones

**Confirmed by: [P] [H] — Playwright: scrollTop stayed 0, scrollHeight === clientHeight; Human: "bottom of the soil profile is not aligned with the forecast scroll wheel, there is a big gap"**

At 320×568, soil profile content is clipped behind the forecast rail and unreachable by scroll. The causes are layered: `.app-shell { overflow: hidden }` clips the profile-view before its own `overflow-y: auto` can engage; `.soil-stage { min-height: 0 }` undersizes the content area; `.soil-slice { height: 44vh }` at 568px height is only 249px and can still overflow its container.

**Files:**
- Modify: `terra-intelligence/src/styles.css`

- [ ] **Step 2.1: Give the profile view a bounded, scrollable height**

In `styles.css`, inside `@media (max-width: 760px)`, replace:

```css
/* current */
.profile-view {
  padding: 78px 14px 168px;
  place-items: stretch;
  overflow-y: auto;
}
```

with:

```css
.profile-view {
  position: fixed;                /* take it out of the app-shell overflow: hidden chain */
  inset: 0;
  padding: 78px 14px 180px;       /* 180px = forecast rail height (66px) + tool gap (94px) + safety margin (20px) */
  place-items: stretch;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  z-index: 20;                    /* above field-scene and forecast-rail */
}
```

`position: fixed; inset: 0` gives the profile-view a known viewport-sized box with its own scroll context, independent of `.app-shell { overflow: hidden }`.

- [ ] **Step 2.2: Fix soil-stage and soil-slice minimum heights**

In `styles.css`, inside `@media (max-width: 760px)`, replace:

```css
/* current */
.soil-stage {
  --surface-offset: 116px;
  --root-zone-left: 12%;
  --root-zone-width: 24%;
  min-height: 0;
  padding-top: var(--surface-offset);
}

.soil-slice {
  min-height: 310px;
  height: 44vh;
}
```

with:

```css
.soil-stage {
  --surface-offset: 116px;
  --root-zone-left: 12%;
  --root-zone-width: 24%;
  min-height: 360px;             /* was 0 — ensures content taller than viewport slice */
  padding-top: var(--surface-offset);
}

.soil-slice {
  min-height: 310px;
  height: auto;                  /* was 44vh — let content dictate height */
}
```

- [ ] **Step 2.3: Acceptance check**

At 320×568 in Playwright: after entering profile mode, `profileView.scrollTop` should change on a vertical swipe, and `scrollHeight > clientHeight`. Soil horizon content at the bottom is reachable without the forecast rail covering it.

---

### Task 3: Fix prefers-reduced-motion invisible profile

**Confirmed by: [D] — regression risk, low-cost fix**

When `prefers-reduced-motion: reduce` is active, the profile-view's reveal animation (`clip-path: circle(0%)` → `circle(145%)`) never fires. The view remains invisible. The existing `@media (prefers-reduced-motion: reduce) { animation: none }` suppression breaks the clip-path entry entirely.

**Files:**
- Modify: `terra-intelligence/src/App.tsx`
- Modify: `terra-intelligence/src/styles.css`

- [ ] **Step 3.1: Add JS guard for reduced-motion profile reveal**

In `App.tsx`, in the `handleProfileAnimationEnd` callback (or where profile entry is triggered), add a reduced-motion bypass. Find where `mode` transitions to `'profile'` and add:

```tsx
// After setMode('profile') / beginProfileDive, add:
if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  // Skip the animation; set the profile-view to its final visible state immediately
  const profileEl = document.querySelector<HTMLElement>('.profile-view');
  if (profileEl) {
    profileEl.style.clipPath = 'circle(145% at 50% 50%)';
    profileEl.style.opacity = '1';
    profileEl.style.transform = 'translateY(0) scale(1)';
    profileEl.style.filter = 'none';
  }
}
```

- [ ] **Step 3.2: Ensure profile-view is visible by default under reduced-motion**

In `styles.css`, inside `@media (prefers-reduced-motion: reduce)`:

```css
.profile-view {
  clip-path: circle(145% at 50% 50%) !important;
  opacity: 1 !important;
  transform: none !important;
  filter: none !important;
}
```

---

### Task 4: Restore profile metrics bar on mobile

**Confirmed by: [D] — `display: none` removes critical data**

The `.profile-header` is hidden entirely on mobile (`display: none` at `styles.css:1948`), removing the time context label. Compact representation is sufficient.

**Files:**
- Modify: `terra-intelligence/src/styles.css`

- [ ] **Step 4.1: Replace display: none with compact inline label**

In `styles.css`, inside `@media (max-width: 760px)`, replace:

```css
.profile-header {
  display: none;
}
```

with:

```css
.profile-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.72rem;
  opacity: 0.72;
  padding: 0 0 4px;
}

.profile-header span {
  font-size: 0.68rem;
}

.profile-header strong {
  font-size: 0.82rem;
}
```

---

### Task 5: Restore profile metrics bar on mobile

**Confirmed by: [D] — `display: none` on `.plant-crown` and compact crop stand removes crop context entirely**

Note: the profile metrics chip strip (irrigation demand callout area) is handled in Task 7. This task restores the crop-stand visual header information only.

**Files:**
- Modify: `terra-intelligence/src/styles.css`

- [ ] **Step 5.1: Show plant-crown at reduced size on mobile**

In `styles.css`, inside `@media (max-width: 760px)`, replace:

```css
.plant-crown {
  display: none;
}
```

with:

```css
.plant-crown {
  display: block;
  font-size: 0.68rem;
  padding: 2px 6px;
  opacity: 0.8;
}
```

---

## P1 — High Priority

### Task 6: Replace overlapping bottom-field panels with a managed stack

**Confirmed by: [H] [P] [F] — three sources**

Human observation: "the output boxes for prediction grid, irrigation demand and concept forecast overlap with the dry to wet indicator legend."
Playwright: "value chips overlap the brand HUD and the field intelligence panel" at 320×568.
Code analysis: `.field-value-strip` at `bottom: 282px` and `.field-intelligence-panel` at `bottom: 154px` with dynamic height ~136px → panel top reaches ~290px → 8–25px overlap with value strip.

The root issue is four independently-positioned absolute panels with hardcoded bottom offsets that don't account for each other's dynamic heights:
- `.forecast-rail` → bottom: 14px, ~66px tall
- `.tool-stack` → bottom: 94px, 44px tall
- `.field-intelligence-panel` → bottom: 154px, dynamic height
- `.field-value-strip` → bottom: 282px (is-visible state)
- `.water-status-legend` → inside intelligence panel

**Files:**
- Modify: `terra-intelligence/src/styles.css`

- [ ] **Step 6.1: Introduce a CSS custom property bottom stack height**

At the top of the `@media (max-width: 760px)` block, add:

```css
@media (max-width: 760px) {
  :root {
    --mobile-rail-height: 76px;     /* forecast-rail: 56px slider + 10px padding top + 10px padding bottom */
    --mobile-tool-row: 58px;        /* tool-stack: 44px buttons + 14px gap above rail */
    --mobile-stack-base: calc(var(--mobile-rail-height) + 14px); /* rail bottom offset */
    --mobile-panel-base: calc(var(--mobile-stack-base) + var(--mobile-tool-row));
  }
```

- [ ] **Step 6.2: Reanchor tool-stack using the CSS variable**

```css
  .tool-stack {
    top: auto;
    right: auto;
    left: 14px;
    bottom: calc(var(--mobile-stack-base) + 10px);
    display: grid;
    grid-template-columns: repeat(6, 44px);
  }
```

- [ ] **Step 6.3: Reanchor field-intelligence-panel above the tool row**

```css
  .field-intelligence-panel {
    right: 14px;
    bottom: calc(var(--mobile-panel-base) + 10px);
    left: 14px;
    width: auto;
    gap: 8px;
  }
```

- [ ] **Step 6.4: Push field-value-strip above the intelligence panel**

Because the panel height is dynamic, use a generous margin. The value strip is only shown when explicitly enabled so a larger bottom offset is acceptable:

```css
  .field-value-strip {
    right: 14px;
    bottom: calc(var(--mobile-panel-base) + 160px); /* clears typical panel max-height */
    left: 14px;
    max-width: none;
    transform: translateY(12px);
  }

  .field-value-strip.is-visible {
    transform: translateY(0);
  }
```

- [ ] **Step 6.5: Adjust live-status-bar to clear the brand-hud bottom**

```css
  .live-status-bar {
    top: 148px;    /* was 124px — brand-hud in live mode is ~110px tall; this adds 38px safety */
    right: 14px;
    left: 14px;
    max-width: none;
    justify-content: flex-start;
    transform: none;
  }
```

- [ ] **Step 6.6: Acceptance check**

At 320×568 with water status, prediction grid, and irrigation demand all enabled: no `.field-value-strip span` element should overlap any `.field-intelligence-panel` child. Bounding rect checks: value-strip bottom < intelligence-panel top.

---

### Task 7: Fix irrigation demand callout overlapping crop in soil profile

**Confirmed by: [H] — "the irrigation demand box is overlapping the crop (maybe this box can be default off and toggled on by tapping on the soil)"**

The `.irrigation-demand-callout` is absolutely positioned within `.soil-stage` and overlays the crop visual on mobile. The human suggestion (tap to reveal) is the right interaction model.

**Files:**
- Modify: `terra-intelligence/src/App.tsx`
- Modify: `terra-intelligence/src/styles.css`

- [ ] **Step 7.1: Add showDemandCallout state to App**

In `App.tsx`, add a state variable near the other boolean states (~line 1244):

```tsx
const [showDemandCallout, setShowDemandCallout] = useState(false);
```

- [ ] **Step 7.2: Toggle on soil-stage tap**

Find the `.soil-stage` div in the JSX (~line 2161) and add an onClick handler:

```tsx
<div
  className="soil-stage"
  aria-label="Soil profile with crop roots and water status"
  onClick={() => setShowDemandCallout((v) => !v)}
>
```

- [ ] **Step 7.3: Conditionally render the callout**

Find the `.irrigation-demand-callout` aside element and wrap it:

```tsx
{showDemandCallout && (
  <aside className="irrigation-demand-callout" aria-label="Irrigation demand for active root zone">
    <span>Irrigation demand</span>
    <strong>{profileMetrics.irrigationDemandMm.toFixed(1)} mm</strong>
    <small>…</small>
  </aside>
)}
```

- [ ] **Step 7.4: Add tap hint to soil-stage on mobile**

In `styles.css`, inside `@media (max-width: 760px)`:

```css
.soil-stage::after {
  content: "Tap for demand";
  position: absolute;
  bottom: 8px;
  right: 10px;
  font-size: 0.6rem;
  color: rgba(238, 248, 242, 0.4);
  pointer-events: none;
}
```

---

### Task 8: Fix brand-hud / profile-selector overlap on narrow screens

**Confirmed by: [F] [P]**

Code analysis: brand-hud `left: 14px; max-width: 190px` → occupies to x=204px. Profile-selector `left: 112px` → overlaps by 92px.
Playwright: confirmed brand-hud overlap in active value chip screenshots at 320×568.

**Files:**
- Modify: `terra-intelligence/src/styles.css`

- [ ] **Step 8.1: Hide brand-hud in profile mode**

The brand-hud is irrelevant when the profile view is open (the profile-selector replaces it). Add:

```css
@media (max-width: 760px) {
  .mode-profile .brand-hud {
    display: none;
  }

  .profile-selector {
    top: 14px;
    right: 14px;
    left: 14px;    /* was 112px — no longer needs to avoid the hud */
    width: auto;
    padding: 8px;
  }
}
```

---

### Task 9: Relocate Mapbox navigation controls on mobile

**Confirmed by: [P] — "Mapbox bottom-left control overlaps the draw button/tool row on every tested mobile viewport"**

The `NavigationControl` is added at `'bottom-left'` in `App.tsx:1476`. The Terra tool-stack is also bottom-left on mobile. They collide.

**Files:**
- Modify: `terra-intelligence/src/App.tsx`

- [ ] **Step 9.1: Conditionally add Mapbox NavigationControl**

Find the line adding the NavigationControl (~line 1476):

```tsx
map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-left');
```

Replace with:

```tsx
const isMobile = window.matchMedia('(max-width: 760px)').matches;
if (!isMobile) {
  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-left');
}
```

Rationale: the Mapbox pitch/zoom controls duplicate touch gestures (pinch-to-zoom, two-finger rotate) that are already natively available on mobile. Removing them recovers the bottom-left corner for Terra tools.

---

### Task 10: Fix tool-stack overflow on 320px screens

**Confirmed by: [F] [P]**

6 × 44px = 264px. At 320px screen width with 14px left margin, the stack is 278px from left edge — 42px overflows on 320px screens. The rightmost tools (Values, Irrigation demand) clip silently.

**Files:**
- Modify: `terra-intelligence/src/styles.css`

- [ ] **Step 10.1: Add 3×2 wrapping grid below 400px**

After the existing `@media (max-width: 760px)` tool-stack rules, add a new breakpoint:

```css
@media (max-width: 400px) {
  .tool-stack {
    grid-template-columns: repeat(3, 44px);
    grid-template-rows: repeat(2, 44px);
    gap: 4px;
    bottom: calc(var(--mobile-stack-base) + 10px);
  }

  .tool-tip {
    bottom: 108px;   /* clears 2-row stack height */
  }
}
```

---

### Task 11: Replace :hover tooltips with tap-driven labels on mobile

**Confirmed by: [D] [F] — hover is inaccessible on touch; tool-tip clips off right edge at 320px (Playwright)**

**Files:**
- Modify: `terra-intelligence/src/styles.css`

- [ ] **Step 11.1: Disable hover tooltips on touch devices**

Add inside `@media (max-width: 760px)`:

```css
.tool-tip {
  display: none;    /* suppress hover-driven tooltips on touch */
}

.tool-button:focus-visible .tool-tip,
.tool-button[aria-pressed="true"] .tool-tip {
  display: block;   /* still show on keyboard focus or active state */
}
```

- [ ] **Step 11.2: Add aria-label to all ToolButton usages in App.tsx**

Confirm that each `<ToolButton>` already passes a `label` prop (it does — `aria-label={label}` at line 1141). No JSX change needed; the accessible name is already present.

---

### Task 12: Mobile UX polish — overscroll, safe-area, iOS select zoom

**Confirmed by: [D] items 8, 9, 10**

**Files:**
- Modify: `terra-intelligence/src/styles.css`
- Modify: `terra-intelligence/index.html`

- [ ] **Step 12.1: Add overscroll-behavior: contain to all mobile scroll containers**

In `styles.css`, inside `@media (max-width: 760px)`:

```css
body,
.profile-view {
  overscroll-behavior: contain;
}
```

- [ ] **Step 12.2: Add viewport-fit=cover to index.html**

In `terra-intelligence/index.html`, update the viewport meta tag:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

- [ ] **Step 12.3: Add safe-area-inset padding to anchored panels**

In `styles.css`, inside `@media (max-width: 760px)`:

```css
.forecast-rail {
  bottom: max(14px, env(safe-area-inset-bottom));
}

.profile-view {
  padding-bottom: max(180px, calc(180px + env(safe-area-inset-bottom)));
}
```

- [ ] **Step 12.4: Fix select auto-zoom on iOS**

In `styles.css`, add globally (not scoped to a breakpoint — iOS applies this to all viewports):

```css
select {
  font-size: max(16px, 1em);  /* iOS zooms the viewport on focus if font-size < 16px */
}
```

---

## P2 — Medium Priority

### Task 13: Add intermediate breakpoint and minor refinements

**Confirmed by: [D] items 11–16**

**Files:**
- Modify: `terra-intelligence/src/styles.css`

- [ ] **Step 13.1: Add 480px breakpoint for phablet form factors**

```css
@media (min-width: 431px) and (max-width: 600px) {
  .brand-hud {
    max-width: 240px;
  }

  .tool-stack {
    grid-template-columns: repeat(6, 44px);  /* restore single row */
  }

  .selector-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
```

- [ ] **Step 13.2: Add will-change hints on animated layers**

```css
.soil-horizon {
  will-change: background-color;
}

.moisture-cell {
  will-change: fill-opacity;
}
```

- [ ] **Step 13.3: Prevent text selection on long-press for HUD elements**

```css
.brand-hud,
.tool-button,
.tool-stack,
.forecast-rail,
.field-intelligence-panel {
  user-select: none;
  -webkit-user-select: none;
}
```

- [ ] **Step 13.4: Add ARIA role and label to forecast rail input**

In `App.tsx`, on the `<input type="range">` in `ForecastRail`:

```tsx
<input
  role="slider"
  aria-label="Forecast hour (0–167)"
  aria-valuemin={0}
  aria-valuemax={TOTAL_HOURS - 1}
  aria-valuenow={Math.round(hour)}
  aria-valuetext={formatForecastTime(hour, startDate)}
  …
/>
```

- [ ] **Step 13.5: Add touch-action: none to map canvas during drawing mode**

In `styles.css`, inside `.is-drawing .map-host`:

```css
.is-drawing .map-host {
  touch-action: none;   /* prevent browser scroll/zoom interfering with vertex placement */
}
```

---

### Task 14: PredictionCard mobile fixes (osi-server/frontend)

**Confirmed by: [F] — static analysis only; no Playwright coverage yet**

**Files:**
- Modify: `osi-server/frontend/src/components/farming/prediction/PredictionCard.tsx`
- Modify: `osi-server/frontend/src/components/farming/prediction/PredictionTrajectoryTab.tsx`

- [ ] **Step 14.1: Make tab bar horizontally scrollable instead of clipping**

In `PredictionCard.tsx:517`, change the tab container class:

```tsx
{/* was: overflow-hidden (clips tabs on ≤360px) */}
<div className="flex gap-px bg-[var(--border)] rounded-lg border border-[var(--border)] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
```

- [ ] **Step 14.2: Define touch-target as a real utility class**

`touch-target` is referenced on action buttons (lines 443, 452) but has no definition anywhere. Add to the project's global CSS or Tailwind config:

```css
/* global.css or index.css */
.touch-target {
  min-height: 44px;
  min-width: 44px;
}
```

- [ ] **Step 14.3: Fix gear button touch target**

In `PredictionCard.tsx:459`, replace:

```tsx
<button
  onClick={() => setShowConfigModal(true)}
  className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--card)] transition-colors text-lg"
  title="Configure"
>
```

with:

```tsx
<button
  onClick={() => setShowConfigModal(true)}
  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--card)] transition-colors text-lg"
  title="Configure"
>
```

- [ ] **Step 14.4: Add overflow-x-auto wrapper to trajectory table**

In `PredictionTrajectoryTab.tsx:29`, change:

```tsx
{/* was: overflow-hidden — clips table on narrow screens */}
<div className="rounded-xl border border-[var(--border)] overflow-x-auto">
```

- [ ] **Step 14.5: Increase stress bar label size above WCAG minimum**

In `PredictionStressBars.tsx:57`, change `text-[9px]` to `text-[10px]` on both label spans.

---

## Acceptance Summary

| Task | Viewport | Pass condition |
|---|---|---|
| 1 (slider) | 390×844 | Touch-drag changes forecast hour; `.rail-marker` not at `elementFromPoint` midpoint |
| 2 (profile scroll) | 320×568 | `profileView.scrollTop` changes on swipe; bottom horizon visible without forecast rail covering it |
| 3 (reduced-motion) | any | Profile view visible with `prefers-reduced-motion: reduce` media |
| 6 (bottom stack) | 320×568 | `.field-value-strip` bounding rect bottom < `.field-intelligence-panel` top |
| 7 (demand callout) | 390×844 | Callout absent on profile open; appears after soil tap; disappears on second tap |
| 8 (hud overlap) | 360×740 | brand-hud and profile-selector have zero bounding-rect intersection |
| 9 (Mapbox) | 390×844 | No Mapbox NavigationControl DOM element present on mobile viewport |
| 10 (tool overflow) | 320×568 | All 6 tool buttons fully visible within viewport bounds |

---

## Regression Notes

- Tasks 6 and 8 (bottom stack reanchoring, brand-hud hide in profile mode) will be superseded by the full CSS-grid overhaul in `docs/plans/2026-04-24-terra-overhaul.md`. Apply them now as targeted fixes; do not block on the overhaul timeline.
- Task 7 (irrigation demand callout toggle) introduces a `showDemandCallout` state. The overhaul plan's `ProfileView` component should absorb this state when it extracts the profile section.
- Task 9 (Mapbox control removal on mobile) should be revisited if a future field-drawing UX needs map zoom controls on mobile.
- Task 1 Step 1.3 (`isTouchDevice` check) uses `window.matchMedia('(hover: none)')` which is evaluated once at ForecastRail mount. This is sufficient since the app does not dynamically switch between touch and pointer modes within a session.
