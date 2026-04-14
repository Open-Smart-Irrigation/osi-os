# CLAUDE.md — OSI OS Developer Context

> **IMPORTANT**: For AI agents (Claude Code, etc.), see **[AGENTS.md](/home/phil/Repos/osi-os/AGENTS.md)** first.
> AGENTS.md is the primary, maintained source of truth for implementation state and architectural decisions.
> CLAUDE.md provides broad repo/build context only.

---

## What This Project Is

**OSI OS** (Open Smart Irrigation OS) is a custom OpenWrt 24.10-based embedded Linux firmware for Raspberry Pi 5 LoRaWAN gateways. It enables offline-first smart irrigation management for smallholder farmers, combining:

- **ChirpStack** — LoRaWAN network server receiving sensor/valve data over LoRa radio
- **Node-RED** — backend logic engine, REST API, irrigation scheduler, sync orchestration
- **SQLite** — persistent local database
- **React** — farmer-facing web dashboard

Primary target: Raspberry Pi 5 (`full_raspberrypi_bcm27xx_bcm2712`)

---

## Repository Structure

```
osi-os/
├── AGENTS.md                           # Primary: implementation state & architecture
├── CLAUDE.md                           # This file: broad context only
├── README.md                           # User-facing documentation
├── BUILD-Readme.md                    # Firmware build instructions
├── Makefile                            # Build system entry point
├── Jenkinsfile                         # CI/CD pipeline
├── docker-compose.yml
├── Dockerfile-devel
├── feeds.conf.default
├── prepare_release.sh
│
├── web/react-gui/                     # React frontend (TypeScript, Tailwind, Vite)
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── FarmingDashboard.tsx
│   │   │   ├── Login.tsx
│   │   │   ├── Register.tsx
│   │   │   └── AccountLink.tsx
│   │   ├── components/farming/
│   │   ├── contexts/AuthContext.tsx
│   │   ├── services/api.ts
│   │   └── types/farming.ts
│   └── package.json
│
├── conf/
│   └── full_raspberrypi_bcm27xx_bcm2712/
│       ├── files/
│       │   ├── usr/share/flows.json    # Main Node-RED flow source
│       │   ├── usr/share/db/farming.db
│       │   └── etc/uci-defaults/
│       └── .config
│
├── feeds/chirpstack-openwrt-feed/     # OpenWrt packages
│   └── apps/node-red/
│
├── database/farming.db                # Source-of-truth schema
├── scripts/verify-sync-flow.js        # Sync implementation verifier
└── openwrt/                          # OpenWrt 24.10 (git submodule)
```

---

## Critical File Locations

### On the running Raspberry Pi

| What | Path |
|------|------|
| Node-RED flows | `/srv/node-red/flows.json` |
| SQLite database | `/data/db/farming.db` |
| React GUI | `/usr/lib/node-red/gui/` |
| Node-RED settings | `/srv/node-red/settings.js` |
| Node-RED init | `/etc/init.d/node-red` |
| Web UI | `http://<device-ip>:1880/gui` |

### In the repo

| What | Path |
|------|------|
| Node-RED flows | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` |
| Database | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db` |
| React source | `web/react-gui/src/` |
| Node-RED settings | `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` |

---

## Architecture Layers

```
Farmer Browser
    ↕ HTTP (/gui, React SPA)
Node-RED (localhost:1880)
    ├── REST API (/api/*, /auth/*)
    ├── Scheduler / irrigation logic
    ├── Dendrometer analytics
    ├── Sync (REST polling)
    ├── MQTT subscriber (ChirpStack sensor uplinks)
    └── MQTT publisher (telemetry → cloud)
    ↕ SQLite (/data/db/farming.db)
ChirpStack (LoRaWAN NS)
    ↕ MQTT
Packet forwarder / LoRa radio
    ↕
Field devices (KIWI, LSN50, STREGA valves)
```

---

## Development Workflow

### Edit and validate flows
```bash
# Edit the source
vim conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json

# Validate sync implementation
node scripts/verify-sync-flow.js
```

### Frontend
```bash
cd web/react-gui && npm install && npm run build
```

### Deploy to device
Do not overwrite `/data/db/farming.db` on a live or previously provisioned Pi. Treat the bundled database as a first-boot seed only; use `deploy.sh` or migrations for updates, and back up the live DB plus any `farming.db-wal`, `farming.db-shm`, or `farming.db-journal` sidecar files before manual repair.

```bash
# Deploy flows
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
    root@<pi-ip>:/srv/node-red/flows.json

# Deploy frontend
scp -r web/react-gui/build/* root@<pi-ip>:/usr/lib/node-red/gui/

# Restart
ssh root@<pi-ip> '/etc/init.d/node-red restart'
```

---

## Session Closeout

When the user says `finish the session`, treat that as a deliberate close-out request.

- Review `git status --short --branch` and report staged, unstaged, and untracked files.
- Remove only clearly temporary files created during the session. If a file might still be useful, list it as a cleanup candidate instead of deleting it.
- Review and update [AGENTS.md](/home/phil/Repos/osi-os/AGENTS.md) for durable repo-level context changes.
- Review and update `/home/phil/.claude/projects/-home-phil-Repos-osi-os/memory/MEMORY.md` for cross-session operational context changes.
- Run `scripts/session-closeout.sh` and report any warnings or follow-up needed.
- If neither context file changed, say explicitly that both were reviewed and left unchanged.
- End with remaining risks, skipped verification, and the next recommended step.

Keep closeout updates factual and avoid speculative rewrites.

---

## Adding A New Device Type

1. Update DB schema (`database/farming.db`)
2. Update TypeScript types (`web/react-gui/src/types/farming.ts`)
3. Add Node-RED ingest flow in `flows.json`
4. Add catalog / merge logic
5. Add React card/component
6. Render in dashboard
7. Update bundled DB copies

Also consider sync metadata requirements and ChirpStack app/profile mapping.

---

## Security Notes

- Local auth tokens: HMAC-signed
- Local passwords: bcrypt-hashed
- `/download/database`: gated
- Linked account login: gateway-specific offline verifier (not cloud password hash)

---

## Session Closeout

When the user says `finish the session`, follow the 9-step convention documented in [AGENTS.md § Session Closeout](/home/phil/Repos/osi-os/AGENTS.md). Run `scripts/session-closeout.sh` as part of that process and report any warnings.

---

## Recommended Reading Order

1. **[AGENTS.md](/home/phil/Repos/osi-os/AGENTS.md)** — Implementation state & architecture (start here)
2. `flows.json` — Node-RED backend logic
3. `scripts/verify-sync-flow.js` — Sync implementation
4. Frontend pages/components
5. **This file** (CLAUDE.md) — Only if you need build/runtime context
6. `README.md` — User-facing documentation
7. `BUILD-Readme.md` — Firmware build instructions
