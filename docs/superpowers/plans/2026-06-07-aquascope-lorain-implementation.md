# Aqua-Scope LoRain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Aqua-Scope LoRain / `RANLWE01` rain gauge to OSI OS from ChirpStack provisioning through local Node-RED ingestion, edge/cloud telemetry sync, zone rain aggregation, and React dashboard rendering.

**Architecture:** LoRain is a static device integration, consistent with `docs/adr/2026-05-28-static-device-plugin-registry.md`. The device is provisioned into the existing ChirpStack `Sensors` application with a new device profile and JavaScript codec. Node-RED ingests LoRain uplinks from the wildcard ChirpStack MQTT topic, persists rain telemetry into existing `device_data` rain columns, aggregates assigned-gauge rainfall into `zone_daily_environment`, and exposes the device through the existing device catalog and dashboard card model. No plugin registry or live Pi database replacement is introduced.

**Tech Stack:** Node.js scripts, Node-RED `flows.json`, ChirpStack bootstrap helper, SQLite seed/bundled databases, React + TypeScript GUI, Vitest/frontend build verification.

**External Device Facts To Encode:**
- Model: Aqua-Scope LoRain rain gauge, `RANLWE01`.
- Join mode: OTAA, LoRaWAN `1.0.3`, Class A.
- Current public onboarding docs use FPort `10`; the public firmware repository still defines FPort `2`, so the decoder must accept both `10` and `2`.
- JoinEUI/AppEUI: `4943485448592021`.
- DevEUI is printed on the package/device QR. AppKey is retrieved from Aqua-Scope using DevEUI and email.
- Payload rain field is command `0x06 0x81`, one tip equals `0.5` mm. Battery voltage is command `0x12`, first value byte divided by `10`.

## Implementation Tasks

### 1. Add A Failing Codec Contract

- [ ] Create `scripts/verify-lorain-codec.js`.

  The script must load the codec from:

  ```js
  const CODEC_PATH = path.join(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js');
  ```

  Use `fs.readFileSync`, `vm.createContext`, and `vm.runInContext`, matching the style used by existing codec verification scripts.

- [ ] In `scripts/verify-lorain-codec.js`, assert that `decodeUplink` exists and returns decoded data for FPort `10`.

  Use this sample payload:

  ```js
  const sample = [0x06, 0x81, 0x00, 0x03, 0x06, 0x01, 0x08, 0x05, 0x12, 0x21, 0x00, 0x0a];
  ```

  Expected decoded fields:

  ```js
  {
    rain_tips_delta: 3,
    rain_mm_delta: 1.5,
    rainlevel: 1.5,
    ambient_temperature: 20.5,
    temperature_C: 20.5,
    bat_v: 3.3,
    bat_mAh: 10
  }
  ```

- [ ] Add assertions that FPort `2` decodes the same sample and FPort `5` returns an error.

- [ ] Run the failing test:

  ```bash
  node scripts/verify-lorain-codec.js
  ```

  Expected result before implementation: failure because `aquascope_lorain_decoder.js` does not exist.

### 2. Implement And Bundle The LoRain Codec

- [ ] Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js`.

  Export ChirpStack-compatible `decodeUplink(input)`. Keep the file self-contained and ASCII-only.

- [ ] Implement command parsing for the fields OSI OS needs:

  ```js
  function round(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  function readU16(bytes, index) {
    return (((bytes[index] || 0) << 8) | (bytes[index + 1] || 0)) >>> 0;
  }

  function readSignedTenths(raw) {
    return raw < 0x4000 ? raw / 10 : (raw - 0x10000) / 10;
  }
  ```

  Required command behavior:
  - `0x06 0x81`: raw tip count, set `rain_tips_delta`, `rain_mm_delta = tips * 0.5`, and TTN-compatible `rainlevel`.
  - `0x06 0x01`: signed tenths Celsius, set `ambient_temperature` and TTN-compatible `temperature_C`.
  - `0x06 0x03`: uptime seconds, set `uptime_seconds`.
  - `0x12`: battery block, set `bat_v = firstValueByte / 10` and `bat_mAh` from the next two bytes when present.
  - Unknown commands: append a warning and continue parsing.

- [ ] Validate FPort:

  ```js
  const fPort = Number(input.fPort);
  if (fPort !== 10 && fPort !== 2) {
    return { data: {}, warnings: [], errors: ['LoRain uplinks are expected on FPort 10 or legacy FPort 2'] };
  }
  ```

- [ ] Copy the codec byte-for-byte to the profile parity tree:

  ```bash
  cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js \
     conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js
  ```

- [ ] Run:

  ```bash
  node scripts/verify-lorain-codec.js
  ```

  Expected result after implementation: all LoRain codec assertions pass.

### 3. Register The ChirpStack Profile In Bootstrap

- [ ] Update `scripts/chirpstack-bootstrap.js`.

  Add config values:

  ```js
  profileLorainName: process.env.CS_PROFILE_LORAIN_NAME || 'OSI Aqua-Scope LoRain',
  lorainCodecPath: process.env.LORAIN_CODEC_PATH || '/usr/share/node-red/codecs/aquascope_lorain_decoder.js',
  ```

- [ ] In `toUciCloudKey`, add:

  ```js
  CHIRPSTACK_PROFILE_LORAIN: 'chirpstack_profile_lorain',
  ```

- [ ] In the profile creation section, load the codec and create the profile:

  ```js
  const lorainCodecScript = readCodecScript(CFG.lorainCodecPath, 'LoRain');
  const lorainProfileId = await getOrCreateProfileWithCodec(
    client,
    tenantId,
    CFG.profileLorainName,
    'Aqua-Scope LoRain RANLWE01 rain gauge (LoRaWAN 1.0.3 OTAA)',
    lorainCodecScript
  );
  ```

- [ ] Add the profile to the emitted environment:

  ```js
  CHIRPSTACK_PROFILE_LORAIN: lorainProfileId,
  ```

- [ ] Add a log line in the final profile summary for `LoRain`.

- [ ] Apply the same `chirpstack-bootstrap.js` changes byte-for-byte to both bundled profile paths:

  ```bash
  cp scripts/chirpstack-bootstrap.js \
     conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js
  cp scripts/chirpstack-bootstrap.js \
     conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js
  ```

- [ ] Update `deploy.sh` so the codec is copied to `/srv/node-red/codecs/aquascope_lorain_decoder.js` with the existing codec deployment block.

- [ ] Update `scripts/verify-sync-flow.js` with assertions for:
  - `CFG.lorainCodecPath`.
  - `CS_PROFILE_LORAIN_NAME`.
  - `CHIRPSTACK_PROFILE_LORAIN`.
  - `LORAIN_CODEC_PATH`.
  - `/usr/share/node-red/codecs/aquascope_lorain_decoder.js`.
  - `deploy.sh` copy of `aquascope_lorain_decoder.js`.

### 4. Add Device Type To Schema, Repair, And Catalog

- [ ] Update the `devices.type_id` `CHECK` constraint in `database/seed-blank.sql` to include:

  ```sql
  'AQUASCOPE_LORAIN'
  ```

- [ ] Update `scripts/repair-pi-schema.js` with an idempotent `ensureDeviceTypeCheckIncludesLorain(db)` helper.

  Requirements:
  - Inspect `sqlite_master.sql` for table `devices`.
  - Return without changes when `AQUASCOPE_LORAIN` already appears.
  - Rebuild only the `devices` table when missing.
  - Preserve every existing row and column value.
  - Keep the existing `devices` columns, defaults, foreign keys, and indexes.
  - Do not delete or recreate unrelated tables.

- [ ] Add a schema check in `scripts/verify-db-schema-consistency.js` that fails unless every bundled database and `database/seed-blank.sql` include `AQUASCOPE_LORAIN` in the `devices.type_id` constraint.

- [ ] Run the repair against every bundled SQLite database, preserving bundled calibration rows:

  ```bash
  node scripts/repair-pi-schema.js database/farming.db
  node scripts/repair-pi-schema.js web/react-gui/farming.db
  node scripts/repair-pi-schema.js conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
  node scripts/repair-pi-schema.js conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
  node scripts/repair-pi-schema.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
  node scripts/repair-pi-schema.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
  ```

- [ ] Update the `/api/catalog` `catalog-response` function in both bundled `flows.json` files:

  ```js
  { id: 'AQUASCOPE_LORAIN', name: 'Aqua-Scope LoRain Rain Gauge' }
  ```

- [ ] Update local registration maps in the `Insert or Claim Device` function in both bundled `flows.json` files:

  ```js
  appMap.AQUASCOPE_LORAIN = 'CHIRPSTACK_APP_SENSORS';
  profileMap.AQUASCOPE_LORAIN = 'CHIRPSTACK_PROFILE_LORAIN';
  ```

  Add conditional JoinEUI assignment for LoRain:

  ```js
  if (type_id === 'AQUASCOPE_LORAIN') {
    msg.deviceRegistration.joinEui = '4943485448592021';
  }
  ```

- [ ] Update cloud-originated `REGISTER_DEVICE` ChirpStack registration mapping in both bundled `flows.json` files with the same application, profile, and JoinEUI behavior.

### 5. Add Node-RED LoRain Ingest

- [ ] In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, add a LoRain ingest branch. Use new node IDs prefixed with `lorain-`.

- [ ] The LoRain MQTT input node must subscribe to:

  ```text
  application/+/device/+/event/up
  ```

  This is required by `scripts/check-mqtt-topics.sh`.

- [ ] Add `lorain-process-fn` with two outputs: SQL insert and zone rain aggregation.

  Required branch guards:
  - Parse string payloads with `JSON.parse`.
  - Read `deviceInfo.deviceProfileId`, `deviceInfo.deviceProfileName`, `deviceInfo.devEui`, and `data.object`.
  - Accept only profile ID `global.get('CHIRPSTACK_PROFILE_LORAIN')` or profile names containing `LORAIN` / `AQUA-SCOPE`.
  - Query local `devices` by DevEUI and return early unless `type_id === 'AQUASCOPE_LORAIN'`.

- [ ] In `lorain-process-fn`, treat LoRain rain as interval rainfall, not as a cumulative counter.

  Required calculations:
  - `rainMmDelta = Number(object.rain_mm_delta ?? object.rainlevel)`.
  - `rainTipsDelta = Number(object.rain_tips_delta)` when available.
  - `recorded_at` from ChirpStack uplink time, falling back to `new Date().toISOString()`.
  - Look up the previous LoRain rain sample for the same DevEUI.
  - If previous sample timestamp is equal or later than the current timestamp, set `rain_delta_status = 'duplicate_or_out_of_order'`, do not aggregate rainfall, and either skip insert or insert with `rain_mm_delta = 0` matching the existing S2120 duplicate policy.
  - If no previous sample exists, persist the current `rain_mm_delta` and set `counter_interval_seconds = null`; do not fabricate a rate.
  - If a previous sample exists, calculate `counter_interval_seconds`, `rain_mm_per_hour`, and `rain_mm_per_10min`.
  - Calculate `rain_mm_today` by summing stored LoRain `rain_mm_delta` rows for the local day plus the current delta.
  - Set `rain_delta_status = 'ok'` when the uplink has a valid rain field and is not duplicate/out-of-order.

- [ ] Add `lorain-sql-fn` to insert into existing `device_data` columns:

  ```sql
  deveui,
  recorded_at,
  ambient_temperature,
  bat_v,
  rain_tips_delta,
  rain_mm_delta,
  rain_mm_per_hour,
  rain_mm_per_10min,
  rain_mm_today,
  counter_interval_seconds,
  rain_delta_status
  ```

- [ ] Add `lorain-rain-agg-fn` to aggregate assigned LoRain rainfall into `zone_daily_environment`.

  Required behavior:
  - Resolve `zone_id` from `devices.irrigation_zone_id`.
  - Use the zone timezone when available, matching the LSN50/S2120 aggregation style.
  - Skip aggregation when `rain_mm_delta <= 0`.
  - Upsert source as:

    ```text
    aquascope_lorain
    ```

  - Add delta to existing `rainfall_mm` while ensuring the row is at least `rain_mm_today` when that value is higher.

- [ ] Copy the finished `flows.json` byte-for-byte to the bcm2709 profile:

  ```bash
  cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
     conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
  ```

- [ ] Extend `scripts/verify-sync-flow.js` with LoRain fixture tests:
  - LoRain MQTT node uses `application/+/device/+/event/up`.
  - LoRain branch rejects non-LoRain profiles.
  - Valid LoRain uplink for `AQUASCOPE_LORAIN` creates formatted SQL data.
  - First valid sample persists and aggregates immediate interval rainfall.
  - Duplicate/out-of-order timestamp does not double-count rainfall.
  - SQL insert includes temperature, battery voltage, rain tips, delta rain, rate fields, daily rain, interval seconds, and status.
  - Zone aggregate source is `aquascope_lorain`.

### 6. Update Frontend Types And Dashboard Cards

- [ ] Read root overlays before TypeScript edits:

  ```bash
  sed -n '1,220p' architect.yaml
  sed -n '1,260p' RULES.yaml
  sed -n '1,220p' docs/agents/typescript-rule-overlays.md
  ```

- [ ] Update `web/react-gui/src/types/farming.ts`:

  ```ts
  export type DeviceType =
    | 'KIWI_SENSOR'
    | 'STREGA_VALVE'
    | 'DRAGINO_LSN50'
    | 'TEKTELIC_CLOVER'
    | 'SENSECAP_S2120'
    | 'AQUASCOPE_LORAIN';
  ```

- [ ] Create `web/react-gui/src/components/farming/LoRainGaugeCard.tsx`.

  Required UI data:
  - Device display name and DevEUI.
  - Badge text: `LoRain`.
  - Rain today from `rain_mm_today`.
  - Last interval rainfall from `rain_mm_delta`.
  - Ten-minute rate from `rain_mm_per_10min`.
  - Ambient temperature from `ambient_temperature`.
  - Battery voltage from `bat_v`.
  - Last seen from `last_seen` / `device_data.recorded_at`.
  - Footer actions matching existing device cards, including remove through `devicesAPI.remove`.

- [ ] Use existing UI primitives and patterns:
  - `SensorMonitor` for rain values.
  - `DeviceCardFooter` for remove/history controls.
  - Existing `Weather` / `CloudRain` / `Thermometer` / `Battery` lucide icons when already imported elsewhere in farming components.

- [ ] Create a small shared helper only when it removes duplicated rain formatting between `SenseCapWeatherCard.tsx` and `LoRainGaugeCard.tsx`.

  Suggested file:

  ```text
  web/react-gui/src/components/farming/shared/rainTelemetry.ts
  ```

  Candidate helpers:
  - `formatCounterInterval(seconds?: number | null): string`
  - `formatCounterStatus(status?: string | null): string`
  - `formatPerTenMinuteValue(value?: number | null): string`

- [ ] Update `web/react-gui/src/components/farming/FarmingDashboard.tsx`:
  - Import `LoRainGaugeCard`.
  - Add `unassignedLoRainGauges`.
  - Render unassigned LoRain cards with the other unassigned sensor devices.

- [ ] Update `web/react-gui/src/components/farming/IrrigationZoneCard.tsx`:
  - Import `LoRainGaugeCard`.
  - Add `loRainGauges = devices.filter((device) => device.type_id === 'AQUASCOPE_LORAIN')`.
  - Render LoRain cards in the zone weather/rain section.

- [ ] Update `web/react-gui/src/components/local/LocalTab.tsx` device type color map to include `AQUASCOPE_LORAIN`.

- [ ] Add focused frontend tests for the new card:

  ```text
  web/react-gui/src/components/farming/__tests__/LoRainGaugeCard.test.tsx
  ```

  Required assertions:
  - Renders LoRain badge/name/DevEUI.
  - Renders interval rain, rain today, temperature, and battery voltage when present.
  - Handles missing telemetry without throwing.
  - Remove action calls `devicesAPI.remove` after confirmation.

### 7. Update Static Verification Coverage

- [ ] In `scripts/verify-sync-flow.js`, add static assertions that both profile `flows.json` files contain:
  - `AQUASCOPE_LORAIN`.
  - `CHIRPSTACK_PROFILE_LORAIN`.
  - `4943485448592021`.
  - `lorain-process-fn`.
  - `lorain-sql-fn`.
  - `lorain-rain-agg-fn`.
  - `aquascope_lorain`.

- [ ] In `scripts/verify-sync-flow.js`, add profile parity checks for the LoRain codec path.

- [ ] In `scripts/verify-sync-flow.js`, chain `scripts/verify-lorain-codec.js` if the script has a central child-process verification section. If there is no existing central section, leave `verify-lorain-codec.js` as a separately documented command and add a static assertion that the file exists.

- [ ] Update `scripts/check-mqtt-topics.sh` only if the current implementation enumerates allowed node IDs. The preferred outcome is no script change because the LoRain MQTT node already uses the required wildcard topic.

### 8. Final Verification

- [ ] Run schema verification:

  ```bash
  node scripts/verify-db-schema-consistency.js
  ```

- [ ] Run LoRain codec verification:

  ```bash
  node scripts/verify-lorain-codec.js
  ```

- [ ] Run full sync/static verification:

  ```bash
  node scripts/verify-sync-flow.js
  ```

- [ ] Run device-regression verification:

  ```bash
  node scripts/verify-strega-gen1.js
  node scripts/verify-communication-contract.js
  scripts/check-mqtt-topics.sh
  ```

- [ ] Run frontend verification:

  ```bash
  cd web/react-gui && npm run test:unit
  cd web/react-gui && npm run build
  ```

- [ ] Confirm working tree state:

  ```bash
  git status --short --branch
  ```

## Implementation Notes

- Do not replace `/data/db/farming.db` on a live Pi. The schema change must be represented as an idempotent repair/migration and applied to bundled DB copies only during image build work.
- Do not regenerate bundled SQLite databases from `seed-blank.sql` unless preserving the existing `chameleon_calibrations` rows. The safer path is the idempotent `repair-pi-schema.js` table rebuild.
- Keep all MQTT IN subscriptions on `application/+/device/+/event/up`; branch filtering belongs in the downstream LoRain function node.
- Keep bcm2712 and bcm2709 payload files byte-for-byte aligned for codec, bootstrap, flows, and database changes.
- Do not introduce a plugin registry for this device. This integration follows the static catalog/profile pattern documented by the local ADR.
