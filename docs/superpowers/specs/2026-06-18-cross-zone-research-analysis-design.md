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

Returns the selectable universe for the authenticated account as a
`farm → zone → card (theme/source) → channel` tree. The card level matters because a zone can
hold multiple sources of the same theme (e.g. several soil sensors at different depths, or
multiple dendrometers), and the rollup store is keyed accordingly — see §4.1.1. Each channel
leaf carries:

- `seriesId` — opaque, deterministic, farmer-safe handle for this exact series (see §4.1.1).
  This is the canonical thing selectors reference.
- `cardType` — `soil` | `dendro` | `environment` | `irrigation` | `gateway`
- `sourceKey` — logical source key (e.g. `root-zone`, `microclimate`, `zone-valves`, or the
  opaque `dendro-src-<hash>`), never a raw DevEUI
- `channelKey` — canonical metric key within the card (e.g. `swt_60cm`, `dendro_twd`)
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
- The channel vocabulary, units, and labels come from a shared channel registry (§4.1.2), not
  from analysis-local mappings, so a metric means the same thing here and in History.

#### 4.1.1 Series identity (resolves under-identification)

A series is identified by the tuple `(zoneId, cardType, sourceKey, channelKey)`, mirroring the
`history_channel_rollups` unique key `(zone_id, card_type, source_key, channel_key,
bucket_level, bucket_start)`. `farmId` is carried for display and access scoping but is not part
of series identity. A selector keyed only by `{farmId, zoneId, channel}` is under-identified and
would silently collapse multi-source zones, multiple SWT depths, or multiple dendrometers into
one ambiguous line; that form is rejected.

The catalog emits an opaque `seriesId = sha256(zoneId|cardType|sourceKey|channelKey).slice(0,16)`
as the user-facing handle. Clients pass `seriesId` back in selectors; the server resolves it to
the full tuple. Raw `sourceKey`/`channelKey` remain available in the catalog leaf for labeling
and CSV columns but routes, saved views, and logs use `seriesId`.

#### 4.1.2 Shared channel registry (resolves vocabulary drift)

"Shared canonical vocabulary" must be an actual shared component, not a convention. Today the
cloud History service holds private `unitFor(cardType, channelKey)` and `labelFor(channelKey)`
mappings (`HistoryAggregationService.java:745` / `:762`). A new `org.osi.server.analysis` package
that re-derived units/labels would duplicate and drift from those.

Work item: extract a single `ChannelRegistry` (canonical `channelKey` → `{canonicalMetric, unit,
displayName, cardType association, status thresholds}`) as the one source of truth, consumed by:

- History aggregation (refactor `unitFor`/`labelFor` to delegate to it),
- the analysis catalog and series endpoints,
- frontend types (generated or mirrored, with a contract test asserting parity).

This refactor of shared History code is a prerequisite, not an afterthought, and is called out
again in §9.

### 4.2 Series endpoint

```text
POST /api/v1/analysis/series
```

Request body:

```json
{
  "selectors": [
    { "seriesId": "a1b2c3d4e5f60718" },
    { "seriesId": "0f1e2d3c4b5a6978" },
    { "seriesId": "9a8b7c6d5e4f3021" }
  ],
  "range": { "mode": "relative", "label": "7d", "from": null, "to": null },
  "aggregation": "auto"
}
```

Selectors reference series by opaque `seriesId` (§4.1.1). The server resolves each to its
`(zoneId, cardType, sourceKey, channelKey)` tuple.

Response:

```json
{
  "generatedAt": "2026-06-18T10:00:00Z",
  "range": { "label": "7d", "from": "...", "to": "...", "timezone": "UTC" },
  "aggregation": { "requested": "auto", "applied": "hourly", "bucketSizeSeconds": 3600 },
  "grid": { "stepSeconds": 3600, "from": "...", "to": "...", "bucketCount": 168 },
  "series": [
    {
      "seriesId": "a1b2c3d4e5f60718",
      "resolved": { "farmId": 1, "zoneId": 12, "cardType": "soil", "sourceKey": "root-zone", "channelKey": "swt_60cm" },
      "label": "Farm A · Zone 12 · Soil tension 60cm",
      "unit": "kPa",
      "coveragePct": 96,
      "points": [
        { "t": "...", "value": 41.2, "count": 4, "quality": "ok" },
        { "t": "...", "value": null, "count": 0, "quality": "gap" }
      ],
      "truncated": false
    }
  ],
  "dropped": [
    { "seriesId": "deadbeefdeadbeef", "reason": "access_denied" }
  ]
}
```

Behavior:

- **Shared grid (canonical):** the response defines exactly one time grid for the whole request
  (`grid.stepSeconds`, `grid.from`, `grid.to`, `grid.bucketCount`). Every returned series has
  exactly one point per grid bucket, in bucket order, with `t` set to the bucket start. This is
  what makes the crosshair, CSV export, and correlation align deterministically across series.
- **Gaps are explicit, not skipped:** a bucket with no underlying data is emitted as a point
  with `value: null`, `count: 0`, `quality: "gap"`. Series never have differing timestamp sets.
- **Aggregation:** `auto` by default. The grid step follows the applied aggregation level (raw
  buckets for short ranges; hourly/daily rollup buckets for long ranges). Long-range queries
  read the typed hourly/daily rollups and must not live-scan raw JSONB telemetry. The response
  always reports the level actually applied.
- **Downsampling is visual-only and client-side:** the server output is the canonical aligned
  dataset and is NOT LTTB-thinned (LTTB would give series differing timestamps and break the
  grid). If a dense panel needs fewer drawn points, the *client* may downsample for rendering
  only, after alignment, while crosshair/CSV/correlation continue to use the canonical points.
- **Range values:** `range.label` accepts `12h | 24h | 7d | 30d | 90d | custom` only. `season`
  is not a valid cross-zone range (§9) and is rejected with HTTP 400 and
  `{ "error": "unsupported_range", "detail": "season is per-zone and undefined across a multi-zone selection" }`.
- **Access control:** every selector is re-checked against account zone access at query time.
  Denied or unavailable selectors are returned in `dropped` with a reason; they do not fail
  the whole request.
- **Limits:** a per-series bucket cap and a total-series cap, both reported. The grid step is
  chosen so bucket count stays within the cap; series are never silently cut.

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

- `farm → zone → card (source) → channel` picker, searchable, driven by
  `GET /api/v1/analysis/channels`. The card/source level is exposed so distinct depths/sources
  in one zone are separately selectable.
- Each selected series becomes a removable chip showing `zone · source · channel · unit` and a
  color swatch, backed by the opaque `seriesId`.
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
- **Correlation:** choose two channels; scatter across the selected zones. Specified in §5.5 —
  it is the only statistical output in v1 and must not mislead.

### 5.5 Correlation mode (specified)

A scatter with an r value is easy to misread, so v1 fixes the semantics:

- **Statistic:** Pearson r (linear) on the canonical aligned grid (§4.2). Exploratory only —
  v1 reports r and n, not p-values or confidence intervals, and labels it "exploratory, not
  inferential."
- **Per-zone by default:** one r per zone (X and Y channels paired within the same zone over
  the shared grid), so each zone is a separate scatter group with its own r. A **pooled r**
  across all selected zones is available as an explicit, separately-labeled toggle (pooling
  hides between-zone structure, so it is opt-in, never the default).
- **Missing data:** pairwise deletion — a grid bucket contributes only when BOTH channels have
  a non-null value in that bucket. Gap buckets are excluded from r and from the scatter.
- **Minimum sample count:** if usable pairs `n < 30` for a zone (pooled or per-zone), r is
  suppressed for that group and shown as "insufficient data (n=…)" rather than a number.
- **Raw values, not normalized:** Pearson r is scale-invariant, so correlation always uses raw
  aligned values; the §6 Normalize toggle does not apply to r (it would not change r and would
  imply otherwise).
- **Reporting:** the mode reports, per group, `n` used, pairs dropped for missing data, and
  whether the group was suppressed. The two channels may differ in unit; that is expected here.

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

- **CSV export:** tidy long format with columns
  `timestamp, farm, zone, card_type, source_key, channel_key, unit, value`, reflecting the
  current selectors, range, and applied aggregation. `source_key` and `channel_key` are
  required so multi-source zones and multiple depths stay distinguishable in the export. This
  is the format downstream R/Python/Excel analysis expects.
- **PNG export:** image of the current canvas (ECharts native export).
- **Saved analysis views:** new cloud table, separate from the zone-scoped
  `history_workspaces` (which is zone-bound and cannot express a cross-zone selector set). It
  follows the same production-grade constraints as the existing `history_workspaces` migration
  (cascade on user delete, indexes, single default per user).

```sql
CREATE TABLE analysis_views (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  view_json JSONB NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_analysis_views_user_updated
  ON analysis_views(user_id, updated_at DESC);

-- At most one default view per user.
CREATE UNIQUE INDEX idx_analysis_views_one_default_per_user
  ON analysis_views(user_id)
  WHERE is_default;
```

`view_json` stores the selector set (by `seriesId`), range, render mode, and opt-in toggle
state. `schema_version` is a first-class column (not only inside the JSON) so a future
migration can find and upgrade rows without parsing every blob. The server validates
`view_json` against the current schema on write and runs `migrateAnalysisView(schema_version,
view_json)` on read. Saved views are private to the owning user in v1.

```json
{
  "schemaVersion": 1,
  "selectors": [
    { "seriesId": "a1b2c3d4e5f60718" },
    { "seriesId": "9a8b7c6d5e4f3021" }
  ],
  "range": { "mode": "relative", "label": "7d", "from": null, "to": null },
  "mode": "builder",
  "toggles": { "normalize": false, "multiAxisOverlay": false }
}
```

View lifecycle:

- A saved view references series by opaque `seriesId`. If a referenced series resolves to a
  zone no longer accessible at load time, that selector is dropped (surfaced to the user)
  rather than failing the whole view.
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
  the History redesign (`history_channel_rollups`, migration `V2026_05_31_001`). The series
  identity tuple in §4.1.1 is deliberately aligned to that table's unique key. If long-range
  rollups are incomplete, long-range views must be sequenced after them; short-range (raw)
  views do not depend on them.
- **ChannelRegistry refactor (prerequisite):** §4.1.2 requires extracting the cloud History
  service's private `unitFor`/`labelFor` (`HistoryAggregationService.java:745`/`:762`) into a
  shared registry consumed by History, the analysis APIs, and frontend types. This is shared,
  load-bearing History code; the refactor and its contract test must land before, or with, the
  analysis catalog. Reconciling heterogeneous device families (Kiwi/Tektelic, LSN50/Chameleon,
  SenseCAP, dendrometer, valve) into stable per-metric keys with consistent units is the main
  correctness risk and lives in this registry.
- **Grid vs downsampling contract:** §4.2 fixes that the server returns a canonical
  bucket-aligned grid (one point per bucket per series, explicit null gaps) and that any
  thinning is client-side, visual-only, after alignment. Implementations must not introduce
  server-side LTTB on the series endpoint, which would break crosshair/CSV/correlation
  alignment.
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
