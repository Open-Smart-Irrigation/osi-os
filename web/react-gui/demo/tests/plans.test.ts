import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DemoError, Simulator, VALVE_EUI} from '../model';
import {localParts, nextLocalOccurrence, nextPlanRun} from '../model/plans';

const schedulesPath = `/api/valves/${VALVE_EUI}/schedules`;

test('weekly plan create, edit, disable, delete update schedule reads and compiled summary', () => {
  const sim = new Simulator({mode: 'public'});
  const created = sim.request('POST', schedulesPath, {
    kind: 'WEEKLY', weekdays_mask: 64, start_time: '06:00', duration_minutes: 15, label: 'Morning', enabled: true,
  }) as {schedule: {schedule_uuid: string}; pushes_queued: number};
  assert.ok(created.schedule.schedule_uuid);
  assert.ok(created.pushes_queued > 0);
  let snapshot = sim.request('GET', schedulesPath) as {schedules: Array<Record<string, unknown>>; compiled: {days: Array<unknown[]>}; push_state: Array<Record<string, unknown>>};
  assert.equal(snapshot.schedules.length, 1);
  assert.equal(snapshot.compiled.days[6]?.length, 1);
  const id = created.schedule.schedule_uuid;
  sim.request('PUT', `${schedulesPath}/${id}`, {duration_minutes: 20, enabled: false, label: 'Updated'});
  snapshot = sim.request('GET', schedulesPath) as typeof snapshot;
  assert.equal(snapshot.schedules[0]?.duration_minutes, 20);
  assert.equal(snapshot.schedules[0]?.enabled, false);
  assert.equal(snapshot.compiled.days[6]?.length, 0);
  sim.request('PUT', `${schedulesPath}/${id}`, {enabled: true});
  snapshot = sim.request('GET', schedulesPath) as typeof snapshot;
  assert.equal(snapshot.compiled.days[6]?.length, 1);
  sim.request('DELETE', `${schedulesPath}/${id}`);
  snapshot = sim.request('GET', schedulesPath) as typeof snapshot;
  assert.equal(snapshot.schedules.length, 0);
  assert.equal(snapshot.compiled.days[6]?.length, 0);
});

test('overlapping weekly plan is rejected atomically with native plan_conflict details', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 64, start_time: '06:00', duration_minutes: 15, label: 'First'});
  assert.throws(() => sim.request('POST', schedulesPath, {
    kind: 'WEEKLY', weekdays_mask: 64, start_time: '06:05', duration_minutes: 20, label: 'Second',
  }), (error: unknown) => {
    assert.ok(error instanceof DemoError);
    assert.equal(error.status, 422);
    assert.equal(error.code, 'plan_conflict');
    const details = (error.data as {details: Array<{code: string; weekday: number; conflicts: string[]; labels: Array<string | null>}>}).details;
    const first = (sim.request('GET', schedulesPath) as {schedules: Array<{schedule_uuid: string}>}).schedules[0]!;
    assert.equal(details[0]?.code, 'overlap');
    assert.equal(details[0]?.weekday, 6);
    assert.equal(details[0]?.conflicts[0], first.schedule_uuid);
    assert.equal(details[0]?.conflicts.length, 2);
    assert.deepEqual(details[0]?.labels, ['First', 'Second']);
    return true;
  });
  assert.equal((sim.request('GET', schedulesPath) as {schedules: unknown[]}).schedules.length, 1);
});

test('weekly validation enforces native duration, weekday mask, and at most four windows per day', () => {
  const sim = new Simulator({mode: 'public'});
  for (const duration of [1, 1439]) sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 64, start_time: `${String(duration === 1 ? 7 : 8).padStart(2, '0')}:00`, duration_minutes: duration});
  for (const input of [
    {kind: 'WEEKLY', weekdays_mask: 0, start_time: '09:00', duration_minutes: 5},
    {kind: 'WEEKLY', weekdays_mask: 64, start_time: '9:00', duration_minutes: 5},
    {kind: 'WEEKLY', weekdays_mask: 64, start_time: '09:00', duration_minutes: 1440},
  ]) assert.throws(() => sim.request('POST', schedulesPath, input));
  const other = new Simulator({mode: 'public'});
  for (let index = 0; index < 4; index++) other.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 64, start_time: `${String(index * 2).padStart(2, '0')}:00`, duration_minutes: 1});
  assert.throws(() => other.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 64, start_time: '08:00', duration_minutes: 1}), (error: unknown) => error instanceof DemoError && error.code === 'plan_conflict');
});

test('ONCE create and edit return normalized values without queuing weekly plan pushes', () => {
  const sim = new Simulator({mode: 'public'});
  const weekly = sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 64, start_time: '06:00', duration_minutes: 15}) as {pushes_queued: number};
  const once = sim.request('POST', schedulesPath, {kind: 'ONCE', fire_at: new Date(sim.now + 60_000).toISOString(), duration_minutes: 1, enabled: true}) as {schedule: {schedule_uuid: string; fire_at: string; once_state: string}; pushes_queued: number};
  assert.equal(once.pushes_queued, 0);
  assert.equal(once.schedule.once_state, 'PENDING');
  assert.equal(once.schedule.fire_at, new Date(sim.now + 60_000).toISOString());
  sim.request('PUT', `${schedulesPath}/${once.schedule.schedule_uuid}`, {fire_at: new Date(sim.now + 120_000).toISOString(), duration_minutes: 2, enabled: false});
  const read = sim.request('GET', schedulesPath) as {schedules: Array<Record<string, unknown>>; push_state: unknown[]};
  const reread = read.schedules.find(row => row.schedule_uuid === once.schedule.schedule_uuid)!;
  assert.equal(reread.duration_minutes, 2);
  assert.equal(reread.enabled, false);
  assert.equal(reread.fire_at, new Date(sim.now + 120_000).toISOString());
  assert.ok(weekly.pushes_queued > 0);
});

test('one-time plan produces a complete simulated run across one large tick', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', schedulesPath, {
    kind: 'ONCE', fire_at: new Date(sim.now + 60_000).toISOString(), duration_minutes: 1, enabled: true,
  });
  sim.advance(123_000);
  const response = sim.request('GET', '/api/irrigation/recent-actuations') as {
    actuations: Array<{status: string; observedOpenAt: string | null; observedCloseAt: string | null}>;
  };
  assert.equal(response.actuations.length, 1);
  assert.equal(response.actuations[0]!.status, 'COMPLETED');
  assert.ok(response.actuations[0]!.observedOpenAt);
  assert.ok(response.actuations[0]!.observedCloseAt);
});

test('one-time plan beyond the jump horizon remains scheduled and fires once', () => {
  const sim = new Simulator({mode: 'public'});
  const dueAt = sim.now + 9 * 24 * 60 * 60_000;
  const created = sim.request('POST', schedulesPath, {
    kind: 'ONCE', fire_at: new Date(dueAt).toISOString(), duration_minutes: 1, enabled: true,
  }) as {schedule: {schedule_uuid: string}};
  sim.advanceTo(dueAt + 63_000);
  const schedule = (sim.request('GET', schedulesPath) as {schedules: Array<{schedule_uuid: string; once_state: string}>}).schedules
    .find(row => row.schedule_uuid === created.schedule.schedule_uuid);
  const outcomes = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<{status: string}>}).actuations;
  assert.equal(schedule?.once_state, 'FIRED');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.status, 'COMPLETED');
});

test('adjacent delivered weekly windows close before equal-time start and retain both volumes', () => {
  const sim = new Simulator({mode: 'public'});
  const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(sim.now));
  const saturday = 64;
  sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: saturday, start_time: '06:00', duration_minutes: 15, label: 'First'});
  sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: saturday, start_time: '06:15', duration_minutes: 20, label: 'Second'});
  const [year, month, day] = date.split('-').map(Number);
  const start = Date.UTC(year!, month! - 1, day!, 0, 0) - 3 * 60 * 60 * 1000;
  sim.advanceTo(start + 36 * 60 * 60 * 1000);
  const outcomes = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<{status: string; estimatedGrossLiters: number | null}>}).actuations;
  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['COMPLETED', 'COMPLETED']);
  assert.equal(outcomes.reduce((total, outcome) => total + (outcome.estimatedGrossLiters ?? 0), 0), 210);
  assert.equal(outcomes[1]?.observedOpenAt, new Date(start + 6 * 60 * 60 * 1000).toISOString());
});

test('weekly timezone resolution matches spring gap, fall repeat, and invalid-zone source fallback', () => {
  const springFrom = Date.parse('2026-03-28T12:00:00Z');
  const spring = nextLocalOccurrence(springFrom, 'Europe/Zurich', 0, 2, 30);
  assert.ok(spring);
  assert.deepEqual(localParts(spring, 'Europe/Zurich'), {year: 2026, month: 3, day: 29, hour: 3, minute: 0, second: 0, weekday: 0});
  const fallFrom = Date.parse('2026-10-24T12:00:00Z');
  const fall = nextLocalOccurrence(fallFrom, 'Europe/Zurich', 0, 2, 30);
  assert.ok(fall);
  assert.equal(new Date(fall).toISOString(), '2026-10-25T01:30:00.000Z');
  assert.equal(localParts(Date.parse('2026-10-10T03:00:00Z'), 'Invalid/Test').hour, 3);
});

test('deactivated weekly control leaves ONCE edge dispatch independent', () => {
  const sim = new Simulator({mode: 'public'});
  const once = sim.request('POST', schedulesPath, {kind: 'ONCE', fire_at: new Date(sim.now + 60_000).toISOString(), duration_minutes: 1}) as {schedule: {schedule_uuid: string}};
  sim.request('POST', `/api/valves/${VALVE_EUI}/scheduler-status`, {status: 'DEACTIVATED'});
  sim.advanceTo(sim.now + 123_000);
  const snapshot = sim.request('GET', schedulesPath) as {schedules: Array<Record<string, unknown>>};
  const saved = snapshot.schedules.find(row => row.schedule_uuid === once.schedule.schedule_uuid)!;
  assert.equal(saved.once_state, 'FIRED');
  const outcomes = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<Record<string, unknown>>}).actuations;
  assert.equal(outcomes[0]?.status, 'COMPLETED');
});

test('weekly start before the queued delivery ACK is skipped and never replayed', () => {
  const sim = new Simulator({mode: 'public'});
  sim.advanceTo(sim.now + 9_000); // Public seed is 10 seconds before the Kampala 06:00 boundary.
  sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 64, start_time: '06:00', duration_minutes: 1, label: 'Too late to deliver'});
  sim.advanceTo(sim.now + 1_000);
  let outcomes = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<Record<string, unknown>>}).actuations;
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.cancelReason, 'plan_not_delivered');
  assert.equal(outcomes[0]?.observedOpenAt, null);
  sim.advanceTo(sim.now + 30_000); // The 2-second delivery ACK arrives after the missed start.
  outcomes = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<Record<string, unknown>>}).actuations;
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.cancelReason, 'plan_not_delivered');
});

test('resend fences a weekly occurrence until the resent generation is acknowledged', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 64, start_time: '06:00', duration_minutes: 1});
  sim.advanceTo(sim.now + 9_000);
  sim.request('POST', `/api/valves/${VALVE_EUI}/plan/resend`);
  sim.advanceTo(sim.now + 1_000);
  const outcomes = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<{cancelReason: string | null; observedOpenAt: string | null}>}).actuations;
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.cancelReason, 'plan_not_delivered');
  assert.equal(outcomes[0]?.observedOpenAt, null);
  sim.advanceTo(sim.now + 30_000);
  assert.equal((sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: unknown[]}).actuations.length, 1);
});

test('weekly delivery projection uses native per-weekday rows and response count', () => {
  const sim = new Simulator({mode: 'public'});
  assert.deepEqual((sim.request('GET', schedulesPath) as {push_state: unknown[]}).push_state, []);
  const created = sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 64, start_time: '06:00', duration_minutes: 15}) as {pushes_queued: number};
  assert.equal(created.pushes_queued, 8); // Seven changed weekday payloads plus the initial clock sync.
  let rows = (sim.request('GET', schedulesPath) as {push_state: Array<{purpose: string; weekday: number; state: string; plan_hash: string | null; queued_at: string | null; acked_at: string | null}>}).push_state;
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map(row => row.weekday).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(rows.every(row => row.purpose === 'WEEKDAY_PLAN' && row.state === 'QUEUED' && row.plan_hash && row.queued_at && row.acked_at === null));
  sim.advanceTo(sim.now + 2_000);
  rows = (sim.request('GET', schedulesPath) as {push_state: typeof rows}).push_state;
  assert.ok(rows.every(row => row.state === 'ACKED' && row.acked_at));
  const updated = sim.request('POST', `/api/valves/${VALVE_EUI}/plan/resend`) as {pushes_queued: number};
  assert.equal(updated.pushes_queued, 8);
});

test('GEN2 weekly delivery groups equal weekdays and switches scheduler-status purpose separately', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('PUT', `/api/valves/${VALVE_EUI}/settings`, {strega_generation: 'GEN2'});
  const created = sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 64, start_time: '06:00', duration_minutes: 15}) as {pushes_queued: number};
  assert.equal(created.pushes_queued, 3); // Two DAYMASK_PLAN groups plus initial CLOCK_SYNC.
  let rows = (sim.request('GET', schedulesPath) as {push_state: Array<{purpose: string; daymask: number | null; state: string; plan_hash: string | null}>}).push_state;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.purpose === 'DAYMASK_PLAN' && row.state === 'QUEUED' && row.plan_hash));
  assert.deepEqual(rows.map(row => row.daymask).sort(), [63, 64]);
  sim.request('POST', `/api/valves/${VALVE_EUI}/scheduler-status`, {status: 'DEACTIVATED'});
  rows = (sim.request('GET', schedulesPath) as {push_state: typeof rows}).push_state;
  assert.equal(rows.length, 2);
  sim.advanceTo(sim.now + 2_000);
  rows = (sim.request('GET', schedulesPath) as {push_state: typeof rows}).push_state;
  assert.ok(rows.every(row => row.state === 'ACKED'));
});

test('independent weekday delivery ACKs survive a later diff and generation switch', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 64, start_time: '06:00', duration_minutes: 15});
  sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 2, start_time: '07:00', duration_minutes: 15});
  let rows = (sim.request('GET', schedulesPath) as {push_state: Array<{purpose: string; weekday: number | null; daymask: number | null; state: string}>}).push_state;
  assert.equal(rows.filter(row => row.state === 'QUEUED').length, 7);
  sim.advanceTo(sim.now + 2_000);
  rows = (sim.request('GET', schedulesPath) as {push_state: typeof rows}).push_state;
  assert.ok(rows.every(row => row.state === 'ACKED'));

  const saturday = (sim.request('GET', schedulesPath) as {schedules: Array<{schedule_uuid: string; weekdays_mask: number}>}).schedules.find(row => row.weekdays_mask === 64)!;
  const changedDay = sim.request('PUT', `${schedulesPath}/${saturday.schedule_uuid}`, {start_time: '06:15'}) as {pushes_queued: number};
  assert.equal(changedDay.pushes_queued, 1); // Only Saturday changed; clock sync was already queued.
  rows = (sim.request('GET', schedulesPath) as {push_state: typeof rows}).push_state;
  const latestByWeekday = new Map<number, string>();
  for (const row of rows) if (row.weekday !== null && !latestByWeekday.has(row.weekday)) latestByWeekday.set(row.weekday, row.state);
  assert.equal(latestByWeekday.get(6), 'QUEUED');
  assert.ok([...latestByWeekday].filter(([day]) => day !== 6).every(([, state]) => state === 'ACKED'));

  sim.request('PUT', `/api/valves/${VALVE_EUI}/settings`, {strega_generation: 'GEN2'});
  const switched = sim.request('PUT', `${schedulesPath}/${saturday.schedule_uuid}`, {start_time: '06:30'}) as {pushes_queued: number};
  assert.equal(switched.pushes_queued, 3); // GEN2's empty-day, Tuesday, and Saturday groups.
  rows = (sim.request('GET', schedulesPath) as {push_state: typeof rows}).push_state;
  assert.equal(rows.filter(row => row.state === 'QUEUED' && row.purpose === 'WEEKDAY_PLAN').length, 0);
  assert.deepEqual(rows.filter(row => row.purpose === 'DAYMASK_PLAN' && row.state === 'QUEUED').map(row => row.daymask).sort((a, b) => Number(a) - Number(b)), [2, 61, 64]);
});

test('GEN2 all-days mask counts seven slots and label-only edits do not queue payloads', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('PUT', `/api/valves/${VALVE_EUI}/settings`, {strega_generation: 'GEN2'});
  const created = sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 127, start_time: '06:00', duration_minutes: 1}) as {schedule: {schedule_uuid: string}; pushes_queued: number};
  assert.equal(created.pushes_queued, 2); // One all-weekday DAYMASK payload plus initial CLOCK_SYNC.
  let raw = sim.request('GET', schedulesPath) as {push_state: Array<{daymask: number | null; state: string}>};
  assert.deepEqual(raw.push_state.map(row => [row.daymask, row.state]), [[0x80, 'QUEUED']]);
  let summary = (sim.request('GET', '/api/valves') as {valves: {device_eui: string; push_state: {queued: number; acked: number}}[]}).valves.find(row => row.device_eui === VALVE_EUI)!.push_state;
  assert.deepEqual([summary.queued, summary.acked], [7, 0]);
  sim.advanceTo(sim.now + 2_000);
  summary = (sim.request('GET', '/api/valves') as {valves: {device_eui: string; push_state: {queued: number; acked: number}}[]}).valves.find(row => row.device_eui === VALVE_EUI)!.push_state;
  assert.deepEqual([summary.queued, summary.acked], [0, 7]);
  const edited = sim.request('PUT', `${schedulesPath}/${created.schedule.schedule_uuid}`, {label: 'All days renamed'}) as {pushes_queued: number};
  assert.equal(edited.pushes_queued, 0);
  raw = sim.request('GET', schedulesPath) as typeof raw;
  assert.equal(raw.push_state.length, 1);
});

test('zero-push GEN2 to GEN1 switch supersedes queued opposite-generation rows', () => {
  const sim = new Simulator({mode: 'public'});
  const created = sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 64, start_time: '06:00', duration_minutes: 1}) as {schedule: {schedule_uuid: string}};
  sim.advanceTo(sim.now + 2_000);
  sim.request('PUT', `/api/valves/${VALVE_EUI}/settings`, {strega_generation: 'GEN2'});
  sim.request('PUT', `${schedulesPath}/${created.schedule.schedule_uuid}`, {label: 'GEN2 delivery'});
  let raw = sim.request('GET', schedulesPath) as {push_state: Array<{purpose: string; state: string}>};
  assert.ok(raw.push_state.some(row => row.purpose === 'DAYMASK_PLAN' && row.state === 'QUEUED'));

  sim.request('PUT', `/api/valves/${VALVE_EUI}/settings`, {strega_generation: 'GEN1'});
  const demoted = sim.request('PUT', `${schedulesPath}/${created.schedule.schedule_uuid}`, {label: 'GEN1 restored'}) as {pushes_queued: number};
  assert.equal(demoted.pushes_queued, 0); // Matching retained GEN1 hashes means no new payload.
  raw = sim.request('GET', schedulesPath) as typeof raw;
  assert.equal(raw.push_state.filter(row => row.purpose === 'DAYMASK_PLAN' && row.state === 'QUEUED').length, 0);
  const summary = (sim.request('GET', '/api/valves') as {valves: {device_eui: string; push_state: {queued: number}}[]}).valves.find(row => row.device_eui === VALVE_EUI)!.push_state;
  assert.equal(summary.queued, 0);
  sim.advanceTo(sim.now + 8_000); // Saturday's 06:00 edge must use the retained ACKed GEN1 payload.
  const outcomes = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<{cancelReason: string | null; observedOpenAt: string | null}>}).actuations;
  assert.equal(outcomes[0]?.cancelReason, null);
  assert.equal(outcomes[0]?.observedOpenAt, new Date(sim.now).toISOString());
  raw = sim.request('GET', schedulesPath) as typeof raw;
  assert.equal(raw.push_state.filter(row => row.purpose === 'DAYMASK_PLAN').length, 0); // A stale ACK did not revive the superseded generation.
});

test('skip today rolls over at the valve local midnight and clears the public summary', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', `/api/valves/${VALVE_EUI}/scheduler-status`, {status: 'SKIP_TODAY'});
  sim.advanceTo(sim.now + 24 * 60 * 60_000);
  const valve = (sim.request('GET', '/api/valves') as {valves: Array<{device_eui: string; scheduler_status: string; skip_today_date: string | null}>}).valves
    .find(row => row.device_eui === VALVE_EUI)!;
  assert.equal(valve.scheduler_status, 'ACTIVE');
  assert.equal(valve.skip_today_date, null);
});

test('timezone update that advances past the skip date clears SKIP_TODAY immediately', () => {
  const sim = new Simulator({mode: 'public'});
  sim.clock.reset(Date.parse('2026-10-10T20:30:00.000Z'));
  sim.request('POST', `/api/valves/${VALVE_EUI}/scheduler-status`, {status: 'SKIP_TODAY'});
  sim.request('PUT', '/api/irrigation-zones/1/config', {timezone: 'Asia/Tokyo'});
  const valve = (sim.request('GET', '/api/valves') as {valves: Array<{device_eui: string; scheduler_status: string; skip_today_date: string | null}>}).valves
    .find(row => row.device_eui === VALVE_EUI)!;
  assert.equal(valve.scheduler_status, 'ACTIVE');
  assert.equal(valve.skip_today_date, null);
});

test('weekly windows close at compiled local ends across spring gaps and fall repeats', () => {
  const run = (clockStart: string, expectedOpen: string, expectedClose: string, expectedLiters: number) => {
    const sim = new Simulator({mode: 'public'});
    sim.clock.reset(Date.parse(clockStart));
    const zone = sim.zones.find(row => row.id === 1)!;
    zone.timezone = 'Europe/Zurich';
    sim.request('POST', schedulesPath, {kind: 'WEEKLY', weekdays_mask: 1, start_time: '01:30', duration_minutes: 120});
    const closeAt = Date.parse(expectedClose);
    sim.advanceTo(closeAt + 60_000);
    const outcome = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<{status: string; observedOpenAt: string | null; observedCloseAt: string | null; estimatedGrossLiters: number | null}>}).actuations[0]!;
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.observedOpenAt, expectedOpen);
    assert.equal(outcome.observedCloseAt, expectedClose);
    assert.equal(outcome.estimatedGrossLiters, expectedLiters);
  };
  run('2026-03-28T12:00:00.000Z', '2026-03-29T00:30:00.000Z', '2026-03-29T01:30:00.000Z', 360);
  run('2026-10-24T12:00:00.000Z', '2026-10-24T23:30:00.000Z', '2026-10-25T02:30:00.000Z', 1080);
});

test('ONCE plans up to ten minutes late remain eligible while older edges are skipped once', () => {
  const recent = new Simulator({mode: 'public'});
  recent.request('POST', schedulesPath, {kind: 'ONCE', fire_at: new Date(recent.now - 5 * 60_000).toISOString(), duration_minutes: 1});
  recent.advanceTo(recent.now + 63_000);
  const recentRun = (recent.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<{status: string}>}).actuations[0];
  assert.equal(recentRun?.status, 'COMPLETED');
  const old = new Simulator({mode: 'public'});
  old.request('POST', schedulesPath, {kind: 'ONCE', fire_at: new Date(old.now - 10 * 60_000 - 1).toISOString(), duration_minutes: 1});
  const skipped = (old.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<{cancelReason: string}>}).actuations[0];
  assert.equal(skipped?.cancelReason, 'one_time_missed');
  old.advanceTo(old.now + 24 * 60 * 60_000);
  assert.equal((old.request('GET', '/api/irrigation/recent-actuations') as {actuations: unknown[]}).actuations.length, 1);
});

test('weekly and one-time schedule limits match the offered device controls', () => {
  const sim = new Simulator({mode: 'public'});
  for (const duration of [1, 255]) sim.request('POST', schedulesPath, {kind: 'ONCE', fire_at: new Date(sim.now + 86_400_000).toISOString(), duration_minutes: duration});
  for (const input of [
    {kind: 'ONCE', fire_at: new Date(sim.now + 86_400_000).toISOString(), duration_minutes: 256},
    {kind: 'ONCE', fire_at: 'not-an-instant', duration_minutes: 1},
    {kind: 'WEEKLY', weekdays_mask: 64, start_time: '06:00', duration_minutes: 1440},
  ]) assert.throws(() => sim.request('POST', schedulesPath, input));
});
