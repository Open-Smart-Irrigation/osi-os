# Provenance

Part of the osi-agronomy-sensors-reference skill; read SKILL.md first.

## Provenance and maintenance

Re-verify these if this skill's answers seem stale:

```bash
# SWT sign convention: scheduler comparison direction
grep -n "const irrigate" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json

# Chameleon resistance->kPa formula and clamp bounds
sed -n '1,50p' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js

# pF formula + golden vectors (must match GUI TS, edge JS, and server Java)
sed -n '1,60p' web/react-gui/src/utils/swt.ts
sed -n '85,110p' docs/contracts/sync-schema/canonicalization.md

# irrigation_schedules trigger_metric CHECK (confirm current schema contract)
grep -n "trigger_metric" database/seed-blank.sql

# Dendrometer edge (v5) vs cloud (v6) ownership
grep -n "Dendrometer Analytics v5" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
sed -n '1,40p' docs/architecture/dendrometer-analytics-v6.md

# ET0 on the edge (three tiers, FAO-56 math) and the cloud's Java reference it was ported from
sed -n '1,80p' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js
grep -n "stationDayInputs\|radiationImplausible\|resolveDay" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.js
grep -n "et0\|Et0" ../osi-server/backend/src/main/java/org/osi/server/analytics/WeatherMath.java  # sister-repo checkout required, path relative to this repo root

# Rain aggregation (S2120 cumulative-delta status machine; LoRain interval decoder)
grep -n "rainDeltaStatus\|rain_delta_status" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
sed -n '1,130p' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js

# Battery footer fallback behavior (confirm issue #51 / bat_v fallback still present)
sed -n '1,55p' web/react-gui/src/components/farming/shared/deviceCardBattery.ts

# VWC not-implemented status
grep -n "VWC" web/react-gui/src/types/farming.ts docs/channel-manifest.md

# STREGA cancel endpoint + expectation table
grep -n "valves/:deveui/cancel" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
grep -n "CREATE TABLE valve_actuation_expectations" -A 20 database/seed-blank.sql

# STREGA on-valve scheduler FPorts + window cap
grep -n "Schl_Port\|Schl_status_Port\|RTC_Port" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/ack.js
sed -n '1,40p' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/plan.js
```
