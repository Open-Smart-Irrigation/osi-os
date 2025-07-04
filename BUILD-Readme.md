# ChirpStack Gateway OS Build Process

## Prerequisites

- Docker and Docker Compose installed
- At least 20GB free disk space
- At least 8GB RAM recommended
- Stable internet connection

## Build Steps

### 1. Initialize Build Environment (First Time Only)

```bash
# Initialize OpenWrt build environment
make init
```

**⚠️ This takes 10-15 minutes and downloads ~2GB of data**

### 2. Enter Development Shell

```bash
# Enter the Docker development environment
make devshell
```

### 3. Switch to Target Environment

```bash
# Switch to Raspberry Pi environment (or your target)
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2709
```

### 4. Update Feeds (Important!)

```bash
# Update all OpenWrt feeds
make update
```

### 5. Build the Image

```bash
# Build the complete image
make
```

**⚠️ This takes 1-3 hours depending on your hardware**

## Build Output

After successful build, your image will be in:
```
openwrt/bin/targets/bcm27xx/bcm2709/
```

Look for files like:
- `openwrt-bcm27xx-bcm2709-rpi-3-ext4-factory.img.gz`
- `openwrt-bcm27xx-bcm2709-rpi-3-ext4-sysupgrade.img.gz`

## Common Issues & Solutions

### "No space left on device"
- Free up disk space (need 20GB+)
- Run `docker system prune -a` to clean Docker cache

### "Permission denied" errors
- Make sure you're in the docker group: `sudo usermod -aG docker $USER`
- Log out and back in, or run: `newgrp docker`

### Build fails with missing packages
- Run `make update` inside devshell
- Try `make clean` and rebuild if packages seem corrupted

### "Feed not found" errors
- Run `make init` again
- Check internet connection during feed updates

## Clean Build (If Things Go Wrong)

```bash
# Clean everything and start fresh
make clean
make init
make devshell
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2709
make update
make
```

## Quick Reference

```bash
# Complete build process in order:
make init                    # First time only
make devshell               # Enter Docker environment
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2709
make update                 # Update feeds
make                        # Build image
```