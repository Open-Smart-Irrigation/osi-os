---
name: osi-config-and-flags
description: "Use when looking up or changing gateway configuration: UCI osi-server.cloud.*, DEVICE_EUI resolution, CHIRPSTACK_* env vars, retention overrides, settings.js options, deploy.sh tunables, /api/system/features flags, or adding a config knob."
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
marked otherwise. The live identity daemon notes in section 2 were verified on
2026-07-15. Re-verification commands are in the last section.

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
| Journal V2 media cache | UCI `journal_photo_cache_bytes`, `journal_min_free_bytes`, `journal_media_root` | `node-red.init` validates and exports `JOURNAL_*`; the independent Journal V2 worker reads them | `uci -q get osi-server.cloud.journal_media_root` |
| `OSI_HEALTH_RAW_RETENTION_DAYS` / `OSI_HEALTH_HOURLY_RETENTION_DAYS` | Inline default in the flows.json rollup function (`14`, `365`) | Same function, via Node-RED `env.get(...)` | no live override mechanism is wired — see below |
| Node-RED `settings.js` | `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` | Node-RED runtime on boot | `cat /srv/node-red/settings.js` |
| `deploy.sh` | Repo root | Run manually on-Pi — see `osi-live-ops-runbook` deploy runbook (download-then-run, not `curl \| sh`) | n/a (script itself) |
| `/api/system/features` | flows.json, node `history-api-router-fn` | `web/react-gui/src/history/useFeatureFlags.ts` | `curl http://127.0.0.1:1880/api/system/features` |

---

## Common mistakes

- Assuming the MQTT telemetry broker is fixed. It follows
  `mqtt_broker_url`, then `server_host`, then the default (section 9), and
  only after a Node-RED restart.
- Assuming `.chirpstack.env` is dead weight that's safe to delete blindly.
  It's still the fallback path for every `CHIRPSTACK_*` key that isn't yet in
  UCI (fresh bootstrap before first successful UCI write, or the
  `CHIRPSTACK_PROFILE_LORAIN`/`CHIRPSTACK_PROFILE_UC512` pair that
  `node-red.init` never exports) — removing it is correct only for identity
  keys during a repair, not universally. `osi-live-ops-runbook` has the actual
  repair sequence.
- Believing `OSI_HEALTH_*_RETENTION_DAYS` can be tuned per-gateway today. It
  cannot without a flows.json edit — there is no UCI/env plumbing yet
  (section 4).
- Editing `settings.js` or `node-red.init` under
  `conf/full_raspberrypi_bcm27xx_bcm2712/` — they don't live there. Both are
  under `feeds/chirpstack-openwrt-feed/apps/node-red/files/` and are shared
  (not profile-specific), unlike flows.json which is genuinely duplicated
  per hardware profile.
- Pointing `CHIRPSTACK_PROFILE_CLOVER` at the RAK10701 field-tester profile.
  That profile has no codec, so every Clover uplink arrives without a decoded
  `object` and Process Data drops it. Older gateways carry this alias until
  `--repair-soil-profiles` runs (deploy.sh does it).
- Assuming deploy.sh enforces ChirpStack profile completeness. It doesn't;
  that's a manual operator check (`diagnose-pi-communication.sh`).
- Assuming deploy.sh never restarts services. Since the payload-flip redesign
  it stops/starts Node-RED around the schema-migration step and restarts it
  again after the payload flip (see section 6).

## References

- `references/uci-and-identity.md`: Read for every `osi-server.cloud.*` key, and for `DEVICE_EUI` resolution, the identity daemon, and the `.chirpstack.env` trap. Sections: "1. UCI `osi-server.cloud.*`"; "2. DEVICE_EUI resolution — the identity precedence chain".
- `references/chirpstack-profiles.md`: Read for the `CHIRPSTACK_*` env vars, per-installation UUIDs, and the profile repairs `deploy.sh` runs. Sections: "3. `CHIRPSTACK_PROFILE_*` / `CHIRPSTACK_APP_*`".
- `references/runtime-and-flags.md`: Read for retention overrides, `settings.js`, `deploy.sh` knobs, `/api/system/features`, and version, identity and broker facts. Sections: "4. Gateway-health retention: `OSI_HEALTH_RAW_RETENTION_DAYS` / `OSI_HEALTH_HOURLY_RETENTION_DAYS`"; "5. Node-RED `settings.js`"; "6. `deploy.sh` knobs"; "7. Feature flags: `/api/system/features`"; "9. Version / identity / broker facts".
- `references/adding-a-flag.md`: Read when adding a config knob, or to re-verify this skill against the repo. Sections: "8. Checklist: adding a new config flag"; "Provenance and maintenance".
