'use strict';
// Guard for the Node-RED editor/admin API closure (osi-architecture-review
// 2026-09-01, "Production Node-RED admin-boundary containment"; consult Q3,
// external-consult-codex-2026-09-16.md). httpAdminRoot: false disables the
// unauthenticated Node-RED editor and admin API (/flows, /settings, /nodes,
// deploy) on the shared :1880 listener while leaving the HTTP-node product
// routes and the static /gui bundle reachable. uiHost must stay unset: it
// would also remove LAN access to /gui and /api for every farmer browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SETTINGS_PATH = path.join(
  REPO,
  'feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js'
);
const DEPLOY_PATH = path.join(REPO, 'deploy.sh');
const NGINX_PATH = path.join(
  REPO,
  'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.nginx'
);

test('settings.js closes the Node-RED editor/admin API but keeps /gui and product routes', () => {
  // require() the real deployed file directly, not a copy: a sandboxed load
  // still executes the module's top-level loadChirpstackEnvFile() call, which
  // is safe here because /srv/node-red/.chirpstack.env does not exist on this
  // machine and the function no-ops via fs.existsSync.
  delete require.cache[SETTINGS_PATH];
  const settings = require(SETTINGS_PATH);

  assert.equal(settings.httpAdminRoot, false,
    'httpAdminRoot must be false to disable the editor and admin API');
  assert.equal(settings.uiHost, undefined,
    'uiHost must stay unset: setting it would also remove LAN access to /gui and /api');
  assert.equal(settings.httpStatic, '/usr/lib/node-red/gui',
    'httpStatic (the /gui bundle path) must be unchanged');
  assert.equal(settings.httpStaticRoot, '/gui',
    'httpStaticRoot must be unchanged so /gui keeps serving on the shared listener');
});

test('deploy.sh still fetches and ships this exact settings.js to the gateway', () => {
  const deploy = fs.readFileSync(DEPLOY_PATH, 'utf8');
  assert.match(
    deploy,
    /fetch_required "Node-RED settings\.js"\s*\\\s*\n\s*"feeds\/chirpstack-openwrt-feed\/apps\/node-red\/files\/settings\.js"\s*\\\s*\n\s*"\/srv\/node-red\/settings\.js"/,
    'deploy.sh must still ship feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js to /srv/node-red/settings.js'
  );
});

test('node-red.nginx no longer proxies the editor at /apps/node-red', () => {
  const nginx = fs.readFileSync(NGINX_PATH, 'utf8');
  assert.doesNotMatch(
    nginx,
    /location\s+\/apps\/node-red\s*\{\s*return\s+302\s+http:\/\/\$host:1880;/,
    'the /apps/node-red -> :1880 editor redirect must be removed or changed to a 404'
  );
  // Whatever replaces it (removed entirely, or an explicit 404) must not still
  // route to the admin-capable port-1880 origin.
  if (/location\s+\/apps\/node-red\b/.test(nginx)) {
    const block = nginx.slice(nginx.indexOf('location /apps/node-red'));
    const closeIdx = block.indexOf('}');
    const snippet = block.slice(0, closeIdx + 1);
    assert.doesNotMatch(snippet, /:1880/,
      'a retained /apps/node-red location must not proxy or redirect to :1880');
  }
});
