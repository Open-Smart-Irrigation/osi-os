'use strict';
// C1 (partial) — local operation and outbox growth while the cloud is not
// reachable, observed through GET /api/sync/state and the sync_outbox table.
//
// SCOPE LIMIT, deliberate: this case never touches the cloud link. It does not
// create, break or repair an account link, does not cut the network, and does
// not call POST /api/sync/force in a way that would push this gateway's data
// anywhere. It only observes what the edge does with its own outbox while it
// keeps serving local traffic. The interruption/reconnect/duplicate-delivery
// half of the C1 matrix row needs a controlled cloud endpoint and is out of
// scope here.
//
// The invariant under test: the edge is authoritative. Local writes must
// succeed and be durably queued whether or not the cloud is reachable.

exports.title = 'Cloud-edge (partial): local writes while the cloud is unreachable, outbox growth';

const state = { zones: [], devices: [] };

async function syncState(rest) {
  const res = await rest.get('/api/sync/state');
  return res.body || {};
}

// The edge's own definition of "pending" (sync-state-http):
//   delivered_at IS NULL AND rejected_at IS NULL
async function pendingOutbox(ssh) {
  return Number(await ssh.sqlScalar(
    'SELECT COUNT(*) AS n FROM sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL'));
}

// Rows the cloud refused for good. They are neither delivered nor pending, so
// nothing in the API or the GUI counts them.
async function rejectedOutbox(ssh) {
  return Number(await ssh.sqlScalar('SELECT COUNT(*) AS n FROM sync_outbox WHERE rejected_at IS NOT NULL'));
}

exports.run = async (ctx) => {
  const { rest, ssh, ev } = ctx;
  const tag = 'c1-' + Date.now().toString(36);

  const s0 = await syncState(rest);
  ctx.expect('GET /api/sync/state reports this gateway identity',
    s0.gatewayIdentity && s0.gatewayIdentity.currentEui === '0016C001F11715E2', s0.gatewayIdentity);
  ctx.expect('GET /api/sync/state reports a pending outbox count',
    typeof s0.pendingOutboxCount === 'number', { pendingOutboxCount: s0.pendingOutboxCount });
  ctx.expect('GET /api/sync/state reports database health',
    !!(s0.dbHealth && s0.dbHealth.quickCheck), s0.dbHealth);
  ctx.expect('the bundled database passes its own quick_check',
    s0.dbHealth && String(s0.dbHealth.quickCheck).toLowerCase() === 'ok', s0.dbHealth && s0.dbHealth.quickCheck);

  const linked = !!(s0.installationIdentity && s0.installationIdentity.currentGatewayDeviceEui);
  ev.note('Installation identity: ' + JSON.stringify(s0.installationIdentity) +
    '; last outbox delivery success: ' + (s0.lastOutboxDeliverySuccessAt || 'never') +
    '; last error: ' + (s0.lastError || 'none') + '.');

  const cloudReachable = !!s0.lastOutboxDeliverySuccessAt &&
    (Date.now() - Date.parse(s0.lastOutboxDeliverySuccessAt)) < 10 * 60 * 1000;
  ev.note('Cloud delivery in the last 10 minutes: ' + (cloudReachable ? 'yes' : 'no') +
    '. The outbox-growth assertions below only hold while the cloud is NOT draining the outbox.');

  const outboxBefore = await pendingOutbox(ssh);
  ctx.expect('the API pending count matches the edge definition of pending (undelivered AND not rejected)',
    Math.abs(Number(s0.pendingOutboxCount) - outboxBefore) <= 2,
    { api: s0.pendingOutboxCount, sqlite: outboxBefore });

  // Terminally rejected rows are invisible to every operator surface: the API
  // counts only delivered_at IS NULL AND rejected_at IS NULL, so a gateway whose
  // cloud sync has been failing for months still reports a small, healthy-looking
  // pending count while the table grows without bound.
  const rejectedBefore = await rejectedOutbox(ssh);
  const rejectionBreakdown = await ssh.sql(
    'SELECT rejection_reason, aggregate_type, COUNT(*) AS n FROM sync_outbox ' +
    'WHERE rejected_at IS NOT NULL GROUP BY rejection_reason, aggregate_type ORDER BY n DESC LIMIT 8'
  );
  const rejectedSpan = await ssh.sqlOne(
    'SELECT MIN(rejected_at) AS oldest, MAX(rejected_at) AS newest FROM sync_outbox WHERE rejected_at IS NOT NULL'
  );
  ctx.expect('the permanently rejected outbox backlog is bounded (retention prunes it)',
    rejectedBefore < 1000, { rejectedRows: rejectedBefore, span: rejectedSpan, topReasons: rejectionBreakdown });
  ctx.expect('GET /api/sync/state tells the operator about terminally rejected events, not just pending ones',
    rejectedBefore === 0 || Object.keys(s0).some((k) => /reject/i.test(k)),
    { rejectedRows: rejectedBefore, syncStateKeys: Object.keys(s0) });
  if (rejectedBefore > 0) {
    ev.note('sync_outbox holds ' + rejectedBefore + ' terminally rejected rows (' +
      (rejectedSpan && rejectedSpan.oldest) + ' .. ' + (rejectedSpan && rejectedSpan.newest) + '). ' +
      'GET /api/sync/state counts only rows that are neither delivered nor rejected, so it reports ' +
      s0.pendingOutboxCount + ' and no operator surface mentions the rejected pile. Top reasons: ' +
      JSON.stringify(rejectionBreakdown) + '.');
  }

  // --- local writes keep working -------------------------------------------
  const zone = await rest.post('/api/irrigation-zones', { name: 'Sync Zone ' + tag, timezone: 'Europe/Zurich' });
  ctx.expectStatus('a zone can be created regardless of cloud reachability (edge is authoritative)', zone, 201);
  if (zone.body && zone.body.id) state.zones.push(zone.body.id);

  const eui = ctx.freshDeveui('C1-kiwi');
  state.devices.push(eui);
  const dev = await ctx.createSimDevice({
    deveui: eui, name: 'Sim KIWI ' + tag, type_id: 'KIWI_SENSOR', zoneId: zone.body && zone.body.id,
  });
  ctx.expectStatus('a device can be registered regardless of cloud reachability', dev, [200, 201]);

  ctx.publishSensorUplink(ctx.U.kiwiUplink(ctx.profiles, {
    deveui: eui, swt1Kpa: 42, swt2Kpa: 44, temperatureC: 18, time: new Date(Date.now() - 60000).toISOString(),
  }));
  await ctx.until(async () => {
    const n = await ssh.sqlScalar("SELECT COUNT(*) AS n FROM device_data WHERE deveui = '" + eui + "'");
    return Number(n) >= 1 ? n : null;
  }, { timeoutMs: 20000, what: 'the telemetry row' }).catch(() => null);

  // --- the writes are queued for the cloud ---------------------------------
  const zoneEvent = await ssh.sqlOne(
    "SELECT aggregate_type, op, delivered_at, rejected_at, retry_count, gateway_device_eui " +
    "FROM sync_outbox WHERE aggregate_key = '" + (zone.body && zone.body.zone_uuid) + "' ORDER BY occurred_at DESC LIMIT 1"
  );
  ctx.expect('SQLite: the zone create is queued in sync_outbox', !!zoneEvent, zoneEvent);
  ctx.expect('SQLite: the queued event is stamped with this gateway EUI',
    !!zoneEvent && String(zoneEvent.gateway_device_eui || '').toUpperCase() === '0016C001F11715E2', zoneEvent);

  const deviceEvent = await ssh.sqlOne(
    "SELECT aggregate_type, op FROM sync_outbox WHERE aggregate_key = '" + eui + "' ORDER BY occurred_at DESC LIMIT 1"
  );
  ctx.expect('SQLite: the device registration is queued in sync_outbox', !!deviceEvent, deviceEvent);

  const telemetryEvent = await ctx.until(async () => {
    const row = await ssh.sqlOne(
      "SELECT aggregate_type, op FROM sync_outbox WHERE aggregate_type = 'DEVICE_DATA' " +
      "AND payload_json LIKE '%" + eui + "%' ORDER BY occurred_at DESC LIMIT 1"
    );
    return row || null;
  }, { timeoutMs: 15000, what: 'a DEVICE_DATA outbox event' }).catch(() => null);
  ctx.expect('SQLite: telemetry is queued for the cloud by the device_data INSERT trigger',
    !!telemetryEvent, telemetryEvent);

  // --- nothing is lost while the cloud is away -----------------------------
  const outboxAfter = await pendingOutbox(ssh);
  const s1 = await syncState(rest);
  if (cloudReachable) {
    ev.note('The cloud was draining the outbox during this run, so an exact growth assertion would be a ' +
      'race. Recorded instead: pending ' + outboxBefore + ' -> ' + outboxAfter + '.');
    ctx.expect('local writes are queued or already delivered, never dropped',
      outboxAfter >= 0 && !!zoneEvent && !!deviceEvent, { before: outboxBefore, after: outboxAfter });
  } else {
    ctx.expect('with the cloud unreachable, the pending outbox grows rather than dropping events',
      outboxAfter > outboxBefore, { before: outboxBefore, after: outboxAfter });
    ctx.expect('GET /api/sync/state surfaces the growing backlog to the operator',
      Number(s1.pendingOutboxCount) > Number(s0.pendingOutboxCount),
      { before: s0.pendingOutboxCount, after: s1.pendingOutboxCount });
  }

  // Simulated devices are unknown to the cloud, so VALVE_*/DEVICE events for them
  // are legitimately answered ownership_denied -- that is the documented
  // never-seen-resource rule, not a defect, and it is excluded here. A rejection
  // on a ZONE or ZONE_ENVIRONMENT aggregate is a different matter.
  // Scoped to the resources THIS case created, so a sibling case's leftovers
  // cannot make or break the assertion.
  const mine = "(aggregate_key = '" + eui + "' OR aggregate_key = '" + (zone.body && zone.body.zone_uuid) +
    "' OR payload_json LIKE '%" + eui + "%')";
  const freshRejects = await ssh.sql(
    "SELECT aggregate_type, op, rejection_reason FROM sync_outbox " +
    "WHERE rejected_at IS NOT NULL AND " + mine + " AND rejection_reason NOT LIKE 'ownership_denied%'"
  );
  ctx.expect("this case's own zone and telemetry events were not rejected with a version/payload conflict",
    freshRejects.length === 0, freshRejects);
  if (freshRejects.length) {
    ev.note('A brand-new device\'s first DEVICE_DATA_APPENDED events came back ' +
      JSON.stringify([...new Set(freshRejects.map((r) => r.rejection_reason))]) + '. The same reason accounts ' +
      'for most of the historical rejected pile on this gateway, so it is worth reading as a contract ' +
      'question (what sync_version a first append should carry) rather than as test residue.');
  }
  const simRejects = await ssh.sql(
    "SELECT aggregate_type, rejection_reason FROM sync_outbox WHERE rejected_at IS NOT NULL " +
    "AND rejection_reason LIKE 'ownership_denied%' AND " + mine + " LIMIT 5"
  );
  if (simRejects.length) {
    ev.note('This run\'s simulated devices produced ' + simRejects.length + ' ownership_denied rejection(s), ' +
      'which is the expected never-seen-resource rule. Note the side effect: every simulated device a test ' +
      'registers leaves permanently rejected rows behind in sync_outbox on a cloud-linked gateway.');
  }

  ctx.expect('GET /api/sync/state stays readable while the backlog grows',
    !!s1.gatewayIdentity && typeof s1.pendingOutboxCount === 'number', { pendingOutboxCount: s1.pendingOutboxCount });
  ctx.expect('the oldest pending event is reported so an operator can see how far behind the gateway is',
    outboxAfter === 0 || !!s1.pendingOutboxNewestAt || !!s1.pendingOutboxOldestAt,
    { oldest: s1.pendingOutboxOldestAt, newest: s1.pendingOutboxNewestAt, pending: outboxAfter });

  // --- the local read path is unaffected by cloud state --------------------
  const zones = await rest.get('/api/irrigation-zones');
  ctx.expect('zones still list correctly with a non-empty outbox',
    Array.isArray(zones.body) && zones.body.some((z) => z.zone_uuid === (zone.body && zone.body.zone_uuid)),
    { count: Array.isArray(zones.body) ? zones.body.length : -1 });

  const devices = await rest.get('/api/devices');
  ctx.expect('devices still list correctly with a non-empty outbox',
    Array.isArray(devices.body) && devices.body.some((d) => d.deveui === eui),
    { count: Array.isArray(devices.body) ? devices.body.length : -1 });

  ev.note('Not covered here, and deliberately: link/unlink, network cut and restore, duplicate delivery, ' +
    'conflicting cloud edits, and expiry of queued cloud commands. Those need a controlled cloud endpoint ' +
    'and an account link this harness must not create.');
  ev.note('Account link present on this gateway: ' + (linked ? 'yes' : 'no') + '.');
};

exports.cleanup = async (ctx) => {
  for (const eui of state.devices.slice()) await ctx.deleteSimDevice(eui);
  for (const id of state.zones.slice()) await ctx.deleteZone(id);
  state.devices.length = 0;
  state.zones.length = 0;
};
