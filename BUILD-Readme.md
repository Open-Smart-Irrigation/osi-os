# OSI OS — Firmware Build Guide

> **Note:** The firmware build is currently work-in-progress. For day-to-day development, use the [manual deployment workflow](README.md#device-setup-manual) instead.

---

## Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose installed
- At least 20 GB free disk space
- At least 8 GB RAM recommended
- Stable internet connection (build downloads several GB of packages)

---

## Build Steps

### 1. Initialize (first time only)

```bash
make init
```

This clones the OpenWrt source, fetches all feeds (including the ChirpStack OpenWrt feed), and sets up symlinks. Takes 10–15 minutes and downloads ~2 GB.

### 2. Enter the Docker build environment

```bash
make devshell
```

All subsequent build commands run inside this Docker container.

### 3. Switch to the target configuration

```bash
# Raspberry Pi 5 (primary / recommended)
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2712

# Raspberry Pi 2/3
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2709

# Raspberry Pi 1/Zero
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2708
```

`switch-env` undoes any previously applied patches, updates OpenWrt symlinks, and applies the target's quilt patches.

### 4. Update feeds

```bash
make update
```

Run this after `switch-env` to ensure all feeds are up to date.

### 5. Build the React GUI

Before building the firmware, build the React frontend and copy it into the Node-RED package:

```bash
# Run outside the Docker container, in the repo root
cd web/react-gui
npm install
npm run build
cp -r build/* feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/
```

### 6. Build the firmware image

Inside the Docker devshell:

```bash
make
```

This takes 1–3 hours depending on hardware. The first build is slowest; subsequent builds reuse cached artifacts.

---

## Build Output

After a successful build, firmware images are in:

| Target | Output directory |
|---|---|
| Raspberry Pi 5 | `openwrt/bin/targets/bcm27xx/bcm2712/` |
| Raspberry Pi 2/3 | `openwrt/bin/targets/bcm27xx/bcm2709/` |
| Raspberry Pi 1/Zero | `openwrt/bin/targets/bcm27xx/bcm2708/` |

Look for files like:
- `openwrt-bcm27xx-bcm2712-rpi-5-ext4-factory.img.gz` — for flashing a new SD card
- `openwrt-bcm27xx-bcm2712-rpi-5-ext4-sysupgrade.img.gz` — for over-the-air upgrades

---

## Making Configuration Changes

Run the following commands from inside the `openwrt/` directory (still within devshell):

```bash
# Interactive package/kernel config
make menuconfig

# Refresh config after upstream updates
make defconfig
```

See the [OpenWrt build system documentation](https://openwrt.org/docs/guide-developer/toolchain/use-buildsystem) for more options.

---

## Troubleshooting

### "No space left on device"
Free up disk space (20 GB+ required). Clean Docker cache:
```bash
docker system prune -a
```

### "Permission denied" errors
Ensure your user is in the `docker` group:
```bash
sudo usermod -aG docker $USER
newgrp docker
```

### Build fails with missing packages
Run `make update` inside the devshell, then retry. If packages seem corrupted:
```bash
make clean && make
```

### "Feed not found" errors
Run `make init` again and check your internet connection.

### Rust compilation OOM
The Jenkinsfile limits Cargo to 2 parallel jobs (`CARGO_BUILD_JOBS=2`). If building locally with more RAM available, you can increase this, but keep it conservative on machines with less than 16 GB.

---

## Clean Build

```bash
make clean
make init
make devshell
# then inside devshell:
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2712
make update
make
```

---

## Quick Reference

```bash
# Complete build sequence (Pi 5):
make init                                          # First time only
make devshell                                      # Enter Docker environment
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2712
make update
make
```
