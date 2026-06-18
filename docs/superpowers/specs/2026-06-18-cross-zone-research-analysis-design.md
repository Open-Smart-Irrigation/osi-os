# Cross-Zone Research Analysis — Design Specification

Status: draft for implementation planning
Date: 2026-06-18
Scope: OSI Server / OSI Cloud only (desktop). OSI OS edge is explicitly out of scope.
Related: [history-data-visualization-redesign-spec.md](../../ux/history-data-visualization-redesign-spec.md) — the zone-scoped History redesign this surface sits beside.

## 1. Objective

Provide a desktop, research-aligned analysis surface on OSI Cloud where a researcher or
agronomist can compare **different sensors across all irrigation zones they can access**,
spanning multiple farms/sites, on a shared timeline. The deliverable for the user is
**live, on-screen insight** plus data/image export — not reproducible documents and not an
analyst sandbox.

This surface is additive. It does not replace the zone-scoped History redesign, and it does
not change the edge dashboard.

### 1.1 Why this is cloud-only

Cross-zone, cross-farm comparison is fundamentally a cloud capability: the edge Pi is
offline-first and only knows its own farm, while the cloud is where multiple zones/farms
mirror. The existing History spec already treats "desktop analysis" as a cloud concern. The
Raspberry Pi edge target gets nothing from this feature.

### 1.2 The R question — resolved: do not add R

The trigger for this design was whether to add an R environment for data visualization.
Decision: **no**, for this feature.

- The deliverable is a *live interactive dashboard* embedded in the existing React SPA. That
  wants client-side charting plus a fast cross-zone aggregation API. R/Shiny is a separate
  server-rendered app with its own runtime, session model, auth, and container; it fights the
  SPA, adds a server round-trip to every hover/zoom, and is awkward to embed.
- OSI Server already runs a Python data-science stack in production (`prediction-service`:
  FastAPI, pandas, numpy, chronos-forecasting, torch, aquacrop, pyomo). Any server-side
  number-crunching has a home there. There is no reason to introduce a second analysis
  language and toolchain on the VPS.
- R's genuine strengths — ggplot2 static figures, Quarto reports, niche statistics packages —
  are batch / reproducible-output strengths, not live-interactivity strengths. They would be
  wasted in this mode.

R may be reconsidered **later** as a separate, optional, batch path (a "generate
publication-grade figures / reproducible report" export via Quarto + ggplot rendering a PDF
from the same data) only if paper-grade output becomes a real requirement. It does not belong
in the interactive dashboard and is out of scope here (see §8).

## 2. Locked decisions

These came out of brainstorming and are treated as fixed inputs to implementation planning:

- **Deliverable:** live cross-zone dashboard (on-screen insight + export), not reports, not a
  hosted analyst sandbox, not a stats engine.
- **v1 framing:** build the free-form `(zone × sensor)` series builder as the engine; ship
  "overlay one metric across all zones" as a one-click preset on top of it. Overlay is the
  simplest special case of the builder, so it falls out for free.
- **Zone scope:** across all sites the account can access (multiple farms). The series picker
  is a `farm → zone → sensor` tree.
- **Mixed-unit reconciliation (default):** same-unit series share one axis (overlay); mixed
  units auto-split into stacked aligned panels grouped by unit, with a shared x-axis and
  synced crosshair. Normalize 0–100% and explicit multi-axis overlay are opt-in, never the
  default. No silent misleading dual-axis charts.
- **Chart renderer:** adopt **ECharts** for this view (canvas-based, large multi-series,
  built-in dataZoom/brush, multi-axis, downsampling). Recharts remains for the rest of the
  app. The interaction layer must not leak ECharts internals into shared code.

## 3. Architecture and boundaries

```text
Account (multi-farm access)
  -> GET /api/v1/analysis/channels   (selectable farm->zone->channel tree)
  -> POST /api/v1/analysis/series    (selectors + range -> time-aligned series)
       -> typed hourly/daily rollups (long ranges)
       -> raw + server-side downsampling (short ranges)
  -> React /analysis workspace (ECharts)
       -> stacked-by-unit panels | overlay preset | small-multiples | correlation
       -> CSV (tidy long) + PNG export
       -> saved analysis_views
```

- New top-level cloud frontend route: `/analysis`, separate from the zone-scoped History
  surface.
- New Spring backend package: `org.osi.server.analysis`.
- **Reuses, does not duplicate:** the typed hourly/daily rollup tables introduced by the
  History redesign. This surface queries them *across* zones rather than within one zone. If
  those rollups are not yet built when this work starts, that dependency must be sequenced
  first (see §9).
- The edge codebase (`osi-os`) is untouched. No profile-parity payload changes.

## 4. Backend specification

### 4.1 Channel catalog endpoint

```text
GET /api/v1/analysis/channels
```

Returns the selectable universe for the authenticated account as a `farm → zone → channel`
tree. Each channel carries:

- `channel` — canonical metric key (stable across zones/devices)
- `displayName`
- `unit` — canonical unit (e.g. `kPa`, `degC`, `um`, `pct`, `lux`)
- `cadenceSeconds` — nominal sample interval, where known
- `availability` — `available` | `available_no_recent_data` | `unsupported`
- `zoneId`, `zoneName`, `farmId`, `farmName`

Rules:

- Scoped to zones the account can access. Inaccessible farms/zones are absent, not nulled.
- No raw DevEUI, raw channel IDs, firmware, RSSI/SNR, or calibration internals in this tree.
  Hardware identity stays out of the normal research UI (consistent with the History spec's
  advanced-only policy).
- The canonical channel vocabulary is shared with the History card definitions so a metric
  means the same thing in both surfaces (soil tension, air temperature, dendro TWD/MDS/TGR,
  external temperature, humidity, light, rain/flow, valve state, etc.).

### 4.2 Series endpoint

```text
POST /api/v1/analysis/series
```

Request body:

```json
{
  "selectors": [
    { "farmId": 1, "zoneId": 12, "channel": "soil_tension" },
    { "farmId": 1, "zoneId": 14, "channel": "dendro_twd" },
    { "farmId": 2, "zoneId": 31, "channel": "air_temperature" }
  ],
  "range": { "mode": "relative", "label": "7d", "from": null, "to": null },
  "aggregation": "auto"
}
```

Response:

```json
{
  "generatedAt": "2026-06-18T10:00:00Z",
  "range": { "label": "7d", "from": "...", "to": "...", "timezone": "UTC" },
  "aggregation": { "requested": "auto", "applied": "hourly", "bucketSizeSeconds": 3600 },
  "grid": { "stepSeconds": 3600, "from": "...", "to": "..." },
  "series": [
    {
      "selector": { "farmId": 1, "zoneId": 12, "channel": "soil_tension" },
      "label": "Farm A · Zone 12 · Soil tension",
      "unit": "kPa",
      "color": null,
      "coveragePct": 96,
      "points": [ { "t": "...", "value": 41.2 } ],
      "truncated": false
    }
  ],
  "dropped": [
    { "selector": { "farmId": 9, "zoneId": 99, "channel": "soil_tension" }, "reason": "access_denied" }
  ]
}
```

Behavior:

- **Time alignment:** all series are resampled onto one shared time grid for the requested
  range so the crosshair and CSV export align cleanly. The grid step follows the applied
  aggregation level.
- **Aggregation:** `auto` by default. Short ranges read raw and server-side downsample
  (e.g. LTTB) to a point cap per series. Long ranges (30d / season) read the typed
  hourly/daily rollups. Long-range queries must not live-scan raw JSONB telemetry. The
  response always reports the aggregation level actually applied.
- **Access control:** every selector is re-checked against account zone access at query time.
  Denied or unavailable selectors are returned in `dropped` with a reason; they do not fail
  the whole request.
- **Limits:** a per-series point cap and a total-series cap, both reported. Over-cap series
  are downsampled (`truncated: true`), never silently cut.

### 4.3 Performance budget

| Scope | Target |
| --- | --- |
| Catalog endpoint | p95 under 500 ms |
| Series, <= 8 series, 7d, hourly | p95 under 1.0 s |
| Series, <= 12 series, 30d/90d, from rollups | p95 under 1.5 s |

## 5. Frontend specification

### 5.1 Surface

- New route `/analysis` with a `CrossZoneAnalysisWorkspace` shell. Reuses existing cloud
  auth, layout chrome, and API client patterns.
- A shared, renderer-agnostic time-viewport / selection state module so ECharts specifics do
  not leak into app-wide code.

### 5.2 Series tray (the builder)

- `farm → zone → sensor` picker, searchable, driven by `GET /api/v1/analysis/channels`.
- Each selected series becomes a removable chip showing `zone · sensor · unit` and a color
  swatch.
- Unavailable channels are shown disabled with their availability reason.

### 5.3 Canvas and interaction

- ECharts canvas implementing the §6 mixed-unit behavior.
- Shared x-axis across stacked panels; synced crosshair; hover inspector reading every series
  at the cursor timestamp.
- Bottom `dataZoom` brush over the full range with the selected window highlighted.
- Range control (12h / 24h / 7d / 30d / 90d / custom) and an aggregation indicator showing
  the level actually applied. "Season" is intentionally absent (see §9): season boundaries are
  defined per zone and are ambiguous across a multi-zone selection.

### 5.4 Modes (same selected series set, different lens)

- **Builder (default):** stacked-by-unit panels per §6.
- **Overlay preset:** one click — choose a metric, auto-add every accessible zone's series for
  it, render shared-axis overlay with a zone legend supporting solo/mute.
- **Small-multiples:** one metric, one mini-panel per zone, shared axes; the "scan every zone"
  glance.
- **Correlation:** choose two channels; scatter across the selected zones with an r value.
  Uses the same selectors and aligned grid as the time views.

## 6. Mixed-unit reconciliation (detailed)

- Group selected series by canonical unit.
- One unit group present -> single shared-axis overlay.
- Multiple unit groups -> stacked aligned panels, one panel per unit group, shared x-axis and
  synced crosshair.
- Opt-in toggles (off by default): **Normalize 0–100%** (per-series min/max within the visible
  window, clearly labeled as normalized) and **multi-axis overlay** (collapse stacked panels
  into one chart with a y-axis per unit, with an explicit "axes are independently scaled"
  caveat).
- The default never produces a silent dual-axis chart.

## 7. Export and persistence

- **CSV export:** tidy long format with columns `timestamp, farm, zone, channel, unit, value`,
  reflecting the current selectors, range, and applied aggregation. This is the format
  downstream R/Python/Excel analysis expects.
- **PNG export:** image of the current canvas (ECharts native export).
- **Saved analysis views:** new cloud table, separate from the zone-scoped
  `history_workspaces` (which is zone-bound and cannot express a cross-zone selector set).

```sql
CREATE TABLE analysis_views (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  view_json JSONB NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`view_json` stores the selector set, range, render mode, and opt-in toggle state. Saved views
are private to the owning user in v1.

```json
{
  "schemaVersion": 1,
  "selectors": [
    { "farmId": 1, "zoneId": 12, "channel": "soil_tension" },
    { "farmId": 2, "zoneId": 31, "channel": "air_temperature" }
  ],
  "range": { "mode": "relative", "label": "7d", "from": null, "to": null },
  "mode": "builder",
  "toggles": { "normalize": false, "multiAxisOverlay": false }
}
```

View lifecycle:

- A saved view references zones by id. If a referenced zone is no longer accessible at load
  time, its selector is dropped (surfaced to the user) rather than failing the whole view.
- Unknown future `view_json` fields are preserved on save.

## 8. Out of scope for v1

- Any edge / Raspberry Pi involvement. This feature is cloud-only.
- R / Quarto reproducible-report or publication-figure export. Revisit only if paper-grade
  output becomes a real requirement; if so it is a separate batch path, not part of the
  interactive dashboard.
- Curated cross-farm "study / cohort" as a first-class saved concept, and cross-zone alerting.
- Sharing saved analysis views between users.
- Statistical modeling beyond the correlation scatter (regression, mixed models, driver
  ranking). Correlation r is the only statistical output in v1.

## 9. Dependencies, risks, open questions

- **Rollup dependency:** §4.2 long-range queries depend on the typed hourly/daily rollups from
  the History redesign. If those are not yet implemented, that work must be sequenced before
  this surface's long-range views. Short-range (raw + downsample) views do not depend on them.
- **Canonical channel vocabulary:** the catalog must reconcile heterogeneous device families
  (Kiwi/Tektelic, LSN50/Chameleon, SenseCAP, dendrometer, valve) into stable per-metric keys
  with consistent units. This mapping is the main correctness risk and should be defined once
  and shared with the History card definitions.
- **Cross-zone season:** a single "season" range is ambiguous across a multi-zone, multi-farm
  selection because each zone defines its own season boundaries (`zone_seasons` in the History
  spec). v1 omits season in favor of fixed relative ranges plus custom. A future per-selector
  season alignment could be revisited if researchers ask for it.
- **Timezone:** cross-farm series can span timezones. v1 aligns and labels on a single axis
  timezone (UTC by default, with a user-selectable display timezone); per-zone local-time
  bucketing is not attempted in v1.
- **ECharts adoption:** first use of ECharts in the cloud frontend. Bundle-size and
  lazy-loading of the `/analysis` route should be validated so it does not regress the main
  dashboard load.
