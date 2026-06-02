# History Fullscreen Polish — Design

Status: design for implementation planning
Scope: OSI OS edge dashboard (`web/react-gui`) — mobile-first
Date: 2026-06-02
Builds on: [2026-06-02-history-fullscreen-gesture-redesign-design.md](2026-06-02-history-fullscreen-gesture-redesign-design.md)

## 1. Objective

Polish the fullscreen Data view that shipped in the previous round: remove all leftover
"History" chrome, maximise the chart to ~90% of the screen, make pinch fluid and
location-aware, revise the gesture model so card-switching no longer collides with calendar
month-paging, and add a landscape layout.

Edge-only, mobile-first. No API, data, schema, or Node-RED changes. The thematic-card API,
aggregation, workspace, and Advanced View contracts are unchanged. The route family
`#/history/zones/:zoneId(/cards/:cardId)` is unchanged (internal only).

## 2. Decisions locked during brainstorming

| # | Topic | Decision |
| --- | --- | --- |
| A | Back button | Remove the "Back to history" button entirely; rely on native browser back. |
| A | Header content | Header = zone · card title, `⊟ sources` (multi-source cards only), `⋯`. Remove the inline "N sources: …" subtitle. |
| A | "History" wording | Remove all visible "History" text. The URL route stays `#/history/...` (visible cleanup only; no route rename). |
| B | Chart space | Remove nested container boxes; the visualization fills the body to ~90% of the screen. |
| B | View/range label | The "Soil Profile · 24h" line becomes a small in-chart overlay, not a header row. |
| B | Per-chart labels | Strip "Soil line chart", "2 readings", "Environment trend", "155 readings", "External temperature", and the Soil 1/2/3 legend rows above the soil line chart. Axis unit labels stay. |
| C | Card switch | **Two-finger horizontal swipe** switches card, in any view. (Replaces the current one-finger=card behaviour.) |
| C | One-finger horizontal | Contextual: pan time in chart views when zoomed; **inner** horizontal swipe = change month in calendar view. |
| C | One-finger vertical | Change view mode (unchanged). |
| C | Edges | Screen edges/corners reserved (untouched) so browser back-swipe and accidental triggers do not fire; month-paging uses an inner swipe. |
| D | Landscape | Thin persistent header; layout responds to orientation so time-series charts use the wide aspect. |
| E | Pinch | Continuous live update during the gesture via `requestAnimationFrame`; anchored at the finger-midpoint timestamp (location-aware). Double-tap resets. |

## 3. Architecture overview

All changes are in `web/react-gui`. No new modules of consequence; mostly edits to the
fullscreen page, the visualization surface/hook, and the view components.

```
Header/chrome          Gesture surface              Visualizations            Layout
-------------          ---------------              --------------            ------
HistoryDetailHeader    useVisualizationGestures     SoilProfileView           HistoryCardDetailPage
HistoryCardDetailPage   (two-finger card swipe,     SoilLineChartView          (orientation-aware
 (remove back btn,       calendar month swipe,      EnvironmentLineChartView    container, ~90% body)
  inline sources,        rAF live pinch,            DendroLineChartView
  view-label overlay)    contextual one-finger)     DailyMinMaxView
                        gestureModel (anchor math)  HistoryMonthCalendarView
                                                     (month paging handler)
```

### 3.1 Header (`HistoryDetailHeader.tsx`, `HistoryCardDetailPage.tsx`)
- Delete the "Back to history" `Link`/button. No in-app back affordance.
- Delete the inline source-summary subtitle. Sources are reachable only via `⊟ sources`
  (already hidden for single-source cards).
- Title shows zone + card name only. Remove any i18n string containing "History" from the
  visible header (keep route/i18n namespace names as-is).

### 3.2 Chart density (`HistoryCardDetailPage.tsx` + each view component)
- Remove the outer/inner nested `div` wrappers around the visualization; the active view
  renders directly into a flex body sized to ~90% of viewport height
  (`flex-1 min-h-0` with the header taking the rest).
- Replace the standalone "{view} · {range}" label row with a small absolutely-positioned
  overlay inside the chart (e.g. top-left, `text-xs text-tertiary`).
- In `SoilLineChartView`, `EnvironmentLineChartView`, `DendroLineChartView`, `DailyMinMaxView`:
  remove the title/subtitle/reading-count headers and any series-legend rows rendered above
  the chart. Keep Recharts axis labels (units) and the in-chart legend only if it does not
  cost a row of height (prefer none on mobile).
- `SoilProfileView`: keep the coloured layer rows (they are the visualization) but drop the
  extra nesting so they use full width.

### 3.3 Gesture model (`gestureModel.ts`, `useVisualizationGestures.ts`)
Single touch surface; raw touch events. Gesture allocation:

| Gesture | Action |
| --- | --- |
| Two-finger horizontal swipe | Switch card (prev/next in the zone), any view |
| Two-finger pinch (distance change) | Zoom time window, live, anchored at midpoint |
| One-finger vertical swipe | Change view mode |
| One-finger horizontal swipe — chart view, zoomed in | Pan the time window |
| One-finger horizontal **inner** swipe — calendar view | Change month (left = previous) |
| Long-press | Inspector |
| Double-tap | Reset window to default |

Disambiguation rules:
- Two fingers: distinguish **pinch** (finger distance changes beyond a ratio threshold) from
  **two-finger swipe** (both fingers translate together, distance ~constant) by comparing
  distance delta vs midpoint translation.
- One finger: dominant-axis test (existing `swipeDirection`); horizontal meaning is resolved
  by the active view (`'calendar'` → month; chart + zoomed → pan; chart + default zoom → no-op).
- "Inner" = the gesture must start outside an edge gutter (e.g. ≥ 24px from left/right edges)
  so browser back-swipe is preserved.

### 3.4 Live, location-aware pinch (`useVisualizationGestures.ts`)
- On `touchmove` with two fingers, compute the new window on every frame and schedule the
  viewport update with `requestAnimationFrame` (coalesce multiple moves per frame); apply on
  the next frame so the chart tracks the fingers fluidly.
- Anchor: map the finger-midpoint x to a ratio of the surface width, then to a timestamp in
  the current window; keep that timestamp fixed while scaling width by the pinch ratio
  (`prevDist/nextDist`). Clamp to `MIN_WINDOW`/`MAX_WINDOW`.
- Result: pinching open centred on Monday in a 7-day window narrows toward ~24h around Monday.

### 3.5 Calendar month paging (`HistoryMonthCalendarView.tsx` + detail page)
- The calendar view exposes a `month` state (the visible month). An inner one-finger
  horizontal swipe calls `onMonthChange(delta)` (−1 = previous, +1 = next), which shifts the
  visible month and refetches calendar data for that month range.
- While the calendar view is active, the gesture surface routes one-finger horizontal to month
  paging instead of card/pan.

### 3.6 Landscape (`HistoryCardDetailPage.tsx`)
- Detect orientation (CSS `@media (orientation: landscape)` and/or a `matchMedia` hook).
- Landscape: header stays as one slim persistent row; the chart body fills the remaining
  width and height. No control relocation (decision D = thin persistent header, not a rail).
- Time-series charts should render with the wide aspect (Recharts `ResponsiveContainer`
  already adapts; verify min-heights don't force scroll).

## 4. Out of scope / guardrails
- No edge/Node-RED/helper/schema changes; no `osi-server`. Offline-first preserved.
- Route paths unchanged; only visible strings change.
- Soil thresholds, calendar averaging, and view trimming from the prior round stay as-is.
- Do not reintroduce range buttons or view-mode buttons.

## 5. Risks
- **Two-finger swipe vs pinch disambiguation** — both are two-finger; needs a clear
  distance-vs-translation threshold and unit coverage, or card-switch will fire during pinch.
- **Live pinch performance** — rAF coalescing must avoid re-render storms on the Pi-served
  bundle; throttle to one update per frame.
- **Calendar month paging vs card swipe** — one-finger (month) vs two-finger (card) must be
  unambiguous on the calendar.
- **Pinch/pan still not verifiable by Playwright** — single-finger only; multi-touch and the
  fluidity require a manual real-device loop.
- **Landscape min-heights** — ensure the ~90% chart target doesn't introduce page scroll in
  either orientation across the supported phone sizes.

## 6. Verification
- `cd web/react-gui && npm run test:unit && npm run build`.
- Unit tests for the pure gesture math: two-finger swipe vs pinch classification, anchor
  timestamp, month-delta from inner swipe, contextual one-finger resolution.
- Playwright (kaba100, iPhone portrait + landscape): no "History"/"Back to history" text;
  header has only title + ⊟ (multi) + ⋯; chart occupies ~90% height; stripped labels absent;
  landscape renders a thin header with a wide chart and no page scroll.
- Manual real-device loop: two-finger card swipe, live location-aware pinch, one-finger pan
  when zoomed, calendar inner-swipe month change, edge back-swipe still works.
