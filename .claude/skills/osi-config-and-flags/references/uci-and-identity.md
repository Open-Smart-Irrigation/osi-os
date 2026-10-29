# UCI and gateway identity

Part of the osi-config-and-flags skill; read SKILL.md first.

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
| `firmware_version` | Reported firmware version string | `0.8.1` (2026-10-10; bump on release) | `node-red.init` exports as `FIRMWARE_VERSION` |
| `server_host` | Cloud host set during account-link (host of the cloud's MQTT broker URL, else of the server URL); the MQTT broker URL falls back to `wss://<server_host>/mqtt` when `mqtt_broker_url` is empty (section 9) | empty | flows.json account-link nodes write it; `node-red.init` exports as `OSI_SERVER_HOST` and derives `OSI_CLOUD_BROKER_URL` from it |
| `mqtt_password` | **Secret.** Cloud MQTT password used to build `/srv/node-red/flows_cred.json` | empty | Written by flows.json account-link finalize node; read by `node-red.init`. **Never print, log, or commit this value.** |
| `allow_private_target` | Dev/test escape hatch allowing `http://` or private/loopback hosts for account-link `serverUrl` | `0` | flows.json `allowPrivateTargets()` reads via UCI directly (`uci -q get osi-server.cloud.allow_private_target`), also via `ALLOW_PRIVATE_SERVER_URLS`/`ALLOW_INSECURE_SERVER_URL` env fallback |
| `journal_photo_cache_bytes` | Maximum retained Journal V2 photo-cache bytes | `4294967296` | `node-red.init` validates a positive safe integer and exports `JOURNAL_PHOTO_CACHE_BYTES`; the Journal V2 worker enforces it |
| `journal_min_free_bytes` | Filesystem free-space reserve for the Journal V2 media root | `4294967296` | `node-red.init` validates a positive safe integer and exports `JOURNAL_MIN_FREE_BYTES`; the Journal V2 worker enforces it |
| `journal_media_root` | Exact canonical directory for generated Journal V2 media files | `/data/journal-media` | `node-red.init` rejects non-canonical or symlink roots and exports `JOURNAL_MEDIA_ROOT`; the Journal V2 worker accepts UUID-generated paths only |
| `openagri_weather_url` | OpenAgri weather integration endpoint | empty | `node-red.init` exports as `OPENAGRI_WEATHER_URL` |
| `openagri_weather_username` | OpenAgri basic-auth username | empty | exports as `OPENAGRI_WEATHER_USERNAME` |
| `openagri_weather_password` | **Secret.** OpenAgri basic-auth password | empty | exports as `OPENAGRI_WEATHER_PASSWORD` |
| `openagri_weather_bearer_token` | **Secret.** OpenAgri bearer token (alternative to basic auth) | empty | exports as `OPENAGRI_WEATHER_BEARER_TOKEN` |
| `openagri_weather_radius_km` | Weather station search radius | `10` | exports as `OPENAGRI_WEATHER_RADIUS_KM` |
| `openagri_weather_current_cache_minutes` | Current-conditions cache TTL | `30` | exports as `OPENAGRI_WEATHER_CURRENT_CACHE_MINUTES` |
| `openagri_weather_forecast_cache_minutes` | Forecast cache TTL | `120` | exports as `OPENAGRI_WEATHER_FORECAST_CACHE_MINUTES` |
| `weather_provider_default` | Observation weather provider for zones whose `weather_source` is `auto`: `open_meteo` or `meteoswiss` (customer branches for Swiss farms set `meteoswiss`); the forecast always comes from Open-Meteo. Already-provisioned gateways do not re-run uci-defaults; a customer gateway is switched with `uci set osi-server.cloud.weather_provider_default=meteoswiss && uci commit osi-server && /etc/init.d/node-red restart`. Switching creates a new location key, so the store backfills again under the new provider | `open_meteo` | `node-red.init` validates and exports as `OSI_WEATHER_PROVIDER_DEFAULT`; read by flows.json node `weather-provider-fn` |
| `chirpstack_app_sensors`, `chirpstack_app_actuators`, `chirpstack_app_field_tester` | Per-installation ChirpStack application UUIDs | unset until bootstrap runs | Written by `chirpstack-bootstrap.js`; see section 3 |
| `chirpstack_profile_kiwi`, `chirpstack_profile_strega`, `chirpstack_profile_lsn50`, `chirpstack_profile_clover`, `chirpstack_profile_rak10701`, `chirpstack_profile_s2120`, `chirpstack_profile_lorain`, `chirpstack_profile_uc512`, `chirpstack_profile_strega_gen2` | Per-installation ChirpStack device-profile UUIDs | unset until bootstrap runs | Written by `chirpstack-bootstrap.js`; see section 3 |

Note: `chirpstack-bootstrap.js` writes all three `CHIRPSTACK_PROFILE_LORAIN`,
`CHIRPSTACK_PROFILE_UC512` and `CHIRPSTACK_PROFILE_STREGA_GEN2` to both the env file and UCI — `chirpstack_profile_lorain`
and `chirpstack_profile_uc512` **are** mapped in `toUciCloudKey()`
(`scripts/chirpstack-bootstrap.js`, mirrored at
`conf/.../usr/share/node-red/chirpstack-bootstrap.js`). The real asymmetry is
in `node-red.init`: its `resolve_chirpstack_value` list and `procd_set_param
env` block omit `CHIRPSTACK_PROFILE_LORAIN`, `CHIRPSTACK_PROFILE_UC512` and `CHIRPSTACK_PROFILE_STREGA_GEN2`,
so at Node-RED runtime the LoRain, Milesight UC512 and STREGA Gen2 profile IDs arrive only
via `settings.js`'s `.chirpstack.env` compat loader, not via the UCI→procd
path the other profiles use (as of 2026-09-14; recheck with `grep -c STREGA_GEN2 feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`, expected 0 until plumbed).

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

`osi-identityd` adds the live convergence path. The daemon is supervised by
`/etc/init.d/osi-identityd`, sources the same helper, and owns two tmpfs files:

- `/var/run/osi-gateway-identity.json` is the observed cache. Its phases are
  `provisional`, `active`, `healing`, and `restart_pending`.
- `/var/run/osi-identity-restart.json` is the transition sentinel. During
  `healing`, it has no deadline. During `restart_pending`, it carries the
  absolute restart time and private target fields.

Node-RED does not switch to the cache EUI while it is running. Identity-coupled
link and sync builders keep the boot `DEVICE_EUI*` environment and fail closed
when the restart sentinel exists, including malformed or unreadable sentinel
files. After a non-provisional transition, `osi-identityd` runs the shared
`resolve -> repair -> resolve -> persist` heal path, validates durable UCI
readback, waits 60 seconds, restarts Node-RED, and removes the sentinel only
after the restart command exits zero. `/api/system/stats` exposes only
`restartPending.restartAt` and `restartPending.reason`; target EUIs remain
private.

`osi-bootstrap`, account link, and account unlink publish restart requests in
`/var/run/osi-node-red-restart-requests/`. The daemon is the only consumer and
the only writer of the live cache and restart sentinel. A gateway identity
transition keeps priority over generic restart requests and always receives a
fresh 60-second warning from the detection time.

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

**Consequence:** whether a `DEVICE_EUI` change breaks linked offline login
depends on the verifier version stored for the account (`AGENTS.md`
"Security"). Version 2 and higher hash `password::installation_uuid` and do
not depend on the EUI. Version 1 (also missing, NULL or 0) hashes
`password::<EUI>`, where the gateway takes the first valid value of
`LINK_GATEWAY_DEVICE_EUI`, the sync token's `gateway_device_eui` and
`DEVICE_EUI`; it breaks when that EUI no longer matches the one the cloud
hashed. The cloud computes verifiers; account link and cloud auth sync are
the supported writers, and there is no manual verifier repair. Subject
failures, the fallback hash and a read-only inspection are in
`osi-live-ops-runbook` (`references/repair.md`, "Changing DEVICE_EUI and
linked offline login").

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
history strands under the old value, and a version-1 offline login breaks if
the linked EUI later changes (see the Consequence note above).

**Re-verify:**
```
grep -n "gateway_identity_resolve\|gateway_identity_read_linked\|gateway_identity_read_persisted" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh
grep -n "request-restart\|restart_pending\|osi-node-red-restart-requests" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh
grep -n "protectedKeys" feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js
grep -n "envVars.DEVICE_EUI" scripts/verify-sync-flow.js
```

---
