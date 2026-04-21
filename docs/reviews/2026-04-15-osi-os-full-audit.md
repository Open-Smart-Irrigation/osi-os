# OSI OS Full Audit

Date: 2026-04-15
Scope: application-owned `osi-os` code paths, including React GUI, Node-RED flow/runtime helpers, provisioning, sync, and deploy scripts

## Verification Run

- `node scripts/verify-sync-flow.js` -> pass
- `node scripts/verify-prediction-crop-catalog.js` -> pass
- `cd web/react-gui && npm run build` -> pass, with large chunk warning
- `cd web/react-gui && npx tsc --noEmit` -> fails
- `sh -n deploy.sh` -> pass
- `sh -n feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` -> pass
- `sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config` -> pass
- `node --check scripts/chirpstack-bootstrap.js` -> pass
- `node --check conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js` -> pass
- `node --check conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js` -> pass

## Findings

### High

1. Account linking can report success while MQTT provisioning is incomplete.
   - `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
   - `Handle server auth response` accepts missing MQTT credentials.
   - `Persist MQTT Broker Config` silently no-ops when `al_mqtt_password` is blank.
   - Result: a user can look linked while central hub stats never start.

### Medium

2. `chirpstack-bootstrap.js` has weaker gateway-EUI fallback logic than runtime provisioning.
   - `scripts/chirpstack-bootstrap.js`
   - Falls back only to `eth0`, while `node-red.init` and `96_osi_server_config` also check `br-lan` and `wlan0`.

3. React auth state desync on 401 remains unresolved.
   - `web/react-gui/src/services/api.ts`
   - `web/react-gui/src/contexts/AuthContext.tsx`
   - Interceptor clears `localStorage` only; context state stays stale until refresh.

4. Frontend type contract is inconsistent and `tsc` is red.
   - `web/react-gui/src/types/farming.ts`
   - `web/react-gui/src/services/api.ts`
   - `web/react-gui/src/components/farming/AdvancedScheduleDrawer.tsx`
   - `web/react-gui/src/components/farming/IrrigationZoneCard.tsx`
   - Schedules are normalized to camelCase but typed and consumed in mixed snake/camel forms.

5. `AccountLink` is outside the current typed i18n/env declarations.
   - `web/react-gui/src/pages/AccountLink.tsx`
   - `web/react-gui/src/i18n/config.ts`
   - `web/react-gui/src/types/i18next.d.ts`
   - Missing `accountLink` namespace in type declarations.
   - Missing Vite env/assets declaration support for `import.meta.env` and PNG imports.

### Low

6. Click-outside handling is duplicated and mouse-only.
   - `web/react-gui/src/components/farming/KiwiSensorCard.tsx`
   - `web/react-gui/src/components/farming/DraginoTempCard.tsx`
   - `web/react-gui/src/components/farming/StregaValveCard.tsx`
   - `web/react-gui/src/components/farming/SenseCapWeatherCard.tsx`

7. Legacy demo React app files and docs remain in the repo alongside the current app.
   - Dead path still present:
     - `web/react-gui/src/App.jsx`
     - `web/react-gui/src/components/Dashboard.jsx`
     - `web/react-gui/src/components/ApiStatus.jsx`
     - `web/react-gui/src/services/dataService.js`
   - Docs still describe that legacy path:
     - `web/react-gui/README.md`

8. Frontend bundle size is high.
   - `npm run build` reports a minified chunk over 500 kB.

## Notes

- Earlier concern about `KiwiSensorCard` crashing on `latest_data: null` is not proven in current `osi-os`.
- The local devices API currently emits `latest_data: {}` for device list responses and add-device responses.
- Audit excluded the vendored upstream `openwrt/` tree except for directly used project-owned integration surfaces.
