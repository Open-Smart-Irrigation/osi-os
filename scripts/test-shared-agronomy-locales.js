#!/usr/bin/env node
'use strict';

// The eleven texts the edge and the cloud GUIs share for daily agronomy parity
// (plan E2b). The edge embeds the cloud's translations; this test keeps the two
// equal after a later text fix on either side. It compares the edge's
// web/react-gui/public/locales/<locale>/devices.json with the cloud's
// frontend/public/locales/<locale>/devices.json in the osi-server checkout that
// OSI_SERVER_ROOT names, for every shared key the edge carries. Without
// OSI_SERVER_ROOT it skips.
//
// Run: OSI_SERVER_ROOT=/path/to/osi-server node --test scripts/test-shared-agronomy-locales.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CLOUD = process.env.OSI_SERVER_ROOT ? path.resolve(process.env.OSI_SERVER_ROOT) : null;
const LOCALES = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'];
// edge key (devices.json) -> cloud key (devices.json)
const SHARED = [
  ['zoneConfig.stageStartedOn', 'zoneConfigModal.stageStartedOn.label'],
  ['zoneConfig.stageStartedOnHelpLabel', 'zoneConfigModal.stageStartedOn.helpLabel'],
  ['zoneConfig.stageStartedOnHelp', 'zoneConfigModal.stageStartedOn.help'],
  ['zoneConfig.stageStartedOnHelpNoLength', 'zoneConfigModal.stageStartedOn.helpNoLength'],
  ...['kcSource.fao56_curve', 'stageOverrun', 'et0Tier.open_meteo_daily', 'computedBy.edge', 'computedBy.cloud', 'modelAccuracyNote', 'meteoswissCloudNote']
    .map((key) => [`environment.water.${key}`, `environment.water.${key}`]),
];
const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
const bundle = (root, dir, locale) => JSON.parse(fs.readFileSync(path.join(root, dir, locale, 'devices.json'), 'utf8'));

test('the texts the edge shares with the cloud equal the cloud\'s in seven locales', { skip: CLOUD ? false : 'OSI_SERVER_ROOT is not set' }, () => {
  let compared = 0;
  for (const locale of LOCALES) {
    const edge = bundle(ROOT, 'web/react-gui/public/locales', locale);
    const cloud = bundle(CLOUD, 'frontend/public/locales', locale);
    for (const [edgeKey, cloudKey] of SHARED) {
      const mine = get(edge, edgeKey);
      assert.equal(get(cloud, cloudKey), mine, `${locale}: edge ${edgeKey} vs cloud ${cloudKey}`);
      compared += 1;
    }
  }
  // node --test prints this line as '# compared 77 shared texts'. A rename of
  // the eleven edge keys must not make the test silently compare nothing and
  // pass (E-M3): every locale times every shared key must actually be
  // compared -- every edge bundle carries the keys since E2b.
  assert.equal(compared, LOCALES.length * SHARED.length);
  console.log(`compared ${compared} shared texts`);
});
