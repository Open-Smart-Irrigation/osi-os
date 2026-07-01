# History Desktop Live Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the deployed OSI OS desktop History UI so desktop charts render data, card-specific views are selectable, merged Soil Moisture sources are visible/filterable, and Zone A/Zone B cards are distinguishable without exposing raw DevEUI.

**Architecture:** This is a GUI-only follow-up on `feat/history-desktop-mode`. Keep backend/API contracts unchanged and use the existing card-summary fields (`sourceLabel`, `sourceLabels`, `sourceDevices`, `sourceKey`) to drive desktop labels and source filters. Centralize small pure desktop helpers in `web/react-gui/src/history/desktopHistory.ts`, while keeping React state and rendering in `HistoryDesktopDetail` / `HistoryCompareGrid`.

**Tech Stack:** OSI OS edge React GUI: Vite + React 18 + TypeScript, SWR, Recharts, Vitest + Testing Library. Worktree: `/home/phil/Repos/osi-os/.worktrees/desktop-mode`. Branch: `feat/history-desktop-mode`.

---

## Hard Scope And Safety

- GUI-only implementation.
- Do not edit `conf/**`, any `flows.json`, `feeds/**`, bundled DB files, `database/**`, or deploy scripts.
- Do not touch `/data/db/farming.db` on kaba100 during verification.
- Live deploy, if performed after implementation, must be static GUI tar-pipe only into `/usr/lib/node-red/gui/`.
- Product decision: Zone B remains one merged `Soil Moisture` thematic card. Desktop must expose `All`, `Chameleon 1`, `Chameleon 2` source controls inside the card instead of splitting Soil into multiple cards.

## File Map

- Create: `web/react-gui/src/history/desktopHistory.ts`
  - Pure helpers for display-safe labels, source options, view filtering, and union bounds.
- Create: `web/react-gui/src/history/__tests__/desktopHistory.test.ts`
  - Unit tests for helper decisions that should not be buried in component tests.
- Modify: `web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx`
  - Fix chart-surface flex contract.
  - Add card-specific view selector.
  - Add merged-card source selector.
  - Use advanced data hook for Advanced View.
  - Use coherent request/viewport bounds.
- Modify: `web/react-gui/src/components/history/desktop/HistoryCompareGrid.tsx`
  - Fix panel visualization height contract.
  - Use display-safe card labels.
  - Keep 4-panel cap.
- Modify: `web/react-gui/src/components/history/desktop/HistoryOverviewStrip.tsx`
  - Clamp percentage styles defensively so invalid bounds cannot produce negative or oversized brush styles.
- Modify: `web/react-gui/src/components/history/__tests__/HistoryDesktopDetail.test.tsx`
  - Regression coverage for view selector, source selector, layout contract, labels, and advanced view loading.
- Modify: `web/react-gui/src/components/history/__tests__/HistoryCompareGrid.test.tsx`
  - Regression coverage for display-safe labels and panel flex wrapper.
- Modify: `web/react-gui/public/locales/{en,de-CH,es,fr,it,lg,pt}/history.json`
  - Add desktop labels used by visible controls. Use English fallback strings where translations are not yet curated.

## Execution Protocol

Each task below is one reviewable slice and should end with one commit.

After every slice:

1. Run the listed verification commands.
2. Commit only the files for that slice.
3. Review the diff against this plan and [history-data-visualization-kaba100-issues.md](../../ux/history-data-visualization-kaba100-issues.md).
4. Fix any blocking review finding.
5. Re-run the focused verification for that slice before continuing.

## Task 1: Desktop Helper Contract

**Files:**
- Create: `web/react-gui/src/history/desktopHistory.ts`
- Create: `web/react-gui/src/history/__tests__/desktopHistory.test.ts`

- [ ] **Step 1: Write the failing helper tests.**

Create `web/react-gui/src/history/__tests__/desktopHistory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  desktopBoundsForData,
  desktopCardHeaderTitle,
  desktopRailCardLabel,
  desktopSourceOptions,
  selectableDesktopViews,
} from '../desktopHistory';
import type { HistoryCardSummary } from '../types';

function card(overrides: Partial<HistoryCardSummary> = {}): HistoryCardSummary {
  return {
    cardId: 'zone-uuid:soil:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil Moisture',
    subtitle: 'Root-zone tension',
    defaultView: 'soil-profile',
    views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
    supportedRanges: ['24h', '7d', '30d', 'season'],
    defaultRange: '24h',
    sourceDeviceCount: 2,
    sourceLabels: ['Chameleon 1', 'Chameleon 2'],
    sourceDevices: [
      { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-one' },
      { name: 'Chameleon 2', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-two' },
    ],
    metadata: { coverageConfidence: 'unknown' },
    availability: { available: true, reasons: [] },
    ordering: { pinned: false, score: 0, recentRank: null },
    ...overrides,
  };
}

describe('desktopHistory helpers', () => {
  it('keeps raw DevEUI out of rail labels', () => {
    expect(desktopRailCardLabel(card({ title: 'A84041A75D5E7CFB', sourceLabel: null }))).toBe('soil');
  });

  it('uses source label to distinguish repeated single-source dendro cards', () => {
    const dendro = card({
      cardId: 'zone-uuid:dendro:dendro-src-one',
      cardType: 'dendro',
      title: 'Dendro - Growth Timeline',
      sourceLabel: 'Dendro 3',
      sourceLabels: ['Dendro 3'],
      sourceDeviceCount: 1,
      defaultView: 'growth-timeline',
      views: ['growth-timeline', 'line-chart', 'stress-events', 'calendar', 'advanced'],
    });
    expect(desktopRailCardLabel(dendro)).toBe('Dendro 3');
    expect(desktopCardHeaderTitle(dendro, 'Zone A')).toBe('Dendro 3 - Growth Timeline Zone A');
  });

  it('uses title plus zone for merged soil cards', () => {
    expect(desktopCardHeaderTitle(card(), 'Zone B')).toBe('Soil Moisture Zone B');
  });

  it('builds All plus display-safe source options for merged cards', () => {
    expect(desktopSourceOptions(card())).toEqual([
      { key: null, label: 'All' },
      { key: 'soil-src-one', label: 'Chameleon 1' },
      { key: 'soil-src-two', label: 'Chameleon 2' },
    ]);
  });

  it('filters raw source names from source options', () => {
    const options = desktopSourceOptions(card({
      sourceDevices: [
        { name: 'A84041A75D5E7CFB', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'raw' },
        { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'safe' },
      ],
    }));
    expect(options).toEqual([
      { key: null, label: 'All' },
      { key: 'safe', label: 'Chameleon 1' },
    ]);
  });

  it('keeps only card-advertised views', () => {
    expect(selectableDesktopViews(card()).map((entry) => entry.view)).toEqual([
      'soil-profile',
      'line-chart',
      'calendar',
      'irrigation-response',
      'advanced',
    ]);
  });

  it('unions requested bounds and data bounds so the viewport remains representable', () => {
    expect(desktopBoundsForData(
      { minMs: 100, maxMs: 200 },
      { minMs: 120, maxMs: 150 },
    )).toEqual({ minMs: 100, maxMs: 200 });
  });
});
```

- [ ] **Step 2: Run the helper test and verify it fails.**

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode/web/react-gui
npx vitest run src/history/__tests__/desktopHistory.test.ts
```

Expected: FAIL because `../desktopHistory` does not exist.

- [ ] **Step 3: Implement the helper module.**

Create `web/react-gui/src/history/desktopHistory.ts`:

```ts
import { historyCardDefinitionsByType } from './cardDefinitions';
import type { HistoryCardSummary, HistoryViewMode } from './types';
import type { ViewportBounds } from './historyViewport';

export interface DesktopSourceOption {
  key: string | null;
  label: string;
}

export interface DesktopViewOption {
  view: HistoryViewMode;
  labelKey: string;
}

function cleanText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isRawHistoryIdentifier(value: string | null | undefined): boolean {
  const text = cleanText(value);
  return /^[A-Fa-f0-9]{16}$/.test(text) || /\b(?:soil|dendro|environment|gateway)-src-[a-z0-9-]+\b/i.test(text);
}

export function safeHistoryLabel(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text || isRawHistoryIdentifier(text)) return null;
  return text;
}

function titleWithoutThemePrefix(card: HistoryCardSummary): string {
  const title = safeHistoryLabel(card.title) ?? card.cardType;
  if (card.cardType === 'dendro') return title.replace(/^Dendro\\s*-\\s*/i, '').trim() || title;
  return title;
}

export function desktopRailCardLabel(card: HistoryCardSummary): string {
  const count = card.sourceDeviceCount ?? card.sourceDevices?.length ?? card.sourceLabels?.length ?? 0;
  const singleSourceLabel = count === 1
    ? safeHistoryLabel(card.sourceLabel ?? card.sourceLabels?.[0] ?? card.sourceDevices?.[0]?.name)
    : null;
  return singleSourceLabel ?? safeHistoryLabel(card.title) ?? card.cardType;
}

export function desktopCardHeaderTitle(card: HistoryCardSummary, zoneName: string | null): string {
  const zone = safeHistoryLabel(zoneName);
  const count = card.sourceDeviceCount ?? card.sourceDevices?.length ?? card.sourceLabels?.length ?? 0;
  const source = count === 1
    ? safeHistoryLabel(card.sourceLabel ?? card.sourceLabels?.[0] ?? card.sourceDevices?.[0]?.name)
    : null;
  const title = source ? `${source} - ${titleWithoutThemePrefix(card)}` : (safeHistoryLabel(card.title) ?? card.cardType);
  if (card.scope !== 'zone' || !zone || title.toLocaleLowerCase().includes(zone.toLocaleLowerCase())) return title;
  return `${title} ${zone}`;
}

export function desktopSourceOptions(card: HistoryCardSummary): DesktopSourceOption[] {
  const sources = (card.sourceDevices ?? []).reduce<DesktopSourceOption[]>((options, device) => {
    const key = cleanText(device.sourceKey);
    const label = safeHistoryLabel(device.name);
    if (!key || !label || options.some((option) => option.key === key || option.label === label)) return options;
    options.push({ key, label });
    return options;
  }, []);
  if (sources.length <= 1) return [];
  return [{ key: null, label: 'All' }, ...sources];
}

export function selectableDesktopViews(card: HistoryCardSummary): DesktopViewOption[] {
  const definition = historyCardDefinitionsByType[card.cardType];
  const allowedViews = new Set<HistoryViewMode>(definition?.views ?? []);
  const views = card.views.filter((view) => allowedViews.has(view));
  const resolved = views.length > 0 ? views : [card.defaultView];
  return resolved.map((view) => ({ view, labelKey: `history.viewMode.${view}` }));
}

export function defaultDesktopView(card: HistoryCardSummary): HistoryViewMode {
  const views = selectableDesktopViews(card).map((entry) => entry.view);
  return views.includes(card.defaultView) ? card.defaultView : views[0] ?? card.defaultView;
}

export function desktopBoundsForData(requested: ViewportBounds, dataBounds: ViewportBounds | null): ViewportBounds {
  if (!dataBounds) return requested;
  return {
    minMs: Math.min(requested.minMs, dataBounds.minMs),
    maxMs: Math.max(requested.maxMs, dataBounds.maxMs),
  };
}
```

- [ ] **Step 4: Run the helper test and verify it passes.**

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode/web/react-gui
npx vitest run src/history/__tests__/desktopHistory.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1.**

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode
git add web/react-gui/src/history/desktopHistory.ts web/react-gui/src/history/__tests__/desktopHistory.test.ts
git commit -m "feat(history): add desktop history display helpers"
```

## Task 2: Fix Desktop Chart Height And Viewport Bounds

**Files:**
- Modify: `web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx`
- Modify: `web/react-gui/src/components/history/desktop/HistoryCompareGrid.tsx`
- Modify: `web/react-gui/src/components/history/desktop/HistoryOverviewStrip.tsx`
- Modify: `web/react-gui/src/components/history/__tests__/HistoryDesktopDetail.test.tsx`
- Modify: `web/react-gui/src/components/history/__tests__/HistoryCompareGrid.test.tsx`
- Create: `web/react-gui/src/components/history/__tests__/HistoryOverviewStrip.test.tsx`

- [ ] **Step 1: Add failing layout and overview tests.**

Append these tests to `HistoryDesktopDetail.test.tsx`:

```ts
it('provides a flex height contract for Recharts visualizations', () => {
  const card = makeCard();
  renderDesktopDetail([card], card);
  const surface = screen.getByTestId('desktop-chart-surface');
  expect(surface).toHaveClass('flex');
  expect(surface).toHaveClass('flex-col');
  expect(surface.firstElementChild).toHaveClass('min-h-0');
  expect(surface.firstElementChild).toHaveClass('flex-1');
});
```

Append this test to `HistoryCompareGrid.test.tsx`:

```ts
it('wraps each panel visualization in a flex height container', () => {
  const cards = makeCards(2);
  renderGrid(cards);
  const panels = screen.getAllByTestId('compare-panel');
  for (const panel of panels) {
    const wrapper = panel.querySelector('[data-testid="compare-panel-visualization"]');
    expect(wrapper).toHaveClass('min-h-0');
    expect(wrapper).toHaveClass('flex-1');
  }
});
```

Create `web/react-gui/src/components/history/__tests__/HistoryOverviewStrip.test.tsx`:

```ts
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HistoryOverviewStrip } from '../desktop/HistoryOverviewStrip';

describe('HistoryOverviewStrip', () => {
  it('clamps invalid viewport percentages into the visible overview range', () => {
    render(
      <HistoryOverviewStrip
        bounds={{ minMs: 100, maxMs: 200 }}
        viewport={{ fromMs: 0, toMs: 300 }}
        onChange={vi.fn()}
      />,
    );
    const window = screen.getByTestId('overview-window');
    expect(window.style.left).toBe('0%');
    expect(window.style.width).toBe('100%');
  });
});
```

- [ ] **Step 2: Run focused tests and verify they fail.**

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode/web/react-gui
npx vitest run src/components/history/__tests__/HistoryDesktopDetail.test.tsx src/components/history/__tests__/HistoryCompareGrid.test.tsx src/components/history/__tests__/HistoryOverviewStrip.test.tsx
```

Expected: FAIL on missing flex classes / missing `compare-panel-visualization` / unclamped overview styles.

- [ ] **Step 3: Fix the desktop focus surface height contract and union bounds.**

In `HistoryDesktopDetail.tsx`:

1. Import helpers:

```ts
import {
  defaultDesktopView,
  desktopBoundsForData,
  desktopCardHeaderTitle,
  desktopRailCardLabel,
} from '../../../history/desktopHistory';
```

2. Replace header title computation with:

```ts
const headerTitle = desktopCardHeaderTitle(selectedCard, zoneName);
```

3. Replace `const effectiveBounds = derivedBounds ?? bounds;` with:

```ts
const effectiveBounds = desktopBoundsForData(bounds, derivedBounds);
```

4. Replace the focus chart surface class and visualization child with:

```tsx
<div
  ref={chartRef}
  data-testid="desktop-chart-surface"
  tabIndex={0}
  aria-label={t('history.desktop.chartSurfaceLabel', { defaultValue: 'History chart, use arrow keys to pan and plus or minus to zoom' })}
  onKeyDown={handleKeyDown}
  className="relative flex min-h-0 flex-1 flex-col cursor-crosshair overflow-hidden bg-[var(--bg)] outline-none focus:ring-2 focus:ring-[var(--primary)]"
  style={{ userSelect: 'none' }}
>
  <div className="min-h-0 flex-1">
    <HistoryCardVisualization
      card={selectedCard}
      data={cardData.data}
      selectedView={selectedView}
      isLoading={cardData.isLoading}
      error={cardData.error}
      window={chartWindow}
    />
  </div>
</div>
```

5. Replace rail label expression `normalizedCardTitle(card)` with `desktopRailCardLabel(card)`.

- [ ] **Step 4: Fix compare panel visualization height.**

In `HistoryCompareGrid.tsx`, import `desktopRailCardLabel`:

```ts
import { desktopRailCardLabel } from '../../../history/desktopHistory';
```

Replace the panel title:

```tsx
<span className="text-sm font-medium text-[var(--text)]">{desktopRailCardLabel(card)}</span>
```

Replace the visualization wrapper:

```tsx
<div data-testid="compare-panel-visualization" className="min-h-0 flex-1">
  <HistoryCardVisualization
    card={card}
    data={cardData.data}
    selectedView={defaultView}
    isLoading={cardData.isLoading}
    error={cardData.error}
    window={viewport}
  />
</div>
```

- [ ] **Step 5: Clamp overview percentages.**

In `HistoryOverviewStrip.tsx`, replace the percentage calculations with:

```ts
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

const rawLeftPct = ((viewport.fromMs - bounds.minMs) / total) * 100;
const rawRightPct = ((viewport.toMs - bounds.minMs) / total) * 100;
const leftPct = clampPercent(Math.min(rawLeftPct, rawRightPct));
const rightPct = clampPercent(Math.max(rawLeftPct, rawRightPct));
const widthPct = Math.max(rightPct - leftPct, 2);
```

Keep the rendered style as:

```tsx
style={{ left: `${leftPct}%`, width: `${Math.min(widthPct, 100 - leftPct)}%` }}
```

- [ ] **Step 6: Run focused tests and verify they pass.**

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode/web/react-gui
npx vitest run src/history/__tests__/desktopHistory.test.ts src/components/history/__tests__/HistoryDesktopDetail.test.tsx src/components/history/__tests__/HistoryCompareGrid.test.tsx src/components/history/__tests__/HistoryOverviewStrip.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2.**

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode
git add \
  web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx \
  web/react-gui/src/components/history/desktop/HistoryCompareGrid.tsx \
  web/react-gui/src/components/history/desktop/HistoryOverviewStrip.tsx \
  web/react-gui/src/components/history/__tests__/HistoryDesktopDetail.test.tsx \
  web/react-gui/src/components/history/__tests__/HistoryCompareGrid.test.tsx \
  web/react-gui/src/components/history/__tests__/HistoryOverviewStrip.test.tsx
git commit -m "fix(history): keep desktop chart surfaces measurable"
```

## Task 3: Add Card-Specific Desktop View Selector

**Files:**
- Modify: `web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx`
- Modify: `web/react-gui/src/components/history/__tests__/HistoryDesktopDetail.test.tsx`
- Modify: `web/react-gui/public/locales/{en,de-CH,es,fr,it,lg,pt}/history.json`

- [ ] **Step 1: Add failing view-selector tests.**

Update the `HistoryCardVisualization` mock in `HistoryDesktopDetail.test.tsx` to include the selected view:

```ts
vi.mock('../HistoryCardVisualization', () => ({
  HistoryCardVisualization: ({ card, selectedView }: { card: HistoryCardSummary; selectedView: string }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'card-visualization',
        'data-card-id': card.cardId,
        'data-selected-view': selectedView,
      },
      `Visualization: ${card.cardId}:${selectedView}`,
    ),
}));
```

Append these tests:

```ts
it('renders card-specific view buttons for the selected Soil card', () => {
  const card = makeCard({
    views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
  });
  renderDesktopDetail([card], card);
  expect(screen.getByRole('button', { name: 'Soil Profile' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Line Chart' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Calendar' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Irrigation Response' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Advanced View' })).toBeInTheDocument();
});

it('switches the selected view without changing card route state', () => {
  const card = makeCard({
    views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
  });
  renderDesktopDetail([card], card);
  fireEvent.click(screen.getByRole('button', { name: 'Line Chart' }));
  expect(screen.getByTestId('card-visualization')).toHaveAttribute('data-selected-view', 'line-chart');
  expect(screen.getByRole('button', { name: 'Line Chart' })).toHaveAttribute('aria-pressed', 'true');
});

it('resets the selected view when the selected card changes', () => {
  const soil = makeCard({ cardId: 'soil', defaultView: 'soil-profile', views: ['soil-profile', 'line-chart'] });
  const env = makeCard({
    cardId: 'env',
    cardType: 'environment',
    title: 'Environment - Microclimate',
    defaultView: 'line-chart',
    views: ['line-chart', 'daily-min-max', 'calendar', 'advanced'],
  });
  const { rerender } = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <HistoryDesktopDetail cards={[soil, env]} selectedCard={soil} zoneName="Zone A" scope={baseScope} onCardSelect={vi.fn()} />
    </SWRConfig>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Line Chart' }));
  rerender(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <HistoryDesktopDetail cards={[soil, env]} selectedCard={env} zoneName="Zone A" scope={baseScope} onCardSelect={vi.fn()} />
    </SWRConfig>,
  );
  expect(screen.getByTestId('card-visualization')).toHaveAttribute('data-selected-view', 'line-chart');
  expect(screen.getByRole('button', { name: 'Daily Min/Max' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Mock advanced data and add an Advanced View test.**

Add this mock near the existing `useHistoryCardData` mock:

```ts
vi.mock('../../../history/useHistoryCardAdvancedData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../history/useHistoryCardAdvancedData')>();
  return {
    ...actual,
    useHistoryCardAdvancedData: vi.fn(() => ({
      data: { cardId: 'soil-card:root-zone', cardType: 'soil', advancedFields: {} },
      error: null,
      isLoading: false,
      refresh: vi.fn(),
    })),
  };
});
```

Add:

```ts
it('uses Advanced View when the card-specific Advanced button is selected', () => {
  const card = makeCard({
    views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
  });
  renderDesktopDetail([card], card);
  fireEvent.click(screen.getByRole('button', { name: 'Advanced View' }));
  expect(screen.getByTestId('card-visualization')).toHaveAttribute('data-selected-view', 'advanced');
});
```

- [ ] **Step 3: Run tests and verify they fail.**

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode/web/react-gui
npx vitest run src/components/history/__tests__/HistoryDesktopDetail.test.tsx
```

Expected: FAIL because desktop view buttons are not rendered.

- [ ] **Step 4: Implement selected-view state and buttons.**

In `HistoryDesktopDetail.tsx`:

1. Import `useEffect` and advanced data:

```ts
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useHistoryCardAdvancedData } from '../../../history/useHistoryCardAdvancedData';
```

2. Replace fixed selected view state:

```ts
const [selectedView, setSelectedView] = useState<HistoryViewMode>(() => defaultDesktopView(selectedCard));
```

3. Add:

```ts
const viewOptions = useMemo(() => selectableDesktopViews(selectedCard), [selectedCard]);
const shouldRenderAdvanced = selectedView === 'advanced';

useEffect(() => {
  setSelectedView(defaultDesktopView(selectedCard));
}, [selectedCard.cardId, selectedCard.defaultView]);
```

4. Change normal card-data hook:

```ts
enabled: Boolean(selectedCard.availability.available && !shouldRenderAdvanced),
```

5. Add advanced-data hook:

```ts
const advancedData = useHistoryCardAdvancedData({
  scope,
  cardId: selectedCard.cardId,
  view: selectedView,
  range: rangeRequest,
  aggregation: 'raw',
  overlays: [],
  enabled: Boolean(selectedCard.availability.available && shouldRenderAdvanced),
});
```

6. Pass advanced props:

```tsx
advancedData={advancedData.data}
advancedIsLoading={advancedData.isLoading}
advancedError={advancedData.error}
```

7. Render card-specific view buttons in the header before range presets:

```tsx
<div
  role="group"
  aria-label={t('history.desktop.viewSelectorLabel', { defaultValue: 'Card view' })}
  className="flex overflow-hidden rounded border border-[var(--border)]"
>
  {viewOptions.map(({ view, labelKey }) => (
    <button
      key={view}
      type="button"
      aria-pressed={selectedView === view}
      onClick={() => setSelectedView(view)}
      className={`px-2 py-1 text-xs font-semibold transition-colors ${
        selectedView === view
          ? 'bg-[var(--primary)] text-white'
          : 'bg-[var(--secondary-bg)] text-[var(--text)] hover:bg-[var(--border)]'
      }`}
    >
      {t(labelKey)}
    </button>
  ))}
</div>
```

- [ ] **Step 5: Add locale keys.**

In every `web/react-gui/public/locales/*/history.json`, add the following keys inside `history.desktop`:

```json
"modeLabel": "Desktop mode",
"modeFocus": "Focus",
"modeCompare": "Compare",
"viewSelectorLabel": "Card view",
"chartSurfaceLabel": "History chart, use arrow keys to pan and plus or minus to zoom"
```

Use the same English strings for non-English locale files in this pass. The existing i18n issue can refine translations later.

- [ ] **Step 6: Run focused tests and verify they pass.**

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode/web/react-gui
npx vitest run src/components/history/__tests__/HistoryDesktopDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3.**

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode
git add \
  web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx \
  web/react-gui/src/components/history/__tests__/HistoryDesktopDetail.test.tsx \
  web/react-gui/public/locales/de-CH/history.json \
  web/react-gui/public/locales/en/history.json \
  web/react-gui/public/locales/es/history.json \
  web/react-gui/public/locales/fr/history.json \
  web/react-gui/public/locales/it/history.json \
  web/react-gui/public/locales/lg/history.json \
  web/react-gui/public/locales/pt/history.json
git commit -m "feat(history): add desktop card view selector"
```

## Task 4: Add Merged Soil Source Selector And Distinguishing Labels

**Files:**
- Modify: `web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx`
- Modify: `web/react-gui/src/components/history/desktop/HistoryCompareGrid.tsx`
- Modify: `web/react-gui/src/components/history/__tests__/HistoryDesktopDetail.test.tsx`
- Modify: `web/react-gui/src/components/history/__tests__/HistoryCompareGrid.test.tsx`
- Modify: `web/react-gui/public/locales/{en,de-CH,es,fr,it,lg,pt}/history.json`

- [ ] **Step 1: Add failing source-selector tests.**

At the top of `HistoryDesktopDetail.test.tsx`, import the mocked hook:

```ts
import { useHistoryCardData } from '../../../history/useHistoryCardData';
```

Append:

```ts
it('renders an All/per-source selector for merged Soil cards', () => {
  const card = makeCard({
    sourceDeviceCount: 2,
    sourceDevices: [
      { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-one' },
      { name: 'Chameleon 2', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-two' },
    ],
  });
  renderDesktopDetail([card], card, 'Zone B');
  expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Chameleon 1' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Chameleon 2' })).toBeInTheDocument();
});

it('passes selected sourceKey to the card data request', () => {
  const card = makeCard({
    sourceDeviceCount: 2,
    sourceDevices: [
      { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-one' },
      { name: 'Chameleon 2', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-two' },
    ],
  });
  renderDesktopDetail([card], card, 'Zone B');
  fireEvent.click(screen.getByRole('button', { name: 'Chameleon 2' }));
  expect(vi.mocked(useHistoryCardData)).toHaveBeenLastCalledWith(expect.objectContaining({
    sourceKey: 'soil-src-two',
  }));
});

it('does not render raw source identifiers in desktop source controls', () => {
  const card = makeCard({
    sourceDeviceCount: 2,
    sourceDevices: [
      { name: 'A84041A75D5E7CFB', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-raw' },
      { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-safe' },
    ],
  });
  renderDesktopDetail([card], card, 'Zone B');
  expect(screen.queryByText('A84041A75D5E7CFB')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Chameleon 1' })).toBeInTheDocument();
});

it('distinguishes repeated dendro cards by source label in the rail', () => {
  const dendro1 = makeCard({
    cardId: 'dendro-1',
    cardType: 'dendro',
    title: 'Dendro - Growth Timeline',
    sourceLabel: 'Dendro 1',
    sourceLabels: ['Dendro 1'],
    sourceDeviceCount: 1,
    defaultView: 'growth-timeline',
    views: ['growth-timeline', 'line-chart', 'stress-events', 'calendar', 'advanced'],
  });
  const dendro2 = makeCard({
    cardId: 'dendro-2',
    cardType: 'dendro',
    title: 'Dendro - Growth Timeline',
    sourceLabel: 'Dendro 2',
    sourceLabels: ['Dendro 2'],
    sourceDeviceCount: 1,
    defaultView: 'growth-timeline',
    views: ['growth-timeline', 'line-chart', 'stress-events', 'calendar', 'advanced'],
  });
  renderDesktopDetail([dendro1, dendro2], dendro1, 'Zone A');
  expect(screen.getByRole('button', { name: 'Dendro 1' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Dendro 2' })).toBeInTheDocument();
  expect(screen.getByText('Dendro 1 - Growth Timeline Zone A')).toBeInTheDocument();
});
```

- [ ] **Step 2: Add compare-label regression.**

Append to `HistoryCompareGrid.test.tsx`:

```ts
it('uses display-safe source labels for repeated single-source cards', () => {
  const cards = [
    makeCard({
      cardId: 'dendro-1',
      cardType: 'dendro',
      title: 'Dendro - Growth Timeline',
      sourceLabel: 'Dendro 1',
      sourceLabels: ['Dendro 1'],
      sourceDeviceCount: 1,
    }),
    makeCard({
      cardId: 'dendro-2',
      cardType: 'dendro',
      title: 'Dendro - Growth Timeline',
      sourceLabel: 'Dendro 2',
      sourceLabels: ['Dendro 2'],
      sourceDeviceCount: 1,
    }),
  ];
  renderGrid(cards);
  expect(screen.getByRole('checkbox', { name: 'Dendro 1' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Dendro 2' })).toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests and verify they fail.**

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode/web/react-gui
npx vitest run src/components/history/__tests__/HistoryDesktopDetail.test.tsx src/components/history/__tests__/HistoryCompareGrid.test.tsx
```

Expected: FAIL because source selector and compare checkbox labels are not fully wired.

- [ ] **Step 4: Implement source state and controls.**

In `HistoryDesktopDetail.tsx`:

1. Import:

```ts
import { desktopSourceOptions } from '../../../history/desktopHistory';
```

2. Add state:

```ts
const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null);
const sourceOptions = useMemo(() => desktopSourceOptions(selectedCard), [selectedCard]);
```

3. Reset source on card change:

```ts
useEffect(() => {
  setSelectedSourceKey(null);
}, [selectedCard.cardId]);
```

4. Pass to normal and advanced data hooks:

```ts
sourceKey: selectedSourceKey ?? undefined,
```

5. Render source buttons after view buttons:

```tsx
{sourceOptions.length > 0 && (
  <div
    role="group"
    aria-label={t('history.desktop.sourceSelectorLabel', { defaultValue: 'Card source' })}
    className="flex overflow-hidden rounded border border-[var(--border)]"
  >
    {sourceOptions.map((source) => (
      <button
        key={source.key ?? 'all'}
        type="button"
        aria-pressed={selectedSourceKey === source.key}
        onClick={() => setSelectedSourceKey(source.key)}
        className={`px-2 py-1 text-xs font-semibold transition-colors ${
          selectedSourceKey === source.key
            ? 'bg-[var(--primary)] text-white'
            : 'bg-[var(--secondary-bg)] text-[var(--text)] hover:bg-[var(--border)]'
        }`}
      >
        {source.label}
      </button>
    ))}
  </div>
)}
```

- [ ] **Step 5: Wire compare labels.**

In `HistoryCompareGrid.tsx`, replace checkbox label computation:

```ts
const label = desktopRailCardLabel(card);
```

Keep `aria-label={label}` and visible `<span>{label}</span>`.

- [ ] **Step 6: Add locale keys.**

In every `web/react-gui/public/locales/*/history.json`, add inside `history.desktop`:

```json
"sourceSelectorLabel": "Card source"
```

- [ ] **Step 7: Run focused tests and verify they pass.**

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode/web/react-gui
npx vitest run src/history/__tests__/desktopHistory.test.ts src/components/history/__tests__/HistoryDesktopDetail.test.tsx src/components/history/__tests__/HistoryCompareGrid.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4.**

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode
git add \
  web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx \
  web/react-gui/src/components/history/desktop/HistoryCompareGrid.tsx \
  web/react-gui/src/components/history/__tests__/HistoryDesktopDetail.test.tsx \
  web/react-gui/src/components/history/__tests__/HistoryCompareGrid.test.tsx \
  web/react-gui/public/locales/de-CH/history.json \
  web/react-gui/public/locales/en/history.json \
  web/react-gui/public/locales/es/history.json \
  web/react-gui/public/locales/fr/history.json \
  web/react-gui/public/locales/it/history.json \
  web/react-gui/public/locales/lg/history.json \
  web/react-gui/public/locales/pt/history.json
git commit -m "feat(history): expose merged soil sources on desktop"
```

## Task 5: Full Verification And Live Kaba100 QA

**Files:**
- Modify only if verification reveals a doc update is needed:
  - `docs/ux/history-data-visualization-kaba100-issues.md`

- [ ] **Step 1: Run full local GUI verification.**

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode/web/react-gui
npm run test:unit
npm run build
```

Expected:

- `npm run test:unit`: PASS.
- `npm run build`: PASS.
- Built asset appears under `build/assets/index-*.js`.

- [ ] **Step 2: Deploy GUI-only to kaba100 if the user wants the live fix installed.**

Run only after confirming this is still the requested live target:

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode/web/react-gui
LOCAL_ASSET=$(grep -o 'assets/index-[^" ]*\.js' build/index.html | head -n1)
tar -C build -cf - . | SSH_AUTH_SOCK=/home/phil/.ssh/agent/s.dUaIkoc630.agent.Cs3Bf1Nutw ssh -o BatchMode=yes root@100.93.68.86 'tar -C /usr/lib/node-red/gui -xf -'
SERVED_ASSET=$(curl -fsSL http://100.93.68.86:1880/gui/ | grep -o 'assets/index-[^" ]*\.js' | head -n1)
printf 'local_asset=%s\nserved_asset=%s\n' "$LOCAL_ASSET" "$SERVED_ASSET"
test "$LOCAL_ASSET" = "$SERVED_ASSET"
```

Expected: local and served assets match. This command writes only static GUI files under `/usr/lib/node-red/gui`.

- [ ] **Step 3: Run live Playwright desktop/mobile verification.**

Create `/tmp/osi-history-desktop-live-fixes.mjs` with this check script:

```js
const { chromium } = require('/home/phil/playwright-osi/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://100.93.68.86:1880';
const OUT = '/home/phil/playwright-osi/screenshots-desktop-live-fixes-2026-06-07';
fs.mkdirSync(OUT, { recursive: true });
const state = JSON.parse(fs.readFileSync('/home/phil/playwright-osi/tmp/kaba100-admin-auth-state.json', 'utf8'));
const token = (state.origins || []).flatMap((origin) => origin.localStorage || []).find((entry) => entry.name === 'auth_token')?.value;
if (!token) throw new Error('missing kaba100 admin auth token');

async function newContext(browser, viewport, mobile = false) {
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: mobile ? 3 : 1,
  });
  await context.addInitScript(({ token }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('username', 'admin');
    localStorage.setItem('i18n_language', 'en');
  }, { token });
  return context;
}

function bodyText(page) {
  return page.locator('body').innerText().then((text) => text.replace(/\s+/g, ' ').trim());
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const consoleLines = [];

  const desktopContext = await newContext(browser, { width: 1440, height: 900 });
  const desktop = await desktopContext.newPage();
  desktop.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) consoleLines.push(`[desktop:${msg.type()}] ${msg.text()}`);
  });
  desktop.on('pageerror', (error) => consoleLines.push(`[desktop:pageerror] ${error.message}`));

  await desktop.goto(`${BASE}/gui/#/history/zones/12`, { waitUntil: 'domcontentloaded' });
  await desktop.getByTestId('desktop-chart-surface').waitFor({ state: 'visible', timeout: 20000 });
  await desktop.waitForTimeout(1500);
  await desktop.screenshot({ path: path.join(OUT, 'zone-b-soil-profile.png'), fullPage: false });

  await desktop.getByRole('button', { name: 'Line Chart' }).click();
  await desktop.waitForTimeout(1500);
  const zoneBLineSvgCount = await desktop.locator('svg').count();
  await desktop.screenshot({ path: path.join(OUT, 'zone-b-line-chart.png'), fullPage: false });

  await desktop.getByRole('button', { name: 'Chameleon 2' }).click();
  await desktop.waitForTimeout(1500);
  await desktop.screenshot({ path: path.join(OUT, 'zone-b-chameleon-2.png'), fullPage: false });

  const zoneBText = await bodyText(desktop);

  await desktop.goto(`${BASE}/gui/#/history/zones/3`, { waitUntil: 'domcontentloaded' });
  await desktop.getByTestId('desktop-chart-surface').waitFor({ state: 'visible', timeout: 20000 });
  await desktop.waitForTimeout(2000);
  const zoneASvgCount = await desktop.locator('svg').count();
  const zoneAText = await bodyText(desktop);
  await desktop.screenshot({ path: path.join(OUT, 'zone-a-focus.png'), fullPage: false });

  await desktop.getByTestId('mode-compare').click();
  await desktop.waitForTimeout(1500);
  await desktop.screenshot({ path: path.join(OUT, 'zone-a-compare.png'), fullPage: false });

  const mobileContext = await newContext(browser, { width: 390, height: 844 }, true);
  const mobile = await mobileContext.newPage();
  mobile.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) consoleLines.push(`[mobile:${msg.type()}] ${msg.text()}`);
  });
  mobile.on('pageerror', (error) => consoleLines.push(`[mobile:pageerror] ${error.message}`));
  await mobile.goto(`${BASE}/gui/#/history/zones/12`, { waitUntil: 'domcontentloaded' });
  await mobile.getByTestId('history-visualization-surface').waitFor({ state: 'visible', timeout: 20000 });
  await mobile.screenshot({ path: path.join(OUT, 'mobile-zone-b.png'), fullPage: false });

  const result = {
    zoneBLineSvgCount,
    zoneBHasSourceControls: /All/.test(zoneBText) && /Chameleon 1/.test(zoneBText) && /Chameleon 2/.test(zoneBText),
    zoneBNoRawEui: !/\b[A-Fa-f0-9]{16}\b/.test(zoneBText),
    zoneASvgCount,
    zoneAHasDistinctDendroLabels: /Dendro 1/.test(zoneAText) && /Dendro 2/.test(zoneAText),
    consoleLines,
    screenshotDir: OUT,
  };
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
```

Run:

```bash
node /tmp/osi-history-desktop-live-fixes.mjs
```

Expected:

- `zoneBLineSvgCount > 0`.
- `zoneBHasSourceControls === true`.
- `zoneBNoRawEui === true`.
- `zoneASvgCount > 0`.
- `zoneAHasDistinctDendroLabels === true`.
- `consoleLines` has no app errors and no passive-listener warnings.

- [ ] **Step 4: Update the kaba100 issue document with results.**

If live QA passes, append a short status note to `docs/ux/history-data-visualization-kaba100-issues.md`:

```md
Status after desktop live fixes:

- Desktop card-specific views are selectable on Zone B.
- Zone B remains one merged Soil Moisture card with All / Chameleon 1 / Chameleon 2 source controls.
- Zone A Dendro/Environment Recharts visualizations mount nonblank SVG charts.
- No raw 16-hex DevEUI is visible in normal desktop mode.
- Screenshots: /home/phil/playwright-osi/screenshots-desktop-live-fixes-2026-06-07/
```

If live QA fails, append the failing assertion and screenshot path instead of marking it resolved.

- [ ] **Step 5: Commit Task 5 if docs changed.**

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode
git add docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "docs(history): record desktop live fix verification"
```

If docs did not change, do not create an empty commit.

## Final Verification Checklist

Run before claiming the implementation is complete:

```bash
cd /home/phil/Repos/osi-os/.worktrees/desktop-mode/web/react-gui
npm run test:unit
npm run build
```

If live-deployed:

```bash
curl -fsSL http://100.93.68.86:1880/gui/ | grep -o 'assets/index-[^" ]*\.js' | head -n1
node /tmp/osi-history-desktop-live-fixes.mjs
```

Manual/human check still required on the demo device:

- Mouse wheel zoom feel.
- Drag-pan feel.
- Crosshair/tooltip smoothness.
- Whether Chameleon 2's source-level no-data state is understandable to a farmer.

## Plan Self-Review

- Spec coverage: fixes desktop card-specific views, desktop single-card chart visibility, basic compare rendering, merged-source visibility, no raw DevEUI, and mobile non-regression.
- Code quality risks addressed:
  - Repeated label/source logic is centralized in `desktopHistory.ts` instead of duplicated in rail, header, and compare.
  - No backend, flow, DB, or firmware scope is introduced.
  - Recharts height is fixed at the shared desktop surface boundary rather than by per-chart fixed heights.
- Known remaining gap:
  - Source-level hardware status for Chameleon/I2C missing depends on what the card summary exposes. This plan displays source names and filters by `sourceKey`; richer status badges can be a later API-backed slice.
