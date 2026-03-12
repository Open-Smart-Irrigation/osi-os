# OSI OS — Open Smart Irrigation OS

OSI OS is an open-source, offline-first smart irrigation platform for smallholder farmers. It runs on a Raspberry Pi 5 LoRaWAN gateway and combines soil sensing, automated irrigation scheduling, and a farmer-facing web dashboard — all without requiring internet connectivity.

Built on [ChirpStack Gateway OS](https://www.chirpstack.io/docs/chirpstack-gateway-os/) (OpenWrt 24.10).

---

## Features

- **LoRaWAN sensor integration** — TEKTELIC KIWI soil sensors (soil water tension, temperature, humidity, light)
- **Smart valve control** — Strega smart irrigation valves with OPEN/CLOSE commands
- **Automated irrigation scheduling** — threshold-based triggers on soil water tension (kPa)
- **Irrigation zones** — group devices into zones with per-zone schedules
- **Web dashboard** — React-based UI accessible on local Wi-Fi at `http://<device-ip>:1880/gui`
- **Multi-user support** — individual user accounts per device
- **Offline-first** — fully functional without internet; cloud sync optional
- **Sensor data export** — download historical readings as CSV or raw SQLite

---

## Architecture

```
Farmer's Browser  (http://<device-ip>:1880/gui)
        ↕ HTTP
Node-RED  (localhost:1880)
  ├── REST API   — /api/* and /auth/*
  ├── Scheduler  — SWT threshold evaluation, valve triggering
  └── MQTT       — ChirpStack sensor uplinks / valve downlinks
        ↕ SQLite  (/data/db/farming.db)
ChirpStack  (LoRaWAN network server, localhost:8080)
        ↕ LoRa radio
Field devices  (soil sensors, smart valves)
```

---

## Supported Hardware

| Device                       | Target config                      |
| ---------------------------- | ---------------------------------- |
| Raspberry Pi 5 (**primary**) | `full_raspberrypi_bcm27xx_bcm2712` |
| Raspberry Pi 2/3             | `full_raspberrypi_bcm27xx_bcm2709` |
| Raspberry Pi 1/Zero          | `full_raspberrypi_bcm27xx_bcm2708` |
| RAK7391                      | `rak_rak7391`                      |
| RAK7289v2                    | `rak_rak7289v2`                    |
| RAK7268v2                    | `rak_rak7268v2`                    |
| RAK7267                      | `rak_rak7267`                      |
| Seeed SenseCAP M2            | `seeed_sensecap_m2`                |
| Dragino LPS8N                | `dragino_lps8n`                    |

> Current active development targets only the Raspberry Pi 5 configuration.

---

## Repository Structure

```
osi-os/
├── web/react-gui/          # React frontend (TypeScript, Tailwind CSS, Vite)
├── conf/                   # Per-target OpenWrt configs, Node-RED flows, database
│   └── full_raspberrypi_bcm27xx_bcm2712/
│       └── files/usr/share/
│           ├── flows.json  # Node-RED backend logic
│           └── db/farming.db  # Pre-seeded SQLite database
├── feeds/                  # ChirpStack + Node-RED OpenWrt packages
│   └── chirpstack-openwrt-feed/
├── openwrt/                # OpenWrt 24.10 source (git submodule)
├── database/farming.db     # Source-of-truth database schema
├── Makefile                # Build system entry point
├── Jenkinsfile             # CI/CD pipeline
├── CLAUDE.md               # Developer and AI context (architecture details)
└── BUILD-Readme.md         # Detailed build instructions
```

---

## Quick Start — Development

### Prerequisites

- Node.js 20+ and npm
- A running Node-RED instance (local or on a Pi) with the flows loaded
- A copy of `farming.db` accessible at the path configured in Node-RED

### Run the React frontend locally

```bash
cd web/react-gui
npm install
npm run dev
```

The dev server runs on `http://localhost:3000/gui/` and proxies all API calls to `http://localhost:1880`.

To point at a remote Pi instead:

```bash
VITE_NODERED_URL=http://<pi-ip>:1880 npm run dev
```

### Build and deploy the React frontend

```bash
cd web/react-gui
npm run build
# Deploy to a running Pi:
scp -r build/* root@<pi-ip>:/usr/lib/node-red/gui/
```

### Update Node-RED flows on a running Pi

```bash
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
    root@<pi-ip>:/srv/node-red/flows.json
ssh root@<pi-ip> '/etc/init.d/node-red restart'
```

---

## Building the Firmware

See [BUILD-Readme.md](BUILD-Readme.md) for full firmware build instructions.

**Requirements:** Docker, 20 GB free disk space, 8 GB RAM.

```bash
# One-time setup
make init

# Enter build environment
make devshell

# Switch to Raspberry Pi 5 target
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2712

# Build (1–3 hours)
make
```

Output images are in `openwrt/bin/targets/bcm27xx/bcm2712/`.

---

## Device Setup

> **Current approach:** The OSI OS firmware build is work-in-progress. The recommended way to get OSI OS running is to start from the latest [ChirpStack Gateway OS Full](https://www.chirpstack.io/docs/chirpstack-gateway-os/) image (which already includes Node-RED, Node.js, and npm) and deploy the OSI OS components on top via `scp` and `ssh`.

### Prerequisites

- This repository cloned on your dev machine
- Node.js 20+ and npm on your dev machine

### Step 1 — Flash ChirpStack Gateway OS

Flash the latest **ChirpStack Gateway OS Full** image for Raspberry Pi 5 to a microSD card and boot the Pi. Connect to it via SSH — either through the default Wi-Fi AP (`192.168.0.1`) or your local network IP.

Default SSH credentials: `root` / _(no password on first boot, or set during flash)_

### Step 2 — Build the React GUI

On your dev machine, from the repo root:

```bash
cd web/react-gui
npm install
npm run build
cd ../..
```

### Step 3 — Deploy via scp and SSH

```bash
PI=root@<pi-ip>

# Node-RED config (enables React GUI static serving)
scp feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js \
    $PI:/srv/node-red/settings.js

# Node-RED flows (backend logic)
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
    $PI:/srv/node-red/flows.json

# SQLite database
ssh $PI 'mkdir -p /data/db'
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
    $PI:/data/db/farming.db

# SQLite Node-RED module (not pre-installed on ChirpStack OS)
ssh $PI 'cd /srv/node-red && npm install node-red-node-sqlite --save'

# React GUI
ssh $PI 'mkdir -p /usr/lib/node-red/gui'
scp -r web/react-gui/build/* $PI:/usr/lib/node-red/gui/
```

### Step 4 — Restart Node-RED

```bash
ssh root@<pi-ip> '/etc/init.d/node-red restart'
```

### Step 5 — Open the UI

Navigate to `http://<pi-ip>:1880/gui` in a browser.

---

### Re-deploying after changes

```bash
PI=root@<pi-ip>

# Rebuild and redeploy React GUI (if frontend changed)
cd web/react-gui && npm run build && cd ../..
scp -r web/react-gui/build/* $PI:/usr/lib/node-red/gui/

# Redeploy flows (if flows.json changed)
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
    $PI:/srv/node-red/flows.json

ssh $PI '/etc/init.d/node-red restart'
```

---

### Alternative: deploy script (scripted/CI use)

If `scp` is not available (e.g. no interactive terminal), use the included `deploy.sh` via an SSH remote port forward. This tunnels a local HTTP server through the SSH connection so the Pi can pull all files over `localhost`:

```bash
# 1. Build and package the React GUI
cd web/react-gui && npm run build && cd ../..
tar czf react_gui.tar.gz -C web/react-gui/build .

# 2. Serve the repo locally
python3 -m http.server 9876

# 3. In a second terminal — deploy via tunnel
ssh -R 9876:localhost:9876 root@<pi-ip> 'curl -s http://localhost:9876/deploy.sh | sh'

# 4. Restart Node-RED
ssh root@<pi-ip> '/etc/init.d/node-red restart'
```

---

## Default Wi-Fi Access Point (first boot)

For Chirpstack Gateway OS setup (current approach):
| Setting | Value |
|---|---|
| SSID | `ChirpstackAP-<last 6 chars of MAC>` |
| Password | `ChirpStackAP` |
| Device IP | `192.168.0.1` |


For OSI OS firmware build:
| Setting | Value |
|---|---|
| SSID | `OSI-OS-<last 6 chars of MAC>` |
| Password | `opensmartirrigation` |
| Device IP | `192.168.0.1` |

---

## Links

- [ChirpStack documentation](https://www.chirpstack.io/)
- [ChirpStack Gateway OS](https://www.chirpstack.io/docs/chirpstack-gateway-os/)
- [chirpstack-openwrt-feed](https://github.com/chirpstack/chirpstack-openwrt-feed)
- [OpenWrt build system](https://openwrt.org/docs/guide-developer/toolchain/use-buildsystem)
