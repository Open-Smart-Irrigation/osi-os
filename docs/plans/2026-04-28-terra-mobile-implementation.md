# Terra Intelligence Mobile Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` when subagents are explicitly authorized; otherwise use `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix confirmed Terra Intelligence and PredictionCard mobile breakages so the experience is usable from 320 x 568 phones upward without desktop regressions.

**Architecture:** Implement the work in isolated phases with a review checkpoint after each phase. Terra mobile layout uses one shared mobile-UX hook in React and one readable CSS variable stack for bottom controls. Profile scrolling breaks out of `.app-shell { overflow: hidden }` intentionally on mobile, while desktop layout and desktop callout behavior remain unchanged.

**Tech Stack:** React 18, TypeScript, plain CSS for `terra-intelligence`, Vitest + RTL for unit tests, Playwright Chromium for mobile browser regression checks, Tailwind in `frontend`.

**Primary code repo:** `/home/phil/Repos/osi-server`

**Plan repo:** `/home/phil/Repos/osi-os`

---

## Source Context

| Finding | Resolution |
|---|---|
| `.rail-marker` overlays intercept all mobile slider touch events | Disable marker pointer-events in mobile layout and verify with Playwright hit testing + touch drag |
| Profile view has `scrollHeight === clientHeight` at 320 x 568 | Give mobile profile an independent fixed scroll context and content height |
| Mapbox controls collide with Terra mobile toolbar | Skip Mapbox `NavigationControl` when mobile UX is active |
| Bottom panels overlap because independent absolute offsets drift | Use readable `--mobile-*` stack variables and content-aware breakpoints |
| Irrigation demand callout overlaps crop image | Keep desktop callout visible; add a dedicated mobile toggle |
| `prefers-reduced-motion` was suspected but verified as non-bug | No implementation task; `beginProfileDive` already enters `profile` directly |
| `.profile-metrics` is hidden on the smallest screens | Restore compact mobile metrics instead of leaving key data invisible |

---

## Phase 0: Baseline And Shared Utilities

**Files:**
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/App.tsx`
- Test: `/home/phil/Repos/osi-server/terra-intelligence/src/__tests__/mobileUx.test.tsx`

- [ ] **Step 0.1: Verify baseline**

Run:

```bash
cd /home/phil/Repos/osi-server/terra-intelligence
npm run build
npm test

cd /home/phil/Repos/osi-server/frontend
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 0.2: Add failing tests for shared mobile UX**

Create `terra-intelligence/src/__tests__/mobileUx.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ForecastRail, useIsMobileUx } from '../App';

function Probe() {
  const isMobile = useIsMobileUx();
  return <output aria-label="mobile-ux">{String(isMobile)}</output>;
}

function mockMatchMedia(matchesByQuery: Record<string, boolean>) {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: Boolean(matchesByQuery[query]),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

describe('mobile UX detection', () => {
  beforeEach(() => {
    mockMatchMedia({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses mobile UX when viewport is narrow', () => {
    mockMatchMedia({ '(max-width: 760px)': true });

    render(<Probe />);

    expect(screen.getByLabelText('mobile-ux')).toHaveTextContent('true');
  });

  it('uses mobile UX when primary pointer is touch', () => {
    mockMatchMedia({ '(hover: none)': true });

    render(<Probe />);

    expect(screen.getByLabelText('mobile-ux')).toHaveTextContent('true');
  });

  it('uses desktop UX when viewport is wide and pointer can hover', () => {
    mockMatchMedia({ '(max-width: 760px)': false, '(hover: none)': false });

    render(<Probe />);

    expect(screen.getByLabelText('mobile-ux')).toHaveTextContent('false');
  });
});

describe('ForecastRail mobile ergonomics', () => {
  beforeEach(() => {
    mockMatchMedia({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses whole-hour steps for mobile UX', () => {
    mockMatchMedia({ '(max-width: 760px)': true });

    render(<ForecastRail hour={9} onHourChange={vi.fn()} />);

    expect(screen.getByLabelText('Forecast hour')).toHaveAttribute('step', '1');
  });

  it('keeps quarter-hour steps for desktop UX', () => {
    mockMatchMedia({ '(max-width: 760px)': false, '(hover: none)': false });

    render(<ForecastRail hour={9} onHourChange={vi.fn()} />);

    expect(screen.getByLabelText('Forecast hour')).toHaveAttribute('step', '0.25');
  });
});
```

- [ ] **Step 0.3: Run the new tests and verify RED**

Run:

```bash
cd /home/phil/Repos/osi-server/terra-intelligence
npm test -- mobileUx
```

Expected: fails because `ForecastRail` and `useIsMobileUx` are not exported yet.

- [ ] **Step 0.4: Export `ForecastRail` and add `useIsMobileUx`**

In `terra-intelligence/src/App.tsx`, export the rail component and add a shared hook near `useReducedMotion`:

```tsx
export function useIsMobileUx(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const viewportQuery = window.matchMedia('(max-width: 760px)');
    const touchQuery = window.matchMedia('(hover: none)');
    const sync = () => setIsMobile(viewportQuery.matches || touchQuery.matches);

    sync();
    viewportQuery.addEventListener('change', sync);
    touchQuery.addEventListener('change', sync);
    return () => {
      viewportQuery.removeEventListener('change', sync);
      touchQuery.removeEventListener('change', sync);
    };
  }, []);

  return isMobile;
}
```

Change:

```tsx
function ForecastRail({
```

to:

```tsx
export function ForecastRail({
```

Inside `ForecastRail`, add:

```tsx
const isMobileUx = useIsMobileUx();
```

Change the range input step:

```tsx
step={isMobileUx ? 1 : 0.25}
```

Add the existing ARIA attributes while preserving the native range role:

```tsx
aria-valuetext={formatForecastTime(hour, startDate)}
```

- [ ] **Step 0.5: Verify GREEN**

Run:

```bash
cd /home/phil/Repos/osi-server/terra-intelligence
npm test -- mobileUx
```

Expected: the new tests pass.

- [ ] **Phase 0 review checkpoint**

Run:

```bash
git diff -- terra-intelligence/src/App.tsx terra-intelligence/src/__tests__/mobileUx.test.tsx
```

Review:
- The mobile definition is centralized.
- No desktop behavior changes except the exported test surface.
- `ForecastRail` remains a normal controlled range input.

---

## Phase 1: Forecast Rail Touch Fix

**Files:**
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/styles.css`

- [ ] **Step 1.1: Apply mobile rail CSS**

Inside `@media (max-width: 760px)`, update the mobile rail rules:

```css
  .rail-control {
    width: 100%;
    height: 56px;
    min-height: 56px;
  }

  .rail-slider {
    width: 100%;
    height: 56px;
    cursor: ew-resize;
    direction: ltr;
    writing-mode: horizontal-tb;
    touch-action: pan-x;
  }

  .rail-slider::-webkit-slider-runnable-track {
    width: 100%;
    height: 4px;
    background: linear-gradient(90deg, rgba(48, 170, 255, 0.82), rgba(82, 245, 152, 0.82), rgba(255, 72, 88, 0.82));
  }

  .rail-slider::-webkit-slider-thumb {
    width: 44px;
    height: 44px;
    margin-top: -20px;
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
    width: 44px;
    height: 44px;
    border: 1px solid rgba(243, 255, 249, 0.92);
    border-radius: 50%;
    background: #f3fff8;
    box-shadow: 0 0 18px rgba(83, 255, 199, 0.76);
  }

  .rail-markers {
    pointer-events: none;
  }

  .rail-marker {
    pointer-events: none;
    min-width: 36px;
    min-height: 44px;
  }

  .rail-marker span {
    display: block;
    position: absolute;
    bottom: 100%;
    margin-bottom: 2px;
    color: rgba(240, 255, 248, 0.64);
    font-size: 0.6rem;
    line-height: 1;
    pointer-events: none;
    white-space: nowrap;
  }
```

- [ ] **Step 1.2: Verify by browser automation**

Run the app and use Playwright at `390 x 844`:
- `elementFromPoint` at the slider midpoint returns `.rail-slider`.
- Touch-drag across 60% of the rail changes the input value and emits input events.

- [ ] **Phase 1 review checkpoint**

Review:
- Day marker labels are visual only on mobile.
- Slider thumb meets 44px touch target.
- No marker button is still intercepting touch input.

---

## Phase 2: Mobile Bottom Stack And Profile Scroll

**Files:**
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/styles.css`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/index.html`

- [ ] **Step 2.1: Add `viewport-fit=cover`**

In `index.html`, use:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

- [ ] **Step 2.2: Add readable mobile stack variables**

At the top of `@media (max-width: 760px)`, add:

```css
  :root {
    --mobile-edge-gap: 14px;
    --mobile-rail-bottom: max(14px, env(safe-area-inset-bottom));
    --mobile-rail-height: 86px;
    --mobile-tool-height: 44px;
    --mobile-tool-gap: 8px;
    --mobile-panel-gap: 10px;
    --mobile-panel-estimated-height: 150px;
    --mobile-stack-base: calc(var(--mobile-rail-bottom) + var(--mobile-rail-height));
    --mobile-tool-bottom: calc(var(--mobile-stack-base) + var(--mobile-tool-gap));
    --mobile-panel-bottom: calc(var(--mobile-tool-bottom) + var(--mobile-tool-height) + var(--mobile-panel-gap));
    --mobile-strip-bottom: calc(var(--mobile-panel-bottom) + var(--mobile-panel-estimated-height) + var(--mobile-panel-gap));
  }
```

- [ ] **Step 2.3: Reanchor bottom UI using the variables**

Inside `@media (max-width: 760px)`, update:

```css
  .forecast-rail {
    top: auto;
    right: var(--mobile-edge-gap);
    bottom: var(--mobile-rail-bottom);
    left: var(--mobile-edge-gap);
    width: auto;
    grid-template-columns: minmax(100px, auto) 1fr;
    align-items: center;
    padding: 10px 12px;
    transform: none;
  }

  .tool-stack {
    top: auto;
    right: auto;
    left: var(--mobile-edge-gap);
    bottom: var(--mobile-tool-bottom);
    display: grid;
    grid-template-columns: repeat(6, 44px);
  }

  .field-intelligence-panel {
    right: var(--mobile-edge-gap);
    bottom: var(--mobile-panel-bottom);
    left: var(--mobile-edge-gap);
    width: auto;
    gap: 8px;
  }

  .field-value-strip {
    right: var(--mobile-edge-gap);
    bottom: var(--mobile-strip-bottom);
    left: var(--mobile-edge-gap);
    max-width: none;
    transform: translateY(12px);
  }
```

- [ ] **Step 2.4: Add sub-400px tool stack height adjustment**

Before the existing `@media (max-width: 430px)` block, add:

```css
@media (max-width: 400px) {
  :root {
    --mobile-tool-height: 92px;
  }

  .tool-stack {
    grid-template-columns: repeat(3, 44px);
    grid-template-rows: repeat(2, 44px);
    gap: 4px;
  }
}
```

- [ ] **Step 2.5: Make profile view independently scrollable**

Inside `@media (max-width: 760px)`, replace the mobile profile rules with:

```css
  .profile-view {
    /* Mobile profile must escape .app-shell overflow:hidden so short phones can scroll the soil content. */
    position: fixed;
    inset: 0;
    z-index: 9;
    place-items: start stretch;
    padding: 78px 14px calc(var(--mobile-stack-base) + 20px);
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  .profile-visual {
    min-height: 0;
    gap: 12px;
    padding-bottom: calc(var(--mobile-stack-base) + 20px);
  }

  .mode-profile .forecast-rail,
  .mode-diving .forecast-rail {
    z-index: 21;
  }

  .soil-stage {
    --surface-offset: 116px;
    --root-zone-left: 12%;
    --root-zone-width: 24%;
    min-height: 360px;
    padding-top: var(--surface-offset);
  }

  .soil-slice {
    min-height: 310px;
    height: auto;
  }
```

- [ ] **Step 2.6: Restore compact mobile profile context**

Inside `@media (max-width: 760px)`, replace the hidden profile header and metrics rules:

```css
  .profile-header {
    position: static;
    display: flex;
    max-width: none;
    align-items: baseline;
    justify-content: flex-start;
    gap: 6px;
    padding: 0 0 4px;
    text-align: left;
    opacity: 0.72;
  }

  .profile-header span {
    font-size: 0.68rem;
  }

  .profile-header strong {
    font-size: 0.8rem;
  }

  .profile-metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .profile-metrics div {
    min-height: 58px;
    padding: 9px 10px;
  }

  .profile-metrics strong {
    font-size: 0.92rem;
  }
```

Do not add `.plant-crown`; no matching DOM element exists.

- [ ] **Phase 2 review checkpoint**

Use browser evidence at `320 x 568`, `390 x 844`, and `430 x 932`:
- Value chips do not overlap the legend or recommendation panel.
- Profile `scrollHeight > clientHeight` on `320 x 568`.
- A vertical swipe changes `profileView.scrollTop`.
- Forecast rail remains visible above profile content.
- At max profile scroll, the final metric clears the fixed forecast rail.

---

## Phase 3: Mobile Controls And Callout Behavior

**Files:**
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/App.tsx`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/styles.css`

- [ ] **Step 3.1: Skip Mapbox NavigationControl for mobile UX**

In `App.tsx`, create a non-hook helper near the constants:

```tsx
function isMobileUxNow() {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.matchMedia('(max-width: 760px)').matches || window.matchMedia('(hover: none)').matches;
}
```

Replace:

```tsx
map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-left');
```

with:

```tsx
if (!isMobileUxNow()) {
  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-left');
}
```

- [ ] **Step 3.2: Add mobile-only demand callout toggle without desktop regression**

Inside `App`, add:

```tsx
const isMobileUx = useIsMobileUx();
const [showMobileDemandCallout, setShowMobileDemandCallout] = useState(false);
const showDemandCallout = !isMobileUx || showMobileDemandCallout;
```

In `handleReturnToField`, reset:

```tsx
setShowMobileDemandCallout(false);
```

Render a dedicated mobile toggle before `.soil-slice`:

```tsx
{isMobileUx && (
  <button
    className="mobile-demand-toggle"
    type="button"
    aria-expanded={showMobileDemandCallout}
    onClick={() => setShowMobileDemandCallout((value) => !value)}
  >
    Demand
  </button>
)}

{showDemandCallout && (
  <aside className="irrigation-demand-callout" aria-label="Irrigation demand for active root zone">
    ...
  </aside>
)}
```

Do not add `role="button"` to `.soil-stage`.

- [ ] **Step 3.3: Style the mobile demand toggle and suppress touch hover tooltips**

Inside `@media (max-width: 760px)`, add:

```css
  .mobile-demand-toggle {
    position: absolute;
    z-index: 15;
    top: calc(var(--surface-offset) - 42px);
    right: 10px;
    min-width: 72px;
    min-height: 36px;
    border: 1px solid rgba(245, 255, 248, 0.22);
    border-radius: 8px;
    background: rgba(3, 9, 8, 0.68);
    color: #eef8f2;
    font: inherit;
    font-size: 0.72rem;
    backdrop-filter: blur(18px);
  }

  .tool-tip {
    display: none;
  }

  .tool-button:focus-visible .tool-tip {
    display: block;
  }
```

- [ ] **Step 3.4: Mobile polish**

Inside `@media (max-width: 760px)`, add:

```css
  body {
    overscroll-behavior: contain;
  }

  .selector-grid select,
  .live-config-form input,
  .live-config-form select {
    font-size: 16px;
  }

  .brand-hud,
  .tool-button,
  .tool-stack,
  .forecast-rail,
  .field-intelligence-panel {
    user-select: none;
    -webkit-user-select: none;
  }
```

Outside the media query, add:

```css
.is-drawing .map-host {
  touch-action: none;
}
```

- [ ] **Phase 3 review checkpoint**

Review:
- Desktop still renders the irrigation callout by default.
- Mobile uses a dedicated callout toggle.
- Mapbox controls are absent from mobile and present on desktop.
- Tooltips do not stick or clip on touch layouts.

---

## Phase 4: PredictionCard Mobile Fixes

**Files:**
- Modify: `/home/phil/Repos/osi-server/frontend/src/components/farming/prediction/PredictionCard.tsx`
- Modify: `/home/phil/Repos/osi-server/frontend/src/components/farming/prediction/PredictionTrajectoryTab.tsx`
- Modify: `/home/phil/Repos/osi-server/frontend/src/components/farming/prediction/PredictionStressBars.tsx`

- [ ] **Step 4.1: Make the tab bar actually scrollable**

In `PredictionCard.tsx`, replace the tab bar wrapper with:

```tsx
<div className="flex min-w-0 gap-px bg-[var(--border)] rounded-lg border border-[var(--border)] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
```

Change tab buttons from `flex-1` to:

```tsx
className={`shrink-0 min-w-24 px-3 py-2 text-xs font-semibold capitalize transition-colors ${
```

Change the admin link to include:

```tsx
shrink-0
```

- [ ] **Step 4.2: Add the existing `touch-target` utility to the gear button**

In `PredictionCard.tsx`, replace the gear button class with:

```tsx
className="touch-target flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--card)] transition-colors text-lg"
```

- [ ] **Step 4.3: Make the trajectory table horizontally scrollable**

In `PredictionTrajectoryTab.tsx`, change:

```tsx
<div className="rounded-xl border border-[var(--border)] overflow-hidden">
```

to:

```tsx
<div className="rounded-xl border border-[var(--border)] overflow-x-auto">
```

and change:

```tsx
<table className="min-w-full text-sm">
```

to:

```tsx
<table className="min-w-[520px] text-sm">
```

- [ ] **Step 4.4: Increase stress bar label size**

In `PredictionStressBars.tsx`, change both `text-[9px]` classes to `text-[10px]`.

- [ ] **Phase 4 review checkpoint**

Run:

```bash
cd /home/phil/Repos/osi-server/frontend
npm run build
```

Review the diff for minimal Tailwind changes only.

---

## Final Verification

Run:

```bash
cd /home/phil/Repos/osi-server/terra-intelligence
npm run build
npm test

cd /home/phil/Repos/osi-server/frontend
npm run build
```

Run Playwright mobile checks at:
- `320 x 568`
- `360 x 740`
- `390 x 844`
- `430 x 932`

Acceptance:
- Mobile rail drag changes the forecast hour.
- Slider midpoint hit target is `.rail-slider`, not `.rail-marker`.
- Bottom overlays do not visually collide in default and active-control field states.
- Profile view scrolls on short phones and the forecast rail remains usable.
- Desktop profile still shows the irrigation demand callout by default.
- PredictionCard tab row and trajectory table do not force viewport overflow.

---

## Self-Review

- The desktop callout regression is prevented by `!isMobileUx || showMobileDemandCallout`.
- The mobile definition is centralized.
- CSS variable names are readable and include safe-area behavior.
- `position: fixed` on mobile profile has a permanent explanatory comment.
- No `.soil-stage role="button"` is introduced.
- `.profile-metrics` is restored on mobile instead of hidden.
- The plan does not add work for `prefers-reduced-motion`, which is verified as a non-bug.
