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

const {
  PR_262_URL, REJECTED_RETENTION_DAYS, isKnownTerminalReason, hasRejectedOutboxShape,
} = require('../lib/rejections');

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
  const runStartedAt = new Date().toISOString();

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

  // Terminally rejected rows are invisible to the pending-outbox count: the API
  // counts only delivered_at IS NULL AND rejected_at IS NULL, so a gateway whose
  // cloud sync has been failing for months still reports a small, healthy-looking
  // pending count while the table grows without bound. F30 / osi-os#262.
  const rejectedBefore = await rejectedOutbox(ssh);
  const rejectionBreakdown = await ssh.sql(
    'SELECT rejection_reason, aggregate_type, COUNT(*) AS n FROM sync_outbox ' +
    'WHERE rejected_at IS NOT NULL GROUP BY rejection_reason, aggregate_type ORDER BY n DESC LIMIT 8'
  );
  const rejectedSpan = await ssh.sqlOne(
    'SELECT MIN(rejected_at) AS oldest, MAX(rejected_at) AS newest FROM sync_outbox WHERE rejected_at IS NOT NULL'
  );
  if (rejectedBefore > 0) {
    ev.note('sync_outbox holds ' + rejectedBefore + ' terminally rejected rows (' +
      (rejectedSpan && rejectedSpan.oldest) + ' .. ' + (rejectedSpan && rejectedSpan.newest) + '). Top reasons: ' +
      JSON.stringify(rejectionBreakdown) + '.');
  }

  // (b) Operator surface: assert on the EXACT fields osi-os#262 adds to
  // GET /api/sync/state (rejectedOutboxCount, rejectedLast24h, lastRejection),
  // never on a substring match over key names -- a /reject/i name-regex
  // false-positives on the unrelated `rejectedMigrationCandidates` field (a
  // gateway-recovery/migration counter, not a sync_outbox counter).
  const has262Shape = hasRejectedOutboxShape(s0);
  ctx.expect(
    has262Shape
      ? 'GET /api/sync/state reports rejectedOutboxCount / rejectedLast24h / lastRejection{at,op,reason} (#262)'
      : 'expected-after-#262: GET /api/sync/state does not report rejectedOutboxCount / rejectedLast24h / ' +
        'lastRejection -- ' + PR_262_URL + ' is not merged into this payload',
    has262Shape,
    {
      syncStateKeys: Object.keys(s0),
      rejectedOutboxCount: s0.rejectedOutboxCount,
      rejectedLast24h: s0.rejectedLast24h,
      lastRejection: s0.lastRejection,
      pr: PR_262_URL,
    }
  );
  if (has262Shape) {
    ctx.expect('rejectedOutboxCount from /api/sync/state matches sync_outbox (+/- 2 for events rejected mid-read)',
      Math.abs(Number(s0.rejectedOutboxCount) - rejectedBefore) <= 2,
      { api: s0.rejectedOutboxCount, sqlite: rejectedBefore });
  }

  // (c) Absolute growth guard: explicit and documented instead of an arbitrary
  // "< 1000" threshold that is trivially true on any fresh install regardless
  // of whether retention exists. #262's prune-sync-outbox job deletes rejected
  // rows once they are older than a fixed REJECTED_RETENTION_DAYS window; until
  // #262 lands nothing prunes this table, so the count is REPORTED here, not
  // failed on.
  // Cutoff computed in JS (ISO string), not sqlite's datetime('now', ...): the
  // column is written as an ISO-8601 'T...Z' string, and datetime()'s
  // 'YYYY-MM-DD HH:MM:SS' output does not compare correctly against it.
  const staleCutoff = new Date(Date.now() - REJECTED_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const staleRejectedCount = Number(await ssh.sqlScalar(
    "SELECT COUNT(*) AS n FROM sync_outbox WHERE rejected_at IS NOT NULL AND rejected_at < '" + staleCutoff + "'"
  ));
  if (has262Shape) {
    ctx.expect('rejected outbox rows older than the ' + REJECTED_RETENTION_DAYS + '-day retention window are pruned (#262)',
      staleRejectedCount === 0, { staleRejectedCount, retentionDays: REJECTED_RETENTION_DAYS, pr: PR_262_URL });
  } else {
    ev.note('expected-after-#262: ' + staleRejectedCount + ' rejected outbox row(s) are already older than the ' +
      REJECTED_RETENTION_DAYS + '-day window ' + PR_262_URL + ' will prune. No pruning runs until #262 lands, so ' +
      'this is an observation, not a failure. Total rejected backlog right now: ' + rejectedBefore + ' row(s).');
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

  // (a) DELTA: what did THIS run's own traffic (the writes above) add to the
  // rejected pile since this case started, and is every new rejection
  // classified with a known terminal reason? ownership_denied is the
  // documented never-seen-resource rule for a simulated device/zone the
  // interim cloud has never seen -- EXPECTED here, and reported as an
  // observation below, never as a failure.
  const rejectedAfter = await rejectedOutbox(ssh);
  const rejectedDelta = await ssh.sql(
    'SELECT rejection_reason, aggregate_type, COUNT(*) AS n FROM sync_outbox ' +
    "WHERE rejected_at IS NOT NULL AND rejected_at >= '" + runStartedAt +
    "' GROUP BY rejection_reason, aggregate_type ORDER BY n DESC"
  );
  const unexplainedDelta = rejectedDelta.filter((r) => !isKnownTerminalReason(r.rejection_reason));
  ctx.expect("this run's own rejected-outbox rows (" + rejectedBefore + ' -> ' + rejectedAfter +
    ') are all classified with a known terminal reason',
    unexplainedDelta.length === 0,
    { rejectedBefore, rejectedAfter, rows: rejectedDelta, unexplained: unexplainedDelta });
  const expectedDelta = rejectedDelta
    .filter((r) => isKnownTerminalReason(r.rejection_reason))
    .reduce((sum, r) => sum + Number(r.n), 0);
  if (expectedDelta > 0) {
    ev.note('OBSERVATION, not a failure: this run added ' + expectedDelta + ' ownership_denied rejection(s) since ' +
      runStartedAt + ' (' + JSON.stringify(rejectedDelta) + '). Expected: the interim cloud denies first-seen ' +
      'resources, and this run\'s simulated devices/zones are not pre-registered there.');
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
