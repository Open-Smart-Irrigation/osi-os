'use strict';
// Z2 — zones and devices under bad input and broken dependencies.
//
// Preconditions: none; all resources are created and released by this case.
// Every DevEUI is simulated.
//
// What this pins: what the edge does with duplicate names, malformed payloads,
// missing dependencies, deletes of things that were never there, and deletes of
// a zone that still owns devices and schedules.

exports.title = 'Zones/devices: invalid input, duplicates, deleted dependencies';

const state = { zones: [], devices: [] };

exports.run = async (ctx) => {
  const { rest, ssh, ev } = ctx;
  const tag = 'z2-' + Date.now().toString(36);

  // --- zone: invalid input --------------------------------------------------
  const noName = await rest.post('/api/irrigation-zones', { name: '' });
  ctx.expectStatus('creating a zone with an empty name is rejected with 400', noName, 400);

  const blankName = await rest.post('/api/irrigation-zones', { name: '    ' });
  ctx.expectStatus('creating a zone with a whitespace-only name is rejected with 400', blankName, 400);

  const noBody = await rest.post('/api/irrigation-zones', {});
  ctx.expectStatus('creating a zone with no body is rejected with 400', noBody, 400);

  const unauth = await rest.post('/api/irrigation-zones', { name: 'unauth ' + tag }, { token: null });
  ctx.expectStatus('creating a zone without a bearer token is rejected with 401', unauth, 401);

  const leaked = await ssh.sqlScalar(
    "SELECT COUNT(*) AS n FROM irrigation_zones WHERE name LIKE '%" + tag + "%'"
  );
  ctx.expect('SQLite: no zone row was created by any rejected request', Number(leaked) === 0, { rows: leaked });

  // --- zone: duplicate names -----------------------------------------------
  const name = 'Dup Zone ' + tag;
  const first = await rest.post('/api/irrigation-zones', { name });
  ctx.expectStatus('the first zone with this name is created', first, 201);
  if (first.body && first.body.id) state.zones.push(first.body.id);
  const second = await rest.post('/api/irrigation-zones', { name });
  if (second.body && second.body.id) state.zones.push(second.body.id);
  // Pinned ACTUAL behaviour: irrigation_zones has no UNIQUE(name, user_id), and
  // post-zone-insert does no duplicate check, so a second zone with an identical
  // name is accepted. Two identically named zones are indistinguishable in the
  // GUI's zone picker.
  ctx.expect('a duplicate zone name is accepted (no uniqueness constraint on zone names)',
    second.status === 201, { status: second.status, body: second.body });
  ctx.expect('the duplicate gets its own distinct zone_uuid',
    second.status === 201 && second.body.zone_uuid !== first.body.zone_uuid,
    { first: first.body && first.body.zone_uuid, second: second.body && second.body.zone_uuid });
  if (second.status === 201) {
    ev.note('Zone names are not unique: two zones with the same name can coexist for one user. ' +
      'Anything that identifies a zone by name (GUI pickers, journal plot links, operator instructions) ' +
      'has no way to tell them apart.');
  }

  // --- zone: operations on things that do not exist ------------------------
  const ghostId = 99000000 + Math.floor(Math.random() * 1000);
  const delGhost = await rest.del('/api/irrigation-zones/' + ghostId);
  ctx.expectStatus('deleting a zone that does not exist returns 404', delGhost, 404);

  const badId = await rest.del('/api/irrigation-zones/not-a-number');
  ctx.expectStatus('deleting a zone with a non-numeric id returns 400', badId, 400);

  // --- device: invalid input ------------------------------------------------
  // Fresh per run: this case asserts that rejected requests created NO device
  // row, and a "deleted" device survives (DELETE only unclaims).
  const goodEui = ctx.freshDeveui('Z2-dev');
  state.devices.push(goodEui);

  const badType = await rest.post('/api/devices', {
    deveui: goodEui, name: 'bad type', type_id: 'NOT_A_REAL_TYPE', appkey: '00112233445566778899AABBCCDDEEFF',
  });
  ctx.expectStatus('an unknown type_id is rejected with 400', badType, 400);

  const missing = await rest.post('/api/devices', { name: 'no eui', type_id: 'KIWI_SENSOR' });
  ctx.expectStatus('a device with no deveui is rejected with 400', missing, 400);

  const noKey = await rest.post('/api/devices', { deveui: goodEui, name: 'no key', type_id: 'KIWI_SENSOR' });
  ctx.expectStatus('a device with no appkey is rejected with 400', noKey, 400);

  const shortKey = await rest.post('/api/devices', { deveui: goodEui, name: 'short key', type_id: 'KIWI_SENSOR', appkey: 'ABCD' });
  ctx.expectStatus('a device with a short appkey is rejected with 400', shortKey, 400);

  const badGen = await rest.post('/api/devices', {
    deveui: goodEui, name: 'bad gen', type_id: 'STREGA_VALVE',
    appkey: '00112233445566778899AABBCCDDEEFF', strega_generation: 'GEN9',
  });
  ctx.expectStatus('an invalid strega_generation is rejected with 400', badGen, 400);

  const notRegistered = await ssh.sqlScalar("SELECT COUNT(*) AS n FROM devices WHERE deveui = '" + goodEui + "'");
  ctx.expect('SQLite: none of the rejected device requests created a row', Number(notRegistered) === 0, { rows: notRegistered });

  // --- device: types the gateway cannot provision --------------------------
  // post-devices-insert returns 503 when CHIRPSTACK_APP_*/CHIRPSTACK_PROFILE_*
  // for that type is unset. On this gateway, LORAIN, UC512 and STREGA_GEN2 are
  // NOT exported by node-red.init (they are env-file-only), so those device
  // types cannot be registered at all through the API.
  const lorainEui = ctx.freshDeveui('Z2-lorain');
  const lorain = await rest.post('/api/devices', {
    deveui: lorainEui, name: 'Sim LoRain ' + tag, type_id: 'AQUASCOPE_LORAIN', appkey: '00112233445566778899AABBCCDDEEFF',
  });
  state.devices.push(lorainEui);
  const lorainProfileSet = !!ctx.env.CHIRPSTACK_PROFILE_LORAIN;
  ctx.expect('AQUASCOPE_LORAIN registration matches whether the gateway resolves CHIRPSTACK_PROFILE_LORAIN',
    lorainProfileSet ? lorain.status < 300 : lorain.status === 503,
    { profileResolved: lorainProfileSet, status: lorain.status, body: lorain.body });
  ev.note('CHIRPSTACK_PROFILE_LORAIN / _UC512 / _STREGA_GEN2 are NOT exported by node-red.init, but ' +
    'settings.js loads /srv/node-red/.chirpstack.env into process.env at startup for every key not already ' +
    'set, so env.get() resolves them inside a function node. Reading only /proc/<pid>/environ makes them ' +
    'look missing. This gateway resolves all 10 profiles.');

  // --- assignment against missing dependencies -----------------------------
  const zone = first.body;

  // DEFECT PIN. flows.json node `assign-device-update` ("Assign Device") has
  // outputs: 1 and wires: [["assign-device-update-db"]], but its
  // device-not-found path does `return [null, msg]` after setting statusCode
  // 404. The second element goes to an output that does not exist, so the 404 is
  // DROPPED and the HTTP request never receives a response at all: the caller
  // hangs until its own timeout (browser spinner forever, curl exit 28).
  // Every sibling node in this chain (assign-device-verify-zone,
  // assign-device-verify-device, delete-device-unlink) has outputs: 2 wired to
  // device-response; this one node was left at 1.
  let assignGhostStatus = null;
  let assignGhostHung = false;
  try {
    const r = await rest.put('/api/irrigation-zones/' + zone.id + '/devices/' + ctx.freshDeveui('Z2-ghost-9'), {}, { timeoutMs: 8000 });
    assignGhostStatus = r.status;
  } catch (e) {
    assignGhostHung = true;
  }
  ctx.expect('assigning a device that was never registered gets SOME response (does not hang)',
    !assignGhostHung, { hung: assignGhostHung, status: assignGhostStatus, timeoutMs: 8000 });
  ctx.expect('assigning a device that was never registered returns 404',
    assignGhostStatus === 404, { status: assignGhostStatus });
  if (assignGhostHung) {
    ev.note('DEFECT: PUT /api/irrigation-zones/:id/devices/:deveui never responds when the DevEUI is not ' +
      'registered to the caller. flows.json node assign-device-update declares outputs: 1 but returns ' +
      '[null, msg] on the not-found path, so the 404 is dropped and no HTTP response is ever sent. ' +
      'Fix: give that node a second output wired to device-response, like every sibling node in the chain.');
  }

  const realDev = await ctx.createSimDevice({ deveui: goodEui, name: 'Sim KIWI ' + tag, type_id: 'KIWI_SENSOR' });
  ctx.expectStatus('the sensor registers once the payload is valid', realDev, [200, 201]);

  const assignGhostZone = await rest.put('/api/irrigation-zones/' + ghostId + '/devices/' + goodEui, {}, { timeoutMs: 8000 });
  ctx.expectStatus('assigning to a zone that does not exist returns 404', assignGhostZone, 404);

  // Same no-row-count-check shape as DELETE /api/devices: the unassign route
  // reports success for a zone id that does not exist.
  const unassignGhostZone = await rest.del('/api/irrigation-zones/' + ghostId + '/devices/' + goodEui, { timeoutMs: 8000 });
  ctx.expect('unassigning from a zone that does not exist answers 200 (no row-count check)',
    unassignGhostZone.status === 200, { status: unassignGhostZone.status, body: unassignGhostZone.body });

  const unassignNotAssigned = await rest.del('/api/irrigation-zones/' + zone.id + '/devices/' + goodEui);
  ctx.expect('unassigning a device that is not in that zone is rejected or a no-op, never a 500',
    unassignNotAssigned.status !== 500, { status: unassignNotAssigned.status, body: unassignNotAssigned.body });

  // --- delete a zone that still owns a device ------------------------------
  const assign = await rest.put('/api/irrigation-zones/' + zone.id + '/devices/' + goodEui, {});
  ctx.expectStatus('the sensor is assigned to the zone', assign, 200);

  const delWithDeps = await rest.del('/api/irrigation-zones/' + zone.id);
  ctx.expectStatus('deleting a zone that still owns a device succeeds', delWithDeps, 200);
  if (delWithDeps.status === 200) state.zones = state.zones.filter((z) => z !== zone.id);

  const orphan = await ssh.sqlOne(
    "SELECT irrigation_zone_id, deleted_at FROM devices WHERE deveui = '" + goodEui + "'"
  );
  ctx.expect('SQLite: the device is unassigned by the zone delete, not left pointing at a dead zone',
    !!orphan && (orphan.irrigation_zone_id === null), orphan);
  ctx.expect('SQLite: the device itself survives the zone delete', !!orphan && orphan.deleted_at === null, orphan);

  // --- delete a device that does not exist ---------------------------------
  // F33 / #264 (merged, main 77de1971c): delete-device-unlink's UPDATE now
  // returns its RETURNING result set; delete-device-response reports 404 when
  // that set is empty (deveui never registered, already unclaimed, or not
  // owned by this caller) instead of a fabricated 200.
  const ghostDeviceEui = ctx.freshDeveui('Z2-ghost-8');
  const delGhostDev = await rest.del('/api/devices/' + ghostDeviceEui);
  ctx.expectStatus('deleting a device that was never registered returns 404, not a fabricated success',
    delGhostDev, 404);
  ctx.expect('the 404 body does not claim the delete succeeded',
    !!delGhostDev.body && !/removed|success/i.test(JSON.stringify(delGhostDev.body)),
    { status: delGhostDev.status, body: delGhostDev.body });
  const ghostDeviceRows = await ssh.sqlScalar(
    "SELECT COUNT(*) AS n FROM devices WHERE deveui = '" + ghostDeviceEui + "'");
  ctx.expect('SQLite: deleting a device that was never registered does not create anything',
    Number(ghostDeviceRows) === 0, { rows: ghostDeviceRows });
};

exports.cleanup = async (ctx) => {
  for (const eui of state.devices.slice()) await ctx.deleteSimDevice(eui);
  for (const id of state.zones.slice()) await ctx.deleteZone(id);
  state.devices.length = 0;
  state.zones.length = 0;
};
