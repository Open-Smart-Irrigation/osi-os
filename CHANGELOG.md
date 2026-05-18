# Changelog

All notable changes to OSI OS are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
