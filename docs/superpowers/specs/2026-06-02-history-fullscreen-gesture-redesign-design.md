# History Fullscreen Gesture Redesign — Design

Status: design for implementation planning
Scope: OSI OS edge dashboard (`web/react-gui`) — mobile-first
Date: 2026-06-02
Supersedes mobile detail behaviour from: [2026-06-01-history-mobile-fullscreen-redesign.md](../plans/2026-06-01-history-mobile-fullscreen-redesign.md)
Companion spec: [history-data-visualization-redesign-spec.md](../../ux/history-data-visualization-redesign-spec.md)

## 1. Objective

Turn the History experience into a **fullscreen, gesture-first data view** reached from each
irrigation zone, with minimal on-screen chrome. Remove the global History page as the entry
point on mobile, fix the pinch-to-zoom so it works on real phones, colour soil state, and
clean up incomplete view modes.

The overall goal (user goal #10): **a fullscreen data view with minimal buttons and maximal
gesture use**, built like a textbook smartphone web app.

This round is **mobile-first and edge-only** (`osi-os`). The desktop history shell and
`osi-server` are out of scope. The thematic-card API, card derivation, aggregation, workspace,
and Advanced View contracts are unchanged.

## 2. Decisions locked during brainstorming

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Login screen | Move `LanguageSwitcher` to **below the "No account" link**, centred. Card fits a phone viewport with **no page scroll**. (Login was never part of the history spec — this is net-new polish.) |
| 2 | Dashboard header | The four actions (Add Zone, Add Device, OSI Server, Logout) fit in **one horizontal row on mobile**. **Remove the History nav button.** |
| 3 | Entry point | Add a **"Data" button** to the collapsed zone card, next to Delete. It opens the fullscreen Data view scoped to that zone. |
| 4 | View modes | No view-mode buttons. **Vertical swipe (↑/↓) cycles view modes.** |
| 5 | Sources | No sources shown in the header. A **`⊟ sources` button** opens a checkbox list to enable/disable sources. **Hidden when the card has a single source.** Combined cards default to all sources on. |
| 6 | Source chips | Remove the existing `All / Chameleon 1 / Chameleon 2` chip row. |
| 7 | Soil profile | Rename "Soil N" → **"Soil layer N"**. Colour each layer row by tension state (see §6). |
| 8 | Calendar | Same colour states, computed from the **daily average tension**. No "mixed", no amber. |
| 9 | Pinch zoom | **Rewrite on raw touch events + viewport zoom-lock.** Standard direction, midpoint anchor, double-tap reset. Real-device verification required. |
| 10 | Range presets | **Pinch only — no range buttons.** A small label shows the current window; double-tap resets. |
| — | Card switching | **Horizontal swipe (←/→) pages between a zone's cards.** |
| — | Time panning | **Photo-viewer model:** at default zoom, horizontal swipe pages cards; once pinched in, horizontal drag pans the time window; at the window edge the next swipe pages the card. |
| — | View-mode completeness | **Implement Daily Min/Max.** **Remove Stress Events, Irrigation Response, and Connectivity Timeline from the UI** (keep their view components in code as placeholders; drop them from card definitions so they are not selectable). |

## 3. Architecture overview

Three areas change; each is independently testable.

```
App shell           Fullscreen Data view              Shared logic
-----------         --------------------              ------------
Login.tsx           HistoryCardDetailPage (rework)    gestureModel.ts (rewrite)
FarmingDashboard    HistoryDetailHeader (minimise)    useVisualizationGestures (rewrite)
IrrigationZoneCard  view-mode vertical carousel       soilStatus thresholds (centralise)
 (+ Data button)    card horizontal carousel          cardDefinitions (trim views)
                    sources checkbox popover
                    SoilProfileView (colour+rename)
                    HistoryMonthCalendarView (colour)
                    DailyMinMaxView (new, environment)
```

### 3.1 Entry & routing
- The **Data button** routes to the fullscreen view for the zone, defaulting to the zone's
  first/primary card. The existing route family `#/history/zones/:zoneId/cards/:cardId`
  (HashRouter) is reused; card switching updates `:cardId` so deep-link/reload still resolve.
- The global `/history` `HistoryDashboard` overview (and the desktop shell it renders) is **no
  longer linked from anywhere** once the nav button is removed. It is left in the codebase (not
  deleted) so desktop work can resume in a later round; it is simply unreachable via UI. The
  **Data button is the only entry point** on every viewport.

### 3.2 Fullscreen Data view layout
- **Header (thin):** `✕` back-to-dashboard · card title · `⊟ sources` (conditional) · `⋯` menu (Advanced View, reset).
- **Body:** the active visualization, maximised. A small, non-interactive label shows the
  current view name and the current time window (e.g. "Soil profile · 24h"). No button rows.
- **Two-axis carousel:**
  - Horizontal = card index within the zone.
  - Vertical = view-mode index within the current card's (trimmed) `views`.

## 4. Gesture model (the core of this round)

All gestures live on a single **gesture surface** wrapping the visualization. Built on **raw
touch events**, not Pointer Events.

| Gesture | Action |
| --- | --- |
| Swipe ← / → | Switch card (page transition) |
| Swipe ↑ / ↓ | Change view mode |
| Pinch (two fingers) | Zoom time window; fingers apart = narrower, anchored at midpoint |
| One-finger horizontal drag, when zoomed in | Pan the time window (photo-viewer model) |
| Long-press | Open inspector bottom sheet for the touched point/day/cell |
| Double-tap | Reset window to the card's default range |

### 4.1 Pinch implementation requirements (#9)
The current Pointer-Event approach passes synthetic tests but fails on real phones because
(a) the browser claims the two-finger gesture as page zoom before the handler sees it, and
(b) iOS Safari delivers multi-touch unreliably through Pointer Events. The rewrite must:

1. Use native `touchstart` / `touchmove` / `touchend`; read `e.touches[0]` and `e.touches[1]`.
2. Attach `touchmove` as a **non-passive** listener and call `preventDefault()` while a
   gesture is active, so the browser cannot hijack it.
3. **Lock page zoom for the data view** (e.g. `user-scalable=no`, `maximum-scale=1` applied
   while the fullscreen view is mounted, restored on unmount).
4. Compute scale from the ratio of current/previous finger distance; map to time-window width
   with `MIN_WINDOW` / `MAX_WINDOW` clamps; anchor at the finger midpoint mapped to a timestamp.
5. Disambiguate gestures by dominant axis and pointer count: 2 pointers → pinch; 1 pointer
   fast directional flick → card/view paging; 1 pointer sustained horizontal drag while
   zoomed → pan; 1 pointer held in place → long-press.
6. Keep `touch-action: none` on the surface; preserve normal page scroll everywhere else.

### 4.2 Verification reality
Playwright can emulate only single-finger taps, so **pinch cannot be verified by automated
tests**. The plan must include a **manual real-device loop** (user on a phone against kaba100,
agent iterates). Unit tests still cover the pure gesture math (`gestureModel.ts`) and the
non-pinch gestures.

## 5. Sources control (#5/#6)
- Replace the chip row with a `⊟ sources` header button that opens a **checkbox popover/sheet**
  listing the card's display-safe source names (e.g. "Chameleon 1", "Chameleon 2").
- Combined (multi-source) cards: all sources enabled by default; toggling refetches/filters
  using the existing source-filter wiring (no raw DevEUI exposed in normal mode).
- Single-source cards: the `⊟` button is **not rendered**.

## 6. Soil status colours (#7/#8)
Centralise one classifier (`classifySoilStatus`) so profile, calendar, and interpretations
share thresholds:

| State | Tension | Colour |
| --- | --- | --- |
| Wet | `< 22 kPa` | 🔵 blue |
| Moist | `22 – 50 kPa` | 🟢 green |
| Dry | `> 50 kPa` | 🔴 red |
| No data | no reading | grey |

- **Soil profile:** each layer row is labelled "Soil layer N" and tinted by its own state.
- **Calendar:** each day is classified from the **mean of that day's soil-tension samples**
  across the card's enabled depths/sources, then coloured. There is no "mixed" state; a day is
  wet / moist / dry / no-data only.
- Edge classifier and frontend must use the **same threshold constants** (single source of
  truth) to prevent drift; existing 5-state vocabulary collapses to these for the soil card.

## 7. View-mode completeness
- **Implement** `environment/daily-min-max` (min/max bands per day) as a real view.
- **Remove from card definitions** (so they are not selectable, no dead placeholder reachable):
  `environment/stress-events`, `irrigation/irrigation-response` (note: `soil/irrigation-response`
  stays — it is implemented), `gateway/connectivity-timeline`.
- Keep the corresponding view components in the repo as placeholders for a future round; only
  the `views` arrays in `cardDefinitions.ts` change. Verify no card's `defaultView` points at a
  removed view.

## 8. App-shell changes
- **Login (`Login.tsx`):** relocate `LanguageSwitcher` below the register link; compress
  spacing/logo so the card fits a standard phone viewport without scrolling.
- **Dashboard (`FarmingDashboard.tsx`):** convert the action group to a compact single mobile
  row (icon + short label); delete the History `<Link>` and its `historyEnabled` gating for the
  nav button.
- **Zone card (`IrrigationZoneCard.tsx`):** add a **Data** button in the action row
  (⚙ · Assign Device · **Data** · Delete) that navigates to the fullscreen Data view for the
  zone. Visible whenever the zone has at least one history-capable card.

## 9. Out of scope / guardrails
- Desktop history shell unchanged **but becomes unreachable via UI** (entry is the Data button,
  which opens the fullscreen view on every viewport; on desktop the existing mouse interactions
  such as wheel-zoom still apply within that view). The desktop sidebar/comparison shell is left
  in code for a later round. `osi-server` untouched.
- No MQTT/topic changes; cloud→edge stays REST. Offline-first preserved.
- Edge runtime payload changes (if any source-filter helper tweak is needed) must mirror
  bcm2712 ↔ bcm2709 and pass profile parity. The expectation is **no Node-RED/helper change**
  is required — source filtering already exists.
- Card identity, aggregation, workspace, and Advanced View contracts unchanged.

## 10. Risks
- **Pinch on real devices** — primary risk; mitigated by the raw-touch rewrite and a manual
  device loop. If it still resists, it can be split into a follow-up without blocking the rest.
- **Gesture disambiguation** — card-page vs view-change vs pan vs long-press sharing one
  surface; needs careful axis/threshold tuning and unit coverage of the pure model.
- **Threshold centralisation** — collapsing the existing soil-state vocabulary to 3 states must
  not break calendar/interpretation consumers; covered by tests.
- **No-scroll login** — must hold across the supported phone sizes and the 7 locales (longer
  translated labels).

## 11. Verification
- `cd web/react-gui && npm run test:unit && npm run build`
- `node scripts/verify-sync-flow.js` and `node scripts/verify-history-api-contract.js` (only if
  any helper/flows change; expected unchanged).
- Playwright (kaba100, iPhone viewport): login no-scroll, dashboard one-row buttons, zone Data
  button → fullscreen, card swipe, view-mode swipe, soil layer colours, calendar colours,
  Daily Min/Max renders, removed views absent, no raw DevEUI in normal mode.
- **Manual real-device loop** for pinch zoom and pan (cannot be automated).
