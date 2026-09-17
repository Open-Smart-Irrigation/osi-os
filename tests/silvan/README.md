# Silvan end-to-end harness

Drives the **Silvan test gateway** end to end: real HTTP against the running
Node-RED backend, real MQTT against the gateway's own mosquitto, real SQLite
read-back over SSH, and a real browser against the GUI the gateway is serving.
Nothing is mocked and nothing is stubbed — if a case passes, that code path
works on a real gateway.

Silvan is a **test** gateway with no valve hardware. Every valve, sensor and
weather station this harness touches is a device it registers itself, with a
DevEUI in a reserved simulated range.

---

## Safety

These are not conventions, they are enforced in code. Read them before changing
anything under `lib/`.

| Guard | Where | What it does |
|---|---|---|
| EUI guard, pre-flight | `lib/config.js` `assertSilvanViaSsh` | Reads `uci get osi-server.cloud.device_eui` over SSH **before any HTTP request** and aborts unless it is `0016C001F11715E2`. |
| EUI guard, over the tunnel | `lib/config.js` `assertSilvanViaApi` | Reads `gatewayIdentity.currentEui` from `GET /api/sync/state` and aborts on a mismatch, so a tunnel terminating on a different Node-RED than the SSH session cannot go unnoticed. |
| Forbidden hosts | `lib/config.js` `assertEndpointsAllowed` | Applies `FORBIDDEN_HOSTS` (by IP **and** by name) to **every** endpoint — SSH host, `SILVAN_API_BASE`, `SILVAN_GUI_BASE`, `SILVAN_MQTT_HOST` — unconditionally, and **before** `SILVAN_ALLOW_ALT_HOST` is even read. That escape hatch can never reach the Uganda production gateway, `osicloud.ch`, the OSI test server or `100.99.212.115`. |
| Endpoint consistency | `lib/config.js` `assertEndpointsAllowed` | Every non-SSH endpoint must be either a loopback tunnel address (`127.0.0.1`, `localhost`, `::1`) or exactly the SSH host the EUI guards verify. This closes the gap where SSH points at Silvan — so both EUI guards pass — while the HTTP or MQTT client is quietly aimed elsewhere. `SILVAN_MQTT_PORT` must be a real TCP port. |
| Host lock | `lib/config.js` `assertEndpointsAllowed` | Refuses any `sshHost` other than Silvan's unless `SILVAN_ALLOW_ALT_HOST` is set — checked last, after the two rules above, and the EUI guards still apply on top. |
| Guarded clients only | `lib/config.js` `assertEndpointGuardPassed` | `config()` marks a cleared config with a `Symbol`. The SSH client and the MQTT observer both refuse to start unless their config carries it, so a hand-written object literal cannot slip past the checks. |
| Evidence redaction | `lib/rest.js` `redact` | `password`, `token`, `sync_token`, `mqtt_password`, `appkey`, `Authorization` and friends are replaced with `[redacted]` **as the transcript record is built**, not filtered later — so no path exists that records a secret and relies on a downstream filter. |
| Simulated devices only | `lib/config.js` `assertSimulatedDevice` | Every DevEUI the harness registers, actuates or answers for must start with `70B3D57ED00`. Commanding anything else throws. |
| Read-only SQL | `lib/ssh.js` `Ssh.sql` | Opens the database `file:...?mode=ro` with `sqlite3 -readonly` and refuses any statement matching INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/REPLACE/VACUUM/ATTACH. The harness can never reseed or repair `farming.db`. |
| No cloud link changes | case `C1` | Observes the outbox only. It never links, unlinks, cuts the network, or pushes this gateway's data anywhere. |
| Bounded, self-removing route change | case `R1` (`cloudDisconnectCase`) | Before adding an `ip route add blackhole <ip>`, arms a `nohup sh -c 'sleep 180; ip route del blackhole <ip>' &` guard, cross-checks the target against `FORBIDDEN_HOSTS` and against this harness's own SSH/API/MQTT endpoints (refusing if they'd ever coincide), removes the route itself in a `finally`, and reads the route table back to confirm it is gone — never trusting the timer alone. |
| Bounded disk pressure | case `R1` (`diskPressureCase`) | Refuses to create its 200 MB temp file under `/data` at all unless free space would stay ≥ 500 MB afterwards, and always attempts to remove the file in a `finally`. |

Both EUI guards run **before the first mutation**. The API guard needs a bearer
token, so the runner mints a 60-second read-only one on the Pi for that check
alone: `/api/sync/state` tolerates a token whose user does not exist
(`userRows[0] || {}`) and still reports `gatewayIdentity.currentEui`, which
matters because a freshly deployed gateway has an empty users table and
registering an account first would mean writing to a gateway whose HTTP identity
is still unverified.

The gateway's auth secret **never leaves the Pi**: `Ssh.mintToken` runs the HMAC
in a one-shot `node -e` over SSH and only the finished token comes back. That is
also the only way to get a token with a chosen `exp`, which the expired-token
assertions need (`/auth/login` always issues `exp = iat + 7 days`).

---

## Running it

Open the tunnel in one terminal and leave it running:

```bash
ssh -N -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes \
    -L 18800:127.0.0.1:1880 \
    -L 18830:127.0.0.1:1883 \
    root@100.81.220.8
```

`18800` is Node-RED (HTTP API + GUI), `18830` is the gateway's mosquitto
(`allow_anonymous true`, no credentials).

First, the offline self-test — it needs no gateway, no SSH and no tunnel, and
proves the safety machinery still refuses what it should:

```bash
node tests/silvan/selftest.js
```

Then, from the repo root:

```bash
node tests/silvan/run.js --list
node tests/silvan/run.js --cases A1,Z1 --out /tmp/silvan-run
node tests/silvan/run.js --out /tmp/silvan-run           # every case
NODE_OPTIONS=--max-old-space-size=2048 node tests/silvan/run.js --cases U1 --out /tmp/silvan-run
```

The runner exits non-zero if any selected case fails and prints a matrix
summary. Evidence lands in the run directory: `<CASE>.md` and `<CASE>.json` per
case, plus `summary.md` / `summary.json`, and `ui/` for screenshots.

| Flag | Meaning |
|---|---|
| `--cases A1,Z1` | Run only these. Default: all. |
| `--out DIR` | Evidence directory. Default: `./silvan-run-<timestamp>`. |
| `--user NAME` | Authenticate as an existing gateway account (token minted on the Pi) instead of registering a throwaway one. |
| `--keep` | Skip cleanup. Debugging only — it leaves zones, devices and schedules behind. |
| `--list` | Print the case list and exit. |

Environment overrides: `SILVAN_SSH_HOST`, `SILVAN_SSH_USER`, `SILVAN_SSH_KEY`,
`SILVAN_API_BASE`, `SILVAN_GUI_BASE`, `SILVAN_MQTT_HOST`, `SILVAN_MQTT_PORT`,
`OSI_PLAYWRIGHT_DIR`, `SILVAN_DEBUG=1` (print stack traces).

**Playwright** is not a repo dependency. It is loaded from
`/home/phil/osi-tools/playwright` (override with `OSI_PLAYWRIGHT_DIR`). Do not
add it to any `package.json`, and do not `npm run build` the GUI to run `U1` —
the smoke tests the bundle the gateway is actually serving.

---

## Cases

| ID | Covers |
|---|---|
| `A1` | Register, login, session, duplicate/short/blank credentials, malformed, tampered, forged and expired tokens, and what "logout" actually does. |
| `A2` | Role/permission gates in Silvan's default (unscoped) state: the admin accounts/grants router 404s for everyone regardless of role, reboot/fan/settings have no role gate at all while unscoped (proven by reading the deployed source, never by calling reboot), and cross-user isolation on zones/devices/valve schedules (404 for zone/device rows outside your `user_id`, 403 "forbidden" for a valve `ownedValve()` claims belongs to someone else). Deliberately partial — see below. |
| `Z1` | Zones and devices: empty install, create, assign, move, unassign, delete, and the SQLite state behind each. |
| `Z2` | Invalid input, duplicate zone names, operations on missing dependencies, deleting a zone that still owns a device, deleting things that were never there. |
| `V1` | Valve actuation on a simulated valve: byte-exact downlinks, actuation expectations, actuator log, repeated clicks, cancel, and every rejected input. |
| `V2` | The on-valve plan ACK ledger under a refused, duplicated, stray, dropped and very late ACK, plus reconciliation to `OBSERVED_RUNNING`. |
| `S1` | Schedule CRUD, invalid durations and times, overlap detection, midnight, day rollover, one-time opens, and deletes. |
| `S2` | Schedules at day boundaries: an offline pure-math pass over the real `plan.js` across the actual 2026 Europe/Zurich DST transitions, plus a live pass at two fixed-offset, no-DST extremes (Pacific/Kiritimati +14, Pacific/Pago_Pago -11) cross-checking `GET /api/valves`' `next_run` against the same compiler run directly, and proving the on-valve weekday/fPort encoding does not shift with the zone offset. |
| `P1` | Control precedence on a simulated valve: a manual open alongside a pending (not-yet-due) schedule, cancel invalidating an active action (including a late post-cancel uplink race), a schedule deleted before it fires, and the one local, always-reachable retry-safety surface (a repeated cancel is idempotent). |
| `D1` | Ingest with no data / one sample / many samples, out-of-range clamping, NULL-not-zero for absent fields, stale and future-dated samples, and the cumulative-rain delta state machine. |
| `ST1` | Settings read/write/validate/persist/restore, per-zone timezone, feature flags, system stats. |
| `C1` | Local writes and outbox growth while the cloud is unreachable, observed through `/api/sync/state` and `sync_outbox`; plus duplicate uplink delivery, an expired (past-grace) queued one-time open, and a stale plan push's isolation from an unrelated recompile. Deliberately partial — see below. |
| `R1` | Bounded runtime/recovery, Silvan only: a Node-RED restart with an uplink burst and a queued valve action in flight (plus the restart-triggered cloud bootstrap check, F81), a self-removing blackholed route toward whatever host this gateway is actually linked to, and a 200 MB `/data` disk-pressure probe. Every risky action is guarded, bounded, and self-cleaning — see below. |
| `U1` | Browser smoke: real login form, screenshots at 1366×768 and 390×844 for every route, and a French hardcoded-English scan. |

`selftest.js` is separate from the matrix: it tests the harness, not the
gateway. Run it after any change under `lib/`.

---

## Adding a case

A case is one file under `cases/` exporting `title`, `run(ctx)` and optionally
`cleanup(ctx)`. Register it in the `CASES` array in `run.js`.

```js
'use strict';
exports.title = 'One line describing what this proves';

const state = { zones: [], devices: [] };

exports.run = async (ctx) => {
  const { rest, ssh, ev } = ctx;

  // Preconditions: assume NOTHING about gateway state. A fresh deploy has an
  // empty database, so create what you need.
  const zone = await rest.post('/api/irrigation-zones', { name: 'My Zone' });
  ctx.expectStatus('the zone is created', zone, 201);
  if (zone.body && zone.body.id) state.zones.push(zone.body.id);

  // Assert through the API AND through SQLite: the API can report success for a
  // write that never landed.
  const row = await ssh.sqlOne(
    "SELECT name FROM irrigation_zones WHERE zone_uuid = '" + zone.body.zone_uuid + "'");
  ctx.expect('SQLite: the row exists', !!row && row.name === 'My Zone', row);

  ev.note('Anything a reader should know that is not an assertion.');
};

exports.cleanup = async (ctx) => {
  for (const id of state.zones.slice()) await ctx.deleteZone(id);
  state.zones.length = 0;
};
```

What `ctx` gives you:

- `ctx.rest` / `ctx.anonRest` — authenticated and anonymous REST clients. Every
  request is recorded into the case's HTTP transcript.
- `ctx.ssh` — `sql()`, `sqlOne()`, `sqlScalar()` (read-only), `mintToken()`,
  `nodeRedLog()`.
- `ctx.observer` — the downlink observer. `setBehaviour(eui, mode)` with
  `ack | nack | delay | duplicate | drop | observe`, `waitForDownlink(fn)`,
  `downlinksFor(eui)`, `answer(downlink, opts)`.
- `ctx.U` — uplink builders (`kiwiUplink`, `s2120Uplink`, `lsn50Uplink`,
  `stregaStatusUplink`, the STREGA ACK builders, and raw `envelope`).
- `ctx.publishSensorUplink(env)` / `ctx.publishActuatorUplink(env)`.
- `ctx.simDeveui(label, n)` — a stable simulated DevEUI.
  `ctx.freshDeveui(label)` — one unique to this run; use it whenever the case
  needs a device with **no** history (see the cleanup caveat below).
- `ctx.until(fn, { timeoutMs, what })` — poll until truthy. Use this instead of
  a fixed sleep: ingest is asynchronous (MQTT → function node → sqlite node), so
  a fixed wait is either flaky or slow.
- `ctx.expect(name, condition, detail)`, `ctx.expectStatus`, `ctx.expectEqual`.
- `ctx.env` — the gateway's effective ChirpStack application/profile IDs.
- `ctx.ev` — the evidence writer: `step()`, `note()`, `artifact()`.

Write assertion names as the sentence you want to read in a report:
"SQLite: the zone is tombstoned, not hard-deleted" beats "check 4".

---

## Cleanup, and what it cannot clean

Each case releases what it created. Two things survive on purpose, because no
API can remove them:

- **Accounts.** There is no `DELETE /api/users` route. `A1` and `U1` each
  register one throwaway account per run; the runner prints the name. Use
  `--user NAME` for the other cases to authenticate as an existing account and
  leave no new rows at all.
- **Device rows and their telemetry.** `DELETE /api/devices/:deveui` *unclaims*
  a device (`user_id = NULL`); it does not set `deleted_at` and does not remove
  `device_data`. A stable simulated DevEUI is therefore dirty on the second run,
  which is exactly why `D1` and `C1` use `ctx.freshDeveui()`.

On a cloud-linked gateway, registering a device the cloud has never seen leaves
permanently rejected `sync_outbox` rows behind (`ownership_denied`). That is the
documented never-seen-resource rule, not a harness bug, but it means repeated
runs against a linked gateway do add rows the outbox never drains.

---

## Known limitations

- **`C1` is still partial.** Link/unlink, a real network cut, conflicting cloud
  edits, and expiry of queued *cloud* commands all need a controlled cloud
  endpoint and an account link this harness must not create. Duplicate LOCAL
  uplink delivery, an expired LOCAL (ONCE) queued action, and a stale LOCAL
  plan push's isolation from an unrelated recompile are now covered (T16f); a
  bounded, real cloud-reachability outage is `R1`'s job, not `C1`'s.
- **Long timers are out of reach.** `STALE_OPEN_OBSERVED` needs 1800 s past
  `expected_close_at` (`RECONCILIATION_GRACE_SEC`), the schedule tick is a
  06:00 cron, and outbox retention runs at 02:00. These need a soak run or an
  injectable clock.
- **DST/day-boundary math is covered; ON-VALVE firing across a live transition
  is not.** `S2` (T16f) exercises the real `plan.js` next_run/nextLocalOccurrence
  computation offline across the actual 2026 Europe/Zurich DST dates, and live
  against two fixed-offset (+14/-11) zones. What's still out of reach: the
  on-valve firmware actually FIRING across a live transition, and the FPort
  12/13 clock-sync push crossing one — both still need a soak run or an
  injectable gateway clock.
- **`A2` covers the DEFAULT (unscoped) state only, by design.** Silvan runs
  `OSI_SCOPED_ACCESS=0`, and that flag is set once at `node-red.init` startup
  from a UCI value — there is no settings-API toggle, only a UCI write plus a
  Node-RED restart, and this harness does not perform that flip. `A2` proves
  what "role/permission denial" and tenant isolation actually mean in the
  state every current gateway runs in (per-`user_id` isolation on zone/device
  reads and writes, 403 on a claimed valve, and the admin-router/reboot/fan
  role gates all being scoped-only); the scoped-ON code paths, and true
  multi-tenant coverage (`A3`), remain untested here.
- **The `U1` English scan is a heuristic.** It reliably catches i18next error
  text, raw keys, and English that has a French translation. The
  never-translated-at-all check is a marker-word heuristic and can produce a
  false positive on a proper noun or a device name.
- **Assertions are pinned to a deployed payload, not to the repo.** Every run
  records the gateway's `flows.json` path and md5 in `summary.json`. A gateway
  running an older payload than `origin/main` will disagree with the repo, and
  that is a finding, not a harness failure.
- **`R1` shares this gateway with every other harness run.** Silvan
  accumulates a persistent backlog of `ownership_denied` outbox rejections
  from every prior run's simulated devices/zones (see `C1`), and
  `lastOutboxDeliverySuccessAt` was found (2026-09-17, live) to be permanently
  null here as a result — it appears to only be set on a zero-rejection batch,
  which never happens on a gateway with hundreds of accumulated rejections.
  `R1`'s cloud-disconnect recovery check uses `lastPendingCommandPollSuccessAt`
  instead (a plain GET, unconfounded by per-event business-logic rejections),
  not `lastError`'s mere presence/absence and not `lastOutboxDeliverySuccessAt`.
  If you add a new reachability check anywhere in this harness, reuse that
  field rather than re-discovering this the hard way.
