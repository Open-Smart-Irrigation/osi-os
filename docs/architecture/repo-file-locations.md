# Repository file locations and edge data stores

Where the main edge files live in this repository, plus three edge data
stores that `AGENTS.md` used to describe inline. The material moved out of
`AGENTS.md` on 2026-10-22; `AGENTS.md` keeps the on-Pi paths and the profile
parity invariant, and this page carries the same authority.

## In the repo

| What | Path |
|------|------|
| Node-RED flows | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` |
| Seed database | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db` |
| Bootstrap init | `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap` |
| React source | `web/react-gui/src/` |
| Node-RED settings | `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` |
| Sync verifier | `scripts/verify-sync-flow.js` |

## Raspberry Pi image

Full Raspberry Pi image workflow: [docs/build/rpi5-full-osi-image.md](../build/rpi5-full-osi-image.md). Current Pi 5 and Pi 4/400/3/2 release images use `CONFIG_TARGET_ROOTFS_PARTSIZE=14336` so the writable overlay fits 16GB-class SD cards. Path B images also ship a one-shot rootfs grow path (`90_osi_rootfs_grow` + `osi-rootfs-resize`) that uses `parted resizepart`, reboots, then retries `resize2fs` until the mounted filesystem grows successfully. The workflow assumes concentratord is manually configured/enabled after flashing. Chameleon calibration rows may be absent from the OSI OS seed DB because the authoritative calibration source and admin token live on OSI Server; image completeness is gated on schema, helper, GUI, refresh endpoint, sync worker, and runtime calibration lookup support.

## Journal V2 media cache

`osi-server.cloud.journal_photo_cache_bytes`, `journal_min_free_bytes`, and `journal_media_root` are durable UCI settings. `node-red.init` refuses startup unless the byte values are positive safe integers and the media root is an exact canonical non-symlink directory. The worker creates only UUID-derived files below that root; see `osi-config-and-flags` for the full map.

## Provider weather store

Provider weather (temperature, humidity, rain, wind, radiation, ET0) is stored per farm location and completed UTC hour in `weather_locations` / `weather_provider_hours` by the `weather-provider-fn` tick (30 min); the provider is UCI `osi-server.cloud.weather_provider_default` (`open_meteo` | `meteoswiss`) unless a zone's `weather_source` overrides it. The hourly tables do not sync and each side fetches for itself; a zone's `weather_source` travels in the zone events and snapshots, and after sub-project 4 the edge owns it. An already-provisioned gateway keeps its value because uci-defaults do not re-run; switch one with `uci set osi-server.cloud.weather_provider_default=meteoswiss && uci commit osi-server && /etc/init.d/node-red restart` (a new location key, so the store backfills again under the new provider).

Chained off the same tick, `osi-agronomy-daily` writes one `zone_daily_agronomy` row per zone per completed local day, with ET0 from the first complete of three tiers (the hourly FAO-56 Penman-Monteith sum over a local station's complete hours, `et0_source = 'fao56_hourly'`; the stored provider hours summed; or Hargreaves-Samani from the station's daily min/max) and a Kc from the FAO-56 catalogue in `docs/contracts/agronomy/`, on the FAO-56 curve when the zone has a stage start date. The rows replicate to OSI Server as `ZONE_AGRONOMY_UPSERTED` (migration 0067) and in the bootstrap's `zoneAgronomy` list (the last 30 days of each zone). A SenseCAP S2120 assigned to a zone (`weather_station_zones`) is aggregated into `weather_station_hours` by `osi-station-hours` and gives the station tier its inputs, including radiation from `light_lux / luxPerWm2`.
