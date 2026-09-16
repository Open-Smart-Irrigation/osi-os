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
| Forbidden hosts | `lib/config.js` `FORBIDDEN_HOSTS` | Refuses to start against the Uganda production gateway, `osicloud.ch`, the OSI test server, or `100.99.212.115`. |
| Host lock | `lib/config.js` `config()` | Refuses any `sshHost` other than Silvan's unless `SILVAN_ALLOW_ALT_HOST` is set — and the EUI guard still applies on top. |
| Simulated devices only | `lib/config.js` `assertSimulatedDevice` | Every DevEUI the harness registers, actuates or answers for must start with `70B3D57ED00`. Commanding anything else throws. |
| Read-only SQL | `lib/ssh.js` `Ssh.sql` | Opens the database `file:...?mode=ro` with `sqlite3 -readonly` and refuses any statement matching INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/REPLACE/VACUUM/ATTACH. The harness can never reseed or repair `farming.db`. |
| No cloud link changes | case `C1` | Observes the outbox only. It never links, unlinks, cuts the network, or pushes this gateway's data anywhere. |

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
| `Z1` | Zones and devices: empty install, create, assign, move, unassign, delete, and the SQLite state behind each. |
| `Z2` | Invalid input, duplicate zone names, operations on missing dependencies, deleting a zone that still owns a device, deleting things that were never there. |
| `V1` | Valve actuation on a simulated valve: byte-exact downlinks, actuation expectations, actuator log, repeated clicks, cancel, and every rejected input. |
| `V2` | The on-valve plan ACK ledger under a refused, duplicated, stray, dropped and very late ACK, plus reconciliation to `OBSERVED_RUNNING`. |
| `S1` | Schedule CRUD, invalid durations and times, overlap detection, midnight, day rollover, one-time opens, and deletes. |
| `D1` | Ingest with no data / one sample / many samples, out-of-range clamping, NULL-not-zero for absent fields, stale and future-dated samples, and the cumulative-rain delta state machine. |
| `ST1` | Settings read/write/validate/persist/restore, per-zone timezone, feature flags, system stats. |
| `C1` | Local writes and outbox growth while the cloud is unreachable, observed through `/api/sync/state` and `sync_outbox`. Deliberately partial — see below. |
| `U1` | Browser smoke: real login form, screenshots at 1366×768 and 390×844 for every route, and a French hardcoded-English scan. |

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

- **`C1` is partial.** Link/unlink, network cut and restore, duplicate delivery,
  conflicting cloud edits and expiry of queued cloud commands all need a
  controlled cloud endpoint and an account link this harness must not create.
- **Long timers are out of reach.** `STALE_OPEN_OBSERVED` needs 1800 s past
  `expected_close_at` (`RECONCILIATION_GRACE_SEC`), the schedule tick is a
  06:00 cron, and outbox retention runs at 02:00. These need a soak run or an
  injectable clock.
- **No DST or clock manipulation.** The `S2` matrix row (DST gap/repeat, missed
  start and restart recovery) needs control of the gateway clock.
- **No multi-tenant coverage.** Silvan runs `OSI_SCOPED_ACCESS=0`, so the
  role/permission and tenant-isolation rows (`A2`, `A3`) cannot be exercised
  here; the scoped code paths in the flows are all behind that flag.
- **The `U1` English scan is a heuristic.** It reliably catches i18next error
  text, raw keys, and English that has a French translation. The
  never-translated-at-all check is a marker-word heuristic and can produce a
  false positive on a proper noun or a device name.
- **Assertions are pinned to a deployed payload, not to the repo.** Every run
  records the gateway's `flows.json` path and md5 in `summary.json`. A gateway
  running an older payload than `origin/main` will disagree with the repo, and
  that is a finding, not a harness failure.
