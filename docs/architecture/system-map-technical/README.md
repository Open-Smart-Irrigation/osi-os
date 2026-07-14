# OSI system map — technical edition

Structured architecture reference for both OSI repositories: module inventory,
responsibilities, and file locations. This edition targets engineers. A
plain-language edition with identical chapter structure exists at
[../system-map/](../system-map/README.md).

Snapshot: **2026-07-12**, `osi-os` `main` and `osi-server` `main`. Measured
counts (nodes, tables, endpoints) drift with normal development; verify against
the working tree before citing them in plans. Operational authority remains
[AGENTS.md](../../../AGENTS.md) (edge) and `osi-server/AGENTS.md` (cloud); if
this map and AGENTS.md disagree, AGENTS.md wins.

## System summary

OSI OS is an OpenWrt 24.10 firmware for Raspberry Pi 5 LoRaWAN gateways running
offline-first irrigation control: ChirpStack as the network server, Node-RED as
the application backend (REST API, scheduler, sync), SQLite as canonical state,
and a React dashboard served locally. osi-server is the optional cloud: Spring
Boot with PostgreSQL 16 mirrors linked gateways, and adds analytics that need
external data or more compute. The edge is authoritative for farm state.
Cloud-originated edits queue as pending commands until the edge applies and
acknowledges them. REST (edge-initiated polling) is the only cloud-to-edge
path; MQTT carries edge-to-cloud telemetry only.

## Chapters

| Chapter | Scope |
|---|---|
| [01 — System overview](01-big-picture.md) | Topology, data paths, architectural invariants, refactor-program outcome. |
| [02 — Edge gateway](02-edge-gateway.md) | Firmware composition, service inventory, first-boot provisioning, identity, file layout. |
| [03 — Edge backend](03-edge-backend-flows.md) | flows.json: tab inventory, endpoint and timer surfaces, function-node conventions, helper modules. |
| [04 — Edge database](04-edge-database.md) | SQLite schema by domain, trigger architecture, migration runner semantics, parity verifiers. |
| [05 — Edge GUI](05-dashboard-gui.md) | React app structure, data layer, feature flags, i18n, build and test harness. |
| [06 — Sync protocol](06-edge-cloud-sync.md) | Contract package, transports, outbox/inbox lifecycles, history shadow sync, command ACK semantics. |
| [07 — Cloud server](07-cloud-server.md) | Spring package inventory, Flyway conventions, frontend, Terra, prediction service, deployment. |
| [08 — Operations](08-operations.md) | Image build, deploy pipeline, verifier taxonomy, CI gating, feedback-to-PR pipeline. |

## Location conventions

- Bare paths are relative to the `osi-os` repo root.
- Paths marked **(osi-server)** are relative to the `osi-server` repo root.
- flows.json has no stable line numbers. Flow logic is addressed as
  `tab → node name`; resolve either in the Node-RED editor or by searching
  `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` for the
  node's `name` field.

Out of scope: `web/marketing/`, research material under `analysis/` (both
repos), the `docs/superpowers/` plan and spec archive, and anything secret.
Host addresses and credentials stay in private runbooks.
