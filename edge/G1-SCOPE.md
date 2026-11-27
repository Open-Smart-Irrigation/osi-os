# G1 spike scope (pre-registered 2026-11-23, before any port)

The rate G1 measures only means something if the slice was not chosen for
ease. These items were fixed before porting started. Flow lines are the
function-node lines reachable from each route's `http in` node
(`route-sizes.tsv` in the spike folder); module code the route calls
comes on top. Route size quartiles over all 156 routes: p25 32, p50 253,
p75 1,413, max 4,075 lines.

## Routes (15)

| # | Route | Kind | Flow lines | Modules on the path |
|---|---|---|---|---|
| 1 | `POST /auth/register` | write | 320 (shared auth chain) | bcryptjs, osi-installation-helper |
| 2 | `POST /auth/login` | read + rehash write | same chain | bcryptjs, osi-local-password-reset |
| 3 | `GET /api/me` | read | 158 | osi-scope-helper |
| 4 | `GET /api/system/settings` | read | 19 | osi-system-settings |
| 5 | `PUT /api/system/settings` | write | 19 | osi-system-settings |
| 6 | `GET /api/irrigation-zones` | read | 270 | osi-scope-helper |
| 7 | `POST /api/irrigation-zones` | write | 368 | osi-entity-name |
| 8 | `PUT /api/irrigation-zones/:id/name` | write, command path | 198 | osi-entity-name |
| 9 | `PUT /api/irrigation-zones/:zone_id/config` | write, **outbox** | 885 | osi-system-settings, osi-rain |
| 10 | `GET /api/devices` | read | 738 | osi-sdi12-commissioning, osi-history-helper |
| 11 | `POST /api/devices` | write, ChirpStack | 572 | osi-entity-name, osi-chirpstack-helper, osi-valve-control |
| 12 | `PUT /api/devices/:deveui/name` | write | 225 | osi-entity-name |
| 13 | `POST /api/valve/:deveui` | write, **timed open via gRPC** | 9 | osi-command-ingress, osi-valve-control, osi-chirpstack-helper |
| 14 | `GET /api/valves/:deveui/schedules` | read | 4 | osi-valve-control |
| 15 | `POST /api/valves/:deveui/schedules` | write, radio plan | 4 | osi-valve-control |

Size spread: four routes under p25, five between p25 and p50, six above p50.
Six writes reach a durable side effect beyond one table: the outbox, ChirpStack
gRPC or radio frames.

## Non-route items

| # | Item | Charter G1 item | CTO priority |
|---|---|---|---|
| A | Session tokens and bcrypt byte-compatible (vectors plus routes 1–3) | (5) | 1 |
| B | One sync event byte-exact: the zone-config outbox row from route 9, plus canonical v1/v2 and history-row-hash vectors | (5) | 2 |
| C | One timed open end to end through the fake gRPC: INTENT, ATTEMPTED, enqueue, outcome rows and frames (route 13) | (3) | 3 |
| D | KIWI ingest: at least 500 replayed uplinks, zero row differences | (4) | 4 |
| E | SQLite adapter on a seed copy: WAL, `BEGIN IMMEDIATE`, online backup | (2) | 5 |
| F | Timer: the daily 06:00 schedule tick | brief | 6 |
| G | armv7 and arm64 static binaries, size and RSS against Node-RED's, run in the Pi 5 emulator beside Node-RED with a switch script | (1), (6) | — |

Anything not reached is reported as "not measured", never as a pass.

## What G1 does not port

The boot DDL (`sync-init-fn`): every backend run starts from the database
the Node-RED oracle left after its own boot (`fixture.db` in each cassette).
Schema-dump equality after a cold boot of the new backend is G2/G3 work.
