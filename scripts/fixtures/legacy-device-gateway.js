'use strict';
// Disposable OpenWrt rc.common + shipped init scripts. procd's boundary logs
// entry and exits before a real service body can affect the workstation.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
function makeGateway(root) {
  for (const dir of ['etc/init.d', 'etc/rc.d', 'etc/uci-defaults', 'lib/functions', 'data/db', 'srv/node-red', 'usr/lib/node-red/gui']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'lib/functions.sh'), 'list_contains() { return 0; }\n');
  fs.writeFileSync(path.join(root, 'lib/functions/service.sh'), '');
  fs.writeFileSync(path.join(root, 'lib/functions/procd.sh'), 'procd_open_service() { echo "$1" >> "$IPKG_INSTROOT/started"; exit 0; }\n');
  fs.writeFileSync(path.join(root, 'data/db/farming.db'), '');
  const rc = path.join(ROOT, 'openwrt/package/base-files/files/etc/rc.common');
  for (const [name, source] of [['node-red', 'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'],
    ['osi-identityd', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd']]) {
    const contents = fs.readFileSync(path.join(ROOT, source), 'utf8').replace(/^#![^\n]*/, '#!/bin/sh ' + rc);
    const init = path.join(root, 'etc/init.d', name);
    fs.writeFileSync(init, contents, { mode: 0o700 });
    const result = spawnSync(init, ['enable'], { env: { ...process.env, IPKG_INSTROOT: root }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  for (const file of ['flows.json', 'settings.js', 'flows_cred.json']) fs.writeFileSync(path.join(root, 'srv/node-red', file), file === 'flows.json' ? '[]' : '{}');
  fs.writeFileSync(path.join(root, 'usr/lib/node-red/gui/index.html'), 'fixture');
  return root;
}
function reboot(root) {
  // Same rcS autostart selection after losing all process-local state.
  for (const file of fs.readdirSync(path.join(root, 'etc/rc.d')).filter(f => /^S\d\d/.test(f)).sort()) {
    const service = path.join(root, 'etc/rc.d', file);
    const result = spawnSync('/bin/sh', [path.join(ROOT, 'openwrt/package/base-files/files/etc/rc.common'), service, 'boot'],
      { env: { ...process.env, IPKG_INSTROOT: root }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
}
module.exports = { makeGateway, reboot };
