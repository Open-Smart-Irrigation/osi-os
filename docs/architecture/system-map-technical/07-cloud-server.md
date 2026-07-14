# 07 — Cloud server (osi-server)

[← Sync protocol](06-edge-cloud-sync.md) · [Index](README.md) · [→ Operations](08-operations.md)

Paths in this chapter are relative to the osi-server repo. Reference:
`osi-server/AGENTS.md`.

One Spring Boot application (Java 17 source, JRE 21 runtime, Lombok,
constructor injection) with the React frontend embedded in the JAR
(`classpath:/static/`; the nginx frontend image under `docker/frontend/` is
legacy and unused). PostgreSQL 16 under Flyway. Mosquitto (8883 TLS) for
inbound gateway telemetry. A Python prediction service on `:8090`. Docker
Compose behind Caddy. Production `osicloud.ch` is restricted access; the test
host is `server.opensmartirrigation.org`.

## Backend packages

All under `backend/src/main/java/org/osi/server/`. File counts from the
snapshot indicate relative size.

| Package | Responsibility and key classes |
|---|---|
| `sync/` (36) + `sync/history/` | Edge sync ingress: `EdgeSyncController`/`EdgeSyncService` (events, bootstrap, status, reconciliation), `SyncEventApplier` per-operation application, `SyncPayloadCanonicalizer` (golden-vector canonical hashes), `SyncEventTxExecutor`, `SyncExceptionClassifier`, dead letters (`SyncDeadLetter*` + admin controller), `SyncResourceWatermark*`, `SyncHealthController`. History ingest: `EdgeHistoryIngestService`, `HistoryManifestIngestService`, `HistoryHashV1`, `HistoryColumnEncoder`, quarantine/segment/row-index repositories. |
| `command/` (9) | Pending-command store and lifecycle: `CommandService`, `DeviceCommand(Repository)`, `CommandLeaseService` (delivery leases), `CommandAckController`, `LegacyCommandClassifier`. |
| `mqtt/` (6) | `MqttSubscriberService` + `MqttMessageRouter` dispatch heartbeat/telemetry/status/ACK topics to domain services; `DeviceMqttProvisioningService` and `DeviceMqttCredentialReconciler` manage per-gateway broker credentials; `MqttPublisherService` is `@Deprecated` (no cloud→edge MQTT). |
| `user/` (14) | `AuthController` (register/login), user admin controllers, gateway linking: `LocalSyncService`, `LinkedGatewayAccount(Repository/Service)`, `LinkedGatewaySyncService`. |
| `security/` (7) | `JwtTokenProvider` + `JwtAuthenticationFilter`, `RateLimitFilter` (Bucket4j, 10 req/min/IP on `/auth/**`, wired in `SecurityConfig`), `EdgeOwnershipService` (gateway/zone ownership checks), `ClientIpResolver`. |
| `config/` (10) | `SecurityConfig`, `MqttConfig`, `WebSocketConfig` (STOMP/SockJS), `AsyncConfig`, CORS configs, `GlobalExceptionHandler`, `SpaController` (SPA fallback), `SystemFeatureController`, `DataInitializer` (super-admin bootstrap from `SUPERADMIN_*`/`ADMIN_*`; startup fails without an enabled super admin). |
| `device/` (7) | Mirrored device registry: `DeviceService/Controller`, `DeviceResponseMapper`, `DeviceRegistrationSyncStatusService`; `DeviceType` is a string-constant class (types stored as VARCHAR). |
| `zone/` (16) | Mirrored zones/schedules plus cloud-only geometry: `IrrigationZone*`, `IrrigationSchedule*`, `ZoneFieldGeometry*`, `ZoneSensorAnchor*`, `ZoneEffectiveGeometryService`, geometry sampling support. |
| `telemetry/` (3) | `SensorData(Repository)` raw telemetry with retention. The cloud has no `device_data` table; bulk history lives in mirror tables fed by shadow sync. |
| `gateway/` (3) | `GatewayLocation*` records and API. |
| `analytics/` (64) | Weather: provider implementations (`OpenMeteoService`, `AgroMonitoringWeatherService`, `OpenAgriWeatherService`, `MeteoSwissWeatherService`) behind `WeatherResolver`/`WeatherProvider`/`WeatherProperties`; `Et0Resolver` tiers native ET0 → FAO-56 Penman-Monteith (`WeatherMath.fao56Et0`) → Hargreaves-Samani; ET0 is cloud-only. Dendro v6: `DendroAnalyticsService` + `DendroScheduler` compute self-calibrating `TWD_rel` against `DendroBaseline*` (edge keeps v5; no edge consumer yet). Shadow controllers, compute-only: RDI (`RdiShadowService`, `RdiController`, `RdiSetpoint`, `DendroRdiDaily/State*`) and Agroscope parity (`AgroscopeShadowService`, `AgroscopeAggregator`, `AgroscopeStressExtractor`, `AgroscopeShadowDaily/State*`, `AgroscopeController`). Zone environment: `ZoneEnvironmentService`, `ZoneDailyEnvironment*`, `ZoneDailyRecommendation*`, `WeatherStationZone*`, `IrrigationEvent*`, `SolarWindows`, QA flags. |
| `prediction/` (41) | Bridge to the Python service: `PredictionInputAssembler` + `PredictionSpatialUnitAssembler` build run inputs from zone, soil, geometry, and weather; `PredictionScheduler`/`PredictionRunService` orchestrate multi-track runs (live, shadow, reference) persisted as `ZonePrediction*` entities with run comparisons; `PredictionController` + `AdminPredictionController` expose them; `FaoReferenceClient` calls the FAO service; crop knowledge in `PredictionCropProfiles`/`PredictionCatalog`; checkpoint backfill and clustered shadow hydrology services. |
| `history/` (54) | Cloud twin of the edge history API over the Postgres mirror: `HistoryService`, `HistoryCardService`, `HistoryAggregationService`, JDBC raw/rollup repositories, `HistoryRollupScheduler` + maintenance and admin controllers, `HistoryExportService`/`HistoryCsvWriter`, `HistoryInterpretationService`, `HistoryThresholdClassifier`, workspaces and card preferences. |
| `analysis/` (29) | Cloud twin of cross-zone analysis: `ChannelRegistry`, `AnalysisCatalogService`, `AnalysisSeriesService` with `AnalysisRangePolicy`/`AnalysisGridAligner`/`AnalysisLimits`, saved views (`AnalysisView*`), `SeriesIdAliasResolver`. |
| `chameleon/` (18) | Global calibration authority: `ViaFarmClient` (via.farm fetch, `VIA_FARM_API_TOKEN`), `ChameleonCalibrationsService`, `KpaCurve`, `SensorIdDerivation` (`array_id[2:4]+array_id[14:16]`), miss cache, `ChameleonRecomputeService/Listener` (backfills `chameleon_readings.swt_*` on calibration arrival), sync + admin controllers. |
| `soil/` (6) | SoilHive OAuth2 integration: `SoilHiveClient`, `ZoneSoilProfile*`; feeds prediction inputs. |
| `workrequest/` (30) | Work-request intake and the Forge API: `WorkRequestIntakeService`, `WorkRequestRedactor`, `WorkRequestPseudonymService`, `PublicArtifactSecretScanner`, `WorkRequestRateLimiter`, `WorkRequestGeoIpResolver`, GitHub issue filing (`GitHubIssueClient`, `GitHubAppTokenService`), `WorkRequestStatusNotifier` (status back to gateways), admin triage (`WorkRequestAdminController/Service`), gateway controls, diagnostics retention, `ForgeController`/`ForgeService`/`ForgeTokenFilter`. |
| `retention/` (5) | Scheduled cleanup: `TelemetryRetentionJob`, `CommandRetentionJob`, `SyncInboxRetentionJob`, `SyncDeadLetterRetentionJob`, `DbHealthCounters`. |
| `websocket/` (2) | `DeviceWebSocketHandler` pushes device updates to browsers over STOMP. |
| `channels/` (1) | `ChannelManifest`, parity-checked against the edge manifest by `scripts/verify-channel-manifest-sync.js`. |

## Database and migrations

PostgreSQL 16, Flyway-managed, `ddl-auto: validate`. Migrations in
`backend/src/main/resources/db/migration/`: 61 files at the snapshot, legacy
numeric `V1..V41` plus date-versioned `V2026_MM_DD_*`. Applied migrations are
immutable; new date versions must sort after the highest applied version.
Documented Postgres pitfalls: enum values added and referenced in the same
transaction fail, and partial-index predicates must avoid non-IMMUTABLE
expressions (provenance: `V2026_05_16_011/012`).

## Frontend

`frontend/src/`, React + TypeScript + Vite, built by Gradle
`processResources` into the JAR. Pages: `Dashboard.tsx` (mirror dashboard;
edits on gateway-backed farms surface as pending until the edge ACKs),
`DeviceDetail.tsx`, `HistoryDashboard.tsx`, `CrossZoneAnalysisPage.tsx`,
`Account.tsx`, auth pages, and `admin/` (`AdminUsers.tsx`,
`AdminDevices.tsx`, `AdminWorkRequests.tsx`, `AdminPrediction.tsx`).
`services/api.ts` centralizes REST and carries the compatibility bridge
(`normaliseDevice()`, `normaliseZone()` mapping camelCase JSON to the
snake_case shapes shared with the edge GUI); `services/websocket.ts` is the
STOMP client. `history/`, `analysis/`, `channels/`, `i18n/` mirror the edge
GUI's module layout. Tests run with `npm run test:unit` (tsx runner +
Vitest, same split as the edge GUI); no ESLint/Prettier is configured.

## Terra Intelligence

`terra-intelligence/`: standalone Vite app served at `/terra-intelligence`.
Zone digital-twin view: `src/map/terraMapLayers.ts`, `src/moistureModel.ts`,
`src/cropVisuals.ts`, live-data adapter `src/terraLive.ts`. Direct access
runs demo data; the dashboard launches it with
`?zoneId=<id>&returnUrl=<same-origin path>` (URL-validated, fallback
`/dashboard`).

## Prediction service

`prediction-service/`: FastAPI + uvicorn on `:8090`, shared bearer token
(`PREDICTION_SERVICE_TOKEN`). `app/engine.py` implements an AquaCrop-style
daily soil-water balance; `app/models.py` payload schemas;
`app/recommendation.py` converts balances to irrigation advice;
`app/assimilation.py` nudges state toward observed sensor data;
`app/model_backends.py` + `app/chronos_runtime.py` pluggable forecast
backends; `app/evaluation.py`/`evaluation_store.py` score predictions;
`app/shadow_adapter.py` shadow-track runs; `app/fao_reference*.py` an
optional FAO-56 reference service on `:8091`
(`PREDICTION_REFERENCE_ENABLED=true`). Weather resolution chain:
OpenAgri → AgroMonitoring → Open-Meteo, with in-process caches. Tests under
`tests/`; a compose-driven validation harness under `validation/`.

## Deployment

`docker/docker-compose.yml`: postgres, mosquitto (self-signed CA generated
on first start into a named volume; gateways must trust it or set
`tls_insecure`), backend (three-stage build: Node 20 frontends → Gradle →
JRE 21), prediction-service (+ optional `fao-reference-service`, validation
profile), OpenAgri weather stack with MongoDB, all attached to the external
`caddy-net` for the reverse proxy. The VPS is small (4 CPU / 4 GB); rollouts
build one service at a time (`docker compose build backend && docker compose
up -d --no-deps backend`) or ship prebuilt images via GHCR
(`.github/workflows/ghcr-publish.yml`).

Also in the repo: `android/` ("OSI Cloud",
`org.opensmartirrigation.osiserver`, a native wrapper around the web app),
`mqtt/nodered-flows/` (reference copy of the edge sync tab),
`forge/` (chapter [08](08-operations.md)), `review/` and `docs/` (including
`docs/prediction/architecture.md`).
