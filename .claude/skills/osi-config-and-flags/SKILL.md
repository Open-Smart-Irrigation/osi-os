---
name: osi-config-and-flags
description: Use when looking up or changing OSI OS gateway configuration or feature-flag surface - UCI osi-server.cloud.* settings, DEVICE_EUI / gateway identity resolution and precedence, CHIRPSTACK_PROFILE_*/CHIRPSTACK_APP_* env vars, OSI_HEALTH_*_RETENTION_DAYS overrides, Node-RED settings.js load-bearing options, deploy.sh tunables, /api/system/features flags, or adding a brand-new config knob. Not for symptom triage, live-Pi repair execution, flows.json editing mechanics, or schema migrations.
---

# OSI Config and Flags

## Overview

An OSI OS gateway (Raspberry Pi 5, OpenWrt 24.10 + ChirpStack + Node-RED +
SQLite + React) has configuration spread across five layers: UCI — OpenWrt's
Unified Configuration Interface, the `/etc/config/*` files plus `uci` CLI that
form the durable per-installation config store — under `osi-server.cloud.*`, a
legacy per-key env-file fallback
(`/srv/node-red/.chirpstack.env`), Node-RED process environment (set by the
init script), Node-RED's own `settings.js`, and hardcoded constants inside
`flows.json`. This skill is the map of that surface: what exists, where it is
defined, who reads/writes it, and how to inspect or safely extend it.

All facts below were verified against the repository on 2026-07-06 unless
marked otherwise. Re-verification commands are in the last section.

## When to use

- You need to know what a UCI key under `osi-server.cloud` does, its default,
  or who reads it.
- Someone asks "why does the gateway think its EUI is X" or "why did the
  gateway's identity change after a repair."
- You are adding a new `CHIRPSTACK_PROFILE_*` / `CHIRPSTACK_APP_*` variable for
  a new device type, or need to know why profile UUIDs differ per Pi.
- You need to know whether gateway-health retention days can be overridden.
- You are touching `settings.js`, `deploy.sh`, or `/api/system/features` and
  need to know what is load-bearing versus decorative.
- You are adding a brand-new config flag and need the full checklist.

## When NOT to use

- Diagnosing a symptom ("gateway won't connect," "MQTT down") — use
  `osi-debugging-playbook` for triage, then come back here once you know which
  knob is implicated.
- Executing a live-Pi repair (identity repair, `.chirpstack.env` cleanup,
  restoring service) — the step-by-step runbook lives in
  `osi-live-ops-runbook`. This skill tells you what the trap is; that skill
  tells you how to fix it live.
- Editing `flows.json` node-by-node (adding nodes, wiring, function bodies) —
  use `osi-flows-json-editing` for mechanics. This skill only documents the
  env/UCI-facing surface flows.json reads.
- Schema/migration work (`database/migrations`, `farming.db` DDL) — use
  `osi-schema-change-control`.
- Sensor/domain semantics (what SWT, dendro ratio, or LoRain rainfall mean) —
  use `osi-agronomy-sensors-reference`.

## Master table: config surfaces

| Surface | Defined | Consumed | Live inspect |
|---|---|---|---|
| UCI `osi-server.cloud.*` | `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config` | `node-red.init` (procd env), `chirpstack-bootstrap.js`, flows.json (account-link nodes) | `uci show osi-server` |
| Gateway identity (`DEVICE_EUI*`) | `usr/libexec/osi-gateway-identity.sh` (resolution logic) + UCI persistence | `node-red.init` → Node-RED process env → flows.json | `/usr/libexec/osi-gateway-identity.sh resolve` |
| `.chirpstack.env` (legacy fallback) | Written by `chirpstack-bootstrap.js` | Read per-key by `node-red.init` (`load_chirpstack_env_value`) and `settings.js` compat loader | `cat /srv/node-red/.chirpstack.env` (never commit/paste secrets) |
| `CHIRPSTACK_PROFILE_*` / `CHIRPSTACK_APP_*` | `chirpstack-bootstrap.js` (creates ChirpStack objects, writes UCI + env file) | `node-red.init` exports as process env; flows.json reads via `env.get(...)` | `scripts/diagnose-pi-communication.sh` |
| `OSI_HEALTH_RAW_RETENTION_DAYS` / `OSI_HEALTH_HOURLY_RETENTION_DAYS` | Inline default in the flows.json rollup function (`14`, `365`) | Same function, via Node-RED `env.get(...)` | no live override mechanism is wired — see below |
| Node-RED `settings.js` | `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` | Node-RED runtime on boot | `cat /srv/node-red/settings.js` |
| `deploy.sh` | Repo root | Run manually on-Pi — see `osi-live-ops-runbook` deploy runbook (download-then-run, not `curl \| sh`) | n/a (script itself) |
| `/api/system/features` | flows.json, node `history-api-router-fn` | `web/react-gui/src/history/useFeatureFlags.ts` | `curl http://127.0.0.1:1880/api/system/features` |

---

## 1. UCI `osi-server.cloud.*`

Defined in full in
`conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config`
(verified byte-identical to the bcm2709 profile's copy of the same file,
2026-07-06). This uci-defaults script runs once on first boot and seeds every
key with a default, then commits.

| Key | Purpose | Default | Read/write by |
|---|---|---|---|
| `enabled` | Master on/off switch for cloud integration (not read by any grepped consumer as of 2026-07-06 — treat as reserved/unused; do not assume it gates anything) | `0` | uci-defaults only |
| `device_eui` | Persisted canonical gateway EUI | resolved at boot by the identity helper, else empty | Written by `osi-gateway-identity.sh` (`gateway_identity_persist`); read by `node-red.init`, `chirpstack-bootstrap.js` |
| `device_eui_source` | Where the EUI came from (`concentratord-runtime`, `concentratord-uci-<chipset>`, `concentratord-toml-<chipset>`, `linked`, `persisted`, `mac:<iface>`) | resolved at boot | Same as above |
| `device_eui_confidence` | `authoritative` \| `persisted` \| `provisional` | resolved at boot | Same as above; gates whether account-linking is allowed (provisional blocks linking — see section 2) |
| `device_eui_last_verified_at` | ISO-8601 UTC timestamp of last resolution | resolved at boot | Same as above |
| `link_gateway_device_eui` | Server-linked override EUI; normally written by account-link finalize after a successful link, but an operator can preset it to bypass the provisional-identity block on concentrator-less gateways — see the override note in section 2 | empty | Written by flows.json account-link finalize node; read by `gateway_identity_read_linked` (highest-priority persisted source, see section 2) |
| `device_type` | Reported device type string | `GATEWAY` | `node-red.init` exports as `DEVICE_TYPE` |
| `firmware_version` | Reported firmware version string | `0.6.5` (2026-07-06; bump on release) | `node-red.init` exports as `FIRMWARE_VERSION` |
| `server_host` | Cloud host set during account-link (used to persist/restore MQTT/server host across link/unlink), separate from the hardcoded telemetry broker URL (section 9) | empty | flows.json account-link nodes write it; `node-red.init` exports as `OSI_SERVER_HOST` |
| `mqtt_password` | **Secret.** Cloud MQTT password used to build `/srv/node-red/flows_cred.json` | empty | Written by flows.json account-link finalize node; read by `node-red.init`. **Never print, log, or commit this value.** |
| `allow_private_target` | Dev/test escape hatch allowing `http://` or private/loopback hosts for account-link `serverUrl` | `0` | flows.json `allowPrivateTargets()` reads via UCI directly (`uci -q get osi-server.cloud.allow_private_target`), also via `ALLOW_PRIVATE_SERVER_URLS`/`ALLOW_INSECURE_SERVER_URL` env fallback |
| `openagri_weather_url` | OpenAgri weather integration endpoint | empty | `node-red.init` exports as `OPENAGRI_WEATHER_URL` |
| `openagri_weather_username` | OpenAgri basic-auth username | empty | exports as `OPENAGRI_WEATHER_USERNAME` |
| `openagri_weather_password` | **Secret.** OpenAgri basic-auth password | empty | exports as `OPENAGRI_WEATHER_PASSWORD` |
| `openagri_weather_bearer_token` | **Secret.** OpenAgri bearer token (alternative to basic auth) | empty | exports as `OPENAGRI_WEATHER_BEARER_TOKEN` |
| `openagri_weather_radius_km` | Weather station search radius | `10` | exports as `OPENAGRI_WEATHER_RADIUS_KM` |
| `openagri_weather_current_cache_minutes` | Current-conditions cache TTL | `30` | exports as `OPENAGRI_WEATHER_CURRENT_CACHE_MINUTES` |
| `openagri_weather_forecast_cache_minutes` | Forecast cache TTL | `120` | exports as `OPENAGRI_WEATHER_FORECAST_CACHE_MINUTES` |
| `chirpstack_app_sensors`, `chirpstack_app_actuators`, `chirpstack_app_field_tester` | Per-installation ChirpStack application UUIDs | unset until bootstrap runs | Written by `chirpstack-bootstrap.js`; see section 3 |
| `chirpstack_profile_kiwi`, `chirpstack_profile_strega`, `chirpstack_profile_lsn50`, `chirpstack_profile_clover`, `chirpstack_profile_rak10701`, `chirpstack_profile_s2120` | Per-installation ChirpStack device-profile UUIDs | unset until bootstrap runs | Written by `chirpstack-bootstrap.js`; see section 3 |

Note: `chirpstack-bootstrap.js` writes `CHIRPSTACK_PROFILE_LORAIN` to both the
env file and UCI — `chirpstack_profile_lorain` **is** mapped in
`toUciCloudKey()` (`scripts/chirpstack-bootstrap.js:299`, mirrored at
`conf/.../usr/share/node-red/chirpstack-bootstrap.js`). The real asymmetry is
in `node-red.init`: its `resolve_chirpstack_value` list and `procd_set_param
env` block omit `CHIRPSTACK_PROFILE_LORAIN`, so at Node-RED runtime the LoRain
profile ID arrives only via `settings.js`'s `.chirpstack.env` compat loader,
not via the UCI→procd path the other profiles use (as of 2026-07-06).

**Live inspection:** `uci show osi-server` on the Pi. This prints
`mqtt_password`, `openagri_weather_password`, and
`openagri_weather_bearer_token` in **plaintext** — treat that output as
sensitive and never paste it into a chat, issue, or log you don't control.

**Re-verify this table:**
```
grep -n "uci -q batch\|^set " conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config
```

---

## 2. DEVICE_EUI resolution — the identity precedence chain

Gateway identity resolution is centralized in
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh`
(same file, byte-identical, under the bcm2709 profile). It defines shell
functions sourced by three call sites: `96_osi_server_config` (uci-defaults,
first boot), `node-red.init` (every Node-RED start), and
`chirpstack-bootstrap.js` (via `osi-gateway-identity.sh resolve`, shelled out).

`gateway_identity_resolve()` tries sources in this exact order, first match
wins:

1. **`concentratord-runtime`** — `sh /usr/bin/gateway-id.sh` (live
   concentratord query). Always `authoritative` confidence — this source is
   explicitly exempt from the MAC-coincidence demotion described below.
2. **`concentratord-uci-<chipset>`** — UCI `chirpstack-concentratord.@<chipset>[0].gateway_id`
   for whichever chipset (`sx1301`/`sx1302`) is active per
   `chirpstack-concentratord.@global[0].chipset`.
3. **`concentratord-toml-<chipset>`** — same, read from the concentratord TOML
   config file instead of UCI.
4. **`linked`** — UCI `osi-server.cloud.link_gateway_device_eui` (set when an
   account-link flow completes). Confidence is always `persisted`.
5. **`persisted`** — UCI `osi-server.cloud.device_eui`, but only if its stored
   confidence is empty, `authoritative`, or `persisted` (a stored
   `provisional` value is deliberately skipped here and re-resolved).
6. **`mac:<iface>`** — derived from `eth0`/`br-lan`/`wlan0` MAC address
   (EUI-48 → EUI-64 via `FFFE` insertion). Always `provisional` confidence —
   this is a last-resort guess, not a real gateway ID.

The MAC-coincidence demotion applies only to steps 2–3: if a UCI/TOML-sourced
EUI coincidentally equals what the local MAC-derived fallback would produce
(meaning it can't be proven to be a real LoRa concentrator ID), that source is
demoted to `provisional` and skipped, falling through to the next source. Step
1 is unconditionally `authoritative`; steps 4–5 carry fixed `persisted`
confidence and never apply the MAC check.

`node-red.init` calls the sequence `resolve → repair_concentratord_config →
resolve → persist` on every Node-RED start: the first resolve finds the
current best answer, `gateway_identity_repair_concentratord_config` writes
that EUI back into the active chipset's UCI `gateway_id` (and clears the
inactive chipset's sibling section) if confidence is not provisional, the
second resolve re-reads post-repair state, and `persist` commits the final
answer to `osi-server.cloud.device_eui*`.

**THE TRAP.** `/srv/node-red/.chirpstack.env` is a legacy compatibility file.
`settings.js` explicitly protects identity keys from it:

```js
const protectedKeys = new Set([
    'DEVICE_EUI', 'DEVICE_EUI_SOURCE', 'DEVICE_EUI_CONFIDENCE',
    'DEVICE_EUI_LAST_VERIFIED_AT', 'LINK_GATEWAY_DEVICE_EUI'
]);
```
(`feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`) — so
`settings.js`'s own env-file loader will never let a stale `.chirpstack.env`
override an already-set `DEVICE_EUI`. **However**, `node-red.init` sets
`DEVICE_EUI` via `procd_set_param env` directly from the UCI/helper
resolution — it does not consult `.chirpstack.env` for identity at all. The
real risk is elsewhere: other tooling or an operator manually sourcing
`.chirpstack.env`, or `chirpstack-bootstrap.js` re-run with a stale
`ENV_FILE`, can reintroduce a stale `DEVICE_EUI` value into that file, and any
future code path that trusts `.chirpstack.env` wholesale (rather than the
per-key protected-list loader) would pick it up. `chirpstack-bootstrap.js`
itself is explicitly guarded against writing a stale identity:
`scripts/verify-sync-flow.js` asserts the bootstrap script does **not**
contain `envVars.DEVICE_EUI = gatewayEui` (it only ever writes
`CHIRPSTACK_*` keys to the env file, never identity keys). Treat any
`.chirpstack.env` that still contains `DEVICE_EUI*` lines as a stale
artifact to remove during an identity repair.

Canonical EUI is always **UPPERCASE** 16 hex chars (`normalize_gateway_eui` /
`normalizeGatewayEui` uppercase and reject the all-`01` invalid pattern). The
full identity-repair procedure (removing the stale file, restarting services,
confirming `uci show osi-server` matches concentratord) lives in
`osi-live-ops-runbook` — this section only documents the mechanism and the
trap.

**Consequence:** changing `DEVICE_EUI` invalidates the linked-login offline
verifier, which is `bcrypt(password::DEVICE_EUI)` — any EUI change forces a
verifier regeneration. The repair sequence for this is also in
`osi-live-ops-runbook`.

**Account-link gate:** flows.json's account-link node explicitly refuses to
link while `gatewayDeviceEuiConfidence === 'provisional'` (HTTP 503, "Gateway
identity is not ready yet"), so a MAC-fallback-only gateway cannot complete
cloud linking until concentratord reports a real ID.

**Provisional-identity link override (test/demo path only):** an operator can
bypass the gate above by presetting the linked-source UCI key before running
account-link — `uci set osi-server.cloud.link_gateway_device_eui=<EUI>; uci
commit osi-server`. `gateway_identity_read_linked()` (precedence step 4) always
reports `persisted` confidence regardless of how the EUI was chosen, so the
next identity resolve clears the provisional check in `al-link-validate`. This
exists for concentrator-less gateways used in test and demo setups; the
production path is a configured concentrator, which resolves an
`authoritative` EUI at step 1 and needs no override. The risk: linking under a
hand-picked EUI on a gateway that later gets a real concentrator (or a
different MAC-derived fallback) leaves the cloud holding a stale EUI. Linked
history strands under the old value, and offline login breaks because the
verifier is `bcrypt(password::DEVICE_EUI)` (see the Consequence note above).

**Re-verify:**
```
grep -n "gateway_identity_resolve\|gateway_identity_read_linked\|gateway_identity_read_persisted" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh
grep -n "protectedKeys" feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js
grep -n "envVars.DEVICE_EUI" scripts/verify-sync-flow.js
```

---

## 3. `CHIRPSTACK_PROFILE_*` / `CHIRPSTACK_APP_*`

`chirpstack-bootstrap.js` (repo copies: `scripts/chirpstack-bootstrap.js` and
mirrored under both hardware profiles'
`files/usr/share/node-red/chirpstack-bootstrap.js`) runs once per gateway (via
`osi-bootstrap` init script, `START=99`, after ChirpStack's gRPC API answers)
and creates-or-reuses:

- 3 ChirpStack applications: **OSI Sensors**, **OSI Actuators**, **OSI Field Tester**
- 6 device profiles: **KIWI Sensor**, **STREGA Valve**, **Dragino LSN50**,
  **RAK Field Tester**, **SenseCAP S2120**, **Aqua-Scope LoRain**
- 1 API key (`osi-nodered`)

Verified full set of env vars it writes (`writeEnvFile` / `envVars` object in
`chirpstack-bootstrap.js`):

| Env var | Maps to | UCI key (via `toUciCloudKey`) |
|---|---|---|
| `CHIRPSTACK_API_URL` | ChirpStack gRPC endpoint | none (env-file only) |
| `CHIRPSTACK_API_KEY` | **Secret.** osi-nodered API key | none (env-file only) |
| `CHIRPSTACK_APP_SENSORS` | OSI Sensors app UUID | `chirpstack_app_sensors` |
| `CHIRPSTACK_APP_ACTUATORS` | OSI Actuators app UUID | `chirpstack_app_actuators` |
| `CHIRPSTACK_APP_FIELD_TESTER` | OSI Field Tester app UUID | `chirpstack_app_field_tester` |
| `CHIRPSTACK_PROFILE_KIWI` | KIWI Sensor profile UUID | `chirpstack_profile_kiwi` |
| `CHIRPSTACK_PROFILE_STREGA` | STREGA Valve profile UUID | `chirpstack_profile_strega` |
| `CHIRPSTACK_PROFILE_LSN50` | Dragino LSN50 profile UUID | `chirpstack_profile_lsn50` |
| `CHIRPSTACK_PROFILE_CLOVER` | **Alias** — intentionally set to the same UUID as `CHIRPSTACK_PROFILE_RAK10701` (compatibility alias for the RAK10701 field tester profile, not a separate profile) | `chirpstack_profile_clover` |
| `CHIRPSTACK_PROFILE_RAK10701` | RAK Field Tester profile UUID | `chirpstack_profile_rak10701` |
| `CHIRPSTACK_PROFILE_S2120` | SenseCAP S2120 profile UUID | `chirpstack_profile_s2120` |
| `CHIRPSTACK_PROFILE_LORAIN` | Aqua-Scope LoRain profile UUID | `chirpstack_profile_lorain` — mapped to UCI by `chirpstack-bootstrap.js`, but **not exported by `node-red.init`** (runtime sees it via the env-file path only; see section 1 note) |

All `CHIRPSTACK_APP_*`/`CHIRPSTACK_PROFILE_*` values are validated as
ChirpStack UUIDs (`assertValidUciValue`, regex
`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`) before being
written to UCI, and a readback check (`uci -q get` immediately after `uci
set`) confirms the commit landed.

**Why UUIDs are per-installation:** each gateway's `chirpstack-bootstrap.js`
run creates its own tenant/apps/profiles against its own local ChirpStack
instance — there is no shared/global UUID. Hardcoding a UUID observed on one
gateway into flows.json or a script will silently break every other gateway
(confirmed pattern the codebase actively guards against — see
`extract_from_legacy_flow`'s comment in `scripts/prepare-pi-communication-config.sh`
about not trusting a bare `FIXED_APP_ID` fallback).

**Who consumes them:** `node-red.init` resolves each one **except
`CHIRPSTACK_PROFILE_LORAIN`** with `resolve_chirpstack_value` (UCI first, then
per-key `.chirpstack.env` fallback via `load_chirpstack_env_value`, logging the
source via `logger -t node-red.init`) and exports the result as a Node-RED
process env var; LORAIN reaches the runtime only through `settings.js`'s
`.chirpstack.env` compat loader (see section 1 note, as of 2026-07-06).
flows.json function nodes then read them with `env.get('CHIRPSTACK_PROFILE_S2120')`
etc. to discriminate device type on uplink. The actual MQTT topic
subscription rule and the `deviceProfileName`-fallback discrimination pattern
inside flows.json are mechanics of `osi-flows-json-editing` — not duplicated
here.

**Deploy-time post-check:** `deploy.sh` does **not** assert
`CHIRPSTACK_PROFILE_RAK10701` or `CHIRPSTACK_PROFILE_S2120` anywhere (verified
by reading the full 687-line file: it fetches, seeds the DB conditionally, and
repairs schema — it has no ChirpStack-profile assertions at all). The actual
check for "is RAK10701/S2120 provisioned" is `scripts/diagnose-pi-communication.sh`
(prints `uci.chirpstack_profile_rak10701` / `env.CHIRPSTACK_PROFILE_S2120`) and
`scripts/prepare-pi-communication-config.sh` (repairs missing UCI values from
the env-file/legacy-flow fallback, `--dry-run` by default). Both are operator
tools run manually on the Pi, not something `deploy.sh` gates automatically —
if you were told a "deploy post-check" enforces this, that check is a manual
operator step (`osi-live-ops-runbook`), not code in `deploy.sh`.

The preflight `deploy.sh` *does* run
(`run_communication_preflight` → `scripts/verify-communication-contract.js`)
only checks that `node-red.init` **exports** `CHIRPSTACK_PROFILE_RAK10701` as
a shell variable — it does not check the UUID is valid or present on the
target Pi.

**Re-verify:**
```
grep -n "CFG = {" -A 25 scripts/chirpstack-bootstrap.js
grep -n "toUciCloudKey\|mapping = {" -A 15 scripts/chirpstack-bootstrap.js
grep -n "CHIRPSTACK_PROFILE_RAK10701\|CHIRPSTACK_PROFILE_S2120" deploy.sh   # expect: no matches
grep -n "chirpstack_profile" scripts/diagnose-pi-communication.sh
```

---

## 4. Gateway-health retention: `OSI_HEALTH_RAW_RETENTION_DAYS` / `OSI_HEALTH_HOURLY_RETENTION_DAYS`

Consumed inline inside the `Gateway Health Rollup` function node in
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (runs daily
at 02:10; ordered migration `database/migrations/ordered/0002__gateway_health.sql`,
osi-os #68):

```js
var rawDays = parseInt(String(env.get('OSI_HEALTH_RAW_RETENTION_DAYS') || '14').trim(), 10);
if (!isFinite(rawDays) || rawDays < 1) { rawDays = 14; }
var hourlyDays = parseInt(String(env.get('OSI_HEALTH_HOURLY_RETENTION_DAYS') || '365').trim(), 10);
if (!isFinite(hourlyDays) || hourlyDays < 1) { hourlyDays = 365; }
```

Defaults: **14 days** raw (`gateway_health_samples`, 1 row/60s heartbeat),
**365 days** hourly rollup (`gateway_health_hourly`, min/mean/max per closed
UTC hour). Documented in
`docs/operations/edge-history-retention.md`.

**Honest status on override plumbing:** `env.get(...)` inside a Node-RED
function node resolves against that node's/flow's configured Environment
Variables, falling back to the Node-RED process environment
(`process.env`) if none is set at the node/flow level. Node-RED's `env.get`
does **not** read UCI. As of 2026-07-06, `node-red.init`'s `procd_set_param
env` list (the process-env injection point — see section 1's table) does
**not** include `OSI_HEALTH_RAW_RETENTION_DAYS` or
`OSI_HEALTH_HOURLY_RETENTION_DAYS`, there is no `osi-server.cloud.*` UCI key
for either, and `docs/operations/edge-history-retention.md` documents the
variable names but not a concrete override mechanism. **Treat these as
currently unplumbed for live override** — changing them today requires
editing the literal `'14'`/`'365'` default-fallback string inside flows.json
(a flows.json edit, subject to `osi-flows-json-editing` + normal review), not
a runtime knob an operator can flip. If you need a live override, wiring
`procd_set_param env OSI_HEALTH_RAW_RETENTION_DAYS=...` in `node-red.init`
plus an `osi-server.cloud.*` UCI default is the natural place to add it (see
section 8 checklist) — but that plumbing does not exist yet.

This data is local-only (not cloud-synced in v1); this table only summarizes
retention, it is not the home for gateway-health schema or column semantics
(see `docs/operations/edge-history-retention.md` for that).

**Re-verify:**
```
grep -n "OSI_HEALTH_RAW_RETENTION_DAYS\|OSI_HEALTH_HOURLY_RETENTION_DAYS" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
grep -n "OSI_HEALTH" feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init   # expect: no matches (unplumbed)
grep -n "OSI_HEALTH" docs/operations/edge-history-retention.md
```

---

## 5. Node-RED `settings.js`

Repo source:
`feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` → deployed to
`/srv/node-red/settings.js` by `deploy.sh`. There is exactly one **deployed**
`settings.js` in the repo (shared across both hardware profiles — it is not
duplicated per profile the way flows.json is; a separate, unrelated
`settings.js` exists under `feeds/chirpstack-openwrt-feed/apps/node-red-node-sqlite/files/`
but is not the one deploy.sh ships).

Load-bearing settings, verified by reading the file:

| Setting | Value | Why it matters |
|---|---|---|
| `functionExternalModules: true` | enabled | Required for function nodes to `require()` external/local npm libraries (the `osi-*-helper` packages, `bcryptjs`, etc.). Without this, most of flows.json's function nodes fail at deploy/runtime. |
| `httpStatic` / `httpStaticRoot` | `/usr/lib/node-red/gui` served at `/gui` | This is how the React dashboard is served — not a separate web server. |
| `flowFile` | `"flows.json"` | Relative to `userDir` |
| `userDir` | `/srv/node-red` | Where Node-RED looks for `flows.json`, `flows_cred.json`, `package.json`, helper packages |
| `uiPort` | `process.env.PORT \|\| 1880` | Standard Node-RED port; `PORT` env override exists but nothing in the repo sets `PORT` today |
| `functionGlobalContext` | exposes `os`, `fs`, `cp` (child_process) to every function node | flows.json function nodes rely on `global.get('fs')`/`global.get('cp')` — do not remove these without auditing every consumer |
| `exportGlobalContextKeys: false` | disabled | Keeps the global context out of the editor's context-data sidebar (cosmetic/security, not functional) |
| env-file compat loader (top of file, before `module.exports`) | loads `/srv/node-red/.chirpstack.env` into `process.env` for any key **not already set** and **not** in the identity `protectedKeys` set | This is the second-priority fallback in the precedence chain from section 2 — `node-red.init` (procd env) always wins over this loader for the keys it sets, and identity keys can never come from this loader at all |

There is no `credentialSecret` configured in this file — Node-RED will fall
back to its own auto-generated/stored secret behavior; this skill does not
document that mechanism further since no explicit value is set here to
verify.

**Companion fact (pointer only):** `/srv/node-red/package.json` (repo source
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`)
must declare `"osi-db-helper": "file:osi-db-helper"` (confirmed present,
alongside `osi-chameleon-helper`, `osi-chirpstack-helper`, `osi-cloud-http`,
`osi-dendro-helper`, `osi-history-helper`) or Node-RED refuses to load flows
that require it. The fix procedure for a live Pi missing this dependency is in
`osi-live-ops-runbook`.

**Re-verify:**
```
grep -n "functionExternalModules\|httpStatic\|protectedKeys" feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js
grep -n "osi-db-helper" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json
```

---

## 6. `deploy.sh` knobs

`deploy.sh` (repo root, 687 lines, verified 2026-07-06) runs **on the Pi**,
fetching artifacts over a tunnelled local HTTP server. Actual tunables and
decision points, read from the file (no invented ones):

| Knob | What it does |
|---|---|
| `$1` (positional arg, default `9876`) | HTTP port the deploy source server is tunnelled on (`PORT="${1:-9876}"`) |
| `/proc/device-tree/model` | Auto-detects Pi 5 vs Pi 4/400/3/2 vs Pi Zero/Model to pick the matching seed DB path (`detect_seed_db_rel`); unknown models fall back to the bcm2712 (Pi 5) seed as the canonical default |
| DB seeding gate | `seed_db_if_missing` only copies the bundled seed DB when `/data/db/farming.db` is **absent** *and* no `-wal`/`-shm`/`-journal` sidecar files exist; otherwise it refuses (exits 1) or skips. **Never** overwrite a live DB — full rule and recovery steps are in `osi-live-ops-runbook`. |
| Live schema repair functions | `ensure_dendro_schema`, `ensure_zone_irrigation_calibration_schema`, `ensure_analysis_views_schema`, `ensure_chameleon_schema`, `ensure_gateway_health_schema` — each is idempotent (checks `PRAGMA table_info` / catches `duplicate column name`) and runs unconditionally on every deploy if `farming.db` exists. `ensure_gateway_health_schema` specifically fetches `database/migrations/ordered/0002__gateway_health.sql` and refuses to apply it unless its first line is `-- risk: additive` — a hard-coded safety gate against ever running a non-additive migration through this path. |
| `run_communication_preflight` | Fetches `scripts/verify-communication-contract.js` plus copies of flows.json (all three hardware profiles), `node-red.init`, `settings.js`, `chirpstack-bootstrap.js`, `diagnose-pi-communication.sh` into a temp dir and runs the contract verifier against them **before** touching the live install. Aborts the whole deploy on failure. |
| `npm install --omit=dev --no-fund --no-audit` | Installs Node-RED runtime dependencies on-device from the fetched `package.json`/`package-lock.json`; failure aborts the deploy (last 80 log lines printed to stderr) |
| `fix_mosquitto_ownership` | Repairs file ownership/permissions on `mosquitto.passwd`/`.acl`/`/var/lib/mosquitto` if mosquitto is installed, using the UCI-configured mosquitto user if set |
| React GUI swap | Fetches `react_gui.tar.gz`, wipes `/usr/lib/node-red/gui/*` (including dotfiles), extracts fresh bundle |

**What it restarts:** nothing, automatically. `deploy.sh`'s final output
explicitly tells the operator to run `/etc/init.d/node-red restart`
manually — confirmed by reading the trailing `echo` block; there is no
`/etc/init.d/node-red restart` call anywhere in the script itself. ChirpStack
re-provisioning (`osi-bootstrap`, `START=99`) only happens automatically on
the next full boot, or can be triggered manually with
`node /usr/share/node-red/chirpstack-bootstrap.js` (per the script's own
closing instructions).

**Re-verify:**
```
grep -n "^[a-z_]*() {" deploy.sh
grep -n "restart" deploy.sh   # expect: only in the trailing echo instructions, not an executed command
```

---

## 7. Feature flags: `/api/system/features`

Served by the `history-api-router-fn` function node in flows.json (node id
`history-api-router-fn`, HTTP GET node `history-system-features-http`). The
handler is a hardcoded literal block, not read from UCI/env at all:

```js
if (requestMethod === 'GET' && requestPath === '/api/system/features') {
  return respond(200, {
    generatedAt: nowIso(),
    features: {
      historyUxEnabled: true,
      historyComparisonEnabled: false,
      historyWorkspacesEnabled: false,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false
    }
  });
}
```

Verified exact flag set and defaults, as shipped (2026-07-06):

| Flag | Shipped value | Meaning |
|---|---|---|
| `historyUxEnabled` | `true` | Master switch for the history dashboard UX |
| `historyComparisonEnabled` | `false` | Cross-period/zone comparison views |
| `historyWorkspacesEnabled` | `false` | Saved analysis workspaces |
| `historyAdvancedOverlaysEnabled` | `false` | Advanced chart overlays |
| `historyCloudAiEnabled` | `false` | Cloud-AI-assisted interpretation features |

**GUI consumption:** `web/react-gui/src/history/useFeatureFlags.ts` fetches
this endpoint via SWR and exposes `flags`, `historyEnabled` (`=
historyUxEnabled`), and `isUnavailable`. Also consumed by
`web/react-gui/src/services/api.ts` (`systemAPI.getFeatures`, type
`SystemFeatureFlags`) and rendered in `web/react-gui/src/pages/HistoryDashboard.tsx`.
The GUI's own `defaultHistoryFeatureFlags` constant defaults every flag to
`false` (used only while the fetch is loading/failed) — do not confuse that
client-side loading default with the server's actual shipped defaults above.

**How to toggle:** there is no runtime toggle. Changing a flag means editing
the literal object inside flows.json's `history-api-router-fn` node — a normal
code change subject to review, the `osi-flows-json-editing` mechanics, and the
bcm2709 profile-parity mirror requirement (section 8). There is no sanctioned
procedure for live-patching this block on a running Pi; if an emergency ever
forces it, coordinate with the operator, take a backup first, and re-deploy
properly through review afterward — it is never the path to ship a flag change.

**Re-verify:**
```
grep -n "historyUxEnabled\|historyComparisonEnabled\|historyWorkspacesEnabled\|historyAdvancedOverlaysEnabled\|historyCloudAiEnabled" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
grep -n "SystemFeatureFlags\|defaultHistoryFeatureFlags" web/react-gui/src/services/api.ts web/react-gui/src/history/useFeatureFlags.ts
```

---

## 8. Checklist: adding a new config flag

1. Decide the layer: durable per-installation identity/secret → UCI
   `osi-server.cloud.*` (add to `96_osi_server_config` with a safe default);
   ChirpStack-object-derived → follow the `chirpstack-bootstrap.js` pattern
   (env file + `toUciCloudKey` mapping); pure feature toggle with no
   per-install variance → flows.json constant (section 7 pattern).
2. If UCI: add the key with its default to
   `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config`
   inside the `uci -q batch` block.
3. Add the read path: `node-red.init`'s `start_service()` (export as
   `procd_set_param env`), and/or `chirpstack-bootstrap.js`'s `CFG` object if
   it's bootstrap-time-only.
4. If flows.json needs to read it, use `env.get('YOUR_KEY')` inside the
   relevant function node — follow `osi-flows-json-editing` for the mechanics
   of adding/wiring nodes.
5. **Mirror to bcm2709 byte-for-byte.** Any change under
   `conf/full_raspberrypi_bcm27xx_bcm2712/files/` (including
   `96_osi_server_config`, `osi-gateway-identity.sh`) must be propagated
   identically to `conf/full_raspberrypi_bcm27xx_bcm2709/files/` — the
   *contents* of `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`
   and `node-red.init` are shared (not per-profile), so those two files do not
   need mirroring, only the `conf/full_raspberrypi_bcm27xx_bcm{2712,2709}`
   tree does. `scripts/verify-profile-parity.js` (chained from
   `scripts/verify-sync-flow.js`) enforces this in CI — mechanics and how to
   run it are documented in `osi-flows-json-editing`.
6. Update this skill's tables (section 1–7) so the map stays accurate — one
   home per fact.
7. If the flag gates safety-relevant behavior (e.g. anything that could touch
   `farming.db` mutation risk, private-target allowance, or identity), add or
   extend a verifier/guard (`scripts/verify-communication-contract.js`,
   `scripts/verify-sync-flow.js`, or a new `scripts/verify-*.js`) rather than
   relying on manual review alone.
8. If the fact is durable repo-level knowledge (not a one-off), add a line to
   `AGENTS.md` — do not duplicate the detail here and there; cross-reference.

---

## 9. Version / identity / broker facts

| Fact | Value | Where set / verified |
|---|---|---|
| `firmware_version` default | `0.6.5` (as of 2026-07-06 — bump on release, re-check before quoting) | `96_osi_server_config`, also the inline fallback default in `node-red.init` (`fw_version=$(uci -q get ... || echo "0.6.5")`) |
| MQTT telemetry broker URL | `wss://server.opensmartirrigation.org/mqtt`, port `443` | **Hardcoded** in the flows.json `mqtt-broker` node named "OSI Cloud Broker" (`broker` field literal) — this is a compile-time constant, not read from `server_host`/UCI/env at all. Its `credentials.user`/`credentials.password` fields use Node-RED's `${DEVICE_EUI}` / `${DEVICE_MQTT_PASSWORD}` template-expansion syntax, resolved from the process env `node-red.init` sets. |
| `osi-server.cloud.server_host` | separate concern from the broker URL above — it is the cloud host recorded/restored during account-link (`OSI_SERVER_HOST` env var), used for REST sync target bookkeeping, not for the MQTT connection itself | flows.json account-link finalize/rollback/restore nodes |
| MQTT client ID | `device_${DEVICE_EUI}` template in the broker node config, but also force-rewritten literally into `/srv/node-red/flows.json` on every Node-RED start by an inline Node snippet in `node-red.init` (because Node-RED does not expand `${VAR}` in `clientid ` reliably across versions in this deployment's testing) | `node-red.init`, `start_service()` |

**Re-verify:**
```
grep -n '"broker": "wss://' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
grep -n "fw_version=" feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init
grep -n "firmware_version" conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config
```

---

## Common mistakes

- Assuming `OSI_SERVER_HOST` / `server_host` controls the MQTT telemetry
  broker. It does not — that URL is hardcoded in flows.json (section 9).
- Assuming `.chirpstack.env` is dead weight that's safe to delete blindly.
  It's still the fallback path for every `CHIRPSTACK_*` key that isn't yet in
  UCI (fresh bootstrap before first successful UCI write, or a key like
  `CHIRPSTACK_PROFILE_LORAIN` that has no UCI mapping at all) — removing it
  is correct only for identity keys during a repair, not universally.
  `osi-live-ops-runbook` has the actual repair sequence.
- Believing `OSI_HEALTH_*_RETENTION_DAYS` can be tuned per-gateway today. It
  cannot without a flows.json edit — there is no UCI/env plumbing yet
  (section 4).
- Editing `settings.js` or `node-red.init` under
  `conf/full_raspberrypi_bcm27xx_bcm2712/` — they don't live there. Both are
  under `feeds/chirpstack-openwrt-feed/apps/node-red/files/` and are shared
  (not profile-specific), unlike flows.json which is genuinely duplicated
  per hardware profile.
- Treating `CHIRPSTACK_PROFILE_CLOVER` as a distinct profile from
  `CHIRPSTACK_PROFILE_RAK10701`. They are intentionally the same UUID
  (compatibility alias) — do not "fix" this by giving CLOVER its own profile
  without understanding why the alias exists.
- Assuming deploy.sh enforces ChirpStack profile completeness. It doesn't;
  that's a manual operator check (`diagnose-pi-communication.sh`).

## Provenance and maintenance

This skill embeds knowledge gathered by reading repository source directly
(uci-defaults, `osi-gateway-identity.sh`, `chirpstack-bootstrap.js`,
`node-red.init`, `settings.js`, `deploy.sh`, flows.json, `docs/operations/edge-history-retention.md`,
`AGENTS.md`) on 2026-07-06 against the `feat/agent-skill-library` worktree.
Nothing here should contradict `AGENTS.md`; if it does, `AGENTS.md` wins and
this file is stale — re-verify and fix.

Re-verify the whole surface in one pass:
```
grep -n "^set " conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config
diff conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-gateway-identity.sh
grep -n "CFG = {" -A 25 scripts/chirpstack-bootstrap.js
grep -n "OSI_HEALTH_.*_RETENTION_DAYS" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
grep -n "functionExternalModules\|protectedKeys" feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js
grep -n "^[a-z_]*() {" deploy.sh
grep -n "historyUxEnabled" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
node scripts/verify-communication-contract.js
node scripts/verify-profile-parity.js
```
