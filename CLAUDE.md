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
2. [docs/engineering-playbook.md](docs/engineering-playbook.md) — how to work: the plan→review→execute→verify loop, thinking tools, hard-won failure modes
3. [README.md](README.md) — user-facing setup and deployment
4. `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` — Node-RED backend logic
5. `scripts/verify-sync-flow.js` — sync implementation reference
6. `web/react-gui/src/` — dashboard source
7. [docs/build/building-firmware.md](docs/build/building-firmware.md) — firmware build (only if rebuilding the OS)
8. [docs/versioning-workflow.md](docs/versioning-workflow.md) — release checklist

## Session Closeout

When the user says `finish the session`, follow [AGENTS.md](AGENTS.md) session closeout and run `scripts/session-closeout.sh`.
