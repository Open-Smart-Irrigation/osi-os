'use strict';
// osi-device-commands -- narrow-waist writer seam for versioned device-family
// commands applied on the edge. Wave 3 zone/weather/calibration sync port
// (AgroLink 33eb12b9): only REPLACE_WEATHER_STATION_ZONES lands here.
// AgroLink's own osi-device-commands also carries UPSERT_DEVICE/UNCLAIM_DEVICE
// ("protected device aggregate" applier, AgroLink 9937ac6c6) as a sibling
// export from this same index.js -- that feature is out of scope for this
// port and does not exist on main, so this index.js stays a thin re-export
// of weather.js only. Do not add UPSERT_DEVICE/UNCLAIM_DEVICE handling here
// without first porting its own migration/contract/test surface.
const weather = require('./weather');

module.exports = {
  applyWeatherStationZonesCommand: weather.applyWeatherStationZonesCommand,
  replaceLocalWeatherStationZones: weather.replaceLocalWeatherStationZones,
};
