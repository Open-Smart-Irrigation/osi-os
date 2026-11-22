'use strict';
// Test-only osiLib binding for flow harnesses whose node calls
// osiLib.require('installation'). It resolves that name to the real profile
// copy of osi-installation-helper, the same module osi-lib loads on a gateway,
// so the harness exercises the shipped guard (gatewayWorkBlocked) instead of a
// stand-in. Other names fail the way an unregistered osi-lib name does, unless
// the caller supplies them in `extra`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');

function installationHelperPath(profile) {
  if (!profile.startsWith('bcm27xx_')) profile = 'bcm27xx_' + profile;
  return path.join(REPO, `conf/full_raspberrypi_${profile}/files/usr/share/node-red/osi-installation-helper`);
}

function installationOsiLib(profile = 'bcm27xx_bcm2712', extra = {}) {
  return {
    require(name) {
      if (name === 'installation') return { ok: true, value: require(installationHelperPath(profile)) };
      if (Object.prototype.hasOwnProperty.call(extra, name)) return { ok: true, value: extra[name] };
      return { ok: false, error: 'unknown osi-lib module: ' + name };
    },
  };
}

// The account-link request builder moved from the al-link-build-req function
// node into the helper's accountLink_build stage; the node only delegates. This
// returns the source of that stage after checking the delegation, so tests that
// inspect the link request's capability list read it where it now lives.
function linkBuilderSource(flows, profile = 'bcm27xx_bcm2712') {
  const node = flows.find((candidate) => candidate.id === 'al-link-build-req');
  assert.ok(node, `${profile}: al-link-build-req exists`);
  assert.ok((node.libs || []).some((lib) => lib.var === 'osiLib' && lib.module === 'osi-lib'), `${profile}: al-link-build-req loads helpers through osi-lib`);
  assert.match(node.func, /osiLib\.require\('installation'\)/, `${profile}: al-link-build-req loads the installation helper`);
  assert.match(node.func, /return load\.value\.accountLinkStage\('build',/, `${profile}: al-link-build-req delegates to the build stage`);
  const source = fs.readFileSync(path.join(installationHelperPath(profile), 'index.js'), 'utf8');
  assert.match(source, /\bbuild: accountLink_build\b/, `${profile}: the build stage is accountLink_build`);
  const start = source.indexOf('async function accountLink_build(');
  assert.ok(start >= 0, `${profile}: accountLink_build is defined`);
  const end = source.indexOf('\nasync function ', start + 1);
  const body = source.slice(start, end < 0 ? undefined : end);
  assert.match(body, /msg\.payload = \{[^}]*\bsyncCapabilities \};/, `${profile}: the link request sends syncCapabilities`);
  return body;
}

module.exports = { installationOsiLib, installationHelperPath, linkBuilderSource };
