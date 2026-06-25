# Raspberry Pi 4 Low-Power Image

This document records the target-selection evidence for the Raspberry Pi 4 low-power OSI OS profile. The low-power implementation is gated on real Pi 4 + GL.iNet GL-XE300 Puli hardware tests because the intended Puli power window depends on USB VBUS switching, not just package or UCI configuration.

## Task 0 Status

Status: blocked on hardware validation.

Local repo evidence collected on 2026-06-25:

```bash
rg -n "CONFIG_TARGET_bcm27xx_bcm2709_DEVICE|CONFIG_TARGET_PROFILE|CONFIG_TARGET_ARCH_PACKAGES|CONFIG_PACKAGE_kmod-usb3|CONFIG_PACKAGE_kmod-usb-xhci" conf/full_raspberrypi_bcm27xx_bcm2709/.config
```

Observed:

```text
58:CONFIG_TARGET_bcm27xx_bcm2709_DEVICE_rpi-2=y
63:CONFIG_TARGET_PROFILE="DEVICE_rpi-2"
64:CONFIG_TARGET_ARCH_PACKAGES="arm_cortex-a7_neon-vfpv4"
2926:# CONFIG_PACKAGE_kmod-usb3 is not set
```

The current standard `bcm2709` profile is therefore not yet proven as a Pi 4 USB power-control target. It is a `DEVICE_rpi-2` ARMv7 profile and does not select USB3 support in the captured config.

OpenWrt target evidence:

```bash
rg -n "define Device/rpi-4|SUBTARGET\\),bcm2711|TARGET_DEVICES \\+= rpi-4" openwrt/target/linux/bcm27xx/image/Makefile
```

Observed:

```text
170:define Device/rpi-4
191:ifeq ($(SUBTARGET),bcm2711)
192:  TARGET_DEVICES += rpi-4
```

OpenWrt has a Raspberry Pi 4 device under the `bcm2711` subtarget, but this repo does not provide a ChirpStack Gateway OS `bcm2711` profile. The implementation must continue with the existing CGOS `bcm2709` profile only if real hardware proves the current universal image boots the Pi 4 and can switch Puli USB power.

## Hardware Gate

Before using the low-power profile as a field image, run these tests on the intended Pi 4 and Puli hardware.

Boot the candidate image and capture:

```sh
cat /etc/openwrt_release
uname -a
ls /sys/bus/usb/devices
uhubctl
```

Check VL805 firmware when the tool is available on the image or from a Raspberry Pi OS maintenance boot:

```sh
rpi-eeprom-update
```

Expected before relying on Pi 4B USB power switching: VL805 firmware `00137ad` or newer.

Connect the Puli exactly as intended for field use:

- Puli USB power from the Pi.
- Puli Ethernet LAN to Pi Ethernet.
- Puli battery installed.
- Puli Wi-Fi can remain disabled.

Measure Puli external USB power with an inline USB meter or equivalent. Do not accept `uhubctl` exit code alone.

Test Pi 4B hub switching:

```sh
uhubctl -l 1-1 -a 0
uhubctl -l 2 -a 0
sleep 15
uhubctl -l 1-1 -a 1
uhubctl -l 2 -a 1
```

Expected: Puli loses external USB power when both hubs are off and regains it when both hubs are on. If the candidate image exposes different hub paths, record the exact `uhubctl` output and measured power behavior.

## Target Decision

Continue with `conf/lowpower_raspberrypi_bcm27xx_bcm2709` only if both conditions hold:

- The existing `bcm2709` image boots the intended Pi 4.
- The Pi 4 can measurably cut and restore Puli external USB power from that image.

Stop this plan and choose an external power-switch path if:

- The `bcm2709` image boots but cannot expose or control the Pi 4 USB power path.
- Direct Pi USB power switching does not reliably cut Puli external power.
- The Pi logs undervoltage or repeated USB resets during Puli LTE attach.
- Puli battery drain remains unacceptable after hub power-off.

Start a separate ChirpStack Gateway OS profile-support project if:

- The project decides Pi 4-specific `bcm2711 / DEVICE_rpi-4` support is required.
- A future low-power image should be based on a new CGOS `bcm2711` profile family rather than the existing universal `bcm2709` profile.

## Implemented Profile

The software scaffold exists at `conf/lowpower_raspberrypi_bcm27xx_bcm2709`. It is intentionally a thin profile delta:

- Own `.config`.
- Own Raspberry Pi boot patch with UART, I2C, and USB gadget defaults removed; SPI remains enabled.
- `files` symlink to the standard `full_raspberrypi_bcm27xx_bcm2709` payload.
- `files-overlay/etc/uci-defaults/99_osi_lowpower_defaults` to enable the low-power UCI defaults only for this image.

The low-power defaults keep the Pi hotspot available, reduce `radio0` transmit power to `12`, disable GPS polling by UCI, enable a daily `02:00` one-hour maintenance window, and enable Pi USB/Ethernet control for the Puli path.

Build environment activation:

```sh
make switch-env ENV=lowpower_raspberrypi_bcm27xx_bcm2709
```

`make switch-env` composes the shared payload plus the low-power overlay into `.tmp-openwrt-files/lowpower_raspberrypi_bcm27xx_bcm2709` and points `conf/files` at that temporary tree.

`make defconfig` was attempted locally on 2026-06-25. It completed, but the local OpenWrt tree was not feed-complete for this profile and dropped required ChirpStack, LuCI, Mosquitto, Tailscale, and `uhubctl` selections. The low-power `.config` was restored from the standard bcm2709 baseline plus the intentional trim. Run defconfig again only in the normal CGOS build environment with feeds installed, then rerun `node scripts/verify-lowpower-profile.js`.

## Maintenance Window

Runtime control is shared by the standard profiles and disabled by default through `/etc/config/osi-lowpower`. The low-power image enables it through the profile overlay.

Useful commands on the Pi:

```sh
uci show osi-lowpower
/etc/init.d/osi-lowpower status
/etc/init.d/osi-lowpower open
/etc/init.d/osi-lowpower close
cat /var/run/osi-lowpower/window.env
logread | grep -i osi-lowpower
```

The controller is a reconciler, not a one-shot timer. It runs every five minutes under procd, opens the Puli USB/Ethernet path during the configured daily window, and closes it outside the window. Manual `open` and `close` commands are available for installation and field testing.

## Cloud Gating

When `osi-lowpower.main.cloud_window_required=1`, Node-RED exports:

```sh
OSI_LOWPOWER_WINDOWED_SYNC=1
OSI_LOWPOWER_STATE_FILE=/var/run/osi-lowpower/window.env
```

Scheduled/background cloud REST calls and cloud MQTT egress are suppressed outside the maintenance window. Local API, GUI, database writes, ChirpStack, and ChirpStack MQTT ingestion are not gated.

First account linking still requires cloud connectivity. For a low-power image, open the maintenance window manually before linking:

```sh
/etc/init.d/osi-lowpower open
```

If the window is closed, the local `/auth/local-sync` flow returns a friendly `OSI_LOWPOWER_WINDOW_CLOSED` message that tells the operator to run the manual open command before linking. Other gated cloud REST calls still return `OSI_LOWPOWER_WINDOW_CLOSED` with HTTP status `425` before network I/O.

## Deferred Trims

Redis remains installed until a real Pi boot/uplink smoke test proves ChirpStack, Mosquitto, Node-RED, LuCI, the ChirpStack GUI, and one LoRaWAN uplink path work without it.

Kernel debug/crash symbols remain verifier warnings, not hard failures, until `make defconfig` in a feed-complete build environment proves they can be removed without dependency churn.

Production Node-RED flow load cleanup is deferred from the first low-power profile change. The current implementation gates cloud egress without consolidating ChirpStack ingress nodes or removing disabled simulation tabs.
