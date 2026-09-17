'use strict';
// C1 (partial) — local operation and outbox growth while the cloud is not
// reachable, observed through GET /api/sync/state and the sync_outbox table.
//
// SCOPE LIMIT, deliberate: this case never touches the cloud link. It does not
// create, break or repair an account link, does not cut the network, and does
// not call POST /api/sync/force in a way that would push this gateway's data
// anywhere. It only observes what the edge does with its own outbox while it
// keeps serving local traffic. Link/unlink, a real network cut, conflicting
// cloud edits, and expiry of queued CLOUD commands need a controlled cloud
// endpoint and stay out of scope here; a real, bounded cloud-reachability
// outage is R1(b)'s job. Duplicate LOCAL uplink delivery, an expired LOCAL
// (ONCE) queued action, and a stale LOCAL plan push's isolation from unrelated
// mutations ARE covered below (T16f additions) -- see their own section near
// the end of exports.run for the exact scoping of each.
//
// The invariant under test: the edge is authoritative. Local writes must
// succeed and be durably queued whether or not the cloud is reachable.

exports.title = 'Cloud-edge (partial): local writes while the cloud is unreachable, outbox growth';

const {
  PR_262_URL, REJECTED_RETENTION_DAYS, isKnownTerminalReason, hasRejectedOutboxShape,
} = require('../lib/rejections');
const { classifyOnceOutcome, ONCE_GRACE_MS } = require('../lib/onceGrace');

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
    s0.gatewayIdentity && s0.gatewayIdentity.currentEui === ctx.cfg.expectedEui, s0.gatewayIdentity);
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

  // F146 C1 #5: pendingOutboxCount is a genuinely LIVE `COUNT(*) ... FROM
  // sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL` on every
  // call (flows.json node "sync-state-build", ~line 6633) -- there is no
  // cache to go stale. The two numbers still diverged (API 38 vs SQLite 2,
  // run 6) because they are read over DIFFERENT transports (HTTP vs an SSH
  // sqlite3 CLI call) a moment apart, and this shared, backlog-heavy gateway
  // can move by dozens of rows in that moment once an outbox flush is
  // actively draining it -- the product never promised these two reads agree
  // at an arbitrary instant mid-flush, only that they agree once activity
  // settles (confirmed live: API==SQLite within two minutes). Poll for that
  // instead of comparing one point-in-time pair, so a genuine drift in the
  // API's own definition -- not a timing artifact -- still fails this check.
  const pendingSettled = await ctx.until(async () => {
    const apiNow = Number((await syncState(rest)).pendingOutboxCount);
    const sqlNow = await pendingOutbox(ssh);
    const diff = Math.abs(apiNow - sqlNow);
    return diff <= 2 ? { api: apiNow, sqlite: sqlNow, diff } : null;
  }, { timeoutMs: 20000, intervalMs: 2000, what: 'the API pending count to settle with the edge definition of pending' })
    .catch(async () => {
      const apiNow = Number((await syncState(rest)).pendingOutboxCount);
      const sqlNow = await pendingOutbox(ssh);
      return { api: apiNow, sqlite: sqlNow, diff: Math.abs(apiNow - sqlNow) };
    });
  ctx.expect('the API pending count matches the edge definition of pending (undelivered AND not rejected), ' +
    'once outbox activity settles',
    pendingSettled.diff <= 2, pendingSettled);
  const outboxBefore = pendingSettled.sqlite;

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
    // F146 C1 #7: same family as the pending-count settle above -- also a
    // live COUNT(*) (same sync-state-build node), also read a moment apart
    // from the SQLite ground truth over a different transport, also
    // observed to settle (API 948 vs SQLite 954, settled to 959/959 within
    // two minutes, run 6). Poll instead of comparing s0's single snapshot.
    const rejectedSettled = await ctx.until(async () => {
      const apiNow = Number((await syncState(rest)).rejectedOutboxCount);
      const sqlNow = await rejectedOutbox(ssh);
      const diff = Math.abs(apiNow - sqlNow);
      return diff <= 2 ? { api: apiNow, sqlite: sqlNow, diff } : null;
    }, { timeoutMs: 20000, intervalMs: 2000, what: 'the API rejected count to settle with sync_outbox' })
      .catch(async () => {
        const apiNow = Number((await syncState(rest)).rejectedOutboxCount);
        const sqlNow = await rejectedOutbox(ssh);
        return { api: apiNow, sqlite: sqlNow, diff: Math.abs(apiNow - sqlNow) };
      });
    ctx.expect('rejectedOutboxCount from /api/sync/state matches sync_outbox, once outbox activity settles ' +
      '(+/- 2 for events rejected mid-read)',
      rejectedSettled.diff <= 2, rejectedSettled);
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
    !!zoneEvent && String(zoneEvent.gateway_device_eui || '').toUpperCase() === ctx.cfg.expectedEui, zoneEvent);

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

  // --- nothing is lost, whether or not the cloud is currently draining -----
  // F122/F146: this case never creates a real outage -- a bounded, controlled
  // blackhole is R1(b)'s job (see the file header's SCOPE LIMIT). Fixing the
  // premise here in the harness sense of the word: `cloudReachable` is only a
  // heuristic guess from the staleness of lastOutboxDeliverySuccessAt, and it
  // does not reliably predict what THIS case's short write burst will
  // observably do to the outbox -- F122 found it guessing "unreachable" while
  // the outbox actually drained to 0 (the cloud was, in fact, reachable; the
  // 10-minute staleness window had simply not caught up yet). Asserting
  // growth-vs-drop from that guess asserts a state this case does not control
  // and the product never promised from it. What the product DOES promise --
  // this file's own header invariant, "the edge is authoritative; local
  // writes must succeed and be durably queued whether or not the cloud is
  // reachable" -- is checked unconditionally below: a real regression here
  // (a write silently dropped instead of queued/delivered) still fails this
  // check regardless of which way the guess points. Whether the backlog
  // happened to grow or drain during this run is recorded for the reader,
  // not asserted on -- a point-in-time API-vs-SQL direction comparison would
  // just reintroduce the same settle-timing race fixed above for #5/#7.
  const outboxAfter = await pendingOutbox(ssh);
  const s1 = await syncState(rest);
  ev.note('Cloud reachability guess for this run: ' + (cloudReachable ? 'reachable' : 'unreachable') +
    ' (lastOutboxDeliverySuccessAt ' + (s0.lastOutboxDeliverySuccessAt || 'never') + '). Observed outbox ' +
    'movement (report, not an assertion): SQLite pending ' + outboxBefore + ' -> ' + outboxAfter +
    ', API-reported ' + s0.pendingOutboxCount + ' -> ' + s1.pendingOutboxCount + '.');
  ctx.expect('local writes are queued or already delivered, never dropped, regardless of cloud reachability',
    outboxAfter >= 0 && !!zoneEvent && !!deviceEvent, { before: outboxBefore, after: outboxAfter });

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

  ev.note('Not covered here, and deliberately: link/unlink, network cut and restore, conflicting cloud edits, ' +
    'and expiry of queued CLOUD commands. Those need a controlled cloud endpoint and an account link this ' +
    'harness must not create. A bounded, real cloud-reachability outage (never a fabricated one) is R1(b)\'s job.');
  ev.note('Account link present on this gateway: ' + (linked ? 'yes' : 'no') + '.');

  // === T16f additions: duplicate delivery, expired queued action, stale =====
  // === LOCAL push isolation ==================================================
  // SCOPE LIMIT unchanged: none of this touches the cloud link.

  // --- duplicate delivery: the identical uplink, republished verbatim -------
  const dupEui = ctx.freshDeveui('C1-dup');
  state.devices.push(dupEui);
  const dupDevReg = await ctx.createSimDevice({ deveui: dupEui, name: 'Dup KIWI ' + tag, type_id: 'KIWI_SENSOR' });
  ctx.expectStatus('a device for the duplicate-delivery check registers', dupDevReg, [200, 201]);
  const dupEnv = ctx.U.kiwiUplink(ctx.profiles, {
    deveui: dupEui, swt1Kpa: 27, time: new Date(Date.now() - 5000).toISOString(),
  });
  ctx.publishSensorUplink(dupEnv);
  await ctx.until(async () => {
    const n = await ssh.sqlScalar("SELECT COUNT(*) AS n FROM device_data WHERE deveui = '" + dupEui + "'");
    return Number(n) >= 1 ? n : null;
  }, { timeoutMs: 15000, what: 'the first delivery to be ingested' }).catch(() => null);
  // Republish the EXACT same envelope object -- same deduplicationId, same
  // fCnt, same time -- simulating an at-least-once redelivery of the identical
  // uplink, not a second reading.
  ctx.publishSensorUplink(dupEnv);
  await ctx.sleep(4000);
  const dupCount = Number(await ssh.sqlScalar("SELECT COUNT(*) AS n FROM device_data WHERE deveui = '" + dupEui + "'"));
  ctx.expect('a byte-identical redelivered uplink (same deduplicationId, same fCnt, same time) produces exactly ' +
    'one device_data row, not two',
    dupCount === 1, { rows: dupCount, deduplicationId: dupEnv.deduplicationId, fCnt: dupEnv.fCnt });
  if (dupCount !== 1) {
    ev.note('FINDING: duplicate delivery is not deduplicated at ingest. No dedup key (fCnt, deduplicationId, or a ' +
      'unique (deveui, recorded_at) constraint) exists anywhere in the ingest path or device_data\'s schema ' +
      '(verified 2026-09-17: no matching index in database/seed-blank.sql, no fCnt/deduplicationId reference ' +
      'under osi-device-writer or the mqtt-in decode functions) -- every uplink that reaches the local broker is ' +
      'stored as its own row. In production this relies entirely on ChirpStack\'s own upstream dedup before it ' +
      'publishes to the local broker; this harness bypasses ChirpStack by design (T10 inventory, section 7), so ' +
      'it is exercising a path production traffic may never actually take. Worth a triage issue, not silently ' +
      'waved through here.');
  }

  // --- expired queued action: a ONCE open with a past fire_at must not fire -
  const expiredEui = ctx.freshDeveui('C1-expired');
  state.devices.push(expiredEui);
  const expiredZone = await rest.post('/api/irrigation-zones', { name: 'C1 Expired Zone ' + tag, timezone: 'Europe/Zurich' });
  ctx.expectStatus('a zone for the expired-schedule valve is created', expiredZone, 201);
  if (expiredZone.body && expiredZone.body.id) state.zones.push(expiredZone.body.id);
  const expiredDevReg = await ctx.createSimDevice({
    deveui: expiredEui, name: 'C1 Expired Valve ' + tag, type_id: 'STREGA_VALVE',
    strega_generation: 'GEN1', zoneId: expiredZone.body && expiredZone.body.id,
  });
  ctx.expectStatus('the expired-schedule valve registers', expiredDevReg, [200, 201]);
  const pastFireAt = new Date(Date.now() - 15 * 60000).toISOString(); // 15 min ago: past ONCE_GRACE_MS (10 min)
  ctx.expect('the reference grace-window classifier (lib/onceGrace) says a 15-minute-old fire_at will be SKIPPED, ' +
    'not fired -- pinning the assumption this live check relies on',
    classifyOnceOutcome(pastFireAt, Date.now()) === 'SKIP', { ONCE_GRACE_MS });
  const expiredSched = await rest.post('/api/valves/' + expiredEui + '/schedules', {
    kind: 'ONCE', fire_at: pastFireAt, duration_minutes: 3, label: 'expired ' + tag,
  });
  ctx.expectStatus('a ONCE schedule with a past fire_at is ACCEPTED by the API (validated as a timestamp, not as ' +
    '"must be in the future")', expiredSched, [200, 201]);
  const expiredUuid = expiredSched.body && (expiredSched.body.schedule_uuid ||
    (expiredSched.body.schedule && expiredSched.body.schedule.schedule_uuid));
  const skipped = await ctx.until(() => ssh.sqlOne(
    "SELECT once_state FROM valve_schedules WHERE schedule_uuid = '" + expiredUuid + "'"
  ).then((row) => (row && row.once_state !== 'PENDING' ? row : null)), { timeoutMs: 90000, intervalMs: 5000,
    what: 'the 60s once-tick to classify the expired schedule' }).catch(() => null);
  ctx.expect('SQLite: an expired queued action is marked SKIPPED, never FIRED',
    !!skipped && skipped.once_state === 'SKIPPED', skipped);
  ctx.expect('no downlink was emitted for the expired ONCE schedule',
    ctx.observer.downlinksFor(expiredEui).filter((d) => d.decoded.kind === 'TIMED_ACTION').length === 0,
    { downlinks: ctx.observer.downlinksFor(expiredEui).length });

  // --- a stale QUEUED plan push is never left duplicated by a recompile -----
  // "Stale command must not fire after reconnect" -- the RECONNECT half of
  // this needs a real disconnect/reconnect of the gateway's OWN mqtt client,
  // which only genuinely happens via a Node-RED restart; that half is R1(a)'s
  // job (this case must stay cloud-link-free and has no restart trigger of
  // its own). What IS safely testable here, locally, is the other half of
  // "stale": VERIFIED LIVE (2026-09-17, this run) that osi-valve-control's
  // compileAndQueue recompiles the FULL 7-weekday + CLOCK_SYNC plan on EVERY
  // schedule mutation for a device, not just the changed slot -- an earlier
  // draft of this check wrongly assumed an unrelated mutation would leave the
  // original push rows completely untouched, which is NOT what the real
  // system does (each mutation reissues fresh push rows for every slot and
  // marks the SUPERSEDED ones as such). The invariant that actually matters,
  // and is what "stale must not [also] fire" means here, is that a recompile
  // never leaves TWO live (QUEUED) commands for the SAME weekday/purpose slot
  // at once -- that would be the genuinely dangerous case (the stale one
  // could still be ACKed and "fire" alongside its replacement).
  const staleEui = ctx.freshDeveui('C1-stale');
  state.devices.push(staleEui);
  const staleDevReg = await ctx.createSimDevice({
    deveui: staleEui, name: 'C1 Stale Valve ' + tag, type_id: 'STREGA_VALVE', strega_generation: 'GEN1',
  });
  ctx.expectStatus('the stale-push valve registers', staleDevReg, [200, 201]);
  ctx.observer.setBehaviour(staleEui, 'drop'); // never ACKed -> stays QUEUED
  const staleSched = await rest.post('/api/valves/' + staleEui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 4, start_time: '04:00', duration_minutes: 5, label: 'stale ' + tag,
  });
  ctx.expectStatus('a schedule whose plan push will never be ACKed is created', staleSched, [200, 201]);
  const staleQueuedBefore = await ctx.until(() => ssh.sql(
    "SELECT push_id, purpose, fport, state FROM valve_schedule_pushes WHERE device_eui = '" + staleEui + "'"
  ).then((rows) => (rows.length ? rows : null)), { timeoutMs: 15000, what: 'the stale plan push to be queued' }).catch(() => []);
  ctx.expect('SQLite: the plan push is QUEUED (unanswered)', staleQueuedBefore.length >= 1 &&
    staleQueuedBefore.every((r) => r.state === 'QUEUED'), staleQueuedBefore);
  const dupeSlots = (rows) => {
    const seen = new Set(); const dupes = [];
    for (const r of rows.filter((x) => x.state === 'QUEUED')) {
      const key = r.purpose + ':' + r.fport;
      if (seen.has(key)) dupes.push(key); else seen.add(key);
    }
    return dupes;
  };
  ctx.expect('SQLite: no weekday/purpose slot has two simultaneously QUEUED pushes before the unrelated mutation',
    dupeSlots(staleQueuedBefore).length === 0, dupeSlots(staleQueuedBefore));

  // An unrelated mutation on the SAME device: a second, independent schedule,
  // which triggers a full recompile of the plan.
  const unrelatedSched = await rest.post('/api/valves/' + staleEui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 32, start_time: '05:00', duration_minutes: 5, label: 'unrelated ' + tag,
  });
  ctx.expectStatus('an unrelated second schedule on the same device is created', unrelatedSched, [200, 201]);
  await ctx.sleep(3000);
  const staleQueuedAfter = await ssh.sql(
    "SELECT push_id, purpose, fport, state FROM valve_schedule_pushes WHERE device_eui = '" + staleEui + "'");
  ctx.expect('SQLite: still no weekday/purpose slot has two simultaneously QUEUED pushes after the recompile ' +
    '(the recompile correctly SUPERSEDES the stale push for any changed slot rather than leaving both live)',
    dupeSlots(staleQueuedAfter).length === 0, dupeSlots(staleQueuedAfter));
  const originalPushIds = new Set(staleQueuedBefore.map((r) => r.push_id));
  const originalRowsAfter = staleQueuedAfter.filter((r) => originalPushIds.has(r.push_id));
  ctx.expect('SQLite: every original push row from before the recompile is now either still QUEUED (slot ' +
    'unchanged) or terminally SUPERSEDED (slot replaced) -- never left QUEUED alongside a newer QUEUED row for ' +
    'the same slot (checked above) and never silently vanished',
    originalRowsAfter.length === staleQueuedBefore.length &&
    originalRowsAfter.every((r) => r.state === 'QUEUED' || r.state === 'SUPERSEDED'),
    { before: staleQueuedBefore, after: originalRowsAfter });

  ev.note('C1 additions scope: "duplicate delivery" and "expired queued action" are exercised exactly as asked. ' +
    '"Stale command must not fire after reconnect" is split: the reconnect half (a real disconnect/reconnect of ' +
    'the GATEWAY\'s own MQTT client) is R1(a)\'s job, since that is the only place in this harness such a ' +
    'reconnect genuinely happens; the LOCAL half asserted here is that a full-plan recompile (triggered by an ' +
    'unrelated schedule mutation) never leaves a stale push and its replacement simultaneously QUEUED for the ' +
    'same weekday/purpose slot. The actual cloud-command replay path (flows.json `Route Command`, commandId-' +
    'keyed) is reachable only via the cloud pending-commands poll and is out of reach for this harness by design.');
};

exports.cleanup = async (ctx) => {
  for (const eui of state.devices.slice()) await ctx.deleteSimDevice(eui);
  for (const id of state.zones.slice()) await ctx.deleteZone(id);
  state.devices.length = 0;
  state.zones.length = 0;
};
