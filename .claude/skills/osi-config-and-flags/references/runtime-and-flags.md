# Runtime knobs and feature flags

Part of the osi-config-and-flags skill; read SKILL.md first.

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

`deploy.sh` tunables (`PAYLOAD_KEEP_N`, `MIGRATE_BACKUP_DIR`, canary-gate
values) are documented once, in `osi-live-ops-runbook` under "What deploy.sh
actually does end-to-end". Read them there; two descriptions of one script
drift.

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

## 9. Version / identity / broker facts

| Fact | Value | Where set / verified |
|---|---|---|
| `firmware_version` default | `0.8.1` (as of 2026-10-10 — bump on release, re-check before quoting) | `96_osi_server_config`, also the inline fallback default in `node-red.init` (`fw_version=$(uci -q get ... || echo "0.8.1")`) |
| MQTT telemetry broker URL | `${OSI_CLOUD_BROKER_URL}` in the flows.json `mqtt-broker` node "OSI Cloud Broker" (`broker` field; Node-RED 3.1 substitutes a whole-string `${VAR}` at start). `node-red.init` `resolve_cloud_broker_url()` sets it from `osi-server.cloud.mqtt_broker_url`, else `wss://<server_host>/mqtt`, else the default `wss://server.opensmartirrigation.org/mqtt`; port field `443`. Logged at start as `cloud MQTT broker <url> source=<mqtt_broker_url\|server_host\|default>`. A change needs a Node-RED restart. Its `credentials.user`/`credentials.password` fields use `${DEVICE_EUI}` / `${DEVICE_MQTT_PASSWORD}`, resolved from the process env `node-red.init` sets. | `node-red.init`, `scripts/test-node-red-init-cloud-broker.sh`, `scripts/verify-communication-contract.js` |
| `osi-server.cloud.server_host` | the cloud host recorded/restored during account-link (`OSI_SERVER_HOST` env var); second source of the broker URL above when `mqtt_broker_url` is empty | flows.json account-link finalize/rollback/restore nodes |
| MQTT client ID | `device_${DEVICE_EUI}` template in the broker node config, but also force-rewritten literally into `/srv/node-red/flows.json` on every Node-RED start by an inline Node snippet in `node-red.init` (because Node-RED does not expand `${VAR}` in `clientid ` reliably across versions in this deployment's testing) | `node-red.init`, `start_service()` |

**Re-verify:**
```
grep -n '"broker": "${OSI_CLOUD_BROKER_URL}"' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
grep -n 'resolve_cloud_broker_url\|OSI_DEFAULT_CLOUD_BROKER_URL=' feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init
grep -n "fw_version=" feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init
grep -n "firmware_version" conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config
```

---
