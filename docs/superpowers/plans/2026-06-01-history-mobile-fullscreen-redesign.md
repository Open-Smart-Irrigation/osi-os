# History Mobile Fullscreen Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the OSI OS History mobile UX so `/history` is a compact card overview and tapping a card opens a route-backed full-screen history detail with first-class pinch zoom, pan, inspect, and range controls.

**Architecture:** Keep the existing thematic-card API, card ordering, workspace, aggregation, and Advanced View contracts. Split the mobile UX into an overview route and a route-backed card detail route: `#/history` lists compact farmer-facing cards, and `#/history/zones/:zoneId/cards/:cardId` owns the visualization, controls, gestures, inspector sheet, and Advanced settings. Use pointer-event gesture handling on the visualization surface so normal page scrolling remains intact outside the full-screen chart/profile area.

**Tech Stack:** OSI OS Vite React, React Router hash routes, TypeScript, SWR, i18next, Recharts, existing Node-RED `/api/history/*` endpoints, existing `osi-history-helper`, Vitest/Testing Library, local Playwright for live kaba100 UX checks.

---

## Locked Product Decisions

- Mobile overview must look and feel closer to the current OSI OS dashboard cards than the current dense History detail card.
- Mobile card tap opens a route-backed full-screen detail page, not an inline card expansion and not an overlay-only modal.
- The mobile overview default is a vertical card list, not a horizontal carousel, unless the product owner explicitly reverses this before Slice 2 starts.
- Mobile comparison and saved workspace controls are desktop-only for this redesign round. Mobile may show pinned cards and card detail links, but it must not show `Single`, `Comparison`, `Save workspace`, or `Update workspace` controls.
- The mobile header must be compact. Language, legacy dashboard, and logout actions move behind an overflow/menu pattern on mobile so cards are visible in the first viewport.
- Pinch in/out for date/time selection is core scope:
  - Pinch open, fingers move apart: zoom in to a narrower time window and more raw detail.
  - Pinch close, fingers move together: zoom out to a wider time window and stronger aggregation.
  - Pinch anchor is the midpoint of the two fingers inside the visualization surface.
- `/history` must remain scrollable and low-clutter on mobile.
- Advanced View remains available, but on mobile it moves behind card settings instead of competing with primary farmer view modes.
- Normal farmer UI may show display-safe source names like `Chameleon 1`; raw DevEUI and diagnostics remain Advanced View only.
- Calendar view must use a recognizable paper-calendar month grid. Days are cells in a month overview and are color-coded by theme-specific state.
- OSI OS work remains edge-only in this plan. Do not touch `osi-server` unless a later plan explicitly includes the cloud app.
- Gateway history needs a hub-scoped route before mobile can claim full Gateway Card support. The default plan adds `#/history/gateways/:gatewayEui/cards/:cardId` in the same route-family as zone cards.

## Review Consolidation

The external review and live verification produced several valid blockers. This plan incorporates them as hard constraints:

- Fix visible interpretation i18n leaks before mobile redesign work starts. `history.interpretation.dataCoverageGap.*` and `history.interpretation.incompleteNightRecovery.*` are emitted by `osi-history-helper` and must exist in all seven locale files.
- Remove the desktop toolbar placeholder in preflight. It is already visible in production and should not wait until a late mobile slice.
- Lock the mobile overview layout decision before implementation. Default is a vertical card list because it matches the existing dashboard card scan pattern and reduces carousel/gesture conflict.
- Treat backend `sourceKey` filtering as required for merged Soil and Environment cards. Current card data does not expose enough per-point provenance for reliable client-only filtering.
- Add browser-driven smoke checks before the final live test. Route loading gets a Playwright smoke after Slice 1, and gesture behavior gets a Playwright smoke immediately after the gesture surface lands.
- HashRouter live URLs must use `#/history/...`; card IDs must be encoded with `encodeURIComponent` and decoded once on the detail route.
- Do not ship midpoint-only long press. The inspector timestamp must be derived from the touched x-position within the current viewport, even before full chart hit-testing exists.
- Pinning remains part of the mobile overview. Cards expose a compact pin/unpin control without showing workspace controls.
- Every slice that adds i18n keys must update all seven locale files symmetrically: `de-CH`, `en`, `es`, `fr`, `it`, `lg`, `pt`.
- Screenshots must be saved to a persistent path, not `/tmp`.

## Source Documents And Local Rules

Read these before executing:

- `/home/phil/Repos/osi-os/AGENTS.md`
- `/home/phil/Repos/osi-os/docs/ux/history-data-visualization-redesign-spec.md`
- `/home/phil/Repos/osi-os/docs/ux/history-data-visualization-gap-analysis.md`
- `/home/phil/Repos/osi-os/docs/ux/history-data-visualization-kaba100-issues.md`
- `/home/phil/Repos/osi-os/docs/adr/2026-05-28-static-device-plugin-registry.md`
- `/home/phil/Repos/osi-os/architect.yaml`
- `/home/phil/Repos/osi-os/RULES.yaml`

The TypeScript rule overlay says:

- Keep API normalization in `web/react-gui/src/services/api.ts`.
- Keep domain types in `web/react-gui/src/history/types.ts` and `web/react-gui/src/types/*`.
- Tests must cover user-visible behavior and use `npm run test:unit`.
- Do not move local API normalization into presentational components.

## Branching, Commit, And Review Protocol

Use the current history branch or create a new branch from it after the current live-test fixes are committed.

```bash
cd /home/phil/Repos/osi-os
git status --short --branch
git switch feat/history-data-visualization
git rev-parse HEAD
```

Preflight rule:

- If there are uncommitted kaba100 issue fixes, commit them before starting this redesign.
- Do not mix the existing source-label/data fixes with the mobile fullscreen redesign commits.
- Do not delete ambiguous temp files; this repo has active temporary artifacts from previous work.

Commit and review rule for every slice:

1. Run the slice verification commands.
2. Commit the slice with one focused commit.
3. Ask for review.
4. Fix review findings in one or more `fix:` commits.
5. Run the same verification again.
6. Ask for a second review.
7. Continue only when the second review has no blockers.
8. If the second review still has blockers, do one more fix pass and request a third review.
9. If review 3 still has blockers or the reviewer disputes product direction, stop and escalate the exact decision.

Review prompt template:

```text
Please review Slice N of the OSI OS History mobile fullscreen redesign.

Plan:
- /home/phil/Repos/osi-os/docs/superpowers/plans/2026-06-01-history-mobile-fullscreen-redesign.md

Spec sources:
- /home/phil/Repos/osi-os/docs/ux/history-data-visualization-redesign-spec.md
- /home/phil/Repos/osi-os/docs/ux/history-data-visualization-kaba100-issues.md

Focus:
- route-backed full-screen mobile detail behavior
- pinch zoom and gesture target separation
- farmer-facing card clarity and low clutter
- no raw hardware IDs in normal mode
- backwards compatibility with desktop and legacy dashboard
- code quality and test coverage

Return blocking findings first, then non-blocking improvements.
```

## Common Verification Commands

Use these as the baseline unless a slice gives a narrower command.

```bash
cd /home/phil/Repos/osi-os
git diff --check
node scripts/verify-history-api-contract.js
node scripts/verify-sync-flow.js
node scripts/verify-db-schema-consistency.js
scripts/check-mqtt-topics.sh

cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit
npm run build
```

## Inter-Slice Browser UX Gates

Rendered UX verification is required between implementation phases, not only at final deploy.

Browser tool policy:

- If the Browser plugin is available in the execution session, use it and follow the Browser skill.
- If the Browser plugin is absent, use regular Playwright and record `Browser plugin not available; used Playwright`.
- Do not write screenshots, traces, or temporary Playwright scripts into the repo unless the product owner explicitly asks for committed artifacts.
- Save screenshots under `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-N/`.
- Temporary Playwright scripts should live under `/home/phil/playwright-osi/tmp/`.

Required checks for each browser gate:

- Page identity: URL/hash matches the expected route.
- Not blank: first meaningful History content renders.
- No framework overlay: no Vite/React error overlay.
- Console health: no relevant `error` or `warning`; specifically no passive `preventDefault` wheel/touch error.
- Screenshot evidence: mobile viewport screenshot at iPhone 13 size; desktop screenshot when the slice touches desktop.
- Interaction proof: exercise the slice's main user action and assert the visible state changed.

Gate matrix:

| Slice | Browser UX gate |
| --- | --- |
| Slice 1 | Route smoke: direct detail route resolves, encoded `:` card ID round-trips, back link returns to `#/history`. |
| Slice 2 | Mobile overview smoke: first viewport shows compact header, zone selector, and overview cards; no inline timeline or workspace/comparison controls. |
| Slice 3 | Detail controls smoke: `12h`, `24h`, `7D`, `30D`, `Season` controls are visible; tapping a range changes the range label and refetches card data. |
| Slice 5 | Gesture smoke: pinch open narrows range, pinch close widens range, one-finger drag pans, double tap resets, no chart blanking. |
| Slice 6 | Calendar smoke: Calendar view renders a month grid with weekday headers and color-coded day cells; tapping/long-pressing a day opens the inspector for that date. |
| Slice 7 | Placeholder/source smoke: Soil Line Chart, Soil Irrigation Response, Dendro Line Chart, and Dendro Stress Events do not show the generic placeholder; source chip refetches with `sourceKey`. |
| Slice 8 | Inspector/settings smoke: long press opens inspector at touched timestamp; Advanced View opens from settings and raw identifiers only appear there. |
| Slice 9 | Full live kaba100 regression: run the complete mobile and desktop flow on the deployed Pi. |

Each browser gate should produce a short QA note in the slice review request:

```text
Browser UX gate:
- Tool: Browser plugin | Playwright fallback
- URL:
- Viewports:
- Interaction:
- Console:
- Screenshots:
- Result:
```

## File Map

Create:

- `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
  Route-backed full-screen detail page for a single thematic card.

- `web/react-gui/src/components/history/mobile/HistoryOverviewCard.tsx`
  Compact farmer-facing overview card modeled after the current dashboard card style.

- `web/react-gui/src/components/history/mobile/HistoryMobileHeader.tsx`
  Compact mobile header for `/history` that keeps actions reachable without consuming half the first viewport.

- `web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx`
  Full-screen top bar with back navigation, card title, source label, sync/freshness metadata, and settings entry.

- `web/react-gui/src/components/history/mobile/HistoryRangeSegmentedControl.tsx`
  Explicit `12h`, `24h`, `7D`, `30D`, `Season` range selector.

- `web/react-gui/src/components/history/mobile/HistoryViewModeSegmentedControl.tsx`
  Card-specific view selector. On mobile it excludes `advanced`; Advanced is opened from settings.

- `web/react-gui/src/components/history/mobile/HistorySourceFilter.tsx`
  Source chips for merged cards, for example `All`, `Chameleon 1`, `Chameleon 2`.

- `web/react-gui/src/components/history/mobile/HistoryVisualizationSurface.tsx`
  Gesture-owning visualization container. Applies `touch-action: none` only to the visualization surface.

- `web/react-gui/src/components/history/mobile/HistoryInspectorSheet.tsx`
  Bottom sheet for selected timestamp/day/cell interpretation and metadata.

- `web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx`
  Paper-calendar-style month grid with color-coded day states and markers.

- `web/react-gui/src/history/gestureModel.ts`
  Pure pointer/pinch math: distance, midpoint anchor, zoom factor, long-press timing, drag threshold.

- `web/react-gui/src/history/useVisualizationGestures.ts`
  React hook that maps pointer events to viewport updates and inspector selection.

- `web/react-gui/src/components/history/visualizations/SoilLineChartView.tsx`
  Real Soil Card line chart, replacing the current placeholder for `line-chart`.

- `web/react-gui/src/components/history/visualizations/SoilIrrigationResponseView.tsx`
  Real Soil Card irrigation response view, replacing the current placeholder for `irrigation-response`.

- `web/react-gui/src/components/history/visualizations/DendroLineChartView.tsx`
  Real Dendro Card line chart, replacing the current placeholder for `line-chart`.

- `web/react-gui/src/components/history/visualizations/DendroStressEventsView.tsx`
  Real Dendro Card stress-event list/timeline, replacing the current placeholder for `stress-events`.

- `web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx`
- `web/react-gui/src/components/history/__tests__/HistoryMobileOverview.test.tsx`
- `web/react-gui/src/components/history/__tests__/HistoryGestureModel.test.ts`
- `web/react-gui/src/components/history/__tests__/HistoryVisualizationSurface.test.tsx`
- `web/react-gui/src/components/history/__tests__/SoilLineChartView.test.tsx`
- `web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`
- `web/react-gui/src/components/history/__tests__/HistoryPlaceholderViews.test.tsx`

Modify:

- `web/react-gui/src/App.tsx`
  Add `Route path="/history/zones/:zoneId/cards/:cardId"` and `Route path="/history/gateways/:gatewayEui/cards/:cardId"`.

- `web/react-gui/src/pages/HistoryDashboard.tsx`
  Keep desktop shell; make mobile shell overview-only. Keep feature flag behavior.

- `web/react-gui/src/components/history/HistoryMobileShell.tsx`
  Remove inline `HistoryCardFrame`; render overview cards that link to the detail route.

- `web/react-gui/src/components/history/HistoryCardFrame.tsx`
  Extract reusable visualization rendering and prevent placeholder views from being selectable without a real implementation.

- `web/react-gui/src/components/history/TimelineBrush.tsx`
  Keep desktop brush behavior; do not make it the mobile gesture owner.

- `web/react-gui/src/history/useTimeViewport.ts`
  Add anchor-aware zoom and explicit range switching helpers.

- `web/react-gui/src/history/types.ts`
  Add mobile detail state, selected source key, inspector selection types, and display-safe `sourceKey` on `HistoryCardSourceDevice`.

- `web/react-gui/src/services/api.ts`
  Add `sourceKey` query serialization for merged Soil and Environment source filters.

- `web/react-gui/public/locales/*/history.json`
  Add labels for full-screen detail, source chips, range controls, inspector sheet, gesture help, and settings.

Possible backend files if source filtering requires API support:

- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js`
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- `scripts/test-history-helper.js`
- `scripts/verify-history-api-contract.js`

## Slice 0 - Preflight Hardening, Decision Lock, And Test Harness

**Purpose:** Fix visible production regressions, lock mobile design decisions, and make sure tests can cover the new route without touching production UI.

**Files:**

- Modify: `docs/ux/history-data-visualization-kaba100-issues.md`
- Modify: `web/react-gui/public/locales/de-CH/history.json`
- Modify: `web/react-gui/public/locales/en/history.json`
- Modify: `web/react-gui/public/locales/es/history.json`
- Modify: `web/react-gui/public/locales/fr/history.json`
- Modify: `web/react-gui/public/locales/it/history.json`
- Modify: `web/react-gui/public/locales/lg/history.json`
- Modify: `web/react-gui/public/locales/pt/history.json`
- Modify: `web/react-gui/src/components/history/HistoryDesktopShell.tsx`
- Modify: `web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx`

- [ ] Step 1: Record the accepted design decisions in the kaba100 issue document.

Add a decision block:

```markdown
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
```

- [ ] Step 2: Record the UX redesign issue cluster in the kaba100 issue document.

Add a new section:

```markdown
### Issue 5 - Mobile History overview is too dense and does not use a true detail surface

Severity: S1

The mobile History page renders the compact carousel card and the full detail card inline. This duplicates title/source/status information, exposes chart controls before the user opens a card, and leaves no dedicated gesture surface for pinch, pan, long press, and pull-to-refresh.

Required direction:

- `/history` becomes a compact mobile overview.
- Tapping a thematic card opens `#/history/zones/:zoneId/cards/:cardId`.
- The full-screen detail route owns range controls, card view modes, source filters, visualization gestures, inspector sheet, and Advanced settings.
- Pinch open/close inside the visualization is core behavior for narrowing/widening the time range.
```

- [ ] Step 3: Fix missing interpretation i18n keys before redesign work starts.

Add symmetric keys under `history.interpretation` in all seven locale files:

```json
"dataCoverageGap": {
  "title": "Sensor data is incomplete",
  "body": "Sensor data was missing during the selected period."
},
"incompleteNightRecovery": {
  "title": "Night recovery was incomplete",
  "body": "The dendrometer did not fully recover overnight during the selected period."
}
```

For non-English locale files, use a correct translation when available. If no translation is available during implementation, use the English fallback in that locale file rather than letting raw keys render to farmers.

- [ ] Step 4: Add a desktop toolbar placeholder regression test.

In `HistoryShell.test.tsx`:

```tsx
it('does not render implementation placeholder copy in the desktop toolbar', async () => {
  renderWithProviders(React.createElement(HistoryDashboard));

  await screen.findByRole('heading', { name: 'History' });
  expect(screen.queryByText(/land here in the visualization slice/i)).not.toBeInTheDocument();
});
```

- [ ] Step 5: Replace visible desktop placeholder copy with real minimal metadata.

Minimal desktop toolbar contents:

- selected range label
- current aggregation badge
- `Single` / `Comparison`
- edge panel cap

Do not add a full desktop redesign in this slice.

- [ ] Step 6: Record shared test helper signatures for later route tests.

Slice 1 or Slice 2 should create helper functions in `HistoryMobileOverview.test.tsx` or a local `historyTestUtils.tsx` in the same `__tests__` directory:

```tsx
function renderHistoryAtMobileWidth(route = '/history') {
  window.innerWidth = 390;
  window.dispatchEvent(new Event('resize'));
  return renderWithProviders(React.createElement(HistoryDashboard), { route });
}

function renderAppAtRoute(route: string) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/history" element={<HistoryDashboard />} />
          <Route path="/history/zones/:zoneId/cards/:cardId" element={<HistoryCardDetailPage />} />
          <Route path="/history/gateways/:gatewayEui/cards/:cardId" element={<HistoryCardDetailPage />} />
        </Routes>
      </MemoryRouter>
    </SWRConfig>,
  );
}
```

Unit tests use MemoryRouter paths such as `/history/zones/12/cards/...`. Live browser and Playwright checks must assert the real HashRouter URL, for example `http://kaba100:1880/gui/#/history/zones/12/cards/soil%3Aroot-zone`.

- [ ] Step 7: Run the preflight regression tests.

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit:vitest -- HistoryShell
npm run test:unit
npm run build
```

- [ ] Step 8: Commit the preflight work.

```bash
cd /home/phil/Repos/osi-os
git add docs/ux/history-data-visualization-kaba100-issues.md web/react-gui/public/locales web/react-gui/src/components/history/HistoryDesktopShell.tsx web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx
git commit -m "fix: harden history ux preflight"
```

## Slice 1 - Route-Backed Fullscreen Detail Shell

**Purpose:** Add the route and page skeleton before moving controls or gestures.

**Files:**

- Modify: `web/react-gui/src/App.tsx`
- Create: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Create: `web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx`
- Test utility: `web/react-gui/src/components/history/__tests__/historyTestUtils.tsx` if shared helpers are extracted

- [ ] Step 1: Write route tests.

Test cases:

```tsx
it('loads the route-backed full-screen detail by zone and encoded card id', async () => {
  const encodedCardId = encodeURIComponent('soil-card:root-zone');
  renderAppAtRoute('/history/zones/12/cards/soil-card%3Aroot-zone');

  await screen.findByRole('heading', { name: 'Soil - Root Zone' });
  expect(decodeURIComponent(encodedCardId)).toBe('soil-card:root-zone');
  expect(screen.getByRole('link', { name: /Back to history/i })).toHaveAttribute('href', expect.stringContaining('/history'));
});

it('shows a safe not-found state when the card id is not in the selected zone', async () => {
  renderAppAtRoute('/history/zones/12/cards/missing-card');

  await screen.findByText(/History card not available/i);
  expect(screen.queryByText(/[A-F0-9]{16}/)).not.toBeInTheDocument();
});

it('loads a hub-scoped gateway card through the gateway route', async () => {
  renderAppAtRoute('/history/gateways/0016C001F11766E7/cards/gateway%3Ahub');

  await screen.findByRole('heading', { name: /Gateway/i });
  expect(screen.queryByText(/[A-F0-9]{16}/)).not.toBeInTheDocument();
});
```

- [ ] Step 2: Add the route.

Modify `App.tsx`:

```tsx
import { HistoryCardDetailPage } from './pages/HistoryCardDetailPage';

<Route
  path="/history/zones/:zoneId/cards/:cardId"
  element={
    <PrivateRoute>
      <HistoryCardDetailPage />
    </PrivateRoute>
  }
/>

<Route
  path="/history/gateways/:gatewayEui/cards/:cardId"
  element={
    <PrivateRoute>
      <HistoryCardDetailPage />
    </PrivateRoute>
  }
/>
```

HashRouter live URL rule:

- Unit tests use route paths inside `MemoryRouter`.
- Rendered links must use `encodeURIComponent(card.cardId)`.
- Live browser URLs must look like `#/history/zones/12/cards/soil-card%3Aroot-zone`.
- Playwright must assert the hash route after tapping a card.

- [ ] Step 3: Implement `HistoryCardDetailPage`.

Required behavior:

- Read `zoneId` and `cardId` via `useParams`.
- Read `gatewayEui` via `useParams` for hub-scoped Gateway Card routes.
- Decode `cardId` with `decodeURIComponent`.
- Load feature flags, zones, and zone cards using existing service hooks/API.
- Reject invalid `zoneId` with a user-safe error.
- Use `historyAPI.markZoneCardOpened(zoneId, cardId)` after the card resolves.
- Render a full-viewport layout: header, controls placeholder, visualization placeholder, inspector placeholder.
- Do not render raw DevEUI in the normal header.

Page skeleton:

```tsx
export const HistoryCardDetailPage: React.FC = () => {
  const { zoneId: rawZoneId, cardId: rawCardId } = useParams();
  const zoneId = Number(rawZoneId);
  const cardId = rawCardId ? decodeURIComponent(rawCardId) : null;

  if (!Number.isInteger(zoneId) || zoneId <= 0 || !cardId) {
    return <HistoryDetailError titleKey="history.detail.invalidRoute" />;
  }

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <HistoryDetailHeader
        zoneName={resolvedZone.name}
        card={resolvedCard}
        sourceLabel={formatHistorySourceLabel(t, resolvedCard)}
        backHref="/history"
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="flex min-h-[calc(100vh-4rem)] flex-col">
        <section className="flex-1" />
      </main>
    </div>
  );
};
```

- [ ] Step 4: Run tests and local browser smoke.

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit:vitest -- HistoryCardDetailPage
npm run build
```

Local Playwright smoke:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
```

In a separate shell, use Playwright to visit `http://127.0.0.1:4173/#/history/zones/12/cards/soil-card%3Aroot-zone` with mocked/authenticated state if the local preview can reach the API. If the route cannot resolve without live API data, document that in the review notes and defer the live route smoke to the first kaba100 deploy after Slice 2.

- [ ] Step 5: Commit.

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/App.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx
git commit -m "feat: add route-backed history card detail"
```

## Slice 2 - Compact Mobile Overview Cards

**Purpose:** Make `/history` mobile-first and low-clutter.

**Files:**

- Create: `web/react-gui/src/components/history/mobile/HistoryOverviewCard.tsx`
- Create: `web/react-gui/src/components/history/mobile/HistoryMobileHeader.tsx`
- Modify: `web/react-gui/src/components/history/HistoryMobileShell.tsx`
- Modify: `web/react-gui/src/pages/HistoryDashboard.tsx`
- Modify: `web/react-gui/src/components/history/ThematicCardCarousel.tsx` if it remains shared
- Modify: `web/react-gui/public/locales/*/history.json`
- Test: `web/react-gui/src/components/history/__tests__/HistoryMobileOverview.test.tsx`

- [ ] Step 1: Write card tests.

Required assertions:

```tsx
it('shows title, source, freshness, coverage, and status without chart controls', () => {
  render(<HistoryOverviewCard zoneId={12} card={soilCardWithTwoSources} onTogglePinned={vi.fn()} />);

  expect(screen.getByRole('link', { name: /Soil - Root Zone/i })).toBeInTheDocument();
  expect(screen.getByText('2 sources: Chameleon 1, Chameleon 2')).toBeInTheDocument();
  expect(screen.getByText(/Coverage unknown/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Pin card/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Line Chart/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/[A-F0-9]{16}/)).not.toBeInTheDocument();
});

it('renders compact mobile cards without inline full history detail', async () => {
  renderHistoryAtMobileWidth('/history');

  await screen.findByRole('heading', { name: 'History' });
  expect(screen.getByRole('link', { name: /Soil - Root Zone/i })).toHaveAttribute(
    'href',
    expect.stringContaining('/history/zones/1/cards/'),
  );
  expect(screen.queryByRole('region', { name: 'Timeline viewport' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Soil Profile' })).not.toBeInTheDocument();
});

it('does not show workspace or comparison controls on mobile overview', async () => {
  renderHistoryAtMobileWidth('/history');

  await screen.findByRole('heading', { name: 'History' });
  expect(screen.queryByRole('button', { name: 'Single' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Comparison' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save workspace' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Update workspace' })).not.toBeInTheDocument();
});
```

- [ ] Step 2: Implement `HistoryOverviewCard`.

Design requirements:

- Use current dashboard visual language: `rounded-xl`, `border`, `bg-[var(--surface)]`, `shadow-sm`, large title, compact chips.
- Entire card is a `Link` to `/history/zones/${zoneId}/cards/${encodeURIComponent(card.cardId)}`.
- Render:
  - card type eyebrow
  - card title
  - subtitle
  - display-safe source label
  - coverage chip
  - sync/freshness chip
  - pinned/alert chip
  - compact pin/unpin button that calls `onTogglePinned(card.cardId, !card.ordering.pinned)` without navigating
- Do not render view modes, timeline brush, chart, advanced fields, or raw hardware IDs.

- [ ] Step 3: Modify `HistoryMobileShell`.

New behavior:

- Keep the native zone selector.
- Render a vertical list of `HistoryOverviewCard`.
- Remove inline `HistoryCardFrame`.
- Do not render `HistorySidebar`, saved workspaces, `Single`, `Comparison`, `Save workspace`, or `Update workspace` on mobile.
- Do not keep the horizontal carousel in mobile overview unless the product owner reverses the Slice 0 decision.

- [ ] Step 4: Implement compact mobile header.

`HistoryMobileHeader` behavior:

- Visible only on mobile.
- Shows `History` and a single overflow/settings button.
- Overflow contains language switcher, legacy dashboard link, and logout.
- Keeps the first card visible in the first iPhone 13 viewport when two zones exist.
- Desktop header remains unchanged in this slice.

- [ ] Step 5: Run verification.

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit:vitest -- HistoryMobileOverview HistoryShell
npm run build
```

- [ ] Step 6: Commit.

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/components/history/mobile/HistoryOverviewCard.tsx web/react-gui/src/components/history/mobile/HistoryMobileHeader.tsx web/react-gui/src/components/history/HistoryMobileShell.tsx web/react-gui/src/pages/HistoryDashboard.tsx web/react-gui/src/components/history/ThematicCardCarousel.tsx web/react-gui/src/components/history/__tests__/HistoryMobileOverview.test.tsx web/react-gui/public/locales
git commit -m "feat: simplify mobile history overview cards"
```

## Slice 3 - Explicit Range And View Controls In Detail

**Purpose:** Add the controls missing from the live kaba100 test: `12h`, `24h`, `7D`, `30D`, `Season`, and card-specific view modes.

**Files:**

- Create: `web/react-gui/src/components/history/mobile/HistoryRangeSegmentedControl.tsx`
- Create: `web/react-gui/src/components/history/mobile/HistoryViewModeSegmentedControl.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Modify: `web/react-gui/src/history/useTimeViewport.ts`
- Modify: `web/react-gui/public/locales/*/history.json`
- Test: `web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx`
- Test: `web/react-gui/src/components/history/__tests__/rangeModel.test.ts`

- [ ] Step 1: Write failing tests for visible range controls.

```tsx
it('shows all required range controls on the detail route', async () => {
  renderDetailRoute({ card: soilCard });

  expect(await screen.findByRole('button', { name: '12h' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '24h' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '7D' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '30D' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Season' })).toBeInTheDocument();
});
```

- [ ] Step 2: Add explicit range helper.

In `useTimeViewport.ts`, add:

```ts
export function setTimeViewportRange(
  rangeLabel: Exclude<HistoryRangeLabel, 'custom'>,
  now = new Date(),
  timezone = timezoneForBrowser(),
): HistoryTimeViewport {
  return createDefaultTimeViewport(rangeLabel, now, timezone);
}
```

If `season` is not available for a card, the control remains visible but disabled with a reason from `supportedRanges`.

- [ ] Step 3: Implement range segmented control.

Control rules:

- One row on wide mobile when it fits; wraps to two rows on narrow phones.
- `aria-pressed=true` for active range.
- Disabled unsupported ranges still render so users learn the full model.
- On click, call `onRangeChange(label)` and fetch card data with the new viewport.

- [ ] Step 4: Implement card-specific view control.

Control rules:

- Use `card.views`.
- Exclude `advanced` from the mobile primary control.
- Keep `advanced` reachable via settings in Slice 8.
- Do not introduce a global view mode selector.

- [ ] Step 5: Run verification.

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit:vitest -- HistoryCardDetailPage rangeModel
npm run build
```

- [ ] Step 6: Commit.

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/components/history/mobile/HistoryRangeSegmentedControl.tsx web/react-gui/src/components/history/mobile/HistoryViewModeSegmentedControl.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/history/useTimeViewport.ts web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx web/react-gui/src/components/history/__tests__/rangeModel.test.ts web/react-gui/public/locales
git commit -m "feat: add mobile history range and view controls"
```

## Slice 4 - Pinch/Pan/Reset Gesture Model

**Purpose:** Implement the core pinch date/time selection model in pure functions and a reusable hook.

**Files:**

- Create: `web/react-gui/src/history/gestureModel.ts`
- Create: `web/react-gui/src/history/useVisualizationGestures.ts`
- Modify: `web/react-gui/src/history/useTimeViewport.ts`
- Test: `web/react-gui/src/components/history/__tests__/HistoryGestureModel.test.ts`

- [ ] Step 1: Write pure gesture tests.

Test cases:

```ts
it('pinch open zooms into a narrower anchored time window', () => {
  const viewport = createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich');
  const result = applyPinchZoom(viewport, {
    previousDistancePx: 100,
    nextDistancePx: 140,
    anchorRatio: 0.25,
  });

  expect(durationMs(result)).toBeLessThan(durationMs(viewport));
  expect(result.range.label).toBe('custom');
  expect(result.aggregation).toBe('auto');
});

it('pinch close zooms out to a wider anchored time window', () => {
  const viewport = createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich');
  const result = applyPinchZoom(viewport, {
    previousDistancePx: 140,
    nextDistancePx: 100,
    anchorRatio: 0.75,
  });

  expect(durationMs(result)).toBeGreaterThan(durationMs(viewport));
});

it('small pinch jitter below threshold does not change the viewport', () => {
  const result = applyPinchZoom(viewport, {
    previousDistancePx: 100,
    nextDistancePx: 103,
    anchorRatio: 0.5,
  });

  expect(result).toBe(viewport);
});

it('maps a touched x-position to a timestamp inside the current viewport', () => {
  const viewport = createDefaultTimeViewport('24h', fixedNow, 'Europe/Zurich');
  const timestamp = timestampAtSurfaceRatio(viewport, 0.25);

  expect(Date.parse(timestamp)).toBeGreaterThan(Date.parse(viewport.range.from as string));
  expect(Date.parse(timestamp)).toBeLessThan(Date.parse(viewport.range.to as string));
});
```

- [ ] Step 2: Add anchor-aware viewport helpers.

In `useTimeViewport.ts`, add:

```ts
export function zoomTimeViewportAtRatio(
  viewport: HistoryTimeViewport,
  scale: number,
  anchorRatio: number,
): HistoryTimeViewport

export function panTimeViewportByRatio(
  viewport: HistoryTimeViewport,
  deltaRatio: number,
): HistoryTimeViewport
```

Rules:

- `scale < 1` narrows duration.
- `scale > 1` widens duration.
- `anchorRatio` clamps to `0..1`.
- Keep `MIN_VIEWPORT_MS` and `MAX_VIEWPORT_MS`.
- Return `aggregation: 'auto'` for custom gesture windows.

- [ ] Step 3: Implement `gestureModel.ts`.

Exports:

```ts
export interface PinchZoomInput {
  previousDistancePx: number;
  nextDistancePx: number;
  anchorRatio: number;
}

export interface DragPanInput {
  surfaceWidthPx: number;
  deltaXPx: number;
}

export function distance(a: Point, b: Point): number
export function midpoint(a: Point, b: Point): Point
export function anchorRatioForPoint(pointX: number, surfaceLeft: number, surfaceWidth: number): number
export function applyPinchZoom(viewport: HistoryTimeViewport, input: PinchZoomInput): HistoryTimeViewport
export function applyDragPan(viewport: HistoryTimeViewport, input: DragPanInput): HistoryTimeViewport
export function timestampAtSurfaceRatio(viewport: HistoryTimeViewport, anchorRatio: number): string
export function isLongPress(elapsedMs: number, movedPx: number): boolean
```

Thresholds:

- Pinch ratio threshold: `0.08`.
- Drag dead zone: `6px`.
- Long press: `500ms`, cancelled after `10px` movement.

- [ ] Step 4: Implement `useVisualizationGestures`.

Rules:

- Use Pointer Events, not raw touch events.
- Track active pointers in a `Map<number, Point>`.
- Call `event.currentTarget.setPointerCapture(event.pointerId)` on pointer down.
- The hook returns event handlers and `style: { touchAction: 'none' }`.
- One pointer drag pans the viewport.
- Two pointer pinch zooms using midpoint anchor.
- Double tap resets viewport.
- Long press calls `onInspect({ timestamp })`; timestamp must be derived from the touched x-position inside the current viewport with `timestampAtSurfaceRatio`.
- Do not use the viewport midpoint as a fallback for long press.

- [ ] Step 5: Run browser-level gesture smoke before integrating the real visualizations.

Use a minimal local test fixture rendered by `HistoryVisualizationSurface.test.tsx` or a temporary local preview page. The smoke must verify that two pointer events can trigger the pinch handler in Chromium. Unit tests are not enough because Recharts and SVG descendants can affect pointer propagation after integration.

- [ ] Step 6: Run verification.

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit:vitest -- HistoryGestureModel TimelineBrush
npm run build
```

- [ ] Step 7: Commit.

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/history/gestureModel.ts web/react-gui/src/history/useVisualizationGestures.ts web/react-gui/src/history/useTimeViewport.ts web/react-gui/src/components/history/__tests__/HistoryGestureModel.test.ts
git commit -m "feat: add history pinch and pan gesture model"
```

## Slice 5 - Gesture-Owning Visualization Surface

**Purpose:** Put the gesture hook into the full-screen detail route without breaking desktop timeline brush behavior.

**Files:**

- Create: `web/react-gui/src/components/history/mobile/HistoryVisualizationSurface.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Modify: `web/react-gui/src/components/history/HistoryCardFrame.tsx` or extract visualization render helper
- Test: `web/react-gui/src/components/history/__tests__/HistoryVisualizationSurface.test.tsx`

- [ ] Step 1: Write interaction tests.

Required assertions:

```tsx
it('sets touch-action none only on the visualization surface', () => {
  render(
    <HistoryVisualizationSurface
      viewport={viewport24h}
      defaultRange="24h"
      onViewportChange={vi.fn()}
      onReset={vi.fn()}
      onInspect={vi.fn()}
    >
      <div>Soil profile</div>
    </HistoryVisualizationSurface>,
  );
  expect(screen.getByTestId('history-visualization-surface')).toHaveStyle({ touchAction: 'none' });
});

it('pans the viewport on one-finger horizontal drag', () => {
  const onViewportChange = vi.fn();
  render(
    <HistoryVisualizationSurface
      viewport={viewport24h}
      defaultRange="24h"
      onViewportChange={onViewportChange}
      onReset={vi.fn()}
      onInspect={vi.fn()}
    >
      <div>Soil profile</div>
    </HistoryVisualizationSurface>,
  );
  pointerDrag(screen.getByTestId('history-visualization-surface'), { fromX: 300, toX: 120 });
  expect(onViewportChange).toHaveBeenCalled();
});

it('zooms the viewport on two-pointer pinch', () => {
  const onViewportChange = vi.fn();
  render(
    <HistoryVisualizationSurface
      viewport={viewport24h}
      defaultRange="24h"
      onViewportChange={onViewportChange}
      onReset={vi.fn()}
      onInspect={vi.fn()}
    >
      <div>Soil profile</div>
    </HistoryVisualizationSurface>,
  );
  pointerPinch(screen.getByTestId('history-visualization-surface'), { startDistance: 80, endDistance: 160 });
  expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({ aggregation: 'auto' }));
});

it('refreshes selected card data on pull-down outside the visualization surface', () => {
  const onRefresh = vi.fn();
  renderDetailRoute({ onRefresh });

  pointerDrag(screen.getByTestId('history-detail-scroll-root'), { fromY: 40, toY: 180 });
  expect(onRefresh).toHaveBeenCalled();
});
```

- [ ] Step 2: Implement `HistoryVisualizationSurface`.

Responsibilities:

- Own pointer gestures.
- Render the active visualization child.
- Show active aggregation and range as compact badges.
- Keep browser/page scroll behavior outside the surface.
- Keep Recharts tooltip/hover readable where available; pointer capture happens on the surface only after a gesture starts.
- Expose `data-testid="history-visualization-surface"` for tests.
- Do not place `touch-action: none` on the page root or overview cards.

- [ ] Step 3: Wire into detail page.

The detail route should use:

```tsx
<HistoryVisualizationSurface
  viewport={viewport}
  defaultRange={card.defaultRange}
  onViewportChange={setViewport}
  onReset={resetViewport}
  onInspect={setInspectorSelection}
>
  <HistoryCardVisualization card={card} data={cardData.data} selectedView={selectedView} />
</HistoryVisualizationSurface>
```

- [ ] Step 4: Add pull-to-refresh on mobile detail and overview.

Rules:

- Pull-down on `/history` refreshes zones and card summaries.
- Pull-down on the detail route refreshes selected card data.
- Pull-down inside the visualization surface does not refresh; the surface owns pan/zoom/inspect.
- If mobile browser native pull-to-refresh wins on a real device, keep the explicit refresh button in the header settings menu as a fallback.

- [ ] Step 5: Preserve desktop behavior.

Do not remove `TimelineBrush` from `HistoryCardFrame` or desktop shell in this slice. Desktop wheel/double-click behavior must keep passing.

- [ ] Step 6: Run verification.

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit:vitest -- HistoryVisualizationSurface HistoryCardDetailPage TimelineBrush
npm run build
```

- [ ] Step 7: Run Playwright gesture smoke before continuing.

Run against a local preview first. If the branch has already been deployed to kaba100, also run against `http://100.93.68.86:1880/gui/#/history/zones/:zoneId/cards/:encodedCardId`.

Required smoke evidence:

- screenshot before pinch
- screenshot after pinch open with a narrower custom range
- no console `Unable to preventDefault inside passive event listener invocation`
- no chart blanking after pinch

Save screenshots under:

```text
/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-5/
```

- [ ] Step 8: Commit.

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/components/history/mobile/HistoryVisualizationSurface.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/HistoryCardFrame.tsx web/react-gui/src/components/history/__tests__/HistoryVisualizationSurface.test.tsx
git commit -m "feat: add full-screen history gesture surface"
```

## Slice 6 - Monthly Calendar View

**Purpose:** Replace the current day-card calendar presentation with a paper-calendar-style month overview where days are colored by card-specific state.

**Files:**

- Create: `web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx`
- Modify: `web/react-gui/src/components/history/CalendarView.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Modify: `web/react-gui/public/locales/*/history.json`
- Test: `web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`
- Test: `web/react-gui/src/components/history/__tests__/CalendarAndAdvancedViews.test.tsx`

- [ ] Step 1: Write the monthly grid tests.

Required tests:

```tsx
it('renders a recognizable month grid with weekday headers', () => {
  render(<HistoryMonthCalendarView cardType="soil" calendar={soilCalendarMay2026} onInspectDate={vi.fn()} />);

  expect(screen.getByRole('grid', { name: /May 2026/i })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Mon' })).toBeInTheDocument();
  expect(screen.getByRole('gridcell', { name: /May 31/i })).toBeInTheDocument();
});

it('colors days by theme-specific state and keeps no-data visually distinct', () => {
  render(<HistoryMonthCalendarView cardType="soil" calendar={soilCalendarMay2026} onInspectDate={vi.fn()} />);

  expect(screen.getByRole('gridcell', { name: /Dry stress/i })).toHaveAttribute('data-state', 'dry_stress');
  expect(screen.getByRole('gridcell', { name: /Optimal/i })).toHaveAttribute('data-state', 'optimal');
  expect(screen.getByRole('gridcell', { name: /No data/i })).toHaveAttribute('data-state', 'no_data');
});

it('selects a day for the inspector when tapped', () => {
  const onInspectDate = vi.fn();
  render(<HistoryMonthCalendarView cardType="dendro" calendar={dendroCalendarMay2026} onInspectDate={onInspectDate} />);

  fireEvent.click(screen.getByRole('gridcell', { name: /May 12/i }));
  expect(onInspectDate).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-05-12' }));
});
```

- [ ] Step 2: Implement `HistoryMonthCalendarView`.

Calendar requirements:

- Render one month at a time in a 7-column grid.
- Include weekday headers.
- Include leading/trailing blank cells so dates align like a paper calendar.
- The month label comes from the calendar date range, for example `May 2026`.
- Each day cell has:
  - day number
  - state color
  - concise state label or symbol
  - small marker dots for irrigation, rain, heat event, sensor gap, or manual override
  - `data-state` attribute for tests and future visual QA
- No-data days must be muted and clearly different from optimal/normal days.
- Use `calendar.timezone` for date grouping and display.

State color policy:

- Soil: dry stress = amber, optimal = green, wet/excess = blue, mixed = purple, no data = muted gray.
- Dendro: normal growth = green, reduced growth = amber, high shrinkage/stress = red/amber, incomplete night recovery = orange, no data = muted gray.
- Environment: normal = green, heat stress = red, cold stress = blue, high humidity = cyan, rain day = blue, no data = muted gray.
- Irrigation: no irrigation = gray, irrigation event = blue, high frequency = amber, possible ineffective = orange/red, manual override = violet.

- [ ] Step 3: Replace calendar rendering.

`CalendarView` should become a thin wrapper around `HistoryMonthCalendarView` or be renamed only if imports stay stable. The card frame and detail route must render the month grid for `selectedView === 'calendar'`.

- [ ] Step 4: Wire day selection to inspector.

On the detail route:

- tapping a day opens `HistoryInspectorSheet`
- inspector selection stores `{ kind: 'date', date: 'YYYY-MM-DD' }`
- inspector shows that day's state, summary, markers, coverage, and interpretations where available

On desktop shell:

- clicking a day may update the existing inspector state if the wiring is available
- do not block the mobile calendar slice on a full desktop inspector redesign

- [ ] Step 5: Run unit verification.

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit:vitest -- HistoryMonthCalendarView CalendarAndAdvancedViews HistoryCardDetailPage
npm run build
```

- [ ] Step 6: Run browser UX gate.

Use mobile viewport and the detail route:

- open a card with Calendar view
- verify a month grid is visible above the fold
- verify day cells are colored
- tap a colored day
- verify inspector opens for that date
- capture screenshots under `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-6/`

- [ ] Step 7: Commit.

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx web/react-gui/src/components/history/CalendarView.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx web/react-gui/src/components/history/__tests__/CalendarAndAdvancedViews.test.tsx web/react-gui/public/locales
git commit -m "feat: add monthly history calendar view"
```

## Slice 7 - Placeholder View Completion And Source Filters

**Purpose:** Remove visible placeholder views and make merged Soil/Environment sources inspectable.

**Files:**

- Create: `web/react-gui/src/components/history/visualizations/SoilLineChartView.tsx`
- Create: `web/react-gui/src/components/history/visualizations/SoilIrrigationResponseView.tsx`
- Create: `web/react-gui/src/components/history/visualizations/DendroLineChartView.tsx`
- Create: `web/react-gui/src/components/history/visualizations/DendroStressEventsView.tsx`
- Create: `web/react-gui/src/components/history/mobile/HistorySourceFilter.tsx`
- Modify: `web/react-gui/src/components/history/HistoryCardFrame.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Modify: `web/react-gui/src/history/types.ts`
- Modify: `web/react-gui/src/services/api.ts`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js`
- Test: `web/react-gui/src/components/history/__tests__/SoilLineChartView.test.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryPlaceholderViews.test.tsx`
- Test: `scripts/test-history-helper.js`

- [ ] Step 1: Write Soil Line Chart tests.

```tsx
it('renders soil tension series with source-safe labels', () => {
  render(<SoilLineChartView data={zoneBSoilData} />);

  expect(screen.getByRole('region', { name: /Soil line chart/i })).toBeInTheDocument();
  expect(screen.getByText(/Soil 1/i)).toBeInTheDocument();
  expect(screen.queryByText(/[A-F0-9]{16}/)).not.toBeInTheDocument();
});
```

- [ ] Step 2: Implement `SoilLineChartView`.

Rules:

- Reuse the normalization style from `EnvironmentLineChartView`.
- Use soil-specific labels and units.
- Display multiple soil depths in one panel.
- Render an empty state only when no visible points exist.
- Do not duplicate raw token filtering logic if an existing helper can be extracted locally.

- [ ] Step 3: Implement the remaining placeholder replacements.

Required views:

- Soil `irrigation-response`: render a real response view using `data.events`, `data.series`, and `data.interpretations`. If there are no irrigation events or response windows, show a specific empty state such as “No irrigation response events in this range,” not the generic API placeholder.
- Dendro `line-chart`: render a real line chart from dendrometer series. It may reuse normalization from `DendroGrowthTimelineView`, but it must have its own view title and no generic placeholder.
- Dendro `stress-events`: render event cards/timeline from `data.events` and `data.interpretations`. If no events exist, show a specific empty state such as “No stress events in this range.”

Add regression tests:

```tsx
it.each([
  ['soil', 'irrigation-response'],
  ['dendro', 'line-chart'],
  ['dendro', 'stress-events'],
])('does not render the generic placeholder for %s %s', async (cardType, view) => {
  renderCardFrameWithView({ cardType, view });

  expect(screen.queryByText(/Chart and calendar data will load here/i)).not.toBeInTheDocument();
});
```

- [ ] Step 4: Wire all implemented views.

In `HistoryCardFrame` and the detail route visualization resolver:

- `cardType === 'soil' && selectedView === 'line-chart'` renders `SoilLineChartView`.
- `cardType === 'soil' && selectedView === 'irrigation-response'` renders `SoilIrrigationResponseView`.
- `cardType === 'dendro' && selectedView === 'line-chart'` renders `DendroLineChartView`.
- `cardType === 'dendro' && selectedView === 'stress-events'` renders `DendroStressEventsView`.

- [ ] Step 5: Add source filter UI for merged Soil and Environment cards.

`HistorySourceFilter` behavior:

- Render only when `card.sourceDeviceCount > 1` and `card.cardType` is `soil` or `environment`.
- Chips: `All`, then one chip per `card.sourceDevices` or `card.sourceLabels`.
- Selecting a source must refetch data with `sourceKey`.
- Do not render source filters for Dendro per-source cards.

- [ ] Step 6: Add required backend source filtering.

Add a required optional query param for merged Soil and Environment cards:

```http
GET /api/history/zones/:zoneId/cards/:cardId/data?view=soil-profile&range=24h&aggregation=raw&sourceKey=source-1
```

Backend rules:

- `sourceKey` is a display-safe logical key, not DevEUI.
- Card summary exposes `sourceDevices[].sourceKey`.
- Normal UI never receives raw DevEUI through source filter fields.
- Advanced View may still expose raw identifiers.
- Invalid `sourceKey` returns `400` with a user-safe message.
- Empty filtered data returns `200` with empty series/profile arrays and a specific no-data interpretation.
- Mirrored bcm2712 and bcm2709 helper files must remain byte/content equivalent under the profile parity checker.

- [ ] Step 7: Add flows/profile growth verification.

Because `flows.json` is large and mirrored across profiles, keep flow changes minimal and route filtering through `osi-history-helper`.

Verification:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-profile-parity.js
jq -S . conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json > /tmp/flows-bcm2712.sorted.json
jq -S . conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json > /tmp/flows-bcm2709.sorted.json
diff -u /tmp/flows-bcm2712.sorted.json /tmp/flows-bcm2709.sorted.json
```

- [ ] Step 8: Run verification.

```bash
cd /home/phil/Repos/osi-os
node scripts/test-history-helper.js
node scripts/verify-history-api-contract.js
node scripts/verify-profile-parity.js

cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit:vitest -- SoilLineChartView HistoryCardDetailPage
npm run test:unit:vitest -- HistoryPlaceholderViews
npm run build
```

- [ ] Step 9: Commit.

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/components/history/visualizations/SoilLineChartView.tsx web/react-gui/src/components/history/visualizations/SoilIrrigationResponseView.tsx web/react-gui/src/components/history/visualizations/DendroLineChartView.tsx web/react-gui/src/components/history/visualizations/DendroStressEventsView.tsx web/react-gui/src/components/history/mobile/HistorySourceFilter.tsx web/react-gui/src/components/history/HistoryCardFrame.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/history/types.ts web/react-gui/src/services/api.ts web/react-gui/src/components/history/__tests__/SoilLineChartView.test.tsx web/react-gui/src/components/history/__tests__/HistoryPlaceholderViews.test.tsx scripts/test-history-helper.js scripts/verify-history-api-contract.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js
git commit -m "feat: add soil line chart and source filters"
```

## Slice 8 - Inspector Bottom Sheet And Advanced Settings

**Purpose:** Make long press and selected timestamp useful without cluttering the overview or primary controls.

**Files:**

- Create: `web/react-gui/src/components/history/mobile/HistoryInspectorSheet.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Modify: `web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx`
- Modify: `web/react-gui/src/components/history/AdvancedViewPanel.tsx` if it needs a mobile container
- Modify: `web/react-gui/public/locales/*/history.json`
- Test: `web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx`
- Test: `web/react-gui/src/components/history/__tests__/CalendarAndAdvancedViews.test.tsx`

- [ ] Step 1: Write inspector tests.

```tsx
it('opens an inspector sheet when the visualization reports an inspected timestamp', async () => {
  renderDetailRoute({ card: soilCard, data: soilDataWithInterpretations });

  fireEvent.pointerDown(surface, { pointerId: 1, clientX: 120, clientY: 200 });
  vi.advanceTimersByTime(550);

  expect(await screen.findByRole('dialog', { name: /Inspector/i })).toBeInTheDocument();
  expect(screen.getByText(/Root zone/i)).toBeInTheDocument();
});
```

- [ ] Step 2: Implement `HistoryInspectorSheet`.

Sheet contents:

- selected timestamp/day/cell
- local interpretations
- coverage/freshness
- event markers
- source label
- close handle

Sheet behavior:

- On mobile, bottom sheet with max height `70vh`.
- On desktop direct route, right-side sheet or centered panel is acceptable, but do not alter `HistoryDesktopShell` yet.

- [ ] Step 3: Move Advanced View behind settings on mobile.

Header settings menu:

- `Advanced View`
- `Card settings`
- `Reset range`

Primary mobile view controls must not show `Advanced View` in the normal row.

- [ ] Step 4: Add minimum accessibility coverage.

Requirements:

- Full-screen detail has one `h1`.
- Range buttons and view buttons have `aria-pressed`.
- Visualization surface has an `aria-label` explaining supported interactions and a visible or screen-reader-only help string.
- Pinch and drag have button fallbacks: explicit range buttons, reset button, and refresh button.
- Inspector sheet uses `role="dialog"` with an accessible name and a close button.
- Focus moves into the inspector when it opens and returns to the visualization surface or triggering day cell when it closes.
- Calendar month grid uses `role="grid"`, weekday headers use `role="columnheader"`, day cells use `role="gridcell"`, and selected day has `aria-selected`.

- [ ] Step 5: Run verification.

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit:vitest -- HistoryCardDetailPage CalendarAndAdvancedViews
npm run build
```

- [ ] Step 6: Run browser UX gate.

Use mobile viewport:

- long press visualization opens inspector
- keyboard/fallback click opens inspector from a calendar day
- settings menu opens Advanced View
- raw DevEUI is absent before Advanced View and visible only inside Advanced View
- screenshots saved under `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-8/`

- [ ] Step 7: Commit.

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/components/history/mobile/HistoryInspectorSheet.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx web/react-gui/src/components/history/AdvancedViewPanel.tsx web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx web/react-gui/src/components/history/__tests__/CalendarAndAdvancedViews.test.tsx web/react-gui/public/locales
git commit -m "feat: add mobile history inspector sheet"
```

## Slice 8A - Desktop Placeholder Cleanup Fallback

**Purpose:** Remove obvious placeholder language from desktop if Slice 0 did not complete it. Skip this fallback slice when Slice 0 already removed the desktop toolbar placeholder and tests cover it.

**Files:**

- Modify: `web/react-gui/src/components/history/HistoryDesktopShell.tsx`
- Modify: `web/react-gui/public/locales/*/history.json`
- Test: `web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx`

- [ ] Step 1: Write a test that the placeholder text is gone.

```tsx
it('does not render implementation placeholder copy in the desktop toolbar', async () => {
  renderDesktopHistoryShell();

  expect(screen.queryByText(/land here in the visualization slice/i)).not.toBeInTheDocument();
  expect(screen.getByText(/Aggregation/i)).toBeInTheDocument();
});
```

- [ ] Step 2: Replace placeholder toolbar copy.

Minimal desktop toolbar contents:

- current range label
- current aggregation badge
- `Single` / `Comparison`
- panel cap text
- save/update workspace controls remain in sidebar

Do not add a full desktop redesign in this slice.

- [ ] Step 3: Run verification.

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit:vitest -- HistoryShell
npm run build
```

- [ ] Step 4: Commit.

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/components/history/HistoryDesktopShell.tsx web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx web/react-gui/public/locales
git commit -m "fix: remove history desktop toolbar placeholder"
```

## Slice 9 - Live Kaba100 Playwright UX Verification

**Purpose:** Verify the actual Pi-hosted UI, including mobile layout, route behavior, and gesture support.

**Files:**

- Modify: `docs/ux/history-data-visualization-kaba100-issues.md`
- No production code unless a verified bug is found and fixed in a separate `fix:` commit.

- [ ] Step 1: Build and deploy OSI OS UI to kaba100.

Use the repo deployment process already used for this branch. Do not overwrite `/data/db/farming.db`.

- [ ] Step 2: Run Playwright against mobile and desktop viewports.

Checks:

- `/gui/#/history` on mobile shows only compact overview cards.
- Zone B card shows `2 sources: Chameleon 1, Chameleon 2`.
- Tapping Zone B Soil opens `/gui/#/history/zones/12/cards/<encoded-card-id>`.
- Full-screen detail shows range controls `12h`, `24h`, `7D`, `30D`, `Season`.
- Pinch open on visualization changes viewport to a narrower custom range.
- Pinch close changes viewport to a wider custom range.
- One-finger drag pans the time window.
- Double tap resets to the card default range.
- Long press opens the inspector sheet.
- Back returns to `/history`.
- Normal farmer UI does not show raw DevEUI.
- Advanced View still shows diagnostic identifiers.
- Console has no `preventDefault inside passive event listener` errors.

- [ ] Step 3: Save screenshots.

Expected evidence paths:

```text
/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/overview-mobile.png
/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/detail-mobile.png
/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/detail-after-pinch.png
/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/inspector-mobile.png
/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/desktop.png
```

- [ ] Step 4: Update issue document with live results.

Append:

```markdown
## Fullscreen mobile redesign verification

Date: 2026-06-01
Target: kaba100

Passed:
- `/gui/#/history` rendered compact mobile overview cards without inline timeline controls.
- Zone B Soil opened `#/history/zones/12/cards/5bf9d958-f886-4faf-8dcf-e84efe76163a%3Asoil%3Aroot-zone`.
- Pinch open narrowed the visible range and changed aggregation to `auto`.
- Pinch close widened the visible range and changed aggregation to `auto`.
- Long press opened the inspector sheet.
- Normal mobile UI did not render raw DevEUI.

Failed:
- Record `None` when every required check passes.
- Record each failed check with severity, reproduction steps, and screenshot path.

Screenshots:
- `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/overview-mobile.png`
- `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/detail-mobile.png`
- `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/detail-after-pinch.png`
- `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/inspector-mobile.png`
- `/home/phil/playwright-osi/screenshots/history-mobile-fullscreen/slice-9/desktop.png`
```

- [ ] Step 5: Run full local verification.

```bash
cd /home/phil/Repos/osi-os
git diff --check
node scripts/verify-history-api-contract.js
node scripts/verify-sync-flow.js
node scripts/verify-db-schema-consistency.js
scripts/check-mqtt-topics.sh

cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit
npm run build
```

- [ ] Step 6: Commit verification document.

```bash
cd /home/phil/Repos/osi-os
git add docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "docs: record history mobile fullscreen kaba100 verification"
```

## Slice 10 - Final Review And Compliance Trace

**Purpose:** Close the loop against the written spec and this plan.

**Files:**

- Modify: `docs/ux/history-data-visualization-implementation-trace.md`
- Modify: `docs/ux/history-data-visualization-kaba100-issues.md` if any status changed after review

- [ ] Step 1: Add implementation trace rows.

Trace format:

```markdown
| Mobile fullscreen history detail | Route-backed card detail, compact overview, pinch zoom, monthly calendar, source filters, placeholder view replacements, inspector sheet | osi-os | Slice 1-8 | Record the comma-separated slice commit SHAs from `git log --oneline --reverse feat/history-data-visualization -- web/react-gui/src/components/history web/react-gui/src/pages/HistoryCardDetailPage.tsx` | unit tests + inter-slice Playwright gates + kaba100 Playwright | Implemented |
```

- [ ] Step 2: Run full verification.

```bash
cd /home/phil/Repos/osi-os
git diff --check
node scripts/verify-history-api-contract.js
node scripts/verify-sync-flow.js
node scripts/verify-db-schema-consistency.js
scripts/check-mqtt-topics.sh

cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit
npm run build
```

- [ ] Step 3: Request final review.

Review prompt:

```text
Please do a final critical review of the OSI OS History mobile fullscreen redesign.

Focus:
- route-backed mobile detail completeness
- pinch in/out date/time selection correctness
- no overview clutter regression
- no raw DevEUI in normal mobile UI
- live kaba100 verification quality
- any desktop regressions
- whether the implementation still complies with docs/ux/history-data-visualization-redesign-spec.md
```

- [ ] Step 4: Fix final review findings, then run verification again.

- [ ] Step 5: Commit final trace.

```bash
cd /home/phil/Repos/osi-os
git add docs/ux/history-data-visualization-implementation-trace.md docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "docs: trace history mobile fullscreen redesign"
```

## Acceptance Criteria

Mobile overview:

- `/history` shows compact, scan-friendly cards.
- No inline full history detail appears on `/history` mobile.
- Source labels are visible and display-safe.
- No raw DevEUI appears outside Advanced View.

Route-backed detail:

- Tapping a card opens `#/history/zones/:zoneId/cards/:cardId`.
- Browser back returns to `/history`.
- Direct reload of the detail route resolves the card or shows a safe not-found state.

Controls:

- `12h`, `24h`, `7D`, `30D`, and `Season` are visible in detail.
- View modes are card-specific.
- Advanced View is available through settings on mobile, not the primary mode row.

Gestures:

- Pinch open narrows the time window.
- Pinch close widens the time window.
- One-finger horizontal drag pans time.
- Double tap resets range.
- Long press opens inspector.
- Page scroll remains normal outside the visualization surface.
- No passive `preventDefault` console error is emitted.

Visualization:

- Soil Profile renders.
- Soil Line Chart renders real data, not the placeholder.
- Calendar renders as a month grid with weekday headers and color-coded day cells.
- Calendar day tap/long press opens inspector for that date.
- Advanced View renders diagnostics.
- Empty states are only used for true no-data conditions.

Verification:

- Unit tests pass.
- Build passes.
- History API contract checks pass.
- Profile parity remains valid if backend helper files change.
- Kaba100 Playwright screenshots and findings are recorded.

## Scope Deliberately Deferred

- Full OSI Cloud mobile parity.
- Cross-season desktop analytics redesign.
- Unlimited comparison workspaces.
- New chart engine replacement for Recharts.
- Workspace sync between edge and cloud.
- Gesture support on the legacy dashboard.
