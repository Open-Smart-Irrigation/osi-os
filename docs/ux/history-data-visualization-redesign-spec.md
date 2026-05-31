# History / Data Visualization Redesign Specification

Status: draft for implementation planning
Scope: OSI OS edge dashboard and OSI Server / OSI Cloud dashboard
Last reviewed against code: 2026-05-31
Companion gap analysis: [history-data-visualization-gap-analysis.md](history-data-visualization-gap-analysis.md)
Implementation plan: [2026-05-31-history-data-visualization-implementation.md](../superpowers/plans/2026-05-31-history-data-visualization-implementation.md)

## 1. Objective

Redesign the History / Data Visualization UX around this model:

```text
Farm / Hub -> Irrigation Zone -> Thematic Device Card -> Card-specific View Mode -> Detail / Inspector
```

The implementation must stay aligned with the current codebases:

- OSI OS is offline-first and edge-canonical. It runs the local dashboard, Node-RED API, SQLite database, ChirpStack integration, and sync worker on the hub.
- OSI Server / OSI Cloud mirrors edge-backed farms and adds remote backup, prediction, weather, desktop analysis, exports, and future AI/satellite interpretation.
- REST remains the only cloud-to-edge command path. MQTT remains edge-to-cloud telemetry/status/ack only.
- The current physical device dashboard must remain compatible during rollout. The new history UX should be additive until it is proven.

This document is a technical implementation specification. It intentionally does not include production code.

### 1.1 Critical Review Consolidation

The companion review findings are incorporated as hard implementation constraints, not as optional polish:

- Cloud aggregation cannot rely on live JSONB scans for 30D, Season, or multi-season views. MVP must include typed hourly/daily history rollups for measured card channels; existing daily tables are supplemental only.
- Edge aggregation cannot assume cheap timestamp bucket math over `device_data.recorded_at` because it is stored as TEXT. MVP must add composite indexes and precomputed rollups for long ranges.
- The edge history helper must be a concrete bundled Node-RED helper module with packaging, parity checks, and tests. It must not be left as a vague "helper" idea.
- `range=season` requires a season data model. If a season model is not accepted, Season must be removed from MVP rather than inferred inconsistently.
- Card identity for multi-source themes is a P1 product/data-model decision. Frontend/API work should not begin until merged-vs-per-source card identity is resolved.
- Workspace and preference identity must be sync-safe. Local autoincrement IDs are acceptable for local-only edge storage, but any future sync path must use stable UUID identifiers.
- Basic comparison on OSI OS is required by the UX target, but it must be panel-capped, feature-gated, and validated on Pi-served mobile/desktop browsers before becoming default.

### 1.2 Accepted Implementation Decisions

The product owner was unavailable during Slice 0 execution, so the implementation plan defaults are accepted unless explicitly superseded by a later decision record.

Decision: card-key strategy = hybrid-zone-merged-except-dendro-per-source
Decision: logical-source-key derivation = zone_uuid + card_type + stable role, with raw DevEUI only inside backend/advanced metadata; Dendro may use an opaque DevEUI-derived hash
Decision: season model = add zone_seasons and hide Season until a zone has active boundaries
Decision: edge helper packaging = existing /usr/share/node-red/osi-*-helper pattern, modeled on osi-dendro-helper
Decision: edge rollup strategy = history_channel_rollups for 30D and Season, raw/composite-index reads for 12h/24h/7D
Decision: cloud long-range aggregation = new typed hourly/daily rollups; existing daily tables are supplemental only
Decision: workspace owner identity = user_id for local access plus owner_user_uuid from users.user_uuid when available; no edge workspace sync in MVP
Decision: workspace preference sync = local-only edge MVP, cloud-owned cloud workspaces
Decision: edge comparison cap = 4 visible panels behind historyComparisonEnabled
Decision: cloud gateway connectivity = unavailable until heartbeat/status history persistence exists
Decision: coverage confidence = configured | derived | unknown
Decision: i18n key prefix = history.*
Decision: critical alert ordering = pinned cards remain first; critical alerts rank first only among unpinned cards

## 2. Repository Architecture Summary

### 2.1 OSI OS frontend

Primary app:

- `web/react-gui/`
- Vite + React 18 + TypeScript
- Current charting library: Recharts
- Current data libraries: axios, SWR
- Current routing: `react-router-dom`
- Current styling: Tailwind/PostCSS plus component CSS

Key files:

- `web/react-gui/src/pages/FarmingDashboard.tsx`
- `web/react-gui/src/components/farming/IrrigationZoneCard.tsx`
- `web/react-gui/src/components/farming/SensorMonitor.tsx`
- `web/react-gui/src/components/farming/DendrometerMonitor.tsx`
- `web/react-gui/src/components/farming/dendrometer/DendrometerMonitor.tsx`
- `web/react-gui/src/components/farming/EnvironmentCard.tsx`
- `web/react-gui/src/components/farming/IrrigationOutcomesPanel.tsx`
- `web/react-gui/src/components/farming/SystemPanel.tsx`
- `web/react-gui/src/services/api.ts`
- `web/react-gui/src/types/farming.ts`

Current frontend shape:

- `FarmingDashboard.tsx` fetches devices, zones, and recent actuations.
- Devices are grouped by `irrigation_zone_id`.
- `IrrigationZoneCard.tsx` renders physical device cards and zone summaries.
- History exists mostly as modals/drawers opened from physical device cards.
- There is no thematic-card history workspace yet.

### 2.2 OSI OS backend

Primary backend:

- Node-RED flow JSON at `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- SQLite database schema at `database/seed-blank.sql`
- SQLite migrations at `database/migrations/`
- Runtime local DB path on the hub: `/data/db/farming.db`

Profile parity constraint:

- `conf/full_raspberrypi_bcm27xx_bcm2712/files/` is canonical.
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/` must mirror runtime payload changes byte-for-byte.
- Any future flow/helper/schema payload change must pass `scripts/verify-profile-parity.js`, which is chained from `scripts/verify-sync-flow.js`.

Current edge API surfaces relevant to history:

- `GET /api/devices`
- `GET /api/devices/:deveui/sensor-history`
- `GET /api/devices/:deveui/dendro-history`
- `GET /api/dendrometer/:deveui/daily`
- `GET /api/dendrometer/:deveui/readings`
- `GET /api/irrigation-zones/:zone_id/environment-summary`
- `GET /api/irrigation-zones/:zone_id/recommendations`
- `GET /api/irrigation/recent-actuations`
- `GET /api/system/stats`
- `GET /api/sync/state`

Current edge history behavior:

- Sensor history is queried from `device_data` by physical `deveui`, one field at a time.
- Dendro history is queried from `device_data`, `dendrometer_readings`, and `dendrometer_daily`.
- Current endpoints return raw or near-raw rows with simple limits.
- There is no zone-level thematic card API.
- There is no backend aggregation API for min/max/median/latest/dominant status/coverage.
- There is no saved history workspace or learned card ordering schema.

### 2.3 OSI Server / OSI Cloud frontend

Primary app:

- `/home/phil/Repos/osi-server/frontend/`
- Vite + React 18 + TypeScript
- Current charting library: Recharts
- Current data libraries: axios, SWR
- Current live updates: SockJS/STOMP

Key files:

- `/home/phil/Repos/osi-server/frontend/src/pages/Dashboard.tsx`
- `/home/phil/Repos/osi-server/frontend/src/components/farming/deviceRegistry.tsx`
- `/home/phil/Repos/osi-server/frontend/src/components/farming/GatewayCard.tsx`
- `/home/phil/Repos/osi-server/frontend/src/components/farming/SensorMonitor.tsx`
- `/home/phil/Repos/osi-server/frontend/src/components/farming/DendrometerMonitor.tsx`
- `/home/phil/Repos/osi-server/frontend/src/components/farming/EnvironmentCard.tsx`
- `/home/phil/Repos/osi-server/frontend/src/components/farming/PredictionCard.tsx`
- `/home/phil/Repos/osi-server/frontend/src/services/api.ts`
- `/home/phil/Repos/osi-server/frontend/src/types/farming.ts`

Current frontend shape:

- Cloud dashboard is also physical-device oriented.
- `deviceRegistry.tsx` is a static physical device registry for card rendering.
- `GatewayCard` exists as a first-class cloud card.
- Prediction UI exists separately from history visualization.
- There is no shared thematic-card model with OSI OS yet.

### 2.4 OSI Server / OSI Cloud backend

Primary services:

- Spring Boot backend at `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server`
- Flyway migrations at `/home/phil/Repos/osi-server/backend/src/main/resources/db/migration`
- Python prediction service at `/home/phil/Repos/osi-server/prediction-service`
- Terra field visualization app at `/home/phil/Repos/osi-server/terra-intelligence`

Relevant backend packages and files:

- `controller/DeviceController.java`
- `controller/DendroController.java`
- `controller/PredictionController.java`
- `repository/SensorDataRepository.java`
- `service/EdgeSyncService.java`
- `service/MqttMessageRouter.java`
- Prediction services and repositories under the prediction-related packages

Current cloud API surfaces relevant to history:

- `GET /api/v1/devices/:deviceEui/history`
- `GET /api/v1/devices/:deviceEui/sensor-history`
- `GET /api/v1/devices/:deviceEui/dendro-history`
- `GET /api/v1/devices/:deviceEui/status-history`
- `GET /api/v1/dendro/:eui/daily`
- `GET /api/v1/zones/:zoneId/recommendations`
- `GET /api/v1/irrigation-zones/:zoneId/environment-summary`
- Prediction endpoints for catalog, config, summary, trajectory, comparison, run/recompute, soil profile, field geometry, sensor anchors, and prediction field state

Current cloud history behavior:

- `sensor_data` stores JSONB telemetry records.
- Device history is physical-device oriented.
- REST sync is canonical for edge-backed farms; MQTT telemetry is edge-to-cloud only and is not the cloud-to-edge control path.
- Gateway-forwarded sensor telemetry is intentionally not always persisted as canonical telemetry when sync owns the farm state.
- Prediction and Terra capabilities exist, but they are not integrated into a unified card-specific history workspace.

### 2.5 Current database and device model

Edge SQLite tables relevant to history:

- `users`
- `farms`
- `irrigation_zones`
- `devices`
- `device_data`
- `irrigation_events`
- `actuator_log`
- `dendrometer_readings`
- `dendrometer_daily`
- `dendro_baselines`
- `weather_station_zones`
- `zone_daily_recommendations`
- `zone_daily_environment`
- `zone_irrigation_state`
- `zone_weather_cache`
- `zone_shared_environment`
- `sync_outbox`
- `sync_inbox`
- `sync_cursor`
- `chameleon_readings`
- `chameleon_calibrations`
- `chameleon_calibration_misses`
- `gateway_locations`

Cloud PostgreSQL tables relevant to history:

- `devices`
- `sensor_data`
- `irrigation_zones`
- `dendro_readings`
- `dendro_daily`
- `zone_daily_recommendations`
- `zone_daily_environment`
- `irrigation_events`
- `zone_prediction_configs`
- `zone_prediction_runs`
- `zone_prediction_days`
- prediction reference/shadow/comparison tables
- `zone_soil_profiles`
- field geometries
- sensor anchors
- `gateway_locations`
- linked gateway account and sync tables

Current physical device types:

- `KIWI_SENSOR`
- `TEKTELIC_CLOVER`
- `DRAGINO_LSN50`
- `SENSECAP_S2120`
- `STREGA_VALVE`
- `GATEWAY` on cloud

Current important sensor channels:

- Soil: `swt_1`, `swt_2`, `swt_3`, legacy `swt_wm1`, `swt_wm2`, Chameleon readings
- Dendro: stem diameter, stem change, MDS/TGR/TWD, baseline and recovery metrics
- Environment: air temperature, humidity, light, external temperature, SenseCAP weather channels, rain/flow where available
- Irrigation: valve status, `irrigation_events`, `actuator_log`, actuation expectations
- Gateway: system stats, sync state, location, connectivity, power/fan state

## 3. Current-State UX / API / Data-Model Analysis

### 3.1 What exists today

The codebase already has strong underlying data for the target experience:

- Zone assignments for devices.
- A local canonical SQLite model on the edge.
- REST sync to mirror edge state into cloud.
- Raw sensor history endpoints.
- Dendrometer daily analytics.
- Zone daily recommendations.
- Zone daily environment summaries.
- Irrigation event records.
- Gateway/system status surfaces.
- Cloud prediction, soil profile, geometry, sensor anchor, and field-state surfaces.
- Static frontend device registry patterns.

The current farmer UI is still organized around physical devices:

- Zone card -> physical device cards -> per-device modal/drawer history.
- Device identity, channel fields, and hardware-specific configuration are visible in normal flows.
- Time windows are selected per modal, but view modes are not card-specific semantic modes.
- History charting is mostly line/area charts over raw fields.

### 3.2 What already supports the target spec

These existing pieces can be reused:

- Zone grouping in `FarmingDashboard.tsx`, `Dashboard.tsx`, and `IrrigationZoneCard.tsx`.
- Static registry approach in cloud `deviceRegistry.tsx`.
- Local service normalization in `services/api.ts`.
- Existing Recharts charts for MVP line views.
- `dendrometer_daily` for Dendro Growth Timeline and Stress Events.
- `dendrometer_readings` and `device_data` for near-raw dendro history.
- `chameleon_readings` and depth fields for Soil Profile.
- `zone_daily_environment` and `zone_daily_recommendations` for local rule-based explanations.
- `irrigation_events` and `actuator_log` for Irrigation Event Timeline.
- `SystemPanel` and cloud `GatewayCard` for Gateway Card foundations.
- Cloud prediction endpoints for forecast overlays, model confidence, and actual-vs-predicted comparison.
- Terra field-state endpoints for future spatial/soil profile overlays.

### 3.3 What conflicts with the target spec

The main conflicts are structural:

- The UI model is physical-device first, while the target model is thematic-card first.
- History endpoints are device-field first, while the target API should be zone-card-view first.
- Current chart modals expose fields directly; physical device identity should normally be hidden.
- Current view modes are generic or chart-only; target view modes are card-specific.
- There is no semantic zoom layer. Zooming currently does not change representation or aggregation.
- There is no learned card ordering or pinning.
- There is no saved workspace model.
- There is no unified Advanced View contract.
- Gateway exists as a cloud physical device card and an edge system panel, but not as a shared Gateway History Card.
- No generic Diagnostics Card should be created; current diagnostics-style details must move into Card Settings -> Advanced View.

### 3.4 What is missing

Missing edge and cloud capabilities:

- Thematic card discovery API.
- Device-to-card mapping layer.
- Card-specific data contract.
- Aggregation API with coverage and status statistics.
- Calendar state computation by theme.
- Rule-based interpretation engine on edge.
- Cloud interpretation extension contract for prediction/weather/AI/satellite.
- Card preference persistence.
- Saved workspace persistence.
- Synchronized comparison workspace.
- Mobile gesture controller.
- Desktop timeline interaction controller.
- Advanced overlay policy enforcement.
- Advanced diagnostics data normalization.
- Explicit season-range model on edge.
- RSSI/SNR/firmware/raw payload history availability for all device families.

## 4. Proposed Target Architecture

### 4.1 Keep physical devices as source data, derive thematic cards

Do not replace the physical device model. Physical devices remain the storage, sync, and hardware management model.

Add a derived thematic-card layer:

```text
devices + device_data + dendro tables + chameleon tables + irrigation events + gateway state
  -> card availability
  -> card summaries
  -> card-specific datasets
  -> interpretation
  -> visualization
```

This keeps the sync model stable and avoids a new runtime plugin architecture.

### 4.2 Static card definition source

Use static, in-repo card definitions in each frontend and matching backend services. This follows the existing device registry pattern and respects the ADR deferring a plugin registry.

Recommended frontend files:

- `web/react-gui/src/history/types.ts`
- `web/react-gui/src/history/cardDefinitions.ts`
- `web/react-gui/src/history/cardAvailability.ts`
- `web/react-gui/src/history/overlayPolicy.ts`
- `web/react-gui/src/history/timeViewport.ts`
- `/home/phil/Repos/osi-server/frontend/src/history/types.ts`
- `/home/phil/Repos/osi-server/frontend/src/history/cardDefinitions.ts`
- `/home/phil/Repos/osi-server/frontend/src/history/cardAvailability.ts`
- `/home/phil/Repos/osi-server/frontend/src/history/overlayPolicy.ts`
- `/home/phil/Repos/osi-server/frontend/src/history/timeViewport.ts`

Recommended backend modules:

- Edge: Node-RED endpoints in `flows.json`, with heavy aggregation/interpretation delegated to a static helper module bundled into the image.
- Cloud: a new Spring package such as `org.osi.server.history`.

Edge helper packaging requirement:

- Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/`.
- Mirror it to `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/`.
- Use the existing helper-module pattern already used by `osi-db-helper`, `osi-dendro-helper`, `osi-chameleon-helper`, and `osi-cloud-http`.
- Load the helper from Node-RED function-node `libs` entries, not by expanding large business logic blocks in `flows.json`.
- Keep `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` changes minimal. `functionExternalModules` is already enabled.
- Extend `scripts/verify-profile-parity.js` coverage if helper directories are not already included by the payload parity check.
- Add independent Node tests for the helper before wiring the flow nodes.

Static card definition shape:

```ts
type HistoryCardType =
  | "soil"
  | "dendro"
  | "environment"
  | "irrigation"
  | "gateway";

type HistoryViewMode =
  | "soil-profile"
  | "line-chart"
  | "calendar"
  | "irrigation-response"
  | "growth-timeline"
  | "stress-events"
  | "daily-min-max"
  | "event-timeline"
  | "status-overview"
  | "connectivity-timeline"
  | "local-storage-sync"
  | "power-state"
  | "advanced";
```

Card definition fields:

- `cardType`
- `displayName`
- `defaultView`
- `views`
- `defaultRange`
- `supportedRanges`
- `standardOverlays`
- `advancedOverlays`
- `requiredCapabilities`
- `availabilityRules`
- `metadataFields`
- `calendarStates`
- `interpretationRuleIds`

`interpretationRuleIds` must point to runtime rule implementations. Rules are not pure static card config because they depend on zone thresholds, source cadence, available channels, and selected time range.

### 4.3 Stable card identity

Use stable card IDs that do not expose hardware identity in the normal UI.

Recommended form:

```text
{zone_uuid}:{card_type}:{logical_source_key}
```

Gateway cards are hub-scoped and use:

```text
{gateway_eui}:gateway:hub
```

Examples:

- `zone-uuid:soil:root-zone`
- `zone-uuid:dendro:primary-tree`
- `zone-uuid:environment:microclimate`
- `zone-uuid:irrigation:zone-valves`
- `gateway-eui:gateway:hub`

The API may include source devices only in the Advanced View contract or in backend-only metadata. Normal card summaries should not display DevEUI, raw channel IDs, firmware, RSSI, SNR, calibration details, or raw payload data.

Accepted Slice 0 strategy:

- Use merged zone cards for Soil, Environment, and Irrigation.
- Use one hub-scoped Gateway card per hub.
- Use per-source Dendro cards so multiple monitored stems/trees can stay inspectable without exposing DevEUI in the normal farmer UI.

Card key derivation requirement:

- The `logical_source_key` must be deterministic on both edge and cloud.
- For merged cards, use fixed keys per zone/theme such as `root-zone`, `microclimate`, and `zone-valves`, and merge all eligible sources behind the card.
- For Dendro per-source cards, derive the `logical_source_key` as `dendro-src-{sha256(normalized_deveui).slice(0, 12)}`, where `normalized_deveui` is the uppercase 16-character hex DevEUI after removing separators.
- The raw DevEUI must not appear in normal UI, routes, logs intended for farmer inspection, or workspace labels. Advanced View may map the opaque key back to raw DevEUI.
- Card IDs must survive device rename, zone rename, sync replay, and cloud mirror import.
- Frontend route state, workspace persistence, and preference persistence may use this accepted hybrid strategy.

### 4.4 Required MVP cards

#### Soil Card

Default view:

- Soil Profile

Views:

- Soil Profile
- Line Chart
- Calendar
- Irrigation Response
- Advanced View

Data sources:

- `device_data.swt_1`
- `device_data.swt_2`
- `device_data.swt_3`
- `device_data.swt_wm1`
- `device_data.swt_wm2`
- Chameleon readings
- Chameleon depth fields on `devices`
- `chameleon_calibrations`
- `chameleon_calibration_misses`
- `irrigation_events`
- rain signals from SenseCAP / environment data where available

#### Dendro Card

Default view:

- Growth Timeline

Views:

- Growth Timeline
- Line Chart
- Stress Events
- Calendar
- Advanced View

Data sources:

- LSN50 rows with `dendro_enabled`
- `dendrometer_readings`
- `dendrometer_daily`
- `dendro_baselines`
- `zone_daily_recommendations`
- irrigation/rain/heat event markers

#### Environment Card

Default view:

- Line Chart

Views:

- Line Chart
- Daily Min/Max
- Calendar
- Stress Events
- Advanced View

Data sources:

- KIWI/TEKTELIC ambient data
- LSN50 external temperature
- SenseCAP weather channels
- `weather_station_zones`
- `zone_daily_environment`
- Cloud weather context when available

#### Irrigation Card

Default view:

- Event Timeline

Views:

- Event Timeline
- Calendar
- Irrigation Response
- Advanced View

Data sources:

- STREGA valve current state
- `irrigation_events`
- `actuator_log`
- `valve_actuation_expectations`
- `zone_irrigation_state`
- schedules and zone config

#### Gateway Card

Views:

- Status Overview
- Connectivity Timeline
- Local Storage / Sync State
- Power State
- Advanced View

Data sources:

- Edge `systemAPI`
- Edge sync state
- UCI gateway identity
- `gateway_locations`
- Cloud `GATEWAY` device rows
- Cloud linked gateway/sync status
- heartbeat/status telemetry where persisted

Gateway constraint:

- Edge Gateway Card data can use local system and sync APIs immediately.
- Cloud Connectivity Timeline requires persisted gateway heartbeat/status history. If heartbeat history is not stored, cloud must return `available_no_recent_data` or omit that view until ingestion is extended.
- Gateway is hub-scoped, not zone-scoped. It should appear as a sibling card group under the selected hub/farm, while zone cards remain under irrigation zones.

### 4.5 Card summary API contract

Zone card endpoint:

```text
GET /api/history/zones/:zoneId/cards
```

Cloud zone card endpoint:

```text
GET /api/v1/history/zones/:zoneId/cards
```

Gateway card endpoint:

```text
GET /api/history/gateways/:gatewayEui/cards
```

Cloud gateway card endpoint:

```text
GET /api/v1/history/gateways/:gatewayEui/cards
```

Zone card responses include Soil, Dendro, Environment, and Irrigation cards. Gateway Card responses are hub-scoped and are fetched through the gateway endpoints.

Response shape:

```json
{
  "zoneId": 12,
  "zoneUuid": "uuid",
  "generatedAt": "2026-05-31T10:00:00Z",
  "cards": [
    {
      "cardId": "uuid:soil:root-zone",
      "cardType": "soil",
      "title": "Soil - Root Zone",
      "subtitle": "Root-zone tension",
      "defaultView": "soil-profile",
      "views": ["soil-profile", "line-chart", "calendar", "irrigation-response", "advanced"],
      "supportedRanges": ["12h", "24h", "7d", "30d", "season"],
      "defaultRange": "24h",
      "metadata": {
        "lastSeenAt": "2026-05-31T09:55:00Z",
        "battery": { "status": "ok", "latest": 3.62, "unit": "V" },
        "signal": { "status": "unknown" },
        "coveragePct": 94,
        "calibrationStatus": "calibrated"
      },
      "availability": {
        "available": true,
        "reasons": []
      },
      "ordering": {
        "pinned": false,
        "score": 0.71,
        "recentRank": 2
      }
    }
  ]
}
```

Rules:

- `sourceDevices` should not be present in the normal card list.
- Advanced-only metadata may be represented as counts or statuses in normal card metadata.
- `views` must be card-specific. There is no global view-mode list.

### 4.6 Card data API contract

Zone card data endpoint:

```text
GET /api/history/zones/:zoneId/cards/:cardId/data?view=soil-profile&range=24h&from=...&to=...&aggregation=auto
```

Cloud zone card data endpoint:

```text
GET /api/v1/history/zones/:zoneId/cards/:cardId/data?view=soil-profile&range=24h&from=...&to=...&aggregation=auto
```

Gateway card data endpoint:

```text
GET /api/history/gateways/:gatewayEui/cards/:cardId/data?view=status-overview&range=24h&from=...&to=...&aggregation=auto
```

Cloud gateway card data endpoint:

```text
GET /api/v1/history/gateways/:gatewayEui/cards/:cardId/data?view=status-overview&range=24h&from=...&to=...&aggregation=auto
```

Response shape:

```json
{
  "cardId": "uuid:soil:root-zone",
  "cardType": "soil",
  "view": "soil-profile",
  "range": {
    "label": "24h",
    "from": "2026-05-30T10:00:00Z",
    "to": "2026-05-31T10:00:00Z",
    "timezone": "Europe/Zurich"
  },
  "aggregation": {
    "level": "raw",
    "bucketSizeSeconds": null,
    "coveragePct": 94,
    "pointCount": 322,
    "dominantStatusMethod": "soil-status-priority"
  },
  "limits": {
    "maxPointsPerSeries": 2000,
    "truncated": false
  },
  "series": [],
  "profiles": [],
  "events": [],
  "calendar": null,
  "interpretations": [],
  "freshness": {
    "dataAsOf": "2026-05-31T09:55:00Z",
    "syncState": "local"
  }
}
```

`freshness.syncState` enum:

- `local`
- `synced`
- `stale`
- `degraded`
- `unknown`

All calendar cells and day buckets must be computed in `range.timezone`, using `irrigation_zones.timezone` where available.

Series point shape:

```json
{
  "t": "2026-05-31T09:45:00Z",
  "bucketStart": "2026-05-31T09:45:00Z",
  "bucketEnd": "2026-05-31T10:00:00Z",
  "value": 41.2,
  "min": 39.1,
  "max": 44.0,
  "mean": 41.8,
  "median": 41.7,
  "latest": 42.1,
  "dominantStatus": "optimal",
  "dominantStatusMethod": "soil-status-priority",
  "coveragePct": 100,
  "count": 3,
  "unit": "kPa",
  "quality": "ok"
}
```

Event shape:

```json
{
  "id": "event-id",
  "type": "irrigation",
  "t": "2026-05-31T06:00:00Z",
  "end": "2026-05-31T06:20:00Z",
  "label": "Irrigation",
  "severity": "info",
  "metadata": {
    "durationMinutes": 20,
    "source": "schedule"
  }
}
```

Interpretation shape:

```json
{
  "id": "rule-root-zone-dry",
  "source": "local-rule",
  "severity": "warning",
  "title": "Root zone entered dry status",
  "body": "Root zone entered dry status 9 hours ago.",
  "evidence": [
    {
      "seriesId": "soil-swt-60cm",
      "from": "2026-05-31T01:00:00Z",
      "to": "2026-05-31T10:00:00Z"
    }
  ],
  "confidence": null
}
```

Cloud-only interpretation additions may include:

- `source: "forecast" | "prediction-model" | "ai" | "satellite" | "weather-adjusted"`
- `confidence`
- `modelRunId`
- `forecastBoundary`
- `actualVsPredictedDelta`
- `recommendation`

### 4.7 Advanced View API contract

Zone card Advanced View endpoint:

```text
GET /api/history/zones/:zoneId/cards/:cardId/advanced?from=...&to=...
```

Cloud zone card Advanced View endpoint:

```text
GET /api/v1/history/zones/:zoneId/cards/:cardId/advanced?from=...&to=...
```

Gateway card Advanced View endpoint:

```text
GET /api/history/gateways/:gatewayEui/cards/:cardId/advanced?from=...&to=...
```

Cloud gateway card Advanced View endpoint:

```text
GET /api/v1/history/gateways/:gatewayEui/cards/:cardId/advanced?from=...&to=...
```

Advanced View may expose:

- Physical DevEUI
- Device type
- Firmware version if known
- Raw channel IDs
- Raw payload fields
- Raw payload bytes when available
- RSSI/SNR when available
- Battery voltage
- Calibration state
- Chameleon array ID
- Chameleon calibration source
- Data coverage details
- Raw row counts
- Sync origin
- Last cloud sync
- Local command/ack state

Current gap:

- RSSI, SNR, firmware, and raw payload history are not uniformly persisted across all device families.
- Advanced View fields must include data availability, not only null values.

Advanced field availability enum:

- `collected`
- `not_collected_at_time`
- `unknown_now`
- `unsupported`

Example:

```json
{
  "field": "rssi",
  "value": null,
  "unit": "dBm",
  "availability": "not_collected_at_time"
}
```

This avoids making old rows look broken after ingestion starts collecting richer diagnostics.

### 4.8 Semantic zoom and aggregation

Visible range to aggregation mapping:

| Visible range | Edge behavior | Cloud behavior | Default aggregation label |
| --- | --- | --- | --- |
| 12h | raw or near-raw readings | raw or near-raw readings | Raw |
| 24h | raw plus daily-cycle interpretation | raw plus weather-adjusted context | Raw / 15 min |
| 7D | hourly aggregation, min/max bands, event response | hourly aggregation plus forecast boundary | Hourly |
| 30D | daily aggregation, stress periods, reliability summaries | daily aggregation plus prediction comparison | Daily |
| Season | calendar/state summaries, irrigation rhythm, growth/stress cycles | season summaries and model comparison | Daily / Weekly |
| Multi-season | not required on edge | benchmarks, forecast accuracy, long-term indicators | Weekly |

Supported aggregation statistics:

- min
- max
- mean
- median, or documented approximation where exact median is expensive
- latest value
- dominant status
- data coverage percentage
- irrigation event count
- threshold crossing count

Implementation guidance:

- The API should accept `aggregation=auto` by default.
- The response must always report the actual aggregation level used.
- Edge should compute 12h/24h/7D aggregation locally from SQLite raw reads with composite indexes. Edge 30D and Season views must use `history_channel_rollups`.
- Cloud must not perform long-range rollups by live JSONB scans over `sensor_data`. Cloud MVP must include new typed hourly/daily rollups for 30D and Season; existing daily tables are supplemental only.
- Raw endpoints may remain for compatibility, but the new UI should call card data endpoints.

Performance budget:

| Scope | Target |
| --- | --- |
| Edge 12h/24h single card | p95 under 250 ms after DB query warmup |
| Edge 7D single card | p95 under 750 ms |
| Edge 30D single card | p95 under 1.5 s, preferably from hourly/daily rollup |
| Edge Season single card | p95 under 2.5 s, from daily/weekly rollup |
| Cloud 30D/Season single card | p95 under 750 ms from typed rollup |
| Cloud comparison workspace | p95 under 1.5 s for configured panel cap |

Season requirement:

- `range=season` must resolve to explicit season boundaries.
- Add a zone season model before enabling Season in MVP.
- If season boundaries do not exist for a zone, the API must return `availability.available=false` with reason `season_not_configured`, or the frontend must hide Season for that zone.

Recommended edge table:

```sql
CREATE TABLE zone_seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL,
  season_uuid TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  crop_type TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Recommended cloud table:

```sql
CREATE TABLE zone_seasons (
  id BIGSERIAL PRIMARY KEY,
  zone_id BIGINT NOT NULL REFERENCES irrigation_zones(id),
  season_uuid UUID NOT NULL UNIQUE,
  label TEXT NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  crop_type TEXT,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.9 Calendar mode

Calendar data should be returned as theme-specific state cells.

Soil states:

- `dry_stress`
- `optimal`
- `wet_excess`
- `mixed`
- `no_data`

Soil markers:

- irrigation
- rain
- sensor gap

Dendro states:

- `normal_growth`
- `reduced_growth`
- `high_shrinkage_stress`
- `incomplete_night_recovery`
- `no_data`

Dendro markers:

- irrigation
- heat event
- rain

Environment states:

- `normal`
- `heat_stress`
- `cold_stress`
- `high_humidity`
- `rain_day`
- `no_data`

Irrigation states:

- `no_irrigation`
- `irrigation_event`
- `high_irrigation_frequency`
- `possible_ineffective_irrigation`
- `manual_override`

Calendar response shape:

```json
{
  "period": "month",
  "timezone": "Europe/Zurich",
  "cells": [
    {
      "date": "2026-05-31",
      "state": "optimal",
      "coveragePct": 91,
      "markers": ["irrigation"],
      "summary": "Optimal root-zone tension with one irrigation event.",
      "metrics": {
        "min": 22,
        "max": 48,
        "mean": 35
      }
    }
  ]
}
```

Calendar bucketing:

- Calendar dates are local dates in the zone timezone.
- Edge should use `irrigation_zones.timezone`.
- Cloud should use the mirrored zone timezone and must not bucket by server timezone.

### 4.10 Local rule-based interpretation engine

OSI OS should provide deterministic local explanations without cloud dependency.

Recommended edge files:

- Add static helper code bundled into the Node-RED image payload as `osi-history-helper`.
- Keep Node-RED flow nodes as endpoint orchestration, not as large blocks of duplicated business logic.

Initial local rule examples:

- Upper layer recovered, lower layer remained dry.
- Root zone entered dry status 9 hours ago.
- Irrigation occurred while soil was already wet.
- Sensor data missing during selected period.
- Night recovery was incomplete.
- Dendro shrinkage increased during heat stress.
- Irrigation did not change lower-depth soil status within the response window.

Rule inputs:

- Card type
- Selected range
- Aggregated series
- Calendar states
- Irrigation/rain/heat event markers
- Zone thresholds and config
- Data coverage

Rule output:

- Severity
- Short title
- Farmer-readable body
- Evidence references
- Source as `local-rule`

Use existing SWT thresholds as a starting point, but centralize thresholds so Calendar, Soil Profile, and interpretation do not drift.

Threshold ownership:

| Threshold family | Current sources to audit | Target owner |
| --- | --- | --- |
| Soil tension status | zone config, React helpers, Node-RED logic | history helper threshold registry seeded from zone config |
| Dendro stress/recovery | `dendrometer_daily`, dendro helper, recommendations | history helper rule registry plus dendro daily fields |
| Environment stress | environment summary logic, weather station summaries | history helper threshold registry with crop/zone overrides later |
| Irrigation effectiveness | `zone_irrigation_state`, calibration, event outcomes | history helper rule registry using zone calibration |
| Gateway/sync health | system APIs and sync state logic | Gateway Card service rules |

Implementation rule:

- Calendar state, visualization color state, and interpretation text must call the same threshold classifier.
- Frontend may render labels and colors, but it must not reimplement agronomic thresholds.
- i18n strings for states and interpretations must live in locale files, not hardcoded English component text.

### 4.11 Cloud interpretation extensions

OSI Cloud should use the same local rule contract and add:

- Forecast-aware recommendations
- Weather-adjusted interpretations
- Prediction model confidence
- Actual-vs-predicted comparison
- Cross-zone comparisons
- Cross-season comparisons
- Satellite-informed crop-water status when the data source exists
- AI-assisted explanation when the AI service exists
- Exportable report summaries

Current cloud support:

- Prediction trajectories and comparison endpoints exist.
- Soil profile and field geometry endpoints exist.
- Terra field-state visualization exists.

Current cloud gaps:

- No AI explanation service was found.
- No satellite indicator ingestion/model was found in the inspected surfaces.
- No unified anomaly detection service was found.
- No saved/shared workspace model was found.
- Prediction UI is not yet integrated into a shared history card workspace.

### 4.12 Desktop workspace model

Desktop default:

- Single-card mode.

Comparison mode:

- Entered by adding cards to the workspace.
- Default layout is stacked synchronized panels.
- Panels share the same x-axis.
- Hover/click creates a vertical crosshair across all visible panels.
- Right inspector summarizes selected timestamp across all panels.
- Mixed overlays are not the default.
- Edge workspaces must cap visible comparison panels at 4 until Pi browser performance is measured.
- Cloud workspaces should cap visible panels at 8 by default and allow additional panels only with virtualization/performance warnings.

Workspace JSON:

```json
{
  "schemaVersion": 1,
  "farmId": 1,
  "hubId": "gateway-eui",
  "zoneId": 12,
  "zoneUuid": "uuid",
  "selectedCards": ["uuid:soil:root-zone", "uuid:dendro:primary-tree"],
  "panelOrder": ["uuid:soil:root-zone", "uuid:dendro:primary-tree"],
  "collapsedPanels": [],
  "dateRange": {
    "mode": "relative",
    "label": "7d",
    "from": null,
    "to": null
  },
  "aggregation": "auto",
  "viewModesByCard": {
    "uuid:soil:root-zone": "soil-profile",
    "uuid:dendro:primary-tree": "growth-timeline"
  },
  "enabledOverlays": {
    "uuid:soil:root-zone": ["irrigation-events", "rain-events"]
  },
  "advancedOverlaySettings": {},
  "limits": {
    "maxPanels": 4,
    "platform": "edge"
  },
  "inspector": {
    "selectedTimestamp": null,
    "open": true
  },
  "pinnedCards": ["uuid:soil:root-zone"],
  "layout": "stacked"
}
```

Workspace lifecycle:

- Every client must run `migrateWorkspace(schemaVersion, workspace_json)` before rendering.
- Unknown future fields should be preserved on save.
- Missing cards should be retained in the saved JSON but rendered as unavailable panels with a repair/remove action.
- Deleted zones should make the workspace unavailable rather than silently retargeting it.
- Shared cloud workspaces must verify zone access at read time; if access is revoked, the API should return 403 for private data and a workspace-level unavailable state.
- Edge workspaces are local-only for MVP unless sync-safe identity and sync resources are explicitly designed.

### 4.13 Saved workspace schema

Edge SQLite table:

```sql
CREATE TABLE history_workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  owner_user_uuid TEXT,
  zone_id INTEGER,
  name TEXT NOT NULL,
  workspace_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Cloud PostgreSQL table:

```sql
CREATE TABLE history_workspaces (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  farm_id BIGINT,
  zone_id BIGINT REFERENCES irrigation_zones(id),
  name TEXT NOT NULL,
  workspace_json JSONB NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  shared BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Cloud post-MVP sharing table:

```sql
CREATE TABLE history_workspace_shares (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES history_workspaces(id) ON DELETE CASCADE,
  shared_with_user_id BIGINT REFERENCES users(id),
  permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Accepted Slice 0 decision:

- Edge workspaces remain local-only for MVP.
- Cloud workspaces are cloud-owned.
- Workspace sync requires a later decision record and sync-schema design before implementation.

### 4.14 Learned ordering and pinning schema

Edge SQLite table:

```sql
CREATE TABLE history_card_preferences (
  user_id INTEGER NOT NULL,
  owner_user_uuid TEXT,
  zone_id INTEGER NOT NULL,
  card_id TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  manual_order INTEGER,
  open_count INTEGER NOT NULL DEFAULT 0,
  last_opened_at TEXT,
  last_view_mode TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, zone_id, card_id)
);
```

Cloud PostgreSQL equivalent:

```sql
CREATE TABLE history_card_preferences (
  user_id BIGINT NOT NULL REFERENCES users(id),
  zone_id BIGINT NOT NULL REFERENCES irrigation_zones(id),
  card_id TEXT NOT NULL,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  manual_order INTEGER,
  open_count INTEGER NOT NULL DEFAULT 0,
  last_opened_at TIMESTAMPTZ,
  last_view_mode TEXT,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, zone_id, card_id)
);
```

Ordering algorithm:

1. Pinned cards first.
2. Critical alerting cards may rise above unpinned cards.
3. Manual order is respected inside pinned and unpinned groups.
4. Frequently opened cards move earlier.
5. Recently opened cards are remembered per zone.
6. New cards appear after high-use cards until usage exists.

Suggested score:

```text
score =
  pinnedWeight
  + criticalAlertWeight
  + usageWeight(log(open_count + 1))
  + recencyWeight(decay(last_opened_at))
  + freshnessWeight(data_coverage)
```

Pinned cards must not be displaced by non-critical alerts.

### 4.15 Overlay policy implementation

Default policy:

- Use stacked panels.
- Allow standard overlays only when units and semantics are compatible.
- Allow advanced overlays only in Advanced View.
- Show units clearly for every visible series.

Standard overlays:

- Irrigation events on soil timeline.
- Rain events on soil or dendro timeline.
- Forecast boundary marker.
- Data gap markers.
- Threshold lines within the same unit.
- Multiple soil depths in one soil panel.
- Environment variables with clear axes.

Advanced-only overlays:

- Soil tension + dendrometer shrinkage.
- Temperature + stem growth.
- Battery voltage + signal strength.
- Normalized multi-variable overlay.
- Measured values + model prediction.
- Cross-card anomaly overlay.

Advanced overlay controls:

- Normalize 0-100%.
- Show raw units.
- Show separate y-axes.
- Correlation mode.

Implementation:

- Define overlay capabilities in static card definitions.
- Validate overlay selection in frontend state reducers.
- Validate advanced data requests on the backend.
- Persist enabled overlays in workspace JSON.

## 5. Frontend Specification

### 5.1 Shared frontend history module

Create a new history module in both frontends instead of adding more logic to the existing device card components.

Recommended OSI OS files:

- `web/react-gui/src/history/types.ts`
- `web/react-gui/src/history/cardDefinitions.ts`
- `web/react-gui/src/history/overlayPolicy.ts`
- `web/react-gui/src/history/rangeModel.ts`
- `web/react-gui/src/history/useTimeViewport.ts`
- `web/react-gui/src/history/useHistoryCards.ts`
- `web/react-gui/src/history/useHistoryCardData.ts`
- `web/react-gui/src/history/useWorkspaceState.ts`

Recommended OSI Cloud files:

- Same structure under `/home/phil/Repos/osi-server/frontend/src/history/`.

Do not duplicate device protocol mappings in components. The history module should consume normalized API responses and card definitions.

Contract drift policy:

- Do not create a cross-repo npm workspace for MVP. OSI OS must remain buildable as an independent edge image.
- Accept parallel frontend modules in the two repos, but prevent drift with shared JSON examples, API contract tests, and matching TypeScript response shapes.
- If a later build system supports it cleanly, extract history contracts into a shared package or generate frontend types from backend DTO/OpenAPI schemas.

### 5.2 Mobile components

Required components:

- `HistoryMobileShell`
- `FarmHubZonePicker`
- `ZoneHeader`
- `ThematicCardCarousel`
- `HistoryCardFrame`
- `CardViewModeControl`
- `DateRangeControl`
- `AggregationBadge`
- `VisualizationSurface`
- `InspectorSheet`
- `CardSettingsSheet`
- `AdvancedViewSheet`
- `PullToRefreshBoundary`

Mobile interaction model:

- Swipe left/right on card carousel switches thematic cards within the selected zone.
- Swipe inside chart pans time.
- Swipe inside calendar moves previous/next period.
- Pinch inside visualization changes semantic zoom.
- One-finger drag inside chart/profile pans through time.
- Long press inspects timestamp/day/cell.
- Double tap resets to card default range.
- Pull down refreshes local hub data on OSI OS and refreshes cloud/sync state on OSI Cloud.

Implementation detail:

- Use Pointer Events where possible.
- Use explicit gesture target boundaries so carousel swipes do not steal chart pan gestures.
- Set `touch-action` intentionally per visualization surface.
- Keep view mode controls card-local. Do not create a global view selector.

Mobile browser validation baseline:

- Test iOS Safari and Android Chrome against the Pi-served local GUI, not only localhost desktop emulation.
- Test both local LAN access and remote/Tailscale-style access where latency changes gesture feel.
- Validate pull-to-refresh against native browser overscroll.
- Validate pinch inside visualization against browser page zoom.
- Validate Recharts-based surfaces; if pointer conflicts persist, ship visible zoom buttons and range controls as the fallback for MVP.

### 5.3 Desktop components

Required components:

- `HistoryDesktopShell`
- `HistorySidebar`
- `HistoryTopToolbar`
- `SingleCardWorkspace`
- `ComparisonWorkspace`
- `SynchronizedPanelStack`
- `HistoryPanel`
- `RightInspector`
- `TimelineBrush`
- `WorkspaceManager`
- `OverlayManager`
- `ExportMenu`

Desktop layout:

- Left sidebar: farm/hub/zone tree, pinned cards, learned card order, available thematic cards, saved workspaces.
- Top toolbar: date range, current card view mode, zoom controls, aggregation indicator, save workspace, export, sync/data freshness.
- Center: single-card visualization or comparison workspace.
- Right inspector: selected timestamp, interpretation, metadata, advanced settings, AI explanation when available.
- Bottom: timeline brush with full range, selected window, event markers, gaps, forecast boundary.

Desktop interaction:

- Mouse wheel over visualization timeline zooms around cursor.
- Normal page scroll remains when cursor is outside the timeline.
- Shift + drag or zoom-box tool performs marquee zoom.
- Drag timeline background pans through time.
- Double click timeline resets zoom.
- Bottom brush adjusts range precisely.

### 5.4 Chart and timeline interaction layer

Introduce a reusable time viewport controller.

Responsibilities:

- Maintain `from`, `to`, visible range label, and aggregation request.
- Map wheel/pinch gestures to semantic zoom levels.
- Map pan gestures to shifted time windows.
- Reset to card default range.
- Emit selected timestamp for inspector.
- Coordinate synchronized panels in comparison mode.
- Keep browser scroll behavior intact outside visualization surfaces.

Suggested API:

```ts
type TimeViewport = {
  from: string;
  to: string;
  rangeLabel: "12h" | "24h" | "7d" | "30d" | "season" | "custom";
  aggregation: "auto" | "raw" | "15m" | "hourly" | "daily" | "weekly";
};
```

Rendering strategy:

- Recharts can remain the MVP rendering layer for line views and simple brushes.
- The interaction layer should not depend directly on Recharts internals.
- If comparison workspaces become too heavy, move high-density timelines to a faster chart renderer in a later phase without changing API contracts.

### 5.5 Card-specific views

#### Soil Profile

Purpose:

- Show root-zone status by depth over time.

Inputs:

- SWT channels and depths.
- Chameleon readings and depths.
- Irrigation/rain markers.
- Soil status thresholds.
- Calibration status.

Behavior:

- Default Soil Card view.
- 12h/24h shows raw or near-raw depth traces.
- 7D shows hourly bands and event response.
- 30D/Season emphasizes state periods, dry/wet transitions, and coverage.
- Long press inspects timestamp and depth.

#### Dendro Growth Timeline

Purpose:

- Make dendrometer first-class in the MVP.

Inputs:

- `dendrometer_readings`
- `dendrometer_daily`
- `dendro_baselines`
- irrigation/rain/heat markers

Behavior:

- Default Dendro Card view.
- Shows growth, shrinkage, daily recovery, MDS/TGR/TWD where available.
- Stress Events view summarizes high shrinkage and incomplete night recovery.
- Calendar view maps daily states.

#### Environment views

Line Chart:

- Default view.
- Shows selected environment channels with clear units.

Daily Min/Max:

- Uses min/max bands for temperature, humidity, and other daily channels.

Stress Events:

- Heat, cold, high humidity, rain day, and sensor gap events.

Calendar:

- Theme-specific daily environment states.

#### Irrigation views

Event Timeline:

- Default view.
- Shows scheduled/manual valve actions, duration, expected response, and observed response where available.

Calendar:

- Shows no irrigation, irrigation event, high frequency, possible ineffective irrigation, and manual override.

Irrigation Response:

- Links irrigation events to soil/dendro/environment response windows.
- Standard overlays are allowed here; incompatible overlays remain Advanced-only.

#### Gateway views

Status Overview:

- Current CPU, memory, storage, connectivity, identity, sync state.

Connectivity Timeline:

- Heartbeat/status continuity, outages, sync gaps.

Local Storage / Sync State:

- Local DB state, outbox/inbox/cursor status, pending commands, last successful sync.

Power State:

- Fan, thermal, reboot actions, uptime, power indicators where collected.

Advanced View:

- Raw gateway identity, UCI values, sync tokens status without secrets, diagnostics.

### 5.6 Inspector panel

Mobile:

- Bottom sheet opened by long press or tap.

Desktop:

- Right sidebar.

Inspector content:

- Selected timestamp or calendar cell.
- Primary metric values.
- Card-specific interpretation.
- Events at that timestamp.
- Data coverage and quality.
- Metadata such as battery/signal/last seen.
- Cloud-only AI/prediction explanation when available.
- Advanced link/settings.

### 5.7 Responsive behavior

Breakpoints:

- Mobile: card carousel as the primary navigation.
- Tablet: carousel or two-column zone/card list depending on width.
- Desktop: sidebar + toolbar + center workspace + inspector.

Rules:

- Mobile remains first-class for OSI OS.
- Desktop remains first-class for OSI Cloud.
- Do not hide key controls behind hover-only interactions.
- Do not place a generic Diagnostics Card in the carousel.
- Preserve physical device settings workflows, but move hardware detail out of normal history views.

## 6. Backend Specification

### 6.1 Device-to-card mapping

Mapping rules:

| Physical source | Thematic card output |
| --- | --- |
| KIWI_SENSOR with SWT channels | Soil Card |
| KIWI_SENSOR with temp/humidity/light | Environment Card |
| TEKTELIC_CLOVER with VWC/temp/humidity | Soil and/or Environment Card |
| DRAGINO_LSN50 with `dendro_enabled` | Dendro Card |
| DRAGINO_LSN50 with Chameleon/I2C soil data | Soil Card |
| DRAGINO_LSN50 with external temp | Environment Card |
| SENSECAP_S2120 | Environment Card |
| STREGA_VALVE | Irrigation Card |
| Edge system/gateway identity | Gateway Card |
| Cloud GATEWAY device row | Gateway Card |

The mapping layer should return logical cards, not physical card components.

### 6.2 Sensor-channel grouping

Define channel groups:

- `soil_tension`
- `soil_vwc`
- `soil_profile`
- `stem_growth`
- `stem_shrinkage`
- `daily_growth`
- `air_temperature`
- `relative_humidity`
- `light`
- `rain`
- `wind`
- `pressure`
- `uv`
- `valve_state`
- `irrigation_event`
- `gateway_health`
- `sync_state`

Each group should define:

- Units
- Valid range
- Status thresholds
- Aggregation functions
- Allowed standard overlays
- Advanced-only overlays

### 6.3 Date-range-aware card availability

Card availability should consider:

- Zone assignment.
- Device capability flags.
- Actual data in the selected range.
- Last seen timestamp.
- Calibration availability.
- Current sync state.

Availability states:

- `available`
- `available_no_recent_data`
- `needs_calibration`
- `not_configured`
- `unsupported`

Normal card lists should include important unavailable cards only when they help the farmer understand what is missing. Advanced details should explain the hardware reason.

### 6.4 Aggregation buckets

Edge implementation:

- SQL can compute count/min/max/avg/latest for simple numeric fields.
- Median may need helper code or be omitted until a documented approximation exists.
- Dominant status should be computed after values are classified.
- Coverage should compare observed samples against expected cadence per source/channel.
- Add composite indexes for raw-range reads: `device_data(deveui, recorded_at)` and any missing `(deveui, recorded_at)` indexes on history tables used by card endpoints.
- Run `ANALYZE` after adding indexes.
- Use `history_channel_rollups` for 30D and Season.

Cloud implementation:

- PostgreSQL can compute short-range bucketed aggregations from `sensor_data`, but long-range history must not depend on repeated live JSONB extraction.
- Prediction and weather overlays should be joined after base bucket computation.
- MVP must include typed hourly/daily rollup tables for 30D and Season. Existing daily tables are supplemental context only, not a substitute for typed measured-channel rollups.

Recommended rollup table shape, adapted per database:

```sql
CREATE TABLE history_channel_rollups (
  id INTEGER PRIMARY KEY,
  zone_id INTEGER NOT NULL,
  card_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  bucket_level TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  bucket_end TEXT NOT NULL,
  min_value REAL,
  max_value REAL,
  mean_value REAL,
  median_value REAL,
  latest_value REAL,
  dominant_status TEXT,
  dominant_status_method TEXT,
  coverage_pct REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  threshold_crossing_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Minimum indexes:

```sql
CREATE INDEX idx_history_rollups_zone_card_bucket
  ON history_channel_rollups(zone_id, card_type, bucket_level, bucket_start);

CREATE INDEX idx_device_data_deveui_recorded_at
  ON device_data(deveui, recorded_at);
```

Coverage calculation:

```text
coveragePct = observed_sample_count / expected_sample_count_for_source_and_bucket * 100
```

The expected cadence must be source-aware. A dendrometer, SWT sensor, weather station, and valve event stream should not share a single expected interval.

Expected cadence derivation:

- Prefer explicit device configuration when available.
- Otherwise compute a rolling median sample delta over the previous 7 days for that source/channel.
- Store the derived value in a helper-owned cadence cache or return it in aggregation metadata.
- Mark coverage confidence as `configured`, `derived`, or `unknown`.
- If cadence is unknown, return `coveragePct: null` and an interpretation explaining that coverage could not be scored.

Dominant status:

- Dominant status is only valid when a channel group defines an ordered or priority-based status rule.
- Soil may use dry/wet/optimal priority.
- Environment must define separate dominance rules such as `heat_stress_over_normal` before returning `dominantStatus`; otherwise omit it.

### 6.5 Rule-based local interpretation

Add a deterministic rule engine on edge.

Rule categories:

- Soil status and recovery.
- Dendro daily stress/recovery.
- Irrigation timing/effectiveness.
- Environment stress.
- Data quality and gaps.
- Gateway/sync health.

Initial rules should consume existing tables only. Do not require cloud data for local explanations.

Recommended edge rule output:

- `id`
- `source`
- `severity`
- `title`
- `body`
- `evidence`
- `createdAt`

### 6.6 Cloud / Server extensions

Cloud should expose the same history API contract with additional fields:

- Forecast boundary markers.
- Weather context.
- Prediction confidence.
- Actual-vs-predicted deltas.
- Cross-zone comparison summaries.
- Cross-season summary statistics.
- AI explanation blocks.
- Satellite indicator blocks.
- Export metadata.

Initial cloud implementation should integrate existing prediction APIs before introducing new AI/satellite services.

### 6.7 Saved workspaces

Backend responsibilities:

- CRUD workspaces.
- Validate workspace card IDs against current farm/zone access.
- Preserve unknown future JSON fields for compatibility.
- Return default workspace when available.
- Support local-only edge workspaces and cloud saved/shared workspaces.

Authorization and ownership:

- Edge MVP should treat workspaces as local to the authenticated local user and validate zone access using the same JWT/user ownership pattern used by existing Node-RED endpoints.
- If the product confirms a single-user edge assumption, the schema may keep `user_id` for compatibility but does not need multi-tenant sharing semantics on the Pi.
- Cloud must validate farm/zone access for every workspace read and write.
- Any future edge-to-cloud workspace sync must key owner identity by stable linked account UUID, not local SQLite autoincrement `users.id`.

Suggested endpoints:

Edge:

- `GET /api/history/workspaces`
- `POST /api/history/workspaces`
- `PUT /api/history/workspaces/:id`
- `DELETE /api/history/workspaces/:id`

Cloud:

- `GET /api/v1/history/workspaces`
- `POST /api/v1/history/workspaces`
- `PUT /api/v1/history/workspaces/:id`
- `DELETE /api/v1/history/workspaces/:id`
- `POST /api/v1/history/workspaces/:id/share` post-MVP

### 6.8 Usage scoring and pinning

Backend responsibilities:

- Persist pin state.
- Persist open count and last opened.
- Persist last view mode per card.
- Return ordering metadata in card list responses.

Suggested endpoints:

Edge:

- `PUT /api/history/zones/:zoneId/cards/:cardId/preferences`
- `POST /api/history/zones/:zoneId/cards/:cardId/opened`

Cloud:

- `PUT /api/v1/history/zones/:zoneId/cards/:cardId/preferences`
- `POST /api/v1/history/zones/:zoneId/cards/:cardId/opened`

### 6.9 Sync considerations

MVP recommendation:

- Do not change edge/cloud sync contracts for card definitions. Cards are derived from existing synced resources.
- Keep edge workspaces/preferences local-only unless product requires roaming preferences.
- Keep cloud workspaces/preferences cloud-owned.
- Preserve the edge invariant that operational state mutations are explicit. If workspace/preference mutations are not synced, document them as local UI state and do not emit sync outbox events for them.

If roaming preferences are required:

- Add new resource types to the sync schema after a separate design review.
- Use stable user and zone identifiers such as linked account UUID and `zone_uuid`, not local autoincrement IDs.
- Avoid cloud-originated workspace commands changing local operational state.
- Keep history preferences distinct from irrigation control commands.

### 6.10 API behavior and observability

Error and empty-state contract:

- Card summary endpoints should return 200 with `availability.available=false` for configured-but-unavailable cards.
- Card data endpoints should return 200 with empty `series` and an explanation when the card exists but has no data in the selected range.
- Return 404 only when the zone/card is not known or not accessible.
- Return 400 for unsupported view/range/aggregation combinations.
- Return 403 for cloud workspace/card access denied.

Limits:

- Every card data response should include `limits.maxPointsPerSeries`, `limits.maxEvents`, `limits.maxInterpretations`, and `limits.truncated`.
- The backend should downsample or reject requests that exceed platform limits rather than returning unbounded arrays.

Cache and freshness:

- Frontends should key SWR caches by zone, card ID, view, range, aggregation, and selected overlays.
- Edge responses may use short cache lifetimes for local history because data is local and mutable.
- Cloud responses should include enough freshness metadata to distinguish cloud sync delay from sensor gaps.

Observability:

- Track per-card endpoint duration.
- Track selected aggregation level distribution.
- Track rollup cache hit/miss or raw-scan fallback counts.
- Track data truncation events.
- Track frontend comparison panel counts and render failures.

## 7. Migration Plan

### 7.1 Minimal schema changes

Edge additive tables:

- `history_card_preferences`
- `history_workspaces`
- `zone_seasons`
- `history_channel_rollups`

Cloud additive tables:

- `history_card_preferences`
- `history_workspaces`
- `history_workspace_shares` post-MVP
- `zone_seasons`
- typed hourly/daily history rollup tables for measured card channels

Additive indexes:

- Edge `device_data(deveui, recorded_at)`.
- Edge any missing `(deveui, recorded_at)` indexes for Chameleon, dendro, or card-specific raw tables.
- Cloud expression indexes may support short raw JSONB reads, but they do not replace rollups for long ranges.

Migration post-step:

- Run `ANALYZE` after SQLite index creation.
- Update bundled DB copies and verify schema consistency.

No existing table replacement is required for MVP.

### 7.2 Compatibility with existing devices

Existing physical device rows remain unchanged.

Compatibility rules:

- If a device has no zone assignment, show it in existing dashboard flows and omit it from zone thematic cards until assigned.
- If a card source lacks calibration, show the card with `needs_calibration` metadata where useful.
- Legacy SWT aliases remain readable.
- Current device settings remain accessible from device management or Advanced View.

### 7.3 Backwards compatibility for current dashboard

The current dashboard should remain available during rollout.

Recommended rollout:

- Add History as a new route or gated panel.
- Reuse existing APIs initially where possible.
- Introduce new card APIs behind a feature flag.
- Keep existing device modals working until card views reach parity.

### 7.4 Feature flags

Recommended flags:

- `historyUxEnabled`
- `historyComparisonEnabled`
- `historyWorkspacesEnabled`
- `historyAdvancedOverlaysEnabled`
- `historyCloudAiEnabled`

Prefer runtime-configurable flags where possible on the edge, because Vite build-time environment flags are inconvenient on deployed Pi images.

Runtime flag endpoint:

- Add `GET /api/system/features` on edge and `GET /api/v1/system/features` or equivalent on cloud before relying on runtime flags.
- The frontend shell should fetch feature flags once during app bootstrap and cache them with SWR.
- If the endpoint is not implemented in a phase, use build-time flags explicitly and document the image-build workflow for flipping them.

### 7.5 Data migration safety

Edge:

- Add SQLite migrations or idempotent repair steps.
- Never replace `/data/db/farming.db` on a running or previously provisioned Pi.
- Update bundled DB copies and verify schema consistency.

Cloud:

- Use additive Flyway migrations.
- Do not alter existing sync semantics for telemetry without a separate migration plan.

## 8. Implementation Roadmap

### 8.1 MVP phase

Goal:

- Deliver thematic history cards and semantic time navigation on OSI OS and establish the same contract on OSI Cloud.

Work:

- Add static history card definitions to both frontends.
- Add the edge `osi-history-helper` module with independent tests and minimal Node-RED flow orchestration.
- Add edge composite indexes, `ANALYZE`, rollup table, and cadence derivation.
- Add cloud typed hourly/daily rollups for 30D/Season.
- Add the zone season model required for `range=season`.
- Add card summary API on edge and cloud.
- Add card data API for raw/auto aggregation.
- Implement Soil, Dendro, Environment, Irrigation, and Gateway cards.
- Implement mobile card carousel.
- Implement card-specific view controls.
- Implement 12h, 24h, 7D, 30D, Season.
- Implement basic semantic zoom and aggregation indicator.
- Implement local rule-based explanations for the listed examples.
- Implement Calendar views for all MVP card types.
- Implement desktop single-card mode.
- Implement basic stacked comparison mode behind `historyComparisonEnabled`, capped at 4 visible edge panels until Pi browser performance is validated.
- Implement mouse wheel zoom, marquee zoom, and timeline brush.
- Add card pinning and learned ordering tables.
- Add local saved workspaces.
- Keep legacy dashboard available.

Verification:

- Edge: `node scripts/verify-sync-flow.js`
- Edge: `scripts/check-mqtt-topics.sh`
- Edge frontend: `cd web/react-gui && npm run test:unit && npm run build`
- Cloud frontend: run existing frontend test/build commands in `/home/phil/Repos/osi-server/frontend`
- Cloud backend: run backend unit/integration tests in `/home/phil/Repos/osi-server/backend`

### 8.2 Cloud / Server advanced phase

Goal:

- Turn OSI Cloud into the desktop analysis surface.

Work:

- Integrate prediction trajectory and comparison data into card data responses.
- Add forecast overlays and forecast boundary markers.
- Add cross-zone comparison.
- Add cross-season comparison.
- Add saved/shared cloud workspaces.
- Add exportable reports.
- Add anomaly detection if a backend service is defined.
- Add AI-assisted interpretation after provider/service decisions.
- Add satellite-informed indicators after ingestion/model decisions.
- Integrate Terra field-state views as advanced soil/environment workspace surfaces.

### 8.3 Post-MVP phase

Work:

- Performance-tune large comparison workspaces.
- Add virtualized panel rendering.
- Add materialized cloud aggregations for multi-season analysis.
- Add richer alerting and critical-card promotion.
- Add workspace sync if selected.
- Add richer Advanced View diagnostics after ingestion captures RSSI/SNR/firmware/raw payload consistently.

## 9. Risks and Dependencies

High-risk items:

- Cloud JSONB aggregation cost for long ranges.
- SQLite TEXT timestamp grouping cost on the Pi.
- Missing composite indexes for card range queries.
- Edge helper-module packaging and profile parity.
- Semantic zoom and gesture separation on mobile.
- Chart performance for dense raw data and comparison panels.
- Mobile browser gesture conflicts with native pull-to-refresh and pinch zoom.
- Consistent coverage computation across device cadences.
- Season-range definition on edge.
- Workspace owner identity if preferences/workspaces are ever synced.
- Advanced View data completeness, especially RSSI/SNR/firmware/raw payload.
- Keeping Node-RED flows maintainable if too much aggregation logic is embedded directly.
- Aligning edge and cloud contracts without forcing sync changes too early.

Dependencies:

- Implementation must follow the accepted Slice 0 card-key strategy for multi-source zones.
- Implementation must keep edge workspaces/preferences local-only for MVP.
- Implementation must add `zone_seasons` before enabling Season.
- Implementation must use the existing `/usr/share/node-red/osi-*-helper` helper placement pattern.
- Cloud decision for AI and satellite service boundaries.

## 10. File-Level Implementation Map

### OSI OS frontend

Create:

- `web/react-gui/src/history/*`
- `web/react-gui/src/components/history/*`
- `web/react-gui/src/pages/HistoryDashboard.tsx`

Modify:

- `web/react-gui/src/services/api.ts`
- `web/react-gui/src/types/farming.ts` or add `types/history.ts`
- Route registration if the app has a central route file
- `FarmingDashboard.tsx` only to link or gate the new experience

Reuse:

- Existing farming components for transitional data and settings flows.
- Existing `EnvironmentCard`, dendro components, and monitor logic as references, not as final history architecture.

### OSI OS backend

Modify:

- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- mirrored `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`
- mirrored `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package.json`
- `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` only if helper loading needs global context, which should be avoided unless required
- `database/seed-blank.sql`
- `database/migrations/*`
- `scripts/repair-pi-schema.js` if schema repair is needed
- `scripts/verify-db-schema-consistency.js` if schema expectations change
- `scripts/verify-sync-flow.js` if endpoint verification is added
- `scripts/verify-profile-parity.js` if helper directories are not already covered

Create:

- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/package.json`
- mirrored bcm2709 helper files
- helper tests under the existing scripts/test structure selected during implementation planning

### OSI Server frontend

Create:

- `/home/phil/Repos/osi-server/frontend/src/history/*`
- `/home/phil/Repos/osi-server/frontend/src/components/history/*`
- `/home/phil/Repos/osi-server/frontend/src/pages/HistoryDashboard.tsx`

Modify:

- `/home/phil/Repos/osi-server/frontend/src/services/api.ts`
- `/home/phil/Repos/osi-server/frontend/src/types/farming.ts` or add `types/history.ts`
- Dashboard route/navigation files

Reuse:

- `deviceRegistry.tsx` pattern for static registration.
- `PredictionCard` data concepts for cloud overlays.
- Terra field-state concepts for advanced spatial views.

### OSI Server backend

Create:

- `org.osi.server.history.HistoryController`
- `org.osi.server.history.HistoryService`
- `org.osi.server.history.HistoryAggregationService`
- `org.osi.server.history.HistoryCardService`
- `org.osi.server.history.HistoryInterpretationService`
- DTOs for card summary, card data, advanced view, workspace, preferences

Modify:

- Flyway migrations for workspace/preferences.
- Repositories or query services for aggregation.
- Prediction service integration where card overlays need model confidence/comparison.

## 11. Grill Me Questions

### Priority 1 - Accepted defaults

There are no remaining Priority 1 blockers after Slice 0. The accepted implementation decisions in Section 1.2 are the planning baseline unless a later decision record supersedes them.

### Priority 2 - Needed before implementation planning

1. Should OSI OS start storing LoRa RSSI/SNR/firmware/raw payload history for Advanced View, or should Advanced View initially show these fields only when already present?
2. For Advanced View diagnostics, should old rows return `not_collected_at_time` once new ingestion starts, or should the UI collapse unavailable diagnostics by default?
3. Should critical alert promotion use only existing water-stress/freshness signals, or should a new alert/event table be introduced before learned ordering ships?
4. Should cloud workspaces be shareable in the first cloud phase, or only saved privately with sharing added later?
5. Should edge workspaces assume one local farmer per Pi, or do we need multi-user local workspace isolation now?

### Priority 3 - Can be resolved during UI refinement

1. What exact labels and icons should each card use in farmer-facing navigation?
2. Should Advanced View use separate drawers per card type, or one common drawer with card-specific sections?
3. Which color states should be standardized for dry/optimal/wet, dendro stress, environment stress, and irrigation effectiveness?
4. How much explanatory text should appear inline on mobile before moving content into the inspector sheet?
5. Should AI explanations be labeled as AI output, assistant output, or model interpretation in the Cloud UI?
6. Should the legacy 90D chart window remain as an expert range after Season is implemented?
