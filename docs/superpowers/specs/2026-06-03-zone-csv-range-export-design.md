# Zone CSV Range Export — Design

Status: design for implementation planning
Scope: OSI OS edge — React (`web/react-gui`), Node-RED (`flows.json`), `osi-history-helper`
Date: 2026-06-03
Depends on: `docs/superpowers/specs/2026-06-02-history-rollups-and-csv-export-design.md` (rollups, hybrid read, tidy CSV serializer) — that branch (`feat/history-rollups-csv`) must merge first.

## 1. Objective

Let a user pick a date range on a small calendar in the zone settings modal and download a
single combined tidy CSV for that zone and range, at a chosen granularity (raw / hourly /
daily). The CSV is built on demand from the database (raw from `device_data`, hourly/daily from
the `rollups+live` read), so it always covers full history and the current day.

## 2. Decisions locked during brainstorming

| Topic | Decision |
| --- | --- |
| Placement | A new **"Data export"** section inside the existing `ZoneConfigModal` (the zone ⚙ settings). |
| Calendar selection | **Double-click a day** = single day (start = end). **Single click** sets start; **second single click** sets end (range fills). A click after a complete range starts a new range. `‹ ›` arrows change month; range may span months; **future days disabled**. |
| Data source | **Query the DB on demand.** Raw from `device_data`; hourly/daily from the `rollups+live` hybrid read. The nightly stored CSVs remain a separate backup; the export does not stitch them. |
| Granularity | **Selector: Raw / Hourly / Daily**, default Raw. One tidy long CSV at the chosen grain. |
| Recency | Range may include **today**; today's portion is generated live. Future days disabled. |
| Format | The same **tidy long format** as the nightly export (§4.4 of the rollups spec): `RAW_CSV_COLUMNS` for raw, `AGG_CSV_COLUMNS` for hourly/daily. |
| Range guard | Cap per granularity to protect the Pi: raw ≤ 92 days, hourly ≤ 730 days, daily unbounded. Over the cap → friendly error suggesting a coarser granularity. |

## 3. Architecture

```
ZoneConfigModal
  └─ DataExportSection
       ├─ RangeCalendar (month grid, range selection)
       ├─ granularity <select> (raw|hourly|daily)
       └─ Download button → GET /api/history/zones/:zoneId/export.csv?from&to&granularity
                              (auth header) → blob → browser download

flows.json: http in  GET /api/history/zones/:zoneId/export.csv
  └─ auth + zone-access check
  └─ osiHistory.buildZoneExportCsv(db, { zoneId, from, to, granularity, nowMs })
       ├─ raw      -> rows from device_data over [from,to) (zone-local)
       └─ hourly/daily -> per card/source/channel rollups+live read over [from,to)
       └─ toCsv(<columns>, rows)  (reused tidy serializer)
  └─ respond text/csv + Content-Disposition: attachment
```

### 3.1 Backend endpoint

`GET /api/history/zones/:zoneId/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=raw|hourly|daily`

- Auth: existing JWT middleware; verify the user can access `zoneId` (same check the other zone
  endpoints use). 403/404 otherwise.
- Validation: `from`/`to` are ISO dates, `from <= to`, both not in the future; `granularity ∈
  {raw,hourly,daily}` (default `raw`). Invalid → 400 with a clear message.
- Range = zone-local `[startOfLocalDay(from), startOfLocalDay(to)+1 day)` using the zone's
  timezone (reuse `startOfLocalDayMs`).
- Range guard: if `granularity='raw'` and span > 92 days, or `hourly` and span > 730 days →
  413/400 with body `{ error, suggestion: 'choose a coarser granularity' }`.
- Response: `Content-Type: text/csv; charset=utf-8`,
  `Content-Disposition: attachment; filename="<zoneSlug>-<from>_<to>-<granularity>.csv"`.
  Stream rows (header first) to bound memory.

### 3.2 Helper: `buildZoneExportCsv(db, options)`

- Resolve the zone (name, timezone) and derive its cards → logical sources → channels
  (`deriveCardsForZone`), excluding `gateway`.
- **raw:** for each source, `SELECT recorded_at, <fields> FROM device_data WHERE deveui IN (…)
  AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at`; emit one tidy row per
  (timestamp, channel) with `value`, `unit`, `depth_cm` (from the source's depth fields),
  `source`, `card`, `zone`, `timezone`. Columns = `RAW_CSV_COLUMNS`.
- **hourly/daily:** aggregate **per physical source device**, not per merged card source. For
  each source device of each card, aggregate that device's channels over the range at the chosen
  level (computed live from `device_data`, bypassing the merged rollup) and emit one tidy row per
  (bucket, channel) with the device's display-safe `source` name and its own `depth_cm`. This
  keeps per-sensor and per-depth fidelity for multi-source cards (a 2-Chameleon zone exports two
  source rows per channel, each with its depth — not a blended `source="2 sources"` with blank
  depth). Columns = `AGG_CSV_COLUMNS`. (Rationale: the merged rollup is keyed by the card's single
  logical source, so reading it conflates same-named channels across devices.)
- Returns `{ columns, rows }` (or a row iterator for streaming). Reuse `toCsv`/`csvCell`.
- No raw DevEUI in any column (display-safe `source`), consistent with the rollups spec.

### 3.3 Frontend

- `web/react-gui/src/components/farming/RangeCalendar.tsx` — controlled month-grid range picker.
  Props: `value: { from: string|null; to: string|null }`, `onChange`, `maxDate` (today). Pure
  date math in a small `rangeCalendarModel.ts` (next/prev month, day grid, in-range test,
  click→start/end, double-click→single day) so the interaction is unit-testable without the DOM.
- `web/react-gui/src/components/farming/DataExportSection.tsx` — the calendar + granularity
  `<select>` + Download button; disabled until a range is chosen; shows the selected-range
  summary; loading/error states.
- `web/react-gui/src/services/api.ts` — `zoneExportAPI.download(zoneId, { from, to, granularity })`
  that GETs the endpoint as a blob (with auth) and triggers a download (anchor + object URL).
- Wire `DataExportSection` into `ZoneConfigModal` as a new section. i18n keys for all visible
  strings across the 7 locale files.

## 4. Data flow & errors

- Frontend constructs the URL from the selected range + granularity; GET with the bearer token;
  on success, save the blob as a file; on 4xx, show the server message (e.g. range-too-large).
- Empty result (no data in range) → still a valid CSV with the header row only.
- The endpoint never mutates state; safe to retry.

## 5. Out of scope / guardrails

- No `osi-server`, no MQTT/topic changes; REST-only.
- Does not change the nightly rollup/CSV job; reuses its serializer + read path.
- No new aggregation levels; no raw DevEUI in output.
- Profile parity: flows/helper changes mirrored to bcm2709 and pass `verify-sync-flow.js`.
  Never replace `/data/db/farming.db`.
- Range guard prevents unbounded raw exports on the Pi.

## 6. Verification

- Helper: `buildZoneExportCsv` over a seeded `:memory:` DB — raw rows (tidy, depth on soil),
  hourly/daily rows (rollups+live, today included), empty range → header-only, range-guard
  rejection. (`scripts/test-history-helper.js`.)
- Flows: `verify-sync-flow.js` asserts the `export.csv` node exists and calls
  `osiHistory.buildZoneExportCsv`; profile parity holds.
- Frontend: `rangeCalendarModel` unit tests (double-click = single day; click-start then
  click-end = range; future disabled; month nav). Component test that Download builds the
  correct URL (`from`, `to`, `granularity`) and calls the blob download.
- Live kaba100: open a zone's settings, pick a 3-day range, download Raw CSV; confirm it opens
  in R / a spreadsheet with the tidy header and depth column, includes today, and a too-large
  raw range returns the friendly error.
