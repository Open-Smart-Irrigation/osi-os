# EB5b auth-consumer inventory

This is a source audit of the pins in [v1.md](v1.md#sources-and-scope), not a claim that revocation is implemented. The machine-readable [inventory](fixtures/auth-consumers.json) is the full record: each route has its HTTP node id, exact file, entry node, reachable auth nodes, current-check group and any route-specific gap. Every group specifies both flag states and the revocation path.

The canonical flow file is `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`; its `bcm2709` mirror is also in scope. Module paths below are relative to `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`. The audit includes public and refused routes so the coverage check cannot silently omit them.

## Coverage and gaps

The snapshot contains 166 HTTP entry nodes per profile: 73 inline HMAC implementations, 10 direct shared-verifier caller nodes and six further delegated admin guards (89 verifier caller records), 60 module consumer records and 59 flow functions carrying or using borrowed auth state. Ten HTTP entries are OPTIONS/CORS. No flow WebSocket/TCP/UDP nodes exist at this pin. The legacy JSON field `inline_bearer_nodes` contains the 83 lexical verifyBearer matches; each now has an explicit kind, and `verification_callers` includes the six additional guards.

| Gap | Checked finding |
| --- | --- |
| G1 | No persisted per-account session generation or equivalent revocation check in any local bearer verifier. Disabled/enabled and role checks cannot revoke a signed token permanently. |
| G2 | Flag-off branch skips current disabled/role/scope checks or substitutes wildcard admin. Session validity and privileged role checks must apply in both flag states. |
| G3 | resolveScope/assertEnabledAccount/assertRole cache account state for 30 seconds. Invalidation tickets protect in-flight loads, but are not a durable session revocation barrier. |
| G4 | Authorization before queued SQL, async work, writer acquisition or delayed physical dispatch does not prove current rights at apply time. Carry validated session identity and recheck at the final boundary. |
| G5 | Device-owner SQL or ownedValve still refuses a zone grantee after a successful scope check (#451). Remove only after replacing it with current authorized resource targeting. |
| G6 | Radio tools currently use device-scope/writer or admin gates inconsistently. CTO R6 requires the enabled paired gateway owner or enabled gateway admin in both flags, over the whole gateway. No installer role/entitlement or SUPER_ADMIN bypass. |
| G7 | Cloud command identity/current-role enforcement is incomplete: REGISTER_DEVICE, generic system commands, valve schedule helpers and scoped-user/grant mutations need EB5a audit. Cloud transport authority does not prove actor authority. |
| G8 | No durable link incarnation/independent credential revision fences unlink/relink. v1 linked change repeats verifier version 1; edge can replace different verifier at equal version; unlink resets version. Delayed delivery can restore prior credentials/binding. Transport-subject disable can strand even an online revocation. |
| G9 | Browser session epoch isolates client caches after observed logout/401; it is neither server revocation nor push notification. An idle tab can retain its stored token. |
| G11 | Edge GET /api/users lacks grant assignments and flag-off account/grant administration returns 404. CTO R2 requires real admin on fresh bootstrap and one recorded original-bootstrap-only upgrade, plus audit/release note and operator fallback. |
| G10 | Some verifiers allow absent/zero expiry or treat exp equality as valid. K1 requires bounded expiry and rejection at now >= exp. |
| G12 | Public feature discovery, account-wide measurement export, ownerless legacy today-liters read and writer-only valve list have different admission paths; shared route groups cannot describe them as one bearer/scope gate. |

Scope-cache invalidation alone does not implement #520. Even the fresh-role routes can accept the same signed token after re-enable or reset. Every bearer boundary needs the durable session check, including flag-off and independent module copies. Reads are consumers too.

## HTTP route index

The check-group names below reference `check_groups` in the JSON. For a hexadecimal node id, this table uses the node name; the JSON retains its exact id. `auth_nodes` follows route-specific guard outputs and records downstream checks; it is a static reachability index, not proof that every branch executes. Separate `flow_state_consumers` records include SQL/query/fanout consumers after authentication.

| Method and route | HTTP node | Entry node | Current-check group |
| --- | --- | --- | --- |
| `POST /auth/register` | `auth-register-http` | `auth-register-func` | `bootstrap` |
| `POST /auth/login` | `auth-login-http` | `auth-login-func` | `login` |
| `OPTIONS /auth/*` | `auth-options-http` | `auth-options-response` | `preflight` |
| `GET /download/database` | Database Download Endpoint (id in JSON) | `database-download-admin-read-guard` | `database_disabled` |
| `GET /api/devices` | `get-devices-http` | `get-devices-auth` | `lists` |
| `GET /api/catalog` | `get-catalog-http` | `catalog-authenticated-read-guard` | `catalog` |
| `POST /api/devices` | `post-devices-http` | `scoped-device-claim-router` | `claim` |
| `DELETE /api/devices/:deveui` | `delete-device-http` | `scoped-device-delete-router` | `lifecycle` |
| `OPTIONS /api/*` | `device-options-http` | `device-options-response` | `preflight` |
| `POST /api/irrigation-zones` | `post-zone-http` | `scoped-zone-create-router` | `zone_create` |
| `GET /api/irrigation-zones` | `get-zones-http` | `get-zones-auth` | `lists` |
| `DELETE /api/irrigation-zones/:id` | `delete-zone-http` | `scoped-zone-delete-router` | `lifecycle` |
| `PUT /api/irrigation-zones/:id/devices/:deveui` | `assign-device-http` | `scoped-device-assign-router` | `lifecycle` |
| `DELETE /api/irrigation-zones/:id/devices/:deveui` | `unassign-device-http` | `scoped-device-unassign-router` | `lifecycle` |
| `PUT /api/irrigation-zones/:id/schedule` | PUT /api/irrigation-zones/:id/schedule (id in JSON) | Decode Token (id in JSON) | `schedule` |
| `POST /api/irrigation-zones/schedules/disable-all` | `settings-disable-schedules-http` | `settings-disable-schedules-fn` | `disable_schedules` |
| `POST /api/valve/:deveui` | POST /api/valve/:deveui (id in JSON) | Auth + Validate + Normalize (id in JSON) | `manual_valve` |
| `GET /download-fieldtest` | `httpin_download_fieldtest` | `fieldtest-download-admin-read-guard` | `admin_guard` |
| `GET /download-sensordata` | `httpin_download_sensordata` | `fn_build_sensor_sql_params` | `sensor_download` |
| `GET /api/devices/:deveui/dendro-history` | `dendro-history-http` | `dendro-history-fn` | `device_read` |
| `PUT /api/devices/:deveui/dendro` | `put-dendro-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/temp` | `put-temp-http` | `scoped-device-config-guard` | `device_config` |
| `GET /api/devices/:deveui/sensor-history` | `sensor-history-http` | `sensor-history-fn` | `device_read` |
| `GET /api/devices/:deveui/rain-history` | `rain-history-http` | `rain-history-fn` | `device_read` |
| `GET /api/system/stats` | `sys-stats-in` | `system-stats-admin-read-guard` | `admin_guard` |
| `POST /api/system/reboot` | `sys-reboot-in` | `sys-reboot-fn` | `system` |
| `POST /api/system/fan` | `sys-fan-in` | `sys-fan-fn` | `system` |
| `OPTIONS /api/system/*` | `sys-cors-in` | `sys-cors-fn` | `preflight` |
| `GET /api/account-link/status` | `al-status-in` | `al-status-decode` | `account_status` |
| `POST /api/account-link` | `al-link-in` | `account-link-admin-write-guard` | `admin_guard` |
| `DELETE /api/account-link` | `al-unlink-in` | `account-unlink-admin-write-guard` | `admin_guard` |
| `OPTIONS /api/account-link` | `al-options-in` | `al-options-func` | `preflight` |
| `GET /api/dendrometer/:deveui/daily` | `dendro-daily-http` | `dendro-daily-fn` | `device_read` |
| `GET /api/irrigation-zones/:zone_id/recommendations` | `dendro-zone-rec-http` | `dendro-zone-rec-fn` | `device_read` |
| `GET /api/dendrometer/:deveui/readings` | `dendro-raw-http` | `dendro-raw-fn` | `device_read` |
| `PUT /api/devices/:deveui/reference-tree` | `dendro-ref-tree-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/irrigation-zones/:zone_id/timezone` | `dendro-tz-http` | `scoped-zone-config-guard` | `zone_config` |
| `OPTIONS /api/dendrometer/*` | `dendro-cors-http` | `dendro-cors-fn` | `preflight` |
| `OPTIONS /api/irrigation-zones/:zone_id/recommendations` | `dendro-zone-cors-http` | `dendro-cors-fn` | `preflight` |
| `OPTIONS /api/devices/:deveui/reference-tree` | `dendro-zone-ref-cors-http` | `dendro-cors-fn` | `preflight` |
| `PUT /api/irrigation-zones/:zone_id/location` | `dendro-location-http` | `scoped-zone-config-guard` | `zone_config` |
| `OPTIONS /api/irrigation-zones/:zone_id/location` | `dendro-location-cors-http` | `dendro-cors-fn` | `preflight` |
| `PUT /api/irrigation-zones/:zone_id/config` | `zone-config-http` | `scoped-zone-config-guard` | `zone_config` |
| `OPTIONS /api/irrigation-zones/:zone_id/config` | `zone-config-cors-http` | `dendro-cors-fn` | `preflight` |
| `GET /api/sync/state` | `sync-state-http` | `sync-state-admin-read-guard` | `admin_guard` |
| `POST /api/sync/force` | `sync-force-http` | `sync-force-admin-write-guard` | `admin_guard` |
| `PUT /api/devices/:deveui/lsn50/mode` | `put-lsn50-mode-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/lsn50/interval` | `put-lsn50-interval-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/kiwi/interval` | `put-kiwi-interval-http` | `scoped-device-config-guard` | `device_config` |
| `POST /api/devices/:deveui/kiwi/temperature-humidity/enable` | `post-kiwi-enable-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/strega/interval` | `put-strega-interval-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/lsn50/interrupt-mode` | `put-lsn50-interrupt-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/lsn50/5v-warmup` | `put-lsn50-5v-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/strega/model` | `put-strega-model-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/strega/timed-action` | `put-strega-timed-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/strega/magnet` | `put-strega-magnet-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/strega/partial-opening` | `put-strega-partial-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/strega/flushing` | `put-strega-flush-http` | `scoped-device-config-guard` | `device_config` |
| `GET /api/gateway/location` | `get-gateway-location-http` | `get-gateway-location-auth-fn` | `gateway_location_read` |
| `GET /api/gateways/:gatewayEui/location` | `get-gateway-location-by-id-http` | `get-gateway-location-auth-fn` | `gateway_location_read` |
| `GET /api/irrigation-zones/:zone_id/environment-summary` | `zone-env-http` | `zone-env-fn` | `device_read` |
| `OPTIONS /api/irrigation-zones/:zone_id/environment-summary` | `zone-env-cors-http` | `dendro-cors-fn` | `preflight` |
| `PUT /api/devices/:deveui/rain-gauge` | `put-rain-gauge-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/flow-meter` | `put-flow-meter-http` | `scoped-device-config-guard` | `device_config` |
| `GET /api/devices/:deveui/zone-assignments` | `s2120-zones-get-http` | `s2120-zones-get-fn` | `device_read` |
| `PUT /api/devices/:deveui/zone-assignments` | `s2120-zones-put-http` | `scoped-weather-zone-assign-router` | `weather_assignment` |
| `PUT /api/devices/:deveui/soil-moisture-depths` | `put-soil-depth-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/chameleon` | `put-chameleon-enabled-http` | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/dendro-config` | `put-dendro-config-http` | `scoped-device-config-guard` | `device_config` |
| `POST /api/devices/:deveui/dendro-baseline/reset` | `post-dendro-baseline-reset-http` | `scoped-device-config-guard` | `device_config` |
| `POST /api/v1/valves/:deveui/cancel` | `cancel-valve-http-in` | `cancel-strega-actuation-fn` | `cancel` |
| `POST /api/valve/:deveui/cancel` | `cancel-valve-local-http-in` | `cancel-strega-actuation-fn` | `cancel` |
| `GET /api/v1/devices/:deveui/today-liters` | `strega-today-liters-http-in` | `strega-today-liters-fn` | `today_liters` |
| `POST /api/devices/:deveui/chameleon/refresh-calibration` | POST /api/devices/:deveui/chameleon/refresh-calibration (id in JSON) | `scoped-device-config-guard` | `device_config` |
| `PUT /api/devices/:deveui/chameleon/depth` | PUT /api/devices/:deveui/chameleon/depth (id in JSON) | `scoped-device-config-guard` | `device_config` |
| `GET /api/devices/:deveui/watermark/calibration` | `watermark-cal-get-http` | `watermark-cal-fn` | `watermark_read` |
| `PUT /api/devices/:deveui/watermark/calibration` | `watermark-cal-put-http` | `scoped-device-config-guard` | `device_config` |
| `DELETE /api/devices/:deveui/watermark/calibration` | `watermark-cal-delete-http` | `scoped-device-config-guard` | `device_config` |
| `GET /api/irrigation/recent-actuations` | `get-actuations-http` | `get-actuations-auth` | `lists` |
| `POST /api/irrigation-zones/:id/calibration` | `zone-calibration-http` | `scoped-zone-config-guard` | `zone_config` |
| `GET /api/irrigation-zones/:zone_id/rain-source` | `zone-rain-source-get-http` | `zone-rain-source-fn` | `device_read` |
| `PUT /api/irrigation-zones/:zone_id/rain-source` | `zone-rain-source-put-http` | `scoped-zone-config-guard` | `zone_config` |
| `GET /api/history/zones/:zoneId/cards` | `history-zone-cards-http` | `history-api-router-fn` | `history` |
| `GET /api/history/zones/:zoneId/cards/:cardId/data` | `history-zone-card-data-http` | `history-api-router-fn` | `history` |
| `GET /api/history/zones/:zoneId/cards/:cardId/advanced` | `history-zone-card-advanced-http` | `history-api-router-fn` | `history` |
| `GET /api/history/gateways/:gatewayEui/cards` | `history-gateway-cards-http` | `history-api-router-fn` | `history` |
| `GET /api/history/gateways/:gatewayEui/cards/:cardId/data` | `history-gateway-card-data-http` | `history-api-router-fn` | `history` |
| `GET /api/history/gateways/:gatewayEui/cards/:cardId/advanced` | `history-gateway-card-advanced-http` | `history-api-router-fn` | `history` |
| `GET /api/history/workspaces` | `history-workspaces-get-http` | `history-api-router-fn` | `history` |
| `POST /api/history/workspaces` | `history-workspaces-post-http` | `history-api-router-fn` | `history` |
| `PUT /api/history/workspaces/:id` | `history-workspaces-put-http` | `history-api-router-fn` | `history` |
| `DELETE /api/history/workspaces/:id` | `history-workspaces-delete-http` | `history-api-router-fn` | `history` |
| `PUT /api/history/zones/:zoneId/cards/:cardId/preferences` | `history-zone-card-preferences-http` | `history-api-router-fn` | `history` |
| `POST /api/history/zones/:zoneId/cards/:cardId/opened` | `history-zone-card-opened-http` | `history-api-router-fn` | `history` |
| `PUT /api/history/gateways/:gatewayEui/cards/:cardId/preferences` | `history-gateway-card-preferences-http` | `history-api-router-fn` | `history` |
| `POST /api/history/gateways/:gatewayEui/cards/:cardId/opened` | `history-gateway-card-opened-http` | `history-api-router-fn` | `history` |
| `GET /api/system/features` | `history-system-features-http` | `history-api-router-fn` | `public_features` |
| `POST /api/history/rollups/run` | `history-rollups-run-http` | `history-rollups-admin-write-guard` | `admin_guard` |
| `GET /api/history/zones/:zoneId/export.csv` | `history-zone-export-csv-http` | `history-api-router-fn` | `history` |
| `GET /api/history/export.csv` | `history-all-zones-export-csv-http` | `portable-history-api-fn` | `portable_history` |
| `DELETE /api/analysis/views/:id` | `analysis-views-delete-http` | `portable-history-api-fn` | `portable_history` |
| `GET /api/analysis/channels` | `analysis-channels-http` | `analysis-api-router-fn` | `analysis` |
| `POST /api/analysis/series` | `analysis-series-http` | `analysis-api-router-fn` | `analysis` |
| `GET /api/analysis/views` | `analysis-views-get-http` | `analysis-api-router-fn` | `analysis` |
| `POST /api/analysis/views` | `analysis-views-post-http` | `analysis-api-router-fn` | `analysis` |
| `GET /api/improvement-requests` | `improvement-requests-get-http` | `improvement-requests-api-router` | `improvements` |
| `GET /api/improvement-requests/diagnostics-preview` | `improvement-requests-preview-http` | `improvement-requests-api-router` | `improvements` |
| `POST /api/improvement-requests` | `improvement-requests-post-http` | `improvement-requests-api-router` | `improvements` |
| `GET /api/journal/catalog` | `journal-catalog-get-http` | `journal-api-router-fn` | `journal` |
| `GET /api/journal/entries` | `journal-entries-get-http` | `journal-api-router-fn` | `journal` |
| `POST /api/journal/entries` | `journal-entries-post-http` | `journal-api-router-fn` | `journal` |
| `PUT /api/journal/entries/:uuid` | `journal-entry-put-http` | `journal-api-router-fn` | `journal` |
| `POST /api/journal/entries/:uuid/void` | `journal-entry-void-post-http` | `journal-api-router-fn` | `journal` |
| `POST /api/journal/custom-vocab` | `journal-custom-vocab-post-http` | `journal-api-router-fn` | `journal` |
| `PUT /api/journal/custom-vocab/:uuid` | `journal-custom-vocab-put-http` | `journal-api-router-fn` | `journal` |
| `GET /api/journal/plots` | `journal-plots-get-http` | `journal-api-router-fn` | `journal` |
| `POST /api/journal/plots` | `journal-plots-post-http` | `journal-api-router-fn` | `journal` |
| `PUT /api/journal/plots/:uuid` | `journal-plot-put-http` | `journal-api-router-fn` | `journal` |
| `GET /api/journal/plot-groups` | `journal-plot-groups-get-http` | `journal-api-router-fn` | `journal` |
| `POST /api/journal/plot-groups` | `journal-plot-groups-post-http` | `journal-api-router-fn` | `journal` |
| `PUT /api/journal/plot-groups/:uuid` | `journal-plot-group-put-http` | `journal-api-router-fn` | `journal` |
| `GET /api/journal/export.csv` | `journal-export-csv-get-http` | `journal-api-router-fn` | `journal` |
| `GET /api/journal/export.package` | `journal-export-package-get-http` | `journal-api-router-fn` | `journal` |
| `GET /api/journal/export.json` | `journal-export-json-get-http` | `journal-api-router-fn` | `journal` |
| `GET /api/journal/export.adapt.json` | `journal-export-adapt-get-http` | `journal-api-router-fn` | `journal` |
| `POST /api/devices/:deveui/sdi12/recipe/rollback` | `sdi12-recipe-rollback-http` | `sdi12-config-auth-fn` | `sdi12_recipe` |
| `POST /api/devices/:deveui/sdi12/recipe/apply` | `sdi12-recipe-apply-http` | `sdi12-config-auth-fn` | `sdi12_recipe` |
| `PUT /api/devices/:deveui/sdi12/config` | `sdi12-config-http` | `scoped-device-config-guard` | `device_config` |
| `GET /api/sdi12/probe-profiles` | `sdi12-profiles-http` | `sdi12-profiles-scope-fn` | `sdi12_profiles` |
| `POST /api/devices/:deveui/sdi12/identify` | `sdi12-identify-http` | `scoped-device-config-guard` | `device_config` |
| `GET /api/valves` | `valve-list-get-http` | `valve-api-router-fn` | `valve_list` |
| `GET /api/valves/:deveui/schedules` | `valve-schedules-get-http` | `valve-api-router-fn` | `valve_api` |
| `POST /api/valves/:deveui/schedules` | `valve-schedules-post-http` | `valve-api-router-fn` | `valve_api` |
| `PUT /api/valves/:deveui/schedules/:uuid` | `valve-schedule-put-http` | `valve-api-router-fn` | `valve_api` |
| `DELETE /api/valves/:deveui/schedules/:uuid` | `valve-schedule-delete-http` | `valve-api-router-fn` | `valve_api` |
| `POST /api/valves/:deveui/plan/resend` | `valve-plan-resend-post-http` | `valve-api-router-fn` | `valve_api` |
| `POST /api/valves/:deveui/scheduler-status` | `valve-scheduler-status-post-http` | `valve-api-router-fn` | `valve_api` |
| `PUT /api/valves/:deveui/settings` | `valve-settings-put-http` | `valve-api-router-fn` | `valve_api` |
| `GET /api/system/settings` | `sys-settings-get-in` | `sys-settings-router-fn` | `settings` |
| `PUT /api/system/settings` | `sys-settings-put-in` | `sys-settings-router-fn` | `settings` |
| `GET /api/me` | `api-me-http` | `api-me-auth` | `me` |
| `GET /api/users` | `admin-users-list-http` | `scoped-admin-account-router` | `accounts` |
| `POST /api/users` | `admin-users-create-http` | `scoped-admin-account-router` | `accounts` |
| `POST /api/users/:uuid/password-reset` | `admin-users-password-http` | `scoped-admin-account-router` | `accounts` |
| `PUT /api/users/:uuid/role` | `admin-users-role-http` | `scoped-admin-account-router` | `accounts` |
| `PUT /api/users/:uuid/disabled` | `admin-users-disabled-http` | `scoped-admin-account-router` | `accounts` |
| `POST /api/grants/zone` | `admin-zone-grant-http` | `scoped-admin-account-router` | `accounts` |
| `DELETE /api/grants/zone/:assignmentUuid` | `admin-zone-grant-delete-http` | `scoped-admin-account-router` | `accounts` |
| `POST /api/grants/plot` | `admin-plot-grant-http` | `scoped-admin-account-router` | `accounts` |
| `DELETE /api/grants/plot/:assignmentUuid` | `admin-plot-grant-delete-http` | `scoped-admin-account-router` | `accounts` |
| `GET /api/network/observations` | `network-api-http-0` | `network-api-handler` | `network` |
| `GET /api/devices/:deveui/installation-location` | `network-api-http-1` | `network-api-handler` | `network` |
| `PUT /api/devices/:deveui/installation-location` | `network-api-http-2` | `network-api-handler` | `network` |
| `GET /api/devices/:deveui/installation-location/revisions` | `network-api-http-3` | `network-api-handler` | `network` |
| `GET /api/devices/:deveui/radio-configuration` | `network-api-http-4` | `network-api-handler` | `network` |
| `PUT /api/devices/:deveui/radio-configuration` | `network-api-http-5` | `network-api-handler` | `network` |
| `GET /api/devices/:deveui/radio-configuration/revisions` | `network-api-http-6` | `network-api-handler` | `network` |
| `PUT /api/gateway/location` | `network-api-http-7` | `network-api-handler` | `network` |
| `PUT /api/irrigation-zones/:id/name` | `zone-rename-http` | `zone-rename-scope-guard` | `rename` |
| `PUT /api/devices/:deveui/name` | `device-rename-http` | `device-rename-scope-guard` | `rename` |
| `POST /api/sync/outbox/recover` | `sync-outbox-recover-http` | `sync-outbox-recover-admin-guard` | `admin_guard` |
| `GET /api/irrigation-zones/:id/irrigation-policy` | `conditional-policy-get-http` | `conditional-policy-route-fn` | `conditional` |
| `PUT /api/irrigation-zones/:id/irrigation-policy` | `conditional-policy-put-http` | `conditional-policy-route-fn` | `conditional` |
| `POST /api/irrigation-zones/:id/irrigation-policy/pause` | `conditional-policy-pause-http` | `conditional-policy-route-fn` | `conditional` |
| `POST /api/irrigation-zones/:id/irrigation-policy/retry-valve` | `conditional-policy-retry-http` | `conditional-policy-route-fn` | `conditional` |
| `GET /api/irrigation-zones/:id/irrigation-policy/decisions` | `conditional-policy-decisions-http` | `conditional-policy-route-fn` | `conditional` |

The direct `/api/devices/:deveui/sdi12/recipe/apply` and `/rollback` POSTs skip bearer, role and owner checks with scoped mode on. They bypass `scoped-device-config-guard`; flag-off verifies inline HMAC and filters by device owner. Their action nodes call `applyDesiredRecipe` / `rollbackCompatibleRecipe` with no principal. EB5b needs a writer/device/session fence through final commissioning dispatch on both actions, not only a replacement of the skipped verifier. `/api/gateway/location` and `/api/gateways/:gatewayEui/location` GET use bearer plus owner-EXISTS SQL without an enabled-account check. The network PUT uses a different module and admin rule.

For #451, the shared device-config guard has 27 selected outputs. Inspect its selected downstream handler: STREGA and Chameleon owner queries can still refuse an authorized grantee. The separate valve API calls `freshValveScope` and then `ownedValve`, which preserves the same owner barrier. The JSON marks the affected routes with G5.

## Module consumers

Each JSON record names its exact function, current checks and required revocation reach. Data adapters that accept trusted `userId`, `scoped` or actor context are included because they rely on upstream session validation. Their options must not become client-controlled authority.

| File relative to payload root | Function or callback | Current check / revocation gap |
| --- | --- | --- |
| `osi-scope-helper/index.js` | `verifyBearer` | HMAC signature, id/username, optional exp; returns identity only, no DB/session check. Gaps: G1, G10. |
| `osi-scope-helper/index.js` | `resolveScope` | 30-second Map keyed by user_uuid; role, disabled, owned/granted zones/plots; flag-off wildcard admin. Gaps: G1, G2, G3. |
| `osi-scope-helper/index.js` | `invalidateScope` | Deletes cache and marks pending-load tickets invalid; called by account/grant mutation paths. Gaps: G1, G3. |
| `osi-scope-helper/index.js` | `assertFreshDeviceAccess` | Fresh user/disabled and current device-zone scope; weather exception; optional unassigned soil owner/admin. Role mutation is a separate canMutate check. Flag-off wildcard. Gaps: G1, G2, G4. |
| `osi-scope-helper/index.js` | `assertFreshZoneAccess` | Fresh enabled user and owned+granted zone set. Does not by itself require writer role; flag-off wildcard. Gaps: G1, G2, G4. |
| `osi-scope-helper/index.js` | `assertFreshPlotAccess` | Fresh enabled user and owned+granted plot set; independent writer role check required. Gaps: G1, G2, G4. |
| `osi-scope-helper/index.js` | `assertAuthenticatedRole` | Fresh id+username, disabled and exact role when scopedMode:true; no revocation generation. authorizeAdminRead delegates here. Gaps: G1, G2, G4. |
| `osi-scope-helper/index.js` | `assertRole` | Uses cached resolveScope then disabled/exact role; flag-off wildcard. Gaps: G1, G2, G3. |
| `osi-scope-helper/index.js` | `assertEnabledAccount` | Uses cached resolveScope; checks disabled but cannot distinguish old sessions after re-enable. Gaps: G1, G2, G3. |
| `osi-scope-helper/index.js` | `assertFreshRole` | Reads uncached current membership/disabled and exact role; flag-off wildcard unless scopedMode:true. Gaps: G1, G2, G4. |
| `osi-scope-helper/index.js` | `authorizeAdminRead` | Verifies bearer then current enabled admin with scopedMode:true; opens/closes DB for boundary. Gaps: G1, G4, G10. |
| `osi-local-password-reset/index.js` | `resetLocalPassword` | Local-only target; bcrypt; transaction rechecks admin and target auth_mode; guarded password update. No session revocation. Linked account returns 409. Gaps: G1, G8. |
| `osi-installation-helper/index.js` | `verifierSubject` | Offline verifier subject password::gateway EUI (v1) or password::installation UUID (v2); helper does not authorize a session. Gaps: G1, G8. |
| `osi-history-router/index.js` | `handlePortableHistoryRequest` | Scoped shared bearer or flag-off portableVerifyBearer; scoped enabled check/cache, flag-off existence by id; private saved views and CSV. Gaps: G1, G2, G3, G4, G10. |
| `osi-history-router/index.js` | `portableVerifyBearer` | Independent HMAC verifier for flag-off portable routes, optional expiry. Gaps: G1, G2, G10. |
| `osi-system-settings/api.js` | `verifyBearer` | Independent strict shape/HMAC/positive expiry verifier; no DB session identity. Gaps: G1, G10. |
| `osi-system-settings/api.js` | `handleHttpRequest` | GET signature only; PUT fresh admin only in scoped mode; setting writes otherwise allowed by bearer. Gaps: G1, G2, G4. |
| `osi-valve-control/api.js` | `verifyBearer` | Independent strict shape/HMAC/positive expiry verifier. Gaps: G1, G10. |
| `osi-valve-control/api.js` | `authorizedValve` | freshValveScope when flag on, then ownedValve for all modes. Several write transactions repeat this helper. Gaps: G1, G2, G4, G5. |
| `osi-valve-control/live-authorize.js` | `liveWriteExpectation` | Scoped physical dispatch requires actor UUID and fresh device/writer authorization; internal scheduler path separate. No local session generation carried. Gaps: G1, G4, G7. |
| `osi-valve-control/claim.js` | `assertAuthorizationTx` | Reads user id/UUID and disabled inside claim transaction when supplied; no session generation. Gaps: G1, G4. |
| `osi-valve-control/live-transport.js` | `liveCloudCommand` | Loads module cloud command handler and transport; queues plans/cancel/settings. Gaps: G4, G7. |
| `osi-valve-control/cloud-commands.js` | `applyCloudCommand` | Schedule/settings/plan/cancel dispatches by type; helper itself has no current actor authorization. Gaps: G4, G7. |
| `osi-valve-control/dispatch.js` | `reserveValveCommandTx` | Reservation/claim/effect safety is separate from actor authorization. Gaps: G1, G4. |
| `osi-journal/api.js` | `verifyBearer` | Independent strict HMAC/expiry verifier used by retained journal HTTP routes. Gaps: G1, G10. |
| `osi-journal/api.js` | `resolvePrincipal` | Fresh id+username to user_uuid; principal lookup alone omits disabled/role. Gaps: G1, G2, G4. |
| `osi-journal/api.js` | `resolvedReadScope` | Scoped resolveScope with cached account state and disabled rejection; flag-off owner UUID reads. Gaps: G1, G2, G3. |
| `osi-journal/api.js` | `freshJournalScope` | Fresh role plus plot/zone access on mutations; principal scoped flag chooses path. Gaps: G1, G2, G4. |
| `osi-network-api/index.js` | `handleRequest` | Shared scope bearer; actor fresh disabled check; device scope/writer or gateway-location admin. No installer identity. Gaps: G1, G2, G4, G6, G10. |
| `osi-sdi12-commissioning/identify-handler.js` | `verifyBearer` | Independent inline-style verifier inside live handler; flag-off owns device, scoped path trusts upstream marker. Gaps: G1, G2, G4, G10. |
| `osi-irrigation-policy/routes.js` | `scopedZoneDelete` | Bearer/current enabled role, zone scope or legacy owner, holder guard; lifecycle authorizeAfterWriters recheck. Gaps: G1, G4. |
| `osi-irrigation-policy/routes.js` | `scopedDeviceAssign` | Bearer/current role, target zone/device scope, lifecycle writer recheck. Gaps: G1, G4. |
| `osi-irrigation-policy/routes.js` | `scopedDeviceUnassign` | Bearer/current role/device-zone scope, lifecycle writer recheck. Gaps: G1, G4. |
| `osi-irrigation-policy/routes.js` | `scopedDeviceDelete` | Bearer/current role/device-zone scope, lifecycle writer recheck. Gaps: G1, G4. |
| `osi-irrigation-policy/api.js` | `assertZoneAccessTx` | Scoped path reloads current zone scope/disabled/role through helper; legacy path trusts supplied actor.role and user_id or resolves id by UUID; actor absent returns without check. Gaps: G1, G2, G4. |
| `osi-scoped-access-commands/index.js` | `applyScopedAccessCommand` | Protected delivery/effect/base/version checks; applyUser/resetPassword preserve last admin; invalidates all scope after applied command. No current initiating admin check here. Gaps: G1, G4, G7, G8. |
| `osi-watermark-helper/commands.js` | `authorizeDevice` | Transaction reads current actor, disabled and role; zone owner/grant or unassigned owner/admin; legacy owner path. Gaps: G1, G4. |
| `osi-entity-name/commands.js` | `authorize` | Fresh actor/disabled, role and device/zone scope in transaction; legacy owner check. Gaps: G1, G4. |
| `osi-installation-location-helper/commands.js` | `applyCommand` | Transaction checks actor disabled, fresh device access and writer; no installer entitlement. Gaps: G1, G4, G6. |
| `osi-history-helper/index.js` | `optionalUserFilter` | Trusts caller userId/scoped context to choose owner SQL or account-wide sensor/history reads. No token check. Gaps: G1, G4. |
| `osi-history-helper/index.js` | `resolveZoneExportScope` | Trusts caller userId/zone scope for CSV selection. No token or current-session check. Gaps: G1, G4. |
| `osi-history-helper/analysis.js` | `buildAnalysisCatalog` | Caller-supplied userId, zoneUuids and unassignedAccess determine catalog visibility; same module owns resolveAnalysisSeries and list/save/deleteAnalysisView. Gaps: G1, G4. |
| `osi-history-helper/analysis-sources.js` | `loadZoneStations` | Uses caller userId/legacyMode for station selection, not a token verifier. Gaps: G1, G4. |
| `osi-watermark-helper/calibration.js` | `assertAccessibleLsn50` | Scoped=true trusts adapter authorization and selects by device; legacy path filters by supplied userId. Gaps: G1, G4. |
| `osi-sdi12-commissioning/tensiomark.js` | `saveTensiomarkDepths` | Caller-derived userId/scoped input selects owner-filtered or trusted scoped Tensiomark configuration. Gaps: G1, G4. |
| `osi-rain/index.js` | `setZoneRainSource` | Checks zone exists and selected gauge is a candidate; records supplied actorUuid. No independent actor/session authorization. Gaps: G1, G4. |
| `osi-installation-location-helper/index.js` | `saveRadioConfiguration` | Persists revision with actorUserUuid supplied by caller; no bearer or installer entitlement. Gaps: G1, G4, G6. |
| `osi-valve-control/store.js` | `listSchedules` | Data access after API authorization; no bearer/session check. Gaps: G1, G4. |
| `osi-irrigation-policy/lifecycle.js` | `authorizeAfterWriters` | Calls supplied authorization callback after writer acquisition; no independent session generation check. Gaps: G1, G4, G7. |
| `osi-command-ledger/index.js` | `withProtectedCommandTransaction` | Delivery, effect binding, payload identity and replay are verified; actor authorization belongs to mutation callback. Gaps: G4, G7. |
| `osi-zone-commands/index.js` | `applyOnce` | Versioned zone command validates owner binding and desired state; no local bearer. Gaps: G4, G7. |
| `osi-journal/commands.js` | `applyJournalCommand` | Retained cloud journal applier relies on command binding and current scoped rules; no browser session verifier. Gaps: G4, G7. |
| `osi-journal/api.js` | `handleHttpRequest` | Own bearer verifier -> resolvePrincipal -> scoped read/write dispatch; flag-off remains independent. Gaps: G1, G4. |
| `osi-valve-control/api.js` | `freshValveScope` | Uncached current enabled writer; targeted calls check device scope, EUI-less list checks role only. Gaps: G1, G4. |
| `osi-valve-control/api.js` | `handleHttpRequest` | Own bearer verifier, operational list versus targeted ownedValve; write transactions repeat authorization. Gaps: G1, G4. |
| `osi-network-api/index.js` | `actor` | Fresh id+username/disabled in both modes; flag-off substitutes admin. Gaps: G1, G4. |
| `osi-network-api/index.js` | `authorize` | Fresh actor/current installation/device binding; device scope, writer on PUT. No installer entitlement. Gaps: G1, G4. |
| `osi-sdi12-commissioning/identify-handler.js` | `handleIdentifyAction` | Flag-off own bearer and owner lookup; scoped trusts upstream guard context. Gaps: G1, G4. |
| `osi-sdi12-commissioning/index.js` | `applyDesiredRecipe` | Claims deployment and enqueues recipe for target; no user/session input. Gaps: G1, G4. |
| `osi-sdi12-commissioning/index.js` | `rollbackCompatibleRecipe` | Claims rollback deployment and enqueues snapshot for target; no user/session input. Gaps: G1, G4. |

Module re-exports are not extra verifiers: `osi-journal/index.js` exports `api.verifyBearer`/HTTP handling; `osi-history-helper/index.js` exports analysis functions; `osi-valve-control/index.js` composes its API/live wrappers. EB5b must update the implementations and exercise the shipped wrappers.

Pure normalization, row serialization and telemetry modules do not accept a local session. In particular, `osi-watermark-binding/canonicalization.js` hashes actor bindings but does not authenticate them; `osi-sync-protocol-state` peer-context state guards sync lineage, not browser sessions. They cannot be used as proof that a user is authorized.

## Issuance, cached state and long-lived work

| Consumer | Location | Today | How revocation reaches it |
| --- | --- | --- | --- |
| account-mutation-writers | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`; `scoped-admin-account-router`, `scoped-access-command-apply-fn` | Role/disable/grant changes invalidate scope; password reset does not invalidate issued tokens. | Atomic durable generation advancement with account change; all module verifiers and inline nodes compare it. |
| login-link-state | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`; `auth-process-result`, `auth-db-query`, `al-status-decode`, `al-status-format`, `al-link-validate`, `al-link-build-req`, `al-link-handle-auth`, `al-link-clear-state`, `al-link-finalize`, `al-unlink-func`, `al-unlink-db`, `cs-reg-cloud-fn` | Stored auth_mode/password_hash/server_offline_verifier/version/installation_uuid plus server token/password-hash legacy fallback; link flow stores al_* identity/credential fields. | Credential replacement must fence concurrent login issuance and invalidate affected sessions by canonical identity. Never use cloud sync token as a browser token. |
| request-context | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`; `auth-login-func`, `auth-register-func`, Decode Token (id in JSON), Auth + Validate + Normalize (id in JSON), `scoped-device-config-guard`, `scoped-zone-config-guard`, Route Command (id in JSON) | msg._authwork isolates credentials; msg.osi.request captures actorId and immutable request target; msg.authUserId/authUsername, actor_user_uuid, _actorUserUuid, _scopedZoneWriteAuthorized and owner markers survive downstream asynchronous work. | Trusted context must include immutable account and session generation; request payload/query may never inject it. Revalidate at apply. |
| cloud-router | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`; `sync-pending-split`, Route Command (id in JSON), `cs-reg-cloud-fn`, `scoped-access-command-apply-fn` | REST pending-command envelope and actor copied into dispatch; generic REBOOT/SET_FAN branches perform side effects without current actor-role check; registration lacks fresh actor-zone gate. | EB5a validates current actor before every branch; account mutations revoke local sessions when applied. Authenticated sync transport alone grants no user right. |
| browser-storage | `web/react-gui/src/services/authSession.ts`; `publish` | localStorage auth_token/username; in-memory sessionEpoch, AbortController and storage listeners isolate observed session changes. No server revocation notification. | 401 session rejection ends current epoch, clears credentials and private cache boundary; no stale response may populate a new session. |
| browser-interceptors | `web/react-gui/src/services/api.ts`; `interceptors` | Attaches captured bearer/session snapshot; rejects stale epoch requests/responses; current-session 401 ends session. | Server rejects revoked tokens at every consumer; interceptor performs local cleanup when observed. |
| browser-cache | `web/react-gui/src/contexts/AuthSessionDataBoundary.tsx`; `AuthSessionDataBoundary` | Session-bound cache/provider boundary; AuthContext also listens for storage changes and auth-expired event. | Reset on session epoch; server remains source of authorization. Include scope/role query caches and queued journal captures in EB5b tests. |
| long-lived-transports | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | No websocket, tcp or udp nodes. HTTP exports/requests may remain in flight. MQTT subscriptions, telemetry and cloud sync polling use service credentials, not local browser sessions. | Fence in-flight local work before effects/private response release. Do not rotate MQTT, ChirpStack or cloud-sync credentials as a substitute for local session revocation. |
| node-red-settings | `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`; `httpAdminRoot` | httpAdminRoot:false closes Node-RED editor/admin API; no shared HTTP-node session middleware supplies product authorization. | Each product consumer remains responsible; keep editor disabled. |

The local token is a two-part HMAC payload/signature, not a three-part cloud JWT. `auth-process-result.issueSignedToken` signs `userId`, username and millisecond `iat`/`exp` for seven days. There is no immutable UUID/generation binding in the token. Login checks `disabled_at` only with scoped mode on. Linked login verifies the stored offline verifier locally (v1 gateway subject, v2 installation subject), with a legacy server password-hash fallback.

`osi-scope-helper` has a process-wide 30-second `cache` and `pendingLoads` ticket sets. `invalidateScope` removes entries and marks pending reads; it does not invalidate any HMAC. `msg.authUserId`, `msg.authUsername`, `msg.actor_user_uuid`, `msg._actorUserUuid`, `msg._authUser` and scoped-owner authorization markers are request state that can outlive entry authentication. The flow-state array names each function using them.

Cloud sync bearer tokens in `users.server_sync_token`, `osiCloudHttp` polling/refresh, MQTT credentials and ChirpStack gRPC authorization are service credentials. Their connections can outlive a browser session. They must not be revoked globally as the #520 fix, and they must not authorize browser work. The cloud command appliers must still evaluate the initiating actor at apply time (EB5a).

HTTP exports can hold a request while querying and building a buffer. Recheck before releasing private output. Local commands can wait on valve writers or timers; recheck before dispatch. Existing browser epoch/AbortController handling prevents an observed ended session from filling the next session cache, but an idle client has no server revocation push channel. The next request must fail server-side regardless of whether that tab has noticed.

## EB5b completion record

Use the machine-readable route list to parameterize actual verifier/route tests. Cover local and linked credentials, each flag state, warm/cold caches and pending loads. Include all module copies, direct SDI-12 recipe paths, exports, account-admin mutations and queued effect boundaries. Test revoke, re-enable, restart and new login with two distinct sessions for the same account; a single-token happy path does not prove all-session revocation.

Rerun `node scripts/test-authority-contract.js` for inventory consistency against the pinned Git object. The inventory remains a dated baseline as implementation changes land; record new consumers and their implementation tests in the owning package. No runtime gate is green merely because this documentation check passes.

## Split admissions and delegated paths

`GET /api/system/features` returns public flags before authentication in either
mode. It remains public. `/download-sensordata` is account-wide measurement data
in both flags; only the scoped path currently checks enabled account state.
`today-liters` similarly lacks the legacy user/owner gate, but its required
flag-off scope is target ownership. `/api/valves` is an operational writer list,
not an account-wide viewer read; its list and targeted routes have distinct
current checks. These each have a separate `check_group`, `admission_today` and
required admission in the JSON.

The six additional admin verifier callers are
`account-link-admin-write-guard`, `account-unlink-admin-write-guard`,
`sync-force-admin-write-guard`, `history-rollups-admin-write-guard`,
`database-download-admin-read-guard` and `sync-state-admin-read-guard`.
They delegate to `scope.authorizeAdminRead`; replacing only lexical local
HMAC implementations misses them. `caller_edges` records real module calls;
`selected_outputs` records the route-specific guard branch. The validator
checks both profile copies against the pin and follows those outputs to sinks.

Borrowed-authority records include `al-unlink-db` consuming `_unlinkAuth`,
`sync-outbox-recover-fn` consuming `_recoveryActor`, both SDI-12 recipe action
nodes consuming `deviceRow`, and `sdi12-identify-action-fn` delegating to its
module verifier. The shared module entry/dispatch records name journal
`handleHttpRequest`, valve `freshValveScope` / `handleHttpRequest` and network
`actor` / `authorize`. A caller marker is never a durable session fence.

## Cloud admission deltas

`cloud_baseline_deltas` names the reviewed owner shortcut in zone writes,
caller-link legacy default, claimer physical-command fallback, direct edge-backed
device rename and prediction owner shortcut. Each records today's admission,
capability source and legacy fallback separately from the required path. These
are required CL2 changes, not evidence that the pinned cloud is already conformant.
The rename adapter retains PATCH `/api/v1/devices/{deviceEui}`, but an edge-backed
name requires `entity_name_commands_v1`, pending issuance and authoritative
ACK/mirror settlement. Unbound cloud-local labels remain a separate owner path.

## Decided defaults, 20 Nov 2026

The baseline rows above remain a dated code audit. The current authority defaults
are the CTO rulings R1–R8 in v1.md, including the lead-confirmed owner/admin-only
radio rule and actorless-command refusal. There is no installer role/entitlement
or legacy application path to add. R6/Q1 and R7/Q3 are product defaults Phil may
override explicitly; no product question remains open.

R2 adds exactly one recorded, audited promotion of the original enabled bootstrap
account when an existing installation has no enabled admin. This is separate
from fresh zero-user bootstrap, which stores admin in both flags. It never
selects a later surviving account. Missing/disabled original bootstrap uses
operator recovery, and the exact release-note line is in v1.md and the
admin-upgrade fixture. Runtime migration/receipt work remains with EB5b/EB6.

R8b uses the new authority_actor_v1 report for actor-bearing commands, with cloud
acceptance deployed first. FORCE_EDGE_SYNC and SYNC_LINKED_AUTH use a system actor
bound to the gateway's own non-human transport credential. Queued pauses retain
the original recorded local actor; actorless queued records are refused at upgrade,
never attributed to an owner. The protected ACK/mirror fence remains unchanged.
