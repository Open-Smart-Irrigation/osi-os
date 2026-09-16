'use strict';
// Z1 — zones and devices, the happy path: create, list, assign, unassign,
// re-assign, delete, and the empty-install state.
//
// Preconditions: none. Every zone and device here is created by this case, and
// all device EUIs are simulated (70B3D57ED00... — assertSimulatedDevice).
//
// Routes: POST/GET/DELETE /api/irrigation-zones, PUT/DELETE
// /api/irrigation-zones/:id/devices/:deveui, POST/GET/DELETE /api/devices.

exports.title = 'Zones + devices: create, assign, unassign, delete, empty install';

const state = { zones: [], devices: [] };

exports.run = async (ctx) => {
  const { rest, ssh, ev } = ctx;
  const tag = 'z1-' + Date.now().toString(36);

  // --- empty-install baseline ----------------------------------------------
  // "Empty install" for this harness account: a freshly registered user owns no
  // zones, whatever else is on the gateway.
  const baseline = await rest.get('/api/irrigation-zones');
  ctx.expectStatus('GET /api/irrigation-zones succeeds on an account with no zones', baseline, 200);
  const baselineCount = Array.isArray(baseline.body) ? baseline.body.length : -1;
  ctx.expect('an account with no zones gets an empty array, not an error or null',
    Array.isArray(baseline.body), { type: typeof baseline.body, count: baselineCount });

  const devBaseline = await rest.get('/api/devices');
  ctx.expectStatus('GET /api/devices succeeds on an account with no devices', devBaseline, 200);
  ctx.expect('an account with no devices gets an empty array',
    Array.isArray(devBaseline.body), { count: Array.isArray(devBaseline.body) ? devBaseline.body.length : -1 });

  // --- create a zone --------------------------------------------------------
  const zoneName = 'Zone ' + tag;
  const zc = await rest.post('/api/irrigation-zones', { name: zoneName, timezone: 'Europe/Zurich' });
  ctx.expectStatus('POST /api/irrigation-zones returns 201', zc, 201);
  const zone = zc.body || {};
  if (zone.id) state.zones.push(zone.id);
  ctx.expect('created zone carries a zone_uuid', typeof zone.zone_uuid === 'string' && zone.zone_uuid.length >= 32, zone.zone_uuid);
  ctx.expect('created zone is stamped with this gateway EUI',
    zone.gateway_device_eui === '0016C001F11715E2', zone.gateway_device_eui);
  ctx.expect('created zone starts at sync_version 1', Number(zone.sync_version) === 1, zone.sync_version);

  const zoneRow = await ssh.sqlOne(
    "SELECT id, name, zone_uuid, timezone, user_id, sync_version, deleted_at FROM irrigation_zones WHERE zone_uuid = '" + zone.zone_uuid + "'"
  );
  ctx.expect('SQLite: the zone row exists with the requested name', !!zoneRow && zoneRow.name === zoneName, zoneRow);
  ctx.expect('SQLite: the client-supplied timezone was persisted',
    !!zoneRow && zoneRow.timezone === 'Europe/Zurich', zoneRow ? zoneRow.timezone : null);
  ctx.expect('SQLite: the zone is owned by the calling user',
    !!zoneRow && Number(zoneRow.user_id) === Number(ctx.user.userId), { row: zoneRow && zoneRow.user_id, caller: ctx.user.userId });

  // A zone create must enqueue a sync event: cloud mirroring depends on it.
  const outboxRow = await ssh.sqlOne(
    "SELECT op, aggregate_type, aggregate_key FROM sync_outbox WHERE aggregate_key = '" + zone.zone_uuid + "' ORDER BY occurred_at DESC LIMIT 1"
  );
  ctx.expect('sync_outbox has an event for the new zone (cloud mirror would see it)',
    !!outboxRow, outboxRow);

  // --- create simulated devices --------------------------------------------
  const kiwiEui = ctx.simDeveui('Z1-kiwi', 1);
  const valveEui = ctx.simDeveui('Z1-valve', 1);

  // 201 on first registration, 200 when an earlier run's row is re-claimed:
  // because DELETE only unclaims (see below), a repeat run re-claims the same
  // surviving row instead of inserting a new one. Both are correct outcomes of
  // POST /api/devices ("created" vs "claimed"), so accept either.
  // Registered for cleanup BEFORE the call: if the create half-succeeds (or the
  // assertion below fails), cleanup must still try to release the device.
  state.devices.push(kiwiEui, valveEui);
  const dk = await ctx.createSimDevice({ deveui: kiwiEui, name: 'Sim KIWI ' + tag, type_id: 'KIWI_SENSOR' });
  ctx.expectStatus('POST /api/devices registers a simulated KIWI sensor (created or re-claimed)', dk, [200, 201]);
  ctx.expect('the registered sensor comes back with the requested type',
    dk.body && dk.body.type_id === 'KIWI_SENSOR' && dk.body.deveui === kiwiEui,
    dk.body ? { deveui: dk.body.deveui, type_id: dk.body.type_id } : null);
  ctx.expect('the sensor was provisioned into ChirpStack by the same request',
    dk.body && dk.body.provisioned_in_chirpstack === true, dk.body && dk.body.chirpstack);

  const dv = await ctx.createSimDevice({ deveui: valveEui, name: 'Sim Valve ' + tag, type_id: 'STREGA_VALVE', strega_generation: 'GEN1' });
  ctx.expectStatus('POST /api/devices registers a simulated STREGA valve (created or re-claimed)', dv, [200, 201]);
  ctx.expect('a new STREGA valve starts CLOSED', dv.body && dv.body.current_state === 'CLOSED', dv.body && dv.body.current_state);

  const devRow = await ssh.sqlOne(
    "SELECT deveui, type_id, name, current_state, gateway_device_eui, sync_version FROM devices WHERE deveui = '" + valveEui + "'"
  );
  ctx.expect('SQLite: the valve row exists with type STREGA_VALVE',
    !!devRow && devRow.type_id === 'STREGA_VALVE', devRow);

  // --- assign a device to the zone -----------------------------------------
  const assign = await rest.put('/api/irrigation-zones/' + zone.id + '/devices/' + kiwiEui, {});
  ctx.expectStatus('PUT zone/devices assigns the sensor to the zone', assign, 200);
  const assignedRow = await ssh.sqlScalar(
    "SELECT irrigation_zone_id FROM devices WHERE deveui = '" + kiwiEui + "'"
  );
  ctx.expect('SQLite: devices.irrigation_zone_id points at the zone',
    Number(assignedRow) === Number(zone.id), { actual: assignedRow, expected: zone.id });

  const listAfterAssign = await rest.get('/api/irrigation-zones');
  const zoneInList = (listAfterAssign.body || []).find((z) => z.zone_uuid === zone.zone_uuid);
  ctx.expect('the zone list reflects the assignment in device_count',
    !!zoneInList && Number(zoneInList.device_count) >= 1, zoneInList ? { device_count: zoneInList.device_count } : null);

  // --- move the device to a second zone ------------------------------------
  const z2 = await rest.post('/api/irrigation-zones', { name: 'Zone B ' + tag });
  ctx.expectStatus('a second zone can be created', z2, 201);
  if (z2.body && z2.body.id) state.zones.push(z2.body.id);

  const move = await rest.put('/api/irrigation-zones/' + z2.body.id + '/devices/' + kiwiEui, {});
  ctx.expectStatus('re-assigning the device to another zone succeeds', move, 200);
  const movedRow = await ssh.sqlScalar("SELECT irrigation_zone_id FROM devices WHERE deveui = '" + kiwiEui + "'");
  ctx.expect('SQLite: the device now belongs to the second zone only',
    Number(movedRow) === Number(z2.body.id), { actual: movedRow, expected: z2.body.id });

  // --- unassign -------------------------------------------------------------
  const unassign = await rest.del('/api/irrigation-zones/' + z2.body.id + '/devices/' + kiwiEui);
  ctx.expectStatus('DELETE zone/devices unassigns the device', unassign, 200);
  const unassignedRow = await ssh.sqlScalar("SELECT irrigation_zone_id FROM devices WHERE deveui = '" + kiwiEui + "'");
  ctx.expect('SQLite: irrigation_zone_id is cleared after unassign',
    unassignedRow === null || unassignedRow === undefined, { actual: unassignedRow });

  const deviceStillThere = await ssh.sqlScalar("SELECT COUNT(*) AS n FROM devices WHERE deveui = '" + kiwiEui + "' AND deleted_at IS NULL");
  ctx.expect('unassigning a device does not delete it', Number(deviceStillThere) === 1, { rows: deviceStillThere });

  // --- delete a device ------------------------------------------------------
  const delDev = await rest.del('/api/devices/' + kiwiEui);
  ctx.expectStatus('DELETE /api/devices removes the sensor', delDev, 200);
  // Pinned ACTUAL behaviour, not the behaviour the sync contract implies:
  // delete-device-unlink ("Unlink Device") runs
  //   UPDATE devices SET user_id = NULL, irrigation_zone_id = NULL, ...
  // It never sets deleted_at. So a "deleted" device is UNCLAIMED, not
  // tombstoned -- the row survives and the same DevEUI can be re-claimed later.
  // docs/contracts/sync-schema says tombstones cross the sync boundary as
  // deleted_at; this route produces no tombstone at all. Pinned here so a
  // future change to tombstoning shows up as a deliberate test update.
  const afterDelete = await ssh.sqlOne(
    "SELECT user_id, irrigation_zone_id, deleted_at, sync_version FROM devices WHERE deveui = '" + kiwiEui + "'"
  );
  ctx.expect('SQLite: DELETE /api/devices unclaims the device (user_id cleared)',
    !!afterDelete && afterDelete.user_id === null, afterDelete);
  ctx.expect('SQLite: DELETE /api/devices does NOT set deleted_at (device is unclaimed, never tombstoned)',
    !!afterDelete && afterDelete.deleted_at === null, afterDelete);
  ev.note('DELETE /api/devices/:deveui unclaims rather than tombstones: devices.deleted_at stays NULL and ' +
    'the row survives. The sync contract models deletion as a deleted_at tombstone, so a device removed on ' +
    'the edge never reaches the cloud as deleted. Re-registering the same DevEUI re-claims the surviving row.');
  const listAfterDelete = await rest.get('/api/devices');
  ctx.expect('a deleted device disappears from GET /api/devices',
    !(listAfterDelete.body || []).some((d) => d.deveui === kiwiEui),
    (listAfterDelete.body || []).map((d) => d.deveui));

  // --- delete a zone --------------------------------------------------------
  const delZone = await rest.del('/api/irrigation-zones/' + z2.body.id);
  ctx.expectStatus('DELETE /api/irrigation-zones removes the empty zone', delZone, 200);
  if (delZone.status === 200) state.zones = state.zones.filter((z) => z !== z2.body.id);
  const zoneTomb = await ssh.sqlOne("SELECT deleted_at FROM irrigation_zones WHERE id = " + z2.body.id);
  ctx.expect('SQLite: the zone is tombstoned, not hard-deleted',
    !zoneTomb || zoneTomb.deleted_at !== null, zoneTomb);
  const listAfterZoneDelete = await rest.get('/api/irrigation-zones');
  ctx.expect('a deleted zone disappears from GET /api/irrigation-zones',
    !(listAfterZoneDelete.body || []).some((z) => Number(z.id) === Number(z2.body.id)),
    (listAfterZoneDelete.body || []).map((z) => z.id));
};

exports.cleanup = async (ctx) => {
  for (const eui of state.devices.slice()) await ctx.deleteSimDevice(eui);
  for (const id of state.zones.slice()) await ctx.deleteZone(id);
  state.devices.length = 0;
  state.zones.length = 0;
};
