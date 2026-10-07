# OSI OS — Open Smart Irrigation OS

**v0.8.0 Alpha**

OSI OS is an open-source, offline-first smart irrigation platform for smallholder farmers. It runs on a Raspberry Pi 5 LoRaWAN gateway and combines soil sensing, automated irrigation scheduling, and a farmer-facing web dashboard — all without requiring internet connectivity.

Built on [ChirpStack Gateway OS](https://www.chirpstack.io/docs/chirpstack-gateway-os/) (OpenWrt 24.10).

---

## Features

- **LoRaWAN integration** — Flexible device support, continious addition of sensors and acutators
- **Automated irrigation scheduling** — threshold-based triggers on soil moisture or dendrometers
- **Irrigation zones** — group devices into zones with per-zone schedules
- **Web dashboard** — React-based UI accessible on local Wi-Fi at `http://<device-ip>:1880/gui`
- **Multi-user support** — individual user accounts per device
- **Offline-first** — fully functional without internet; cloud sync optional
- **OSI Cloud integration** — remote monitoring and gateway control via OSI Server; fan speed control and reboot from anywhere
- **Raspberry Pi system monitoring** — CPU temperature, memory usage, CPU load, and fan speed visible in the web dashboard
- **Forecast** — Weather forecast,agronomic indicators and irrigation prediction (experimental)

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

| Device                       | Target config                      | Notes                        |
| ---------------------------- | ---------------------------------- | ---------------------------- |
| Raspberry Pi 5 (**primary**) | `full_raspberrypi_bcm27xx_bcm2712` |                              |
| Raspberry Pi 4 / 400 / 3 / 2 | `full_raspberrypi_bcm27xx_bcm2709` | 32-bit ARMv7 universal image |

> Primary target is the Raspberry Pi 5 (`bcm2712`); a universal 32-bit image for Pi 2/3/4/400 is built from `bcm2709`.

---

## Supported Field Devices

| Device type          | Description                                                                            |
| -------------------- | -------------------------------------------------------------------------------------- |
| **KIWI_SENSOR**      | Soil water tension (kPa), soil moisture                                                |
| **TEKTELIC_CLOVER**  | Volumetric water content (%), soil moisture                                            |
| **DRAGINO_LSN50**    | Multi-mode: temperature probe, ADC (dendrometer potentiometer), rain gauge, flow meter, Chameleon or WATERMARK soil water tension (custom LSN50 firmware) |
| **DRAGINO_SDI12**    | SDI-12 soil probes (VWC, soil temperature, EC), including Sentek EnviroSCAN and TriSCAN |
| **SENSECAP_S2120**   | Weather station (wind, rain, UV, barometric pressure)                                  |
| **AQUASCOPE_LORAIN** | Interval rain gauge with ambient temperature and battery                               |
| **STREGA_VALVE**     | Gen1 and Gen2 (SV2) motorized or solenoid irrigation valve with on-valve scheduler     |
| **MILESIGHT_UC512**  | Two-channel valve controller with pulse counters and pipe pressure                     |
| **RAK10701_FIELD_TESTER** | LoRaWAN coverage tester; needs `osi-server.cloud.radio_capture_enabled=1`     |

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
├── scripts/                # Deploy + verification scripts
├── Makefile                # Build system entry point
├── Jenkinsfile             # Legacy; CI runs from .github/workflows/
├── AGENTS.md               # Architecture, sync model, conventions
├── CHANGELOG.md            # Release history
└── docs/                   # Build, contracts, hardware, versioning
```

---

## Quick Start — Development

### Prerequisites

- Node.js 22.12 or later (or 24+) and npm; `web/react-gui/package.json` requires `^22.12.0 || >=24.0.0`
- A running Node-RED instance (local or on a Pi) with the flows loaded
- A copy of `farming.db` accessible at the path configured in Node-RED

### Run the React frontend locally

```bash
cd web/react-gui
npm ci
npm run dev
```

The dev server runs on `http://localhost:3000/gui/` and proxies all API calls to `http://localhost:1880`.

To point at a remote Pi instead:

```bash
VITE_NODERED_URL=http://<pi-ip>:1880 npm run dev
```

### Build the React frontend

```bash
cd web/react-gui
npm run build
```

### Put a change on a running Pi

Re-run `deploy.sh` (see [Re-deploying after changes](#re-deploying-after-changes)). Do not copy `flows.json` or the GUI build onto the Pi by hand: on a gateway that `deploy.sh` manages, `/srv/node-red/flows.json` and `/usr/lib/node-red/gui` are symlinks into one versioned payload pair, and a hand copy also skips the schema migrations.

---

## Building the firmware

See [docs/build/building-firmware.md](docs/build/building-firmware.md) for full instructions.

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

|                    | Path A — Pre-built image                                                                            | Path B — ChirpStack Gateway OS + deploy                             |
| ------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **When to use**    | Fastest start; no build tools needed                                                                | Latest code from this repo; or no release available for your target |
| **What you flash** | OSI OS `.img.gz` from the [Releases page](https://github.com/Open-Smart-Irrigation/osi-os/releases) | ChirpStack Gateway OS Full                                          |
| **After flash**    | Open the UI — done                                                                                  | Run `deploy.sh`, then `/etc/init.d/osi-bootstrap start` (or reboot) |

---

### Path A — Flash the OSI OS image

1. Download the latest factory image from the [Releases page](https://github.com/Open-Smart-Irrigation/osi-os/releases): `osi-os_<version>-rpi5-factory.img.gz` for a Raspberry Pi 5, `osi-os_<version>-rpi4-factory.img.gz` for a Pi 4 / 400 / 3 / 2 (the 0.6.5 assets are named `osi-os_0.65-…`).
2. Flash it to a microSD card (e.g. with [Raspberry Pi Imager](https://www.raspberrypi.com/software/) or `dd`).
3. Boot the Pi — OSI OS starts automatically.
4. Connect to the Wi-Fi AP `OSI-OS-<mac>` (password `opensmartirrigation`) and open the configuration page at 192.168.0.1
5. Proceed the intial Chirpstack setup using the guide (https://www.chirpstack.io/docs/chirpstack-gateway-os/getting-started.html).
6. Navigate to `http://<device-ip>:1880/gui`.

No further setup required. See [Step 4 — Install Tailscale](#step-4--install-tailscale-remote-access) if you want remote access.

---

### Path B — ChirpStack Gateway OS + deploy script

> Use this path when no pre-built release is available, or when you want to deploy the latest code from this repo.

#### Prerequisites

- This repository cloned on your dev machine
- Node.js 22.12 or later (or 24+) and npm on your dev machine

### Step 1 — Flash ChirpStack Gateway OS

Flash the latest **ChirpStack Gateway OS Full** image for Raspberry Pi 5 to a microSD card and boot the Pi. Connect to it via SSH — either through the default Wi-Fi AP (`192.168.0.1`) or your local network IP.

Default SSH credentials: `root` / _(no password on first boot, or set during flash)_

### Step 2 — Deploy OSI OS components

The `deploy.sh` script uses an SSH reverse tunnel to pull all files from your dev machine — no manual `scp` needed:

```bash
# 1. Build and package the React GUI
cd web/react-gui && npm ci && npm run build && cd ../..
tar czf react_gui.tar.gz -C web/react-gui/build .

# 2. Serve the repo from your dev machine
python3 -m http.server 9876 --bind 127.0.0.1

# 3. In a second terminal - deploy via tunnel (runs on the Pi, pulls from your machine).
#    Download first, then run: a piped `curl ... | sh` exits 0 even when curl fails.
ssh -R 9876:localhost:9876 root@<pi-ip> \
  'curl -fsSL http://127.0.0.1:9876/deploy.sh -o /tmp/osi-os-deploy.sh && sh /tmp/osi-os-deploy.sh; rc=$?; rm -f /tmp/osi-os-deploy.sh; exit "$rc"'

# 4. Nothing to restart: deploy.sh restarts Node-RED itself and prints a verdict.
#    Read the verdict; a manual restart after a green deploy only hides a failed one.
```

The script deploys `settings.js`, the Node-RED init script, the gateway identity daemon (`osi-identityd`), the `osi-bootstrap` init script (installed and enabled), `flows.json` together with the React GUI bundle as one versioned payload, every Node-RED local helper module (list them with `grep -o 'fetch_required "[^"]*package.json"' deploy.sh`), `chirpstack-bootstrap.js`, and the device codecs (STREGA Gen1 and Gen2, LSN50, S2120, LoRain, UC512, and SDI12), then runs `npm install` on-device. On a gateway with an existing database it stops Node-RED, backs up the database and applies pending ordered migrations with `scripts/migrate-cli.js` before activating the new payload. It also fixes Mosquitto file ownership.

**Database safety:** `deploy.sh` never overwrites `/data/db/farming.db`. It seeds the bundled `farming.db` only when the target file is absent, and refuses to seed if orphaned SQLite WAL/SHM/journal sidecars exist. On already-provisioned devices the live DB is always preserved.

**Fresh gateways start at the migration head.** The bundled `farming.db` ships with its `schema_migrations` ledger and `schema_object_fingerprints` already stamped for every ordered migration, so the schema step that runs straight after seeding finds nothing pending and completes in seconds rather than rebuilding the migration chain on the Pi. Rebuild the bundled images with `node scripts/build-seed-db.js` whenever a migration is added — applying SQL to the `.db` files by hand leaves the ledger behind, and `node scripts/verify-seed-db-ledger.js` will fail.

**Flaky link?** The reverse tunnel above ties the whole fetch loop to one SSH session; a dropped connection (a Tailscale link over rural cellular, for example) kills the deploy along with it, potentially mid-migration. `scripts/deploy-bundle.sh` + `scripts/deploy-push-bundle.sh` build and push a self-contained bundle instead, then run `deploy.sh` on the gateway under `setsid` so it survives the session ending. See [docs/operations/deploying-over-a-flaky-link.md](docs/operations/deploying-over-a-flaky-link.md).

On first boot after a Path B deploy, OSI OS attempts a one-shot in-place resize of the Raspberry Pi writable partition when the SD layout is the expected two-partition `mmcblk0` layout. The helper uses `parted resizepart` without deleting or recreating the root partition, reboots, then runs `resize2fs` on the next boot. It is idempotent: power loss between the reboot and `resize2fs` is recovered on the next boot. It never touches `/data/db/farming.db`.

<details>
<summary>Alternative: no reverse tunnel available</summary>

A manual file-by-file copy is not a supported install: it misses most helper modules, the identity daemon and the schema migrations. When the reverse tunnel cannot be held open, use the offline bundle from **Flaky link?** above: `scripts/deploy-push-bundle.sh` pushes the bundle and starts `scripts/deploy-offline.sh` on the gateway.

</details>

### Step 3 — ChirpStack auto-provision

ChirpStack applications, device profiles (KIWI, LSN50, STREGA Gen1 and Gen2, S2120, LoRain, UC512, SDI-12, RAK10701), and UCI identity fields are provisioned automatically on first boot of the OSI OS image (Path A) by the `osi-bootstrap` init script (`START=99`).

On Path B, `deploy.sh` enables `osi-bootstrap`, which provisions ChirpStack at the next boot. To provision at once, run `ssh root@<pi-ip> '/etc/init.d/osi-bootstrap start'`. Do not run `chirpstack-bootstrap.js` directly: only the service writes the stamp `/etc/osi-bootstrap.done`, and without it the next boot runs the script again, which creates a second API key and rewrites `/srv/node-red/.chirpstack.env`.

To re-provision manually (e.g. after wiping profiles), run on the gateway:

```bash
rm -f /etc/osi-bootstrap.done && CHIRPSTACK_API_KEY="$(sed -n 's/^CHIRPSTACK_API_KEY=//p' /srv/node-red/.chirpstack.env | head -1)" /etc/init.d/osi-bootstrap start
```

This reuses the existing API key, writes the stamp and requests the coordinated Node-RED restart. It rewrites `.chirpstack.env` with the `CHIRPSTACK_*` keys only.

The service returns 0 even when provisioning fails; errors go to `logread`. Before you reboot, confirm the stamp is back:

```bash
ls -l /etc/osi-bootstrap.done || logread | grep -i osi-bootstrap | tail -20
```

If the stamp is missing, fix the cause and run the command again. A reboot without the stamp runs the bootstrap with no key and creates a second API key.

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
cd web/react-gui && npm ci && npm run build && cd ../..
tar czf react_gui.tar.gz -C web/react-gui/build .

# Serve and deploy
python3 -m http.server 9876 --bind 127.0.0.1
# second terminal:
ssh -R 9876:localhost:9876 root@<pi-ip> \
  'curl -fsSL http://127.0.0.1:9876/deploy.sh -o /tmp/osi-os-deploy.sh && sh /tmp/osi-os-deploy.sh; rc=$?; rm -f /tmp/osi-os-deploy.sh; exit "$rc"'
```

No need to provision ChirpStack again after the first provisioning unless ChirpStack was re-provisioned or device profiles are missing; then use the re-provision command in Step 3.

---

## Default Wi-Fi Access Point (first boot)

| Path                                | SSID                  | Password              | Device IP     |
| ----------------------------------- | --------------------- | --------------------- | ------------- |
| ChirpStack Gateway OS base (Path B) | `ChirpstackAP-<mac6>` | `ChirpStackAP`        | `192.168.0.1` |
| OSI OS firmware (Path A)            | `OSI-OS-<mac6>`       | `opensmartirrigation` | `192.168.0.1` |

---

## Links

- [ChirpStack documentation](https://www.chirpstack.io/)
- [ChirpStack Gateway OS](https://www.chirpstack.io/docs/chirpstack-gateway-os/)
- [chirpstack-openwrt-feed](https://github.com/chirpstack/chirpstack-openwrt-feed)
- [OpenWrt build system](https://openwrt.org/docs/guide-developer/toolchain/use-buildsystem)
