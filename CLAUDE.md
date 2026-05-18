# CLAUDE.md

> **Start here:** [AGENTS.md](AGENTS.md) — operational source of truth (architecture, sync, file locations, conventions).

This file exists so Claude Code picks up project context automatically. If you're a human, [README.md](README.md) is the better entry point.

---

## What this project is

**OSI OS** — OpenWrt 24.10-based embedded Linux firmware for Raspberry Pi 5 LoRaWAN gateways. Offline-first smart irrigation: ChirpStack (LoRaWAN NS) + Node-RED (backend logic) + SQLite (state) + React (dashboard).

Primary target: Raspberry Pi 5 (`full_raspberrypi_bcm27xx_bcm2712`).

---

## Recommended reading order

1. [AGENTS.md](AGENTS.md) — architecture, sync model, file locations, conventions
2. [README.md](README.md) — user-facing setup and deployment
3. `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` — Node-RED backend logic
4. `scripts/verify-sync-flow.js` — sync implementation reference
5. `web/react-gui/src/` — dashboard source
6. [docs/build/building-firmware.md](docs/build/building-firmware.md) — firmware build (only if rebuilding the OS)
7. [docs/versioning-workflow.md](docs/versioning-workflow.md) — release checklist
