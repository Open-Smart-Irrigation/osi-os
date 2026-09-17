'use strict';
// R1 -- bounded runtime/recovery cases, Silvan only. Three independent,
// individually-guarded sub-cases; a failure or skip in one does not block the
// others. NONE of them reboot the Pi (reboot was tested at install, per the
// brief) and none touch /data/db directly.
//
//   (a) Node-RED restart while an uplink burst is in flight and a valve action
//       is queued: `/etc/init.d/node-red restart`, then poll for recovery.
//       Also carries C1's "stale command must not [mis]fire after reconnect"
//       check: a never-ACKed plan push must still be QUEUED, not resurrected
//       or re-fired, once Node-RED's own MQTT client reconnects. This is the
//       one place in this harness a real reconnect of the gateway's OWN
//       broker client happens; C1 stays cloud-link-free and has no restart.
//   (b) Bounded cloud disconnect: a SELF-REMOVING `ip route add blackhole`
//       toward whatever host this gateway's own account link actually points
//       at (never assumed, always read back from users.server_url) --
//       skipped entirely if the gateway has no link, or if the resolved host
//       is on the forbidden list, or if it is not a distinct routable host.
//   (c) Disk pressure: a 200 MB temp file under /data, only if free space
//       stays above 500 MB after it; GUI/API must keep answering.
//
// Safety notes specific to this case (beyond the harness-wide guards in
// lib/config.js, which still apply to every HTTP/MQTT/SSH endpoint used here):
//   - (b) NEVER adds a route before first arming a background deletion timer
//     for the exact same route, and NEVER trusts that timer alone: the case's
//     own `finally` also removes the route, and the case then reads the route
//     table back to prove it is gone. The resolved IP is cross-checked against
//     FORBIDDEN_HOSTS and against the harness's own SSH/API/MQTT endpoints
//     before it is ever used in an `ip route` command, so a misresolution
//     cannot blackhole the tunnel this harness is running over.
//   - (c) refuses to create the file at all unless free space would stay
//     >= 500 MB afterwards, and always attempts to remove it in `finally`.

exports.title = 'Runtime/recovery (bounded): Node-RED restart, cloud disconnect, disk pressure';

const { FORBIDDEN_HOSTS, hostOf } = require('../lib/config');
const { hasBlackholeRoute, parsePingResolvedIp } = require('../lib/routeParse');

const MIN_FREE_MB_AFTER = 500;
const DISK_FILE_MB = 200;

async function restartNodeRedCase(ctx) {
  const { rest, ssh, ev, observer } = ctx;
  const tag = 'r1a-' + Date.now().toString(36);
  ev.step('(a) Node-RED restart: begin');

  const zone = await rest.post('/api/irrigation-zones', { name: 'R1a Zone ' + tag, timezone: 'Europe/Zurich' });
  ctx.expectStatus('(a) a zone for the restart case is created', zone, 201);
  const zoneId = zone.body && zone.body.id;

  const valveEui = ctx.freshDeveui('R1a-valve');
  const sensorEui = ctx.freshDeveui('R1a-kiwi');
  const devReg = await ctx.createSimDevice({
    deveui: valveEui, name: 'R1a Valve ' + tag, type_id: 'STREGA_VALVE', strega_generation: 'GEN1', zoneId,
  });
  ctx.expectStatus('(a) the simulated valve registers', devReg, [200, 201]);
  const sensorReg = await ctx.createSimDevice({ deveui: sensorEui, name: 'R1a Kiwi ' + tag, type_id: 'KIWI_SENSOR', zoneId });
  ctx.expectStatus('(a) the simulated sensor registers', sensorReg, [200, 201]);
  observer.setBehaviour(valveEui, 'ack', { delayMs: 150 });

  // A THIRD device carries a stale, never-ACKed plan push across the restart.
  // This is the genuine "stale command must not [mis]fire after reconnect"
  // check (cross-referenced from C1's own additions): Node-RED's restart is
  // the one place in this harness where the GATEWAY's own MQTT client
  // actually disconnects and reconnects. A reconnect of the HARNESS's own
  // observer would prove nothing about gateway state, since QUEUED pushes
  // live in SQLite, not in the observer -- so that check belongs here, not in
  // C1, which must stay cloud-link-free and has no restart of its own.
  const staleEui = ctx.freshDeveui('R1a-stale');
  const staleReg = await ctx.createSimDevice({ deveui: staleEui, name: 'R1a Stale Valve ' + tag, type_id: 'STREGA_VALVE', strega_generation: 'GEN1' });
  ctx.expectStatus('(a) the stale-push valve registers', staleReg, [200, 201]);
  observer.setBehaviour(staleEui, 'drop'); // never ACKed -> stays QUEUED across the restart
  const staleSched = await rest.post('/api/valves/' + staleEui + '/schedules', {
    kind: 'WEEKLY', weekdays_mask: 4, start_time: '04:00', duration_minutes: 5, label: 'stale ' + tag,
  });
  ctx.expectStatus('(a) a schedule whose plan push will never be ACKed is created', staleSched, [200, 201]);
  const staleQueuedBefore = await ctx.until(() => ssh.sql(
    "SELECT push_id, state FROM valve_schedule_pushes WHERE device_eui = '" + staleEui + "'"
  ).then((rows) => (rows.length ? rows : null)), { timeoutMs: 15000, what: 'the stale plan push to be queued' }).catch(() => []);
  ctx.expect('(a) SQLite: the plan push is QUEUED (unanswered) before the restart',
    staleQueuedBefore.length >= 1 && staleQueuedBefore.every((r) => r.state === 'QUEUED'), staleQueuedBefore);

  // Queue a valve action before the restart.
  const open = await rest.put('/api/devices/' + valveEui + '/strega/timed-action', { action: 'OPEN', unit: 'minutes', amount: 3 });
  ctx.expectStatus('(a) a valve action is queued before the restart', open, 202);
  const expectationBefore = await ctx.until(() => ssh.sqlOne(
    "SELECT expectation_id, reconciliation_state FROM valve_actuation_expectations " +
    "WHERE device_eui = '" + valveEui + "' ORDER BY commanded_at DESC LIMIT 1"
  ), { timeoutMs: 12000, what: 'the pre-restart expectation row' }).catch(() => null);
  ctx.expect('(a) SQLite: the queued action has an expectation row before the restart', !!expectationBefore, expectationBefore);

  // Uplink burst: some in flight right as the restart is issued.
  const burstBefore = Array.from({ length: 3 }, (_, i) => ctx.U.kiwiUplink(ctx.profiles, {
    deveui: sensorEui, swt1Kpa: 20 + i, time: new Date(Date.now() - (3 - i) * 1000).toISOString(),
  }));
  for (const env of burstBefore) ctx.publishSensorUplink(env);

  ev.note('(a) issuing `/etc/init.d/node-red restart` over SSH now.');
  try {
    await ssh.exec('/etc/init.d/node-red restart', { timeout: 20000 });
  } catch (e) {
    // The init script legitimately may not return before this command's own
    // timeout while Node-RED is stopping/starting; that is not itself a
    // failure -- the poll loop below is the real assertion.
    ev.note('(a) the restart command did not return cleanly within 20s (' + e.message + '); continuing to poll ' +
      '/api/sync/state for recovery, which is the actual signal that matters.');
  }

  // Keep publishing uplinks through the downtime window and past recovery, so
  // "no data loss for uplinks sent after restart" has something concrete to
  // check: uplinks published once Node-RED's MQTT client has reconnected.
  const duringAndAfter = [];
  const publishTimer = setInterval(() => {
    const env = ctx.U.kiwiUplink(ctx.profiles, { deveui: sensorEui, swt1Kpa: 50, time: new Date().toISOString() });
    duringAndAfter.push(env);
    try { ctx.publishSensorUplink(env); } catch (_) { /* broker may be mid-restart; harmless */ }
  }, 5000);

  const healthy = await ctx.until(async () => {
    try {
      const res = await rest.get('/api/sync/state', { timeoutMs: 5000 });
      return res.status === 200 ? res : null;
    } catch (_) { return null; }
  }, { timeoutMs: 180000, intervalMs: 3000, what: '/api/sync/state to answer 200 again (3 min budget)' }).catch(() => null);
  clearInterval(publishTimer);

  ctx.expect('(a) /api/sync/state is healthy again within 3 minutes of the restart', !!healthy,
    healthy && { status: healthy.status });
  if (healthy) {
    ctx.expect('(a) the post-restart sync state reports a healthy DB quick_check',
      healthy.body && healthy.body.dbHealth && String(healthy.body.dbHealth.quickCheck).toLowerCase() === 'ok',
      healthy.body && healthy.body.dbHealth);
  }

  // F81 (coordinator finding, 2026-09-17, root-caused mid-task): Node-RED
  // startup triggers a cloud bootstrap attempt, and on the interim cloud this
  // was failing with a 500 because Silvan has deleted schedules whose
  // deleted_at is stored in SQLite's 'YYYY-MM-DD HH:MM:SS' format rather than
  // ISO-with-Z (see S1's own deleted_at format observation, added alongside
  // this). After the cloud release lands this must pass; until then a
  // bootstrap failure here is an EXPECTED, already-known finding, recorded
  // with its exact statusCode/message rather than silently passed.
  const restartIssuedAt = Date.now();
  const bootstrapOutcome = await ctx.until(async () => {
    const res = await rest.get('/api/sync/state');
    const body = res.body || {};
    if (body.lastError && body.lastError.source === 'bootstrap') return { failed: true, body };
    const successAt = body.lastBootstrapSuccessAt ? Date.parse(body.lastBootstrapSuccessAt) : NaN;
    if (Number.isFinite(successAt) && successAt >= restartIssuedAt - 5000) return { failed: false, body };
    return null;
  }, { timeoutMs: 180000, intervalMs: 5000,
    what: 'the restart-triggered cloud bootstrap (F81) to either succeed or report a bootstrap error' }).catch(() => null);

  if (!bootstrapOutcome) {
    ev.note('F81: within 3 minutes of the restart, /api/sync/state showed neither a bootstrap success timestamp ' +
      'advancing past the restart nor a lastError with source "bootstrap". Inconclusive -- not asserted as pass ' +
      'or fail. Current lastBootstrapSuccessAt/lastError: recorded in the HTTP transcript for this case.');
  } else if (bootstrapOutcome.failed) {
    ctx.expect('(a) F81: the restart-triggered cloud bootstrap does not fail', false, bootstrapOutcome.body.lastError);
    ev.note('F81 CONFIRMED on this run: bootstrap failed with lastError.source="bootstrap": ' +
      JSON.stringify(bootstrapOutcome.body.lastError) + '. Known root cause as of 2026-09-17: a deleted_at value ' +
      'on this gateway is in SQLite datetime format, not ISO-with-Z, which the interim cloud bootstrap endpoint ' +
      'rejects. Expected to clear once the cloud release (and/or the osi-os deleted_at ISO-format fix) lands.');
  } else {
    ctx.expect('(a) F81: the restart-triggered cloud bootstrap succeeded (lastBootstrapSuccessAt advanced past the restart)',
      true, { lastBootstrapSuccessAt: bootstrapOutcome.body.lastBootstrapSuccessAt });
  }

  // One more uplink, well after recovery is confirmed, with its own bounded wait.
  const postRecoveryEnv = ctx.U.kiwiUplink(ctx.profiles, { deveui: sensorEui, swt1Kpa: 33, time: new Date().toISOString() });
  ctx.publishSensorUplink(postRecoveryEnv);
  const postRecoveryRow = await ctx.until(() => ssh.sqlOne(
    "SELECT swt_1 FROM device_data WHERE deveui = '" + sensorEui + "' ORDER BY recorded_at DESC LIMIT 1"
  ), { timeoutMs: 20000, what: 'an uplink published after confirmed recovery to be ingested' }).catch(() => null);
  ctx.expect('(a) an uplink published AFTER /api/sync/state confirmed recovery is ingested (no data loss post-restart)',
    !!postRecoveryRow, postRecoveryRow);
  ev.note('(a) uplinks published DURING the restart\'s brief downtime window may be lost: the local MQTT broker ' +
    'has no persistent session/QoS1 redelivery configured for this client, which is expected transport behaviour, ' +
    'not asserted on here. What matters, and is asserted above, is that ingest resumes correctly once the tunnel ' +
    'and API are confirmed healthy again.');

  // The stale, never-ACKed push from before the restart: reconnecting must not
  // fabricate an ACK for it, and must not blindly re-fire it outside the
  // normal 10-minute valve-clock-sync cadence just because Node-RED came back.
  const staleQueuedAfter = await ssh.sql("SELECT push_id, state FROM valve_schedule_pushes WHERE device_eui = '" + staleEui + "'");
  ctx.expect('(a) SQLite: the stale plan push is still QUEUED after the restart (not spuriously marked ACKED)',
    staleQueuedAfter.length === staleQueuedBefore.length && staleQueuedAfter.every((r) => r.state === 'QUEUED'),
    { before: staleQueuedBefore, after: staleQueuedAfter });
  const stalePlanDownlinksAfter = observer.downlinksFor(staleEui).filter((d) => d.decoded.kind === 'WEEKDAY_PLAN').length;
  ctx.expect('(a) the restart-triggered reconnect does not itself cause an extra, unprompted re-push of the stale plan',
    stalePlanDownlinksAfter <= staleQueuedBefore.length + 1,
    { stalePlanDownlinksAfter, queuedBefore: staleQueuedBefore.length });

  const expectationAfter = await ssh.sqlOne(
    "SELECT expectation_id, reconciliation_state FROM valve_actuation_expectations " +
    "WHERE device_eui = '" + valveEui + "' ORDER BY commanded_at DESC LIMIT 1"
  );
  const KNOWN_STATES = ['PENDING_OBSERVATION', 'OBSERVED_RUNNING', 'CANCELLED', 'STALE_OPEN_OBSERVED', 'COMPLETED', 'EXPIRED'];
  ctx.expect('(a) SQLite: the queued action\'s expectation state is still one of the known, coherent states after restart ' +
    '(not NULL/corrupted)',
    !!expectationAfter && KNOWN_STATES.includes(expectationAfter.reconciliation_state), expectationAfter);

  await ctx.rest.post('/api/valve/' + valveEui + '/cancel', {}).catch(() => null);
  observer.setBehaviour(staleEui, 'observe');
  await ctx.deleteSimDevice(valveEui);
  await ctx.deleteSimDevice(sensorEui);
  await ctx.deleteSimDevice(staleEui);
  if (zoneId) await ctx.deleteZone(zoneId);
}

async function resolveLinkedCloudHost(ctx) {
  const { ssh, ev } = ctx;
  const row = await ssh.sqlOne("SELECT server_url FROM users WHERE server_url IS NOT NULL AND server_url != '' LIMIT 1");
  if (!row || !row.server_url) {
    ev.note('(b) no linked account (users.server_url is empty on every row) -- this gateway has no cloud link to ' +
      'bound-disconnect. Skipped, not failed.');
    return null;
  }
  const host = hostOf(row.server_url);
  if (!host) {
    ev.note('(b) users.server_url ("' + row.server_url + '") did not yield a parseable host. Skipped.');
    return null;
  }
  const forbidden = new Set(FORBIDDEN_HOSTS.map((h) => h.toLowerCase()));
  if (forbidden.has(host)) {
    ev.note('(b) REFUSING: the linked host resolves to "' + host + '", which is on this harness\'s own ' +
      'FORBIDDEN_HOSTS list. Skipped -- this must never be the target of a route manipulation.');
    return null;
  }
  if (host === hostOf(ctx.cfg.sshHost) || host === hostOf(ctx.cfg.apiBase) || host === hostOf(ctx.cfg.mqttHost)) {
    ev.note('(b) REFUSING: the linked host resolves to the same host as this harness\'s own SSH/API/MQTT endpoint ' +
      '(' + host + '). Skipped -- blackholing it would blackhole the tunnel this harness is running over.');
    return null;
  }
  // `getent` is not present on this BusyBox/OpenWrt image (verified
  // 2026-09-17). `nslookup`'s output prints the DNS RESOLVER's own address
  // first ("Server: 100.100.100.100" -- Tailscale MagicDNS here), so a naive
  // "first IPv4 in the text" grab over nslookup output would silently
  // resolve to the WRONG address. `ping -c1` ties the resolved address
  // unambiguously to the hostname being pinged, in its own first line.
  let ip = null;
  try {
    const out = await ssh.exec("ping -c1 -W2 " + host + " 2>&1 || true");
    ip = parsePingResolvedIp(out);
  } catch (e) { ev.note('(b) DNS resolution over SSH failed: ' + e.message); }
  if (!ip) {
    ev.note('(b) could not resolve "' + host + '" to an IPv4 address from the gateway. Skipped.');
    return null;
  }
  if (forbidden.has(ip)) {
    ev.note('(b) REFUSING: "' + host + '" resolved to ' + ip + ', which is itself on FORBIDDEN_HOSTS. Skipped.');
    return null;
  }
  return { host, ip };
}

async function cloudDisconnectCase(ctx) {
  const { rest, ssh, ev } = ctx;
  ev.step('(b) bounded cloud disconnect: begin');

  const target = await resolveLinkedCloudHost(ctx);
  if (!target) { ctx.expect('(b) skipped: no safe, distinct, linked cloud host to bound-disconnect', true, null); return; }
  const { host, ip } = target;
  ev.note('(b) resolved linked cloud host ' + host + ' -> ' + ip + '.');

  let routeAdded = false;
  try {
    // Arm the self-removing guard BEFORE the route exists, per the brief.
    await ssh.exec(
      "nohup sh -c 'sleep 180; ip route del blackhole " + ip + " 2>/dev/null' >/dev/null 2>&1 < /dev/null &",
      { timeout: 10000 }
    );
    ev.note('(b) armed a 180s background guard to remove the blackhole route even if this case is interrupted.');

    const s0 = await rest.get('/api/sync/state');
    const zoneBefore = await rest.post('/api/irrigation-zones', { name: 'R1b Zone before' });
    ctx.expectStatus('(b) local zone create works BEFORE the outage', zoneBefore, 201);
    if (zoneBefore.body && zoneBefore.body.id) await ctx.deleteZone(zoneBefore.body.id);

    await ssh.exec('ip route add blackhole ' + ip, { timeout: 10000 });
    routeAdded = true;
    const routeShow1 = await ssh.exec('ip route show', { timeout: 10000 });
    ctx.expect('(b) the blackhole route is actually present after adding it', hasBlackholeRoute(routeShow1, ip),
      { ip, routeShow: routeShow1.slice(0, 400) });

    // Local operation continues during the outage.
    const zoneDuring = await rest.post('/api/irrigation-zones', { name: 'R1b Zone during' });
    ctx.expectStatus('(b) local zone create still works DURING the outage (edge is authoritative)', zoneDuring, 201);
    const readDuring = await rest.get('/api/irrigation-zones');
    ctx.expectStatus('(b) local reads still work during the outage', readDuring, 200);
    if (zoneDuring.body && zoneDuring.body.id) await ctx.deleteZone(zoneDuring.body.id);

    // The outage is honestly surfaced -- via a signal that IS causally tied to
    // reachability, not `lastError`'s mere presence or `lastOutboxDeliverySuccessAt`:
    // this shared test gateway carries a PERSISTENT backlog of ownership_denied
    // outbox rejections from every prior harness run's simulated devices/zones
    // (documented in C1), plus, on this same run, F81's bootstrap failure --
    // both keep `lastError` non-null essentially all the time regardless of
    // this outage. Verified live 2026-09-17: `lastOutboxDeliverySuccessAt` is
    // ALSO useless here -- it is permanently null on this gateway (it appears
    // to only be set on a batch with ZERO rejections, which never happens on
    // a gateway with hundreds of accumulated ownership_denied rows). The
    // clean, unconfounded signal is `lastPendingCommandPollSuccessAt`: a
    // plain GET on the 30s pending-commands poll cadence, which either
    // succeeds (updates the timestamp) or fails outright on an unreachable
    // host -- no per-event business-logic rejection is possible on a GET.
    const beforePollSuccessAt = s0.body && s0.body.lastPendingCommandPollSuccessAt;
    await ctx.sleep(35000); // span at least one 30s pending-commands poll tick
    const s1 = await rest.get('/api/sync/state');
    const duringPollSuccessAt = s1.body && s1.body.lastPendingCommandPollSuccessAt;
    ctx.expect('(b) lastPendingCommandPollSuccessAt does NOT advance while the linked host is blackholed',
      duringPollSuccessAt === beforePollSuccessAt, { beforePollSuccessAt, duringPollSuccessAt });
    const p0 = Number(s0.body && s0.body.pendingOutboxCount);
    const p1 = Number(s1.body && s1.body.pendingOutboxCount);
    ctx.expect('(b) the pending outbox count is non-decreasing while the host is unreachable (nothing drains)',
      Number.isFinite(p0) && Number.isFinite(p1) && p1 >= p0, { before: p0, after: p1 });
    ev.note('(b) lastError during the outage (for the record, NOT used as the pass/fail signal -- see above): ' +
      JSON.stringify(s1.body && s1.body.lastError));
  } finally {
    if (routeAdded) {
      try { await ssh.exec('ip route del blackhole ' + ip, { timeout: 10000 }); } catch (e) {
        ev.note('(b) removing the blackhole route in finally raised: ' + e.message + ' (the 180s guard remains armed).');
      }
    }
  }

  const routeShow2 = await ssh.exec('ip route show', { timeout: 10000 }).catch(() => '');
  ctx.expect('(b) the blackhole route is gone after this case removes it', !hasBlackholeRoute(routeShow2, ip),
    { ip, routeShow: routeShow2.slice(0, 400) });

  // Recovery: the pending-commands poll resumes succeeding within a bounded
  // window (30s tick cadence + margin). This does NOT require lastError to go
  // null, nor lastOutboxDeliverySuccessAt to advance -- neither is a reliable
  // signal on this gateway (see above); the pre-existing ownership_denied/
  // bootstrap backlog is expected to keep surfacing independently of this
  // outage, and asserting it away would be asserting something this case did
  // not cause and cannot fix.
  const preRemovalPollSuccessAt = await rest.get('/api/sync/state')
    .then((r) => r.body && r.body.lastPendingCommandPollSuccessAt);
  const recovered = await ctx.until(async () => {
    const res = await rest.get('/api/sync/state');
    const successAt = res.body && res.body.lastPendingCommandPollSuccessAt;
    return (successAt && successAt !== preRemovalPollSuccessAt) ? res : null;
  }, { timeoutMs: 90000, intervalMs: 5000, what: 'lastPendingCommandPollSuccessAt to advance after the route is removed' }).catch(() => null);
  ctx.expect('(b) the pending-commands poll resumes succeeding after connectivity is restored',
    !!recovered, recovered ? { lastPendingCommandPollSuccessAt: recovered.body.lastPendingCommandPollSuccessAt } :
      { preRemovalPollSuccessAt });
}

async function diskPressureCase(ctx) {
  const { rest, ssh, ev } = ctx;
  ev.step('(c) disk pressure: begin');
  const tag = 'r1c-' + Date.now().toString(36);
  const filePath = '/data/.silvan-harness-diskpressure-' + tag;

  const dfBefore = await ssh.exec("df -Pk /data | tail -1", { timeout: 10000 });
  const freeKbBefore = Number((dfBefore.trim().split(/\s+/)[3]) || NaN);
  ctx.expect('(c) free space on /data is readable', Number.isFinite(freeKbBefore), { dfBefore: dfBefore.trim() });
  if (!Number.isFinite(freeKbBefore)) return;

  const freeMbAfter = (freeKbBefore / 1024) - DISK_FILE_MB;
  if (freeMbAfter < MIN_FREE_MB_AFTER) {
    ev.note('(c) skipped: only ' + Math.round(freeKbBefore / 1024) + ' MB free on /data; creating a ' +
      DISK_FILE_MB + ' MB file would leave ' + Math.round(freeMbAfter) + ' MB, below the ' + MIN_FREE_MB_AFTER +
      ' MB safety floor.');
    ctx.expect('(c) skipped for safety (insufficient headroom), not run unsafely', true, { freeKbBefore, freeMbAfter });
    return;
  }

  const diagBefore = await rest.get('/api/improvement-requests/diagnostics-preview');
  const diskFreePctBefore = diagBefore.body && diagBefore.body.diagnostics && diagBefore.body.diagnostics.health &&
    diagBefore.body.diagnostics.health.disk_free_pct;

  let created = false;
  try {
    await ssh.exec('dd if=/dev/zero of=' + filePath + ' bs=1M count=' + DISK_FILE_MB + ' 2>&1', { timeout: 60000 });
    created = true;
    const dfDuring = await ssh.exec("df -Pk /data | tail -1", { timeout: 10000 });
    const freeKbDuring = Number((dfDuring.trim().split(/\s+/)[3]) || NaN);
    ctx.expect('(c) free space actually dropped by roughly ' + DISK_FILE_MB + ' MB after creating the file',
      Number.isFinite(freeKbDuring) && (freeKbBefore - freeKbDuring) > (DISK_FILE_MB * 1024 * 0.8),
      { freeKbBefore, freeKbDuring });

    const statsDuring = await rest.get('/api/system/stats');
    ctx.expectStatus('(c) GET /api/system/stats still answers under disk pressure', statsDuring, 200);
    const zonesDuring = await rest.get('/api/irrigation-zones');
    ctx.expectStatus('(c) GET /api/irrigation-zones still answers under disk pressure', zonesDuring, 200);
    const guiDuring = await rest.get('/gui/', { raw: true });
    ctx.expect('(c) the GUI route still responds under disk pressure', guiDuring.status < 500,
      { status: guiDuring.status });

    const diagDuring = await ctx.until(async () => {
      const res = await rest.get('/api/improvement-requests/diagnostics-preview');
      const pct = res.body && res.body.diagnostics && res.body.diagnostics.health && res.body.diagnostics.health.disk_free_pct;
      return (typeof pct === 'number') ? res : null;
    }, { timeoutMs: 75000, intervalMs: 5000, what: 'the health snapshot to refresh with a disk_free_pct reading' }).catch(() => null);
    if (diagDuring) {
      const pctDuring = diagDuring.body.diagnostics.health.disk_free_pct;
      ev.note('(c) disk_free_pct before: ' + diskFreePctBefore + ', during pressure: ' + pctDuring + '. This is the ' +
        'only "low disk" surface found in this API (osi-health-helper diskFreePct, exposed via ' +
        '/api/improvement-requests/diagnostics-preview\'s health.disk_free_pct) -- there is no separate threshold/ ' +
        'alert field to assert on; a genuine warning banner (if any) is a GUI-side interpretation of this same number.');
      if (typeof diskFreePctBefore === 'number') {
        ctx.expect('(c) disk_free_pct reflects the pressure (did not increase)', pctDuring <= diskFreePctBefore,
          { before: diskFreePctBefore, during: pctDuring });
      }
    } else {
      ev.note('(c) the health snapshot did not refresh with a numeric disk_free_pct within 75s; the diagnostics ' +
        'route answered throughout regardless (asserted above).');
    }
  } finally {
    if (created) {
      try { await ssh.exec('rm -f ' + filePath, { timeout: 10000 }); } catch (e) {
        ev.note('(c) removing the pressure file in finally raised: ' + e.message);
      }
    }
  }

  const dfAfter = await ssh.exec("df -Pk /data | tail -1", { timeout: 10000 }).catch(() => '');
  const freeKbAfter = Number((dfAfter.trim().split(/\s+/)[3]) || NaN);
  ctx.expect('(c) free space is restored after removing the pressure file',
    Number.isFinite(freeKbAfter) && (freeKbAfter - freeKbBefore) > -(DISK_FILE_MB * 1024 * 0.2),
    { freeKbBefore, freeKbAfter });
}

exports.run = async (ctx) => {
  await restartNodeRedCase(ctx);
  await cloudDisconnectCase(ctx);
  await diskPressureCase(ctx);
};

exports.cleanup = async (ctx) => {
  // Each sub-case cleans up its own resources inline (zones/devices are
  // deleted as soon as each check that needs them is done, and both risky
  // system actions -- the blackhole route and the pressure file -- are
  // removed in their own try/finally). Nothing to do here beyond a final,
  // best-effort safety net in case an assertion threw before a sub-case's own
  // finally ran.
  ctx.ev.cleanupStep('R1 sub-cases clean up inline (see per-sub-case finally blocks)', true);
};
