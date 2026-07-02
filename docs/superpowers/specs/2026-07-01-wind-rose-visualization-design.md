# Wind Rose Visualization — Design

**Date:** 2026-07-01
**Status:** Approved (design); implementation plan pending
**Area:** `web/react-gui` — S2120 weather-station wind view

## Problem

The SenseCAP S2120 weather station already records and serves wind speed, gust,
and direction. The station-scoped `WindMonitor` modal shows a speed/gust chart
plus a "Direction history" grid of up to 10 rotated ↑ arrows. That arrow grid is
a weak representation of direction: it cannot convey the *prevailing* direction
or the *speed distribution* per direction over a window.

A standard meteorological **wind rose** (polar histogram of direction × speed)
communicates both at a glance and is the natural upgrade. We have all the data;
we simply are not aggregating direction × speed into a distribution.

## Goal & scope

Add a wind rose to the `WindMonitor` modal, **replacing** the rotated-arrow
"Direction history" grid, which it supersedes.

**In scope**
- Client-side aggregation of the existing wind history into a
  direction × speed-bin distribution.
- A polar wind-rose chart rendered with **echarts** (already a dependency),
  lazy-loaded so it does not enter the main bundle.

**Explicitly out of scope** (deferred; not requested)
- Direction overlaid on the speed/gust time series (dual-axis).
- Headline summary stats (prevailing direction, mean/peak) beyond the existing
  three stat tiles.
- Beaufort / plain-language descriptors.
- Any backend, schema, API, or history-card (`environment`) changes.

The existing speed/gust recharts chart, the three header stat tiles, and the
S2120 card's at-a-glance current-conditions tiles all remain unchanged — the
card stays the "layered" simple cue; the rose is the deep view.

## Context (verified against current code)

- Data: `WindMonitor` already fetches `wind_speed_mps`, `wind_gust_mps`, and
  `wind_direction_deg` via `sensorAPI.getHistory` and merges them by timestamp
  into `WindHistoryPoint[]` (`{ t, wind_speed_mps, wind_gust_mps,
  wind_direction_deg }`). The rose consumes this existing merged array.
- Helpers: `web/react-gui/src/utils/wind.ts` holds `roundWindDirectionDegrees`,
  `toCompassDirection`, `formatWindDirection`, and the `COMPASS_POINTS`
  16-point list. New aggregation lives beside them.
- echarts `^5.6.0` is already installed. It is used only by the desktop-only,
  lazy-loaded Cross-Zone Analysis feature through the shared wrapper
  `web/react-gui/src/components/analysis/EChart.tsx`, which applies any option
  via `chart.setOption(option, true)` — a polar chart works through it. echarts
  is therefore **not** in the main bundle; it ships as an on-demand chunk.
- Everyday farming/history charts (including the current WindMonitor speed/gust
  chart) use **recharts**, which is in the main bundle.

## Architecture — three small units

### 1. `computeWindRose(points, options)` — pure aggregator
Location: `web/react-gui/src/utils/wind.ts` (beside existing helpers).

- **Input:** the merged `WindHistoryPoint[]` and an options object
  (`calmThreshold`, `speedBins`).
- **Output:** a plain, serializable structure — for each of the 16 direction
  sectors, the frequency (% of valid samples) in each speed bin; plus overall
  totals, valid-sample count, and calm %.
- No React, no echarts. Fully unit-testable.

**Rules**
- Consider only points where **both** speed and direction are non-null/finite.
- **Calm:** samples with speed `< calmThreshold` (default **0.5 m/s**) have
  meaningless direction → excluded from petals, counted toward **calm %**
  (shown in the modal's wind-rose section header). Null/undefined speed or
  direction is excluded entirely (not counted as calm) — note that
  `Number(null) === 0`, so `computeWindRose` must guard nulls explicitly before
  numeric conversion.
- **Direction binning:** 16 sectors aligned to `COMPASS_POINTS`, each spanning
  ±11.25°, reusing `roundWindDirectionDegrees` for 0/360° wraparound.
- **Convention:** meteorological — direction is where the wind blows *from*;
  N at top. The S2120 decoder is silent on from/to (it only labels the
  measurement "Wind Direction Sensor"), so "from" is an assumption grounded in
  the SenseCAP vendor spec, not something the code proves. Verify by
  sanity-checking the rendered prevailing direction against known field wind, and
  keep orientation trivially flippable if it proves inverted.
- **Speed bins (default, matching the reference screenshot):**
  `<1, 1–2, 2–3, 3–4, 4–5, 5+ m/s`, defined as a single config constant
  (thresholds + colors + labels colocated). The top bin is `[5, ∞)`, so it is
  labelled `5+` (a `5.0` sample belongs to it).
- Frequencies are **% of total valid samples**, so petal lengths compare across
  time windows.

### 2. `WindRoseChart.tsx` — presentational + lazy boundary
Location: `web/react-gui/src/components/farming/` (near `WindMonitor.tsx`).

- Takes the `computeWindRose` result, builds an echarts `option`, and renders it
  through the existing `EChart` wrapper.
- Because this module imports `EChart` (which imports full echarts), it is the
  **code-split boundary**: echarts lands in a lazy chunk, not the main bundle.
- **echarts option:** `polar` coordinate system; `angleAxis` = category of the
  16 directions, **N at top, clockwise**; `radiusAxis` = frequency %. One
  **stacked `bar` series per speed bin** (6 series) produces the classic stacked
  petals. A blue→red color ramp and a `legend` for the speed bins. Colors and
  text read from CSS theme vars (`--text`, `--border`, …) so light/dark match
  the analysis charts.

### 3. `WindMonitor` integration
- Import `WindRoseChart` via `React.lazy` and render inside `<Suspense>`
  (mirroring `AnalysisRoute.tsx`) so the echarts chunk loads only when the modal
  opens.
- Remove the rotated-arrow "Direction history" section and its
  `sampledDirectionPoints` machinery; the rose replaces it. Keep the speed/gust
  chart and the three stat tiles as-is.

## States

- **Loading:** existing spinner covers data fetch + echarts chunk load.
- **Low data:** if fewer than ~10 valid paired (speed + direction) samples in the
  window, show a small "not enough wind data to plot a rose in this window"
  message (reusing the modal's existing empty-state styling) instead of a
  misleading near-empty rose.
- **All-calm:** rose renders empty petals with the calm % shown in the section
  header. (Center-of-rose placement was considered but rejected: the bottom
  legend offsets the polar center, so a centered label needs a fragile magic
  offset; the header conveys the same information unambiguously.)
- **Responsive:** the drawer is full-width on mobile; the `EChart` wrapper's
  `ResizeObserver` already handles resize.

## Testing

- **Unit** (`utils/__tests__`, following existing pattern) for `computeWindRose`:
  bin-boundary values, calm exclusion, direction wraparound at 0/360°, empty
  input, all-calm input, and % normalization summing correctly.
- **Render:** a light test for `WindRoseChart` mirroring the existing
  `EChart.test.tsx` mock (assert a polar option with the expected stacked series
  is produced), no real echarts render required.
- Run via `npm run test:unit` (per project convention).

## Risks & assumptions

- **Direction convention** ("from" vs "to"): the decoder cannot prove it, so
  "from" (meteorological) is a vendor-spec assumption; a wrong convention rotates
  the rose 180°. Verify with a field sanity-check, not by reading the decoder.
- **Bundle:** lazy-loading keeps echarts out of the initial farming/mobile
  bundle; the chunk loads over LAN from the Pi on first modal open and caches.
- **Consistency:** the modal will mix recharts (speed/gust) and echarts (rose).
  Acceptable — the rose has no good recharts primitive, and the split is
  contained to one modal.

## Out-of-scope follow-ups (future)

- Direction on the speed time series (dual-axis, like the reference right panel).
- A zone-scoped wind view in the `environment` history card.
- Beaufort / spray-drift plain-language cues for operational decisions.
