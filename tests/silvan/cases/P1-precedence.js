'use strict';
// P1 -- control precedence on a SIMULATED STREGA valve: manual vs. a pending
// ONCE schedule, cancel invalidating a queued action, a schedule deleted while
// its action is queued, and retry-safety of the one LOCAL, always-reachable
// command-replay surface this harness can safely exercise.
//
// SCOPE LIMIT, deliberate, on the "retries never produce two irrigations for
// one intent (replay the same command id)" bullet: the one code path in this
// repo that is actually keyed by a replay-safe `commandId` is `Route Command`
// (flows.json, OSI-Server Cloud Integration tab) -- reachable ONLY via the
// cloud pending-commands poll, which this harness must never touch (see
// tests/silvan/README.md and C1's own scope limit). The manual actuation route
// (PUT .../strega/timed-action) has NO idempotency key by design: V1's
// "repeated clicks" case already proves two identical manual PUTs are two
// separate intents, on purpose, and is not re-litigated here. The closest safe,
// LOCAL, always-reachable analog is the cancel endpoint, which IS naturally
// idempotent (a second cancel of the same expectation 404s "no active
// actuation" rather than doing anything twice) -- exercised below as the
// retry-safety check this case can actually stand behind.
//
// Follows feedback_strega_valve_operation throughout: only OPEN_FOR_DURATION
// and the cancel endpoint are used, never a bare CLOSE.

exports.title = 'Precedence: manual vs. pending schedule, cancel, delete-while-queued, retry safety';

const { classifyOnceOutcome, ONCE_GRACE_MS } = require('../lib/onceGrace');

const state = { zones: [], devices: [] };

async function latestExpectation(ssh, eui) {
  return ssh.sqlOne(
    "SELECT expectation_id, reconciliation_state, cancel_reason, commanded_duration_seconds, expected_close_at " +
    "FROM valve_actuation_expectations WHERE device_eui = '" + eui + "' ORDER BY commanded_at DESC LIMIT 1"
  );
}

async function onceRow(ssh, uuid) {
  return ssh.sqlOne(
    "SELECT schedule_uuid, once_state, fire_at, deleted_at FROM valve_schedules WHERE schedule_uuid = '" + uuid + "'"
  );
}

// A fired ONCE schedule reaches the radio as a TIMED_ACTION/OPEN downlink (runOnceTick ->
// actuatorCommand -> OPEN_FOR_DURATION in osi-valve-control/workers.js), same as any other
// scheduled or manual open elsewhere in this case (lines below: `dl`, `cancelDownlinks`). Scope
// the "did the tombstoned schedule fire" count to exactly that kind, so an unrelated housekeeping
// push -- e.g. a Gen1 CLOCK_SYNC on fPort 12/13, which shares the same devEui and can legitimately
// land during a 75s wait -- is never mistaken for the schedule firing.
function isTimedActionOpen(d) {
  return d.decoded.kind === 'TIMED_ACTION' && d.decoded.valveAction === 'OPEN';
}

exports.run = async (ctx) => {
  const { rest, ssh, ev, observer } = ctx;
  const tag = 'p1-' + Date.now().toString(36);
  const eui = ctx.freshDeveui('P1-valve');
  state.devices.push(eui);

  const zone = await rest.post('/api/irrigation-zones', { name: 'P1 Zone ' + tag, timezone: 'Europe/Zurich' });
  ctx.expectStatus('a zone for the valve is created', zone, 201);
  if (zone.body && zone.body.id) state.zones.push(zone.body.id);

  const reg = await ctx.createSimDevice({
    deveui: eui, name: 'P1 Valve ' + tag, type_id: 'STREGA_VALVE',
    strega_generation: 'GEN1', zoneId: zone.body && zone.body.id,
  });
  ctx.expectStatus('the simulated valve registers', reg, [200, 201]);
  observer.setBehaviour(eui, 'ack', { delayMs: 150 });

  // === 1. offline: pin the exact grace-window formula P1/C1 both rely on ====
  const now = Date.now();
  ctx.expect('[offline] a ONCE fire_at 2 minutes in the past is still within the grace window (fires)',
    classifyOnceOutcome(new Date(now - 2 * 60000).toISOString(), now) === 'FIRE', { ONCE_GRACE_MS });
  ctx.expect('[offline] a ONCE fire_at 15 minutes in the past is past the grace window (skipped, never fires)',
    classifyOnceOutcome(new Date(now - 15 * 60000).toISOString(), now) === 'SKIP', { ONCE_GRACE_MS });

  // === 2. manual OPEN while an unrelated ONCE schedule is PENDING (not due) ==
  const farFuture = new Date(Date.now() + 3600000).toISOString(); // 1h out: never due during this case
  const pendingSched = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'ONCE', fire_at: farFuture, duration_minutes: 3, label: 'pending ' + tag,
  });
  ctx.expectStatus('a ONCE schedule far in the future is accepted', pendingSched, [200, 201]);
  const pendingUuid = pendingSched.body && (pendingSched.body.schedule_uuid || (pendingSched.body.schedule && pendingSched.body.schedule.schedule_uuid));

  const before = observer.downlinksFor(eui).length;
  const manual = await rest.put('/api/devices/' + eui + '/strega/timed-action', { action: 'OPEN', unit: 'minutes', amount: 2 });
  ctx.expectStatus('a manual OPEN is accepted while the ONCE schedule is pending', manual, 202);
  const dl = await observer.waitForDownlink((d) => d.deveui === eui && d.decoded.kind === 'TIMED_ACTION', 10000).catch(() => null);
  ctx.expect('the manual open produces its own downlink, independent of the pending schedule', !!dl,
    dl && { hex: dl.bytesHex });

  const pendingAfterManual = pendingUuid ? await onceRow(ssh, pendingUuid) : null;
  ctx.expect('SQLite: the far-future ONCE schedule is untouched by the concurrent manual open (still PENDING)',
    !!pendingAfterManual && pendingAfterManual.once_state === 'PENDING', pendingAfterManual);

  const manualExpectation = await ctx.until(() => latestExpectation(ssh, eui), { timeoutMs: 12000, what: 'the manual expectation row' }).catch(() => null);
  ctx.expect('SQLite: the manual open produced its own valve_actuation_expectations row', !!manualExpectation, manualExpectation);

  // === 3. cancel invalidates the queued/active action; no downlink after ====
  const cancel1 = await rest.post('/api/valve/' + eui + '/cancel', {});
  ctx.expect('cancel of the active manual action succeeds', cancel1.status === 200, { status: cancel1.status, body: cancel1.body });
  const cancelled = await ctx.until(async () => {
    const row = await latestExpectation(ssh, eui);
    return row && row.reconciliation_state === 'CANCELLED' ? row : null;
  }, { timeoutMs: 12000, what: 'the expectation to become CANCELLED' }).catch(() => null);
  ctx.expect('SQLite: cancel marks the active expectation CANCELLED', !!cancelled, cancelled);

  const dlCountAfterCancel = observer.downlinksFor(eui).length;
  await ctx.sleep(2000);
  ctx.expect('no downlink is emitted after cancel (the expectation stays cancelled, no re-issue)',
    observer.downlinksFor(eui).length === dlCountAfterCancel, { downlinks: observer.downlinksFor(eui).length });
  const cancelDownlinks = observer.downlinksFor(eui).filter(
    (d) => d.decoded.kind === 'CLOSE' || (d.decoded.kind === 'TIMED_ACTION' && d.decoded.valveAction === 'CLOSE')
  );
  ctx.expect('cancel never emitted a bare CLOSE downlink (OPEN_FOR_DURATION-only rule)', cancelDownlinks.length === 0,
    { closeDownlinks: cancelDownlinks.map((d) => d.bytesHex) });

  // A late uplink race: the (real, in production) valve may have already
  // received the OPEN over the radio before the cancel reached ChirpStack's
  // queue, and could still report itself OPEN afterwards. Read back what the
  // reconciliation logic actually does with this, rather than assuming.
  observer.publishUplink(ctx.U.stregaStatusUplink(ctx.profiles, { deveui: eui, open: true }), ctx.env.CHIRPSTACK_APP_ACTUATORS);
  await ctx.sleep(3000);
  const afterLateUplink = await latestExpectation(ssh, eui);
  ev.note('after a late "still OPEN" uplink race following cancel, the latest expectation reconciliation_state ' +
    'is: ' + (afterLateUplink && afterLateUplink.reconciliation_state) + '. Recorded as an observation of actual ' +
    'behaviour, not assumed in advance.');
  ctx.expect('a late post-cancel uplink does not revert the CANCELLED expectation back to an active state',
    !!afterLateUplink && afterLateUplink.reconciliation_state !== 'PENDING_OBSERVATION' && afterLateUplink.reconciliation_state !== 'OBSERVED_RUNNING',
    afterLateUplink);

  // === 4. retry-safety: a repeated cancel is idempotent, never double-acts ===
  const cancel2 = await rest.post('/api/valve/' + eui + '/cancel', {});
  ctx.expect('a SECOND cancel of the same (already-cancelled) actuation is refused as "no active actuation", ' +
    'not treated as a new cancel intent (idempotent replay, not a double side effect)',
    cancel2.status === 404, { status: cancel2.status, body: cancel2.body });
  const stillCancelled = await latestExpectation(ssh, eui);
  ctx.expect('SQLite: the expectation state is unchanged by the redundant second cancel',
    !!stillCancelled && stillCancelled.reconciliation_state === 'CANCELLED' &&
    stillCancelled.expectation_id === (cancelled && cancelled.expectation_id),
    stillCancelled);

  // === 5. a schedule deleted while its action is queued fires at most once ==
  const soon = new Date(Date.now() + 90000).toISOString(); // 90s out: due before this case ends, well inside the grace window
  const queuedSched = await rest.post('/api/valves/' + eui + '/schedules', {
    kind: 'ONCE', fire_at: soon, duration_minutes: 2, label: 'queued ' + tag,
  });
  ctx.expectStatus('a ONCE schedule due soon is accepted', queuedSched, [200, 201]);
  const queuedUuid = queuedSched.body && (queuedSched.body.schedule_uuid || (queuedSched.body.schedule && queuedSched.body.schedule.schedule_uuid));

  const del = await rest.del('/api/valves/' + eui + '/schedules/' + queuedUuid);
  ctx.expect('the queued schedule can be deleted before it fires', del.status < 300, { status: del.status });
  const deletedRow = await onceRow(ssh, queuedUuid);
  ctx.expect('SQLite: the deleted schedule is tombstoned (deleted_at set)', !!deletedRow && deletedRow.deleted_at !== null, deletedRow);

  ctx.expect('[offline] the once-tick downlink filter counts only TIMED_ACTION/OPEN pushes, excluding an ' +
    'unrelated CLOCK_SYNC housekeeping push (fPort 12/13) and a TIMED_ACTION/CLOSE',
    [
      { decoded: { kind: 'TIMED_ACTION', valveAction: 'OPEN' } },
      { decoded: { kind: 'CLOCK_SYNC' } },
      { decoded: { kind: 'TIMED_ACTION', valveAction: 'CLOSE' } },
      { decoded: { kind: 'OPEN' } },
    ].filter(isTimedActionOpen).length === 1, {});

  const downlinksBeforeWait = observer.downlinksFor(eui).filter(isTimedActionOpen).length;
  // Wait past the schedule's original fire_at plus one 60s tick period, so a
  // tick that ignored the tombstone would have had a full opportunity to fire.
  await ctx.sleep(75000);
  const downlinksAfterWait = observer.downlinksFor(eui).filter(isTimedActionOpen).length;
  const rowAfterWait = await onceRow(ssh, queuedUuid);
  ctx.expect('SQLite: the deleted schedule never fires (once_state was never advanced to FIRED after deletion)',
    !!rowAfterWait && rowAfterWait.once_state !== 'FIRED', rowAfterWait);
  ctx.expect('no TIMED_ACTION/OPEN downlink was emitted for the deleted schedule\'s original fire_at window ' +
    '(the once-tick excludes deleted_at IS NOT NULL rows); scoped past unrelated housekeeping pushes ' +
    '(e.g. CLOCK_SYNC) that may legitimately land on this devEui during the wait',
    downlinksAfterWait === downlinksBeforeWait, { before: downlinksBeforeWait, after: downlinksAfterWait });
  ev.note('This wait (75s) is the one place this case spends real wall-clock time, to observe the 60s ' +
    'valve-once-tick actually skip a tombstoned row rather than asserting it from the query text alone.');
};

exports.cleanup = async (ctx) => {
  for (const eui of state.devices.slice()) {
    ctx.observer.setBehaviour(eui, 'observe');
    try { await ctx.rest.post('/api/valve/' + eui + '/cancel', {}); } catch (_) { /* best-effort */ }
    await ctx.deleteSimDevice(eui);
  }
  for (const id of state.zones.slice()) await ctx.deleteZone(id);
  state.devices.length = 0;
  state.zones.length = 0;
};
