# OSI OS — Open Smart Irrigation OS

OSI OS is an open-source, offline-first smart irrigation platform for smallholder farmers. It runs on a Raspberry Pi 5 LoRaWAN gateway and combines soil sensing, automated irrigation scheduling, and a farmer-facing web dashboard — all without requiring internet connectivity.

Built on [ChirpStack Gateway OS](https://www.chirpstack.io/docs/chirpstack-gateway-os/) (OpenWrt 24.10), version **0.4.0 Alpha**.

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

| Device | Target config |
|---|---|
| Raspberry Pi 5 (**primary**) | `full_raspberrypi_bcm27xx_bcm2712` |
| Raspberry Pi 2/3 | `full_raspberrypi_bcm27xx_bcm2709` |
| Raspberry Pi 1/Zero | `full_raspberrypi_bcm27xx_bcm2708` |
| RAK7391 | `rak_rak7391` |
| RAK7289v2 | `rak_rak7289v2` |
| RAK7268v2 | `rak_rak7268v2` |
| RAK7267 | `rak_rak7267` |
| Seeed SenseCAP M2 | `seeed_sensecap_m2` |
| Dragino LPS8N | `dragino_lps8n` |

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

## Device Setup (Manual)

1. Flash the [ChirpStack Gateway OS](https://www.chirpstack.io/docs/chirpstack-gateway-os/) base image for Raspberry Pi to a microSD card.
2. Boot the Pi and connect via SSH (`root@192.168.0.1` on the default AP).
3. Copy the database:
   ```bash
   scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
       root@<pi-ip>:/data/db/farming.db
   ```
4. Copy the Node-RED flows:
   ```bash
   scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
       root@<pi-ip>:/srv/node-red/flows.json
   ```
5. Build and deploy the React GUI:
   ```bash
   cd web/react-gui && npm run build
   scp -r build/* root@<pi-ip>:/usr/lib/node-red/gui/
   ```
6. Restart Node-RED:
   ```bash
   ssh root@<pi-ip> '/etc/init.d/node-red restart'
   ```
7. Open `http://<pi-ip>:1880/gui` in a browser.

---

## Default Wi-Fi Access Point (first boot)

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
