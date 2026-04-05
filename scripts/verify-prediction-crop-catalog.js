#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`OK ${message}`);
}

function resolveServerCatalogPath() {
  const explicit = process.env.OSI_SERVER_CATALOG_PATH;
  const candidates = [
    explicit,
    path.resolve(__dirname, '..', '..', 'osi-server', 'prediction-service', 'app', 'catalog.py'),
    path.resolve(__dirname, '..', '..', 'osi-server-waterux', 'prediction-service', 'app', 'catalog.py'),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function parseServerCatalog(source) {
  const cropPattern = /CropSpec\(\s*code="([^"]+)",\s*display_name="([^"]+)"/gs;
  const crops = [];
  let match;
  while ((match = cropPattern.exec(source)) !== null) {
    crops.push({ code: match[1], displayName: match[2] });
  }
  return crops;
}

function parseLocalCatalog(source) {
  return JSON.parse(source).map((entry) => ({
    code: String(entry.code),
    displayName: String(entry.displayName),
  }));
}

function compareCatalogs(serverCrops, localCrops) {
  const serverMap = new Map(serverCrops.map((crop) => [crop.code, crop.displayName]));
  const localMap = new Map(localCrops.map((crop) => [crop.code, crop.displayName]));

  const missingLocally = serverCrops.filter((crop) => !localMap.has(crop.code));
  const missingOnServer = localCrops.filter((crop) => !serverMap.has(crop.code));
  const renamed = localCrops.filter((crop) => serverMap.has(crop.code) && serverMap.get(crop.code) !== crop.displayName)
    .map((crop) => ({
      code: crop.code,
      local: crop.displayName,
      server: serverMap.get(crop.code),
    }));

  if (missingLocally.length > 0) {
    fail(`local prediction crop catalog is missing server crops: ${missingLocally.map((crop) => crop.code).join(', ')}`);
  } else {
    ok('local crop catalog contains every server crop code');
  }

  if (missingOnServer.length > 0) {
    fail(`local prediction crop catalog has extra crops not present on server: ${missingOnServer.map((crop) => crop.code).join(', ')}`);
  } else {
    ok('local crop catalog has no extra crop codes');
  }

  if (renamed.length > 0) {
    fail(`display name mismatches: ${renamed.map((crop) => `${crop.code} local="${crop.local}" server="${crop.server}"`).join('; ')}`);
  } else {
    ok('local crop display names match the server catalog');
  }
}

const serverCatalogPath = resolveServerCatalogPath();
if (!serverCatalogPath) {
  fail('could not find osi-server prediction catalog; set OSI_SERVER_CATALOG_PATH to prediction-service/app/catalog.py');
  process.exit();
}

const localCatalogPath = path.resolve(
  __dirname,
  '..',
  'web',
  'react-gui',
  'src',
  'components',
  'farming',
  'predictionCropCatalog.json'
);

const serverCatalog = parseServerCatalog(fs.readFileSync(serverCatalogPath, 'utf8'));
const localCatalog = parseLocalCatalog(fs.readFileSync(localCatalogPath, 'utf8'));

ok(`using server catalog ${serverCatalogPath}`);
compareCatalogs(serverCatalog, localCatalog);
