# Whole-suite runtime comparison on main 103e4c54

Both runtimes start the same shipped flows under Node 20.18.3. Each executes
all 216 cases in each of five paired runs. The unchanged harness pool is 2;
F-7 will supply one setting from the product init script to the harness.
These measurements precede that change and must be repeated after rebasing.

| Runtime | At-once actuator-log BUSY | Other unexpected differences |
| --- | --- | --- |
| Node-RED 3.1.15 | 0/5 runs | 0 |
| Node-RED 4.0.9 | 1/5 runs (one delivery) | 0 |

The first stock run fails `caught-node-errors` with
`Error: SQLITE_BUSY: database is locked` from the sqlite node
`DB: insert actuator_log` during `open-no-report-open-at-once`.
This is existing F-7, remains unexpected, and is not added to either list.
The stopped run's database has two actuator-log rows for its three accepted
opens, three radio frames and three command records. The paired image run
has all three log rows. No write retry was performed; the loss is not a late read.

The five known cases have identical signatures in every run; their exact
failure evidence is in [the stock list](known-failures.json). Six obsolete
stock entries passed before removal, all fixed by #648 (F-1, F-2 and F-4).
The first stock command exits 1 for those six passing entries and F-7;
subsequent stock commands and every image command exit 0. The table below
counts raw assertions against the current five-entry list, without hiding
that first policy refusal. No failed run is replaced by a green retry.

The actual stock npm user install honors all locked versions, including
node-red-node-sqlite 1.1.1 and sqlite3 5.1.7. Each runtime maps one native
addon; the stock addon is in its user directory, with no firmware copy.
The shared sandbox names/wrapper bindings are identical in 3.1.15 and 4.0.9.
The 4.0.9 getSetting restriction affects no shipped function call, so the
identifier checker stays unchanged.

[Machine-readable counts and run evidence](baseline-103e4c54.json) retain
all five pairs. The sample is a repository baseline, not a field failure-rate
estimate or native ABI/device qualification.

| Case | 3.1.15 | 4.0.9 | Finding |
| --- | --- | --- | --- |
| `runtime-started` | PASS 5/5 | PASS 5/5 |  |
| `login-and-lists` | PASS 5/5 | PASS 5/5 |  |
| `command-accepted:close` | PASS 5/5 | PASS 5/5 |  |
| `command-refused:close` | PASS 5/5 | PASS 5/5 |  |
| `command-accepted:close-duration` | PASS 5/5 | PASS 5/5 |  |
| `command-refused:close-duration` | PASS 5/5 | PASS 5/5 |  |
| `command-accepted:open-duration` | PASS 5/5 | PASS 5/5 |  |
| `command-refused:open-duration` | PASS 5/5 | PASS 5/5 |  |
| `command-accepted:interval` | PASS 5/5 | PASS 5/5 |  |
| `command-refused:interval` | PASS 5/5 | PASS 5/5 |  |
| `command-accepted:timed-close` | PASS 5/5 | PASS 5/5 |  |
| `command-refused:timed-close` | PASS 5/5 | PASS 5/5 |  |
| `command-accepted:magnet` | PASS 5/5 | PASS 5/5 |  |
| `command-refused:magnet` | PASS 5/5 | PASS 5/5 |  |
| `command-accepted:partial-close` | PASS 5/5 | PASS 5/5 |  |
| `command-refused:partial-close` | PASS 5/5 | PASS 5/5 |  |
| `command-accepted:flushing` | PASS 5/5 | PASS 5/5 |  |
| `command-refused:flushing` | PASS 5/5 | PASS 5/5 |  |
| `command-invalid:{"action":"OPEN"}` | PASS 5/5 | PASS 5/5 |  |
| `command-invalid:{"action":"OPEN_FOR_DURATION","duration_minutes":0}` | PASS 5/5 | PASS 5/5 |  |
| `command-invalid:{"action":"OPEN_FOR_DURATION","duration_minutes":256}` | PASS 5/5 | PASS 5/5 |  |
| `open-report-close-open` | PASS 5/5 | PASS 5/5 |  |
| `open-no-report-open-later` | PASS 5/5 | PASS 5/5 |  |
| `open-no-report-open-at-once` | PASS 5/5 | PASS 5/5 |  |
| `no-clock-open-report-close-open` | PASS 5/5 | PASS 5/5 |  |
| `no-clock-open-no-report-open-later` | PASS 5/5 | PASS 5/5 |  |
| `no-clock-open-no-report-open-at-once` | PASS 5/5 | PASS 5/5 |  |
| `no-clock-safety-close` | PASS 5/5 | PASS 5/5 |  |
| `open-after:close-duration` | PASS 5/5 | PASS 5/5 |  |
| `open-at-once-after:close-duration` | PASS 5/5 | PASS 5/5 |  |
| `open-after:timed-close` | PASS 5/5 | PASS 5/5 |  |
| `open-at-once-after:timed-close` | PASS 5/5 | PASS 5/5 |  |
| `open-after:flushing` | PASS 5/5 | PASS 5/5 |  |
| `open-at-once-after:flushing` | PASS 5/5 | PASS 5/5 |  |
| `lifecycle:assign` | PASS 5/5 | PASS 5/5 |  |
| `lifecycle:remove` | PASS 5/5 | PASS 5/5 |  |
| `lifecycle:delete-device` | PASS 5/5 | PASS 5/5 |  |
| `lifecycle:delete-zone` | PASS 5/5 | PASS 5/5 |  |
| `weekly-save` | PASS 5/5 | PASS 5/5 |  |
| `weekly-change` | PASS 5/5 | PASS 5/5 |  |
| `weekly-delete` | PASS 5/5 | PASS 5/5 |  |
| `scheduler-irrigates` | PASS 0/5; FAIL 5/5 | PASS 0/5; FAIL 5/5 | listed F-7 |
| `no-token:POST /auth/register` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /auth/login` | PASS 5/5 | PASS 5/5 |  |
| `no-token:OPTIONS /auth/*` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /download/database` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/devices` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/catalog` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/devices` | PASS 5/5 | PASS 5/5 |  |
| `no-token:DELETE /api/devices/:deveui` | PASS 5/5 | PASS 5/5 |  |
| `no-token:OPTIONS /api/*` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/irrigation-zones` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/irrigation-zones` | PASS 5/5 | PASS 5/5 |  |
| `no-token:DELETE /api/irrigation-zones/:id` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/irrigation-zones/:id/devices/:deveui` | PASS 5/5 | PASS 5/5 |  |
| `no-token:DELETE /api/irrigation-zones/:id/devices/:deveui` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/irrigation-zones/:id/schedule` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/irrigation-zones/schedules/disable-all` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/valve/:deveui` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /download-sensordata` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/devices/:deveui/dendro-history` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/dendro` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/temp` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/devices/:deveui/sensor-history` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/devices/:deveui/rain-history` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/system/stats` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/system/reboot` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/system/fan` | PASS 5/5 | PASS 5/5 |  |
| `no-token:OPTIONS /api/system/*` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/account-link/status` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/account-link` | PASS 0/5; FAIL 5/5 | PASS 0/5; FAIL 5/5 | listed F-13 |
| `no-token:DELETE /api/account-link` | PASS 5/5 | PASS 5/5 |  |
| `no-token:OPTIONS /api/account-link` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/dendrometer/:deveui/daily` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/irrigation-zones/:zone_id/recommendations` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/dendrometer/:deveui/readings` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/reference-tree` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/irrigation-zones/:zone_id/timezone` | PASS 5/5 | PASS 5/5 |  |
| `no-token:OPTIONS /api/dendrometer/*` | PASS 5/5 | PASS 5/5 |  |
| `no-token:OPTIONS /api/irrigation-zones/:zone_id/recommendations` | PASS 5/5 | PASS 5/5 |  |
| `no-token:OPTIONS /api/devices/:deveui/reference-tree` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/irrigation-zones/:zone_id/location` | PASS 5/5 | PASS 5/5 |  |
| `no-token:OPTIONS /api/irrigation-zones/:zone_id/location` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/irrigation-zones/:zone_id/config` | PASS 5/5 | PASS 5/5 |  |
| `no-token:OPTIONS /api/irrigation-zones/:zone_id/config` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/sync/state` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/sync/force` | PASS 0/5; FAIL 5/5 | PASS 0/5; FAIL 5/5 | listed F-13 |
| `no-token:PUT /api/devices/:deveui/lsn50/mode` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/lsn50/interval` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/kiwi/interval` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/devices/:deveui/kiwi/temperature-humidity/enable` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/strega/interval` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/lsn50/interrupt-mode` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/lsn50/5v-warmup` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/strega/model` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/strega/timed-action` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/strega/magnet` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/strega/partial-opening` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/strega/flushing` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/gateway/location` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/gateways/:gatewayEui/location` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/irrigation-zones/:zone_id/environment-summary` | PASS 5/5 | PASS 5/5 |  |
| `no-token:OPTIONS /api/irrigation-zones/:zone_id/environment-summary` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/rain-gauge` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/flow-meter` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/devices/:deveui/zone-assignments` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/zone-assignments` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/soil-moisture-depths` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/chameleon` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/dendro-config` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/devices/:deveui/dendro-baseline/reset` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/v1/valves/:deveui/cancel` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/valve/:deveui/cancel` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/v1/devices/:deveui/today-liters` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/devices/:deveui/chameleon/refresh-calibration` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/chameleon/depth` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/devices/:deveui/watermark/calibration` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/watermark/calibration` | PASS 5/5 | PASS 5/5 |  |
| `no-token:DELETE /api/devices/:deveui/watermark/calibration` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/irrigation/recent-actuations` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/irrigation-zones/:id/calibration` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/irrigation-zones/:zone_id/rain-source` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/irrigation-zones/:zone_id/rain-source` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/history/zones/:zoneId/cards` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/history/zones/:zoneId/cards/:cardId/data` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/history/zones/:zoneId/cards/:cardId/advanced` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/history/gateways/:gatewayEui/cards` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/history/gateways/:gatewayEui/cards/:cardId/data` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/history/gateways/:gatewayEui/cards/:cardId/advanced` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/history/workspaces` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/history/workspaces` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/history/workspaces/:id` | PASS 5/5 | PASS 5/5 |  |
| `no-token:DELETE /api/history/workspaces/:id` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/history/zones/:zoneId/cards/:cardId/preferences` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/history/zones/:zoneId/cards/:cardId/opened` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/history/gateways/:gatewayEui/cards/:cardId/preferences` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/history/gateways/:gatewayEui/cards/:cardId/opened` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/system/features` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/history/rollups/run` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/history/zones/:zoneId/export.csv` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/history/export.csv` | PASS 5/5 | PASS 5/5 |  |
| `no-token:DELETE /api/analysis/views/:id` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/analysis/channels` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/analysis/series` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/analysis/views` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/analysis/views` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/improvement-requests` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/improvement-requests/diagnostics-preview` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/improvement-requests` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/journal/catalog` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/journal/entries` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/journal/entries` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/journal/entries/:uuid` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/journal/entries/:uuid/void` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/journal/custom-vocab` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/journal/custom-vocab/:uuid` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/journal/plots` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/journal/plots` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/journal/plots/:uuid` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/journal/plot-groups` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/journal/plot-groups` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/journal/plot-groups/:uuid` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/journal/export.csv` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/journal/export.package` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/journal/export.json` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/journal/export.adapt.json` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/devices/:deveui/sdi12/recipe/rollback` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/devices/:deveui/sdi12/recipe/apply` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/sdi12/config` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/sdi12/probe-profiles` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/devices/:deveui/sdi12/identify` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/valves` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/valves/:deveui/schedules` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/valves/:deveui/schedules` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/valves/:deveui/schedules/:uuid` | PASS 5/5 | PASS 5/5 |  |
| `no-token:DELETE /api/valves/:deveui/schedules/:uuid` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/valves/:deveui/plan/resend` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/valves/:deveui/scheduler-status` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/valves/:deveui/settings` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/system/settings` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/system/settings` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/me` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/users` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/users` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/users/:uuid/password-reset` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/users/:uuid/role` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/users/:uuid/disabled` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/grants/zone` | PASS 5/5 | PASS 5/5 |  |
| `no-token:DELETE /api/grants/zone/:assignmentUuid` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/grants/plot` | PASS 5/5 | PASS 5/5 |  |
| `no-token:DELETE /api/grants/plot/:assignmentUuid` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/network/observations` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/devices/:deveui/installation-location` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/installation-location` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/devices/:deveui/installation-location/revisions` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/devices/:deveui/radio-configuration` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/radio-configuration` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/devices/:deveui/radio-configuration/revisions` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/gateway/location` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/irrigation-zones/:id/name` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/devices/:deveui/name` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/sync/outbox/recover` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/irrigation-zones/:id/irrigation-policy` | PASS 5/5 | PASS 5/5 |  |
| `no-token:PUT /api/irrigation-zones/:id/irrigation-policy` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/irrigation-zones/:id/irrigation-policy/pause` | PASS 5/5 | PASS 5/5 |  |
| `no-token:POST /api/irrigation-zones/:id/irrigation-policy/retry-valve` | PASS 5/5 | PASS 5/5 |  |
| `no-token:GET /api/irrigation-zones/:id/irrigation-policy/decisions` | PASS 5/5 | PASS 5/5 |  |
| `enabled-inject-sweep` | PASS 5/5 | PASS 5/5 |  |
| `dendro-weather-transport` | PASS 0/5; FAIL 5/5 | PASS 0/5; FAIL 5/5 | listed NEW-1 |
| `caught-node-errors` | PASS 5/5 | PASS 4/5; FAIL 1/5 | F-7, unexpected |
| `network-contained` | PASS 5/5 | PASS 5/5 |  |
| `flows-unchanged` | PASS 5/5 | PASS 5/5 |  |
| `helpers-unchanged` | PASS 5/5 | PASS 5/5 |  |
| `startup-node-errors` | PASS 0/5; FAIL 5/5 | PASS 0/5; FAIL 5/5 | listed F-14 |
| `startup-function-errors` | PASS 5/5 | PASS 5/5 |  |
| `database-integrity` | PASS 5/5 | PASS 5/5 |  |
