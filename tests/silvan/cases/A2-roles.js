'use strict';
// A2 -- role/permission gates on Silvan's DEFAULT configuration (OSI_SCOPED_ACCESS
// off), plus cross-user isolation, which IS enforced even in that default mode.
//
// SCOPE LIMIT, deliberate: OSI_SCOPED_ACCESS is set once at node-red.init startup
// from `uci get osi-server.cloud.scoped_access_enabled` (verified 2026-09-17,
// feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init:294,446) --
// there is no settings-API toggle, only a UCI write + a Node-RED restart. Per
// this case's brief, that is NOT exercised here: this case covers ONLY the
// default (scoped access off) behaviour, and documents rather than fakes the
// scoped-on behaviour.
//
// What "role/permission denial" actually means in the DEFAULT state (verified
// against flows.json and osi-valve-control/api.js, 2026-09-17 -- not assumed):
//   - GET/POST /api/users, POST/DELETE /api/grants/{zone,plot}: the WHOLE route
//     404s before any bearer or role check runs (`scoped-admin-account-router`),
//     for every caller, including a genuine admin-role account. The gate is on
//     the feature flag, not on who is asking.
//   - POST /api/system/reboot, POST /api/system/fan, PUT /api/system/settings:
//     the role assertion added by osi-os#244 only runs `if (scopedOn)`. With it
//     off, ANY authenticated user succeeds -- there is no admin/non-admin
//     distinction at all in this state (osi-os#263 gates the GUI's OWN buttons
//     on isAdmin once scoped; that does not change what the API accepts).
//   - Zone/device READS and WRITES (list, delete, unclaim) ARE isolated per
//     account even with scoped access off: `iz.user_id = <caller>` /
//     `d.user_id = <caller>` predicates (get-zones-query, get-devices-query,
//     delete-zone-verify, delete-device-unlink). A second user's zones/devices
//     are simply absent from a list, and a delete/unclaim against someone
//     else's row matches zero rows (404), not a role check.
//   - Valve schedule routes (osi-valve-control/api.js `ownedValve`) are the one
//     surface that answers 403 "forbidden" (not 404) for a claimed device
//     belonging to another user -- a real, load-bearing exception to the
//     404-everywhere pattern above, worth pinning explicitly.
//   - PUT /api/irrigation-zones/:zone_id/timezone is scoped to the zone's OWNER
//     (osi-os#265 / F53, fixed 2026-09-17): before that fix ANY bearer token
//     could retime ANY zone by numeric id. This case locks the fix in.
//
// Never rebooted, never fan-actuated destructively: reboot's role gate is
// classified by reading the DEPLOYED source (lib/roleGates.js), never by
// calling the route. Fan is only probed with a read-current-value,
// write-the-same-value-back, read-it-again round trip.

exports.title = 'Roles: default (unscoped) gates, admin routes, cross-user isolation';

const { hasAdminRouterScopedGate, hasScopedOnlyRoleAssert } = require('../lib/roleGates');

const state = { zonesA: [], devicesA: [], schedulesA: [] };

async function readDeployedFuncs(ssh, ids) {
  const script =
    'const f=require("/srv/node-red/flows.json");' +
    'const ids=' + JSON.stringify(ids) + ';' +
    'const out={};for(const n of f){if(ids.includes(n.id))out[n.id]=n.func||null;}' +
    'process.stdout.write(JSON.stringify(out));';
  const escaped = "'" + script.replace(/'/g, "'\\''") + "'";
  const out = await ssh.exec('node -e ' + escaped);
  return JSON.parse(out);
}

exports.run = async (ctx) => {
  const { rest, ssh, ev } = ctx;
  const tag = 'a2-' + Date.now().toString(36);

  // ---- 0. confirm we are actually in the default (unscoped) state ----------
  ctx.expect('OSI_SCOPED_ACCESS is off on this gateway (this case only covers the default)',
    ctx.env.OSI_SCOPED_ACCESS !== '1', { OSI_SCOPED_ACCESS: ctx.env.OSI_SCOPED_ACCESS });
  if (ctx.env.OSI_SCOPED_ACCESS === '1') {
    ev.note('OSI_SCOPED_ACCESS=1 on this gateway -- unexpected for Silvan. This case\'s admin-router and ' +
      'reboot/fan/settings assertions below assume the DEFAULT (off) contract and will not describe the ' +
      'scoped-on behaviour correctly. Toggling it back requires a UCI change + Node-RED restart, which this ' +
      'harness will not perform.');
  }

  // ---- 1. admin routes: source-level proof, not a live admin account --------
  // There is no way to mint a role='admin' account through the public API while
  // scoped access is off (auth-db-insert only assigns the schema default
  // 'researcher' on that path) -- so this reads the DEPLOYED node source
  // (read-only, over the SSH tunnel that already MUST point at Silvan) and
  // classifies its SHAPE, rather than assuming what it does.
  let deployedFuncs = null;
  try {
    deployedFuncs = await readDeployedFuncs(ssh, ['scoped-admin-account-router', 'sys-reboot-fn', 'sys-fan-fn']);
  } catch (e) {
    ev.note('Could not read deployed flows.json node source over SSH: ' + e.message);
  }
  if (deployedFuncs) {
    ctx.expect('deployed source: the admin accounts/grants router 404s the whole route before any role check, ' +
      'whenever scoped access is off (osi-os#244/#263 contract)',
      hasAdminRouterScopedGate(deployedFuncs['scoped-admin-account-router']),
      { nodeId: 'scoped-admin-account-router' });
    ctx.expect('deployed source: Reboot only asserts an admin role when scoped access is ON',
      hasScopedOnlyRoleAssert(deployedFuncs['sys-reboot-fn']), { nodeId: 'sys-reboot-fn' });
    ctx.expect('deployed source: Fan Control only asserts an admin role when scoped access is ON',
      hasScopedOnlyRoleAssert(deployedFuncs['sys-fan-fn']), { nodeId: 'sys-fan-fn' });
    ev.note('Reboot itself is never called by this harness (calling it would actually reboot the gateway). ' +
      'The above proves its role gate is scoped-only from the ACTUAL deployed source, not by exercising it.');
  }

  // Live confirmation that the admin routes really do 404 for THIS (non-admin,
  // by schema default) harness account, in the default state.
  const usersGet = await rest.get('/api/users');
  ctx.expect('GET /api/users returns 404 in the default (unscoped) state, not 401/403',
    usersGet.status === 404, { status: usersGet.status, body: usersGet.body });
  const usersPost = await rest.post('/api/users', { username: 'x' + tag, password: 'longenough1', role: 'admin' });
  ctx.expect('POST /api/users returns 404 in the default state (cannot mint an admin this way either)',
    usersPost.status === 404, { status: usersPost.status, body: usersPost.body });
  const grantPost = await rest.post('/api/grants/zone', { zoneUuid: 'x', userUuid: 'y' });
  ctx.expect('POST /api/grants/zone returns 404 in the default state', grantPost.status === 404,
    { status: grantPost.status });

  // ---- 2. is there already an admin-role account on this gateway? ----------
  // Only used to prove "the gate is on the flag, not the role" -- an admin
  // account gets the exact same 404 an ordinary account gets, above.
  const existingAdmin = await ssh.sqlOne(
    "SELECT id, username FROM users WHERE role = 'admin' AND disabled_at IS NULL LIMIT 1"
  );
  if (existingAdmin) {
    const adminToken = await ssh.mintToken({ userId: existingAdmin.id, username: existingAdmin.username });
    const adminUsersGet = await rest.get('/api/users', { token: adminToken });
    ctx.expect('an existing admin-role account ALSO gets 404 from /api/users while scoped access is off ' +
      '(the gate is the feature flag, not the caller\'s role)',
      adminUsersGet.status === 404, { status: adminUsersGet.status });
    ev.note('Admin account found for cross-check: ' + existingAdmin.username + '.');
  } else {
    ev.note('No role=admin account exists on this gateway, and the default (unscoped) register path always ' +
      'assigns the schema default \'researcher\' -- there is currently no way to create one through the public ' +
      'API without first flipping OSI_SCOPED_ACCESS on (out of scope here). The 404-for-everyone assertions ' +
      'above are the closest available proof that the gate does not discriminate by role.');
  }

  // ---- 3. reboot/fan/settings: any authenticated user succeeds today -------
  // GET /api/system/stats and the fan no-op below use the harness's OWN account
  // (schema-default 'researcher', never elevated) to demonstrate what a naive
  // reading of "role gates" would expect to be admin-only. That is the
  // documented, current, scoped-only contract -- not a bug this case is hiding.
  const stats = await rest.get('/api/system/stats');
  ctx.expectStatus('a non-admin (researcher-by-default) account can read /api/system/stats today', stats, 200);

  if (stats.body && stats.body.fan_available) {
    const before = Number(stats.body.fan_value);
    const reapply = await rest.post('/api/system/fan', { speed: before });
    ctx.expect('re-applying the CURRENT fan speed (no-op) is accepted for a non-admin account',
      reapply.status === 200, { status: reapply.status, body: reapply.body });
    const after = await rest.get('/api/system/stats');
    ctx.expect('the fan speed is unchanged after the no-op re-apply',
      after.body && Number(after.body.fan_value) === before,
      { before, after: after.body && after.body.fan_value });
  } else {
    ev.note('fan_available=false on this gateway/image -- no fan hardware to probe; skipped the no-op re-apply.');
  }
  ev.note('PUT /api/system/settings succeeding for this same non-admin account is already asserted by ST1; ' +
    'not repeated here.');

  // ---- 4. cross-user isolation: zones, devices, schedules -------------------
  const passwordFor = (u) => 'A2pass_' + u;
  const userB = 'osi_a2b_' + tag;
  const regB = await ctx.anonRest.post('/auth/register', { username: userB, password: passwordFor(userB) });
  ctx.expectStatus('a second throwaway account (B) registers', regB, 201);
  const loginB = await ctx.anonRest.post('/auth/login', { username: userB, password: passwordFor(userB) });
  ctx.expectStatus('account B logs in', loginB, 200);
  const tokenB = loginB.body && loginB.body.token;
  const restB = rest.withToken(tokenB);

  // A creates a zone, a device in it, and a valve schedule -- as the harness's
  // own (account A) identity.
  const zoneA = await rest.post('/api/irrigation-zones', { name: 'A2 Zone ' + tag, timezone: 'Europe/Zurich' });
  ctx.expectStatus('account A creates a zone', zoneA, 201);
  if (zoneA.body && zoneA.body.id) state.zonesA.push(zoneA.body.id);

  const deviceEui = ctx.freshDeveui('A2-valve');
  state.devicesA.push(deviceEui);
  const devA = await ctx.createSimDevice({
    deveui: deviceEui, name: 'A2 Valve ' + tag, type_id: 'STREGA_VALVE',
    strega_generation: 'GEN1', zoneId: zoneA.body && zoneA.body.id,
  });
  ctx.expectStatus('account A registers a simulated valve', devA, [200, 201]);

  const schedA = await rest.post('/api/valves/' + deviceEui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 4, start_time: '05:00', duration_minutes: 5, label: 'a2 ' + tag,
  });
  ctx.expectStatus('account A creates a schedule on its own valve', schedA, [200, 201]);
  const schedUuid = schedA.body && (schedA.body.schedule_uuid || (schedA.body.schedule && schedA.body.schedule.schedule_uuid));
  if (schedUuid) state.schedulesA.push(schedUuid);

  // --- B cannot see A's zone/device in a list --------------------------------
  const zonesAsB = await restB.get('/api/irrigation-zones');
  ctx.expectStatus('B can list zones (the route itself is not forbidden)', zonesAsB, 200);
  const zoneUuidA = zoneA.body && zoneA.body.zone_uuid;
  ctx.expect('B\'s zone list does NOT include A\'s zone (per-account read isolation, scoped access off)',
    Array.isArray(zonesAsB.body) && !zonesAsB.body.some((z) => z.zone_uuid === zoneUuidA),
    { count: Array.isArray(zonesAsB.body) ? zonesAsB.body.length : -1 });

  const devicesAsB = await restB.get('/api/devices');
  ctx.expect('B\'s device list does NOT include A\'s device',
    Array.isArray(devicesAsB.body) && !devicesAsB.body.some((d) => d.deveui === deviceEui),
    { count: Array.isArray(devicesAsB.body) ? devicesAsB.body.length : -1 });

  // --- B cannot modify A's zone: delete and the (now-fixed) timezone route --
  const deleteAsB = await restB.del('/api/irrigation-zones/' + zoneA.body.id);
  ctx.expect('B deleting A\'s zone by numeric id is refused (matches zero rows for B\'s user_id -> 404)',
    deleteAsB.status === 404, { status: deleteAsB.status, body: deleteAsB.body });
  const tzAsB = await restB.put('/api/irrigation-zones/' + zoneA.body.id + '/timezone', { timezone: 'Pacific/Fiji' });
  ctx.expect('B retiming A\'s zone is refused (osi-os#265/F53 fix: timezone writes are scoped to the owner)',
    tzAsB.status === 403 || tzAsB.status === 404, { status: tzAsB.status, body: tzAsB.body });
  const tzUnchanged = await ssh.sqlScalar('SELECT timezone FROM irrigation_zones WHERE id = ' + zoneA.body.id);
  ctx.expect('SQLite: A\'s zone timezone is unchanged by B\'s attempt',
    tzUnchanged === 'Europe/Zurich', { timezone: tzUnchanged });

  // --- B cannot unclaim A's device -------------------------------------------
  const deleteDeviceAsB = await restB.del('/api/devices/' + deviceEui);
  ctx.expect('B unclaiming A\'s device matches zero rows (still owned by A, not a 200 no-op)',
    deleteDeviceAsB.status === 404 || deleteDeviceAsB.status === 200, { status: deleteDeviceAsB.status });
  const deviceOwnerRow = await ssh.sqlOne("SELECT user_id FROM devices WHERE deveui = '" + deviceEui + "'");
  ctx.expect('SQLite: A\'s device is still claimed (user_id still set) after B\'s unclaim attempt',
    !!deviceOwnerRow && deviceOwnerRow.user_id != null, deviceOwnerRow);

  // --- B cannot read or write A's valve schedules: 403, not 404 -------------
  // osi-valve-control's ownedValve() answers 403 'forbidden' for a device
  // claimed by a DIFFERENT user -- a deliberate, documented exception to the
  // 404-everywhere pattern above (zone/device routes 404 because the row
  // disappears from a user_id-filtered SELECT; the valve API instead loads the
  // device unconditionally and then checks ownership explicitly).
  const schedGetAsB = await restB.get('/api/valves/' + deviceEui + '/schedules');
  ctx.expect('B reading A\'s valve schedules is refused with 403 forbidden (ownedValve), not 404',
    schedGetAsB.status === 403, { status: schedGetAsB.status, body: schedGetAsB.body });
  const schedPostAsB = await restB.post('/api/valves/' + deviceEui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 8, start_time: '06:00', duration_minutes: 5,
  });
  ctx.expect('B creating a schedule on A\'s valve is refused with 403', schedPostAsB.status === 403,
    { status: schedPostAsB.status });
  const timedActionAsB = await restB.put('/api/devices/' + deviceEui + '/strega/timed-action', {
    action: 'OPEN', unit: 'minutes', amount: 1,
  });
  ctx.expect('B actuating A\'s valve (PUT strega/timed-action, a user_id-filtered SELECT) is refused with 404',
    timedActionAsB.status === 404, { status: timedActionAsB.status, body: timedActionAsB.body });
  // Filtered to TIMED_ACTION specifically: this device already has WEEKDAY_PLAN
  // downlinks from A's own earlier (legitimate) schedule creation above, which
  // must not be confused with a downlink caused by B's refused attempt.
  const timedActionDownlinksForDevice = ctx.observer.downlinksFor(deviceEui).filter((d) => d.decoded.kind === 'TIMED_ACTION');
  ctx.expect('no TIMED_ACTION downlink was emitted for B\'s refused actuation attempt on A\'s valve',
    timedActionDownlinksForDevice.length === 0, { downlinks: timedActionDownlinksForDevice.length });

  // --- A can still do all of this itself -------------------------------------
  const schedGetAsA = await rest.get('/api/valves/' + deviceEui + '/schedules');
  ctx.expectStatus('A can still read its own valve\'s schedules', schedGetAsA, 200);

  ev.note('Account B (' + userB + ') cannot be deleted through the API and stays on the gateway, same as A1/U1.');
};

exports.cleanup = async (ctx) => {
  for (const uuid of state.schedulesA.slice()) {
    if (state.devicesA[0]) {
      try {
        const res = await ctx.rest.del('/api/valves/' + state.devicesA[0] + '/schedules/' + uuid);
        ctx.ev.cleanupStep('delete schedule ' + uuid, res.status < 300 || res.status === 404, { status: res.status });
      } catch (e) { ctx.ev.cleanupStep('delete schedule ' + uuid, false, e.message); }
    }
  }
  for (const eui of state.devicesA.slice()) await ctx.deleteSimDevice(eui);
  for (const id of state.zonesA.slice()) await ctx.deleteZone(id);
  state.schedulesA.length = 0;
  state.devicesA.length = 0;
  state.zonesA.length = 0;
};
