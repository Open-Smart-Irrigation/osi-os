# Chameleon calibration global table

Edge detail for the Chameleon calibration store. It moved out of `AGENTS.md`
on 2026-10-22; `AGENTS.md` keeps the wiring rule, the SWT history repair rule
and the release steps, and this page carries the same authority. Sensor
semantics: the `osi-agronomy-sensors-reference` skill.

- `chameleon_calibrations` — keyed by `array_id` (uppercase 16-char hex). Source via.farm; bundled into firmware seed before release.
- `chameleon_calibration_misses` — negative cache (24h TTL) for unknown array_ids.
- `chameleon_readings.calibration_status` — `'calibrated'`, `'pending'`, or `'unknown'`.
- **LSN50 Chameleon wiring:** when SDA/SCL are connected directly to the LSN50 STM32 I2C pins, power the VIA Chameleon I2C reader from LSN50 `VDD` (same 3.3-3.6 V rail as the bus). Do **not** power it from switched 5 V unless a proper bidirectional I2C level shifter and power isolation are added; the reader pull-ups follow VCC and switched-off 5 V can leave the board back-powered through SDA/SCL. See the field incident analysis in [docs/hardware/chameleon-reference.md](../hardware/chameleon-reference.md#field-incident-reader-powered-from-a-different-rail-than-the-bus).
- **Edge endpoints:** `POST /api/devices/:deveui/chameleon/refresh-calibration` (sync worker fetches from cloud), `PUT /api/devices/:deveui/chameleon/depth` (depth-only save, replaces old chameleon-config).
- **Node-RED sync worker** queries missing calibrations every 30s alongside pending commands, fetches from `/api/v1/sync/chameleon/calibrations/lookup`, persists locally, and runs local backfill.
- **Removed:** `PUT /api/devices/:deveui/chameleon-config` endpoint and the 9 per-device coefficient columns (`chameleon_swt[123]_[abc]`). Depth columns (`chameleon_swt[123]_depth_cm`) stay.
- Per-device calibration values entered by hand are discarded in the 2026-05-19 migration. Operators verify post-upgrade that each live array_id has a row in `chameleon_calibrations`.
- Chameleon SWT analysis reads canonical kPa values from `device_data.swt_1`, `swt_2`, and `swt_3`. `chameleon_readings` is the raw/diagnostic mirror. If historical SWT values are repaired from `chameleon_readings` plus `chameleon_calibrations`, update `device_data` too. Historical repairs that UPDATE `device_data` rows are carried by the `trg_sync_device_data_dirty_au` trigger → `sync_history_dirty_keys` → history correction phase. Do not enqueue explicit `DEVICE_DATA_APPENDED` events for them: every such event has `sync_version` 0, and the cloud rejects a changed payload at an equal version as `equal_version_payload_conflict`. Update by row `id`: `device_data` has no UNIQUE(deveui, recorded_at).
- **Release script:** `OSI_ADMIN_TOKEN=… node scripts/refresh-chameleon-calibrations.js` before cutting a release.
- Apply the generated release seed with `node scripts/apply-chameleon-calibration-seed.js`; it updates every bundled DB copy and fails on an empty calibration snapshot.
