# 02 — Edge gateway

[← Index](README.md) · [→ Edge backend](03-edge-backend-flows.md)

## Base system and build profiles

OSI OS is OpenWrt 24.10 with two git submodules: the OpenWrt source under
[openwrt/](../../../openwrt) and the ChirpStack/Node-RED packaging feed under
[feeds/chirpstack-openwrt-feed/](../../../feeds/chirpstack-openwrt-feed)
(see [.gitmodules](../../../.gitmodules)). All OSI-specific runtime content is
a per-profile file overlay under [conf/](../../../conf), copied into the image
at build time.

| Profile | Target | Status |
|---|---|---|
| `conf/full_raspberrypi_bcm27xx_bcm2712/` | Pi 5 (`DEVICE_rpi-5`) | Canonical. Every payload file is edited here first. |
| `conf/full_raspberrypi_bcm27xx_bcm2709/` | Pi 4/400/3/2 (`DEVICE_rpi-2`) | Byte-for-byte mirror, enforced by `scripts/verify-profile-parity.js`. |
| `conf/full_raspberrypi_bcm27xx_bcm2708/` | Pi 1/Zero | Legacy; still covered by the MQTT topic check. |
| `conf/base_raspberrypi_bcm27xx_*` | both | Minimal variants without the application payload. |

Release images set `CONFIG_TARGET_ROOTFS_PARTSIZE=14336` so the overlay fits
16 GB SD cards, then grow the filesystem on first boot (below). Build
procedure: chapter [08](08-operations.md).

## Service inventory

| Service | Function | Interface | Source |
|---|---|---|---|
| ChirpStack | LoRaWAN network server: OTAA join handling, uplink decrypt/dedupe, downlink queue, device/profile registry. | `:8080` HTTP + gRPC; publishes to local broker | ChirpStack feed; provisioned by `chirpstack-bootstrap.js` |
| ChirpStack Concentratord | Driver for the SX130x concentrator HAT. Configured manually per gateway after flashing. | UDS to ChirpStack | ChirpStack feed |
| Mosquitto | Local MQTT broker between ChirpStack and Node-RED. | localhost | `files/etc/mosquitto/mosquitto.conf` |
| Redis | ChirpStack dependency (device sessions, dedupe state). | localhost | `files/etc/redis.conf`, `files/etc/init.d/redis` |
| Node-RED | Application backend and web server; executes flows.json; serves the GUI. | `:1880` (`/api`, `/gui`) | settings: `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` |

Key `settings.js` values: `flowFile: "flows.json"`, `userDir: "/srv/node-red"`,
`httpStatic: '/usr/lib/node-red/gui'` with `httpStaticRoot: '/gui'`, and
`functionExternalModules: true` (required for function-node `libs` bindings,
chapter [03](03-edge-backend-flows.md)). `functionGlobalContext` preloads
`os`, `fs`, and `child_process` for samplers.

Boot-time one-shot services in `files/etc/init.d/`:

| Init script | START | Behavior |
|---|---|---|
| `osi-db-integrity` | 90 | Runs `/usr/share/node-red/osi-db-integrity/index.js` before Node-RED; logs SQLite integrity verdicts to syslog; never blocks boot. |
| `osi-bootstrap` | 99 | First-boot ChirpStack provisioning; later boots validate the stamp and exit (next section). |
| `osi-rootfs-resize` | — | Second half of the rootfs grow: retries `resize2fs` after the `parted resizepart` + reboot performed by the uci-defaults hook. |

`files/etc/nginx/restrict_locally` is an nginx allow-list include
(RFC1918 ranges, loopback, link-local, and the Tailscale CGNAT block
`100.64.0.0/10`; `deny all` otherwise) for services that must not be reachable
from public interfaces.

## First-boot provisioning

OpenWrt executes `files/etc/uci-defaults/` scripts once, in lexical order:

| Script | Effect |
|---|---|
| `90_osi_rootfs_grow` | Arms the partition grow (`parted resizepart` + reboot; `osi-rootfs-resize` finishes with `resize2fs`). |
| `95_osi_bootstrap_enable` | Enables the `osi-bootstrap` init script. |
| `96_osi_server_config` | Writes UCI `osi-server.cloud.*` (cloud base URL, gateway identity). |
| `97_osi_db_seed` | Copies the bundled seed DB to `/data/db/farming.db` if absent. |
| `98_osi_node_red_seed` | Seeds `/srv/node-red/` with flows.json and workspace files. |
| `99_config_chirpstack_ap`, `99_set_hostname`, `99_set_sx1301_gateway_id`, `99_tailscale_init` | Radio and network identity: AP config, hostname, LoRa gateway ID, Tailscale enrollment. |

`osi-bootstrap` then waits up to ~72 s for ChirpStack's HTTP interface and
runs `files/usr/share/node-red/chirpstack-bootstrap.js`, which creates the
tenant, the `Sensors` and `Actuators` applications, and one device profile
per supported family, then writes the resulting IDs to
`/srv/node-red/.chirpstack.env`. Success stamps `/etc/osi-bootstrap.done`.
`stamp_valid()` also requires a plausible `CHIRPSTACK_APP_SENSORS` UUID in the
env file, so a partial provisioning reruns on the next boot instead of being
trusted.

Because application UUIDs differ per installation, device-type discrimination
happens after MQTT receipt, via `CHIRPSTACK_PROFILE_*` environment variables
with `deviceProfileName` fallback (catalog in the `osi-config-and-flags`
skill). A stale `.chirpstack.env` carrying `DEVICE_EUI*` overrides runtime
identity and must be removed during repair (AGENTS.md, live-deploy rules).

## Identity and location

The gateway EUI (16 uppercase hex characters) identifies the device in sync
URLs, MQTT topics, and the cloud account link. Canonical resolution is
`files/usr/libexec/osi-gateway-identity.sh` plus UCI `osi-server.cloud.*`.
GPS input (`files/etc/config/gpsd`, `files/etc/config/osi-gateway-gps`) feeds
the `gateway_locations` table, which syncs to the cloud through its own
applier.

## File layout

On a provisioned Pi:

| Path | Content |
|---|---|
| `/srv/node-red/flows.json` | Active flow file (backend). |
| `/srv/node-red/settings.js`, `flows_cred.json` | Runtime settings; encrypted cloud MQTT credentials after linking. |
| `/srv/node-red/.chirpstack.env` | Bootstrap results (application/profile IDs). |
| `/data/db/farming.db` | Canonical state. WAL mode; sidecars must never be orphaned by manual copies. |
| `/usr/lib/node-red/gui/` | Built GUI bundle, served at `:1880/gui`. |
| `/usr/share/node-red/` | Helper modules (`osi-*`), codecs, bootstrap script (read-only ROM copy). |
| `/data/backups/migrate/` | Pre-migration backups written by the deploy runner. |

In the repo, the same payload lives under
`conf/full_raspberrypi_bcm27xx_bcm2712/files/` with identical relative paths
(`usr/share/flows.json`, `usr/share/db/farming.db`, `usr/share/node-red/…`,
`etc/init.d/…`, `etc/uci-defaults/…`).
