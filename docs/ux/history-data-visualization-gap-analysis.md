# History / Data Visualization Gap Analysis

Status: companion summary to [history-data-visualization-redesign-spec.md](history-data-visualization-redesign-spec.md)
Last reviewed against code: 2026-05-31

## 1. Current Architecture Snapshot

### OSI OS

- Frontend: `web/react-gui`, Vite React, TypeScript, SWR, axios, Recharts.
- Main dashboard: `web/react-gui/src/pages/FarmingDashboard.tsx`.
- Main zone/device composition: `web/react-gui/src/components/farming/IrrigationZoneCard.tsx`.
- Current history components: `SensorMonitor.tsx`, `DendrometerMonitor.tsx`, `dendrometer/DendrometerMonitor.tsx`.
- Local backend: Node-RED flow JSON at `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`.
- Local DB: SQLite schema at `database/seed-blank.sql`.
- Current API style: physical device and field oriented.

### OSI Server / Cloud

- Frontend: `/home/phil/Repos/osi-server/frontend`, Vite React, TypeScript, SWR, axios, Recharts.
- Main dashboard: `/home/phil/Repos/osi-server/frontend/src/pages/Dashboard.tsx`.
- Current registry: `/home/phil/Repos/osi-server/frontend/src/components/farming/deviceRegistry.tsx`.
- Backend: Spring Boot under `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server`.
- DB: PostgreSQL with Flyway migrations.
- Prediction service: `/home/phil/Repos/osi-server/prediction-service`.
- Terra field visualization: `/home/phil/Repos/osi-server/terra-intelligence`.
- Current API style: physical device, sensor history, dendro, environment summary, prediction.

## 2. What Already Aligns With the Target UX

The target UX can build on these existing foundations:

- Zones already group devices.
- Devices already carry capability flags and latest data.
- Edge SQLite has soil, dendro, chameleon, environment, irrigation, gateway, and sync data sources.
- Cloud PostgreSQL mirrors edge history and adds prediction-related tables.
- Existing APIs expose raw sensor history, dendro daily analytics, environment summaries, recommendations, and irrigation events.
- Existing Recharts components can support MVP line charts and simple brush interactions.
- Cloud already has a static registry pattern in `deviceRegistry.tsx`.
- Gateway UI already exists, although edge and cloud represent it differently.
- Prediction and Terra code provide a foundation for cloud-only overlays and advanced analysis.

## 3. Major Gaps

| Area | Current state | Target state | Gap |
| --- | --- | --- | --- |
| UX model | Zone -> physical device card -> modal | Zone -> thematic card -> card-specific view -> inspector | Needs thematic card abstraction |
| Device identity | Visible in normal UI | Mostly hidden except Advanced View | Needs display/data separation |
| View modes | Generic chart/modal patterns | Card-specific modes | Needs per-card definitions |
| APIs | Device EUI + field | Zone + card + view + range | Needs new history APIs |
| Aggregation | Raw or near-raw rows | Raw/15m/hourly/daily/weekly semantic zoom | Needs backend aggregation |
| Calendar | Not present | Theme-specific calendar states | Needs state computation |
| Interpretation | Dendro/environment summaries only | Edge local rules, cloud advanced rules | Needs rule engine |
| Mobile gestures | Basic browser interactions | pinch, pan, long press, double tap, pull refresh | Needs gesture layer |
| Desktop analysis | Device dashboard | single-card workspace plus comparison | Needs workspace layout |
| Comparison | Not unified | stacked synchronized panels | Needs shared viewport/crosshair |
| Saved workspaces | Not present | required on desktop | Needs schema/API/UI |
| Learned ordering | Not present | pinned, frequent, recent, alert-aware | Needs schema/scoring |
| Overlay policy | Ad hoc | standard vs advanced-only overlays | Needs policy enforcement |
| Advanced View | Scattered device settings | normalized per-card diagnostics | Needs contract |
| Cloud AI/satellite | Not found | AI/satellite interpretation | Needs new services/sources |

## 4. Critical Review Consolidation

The critical review raised several findings that change implementation planning. These are now reflected in the redesign spec.

### Accepted blockers

- Cloud long-range aggregation over `sensor_data.data_json` JSONB is not acceptable for MVP-scale 30D, Season, or multi-season views. The spec now requires typed rollups or explicit use of existing daily aggregate tables for long ranges.
- Edge long-range aggregation over TEXT `recorded_at` values is not acceptable without a performance plan. The spec now requires composite indexes, `ANALYZE`, and rollups where raw scans exceed budget.
- The edge helper module must use a concrete packaging path. The spec now names the existing `/usr/share/node-red/osi-*-helper` pattern and requires mirrored bcm2712/bcm2709 payloads.
- `range=season` needs explicit season boundaries. The spec now requires a `zone_seasons` model or hiding/removing Season until configured.
- Card identity for multi-source themes remains a P1 blocker. API, workspace, and preference work should not begin until merged-vs-per-source behavior is chosen.
- Comparison mode on OSI OS must be capped and feature-gated until Pi browser performance is validated.

### Accepted high-priority refinements

- Workspace/preference sync must not use local autoincrement `users.id` as a stable identity.
- Workspace JSON needs schema migration and dangling-card behavior.
- Threshold ownership must be centralized so calendar states, charts, and interpretations do not drift.
- Coverage requires source-specific cadence derivation and an unknown-cadence fallback.
- Cloud Gateway Connectivity Timeline requires persisted heartbeat/status history; otherwise that view is unavailable.
- Mobile gestures require validation on real mobile browsers against the Pi-served GUI.

### Re-scoped items

- The old 90D window is no longer a blocker. It is a UI refinement decision after Season is modeled.
- A shared cross-repo frontend package is not required for MVP. The spec accepts parallel modules with contract tests to reduce drift.

## 5. Codebase-Specific Conflicts

### Physical-device-first rendering

`FarmingDashboard.tsx`, `IrrigationZoneCard.tsx`, and cloud `Dashboard.tsx` render hardware cards. A single physical LSN50 can produce dendro, soil, and environment thematic cards, so the current component tree cannot directly express the target UX without an intermediate card derivation layer.

### Device-field history endpoints

Current endpoints such as `/api/devices/:deveui/sensor-history?field=...` and `/api/v1/devices/:deviceEui/sensor-history?field=...` expose raw fields. The target UX needs card-level responses that can combine multiple devices, fields, events, and interpretations.

### No semantic aggregation contract

The current UI selects time windows, but the backend does not return aggregation level, coverage, dominant status, threshold crossings, or event counts. The UI cannot show `Raw`, `15 min`, `Hourly`, `Daily`, or `Weekly` truthfully without a new contract.

### Advanced diagnostics data is incomplete

The UX requires DevEUI, raw channel IDs, firmware, RSSI, SNR, calibration state, and raw payload in Advanced View. Existing schemas cover some calibration/raw fields, especially Chameleon payload metadata, but RSSI/SNR/firmware/raw payload are not consistently persisted for all device families.

### Gateway representation differs by product

Edge has `SystemPanel` and local system/sync APIs. Cloud has `GATEWAY` devices and gateway cards. The new Gateway Card should normalize these into one shared card contract while preserving product-specific data.

### Cloud advanced features are partial

Cloud has prediction, soil profile, field geometry, sensor anchors, and Terra field state. It does not yet have a unified AI explanation service, satellite indicator pipeline, saved/shared workspaces, or unified anomaly detection in the inspected code.

## 6. Proposed Minimal Architecture Delta

### Add without replacing

Add a new `history` module to both frontends. Keep the current dashboard and device cards until the new experience reaches parity.

Recommended new frontend modules:

- `src/history/types.ts`
- `src/history/cardDefinitions.ts`
- `src/history/cardAvailability.ts`
- `src/history/overlayPolicy.ts`
- `src/history/useTimeViewport.ts`
- `src/components/history/*`

### Add derived card APIs

Edge:

- `GET /api/history/zones/:zoneId/cards`
- `GET /api/history/zones/:zoneId/cards/:cardId/data`
- `GET /api/history/zones/:zoneId/cards/:cardId/advanced`
- workspace and preference endpoints

Cloud:

- Same contract under `/api/v1/history/...`

### Add additive tables

Edge SQLite:

- `history_card_preferences`
- `history_workspaces`
- `zone_seasons`
- `history_channel_rollups`
- additive composite indexes for raw card queries

Cloud PostgreSQL:

- `history_card_preferences`
- `history_workspaces`
- `history_workspace_shares` later
- `zone_seasons`
- typed hourly/daily rollups or explicit long-range mapping to existing daily aggregates

### Keep card definitions static

Use static in-repo definitions. Do not introduce a dynamic remote plugin system. The existing architecture and ADR favor static, bundled code until there is a concrete second-party plugin candidate.

## 7. MVP Implementation Phases

### Phase 1 - Contract and derivation

- Define shared history TypeScript types.
- Define static card definitions.
- Implement card availability from existing device/zone data.
- Add edge/cloud card summary endpoints.
- Keep legacy dashboard unchanged.

### Phase 2 - Data and aggregation

- Implement card data endpoints.
- Add the edge `osi-history-helper` using the existing bundled helper-module pattern.
- Add edge composite indexes, `ANALYZE`, cadence derivation, and rollups for long ranges.
- Add cloud typed rollups or route long ranges through existing daily aggregates.
- Add the season model before enabling `range=season`.
- Add aggregation levels: raw, 15m, hourly, daily, weekly.
- Add coverage calculation.
- Add irrigation/rain/gap markers.
- Add calendar state responses.

### Phase 3 - UI shell

- Add mobile card carousel.
- Add desktop single-card workspace.
- Add card-specific view controls.
- Add inspector panel/sheet.
- Add timeline viewport controller.

### Phase 4 - Preferences and workspaces

- Add pinning and learned ordering.
- Add saved workspace persistence.
- Add basic comparison mode with stacked synchronized panels behind a feature flag and edge panel cap.

### Phase 5 - Cloud advanced analysis

- Integrate prediction overlays and confidence.
- Add actual-vs-predicted comparison.
- Add cross-zone and cross-season analysis.
- Add exports.
- Add AI/satellite/anomaly features after backend services exist.

## 8. Key Implementation Constraints

- OSI OS must remain offline-first.
- Edge schema changes must be additive and migration-safe.
- Never replace `/data/db/farming.db` on a provisioned Pi.
- Runtime payload changes under the Pi 5 profile must be mirrored to the Pi 2/3/4 profile.
- MQTT topic rules must remain unchanged.
- Cloud-to-edge commands must remain REST-only.
- Sync contracts should not change for MVP unless workspace/preference roaming is explicitly required.
- Heavy history logic should not make `flows.json` unmaintainable.
- Long-range cloud aggregation must not depend on repeated live JSONB extraction.
- Long-range edge aggregation must respect Pi storage and CPU limits.
- Season must be backed by explicit zone season dates.

## 9. Recommended Verification When Implemented

For OSI OS changes:

```bash
node scripts/verify-sync-flow.js
scripts/check-mqtt-topics.sh
cd web/react-gui && npm run test:unit
cd web/react-gui && npm run build
```

For OSI Server changes:

```bash
cd /home/phil/Repos/osi-server/frontend && npm run test
cd /home/phil/Repos/osi-server/frontend && npm run build
cd /home/phil/Repos/osi-server/backend && ./mvnw test
```

Adjust commands to the actual package scripts before implementation.

## 10. Blocking Questions

Priority 1:

- Should multiple same-theme sources in one zone be merged into one thematic card or shown as separate logical-source cards?
- Should OSI OS add explicit `zone_seasons`, or should Season be hidden until a season model exists?
- Should edge workspaces/preferences sync to cloud or stay local-only for MVP?
- Should edge aggregation/interpretation use the existing bundled `/usr/share/node-red/osi-*-helper` pattern, or a formal Node-RED contrib package?
- Should cloud 30D/Season aggregation use new typed rollups in MVP, or only existing daily aggregate tables?
- What comparison panel cap should OSI OS enforce before Pi performance validation?

Priority 2:

- Should ingestion be extended to persist RSSI/SNR/firmware/raw payload for Advanced View?
- Should alert-aware ordering use existing status signals or a new alert table?
- Should comparison mode be enabled by default on Pi hardware?
- Should old diagnostic rows report `not_collected_at_time` after richer RSSI/SNR/raw payload ingestion starts?

Priority 3:

- Final card labels/icons.
- Final calendar colors.
- Final Advanced View layout.
- Final AI explanation labeling.
