# OSI OS — Open Smart Irrigation OS

**v0.6.0 Alpha**

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
- **OSI Cloud integration** — remote monitoring and gateway control via OSI Server; fan speed control and reboot from anywhere
- **Dragino LSN50V2 support** — external temperature (DS18B20), ADC, and dendrometer (stem growth) sensor node
- **SenseCAP S2120 weather station** — 8-in-1 weather station (wind speed/direction, rain, pressure, UV, temperature, humidity); multi-zone assignment; history monitoring
- **Soil moisture probe depth metadata** — configurable depth labels per KIWI probe channel
- **Raspberry Pi system monitoring** — CPU temperature, memory usage, CPU load, and fan speed visible in the web dashboard

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
Field devices  (KIWI soil sensors, Strega valves, Dragino LSN50V2)

        ↕ MQTT over WebSocket (wss, port 443)
OSI Server  (optional cloud — remote monitoring & control)
  └── Web dashboard — multi-device overview, fan control, reboot
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

## Supported Field Devices

| Device type | Description |
| --------------------------------- | ------------------------------------------------------------------- |
| **KIWI_SENSOR** | Soil water tension (kPa), soil moisture |
| **DRAGINO_LSN50** | Multi-mode: temperature probe, ADC (dendrometer potentiometer), rain gauge, flow meter |
| **STREGA_VALVE** | Motorized or standard irrigation valve (OPEN/CLOSE) |
| **SENSECAP_S2120** | Weather station (wind, rain, UV, barometric pressure) |
| **TEKTELIC_CLOVER** | Volumetric water content (%), soil moisture |

---

## Repository Structure

```
osi-os/
├── web/react-gui/          # React frontend (TypeScript, Tailwind CSS, Vite)
├── conf/                   # Per-target OpenWrt configs, Node-RED flows, seed database
│   └── full_raspberrypi_bcm27xx_bcm2712/
│       └── files/usr/share/
│           ├── flows.json  # Node-RED backend logic
│           └── db/farming.db  # Seed SQLite database for first boot only
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

Two ways to get OSI OS running on a Raspberry Pi 5:

| | Path A — Pre-built image | Path B — ChirpStack Gateway OS + deploy |
|---|---|---|
| **When to use** | Fastest start; no build tools needed | Latest code from this repo; or no release available for your target |
| **What you flash** | OSI OS `.img.gz` from the [Releases page](https://github.com/Open-Smart-Irrigation/osi-os/releases) | ChirpStack Gateway OS Full |
| **After flash** | Open the UI — done | Run `deploy.sh`, then `chirpstack-bootstrap.js` |

---

### Path A — Flash the OSI OS image

1. Download the latest `osi-os-<version>-bcm2712.img.gz` from the [Releases page](https://github.com/Open-Smart-Irrigation/osi-os/releases).
2. Flash it to a microSD card (e.g. with [Raspberry Pi Imager](https://www.raspberrypi.com/software/) or `dd`).
3. Boot the Pi — OSI OS starts automatically.
4. Connect to the Wi-Fi AP `OSI-OS-<mac>` (password `opensmartirrigation`) or find the device on your local network.
5. Navigate to `http://<device-ip>:1880/gui`.

No further setup required. See [Step 4 — Install Tailscale](#step-4--install-tailscale-remote-access) if you want remote access.

---

### Path B — ChirpStack Gateway OS + deploy script

> Use this path when no pre-built release is available, or when you want to deploy the latest code from this repo.

#### Prerequisites

- This repository cloned on your dev machine
- Node.js 20+ and npm on your dev machine

### Step 1 — Flash ChirpStack Gateway OS

Flash the latest **ChirpStack Gateway OS Full** image for Raspberry Pi 5 to a microSD card and boot the Pi. Connect to it via SSH — either through the default Wi-Fi AP (`192.168.0.1`) or your local network IP.

Default SSH credentials: `root` / _(no password on first boot, or set during flash)_

### Step 2 — Deploy OSI OS components

The `deploy.sh` script uses an SSH reverse tunnel to pull all files from your dev machine — no manual `scp` needed:

```bash
# 1. Build and package the React GUI
cd web/react-gui && npm install && npm run build && cd ../..
tar czf react_gui.tar.gz -C web/react-gui/build .

# 2. Serve the repo from your dev machine
python3 -m http.server 9876

# 3. In a second terminal - deploy via tunnel (runs on the Pi, pulls from your machine)
ssh -R 9876:localhost:9876 root@<pi-ip> 'curl -fsS http://localhost:9876/deploy.sh | sh'

# 4. Restart Node-RED
ssh root@<pi-ip> '/etc/init.d/node-red restart'
```

The script deploys: `settings.js`, `flows.json`, Node-RED packages and local helpers (`osi-chirpstack-helper`, `osi-db-helper`) with `npm install` on-device, `chirpstack-bootstrap.js`, the SenseCAP S2120 codec, and the React GUI bundle.

Database safety: `deploy.sh` must never overwrite `/data/db/farming.db`. It seeds the bundled `farming.db` only when the target file is missing, and it exits instead of seeding if orphaned SQLite WAL/SHM/journal sidecar files are present. On already-provisioned or field devices, the live DB is preserved.

<details>
<summary>Alternative: manual file-by-file deployment (if deploy.sh is not available)</summary>

```bash
PI=root@<pi-ip>
/
scp feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js $PI:/srv/node-red/settings.js
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json $PI:/srv/node-red/flows.json
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db $PI:/tmp/osi-os-seed-farming.db
ssh $PI 'mkdir -p /data/db && if [ ! -e /data/db/farming.db ]; then mv /tmp/osi-os-seed-farming.db /data/db/farming.db; else rm -f /tmp/osi-os-seed-farming.db; echo "preserved existing /data/db/farming.db"; fi'
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json $PI:/srv/node-red/package.json
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json $PI:/srv/node-red/package-lock.json
ssh $PI 'mkdir -p /srv/node-red/osi-chirpstack-helper'
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/package.json \
    $PI:/srv/node-red/osi-chirpstack-helper/package.json
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js \
    $PI:/srv/node-red/osi-chirpstack-helper/index.js
ssh $PI 'mkdir -p /srv/node-red/osi-db-helper'
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/package.json \
    $PI:/srv/node-red/osi-db-helper/package.json
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js \
    $PI:/srv/node-red/osi-db-helper/index.js
scp scripts/chirpstack-bootstrap.js $PI:/srv/node-red/chirpstack-bootstrap.js
ssh $PI 'mkdir -p /srv/node-red/codecs'
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/sensecap_s2120_decoder.js \
    $PI:/srv/node-red/codecs/sensecap_s2120_decoder.js
ssh $PI 'cd /srv/node-red && npm install --omit=dev --no-fund --no-audit'
ssh $PI 'mkdir -p /usr/lib/node-red/gui'
scp -r web/react-gui/build/* $PI:/usr/lib/node-red/gui/
```

</details>

### Step 3 — Provision ChirpStack device profiles

Run the bootstrap script once to create the ChirpStack applications and device profiles (KIWI, LSN50, STREGA valve, SenseCAP S2120) and write the resulting IDs into Node-RED's environment file:

```bash
ssh root@<pi-ip> 'node /srv/node-red/chirpstack-bootstrap.js'
```

Then restart Node-RED so it picks up the generated `.chirpstack.env`:

```bash
ssh root@<pi-ip> '/etc/init.d/node-red restart'
```

The script is idempotent — safe to re-run after reflashing or if profiles are missing.

### Step 4 — Install Tailscale (remote access)

Tailscale provides persistent SSH access to field-deployed devices without needing to know their local IP or be on the same network.

```bash
ssh root@<pi-ip> 'opkg update && opkg install tailscale'
ssh root@<pi-ip> '/etc/init.d/tailscale enable && /etc/init.d/tailscale start'
```

Then open the firewall to allow inbound traffic on the Tailscale interface (OpenWrt drops it by default):

```bash
ssh root@<pi-ip> "printf '#!/bin/sh\nnft insert rule inet fw4 input iifname \"tailscale0\" accept comment \"tailscale-allow\"\n' > /etc/tailscale-firewall.sh && chmod +x /etc/tailscale-firewall.sh"
ssh root@<pi-ip> "uci add firewall include && uci set firewall.@include[-1].path='/etc/tailscale-firewall.sh' && uci set firewall.@include[-1].type='script' && uci commit firewall && /etc/init.d/firewall restart"
```

Then connect the device to your Tailscale network:

```bash
ssh root@<pi-ip> 'tailscale up --accept-dns=false --hostname=<device-name>'
```

Visit the auth URL printed in the output to approve the device in your Tailscale admin console. Once approved, the device is reachable at its Tailscale IP from anywhere on your tailnet — including via SSH: `ssh root@<tailscale-ip>`.

> **State persistence:** Tailscale stores its state at `/etc/tailscale/tailscaled.state` on the overlayfs — it survives reboots and stays connected automatically. The firewall rule is re-applied on every firewall restart via the UCI include.

### Step 5 — Open the UI

Navigate to `http://<pi-ip>:1880/gui` in a browser (use the Tailscale IP for remote access).

---

### Re-deploying after changes

Re-run `deploy.sh` to update application components. It is safe to re-run on live devices because it preserves `/data/db/farming.db` and only seeds the DB on devices where that file is absent:

```bash
# Rebuild and repackage the GUI if frontend changed
cd web/react-gui && npm install && npm run build && cd ../..
tar czf react_gui.tar.gz -C web/react-gui/build .

# Serve and deploy
python3 -m http.server 9876
# second terminal:
ssh -R 9876:localhost:9876 root@<pi-ip> 'curl -fsS http://localhost:9876/deploy.sh | sh'
ssh root@<pi-ip> '/etc/init.d/node-red restart'
```

No need to re-run `chirpstack-bootstrap.js` unless ChirpStack was re-provisioned or device profiles are missing.

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
