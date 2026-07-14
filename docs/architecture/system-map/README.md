# OSI System Map

A structured, plain-language description of the whole OSI system: both repositories,
every major module, what it does, and where it lives. Written at the end of the
2026 refactor program so that anyone (technical or not) can find their way around.

> A **technical edition** of this map, same chapter structure in an engineering
> register, lives at [../system-map-technical/](../system-map-technical/README.md).
>
> Snapshot date: **2026-07-12**, taken from `osi-os` `main` and `osi-server` `main`.
> Counts (node counts, table counts, endpoint lists) drift as features land;
> treat them as orientation, not as contracts. The operational source of truth
> remains [AGENTS.md](../../../AGENTS.md) (edge) and `osi-server/AGENTS.md` (cloud).

## What the system is, in one paragraph

OSI builds **offline-first smart irrigation for farms**. A Raspberry Pi 5 "gateway"
box installed at the farm receives radio signals (LoRaWAN) from battery-powered
field sensors (soil-moisture probes, weather stations, rain gauges, tree-growth
sensors), stores everything in its own local database, decides when to irrigate,
and commands radio-controlled water valves. Everything works with **no internet
at all**. When internet *is* available, the gateway mirrors its data to a cloud
server that adds heavier analytics (weather forecasts, water-balance predictions,
tree-stress models), remote dashboards, and fleet management. The gateway is
always the boss for its own farm: the cloud only *suggests*; the gateway *applies*.

## The two repositories

| Repository | Role | One-line description |
|---|---|---|
| **osi-os** (this repo) | The edge / gateway | Buildable firmware image for the Raspberry Pi gateway: operating system, radio server, local backend, local database, farmer dashboard. **Canonical for farm state.** |
| **osi-server** (`../osi-server` on the dev machine) | The cloud | Spring Boot + PostgreSQL web platform that mirrors gateways, serves the cloud dashboard, and runs cloud-only analytics (predictions, tree-stress models, weather). |

## Chapters

| Chapter | Read it to understand |
|---|---|
| [01 — Big picture](01-big-picture.md) | The product story, the actors, the end-to-end data paths, and the design principles that everything else follows. |
| [02 — Edge gateway (the Pi)](02-edge-gateway.md) | What software actually runs on the gateway box, how a fresh device boots and provisions itself, and where every file lives. |
| [03 — Edge backend (Node-RED flows)](03-edge-backend-flows.md) | The gateway's "brain": every flow tab, its major function nodes, all HTTP endpoints and timers, and the shared helper modules. |
| [04 — Edge database](04-edge-database.md) | Every table in the gateway's SQLite database, grouped by purpose, plus the migration system that changes schema safely. |
| [05 — Farmer dashboard (React GUI)](05-dashboard-gui.md) | The web app farmers use on the gateway: pages, device cards, history/analysis views, and how it is built and served. |
| [06 — Edge ↔ cloud sync](06-edge-cloud-sync.md) | How gateway and cloud stay in agreement: outbox/inbox, pending commands, history shadow sync, MQTT telemetry, account linking. |
| [07 — Cloud server (osi-server)](07-cloud-server.md) | Every backend package, the cloud frontend, Terra Intelligence, the Python prediction service, and the Docker deployment stack. |
| [08 — Operations & tooling](08-operations.md) | Building firmware, deploying to live gateways, the verification-script safety net, CI, and the feedback→PR pipeline. |

Deliberately out of scope: the marketing website (`web/marketing/`), one-off
research material (`analysis/` in both repos, `docs/superpowers/` plan/spec
archives), and anything secret (credentials, host addresses; those live only
in private runbooks).

## How locations are written

- Paths like `scripts/verify-sync-flow.js` are relative to the **osi-os** repo root.
- Paths marked **(osi-server)** are relative to the **osi-server** repo root,
  e.g. **(osi-server)** `backend/src/main/java/org/osi/server/sync/`.
- Logic inside the Node-RED flow file has no useful line numbers (it is one big
  generated JSON file). Those locations are written as
  **flows.json → tab "OSI-Server Cloud Integration" → node "Flush Sync Outbox"**;
  open the file `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
  or the Node-RED editor on a gateway and search for the node name.

## Ten-second glossary

| Term | Meaning here |
|---|---|
| **Edge** | The Raspberry Pi gateway at the farm. |
| **Cloud** | The osi-server web platform (`osicloud.ch` in production). |
| **LoRaWAN** | Long-range, low-power radio protocol the field sensors use. |
| **ChirpStack** | Open-source LoRaWAN network server: the "radio receptionist" on the Pi. |
| **Node-RED** | Visual programming runtime; its flow file *is* the edge backend. |
| **Uplink / downlink** | Radio message from a sensor to the gateway / from the gateway to a device. |
| **SWT** | Soil water tension in kPa: how hard roots must pull to get water; higher = drier. |
| **Outbox / inbox** | Mail-tray tables used for reliable sync: outgoing changes wait in the outbox, incoming commands are deduplicated through the inbox. |
| **Pending command** | A cloud-originated change waiting for the gateway to accept and apply it. |
| **Migration** | A numbered, checksummed SQL file that changes the database schema in a controlled way. |
