# Per-Zone Weather Source — Design Spec

**Status:** Approved design, not yet implemented.
**Date:** 2026-07-05
**Scope:** Cross-repo — OSI Server (osi-server, cloud, Java/Spring) and OSI OS (osi-os, edge, Node-RED + React).

## Purpose

Let each irrigation zone choose which weather source feeds it, instead of the current hardcoded
best-available cascade. This gives operators control (e.g. prefer an on-site station, or MeteoSwiss for
Swiss sites) and is the groundwork for the dendrometer/Agroscope work: selecting **MeteoSwiss** aligns a
zone's weather with Agroscope's own logic.

Every weather-dependent consumer — prediction advisory, the Weather tab, the Water tab, and the v6/dendro
analytics — reads from the zone's selected source, consistently, on both the cloud and the edge.

## Locked decisions

| Decision | Choice |
|---|---|
| Scope | Cloud **and** edge; the setting is authored on the edge and synced edge→cloud (like `calibration_key`). |
| Source options | `auto` (default), `local` (S2120), `open_meteo`, `openagri`, `agromonitoring`, `meteoswiss` (new). |
| Default | `auto` = today's cascade (OpenAgri → AgroMonitoring → Open-Meteo). Zero behavior change for existing zones. |
| Fallback | **Preferred + transparent fallback:** try the selected source; on no data, fall back to the Auto cascade. Always surface which source actually answered (provenance). |
| `local` semantics | S2120 supplies **measured/current** only; forecast falls back to the Auto cascade (S2120 has no forecast). |
| Blend consumers | **Explicit source is authoritative** — for consumers that today blend sources (`ZoneEnvironmentService` forecast merge; `PredictionInputAssembler` S2120-station + AgroMonitoring + Open-Meteo blend), an explicit `weather_source` **replaces the blend** with that provider (+ transparent fallback). `auto` preserves today's blend/cascade exactly (zero change for existing zones). `local` = S2120 measured + cascade forecast. |
| ET0 | Computed **per source** via a tiered `Et0Resolver`: (1) a source's native FAO-56 value if it supplies one (Open-Meteo) → (2) **we compute FAO-56 Penman-Monteith** when the source provides RH + wind + solar radiation → (3) **Hargreaves-Samani** (Tmin/Tmax + latitude + day-of-year) fallback. `auto` keeps Open-Meteo's native value (byte-identical). Replaces the earlier "ET0 always from Open-Meteo" idea so an explicit source (e.g. MeteoSwiss) gets a source-consistent ET0. |
| MeteoSwiss coverage | Switzerland only; returns empty elsewhere → fallback. Shown in the UI with a "Switzerland only" note. |
| Edge MeteoSwiss | **Full parity** — the edge gets a real MeteoSwiss fetcher too (not deferred). |
| Architecture | **Single source-aware resolver** per side; existing per-provider services become pluggable providers behind it. |

## Current state (why this is non-trivial)

Weather is fetched **in parallel on both sides**, and consumers are inconsistent:

- **Cloud (osi-server):** `WeatherLookupService.getWeatherForDay(...)` is a fixed cascade
  OpenAgri → AgroMonitoring → Open-Meteo. But `ZoneEnvironmentService` (the Weather/Water tab backend)
  calls `OpenAgriWeatherService` **directly**, bypassing the cascade; `DendroAnalyticsService` (v6) uses the
  cascade; `PredictionInputAssembler` uses weather too. "Local" already exists as
  `ZoneEnvironmentSummary.LocalEnvironment` derived from the zone's bound S2120
  (`WeatherStationZoneService`).
- **Edge (osi-os):** Node-RED independently fetches OpenAgri/Open-Meteo, and the React `WeatherTab`/`WaterTab`
  render it; S2120 is the on-site station.
- **Config:** `irrigation_zones` has `latitude/longitude/timezone/calibration_key/crop_type/scheduling_mode`
  but **no `weather_source`**. Zone config is authored on the edge and synced edge→cloud via
  `ZONE_CONFIG_UPSERTED` (`EdgeSyncService`).

Because consumers reach for different services, a per-zone setting only works if **all** of them funnel
through one selection point per side. That routing unification is the bulk of the work.

## Architecture

### Cloud (osi-server)

A new **`WeatherResolver`** is the single entry point, exposing the same shapes consumers already use so
the refactor is a drop-in replacement:

- `getWeatherForDay(zone, day) → WeatherSnapshot + provenance`
- `getCurrentConditions(zone) → … + provenance`
- `getForecast(zone) → … + provenance`

Behind it, each source is a **`WeatherProvider`**:

- `OpenAgriWeatherService`, `AgroMonitoringWeatherService`, `OpenMeteoService` — existing, adapted to a
  uniform provider shape.
- **S2120-local** — via `WeatherStationZoneService` / `ZoneEnvironmentService.LocalEnvironment` (current
  conditions only).
- **`MeteoSwissWeatherService`** — NEW. STAC/OGD local-forecasting (nearest forecast point, measured +
  forecast, Switzerland-only). Returns empty outside CH.

**Selection logic** (`resolve`):
1. `auto` → the existing cascade (OpenAgri → AgroMonitoring → Open-Meteo).
2. explicit source `X` → try `X`; on empty/error → Auto cascade.
3. `local` → S2120 for current/measured; **forecast** → Auto cascade.
4. The cloud result surfaces **`actualSource`** (already carried by `WeatherSnapshot.source` and the
   current/forecast types); consumers that store a source label (v6's `vpdSource`) record it.
   **`requestedSource` is not a cloud return value** — the "Source: X (fallback from Y)" string is composed
   at the **edge** (Phase 3), which knows the requested source from the zone config and the actual source
   from the response. For a merged `auto` forecast, `actualSource` is the merge's primary label (approximate).

`WeatherLookupService`'s cascade becomes the resolver's internal "auto" strategy (kept, not duplicated).
`WeatherProperties` (endpoints/keys/cache) is unchanged and reused.

**Consumers refactored to the resolver:** `DendroAnalyticsService`, `PredictionInputAssembler`,
`ZoneEnvironmentService`, and `DendroController` / `HistoryCloudExtensionService` where they read weather.

### Edge (osi-os, Node-RED + React)

- One **"resolve weather for zone"** function mirroring the cloud selection + fallback + provenance, keyed
  on the zone's `weather_source`. The existing OpenAgri/Open-Meteo fetchers become providers behind it, plus
  a **new edge MeteoSwiss fetcher** (full parity) and the S2120-local path.
- The edge `WeatherTab`/`WaterTab` and any other edge weather consumers read through this function.

### Config & sync

- **`irrigation_zones.weather_source VARCHAR(20) DEFAULT 'auto'`** (additive Flyway migration) + field on
  `IrrigationZone`.
- Edge zone-config store gains `weather_source`; the zone-settings UI writes it; it syncs edge→cloud via
  `ZONE_CONFIG_UPSERTED` (extend `EdgeSyncService` payload mapping alongside `calibration_key`).
- Enum is validated at the edge authoring point and defensively on the cloud (unknown value → treated as
  `auto`).

### Frontend

- **Zone settings (edge React GUI):** weather-source dropdown; MeteoSwiss labeled "Switzerland only".
- **Weather/Water tabs:** display provenance, e.g. "Source: Open-Meteo (fallback from MeteoSwiss)", so the
  transparent-fallback decision is visible to the operator.

## Error handling & caching

- Provider empty/error → next in the fallback chain; all fail → weather unavailable (consumers already
  tolerate absent weather / return `Optional`/null).
- Existing per-provider caching (`WeatherProperties.cache`, edge fetch caching) is preserved; the resolver
  does not add a caching layer.

## Testing

- **Cloud:** unit tests for resolver selection + fallback + provenance for each source; `MeteoSwissWeatherService`
  parsing (measured/forecast, out-of-CH empty); one test per refactored consumer proving it routes through
  the resolver.
- **Edge:** unit test for the resolve function's selection/fallback; `verify-sync-flow.js` covers the new
  synced `weather_source` field.
- **Integration:** a zone set to each source resolves to the expected provider + provenance; MeteoSwiss
  outside CH falls back as documented; `local` forecast falls back to the cascade.

## Affected components

| Repo | Component | Change |
|---|---|---|
| osi-server | `IrrigationZone` + Flyway migration | add `weather_source` |
| osi-server | `WeatherResolver` (new) + `WeatherProvider` shape | single routing authority |
| osi-server | `MeteoSwissWeatherService` (new) | new provider (STAC/OGD, CH-only) |
| osi-server | `OpenAgri`/`AgroMonitoring`/`OpenMeteo`/S2120-local | adapt to provider shape |
| osi-server | `DendroAnalyticsService`, `PredictionInputAssembler`, `ZoneEnvironmentService`, `DendroController`, `HistoryCloudExtensionService` | route through resolver |
| osi-server | `EdgeSyncService` | accept `weather_source` in `ZONE_CONFIG_UPSERTED` |
| osi-os | Node-RED zone config + resolve-weather function | authoring + edge selection/fallback |
| osi-os | Node-RED MeteoSwiss fetcher (new) | edge parity |
| osi-os | React zone settings, `WeatherTab`, `WaterTab` | source picker + provenance display |

## Phasing (for the implementation plan)

1. **Cloud core:** migration + `IrrigationZone` field; `WeatherResolver` + provider adaptation; `MeteoSwissWeatherService`; refactor cloud consumers.
2. **Sync:** `weather_source` in `ZONE_CONFIG_UPSERTED` (`EdgeSyncService`) + verify-flow.
3. **Edge:** resolve-weather function + edge MeteoSwiss fetcher; route edge tabs; zone-settings source picker + provenance display.

Cloud can land and be validated before the edge, but this single spec covers all three phases.

## Open items for the plan

- Exact `WeatherProvider` method set and how capability gaps (e.g. S2120 no-forecast, MeteoSwiss out-of-CH)
  are expressed (return empty vs. an explicit "unsupported").
- MeteoSwiss provider details (nearest-point selection, param set, measured/forecast split) — reuse the
  approach documented in the Agroscope weather-pipeline analysis, minus its known bugs (per-row commits,
  Euclidean nearest without cos(lat), five clock conventions).
- Whether provenance is surfaced only in the tabs or also in the prediction/dendro payloads.
