#!/usr/bin/env node
'use strict';
// Every runtime .js/.json file inside a shipped osi-* helper module must be fetched by
// deploy.sh.
//
// Why this exists: osi-valve-control/cloud-commands.js was added and wired in (index.js
// require()s it at module load) but never added to deploy.sh. A gateway would have fetched
// index.js without it, so `require('./cloud-commands')` would throw and the WHOLE module
// would fail to load -- schedules, pushes and ACKs, not merely the feature it served.
//
// verify-helper-registration.js does not catch this: it checks that whole MODULES are
// registered, not that every file within one is deployed.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red';
const deploySh = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');

const moduleDir = path.join(ROOT, PROFILE);
if (!fs.existsSync(moduleDir)) {
  console.error(`FAIL: profile directory missing: ${PROFILE}`);
  process.exit(1);
}

const isRuntimeFile = (f) =>
  (f.endsWith('.js') || f.endsWith('.json')) && !f.endsWith('.test.js') && f !== 'test-helpers.js';

let missing = 0;
let checked = 0;

for (const mod of fs.readdirSync(moduleDir).sort()) {
  if (!mod.startsWith('osi-')) continue;
  const dir = path.join(moduleDir, mod);
  if (!fs.statSync(dir).isDirectory()) continue;
  // Only modules deploy.sh already knows about; a module it ships nothing from is either
  // firmware-baked or not yet wired, and is verify-helper-registration.js's business.
  if (!deploySh.includes(`${mod}/`)) continue;

  for (const f of fs.readdirSync(dir).sort()) {
    if (!isRuntimeFile(f)) continue;
    checked += 1;
    if (!deploySh.includes(`${mod}/${f}`)) {
      console.error(`FAIL: ${mod}/${f} is a runtime file but deploy.sh never fetches it`);
      missing += 1;
    }
  }
}

if (missing) {
  console.error(`\n${missing} module file(s) would be absent on a deployed gateway.`);
  console.error('Add a fetch_required entry to deploy.sh for each.');
  process.exit(1);
}
console.log(`OK: all ${checked} runtime files in deploy.sh-shipped osi-* modules are fetched.`);
