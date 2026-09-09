#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canonicalPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const mirrorPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));

function find(name) {
  const matches = flows.filter((node) => node.name === name);
  if (matches.length !== 1) throw new Error(`${name}: expected one node, found ${matches.length}`);
  return matches[0];
}

function replaceOnce(node, before, after) {
  const count = node.func.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${node.name}: expected one replacement anchor, found ${count}`);
  }
  node.func = node.func.replace(before, after);
}

const finalize = find('Finalize linked account state');
replaceOnce(
  finalize,
  'installation_uuid=excluded.installation_uuid""',
  'installation_uuid=excluded.installation_uuid"'
);

const applyDeviceCommand = find('Apply Device Command');
replaceOnce(
  applyDeviceCommand,
  '|| payload.device != null\\n    || payload.weather_station_zones != null;',
  '|| payload.device != null\n    || payload.weather_station_zones != null;'
);
replaceOnce(
  applyDeviceCommand,
  "const applyCommand = commandType === 'REPLACE_WEATHER_STATION_ZONES'\\n      ? helper.value.applyWeatherStationZonesCommand\\n      : helper.value.applyDeviceCommand;\\n    const result",
  "const applyCommand = commandType === 'REPLACE_WEATHER_STATION_ZONES'\n      ? helper.value.applyWeatherStationZonesCommand\n      : helper.value.applyDeviceCommand;\n    const result"
);

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
console.log('Repaired function-node syntax in both maintained profiles');
