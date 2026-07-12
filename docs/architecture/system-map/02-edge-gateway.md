# 02 — Edge Gateway (the Pi)

[← Index](README.md) · [→ Edge backend](03-edge-backend-flows.md)

This chapter describes the gateway box itself: the operating system, the services
that run on it, how a factory-fresh device turns itself into a working farm
gateway on first boot, and where everything lives, both in this repo and on a
live device.

## Operating system and build profiles

OSI OS is a customized **OpenWrt 24.10** Linux (the same OS family used in
routers: small, reliable, and happy to run from an SD card). The stock OpenWrt source lives
as a git submodule under [openwrt/](../../../openwrt), and ChirpStack/Node-RED
packaging comes from a second submodule feed,
[feeds/chirpstack-openwrt-feed/](../../../feeds/chirpstack-openwrt-feed)
(declared in [.gitmodules](../../../.gitmodules)).

Everything OSI adds on top is an **overlay of files** copied into the image at
build time, one directory per hardware profile under [conf/](../../../conf):

| Profile directory | Hardware | Role |
|---|---|---|
| `conf/full_raspberrypi_bcm27xx_bcm2712/` | Raspberry Pi 5 | **Canonical source of truth**: every runtime file is edited here first. |
| `conf/full_raspberrypi_bcm27xx_bcm2709/` | Pi 4 / 400 / 3 / 2 | Byte-for-byte **mirror** of the canonical payload (enforced by `scripts/verify-profile-parity.js`). |
| `conf/full_raspberrypi_bcm27xx_bcm2708/` | Pi 1 / Zero (legacy) | Historical; still carries a flow copy checked by the MQTT topic guard. |
| `conf/base_raspberrypi_bcm27xx_*` | — | Minimal "base" image variants (no full app payload). |

Building the image is covered in chapter [08](08-operations.md) and in
[docs/build/building-firmware.md](../../build/building-firmware.md).

## What runs on a live gateway

The Pi runs five long-lived services, each with one clearly defined job:

| Service | Plain-language job | Listens on | Config in repo |
|---|---|---|---|
| **ChirpStack** | The radio receptionist. Speaks LoRaWAN with the field devices: receives sensor uplinks, encrypts/queues valve downlinks, manages device registrations. | `:8080` (web/API) | Provisioned at first boot by `chirpstack-bootstrap.js` (below); packaged via the ChirpStack feed. |
| **ChirpStack Concentratord** | The radio chip driver; it talks to the physical LoRa concentrator HAT. Configured manually per gateway after flashing. | — | ChirpStack feed. |
| **Mosquitto** | The building's internal message bus (MQTT broker). ChirpStack publishes every received radio message here; Node-RED subscribes. | local MQTT | `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/mosquitto/mosquitto.conf` |
| **Redis** | A small in-memory notepad ChirpStack needs for its own bookkeeping. | local | `files/etc/redis.conf`, init script `files/etc/init.d/redis` |
| **Node-RED** | The gateway's brain and web server: the entire local backend (REST API, scheduler, sync) *and* the host of the farmer dashboard. Chapter [03](03-edge-backend-flows.md). | `:1880` (API + `/gui`) | Settings: `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`; flow file: `files/usr/share/flows.json` |

Plus three one-shot **boot services** (OpenWrt init scripts in
`conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/`):

| Init script | Plain-language job |
|---|---|
| `osi-bootstrap` (START=99) | First-boot self-provisioning (see next section). On later boots it checks its "done" stamp and exits immediately. |
| `osi-db-integrity` (START=90) | Before Node-RED starts, runs a database health check (`/usr/share/node-red/osi-db-integrity/index.js`) that detects SD-card corruption early and logs the verdict; boot always continues. |
| `osi-rootfs-resize` | Part of the one-shot "grow the filesystem to fill the SD card" path (with `files/etc/uci-defaults/90_osi_rootfs_grow`): resizes the partition, reboots, then grows the filesystem. |

There is also a small **nginx access snippet**,
`files/etc/nginx/restrict_locally`, an allow-list that restricts whatever
includes it to private/LAN and Tailscale address ranges, i.e. "local visitors
only, no public internet".

## First boot: how a blank SD card becomes a farm gateway

OpenWrt runs every script in `files/etc/uci-defaults/` exactly once on first
boot (alphabetical order), then deletes them. OSI uses them as a checklist:

| Script (in `files/etc/uci-defaults/`) | What it does, in order |
|---|---|
| `90_osi_rootfs_grow` | Arms the one-shot root filesystem grow so the OS can use the whole SD card. |
| `95_osi_bootstrap_enable` | Enables the `osi-bootstrap` service for the next stage. |
| `96_osi_server_config` | Creates the gateway's cloud identity config (UCI `osi-server.cloud.*`: server URL, gateway EUI). |
| `97_osi_db_seed` | Copies the bundled blank farm database to its live home `/data/db/farming.db`, but only if none exists. |
| `98_osi_node_red_seed` | Copies the flow file and Node-RED workspace into `/srv/node-red/`. |
| `99_config_chirpstack_ap`, `99_set_hostname`, `99_set_sx1301_gateway_id`, `99_tailscale_init` | Radio/network identity: ChirpStack access point config, hostname, LoRa gateway ID, and Tailscale (private VPN used for remote maintenance). |

Then `osi-bootstrap` runs (init script
`files/etc/init.d/osi-bootstrap`). It waits for ChirpStack to come up, then
executes **`chirpstack-bootstrap.js`**
(`files/usr/share/node-red/chirpstack-bootstrap.js`), which acts like a
registrar: it creates the ChirpStack tenant, the two applications
(**Sensors** and **Actuators**), and one **device profile** per supported
device family (Kiwi, LSN50, S2120, LoRain, STREGA, UC512), then writes the
resulting IDs into `/srv/node-red/.chirpstack.env` so the Node-RED flows can
find them. A stamp file `/etc/osi-bootstrap.done` marks success; the stamp is
only trusted if the env file still contains a valid application ID, so a
half-finished provisioning retries on the next boot.

Because every installation generates **fresh application IDs**, nothing in the
flows may hardcode them; all radio subscriptions use the wildcard topic
`application/+/device/+/event/up` and identify device types afterwards
(rule enforced by `scripts/check-mqtt-topics.sh`).

## Gateway identity

Each gateway is identified everywhere (cloud account, MQTT topics, sync API) by
its **EUI**: a 16-character hardware ID derived from the Pi. The helper
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh`
is the canonical resolver; the value also lives in UCI config
(`uci show osi-server`). GPS support (`files/etc/config/gpsd`,
`files/etc/config/osi-gateway-gps`) lets a gateway report its physical location,
stored in the `gateway_locations` table and synced to the cloud.

## File locations cheat sheet

### On a live Pi

| What | Path on the device |
|---|---|
| Node-RED flow file (the backend) | `/srv/node-red/flows.json` |
| Farm database | `/data/db/farming.db` |
| Farmer dashboard (built files) | `/usr/lib/node-red/gui/` (served at `http://<pi>:1880/gui`) |
| Node-RED settings | `/srv/node-red/settings.js` |
| Cloud MQTT credentials (after account link) | `/srv/node-red/flows_cred.json` |
| ChirpStack provisioning results | `/srv/node-red/.chirpstack.env` |
| Cloud identity | UCI `osi-server.cloud.*` |
| Shared helper modules + decoders | `/usr/share/node-red/` |
| Migration backups (deploy-time) | `/data/backups/migrate/` |

### In this repo (canonical profile)

All under `conf/full_raspberrypi_bcm27xx_bcm2712/files/`:

| What | Path fragment |
|---|---|
| Flow file | `usr/share/flows.json` |
| Seed database | `usr/share/db/farming.db` |
| Decoders (payload translators) | `usr/share/node-red/codecs/` |
| Shared helper modules (`osi-*`) | `usr/share/node-red/osi-*/` |
| First-boot provisioning | `usr/share/node-red/chirpstack-bootstrap.js` |
| Boot services | `etc/init.d/` |
| One-shot first-boot scripts | `etc/uci-defaults/` |

Node-RED's own settings (which tie all of this together: flow file name,
GUI static path `/gui`, permission for function nodes to load the `osi-*` helper
modules) live in the feed:
[feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js](../../../feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js).
