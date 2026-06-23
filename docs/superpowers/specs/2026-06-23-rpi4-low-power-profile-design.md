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
9. Apply conservative low-power defaults for radios, USB, unused peripherals,
   background cloud polling, development flows, and non-required packages.

## Non-Goals

- Do not add a dedicated GPIO-controlled 5 V load switch in v1.
- Do not remove the Puli battery.
- Do not use the Puli Wi-Fi as an access path.
- Do not run Tailscale, OpenVPN, or WireGuard on the Pi low-power image.
- Do not expose Pi management services directly over LTE; expose them only on
  the local Pi hotspot and Puli-connected Ethernet LAN.
- Do not guarantee cloud-originated commands outside the maintenance window.
- Do not sleep the LoRa concentrator in v1; missing sensor uplinks changes edge
  behavior and needs a separate field trial.
- Do not schedule the Pi hotspot off by default in v1; daytime/night schedules
  are optional field-test policy, not the first shipped profile default.
- Do not remove the basic LuCI or ChirpStack first-configuration GUI.
- Do not stretch edge-cloud sync cadences beyond the maintenance-window gate
  without measuring power, command latency, and cloud-contract effects.
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

The low-power profile has four cooperating pieces:

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
     image, starting with LuCI package-manager/watchcat extras, Tailscale,
     OpenVPN, WireGuard tools, Redis if confirmed unused by OSI runtime, unused
     ChirpStack mesh/UDP forwarder variants, USB gadget/device-mode support,
     and UART/GPS defaults when no GPS is installed.
   - Keeps the basic LuCI web UI and ChirpStack LuCI configuration screens
     required for first setup.

## V1 Low-Power Defaults

These defaults are in scope for the first implementation. They are conservative:
they remove idle work and unused hardware paths without changing local irrigation
or LoRa ingest semantics.

The initial audit suggestions consolidate into these decisions:

- **Separate image variant:** create `lowpower_raspberrypi_bcm27xx_bcm2709`
  instead of weakening the universal bcm2709 release image for Pi 2/3/4/400.
- **Wi-Fi/AP:** keep the Pi hotspot on by default for local access and first
  configuration, but lower its transmit power. AP opt-in, Ethernet-first setup,
  and daytime-only AP schedules stay field-test policy.
- **UART/GPS/USB gadget:** make UART/GPS and `dwc2` USB gadget behavior opt-in.
  Keep SPI for the LoRa HAT. Keep I2C only when the measured hardware profile
  requires it.
- **Remote access:** remove Pi-side VPN stacks and let the Puli own remote
  access during the maintenance window.
- **LuCI/admin surface:** keep basic LuCI and ChirpStack setup pages; trim only
  extras that are not needed for first setup or local recovery.
- **ChirpStack variants:** keep only the local ChirpStack server, the configured
  RPi concentratord target, Mosquitto, and the MQTT forwarder path used by OSI.
  Remove mesh, UDP, unused concentratord targets, and matching LuCI pages.
- **Node-RED runtime load:** consolidate duplicate uplink MQTT subscriptions,
  disable active debug nodes, and remove disabled simulation/development tabs
  from the low-power payload.
- **Redis:** target no Redis, but verify a complete boot and ingest path before
  treating it as removable.
- **Kernel/runtime options:** audit debug/minidump options such as debugfs,
  KALLSYMS, debug kernel, debug info, kexec, crash dump, vmcore/kcore, and
  disable what the OpenWrt bcm2709 target can safely drop.
- **Sync cadence:** gate cloud work by the maintenance window first. Further
  cadence changes need measurements and explicit cloud-contract review.

### Cloud And Remote Services

- Remove Pi-side Tailscale, OpenVPN, WireGuard, PPP/PPPoE, watchcat, and the
  Tailscale first-boot autoconnect script from the low-power image.
- Keep Pi SSH and the local API reachable only from the Pi hotspot and the Puli
  Ethernet LAN. Do not expose Pi management directly over LTE.
- Gate all cloud-facing Node-RED work on the maintenance-window state:
  bootstrap sync, outbox event flush, pending-command polling, command ACK flush,
  sync-token refresh, Chameleon calibration lookup, cloud MQTT heartbeat,
  cloud MQTT telemetry/status publishing, and OpenAgri weather fetches.
- Outside the window, leave outbox/ACK rows pending locally and suppress cloud
  network attempts rather than letting them fail repeatedly.

### Network And Radios

- Keep the Pi hotspot always on in v1, using the existing 2.4 GHz HT20 AP
  profile, but add a low-power UCI default for reduced transmit power.
- Keep Puli Wi-Fi disabled and use Puli Ethernet for Pi maintenance traffic.
- Bring Pi Ethernet up only during the Puli window. After the window closes and
  USB power is removed, bring the Puli-facing Ethernet path down.
- Keep LoRa concentrator service available whenever the configured concentrator
  is enabled. Do not add LoRa sleep windows in v1.

### USB And Boot Peripherals

- Add `uhubctl` and default Pi USB VBUS off outside the maintenance window.
- Remove USB gadget/device-mode defaults, including the Pi boot `dtoverlay=dwc2`
  path, from the low-power profile.
- Remove USB serial, USB HID, USB audio, and USB storage support unless a
  specific measured field setup requires them.
- Keep SPI enabled for the LoRa HAT.
- Disable UART/GPS defaults unless the installation explicitly includes a GPS
  receiver. The existing `osi-gateway-gps` sidecar remains out of the default
  low-power runtime.
- Disable I2C by default unless the selected HAT, RTC, or sensor stack requires
  it in the measured installation.
- Disable display/audio/LED-oriented defaults: HDMI/display output, onboard
  audio modules, and non-essential LEDs where the Pi/OpenWrt target supports it.

### CPU And Runtime Load

- Use a conservative CPU governor and frequency cap for the low-power profile.
  The cap is accepted only if local GUI/API latency, Node-RED scheduler latency,
  ChirpStack ingest, and STREGA command handling remain within field-test
  thresholds.
- Keep SQLite durability settings unchanged unless a separate data-integrity
  review approves a change. Power saving must not trade away edge canonicality.
- Keep Node-RED logging at `info` or lower and disable active debug nodes in the
  shipped low-power flow.
- Remove disabled development/simulation tabs from the low-power payload:
  `Field testing`, `Simulations (Dev)`, and `Dendro Live Sim`.
- Consolidate duplicate `application/+/device/+/event/up` MQTT subscriptions
  into one ingest router before device-specific processing. This should be a
  behavior-preserving runtime cleanup and can ship through the canonical payload
  if tests prove parity.
- Keep the current edge-cloud cadence semantics inside the open maintenance
  window until power measurements show that slower intervals are needed.

### Package And Service Set

- Keep the basic LuCI web UI for first configuration, including the LuCI nginx
  integration, LuCI base/admin modules, network/status/system screens, firewall
  screen, and one standard theme.
- Keep the ChirpStack LuCI configuration screens required for first setup:
  applications/server, ChirpStack server, RPi concentratord target, and the
  MQTT forwarder path used by the local gateway.
- Remove only LuCI extras that are not needed for first setup or local recovery:
  package manager UI, watchcat UI, remote-access protocol UI for removed VPNs,
  and ChirpStack mesh/UDP UI variants when their matching runtime packages are
  removed from the low-power profile.
- Remove Pi-side VPN packages: `tailscale`, `openvpn-openssl`, and
  `wireguard-tools`.
- Remove unused ChirpStack mesh and UDP forwarder variants. Keep only the local
  ChirpStack server, the configured RPi concentratord target, Mosquitto, and the
  MQTT forwarder path needed by the local gateway.
- Target no Redis in the low-power image. The implementation must verify a full
  boot and ChirpStack/Node-RED ingest path without Redis; if that fails, Redis
  stays disabled by default until the dependency is understood.
- Remove diagnostic and development utilities unless they are part of the
  hardware acceptance checklist. Keep enough shell/network tooling for local
  status and recovery over the Pi hotspot.
- Audit and disable kernel/runtime debug options where safe for the low-power
  target: debugfs, KALLSYMS, debug kernel, debug info, kexec, crash dump, and
  vmcore/kcore. Treat this as a minimal-image and idle-overhead cleanup; do not
  let it block the higher-value radio, USB, VPN, and daemon savings.

### Field-Test-Only Options

These are not v1 defaults:

- Pi hotspot daytime-only schedule.
- Ethernet-first first-boot setup with Pi AP opt-in instead of always-on.
- LoRa concentrator sleep windows.
- Stronger CPU underclocking than the first conservative cap.
- Slower in-window sync cadences than the current edge-cloud contract.
- Always-powered Puli with Puli-side cellular scheduling.
- Replacing GL-XE300 with GL-XE3000 Puli AX or another GL.iNet model because
  GL-XE300 Tailscale is unstable.

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
8. Low-power OpenWrt config excludes Pi-side `tailscale`, `openvpn-openssl`,
   `wireguard-tools`, PPP/PPPoE, watchcat, USB gadget/device-mode, USB storage,
   USB audio, and non-required USB serial/HID support.
9. Low-power boot config keeps SPI enabled and disables `dtoverlay=dwc2`,
   UART/GPS defaults, display/audio defaults, and I2C unless the selected
   hardware profile explicitly requires I2C.
10. Low-power OpenWrt config keeps the basic LuCI GUI and ChirpStack first-setup
    GUI: LuCI nginx integration, base/admin/network/status/system/firewall
    screens, one standard theme, and the ChirpStack server/concentratord/MQTT
    forwarder configuration screens needed by the local gateway.
11. Low-power payload either removes Redis or proves Redis is disabled and not
    required by the ChirpStack/Node-RED ingest smoke test.
12. Node-RED low-power verification confirms no active debug nodes, no disabled
    development/simulation tabs in the shipped payload, and one MQTT ingress
    subscription for `application/+/device/+/event/up`.
13. Low-power OpenWrt config audits and disables safe-to-drop kernel debug/crash
    options, including debugfs, KALLSYMS, debug kernel, debug info, kexec, crash
    dump, and vmcore/kcore where the bcm2709 target still boots and verifies.

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
9. CPU governor/frequency defaults do not break local GUI/API responsiveness,
   scheduled irrigation checks, ChirpStack uplink processing, or STREGA command
   handling during a field acceptance run.

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
8. Outside the window, cloud sync timers do not make network attempts; they
   leave pending work queued locally.
9. During the window, bootstrap sync, outbox flush, pending-command polling,
   command ACK flush, cloud MQTT, calibration lookup, and weather fetches run
   through the Puli route.
10. Outside the window, the Pi Ethernet path connected to the Puli is down and
    Pi USB VBUS is off.
11. In-window sync cadence changes are not accepted without measurement evidence
    and an explicit review of command-latency and cloud-sync contract effects.

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
