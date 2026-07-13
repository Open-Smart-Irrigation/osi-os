# 07 — Cloud Server (osi-server)

[← Sync](06-edge-cloud-sync.md) · [Index](README.md) · [→ Operations](08-operations.md)

All paths in this chapter are relative to the **osi-server** repository
(`/home/phil/Repos/osi-server` on the dev machine). Its own operational
reference is `osi-server/AGENTS.md`.

The cloud is one **Spring Boot** application (Java) with an embedded React
frontend, a **PostgreSQL 16** database managed by Flyway migrations, an MQTT
broker (Mosquitto) it listens to, and a separate **Python prediction service**.
Everything ships as Docker containers behind a Caddy reverse proxy. Production
host: `osicloud.ch` (treated as restricted-access); test host:
`server.opensmartirrigation.org`.

```
Gateways ── REST sync ──► Spring Boot backend ──► PostgreSQL 16 (Flyway-managed)
Gateways ── MQTT TLS ──► Mosquitto ──(subscribed)──► backend ──► WebSocket push ──► React frontend
                                          │
                                          ├──► Python prediction service (:8090, AquaCrop engine)
                                          └──► external APIs: weather providers, via.farm, SoilHive, GitHub
```

## Backend packages (the departments)

All under `backend/src/main/java/org/osi/server/`. Each package is described as
"what this department does"; class names are the door signs.

| Package | What it does |
|---|---|
| `sync/` (+ `sync/history/`) | **The receiving dock for gateways.** Accepts event batches, bootstrap snapshots, and history segments; validates and applies them to the mirror; hands out pending commands; tracks freshness watermarks and a dead-letter drawer for poison events. Key classes: `EdgeSyncController`, `EdgeSyncService`, `SyncEventApplier`, `SyncPayloadCanonicalizer`, `SyncDeadLetterAdminController`, `SyncHealthController`; history ingest in `sync/history/` (`EdgeHistoryIngestService`, `HistoryManifestIngestService`, `HistoryHashV1`). Details in chapter [06](06-edge-cloud-sync.md). |
| `command/` | **The outgoing command desk.** Stores cloud-originated commands per gateway, leases them to polls so none is delivered twice at once, and processes acknowledgements. `CommandService`, `CommandLeaseService`, `CommandAckController`, `DeviceCommand`, `LegacyCommandClassifier`. |
| `mqtt/` | **The telemetry listener.** Subscribes to the broker, routes each gateway message (heartbeat, telemetry, status, ACK) to the right domain service (`MqttSubscriberService`, `MqttMessageRouter`), and provisions per-gateway broker credentials (`DeviceMqttProvisioningService`, `DeviceMqttCredentialReconciler`). `MqttPublisherService` is deprecated by design; the cloud never pushes commands over MQTT. |
| `user/` | **Accounts and gateway linking.** Registration/login (`AuthController`), user admin (`AdminUserController`, `AdminUserDirectoryController`), and the account-link ceremony with gateways (`LocalSyncService`, `LinkedGatewayAccount*`, `LinkedGatewaySyncService`). |
| `security/` | **The guards.** JWT issuing/checking (`JwtTokenProvider`, `JwtAuthenticationFilter`), request rate limiting (`RateLimitFilter`, Bucket4j on `/auth/**`), "does this user own this gateway/zone?" checks (`EdgeOwnershipService`), client IP resolution. |
| `config/` | **The building services.** Spring wiring: `SecurityConfig`, `MqttConfig`, `WebSocketConfig`, `AsyncConfig`, CORS configs, `GlobalExceptionHandler`, `SpaController` (serves the React app for any non-API URL), `SystemFeatureController` (feature flags), and `DataInitializer` (seeds the super-admin account at startup; refuses to start without one). |
| `device/` | **The device registry (cloud view).** Mirrored devices, registration status, API responses: `DeviceService`, `DeviceController`, `DeviceType` (a string-constant catalog, deliberately not a Java enum). |
| `zone/` | **Zones and schedules (cloud view).** Mirrored irrigation zones and schedules plus cloud-only geometry: field outlines (`ZoneFieldGeometry*`), sensor anchor points for maps (`ZoneSensorAnchor*`), effective-geometry math (`ZoneEffectiveGeometryService`). |
| `telemetry/` | **Raw telemetry storage** (`SensorData`, retention-managed). |
| `gateway/` | Gateway location records (`GatewayLocation*`). |
| `analytics/` (64 files, the largest) | **The agronomy department.** Weather: pluggable providers (`OpenMeteoService`, `AgroMonitoringWeatherService`, `OpenAgriWeatherService`, `MeteoSwissWeatherService`) unified by `WeatherResolver`/`WeatherProvider`, reference evapotranspiration via `Et0Resolver` + `WeatherMath` (FAO-56 with fallbacks; cloud-only, the edge never computes ET0). Tree analytics v6: `DendroAnalyticsService` + `DendroScheduler` compute the self-calibrating relative tree-water-deficit (`TWD_rel`) with baselines (`DendroBaseline*`); cloud-only, the edge keeps its own v5. Research controllers running in shadow (compute-only, no actuation): the RDI closed-loop controller (`RdiShadowService`, `RdiController`, `DendroRdiDaily/State`) and the Agroscope parity controller (`AgroscopeShadowService`, `AgroscopeAggregator`, `AgroscopeStressExtractor`, `AgroscopeController`). Zone environment mirroring and summaries (`ZoneEnvironmentService`, `ZoneDailyEnvironment*`, `ZoneDailyRecommendation*`, `WeatherStationZone*`, `IrrigationEvent*`). |
| `prediction/` (41 files) | **The forecasting liaison.** Assembles inputs (zone, soil, weather, geometry) for the Python prediction service (`PredictionInputAssembler`, `PredictionSpatialUnitAssembler`), schedules runs (`PredictionScheduler`, `PredictionRunService`), stores multi-track results (live, shadow, reference: the `ZonePrediction*` entities), compares runs (`ZonePredictionRunComparison*`), exposes farmer and admin APIs (`PredictionController`, `AdminPredictionController`), and talks to the FAO reference service (`FaoReferenceClient`). Crop knowledge in `PredictionCropProfiles`/`PredictionCatalog`. |
| `history/` (54 files) | **The cloud twin of the edge history dashboard backend.** Serves the same cards/workspaces/rollups/CSV-export API from the Postgres mirror so cloud dashboards feel identical: `HistoryService`, `HistoryCardService`, `HistoryAggregationService`, `HistoryRollupScheduler` + maintenance, `HistoryExportService`/`HistoryCsvWriter`, `HistoryInterpretationService` (plain-language "what does this chart mean" strings), `HistoryThresholdClassifier`, workspaces + preferences. |
| `analysis/` (29 files) | **The cloud twin of cross-zone analysis.** Channel registry, series service with range policies and grid alignment (`AnalysisSeriesService`, `AnalysisGridAligner`, `AnalysisRangePolicy`), saved views (`AnalysisViewService`), catalog (`AnalysisCatalogService`), alias resolution for renamed series. |
| `chameleon/` | **The calibration bureau.** Fetches soil-probe calibration curves from via.farm (`ViaFarmClient`, `ChameleonCalibrationsService`, `KpaCurve`, `SensorIdDerivation`), caches misses, serves lookups to gateways, recomputes stored readings when calibrations arrive (`ChameleonRecomputeService`/`Listener`), admin endpoints. |
| `soil/` | **Soil-profile integration** with SoilHive via OAuth2 (`SoilHiveClient`, `ZoneSoilProfile*`): per-zone soil texture/parameters used by predictions. |
| `workrequest/` (30 files) | **The feedback intake office.** Receives improvement requests from gateways and the public form, redacts and pseudonymizes them (`WorkRequestRedactor`, `WorkRequestPseudonymService`, `PublicArtifactSecretScanner`), rate-limits and geo-tags (`WorkRequestRateLimiter`, `WorkRequestGeoIpResolver`), files them as GitHub issues (`GitHubIssueClient`, `GitHubAppTokenService`), notifies status back to the edge (`WorkRequestStatusNotifier`), offers admin triage (`WorkRequestAdminController/Service`), and exposes the Forge agent API (`ForgeController`, `ForgeService`, `ForgeTokenFilter`). Chapter [08](08-operations.md) tells the pipeline story. |
| `retention/` | **The cleanup crew.** Scheduled jobs trimming old telemetry, commands, sync inbox rows, and dead letters (`TelemetryRetentionJob`, `CommandRetentionJob`, `SyncInboxRetentionJob`, `SyncDeadLetterRetentionJob`, `DbHealthCounters`). |
| `websocket/` | **The live-update bell.** Pushes device updates to connected browsers over STOMP/SockJS (`DeviceWebSocketHandler`). |
| `channels/` | `ChannelManifest`, the cloud copy of the shared measurement vocabulary. |

## Cloud database

PostgreSQL 16, schema owned by **Flyway** migrations in
`backend/src/main/resources/db/migration/` (61 files at the snapshot: legacy
numeric `V1…V41` plus date-versioned `V2026_MM_DD_*`). Rules: Hibernate only
*validates* (never creates) schema; applied migrations are never edited or
renumbered; new-enum-value and index pitfalls are documented in
`osi-server/AGENTS.md`. The cloud deliberately has **no `device_data` table**;
bulk sensor history lives in the mirror tables fed by history shadow sync, and
raw telemetry in `sensor_data` with retention.

## Cloud frontend

`frontend/src/`: React + TypeScript (Vite), built by Gradle into the Spring
JAR and served from `classpath:/static/` (the separate nginx frontend image is
legacy and unused).

- Pages: `Dashboard.tsx` (mirrors the edge dashboard for linked farms: devices,
  zones, schedules; edits become pending commands), `DeviceDetail.tsx`,
  `HistoryDashboard.tsx` and `CrossZoneAnalysisPage.tsx` (cloud twins of the
  edge history/analysis pages), `Account.tsx`, `Login.tsx`/`Register.tsx`, and
  the `admin/` area: `AdminUsers.tsx`, `AdminDevices.tsx`,
  `AdminWorkRequests.tsx` (feedback triage), `AdminPrediction.tsx`
  (prediction run monitoring).
- Services: `services/api.ts` (all REST calls; contains the
  camelCase→snake_case compatibility bridge `normaliseDevice()` /
  `normaliseZone()` so cloud and edge frontends share component logic),
  `services/websocket.ts` (STOMP live updates), shared `types/farming.ts`.
- Like the edge GUI it has `history/`, `analysis/`, `channels/`, `i18n/`
  modules; the two frontends are siblings, not forks of each other's pages.

## Terra Intelligence

`terra-intelligence/`: a standalone Vite/TypeScript app served at
`/terra-intelligence`: an illustrated, map-style "digital twin" view of a zone
(crop visuals, moisture shading, sensor anchors). Key files: `src/App.tsx`,
`src/map/terraMapLayers.ts`, `src/moistureModel.ts`, `src/cropVisuals.ts`,
`src/terraLive.ts` (live-data adapter). Opened directly it runs a demo; the
cloud dashboard launches it live with `?zoneId=<id>&returnUrl=…`.

## Python prediction service

`prediction-service/`: FastAPI on `:8090`, shared-token auth. The heart is
`app/engine.py`, an **AquaCrop-style daily water-balance engine**: given soil
properties, crop profile, weather history and forecast, it simulates root-zone
water day by day and produces irrigation-need forecasts. Around it:
`app/models.py` (payload shapes), `app/recommendation.py` (turns balances into
advice), `app/assimilation.py` (nudges the model toward actual sensor
readings), `app/catalog.py` + crop profiles, `app/evaluation.py` +
`evaluation_store.py` (scoring predictions against reality),
`app/model_backends.py`/`chronos_runtime.py` (pluggable forecast backends),
`app/shadow_adapter.py` (shadow-track runs), and `app/fao_reference*.py`, an
optional second service (`:8091`) computing textbook FAO-56 references for
validation. Weather is fetched through the chain OpenAgri → AgroMonitoring →
Open-Meteo with caching. Tests in `prediction-service/tests/`, plus a
validation harness in `prediction-service/validation/`.

## Android app

`android/`: a thin native Android wrapper ("OSI Cloud",
`org.opensmartirrigation.osiserver`) that packages the cloud web app for
phones.

## Docker deployment

`docker/docker-compose.yml` runs the whole stack: `postgres`, `mosquitto`
(8883 TLS, self-signed CA auto-generated on first start), `backend`
(3-stage build: Node builds frontends → Gradle builds the JAR → slim JRE 21
runtime), `prediction-service` (+ optional `fao-reference-service` and a
validation profile), and the OpenAgri weather stack (+ MongoDB). An external
`caddy-net` network connects it to the Caddy reverse proxy that terminates
HTTPS. Safe production rollout pattern and VPS cautions are in
`osi-server/AGENTS.md` ("Live VPS notes").

## Misc

- `mqtt/nodered-flows/osi-server-cloud-integration.json`: a reference copy of
  the edge's cloud-integration flow tab, kept for cloud-side development.
- `review/`, `docs/`, `templates/`: code-review handovers, cloud docs
  (including `docs/prediction/architecture.md`), and rule-overlay templates.
- `scripts/verify-channel-manifest-sync.js` keeps the cloud's channel
  manifest byte-identical with the edge's.
- `forge/`: the Forge automation service (chapter [08](08-operations.md)).
