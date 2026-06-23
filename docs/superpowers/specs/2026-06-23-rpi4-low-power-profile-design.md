# Raspberry Pi 4 Low-Power Profile Design

Status: draft for user review
Date: 2026-06-24

## Context

OSI OS currently ships a Raspberry Pi 5 release profile at
`conf/full_raspberrypi_bcm27xx_bcm2712` and a Raspberry Pi 4 / 400 / 3 / 2
release profile at `conf/full_raspberrypi_bcm27xx_bcm2709`. The Pi 5 profile is
the canonical OSI runtime payload source. The bcm2709 profile mirrors that
payload byte-for-byte, and `scripts/verify-profile-parity.js` enforces the
invariant.

The requested new target is a Raspberry Pi 4 low-power field image. It should
minimize idle power while preserving the edge as the canonical system:
Node-RED, SQLite, ChirpStack, LoRa sensor ingest, irrigation control, and the
local GUI must continue to run without cloud access.

Cloud sync and remote maintenance should be available during one daily
maintenance window of about one hour. The planned LTE device is a GL.iNet
GL-XE300 Puli. Its Wi-Fi is not required. The Raspberry Pi hotspot remains the
local access path and should stay available in v1. The Puli keeps its internal
battery. No Raspberry Pi USB peripherals are required, so all Pi USB ports may
be powered down together.

Remote access should move off the Pi. The low-power Pi image should not run
Tailscale, OpenVPN, WireGuard, or other always-on remote-access daemons. During
the maintenance window, the Puli should provide the LTE connection and, if the
exact Puli firmware supports it reliably, the Tailscale endpoint/subnet route
used to reach the Pi over Ethernet.

Relevant hardware facts:

- Raspberry Pi 4 USB peripheral current is limited to about 1.2 A total.
- GL.iNet specifies the GL-XE300 input as 5 V / 2 A with battery installed.
- The Puli is documented to power on when USB-C power is connected.
- `uhubctl` supports ganged Raspberry Pi USB power switching; on Pi 4 the
  expected control target is all USB ports together, not one independent port.
- GL.iNet Router Docs 4 list Tailscale as available on selected routers, with
  LAN/WAN subnet access options, but list `GL-XE300 (Puli)` as unsupported and
  `GL-XE3000 (Puli AX)` as supported. GL.iNet forum reports show manual or beta
  GL-XE300 Tailscale installs, but also instability. Therefore GL-XE300
  Tailscale is an acceptance-test item, not a baseline assumption.

Sources:

- Raspberry Pi power requirements:
  https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#typical-power-requirements
- GL-XE300 specifications:
  https://docs.gl-inet.com/router/en/3/specification/gl-xe300/
- GL-XE300 first-time setup and power behavior:
  https://docs.gl-inet.com/router/en/3/setup/gl-xe300/first_time_setup/
- `uhubctl` Raspberry Pi notes:
  https://github.com/mvp/uhubctl#raspberry-pi-turns-power-off-on-all-ports-not-just-the-one-i-specified
- GL.iNet Tailscale docs:
  https://docs.gl-inet.com/router/en/4/interface_guide/tailscale/
- GL-XE300 Puli Tailscale forum thread:
  https://forum.gl-inet.com/t/gl-xe300-puli-and-tailscale/32311

## Goals

1. Add a separate Raspberry Pi 4 low-power build profile so the normal bcm2709
   release image stays conservative.
2. Use direct Pi USB power switching as the first Puli power-control prototype.
3. Keep the Pi hotspot available independently of the Puli.
4. Limit cloud sync and remote maintenance to a one-hour daily window.
5. Keep LoRaWAN ingest, local control, local GUI, scheduler behavior, and local
   database writes available outside the window.
6. Preserve profile parity discipline for shared OSI runtime payload files.
7. Fail safely when LTE or USB power control is unavailable: the edge keeps
   operating locally, sync is deferred, and no local database is replaced.
8. Remove Pi-side remote-access daemons from the low-power image; remote
   maintenance reaches the Pi through the Puli's Ethernet LAN during the window.

## Non-Goals

- Do not add a dedicated GPIO-controlled 5 V load switch in v1.
- Do not remove the Puli battery.
- Do not use the Puli Wi-Fi as an access path.
- Do not run Tailscale, OpenVPN, or WireGuard on the Pi low-power image.
- Do not expose Pi management services directly over LTE; expose them only on
  the local Pi hotspot and Puli-connected Ethernet LAN.
- Do not guarantee cloud-originated commands outside the maintenance window.
- Do not contact production `osicloud.ch` during implementation or validation
  unless explicitly requested in that same session.

## Proposed Architecture

Create a new profile named `conf/lowpower_raspberrypi_bcm27xx_bcm2709`. It
targets the same OpenWrt bcm2709 / `DEVICE_rpi-2` build target as the current
Pi 4 image, but it has lower-power defaults and a smaller package/service set.

Shared OSI runtime additions should be generic and disabled by default in the
standard profiles. The low-power profile opts into them through profile-specific
configuration. This keeps the Pi 5 and standard Pi 4 images behavior-compatible
while avoiding a forked Node-RED or helper payload.

The low-power profile has three cooperating pieces:

1. Maintenance-window controller
   - Owns the daily one-hour window.
   - Powers Pi USB on at the start of the window with `uhubctl`.
   - Waits for the Puli Ethernet/LTE route.
   - Optionally waits for Puli Tailscale/subnet-route readiness if enabled.
   - Publishes window state for Node-RED sync gating.
   - Attempts a clean Puli shutdown near the end of the window.
   - Powers Pi USB off after the shutdown grace period.

2. Cloud-sync gate
   - Leaves local edge behavior unchanged.
   - Lets outbox events accumulate outside the window.
   - Allows bootstrap, outbox delivery, pending-command polling, token refresh,
     and cloud calibration lookup only while the maintenance window is open.
   - Defaults to "always allowed" unless the low-power UCI config explicitly
     enables windowed sync.

3. Remote-maintenance boundary
   - The Puli owns Tailscale or any other remote-access VPN.
   - The Pi does not join the tailnet and does not run Pi-side VPN daemons.
   - If the Puli Tailscale implementation supports LAN subnet advertisement,
     remote operators reach the Pi through the Puli LAN route during the window.
   - If GL-XE300 Tailscale is unavailable or unstable, remote maintenance falls
     back to cloud-mediated diagnostics during the window, or to a different LTE
     router model such as GL-XE3000 Puli AX.

4. Profile/package trimming
   - Keeps required services: Node-RED, SQLite support, ChirpStack, LoRa
     concentratord, Mosquitto, nginx local API/GUI proxy, Wi-Fi AP support,
     DHCP/DNS/firewall pieces needed by the Pi hotspot.
   - Adds `uhubctl`.
   - Removes or disables obvious non-required idle services in the low-power
     image, starting with LuCI package-manager UI, Tailscale, OpenVPN,
     WireGuard tools, Redis if confirmed unused by OSI runtime, unused
     ChirpStack mesh/UDP forwarder variants, USB gadget/device-mode support,
     and UART/GPS defaults when no GPS is installed.

## Maintenance Window Flow

Default window policy:

- One daily window.
- Duration: 60 minutes.
- Start time: configurable in UCI, stored as local time.
- USB state outside the window: off.
- Puli Wi-Fi: disabled on the Puli itself during router setup.
- Pi hotspot: always on in v1.

Start-of-window sequence:

1. Mark state as `starting`.
2. Enable Pi USB power with `uhubctl -l 1-1 -a 1`.
3. Wait for the Puli Ethernet interface and gateway route.
4. Wait for external connectivity to the configured OSI Server host.
5. If Puli Tailscale is enabled, wait for the router to be reachable from the
   tailnet and for the Pi LAN subnet route to be active.
6. Mark state as `open`.
7. Let Node-RED cloud sync run normally until the window enters shutdown.

End-of-window sequence:

1. Mark state as `closing`.
2. Let Node-RED complete one final outbox flush attempt.
3. If Puli SSH is configured, run a clean shutdown command on the Puli.
4. Wait for the shutdown grace period.
5. Disable Pi USB power with `uhubctl -l 1-1 -a 0`.
6. Mark state as `closed`.

Failure behavior:

- If `uhubctl` is missing or fails, record `usb_power_error` and leave cloud
  sync closed.
- If the Puli does not become reachable, record `router_unreachable`, turn USB
  off at the end of the attempt, and retry at the next scheduled window.
- If LTE does not become usable, leave the edge local-only and retry at the next
  scheduled window.
- If Pi undervoltage is detected during router power-up, immediately close the
  window, turn USB off, and record `undervoltage`.
- If the Puli continues running from battery after USB power is disabled, the
  direct-USB design fails hardware acceptance and the fallback is an externally
  powered or switched solution.

## Hardware Wiring

Prototype wiring:

- Pi USB-A port to Puli USB-C power input.
- Pi Ethernet to Puli LAN port.
- Pi Wi-Fi AP remains the local service hotspot.
- Puli Wi-Fi disabled.
- Puli Tailscale enabled only if the exact GL-XE300 firmware proves stable.
- No other Pi USB devices connected.

This wiring intentionally avoids a GPIO-controlled load switch. It is accepted
only if hardware testing proves the Pi does not brown out and the Puli does not
remain awake all day on battery after the window closes.

## Profile Parity Strategy

The new low-power profile must not become an uncontrolled fork of the standard
Pi runtime payload.

Implementation should use this rule:

- Generic behavior and helper code lives in the canonical payload and is copied
  through the existing Pi 5 to Pi 4 parity path.
- The low-power profile may differ in `.config`, boot config patches, and a
  small allowlist of profile-specific defaults that turn low-power behavior on.
- Add or extend a verifier so shared OSI payload files in the low-power profile
  are checked against the canonical Pi 5 payload, with explicit exceptions for
  the low-power enablement files.

## Acceptance Criteria

Static and build acceptance:

1. `node scripts/verify-profile-parity.js` passes for standard profiles.
2. A low-power profile verifier passes and rejects drift outside the explicit
   low-power allowlist.
3. `node scripts/verify-sync-flow.js` passes.
4. `scripts/check-mqtt-topics.sh` passes.
5. `make switch-env ENV=lowpower_raspberrypi_bcm27xx_bcm2709` succeeds.
6. OpenWrt config normalization keeps `CONFIG_PACKAGE_uhubctl=y`.
7. The low-power image builds at least once before field testing.

Hardware acceptance:

1. `uhubctl -l 1-1 -a 0` removes Pi USB power from the Puli.
2. `uhubctl -l 1-1 -a 1` powers the Puli back on.
3. The Puli LTE route becomes usable within the configured startup budget.
4. The Pi reports no undervoltage or USB instability during Puli boot and LTE
   attach.
5. After the window closes, the Puli is off or in sufficiently low drain that
   it does not run its battery down before the next window.
6. Local Wi-Fi AP, GUI, Node-RED scheduler, LoRa ingest, and SQLite writes keep
   working while the Puli is off.
7. If Puli Tailscale is enabled, the exact GL-XE300 firmware keeps a stable
   tailnet connection and exposes the Pi LAN route for the full window.
8. If Puli Tailscale is unstable or unsupported, the low-power Pi image remains
   valid, but remote shell maintenance is marked unsupported for that router.

Functional acceptance:

1. Outbox events created outside the window remain local and pending.
2. At the next window, pending events flush to the configured cloud endpoint.
3. Pending cloud commands are pulled only while the window is open.
4. Local irrigation behavior does not depend on LTE availability.
5. Maintenance-window state and recent failures are visible in logs or a simple
   local status command.
6. The low-power Pi image contains no Tailscale, OpenVPN, or WireGuard daemon.
7. Pi SSH/API access over the Puli path is possible only through the Puli's LAN
   and, if enabled, its Puli-hosted Tailscale subnet route.

## Fallbacks

If direct Pi USB power is electrically unreliable, keep the same software
contract and replace the power backend with one of these options:

1. Powered USB hub with switchable downstream power controlled by the Pi.
2. Dedicated 5 V load switch controlled from GPIO.
3. Always-powered Puli with Puli-side Wi-Fi/cellular scheduling, accepting
   higher idle power.
4. Replace GL-XE300 with GL-XE3000 Puli AX or another GL.iNet model with
   officially supported Tailscale if remote shell maintenance through the router
   is required and GL-XE300 Tailscale is unreliable.

The direct Pi USB path remains the first implementation because it matches the
current hardware preference and avoids extra switching hardware.
