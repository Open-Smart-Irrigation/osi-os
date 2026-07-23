#!/usr/bin/env node
'use strict';

// Scoped-access ratchet (spec §5.4): every HTTP-handler function chain in the
// maintained profiles must reference the scope module (osiLib.require('scope'))
// or be explicitly allowlisted. Necessary-not-sufficient: the behavioral
// matrix (test-scoped-access-*.js) is the correctness gate; this stops
// newly-added endpoints shipping with no scope call at all.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];

// Endpoints with no scoped data or Phase-A/public semantics (exact http-in ids).
const PUBLIC_ALLOWLIST = new Set([
  'auth-register-http',
  'auth-login-http',
  'api-me-http',
  'history-system-features-http',
]);

// Phase B lands before write enforcement by design. These exact pre-existing
// mutation/effect routes are tracked debt, not general exemptions. Phase C
// removes each id as its scope guard lands; any newly-added route still fails.
const PHASE_C_PENDING = new Set([
  'sys-reboot-in',
  'sys-fan-in',
  'al-link-in',
  'al-unlink-in',
  'dendro-tz-http',
  'dendro-location-http',
  'zone-config-http',
  'sync-force-http',
  'zone-calibration-http',
  'history-rollups-run-http',
]);
const ALLOWLIST = new Set([...PUBLIC_ALLOWLIST, ...PHASE_C_PENDING]);

function findFailures(flows, profileLabel, allowlist = ALLOWLIST) {
  const failures = [];
  const byId = new Map(flows.map((node) => [node.id, node]));

  for (const node of flows) {
    if (node.type !== 'http in' || node.method === 'options') continue;
    if (allowlist.has(node.id)) continue;

    const seen = new Set();
    let text = '';
    const walk = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const downstream = byId.get(id);
      if (!downstream) return;
      text += String(downstream.func || '') + '\n' + JSON.stringify(downstream.libs || []);
      for (const output of downstream.wires || []) {
        for (const target of output) walk(target);
      }
    };

    for (const output of node.wires || []) {
      for (const target of output) walk(target);
    }

    if (!text.includes("require('scope')")) {
      failures.push(
        `${profileLabel}: ${node.method.toUpperCase()} ${node.url} (${node.id}) has no scope call`
      );
    }
  }
  return failures;
}

function verifyProfiles(profiles = PROFILES) {
  const failures = [];
  for (const relativePath of profiles) {
    const flows = JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
    failures.push(...findFailures(flows, relativePath));
  }
  return failures;
}

if (require.main === module) {
  const failures = verifyProfiles();
  if (failures.length) {
    console.error('FAIL: scoped-access ratchet:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('verify-scoped-access: OK (ratchet only; behavioral matrix is the correctness gate)');
}

module.exports = {
  ALLOWLIST,
  PHASE_C_PENDING,
  PROFILES,
  PUBLIC_ALLOWLIST,
  findFailures,
  verifyProfiles,
};
