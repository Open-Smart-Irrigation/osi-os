# Runtime comparison on main baseline 23bfda61e

Under Node 20.18.3, Node-RED 3.1.15 and 4.0.9 each executed all 211 cases:
200 passed, zero unexpected failures, and the same 11 known failures.
Every normalized failure signature matched. Image runtime took 27.5 seconds;
stock runtime took 28.2 seconds, excluding installation and seed construction.

The stock clean install honored every version in the shipped user lock:
node-red-node-sqlite 1.1.1, sqlite3 5.1.7, and one mapped native addon in
the user directory, with none in the firmware. The exact failure evidence
for each FAIL below is in [the stock list](known-failures.json); the image
list has identical finding IDs and signatures at this baseline.

| Case | Image 3.1.15 | Stock 4.0.9 | Finding |
| --- | --- | --- | --- |
| `runtime-started` | PASS | PASS |  |
| `login-and-lists` | PASS | PASS |  |
| `command-accepted:close` | PASS | PASS |  |
| `command-refused:close` | PASS | PASS |  |
| `command-accepted:close-duration` | PASS | PASS |  |
| `command-refused:close-duration` | PASS | PASS |  |
| `command-accepted:open-duration` | PASS | PASS |  |
| `command-refused:open-duration` | PASS | PASS |  |
| `command-accepted:interval` | PASS | PASS |  |
| `command-refused:interval` | PASS | PASS |  |
| `command-accepted:timed-close` | PASS | PASS |  |
| `command-refused:timed-close` | PASS | PASS |  |
| `command-accepted:magnet` | PASS | PASS |  |
| `command-refused:magnet` | PASS | PASS |  |
| `command-accepted:partial-close` | PASS | PASS |  |
| `command-refused:partial-close` | PASS | PASS |  |
| `command-accepted:flushing` | PASS | PASS |  |
| `command-refused:flushing` | PASS | PASS |  |
| `command-invalid:{"action":"OPEN"}` | PASS | PASS |  |
| `command-invalid:{"action":"OPEN_FOR_DURATION","duration_minutes":0}` | PASS | PASS |  |
| `command-invalid:{"action":"OPEN_FOR_DURATION","duration_minutes":256}` | PASS | PASS |  |
| `open-report-close-open` | PASS | PASS |  |
| `open-no-report-open-later` | FAIL | FAIL | F-1 |
| `no-clock-open-report-close-open` | FAIL | FAIL | F-2 |
| `no-clock-open-no-report-open-later` | FAIL | FAIL | F-1 |
| `no-clock-safety-close` | PASS | PASS |  |
| `open-after:close-duration` | FAIL | FAIL | F-4 |
| `open-after:timed-close` | FAIL | FAIL | F-4 |
| `open-after:flushing` | FAIL | FAIL | F-4 |
| `lifecycle:assign` | PASS | PASS |  |
| `lifecycle:remove` | PASS | PASS |  |
| `lifecycle:delete-device` | PASS | PASS |  |
| `lifecycle:delete-zone` | PASS | PASS |  |
| `weekly-save` | PASS | PASS |  |
| `weekly-change` | PASS | PASS |  |
| `weekly-delete` | PASS | PASS |  |
| `scheduler-irrigates` | FAIL | FAIL | F-7 |
| `no-token:POST /auth/register` | PASS | PASS |  |
| `no-token:POST /auth/login` | PASS | PASS |  |
| `no-token:OPTIONS /auth/*` | PASS | PASS |  |
| `no-token:GET /download/database` | PASS | PASS |  |
| `no-token:GET /api/devices` | PASS | PASS |  |
| `no-token:GET /api/catalog` | PASS | PASS |  |
| `no-token:POST /api/devices` | PASS | PASS |  |
| `no-token:DELETE /api/devices/:deveui` | PASS | PASS |  |
| `no-token:OPTIONS /api/*` | PASS | PASS |  |
| `no-token:POST /api/irrigation-zones` | PASS | PASS |  |
| `no-token:GET /api/irrigation-zones` | PASS | PASS |  |
| `no-token:DELETE /api/irrigation-zones/:id` | PASS | PASS |  |
| `no-token:PUT /api/irrigation-zones/:id/devices/:deveui` | PASS | PASS |  |
| `no-token:DELETE /api/irrigation-zones/:id/devices/:deveui` | PASS | PASS |  |
| `no-token:PUT /api/irrigation-zones/:id/schedule` | PASS | PASS |  |
| `no-token:POST /api/irrigation-zones/schedules/disable-all` | PASS | PASS |  |
| `no-token:POST /api/valve/:deveui` | PASS | PASS |  |
| `no-token:GET /download-sensordata` | PASS | PASS |  |
| `no-token:GET /api/devices/:deveui/dendro-history` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/dendro` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/temp` | PASS | PASS |  |
| `no-token:GET /api/devices/:deveui/sensor-history` | PASS | PASS |  |
| `no-token:GET /api/devices/:deveui/rain-history` | PASS | PASS |  |
| `no-token:GET /api/system/stats` | PASS | PASS |  |
| `no-token:POST /api/system/reboot` | PASS | PASS |  |
| `no-token:POST /api/system/fan` | PASS | PASS |  |
| `no-token:OPTIONS /api/system/*` | PASS | PASS |  |
| `no-token:GET /api/account-link/status` | PASS | PASS |  |
| `no-token:POST /api/account-link` | FAIL | FAIL | F-13 |
| `no-token:DELETE /api/account-link` | PASS | PASS |  |
| `no-token:OPTIONS /api/account-link` | PASS | PASS |  |
| `no-token:GET /api/dendrometer/:deveui/daily` | PASS | PASS |  |
| `no-token:GET /api/irrigation-zones/:zone_id/recommendations` | PASS | PASS |  |
| `no-token:GET /api/dendrometer/:deveui/readings` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/reference-tree` | PASS | PASS |  |
| `no-token:PUT /api/irrigation-zones/:zone_id/timezone` | PASS | PASS |  |
| `no-token:OPTIONS /api/dendrometer/*` | PASS | PASS |  |
| `no-token:OPTIONS /api/irrigation-zones/:zone_id/recommendations` | PASS | PASS |  |
| `no-token:OPTIONS /api/devices/:deveui/reference-tree` | PASS | PASS |  |
| `no-token:PUT /api/irrigation-zones/:zone_id/location` | PASS | PASS |  |
| `no-token:OPTIONS /api/irrigation-zones/:zone_id/location` | PASS | PASS |  |
| `no-token:PUT /api/irrigation-zones/:zone_id/config` | PASS | PASS |  |
| `no-token:OPTIONS /api/irrigation-zones/:zone_id/config` | PASS | PASS |  |
| `no-token:GET /api/sync/state` | PASS | PASS |  |
| `no-token:POST /api/sync/force` | FAIL | FAIL | F-13 |
| `no-token:PUT /api/devices/:deveui/lsn50/mode` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/lsn50/interval` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/kiwi/interval` | PASS | PASS |  |
| `no-token:POST /api/devices/:deveui/kiwi/temperature-humidity/enable` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/strega/interval` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/lsn50/interrupt-mode` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/lsn50/5v-warmup` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/strega/model` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/strega/timed-action` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/strega/magnet` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/strega/partial-opening` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/strega/flushing` | PASS | PASS |  |
| `no-token:GET /api/gateway/location` | PASS | PASS |  |
| `no-token:GET /api/gateways/:gatewayEui/location` | PASS | PASS |  |
| `no-token:GET /api/irrigation-zones/:zone_id/environment-summary` | PASS | PASS |  |
| `no-token:OPTIONS /api/irrigation-zones/:zone_id/environment-summary` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/rain-gauge` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/flow-meter` | PASS | PASS |  |
| `no-token:GET /api/devices/:deveui/zone-assignments` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/zone-assignments` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/soil-moisture-depths` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/chameleon` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/dendro-config` | PASS | PASS |  |
| `no-token:POST /api/devices/:deveui/dendro-baseline/reset` | PASS | PASS |  |
| `no-token:POST /api/v1/valves/:deveui/cancel` | PASS | PASS |  |
| `no-token:POST /api/valve/:deveui/cancel` | PASS | PASS |  |
| `no-token:GET /api/v1/devices/:deveui/today-liters` | PASS | PASS |  |
| `no-token:POST /api/devices/:deveui/chameleon/refresh-calibration` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/chameleon/depth` | PASS | PASS |  |
| `no-token:GET /api/devices/:deveui/watermark/calibration` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/watermark/calibration` | PASS | PASS |  |
| `no-token:DELETE /api/devices/:deveui/watermark/calibration` | PASS | PASS |  |
| `no-token:GET /api/irrigation/recent-actuations` | PASS | PASS |  |
| `no-token:POST /api/irrigation-zones/:id/calibration` | PASS | PASS |  |
| `no-token:GET /api/irrigation-zones/:zone_id/rain-source` | PASS | PASS |  |
| `no-token:PUT /api/irrigation-zones/:zone_id/rain-source` | PASS | PASS |  |
| `no-token:GET /api/history/zones/:zoneId/cards` | PASS | PASS |  |
| `no-token:GET /api/history/zones/:zoneId/cards/:cardId/data` | PASS | PASS |  |
| `no-token:GET /api/history/zones/:zoneId/cards/:cardId/advanced` | PASS | PASS |  |
| `no-token:GET /api/history/gateways/:gatewayEui/cards` | PASS | PASS |  |
| `no-token:GET /api/history/gateways/:gatewayEui/cards/:cardId/data` | PASS | PASS |  |
| `no-token:GET /api/history/gateways/:gatewayEui/cards/:cardId/advanced` | PASS | PASS |  |
| `no-token:GET /api/history/workspaces` | PASS | PASS |  |
| `no-token:POST /api/history/workspaces` | PASS | PASS |  |
| `no-token:PUT /api/history/workspaces/:id` | PASS | PASS |  |
| `no-token:DELETE /api/history/workspaces/:id` | PASS | PASS |  |
| `no-token:PUT /api/history/zones/:zoneId/cards/:cardId/preferences` | PASS | PASS |  |
| `no-token:POST /api/history/zones/:zoneId/cards/:cardId/opened` | PASS | PASS |  |
| `no-token:PUT /api/history/gateways/:gatewayEui/cards/:cardId/preferences` | PASS | PASS |  |
| `no-token:POST /api/history/gateways/:gatewayEui/cards/:cardId/opened` | PASS | PASS |  |
| `no-token:GET /api/system/features` | PASS | PASS |  |
| `no-token:POST /api/history/rollups/run` | PASS | PASS |  |
| `no-token:GET /api/history/zones/:zoneId/export.csv` | PASS | PASS |  |
| `no-token:GET /api/history/export.csv` | PASS | PASS |  |
| `no-token:DELETE /api/analysis/views/:id` | PASS | PASS |  |
| `no-token:GET /api/analysis/channels` | PASS | PASS |  |
| `no-token:POST /api/analysis/series` | PASS | PASS |  |
| `no-token:GET /api/analysis/views` | PASS | PASS |  |
| `no-token:POST /api/analysis/views` | PASS | PASS |  |
| `no-token:GET /api/improvement-requests` | PASS | PASS |  |
| `no-token:GET /api/improvement-requests/diagnostics-preview` | PASS | PASS |  |
| `no-token:POST /api/improvement-requests` | PASS | PASS |  |
| `no-token:GET /api/journal/catalog` | PASS | PASS |  |
| `no-token:GET /api/journal/entries` | PASS | PASS |  |
| `no-token:POST /api/journal/entries` | PASS | PASS |  |
| `no-token:PUT /api/journal/entries/:uuid` | PASS | PASS |  |
| `no-token:POST /api/journal/entries/:uuid/void` | PASS | PASS |  |
| `no-token:POST /api/journal/custom-vocab` | PASS | PASS |  |
| `no-token:PUT /api/journal/custom-vocab/:uuid` | PASS | PASS |  |
| `no-token:GET /api/journal/plots` | PASS | PASS |  |
| `no-token:POST /api/journal/plots` | PASS | PASS |  |
| `no-token:PUT /api/journal/plots/:uuid` | PASS | PASS |  |
| `no-token:GET /api/journal/plot-groups` | PASS | PASS |  |
| `no-token:POST /api/journal/plot-groups` | PASS | PASS |  |
| `no-token:PUT /api/journal/plot-groups/:uuid` | PASS | PASS |  |
| `no-token:GET /api/journal/export.csv` | PASS | PASS |  |
| `no-token:GET /api/journal/export.package` | PASS | PASS |  |
| `no-token:GET /api/journal/export.json` | PASS | PASS |  |
| `no-token:GET /api/journal/export.adapt.json` | PASS | PASS |  |
| `no-token:POST /api/devices/:deveui/sdi12/recipe/rollback` | PASS | PASS |  |
| `no-token:POST /api/devices/:deveui/sdi12/recipe/apply` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/sdi12/config` | PASS | PASS |  |
| `no-token:GET /api/sdi12/probe-profiles` | PASS | PASS |  |
| `no-token:POST /api/devices/:deveui/sdi12/identify` | PASS | PASS |  |
| `no-token:GET /api/valves` | PASS | PASS |  |
| `no-token:GET /api/valves/:deveui/schedules` | PASS | PASS |  |
| `no-token:POST /api/valves/:deveui/schedules` | PASS | PASS |  |
| `no-token:PUT /api/valves/:deveui/schedules/:uuid` | PASS | PASS |  |
| `no-token:DELETE /api/valves/:deveui/schedules/:uuid` | PASS | PASS |  |
| `no-token:POST /api/valves/:deveui/plan/resend` | PASS | PASS |  |
| `no-token:POST /api/valves/:deveui/scheduler-status` | PASS | PASS |  |
| `no-token:PUT /api/valves/:deveui/settings` | PASS | PASS |  |
| `no-token:GET /api/system/settings` | PASS | PASS |  |
| `no-token:PUT /api/system/settings` | PASS | PASS |  |
| `no-token:GET /api/me` | PASS | PASS |  |
| `no-token:GET /api/users` | PASS | PASS |  |
| `no-token:POST /api/users` | PASS | PASS |  |
| `no-token:POST /api/users/:uuid/password-reset` | PASS | PASS |  |
| `no-token:PUT /api/users/:uuid/role` | PASS | PASS |  |
| `no-token:PUT /api/users/:uuid/disabled` | PASS | PASS |  |
| `no-token:POST /api/grants/zone` | PASS | PASS |  |
| `no-token:DELETE /api/grants/zone/:assignmentUuid` | PASS | PASS |  |
| `no-token:POST /api/grants/plot` | PASS | PASS |  |
| `no-token:DELETE /api/grants/plot/:assignmentUuid` | PASS | PASS |  |
| `no-token:GET /api/network/observations` | PASS | PASS |  |
| `no-token:GET /api/devices/:deveui/installation-location` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/installation-location` | PASS | PASS |  |
| `no-token:GET /api/devices/:deveui/installation-location/revisions` | PASS | PASS |  |
| `no-token:GET /api/devices/:deveui/radio-configuration` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/radio-configuration` | PASS | PASS |  |
| `no-token:GET /api/devices/:deveui/radio-configuration/revisions` | PASS | PASS |  |
| `no-token:PUT /api/gateway/location` | PASS | PASS |  |
| `no-token:PUT /api/irrigation-zones/:id/name` | PASS | PASS |  |
| `no-token:PUT /api/devices/:deveui/name` | PASS | PASS |  |
| `no-token:POST /api/sync/outbox/recover` | PASS | PASS |  |
| `no-token:GET /api/irrigation-zones/:id/irrigation-policy` | PASS | PASS |  |
| `no-token:PUT /api/irrigation-zones/:id/irrigation-policy` | PASS | PASS |  |
| `no-token:POST /api/irrigation-zones/:id/irrigation-policy/pause` | PASS | PASS |  |
| `no-token:POST /api/irrigation-zones/:id/irrigation-policy/retry-valve` | PASS | PASS |  |
| `no-token:GET /api/irrigation-zones/:id/irrigation-policy/decisions` | PASS | PASS |  |
| `enabled-inject-sweep` | PASS | PASS |  |
| `dendro-weather-transport` | FAIL | FAIL | NEW-1 |
| `caught-node-errors` | PASS | PASS |  |
| `network-contained` | PASS | PASS |  |
| `flows-unchanged` | PASS | PASS |  |
| `helpers-unchanged` | PASS | PASS |  |
| `startup-node-errors` | FAIL | FAIL | F-14 |
| `startup-function-errors` | PASS | PASS |  |
| `database-integrity` | PASS | PASS |  |
