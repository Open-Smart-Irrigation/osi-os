# Changelog

All notable changes to OSI OS are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.7.0] — 2026-07-13

### Added
- **Daily-analytics sync versioning** (migration `0015__upsert_sync_versioning.sql`): `dendrometer_daily`, `zone_daily_recommendations`, and `zone_daily_environment` gain a `sync_version` column; their outbox triggers now pass `NEW.sync_version` instead of a literal `0`.
- **Device chameleon sync** (migration `0016__device_chameleon_sync.sql`): `chameleon_enabled` and the three `chameleon_swt{1,2,3}_depth_cm` columns join `trg_sync_devices_outbox_au`'s change-detection and payload, so a Chameleon-enabled LSN50 no longer appears as a plain LSN50 in the cloud.
- `verify-flows-fn-parse` CI gate: parse-checks every function node's source across all three flow profiles and fails on a syntax error a compiled Node-RED node would otherwise swallow silently.
- `verify-boot-ddl-interpolation.js` CI gate: executes `sync-init-fn`'s boot-DDL statement array against a scratch DB and fails on a broken string interpolation or a sync-versioning regression in any trigger.
- GUI favicon (`/gui/favicon.png`, derived from the existing OSI logo asset) — browsers no longer log a 404 on `/favicon.ico`.

### Changed
- `firmware_version` UCI default bumped `0.6.5` → `0.7.0`; the GUI login screen, `README.md`, and `docs/versioning-workflow.md` version strings updated to match.
- Pipeline verification checks (`routes.py`, `errors.py`, `schema.py`, `gui.py`, `canary.py`) hardened against silent false passes: probed routes now match the shipped route table, error/staleness counts come from real on-disk signals instead of a nonexistent table, and a missing Playwright or admin token now fails the gate instead of skipping it quietly.
- `sqlite3-cli` enabled in every full-image `.config` profile (`deploy.sh` previously depended on internet access to self-heal it via `opkg`).
- `commands.schema.json`'s `command_type` enum gained `UC512_OPEN_FOR_DURATION`, matching the duration-bound actuator entry already present in the flow's command-type registry, with the same `duration_seconds` payload constraint as `OPEN_FOR_DURATION`.

### Fixed
- Daily-analytics writers (`dendro-compute-fn`, `sim-dendro-fn-setup`, and the LSN50/S2120/LoRain zone-aggregation nodes) now bump `sync_version` on every rewrite, so a recompute no longer collides with the cloud's per-resource watermark (`equal_version_payload_conflict`).
- Boot-DDL string-interpolation bug in `sync-init-fn`: two trigger DDL strings shipped the literal text `+ gatewaySql +` instead of interpolating the gateway EUI.
- `dendro-raw-fn` (`GET /api/dendrometer/:deveui/readings`) hung indefinitely because a corrupted regex made Node-RED unable to compile the node.
- `device-api-http500` returned a hardcoded 500 on every failure, including unauthenticated requests, discarding the thrown 401 from `verifyBearer`.
- Chameleon enable-toggle endpoint (`put-chameleon-enabled-auth-fn`) now bumps `devices.sync_version`, so a toggle after the first delivered `DEVICE` event reaches the cloud instead of being rejected.
- Reference-tree toggle endpoint (`dendro-ref-tree-fn`) now bumps `devices.sync_version`, the same defect class as the chameleon fix above.

---

## [0.6.5] — 2026-05-18

### Added
- **Auto-provision on first boot** (`osi-bootstrap` init script, START=99): ChirpStack apps, device profiles, MQTT credentials, and UCI identity fields are written automatically without manual intervention.
- **IPv4-forced cloud REST** (`osi-cloud-http` module): all cloud sync HTTP calls explicitly bind to IPv4 (`family: 4`) to avoid DNS resolution falling back to unreachable IPv6 addresses in dual-stack environments.
- **Chameleon SWT integration** (TEKTELIC LSN50 dendrometer): per-device polynomial calibration coefficients (`chameleon_swt{1,2,3}_{depth_cm,a,b,c}`), `chameleon_readings` table, and calibration UI in the device settings panel.
- **Mosquitto ownership fix** in `deploy.sh`: `passwd`, `acl`, and `/var/lib/mosquitto/` are chowned to the mosquitto service user on every deploy, preventing broker startup failures after upgrades.
- `verify-db-schema-consistency.js` script to catch seed DB / live DB drift at development time.
- `scripts/session-closeout.sh` repo health check script.

### Changed
- Seed database (`seed-blank.sql` and bundled `farming.db`) is now built from a clean schema with all current tables — no demo data, no stale columns.
- `deploy.sh` preserves the live `/data/db/farming.db` unconditionally; seeding only happens when the file is absent on a fresh device.
- React GUI login screen version string updated to v0.6.5.

### Fixed
- `deploy.sh` now deploys the `osi-cloud-http` module directory (was missing, leaving a broken `node_modules` symlink).
- Duplicate `normalizeTriggerMetric` function in `ScheduleSection.tsx` removed (merge artifact from chameleon-swt integration).
- Post-merge schema sync: chameleon calibration columns added to all farming.db copies and `seed-blank.sql`.

---

## [0.6.0] — 2026-04-22

### Added
- Initial public release on Raspberry Pi 5 (`bcm2712`).
- ChirpStack LoRaWAN network server integration with KIWI, STREGA, LSN50, S2120, CLOVER device support.
- Node-RED backend: REST API, irrigation scheduler, dendrometer analytics, bidirectional sync.
- React farmer dashboard: login, device cards, schedule editor, dendrometer graph.
- SQLite local database with offline-first operation.
- Bidirectional cloud sync via REST polling (30 s outbox, 6 h bootstrap).
- HMAC-signed local auth tokens; bcrypt-hashed passwords; gateway-specific offline verifier for linked accounts.
- SenseCAP S2120 8-in-1 weather station support with multi-zone junction table.

---
