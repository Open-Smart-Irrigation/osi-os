import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {METER_EUI, PLANS_PATH, PROBE_EUI, VALVE_PATH, ZONE_PATH} from '../../src/core/osi/farm-builder';
import {DAY_MS, FARM_SITE, localDateStart, localDayStart} from '../../src/core/time';
import {atHour, buildAdapter, hash, iso, START, write} from './osi-fixture';

const device = '/api/devices/' + METER_EUI;
const schedules = PLANS_PATH + '/schedules';
const disable = '/api/irrigation-zones/schedules/disable-all';
const open = {action: 'OPEN_FOR_DURATION', duration_seconds: 600};
const secret = {example: 'discard this request payload'};
const refused: [method: string, path: string, body?: unknown][] = [
  ['POST', '/api/devices'], ['DELETE', device], ['PUT', ZONE_PATH + '/devices/' + METER_EUI],
  ['DELETE', ZONE_PATH + '/devices/' + METER_EUI],
  ...['dendro', 'temp', 'rain-gauge', 'flow-meter', 'chameleon', 'lsn50/mode', 'lsn50/interval',
    'lsn50/interrupt-mode', 'lsn50/5v-warmup', 'dendro-config', 'chameleon/depth', 'watermark/calibration',
    'kiwi/interval', 'soil-moisture-depths', 'reference-tree', 'zone-assignments', 'sdi12/config',
    'installation-location', 'radio-configuration', 'strega/interval', 'strega/model', 'strega/timed-action',
    'strega/magnet', 'strega/partial-opening', 'strega/flushing'].map((part): [string, string] => ['PUT', device + '/' + part]),
  ...['dendro-baseline/reset', 'chameleon/refresh-calibration', 'kiwi/temperature-humidity/enable', 'sdi12/identify',
    'sdi12/recipe/apply', 'sdi12/recipe/rollback'].map((part): [string, string] => ['POST', device + '/' + part]),
  ['DELETE', device + '/watermark/calibration'], ['PUT', PLANS_PATH + '/settings', {strega_generation: 'GEN2'}],
  ['PUT', PLANS_PATH + '/settings', {flow_rate_lpm: 2}], ['PUT', PLANS_PATH + '/settings', {flow_rate_source: 'measured'}],
  ['POST', '/api/irrigation-zones'], ['DELETE', ZONE_PATH], ['PUT', ZONE_PATH + '/config'],
  ['POST', ZONE_PATH + '/calibration'], ['PUT', ZONE_PATH + '/location'], ['PUT', ZONE_PATH + '/rain-source'],
  ['PUT', ZONE_PATH + '/irrigation-policy'], ['GET', ZONE_PATH + '/irrigation-policy'],
  ['POST', ZONE_PATH + '/irrigation-policy/pause'], ['POST', ZONE_PATH + '/irrigation-policy/retry-valve'],
  ['PUT', ZONE_PATH + '/schedule', {trigger_metric: 'DENDRO', threshold_kpa: 2, enabled: true}],
  ['PUT', ZONE_PATH + '/schedule', {trigger_metric: 'SWT_3', threshold_kpa: 30, enabled: true}],
  ['PUT', '/api/system/settings'], ['POST', '/api/system/fan'], ['POST', '/api/system/reboot'],
  ['POST', '/api/account-link'], ['DELETE', '/api/account-link'], ['POST', '/api/sync/force'],
  ['POST', '/auth/login'], ['POST', '/auth/register'], ['POST', '/api/users'], ['POST', '/api/grants'],
  ['POST', '/api/improvement-requests'],
  ['PUT', '/api/history/zones/1/cards/soil/preferences'], ['POST', '/api/history/zones/1/cards/soil/opened'],
  ['POST', '/api/history/workspaces'], ['PUT', '/api/history/workspaces/1'], ['DELETE', '/api/history/workspaces/1'],
  ['POST', '/api/analysis/series'], ['DELETE', '/api/analysis/views/1'],
  ['GET', '/api/history/export.csv'], ['GET', '/api/history/zones/1/export.csv'],
  ['GET', '/api/journal/export.json'], ['GET', '/api/journal/entries'], ['POST', '/api/journal/entries'],
  ['GET', '/api/network/observations'], ['GET', '/api/history/gateways/1'],
  ['GET', device + '/installation-location'], ['GET', device + '/radio-configuration'],
  ['GET', '/api/history/zones/1/cards/soil/data?from=2026-01-01T00:00:00Z&to=2027-01-11T00:00:00Z'],
  ['PUT', '/api/irrigation-zones/2/name'], ['PUT', '/api/devices/' + PROBE_EUI.toLowerCase() + '/name'],
  ['POST', VALVE_PATH + '0', open], ['GET', '//demo.invalid/api/devices'], ['GET', '/api/../%2e//api/devices'],
];

test('refused route inventory preserves the full simulator digest and logs no body', () => {
  const {adapter, traffic, log} = buildAdapter(4);
  const before = hash(adapter.simulatorSnapshot());
  for (const [method, path, body = secret] of refused) {
    const response = adapter.request(method, path, body);
    assert.equal(response.status, 403, method + ' ' + path);
    assert.equal((response.data as {error: string}).error, 'game_refused', path);
    assert.equal(hash(adapter.simulatorSnapshot()), before, path);
  }
  assert.equal(traffic.length, refused.length);
  assert.equal(log.length, 0);
  for (const event of traffic) {
    assert.equal(event.type, 'phone_refused');
    assert.deepEqual(Object.keys(event).sort(), ['code', 'method', 'path', 'simNow', 'type']);
  }
  assert.ok(!JSON.stringify(traffic).includes(secret.example));
});

test('history bounds explicit endpoints while preserving relative, forecast and month reads', () => {
  const {adapter} = buildAdapter(2);
  const cardsPath = '/api/history/zones/1/cards';
  const {cards} = write(adapter, 'GET', cardsPath) as {cards: {cardId: string; cardType: string}[]};
  const cardPath = (type: string) => cardsPath + '/' + encodeURIComponent(cards.find(card => card.cardType === type)!.cardId) + '/data';
  const soil = cardPath('soil');
  const environment = cardPath('environment');
  const history = (path: string, from: string, to: string, view = 'line-chart') => adapter.request('GET', path + '?' +
    new URLSearchParams({range: 'custom', timezone: FARM_SITE.timezone, view, from, to}));
  const earliest = localDayStart(START) - 92 * DAY_MS;
  const forecastEnd = localDayStart(START) + 4 * DAY_MS;
  const monthStart = localDateStart('2027-01-01');
  const monthEnd = localDateStart('2027-02-01') - 1;

  assert.equal(history(soil, iso(START - DAY_MS), iso(START + 5 * DAY_MS)).status, 403, 'future soil data');
  assert.equal(history(soil, iso(START - DAY_MS), '2027-01-11T06:00:00').status, 403, 'end without an offset');
  assert.equal(history(soil, iso(START - DAY_MS), 'invalid').status, 403, 'unparseable end');
  assert.equal(history(soil, iso(earliest - 1), iso(START)).status, 403, 'before retained history');
  assert.equal(history(soil, iso(START), iso(START)).status, 403, 'empty interval');
  assert.equal(history(environment, iso(START), iso(forecastEnd + 1)).status, 403, 'past the forecast horizon');
  assert.equal(history(soil, iso(monthStart), iso(monthEnd + DAY_MS), 'calendar').status, 403, 'past the calendar month');

  assert.equal(adapter.request('GET', soil + '?range=7d').status, 200);
  assert.equal(history(soil, iso(earliest), '2027-01-11T06:30:00+03:00').status, 200, 'retained history with a zoned end');
  assert.equal(history(environment, iso(START), iso(forecastEnd)).status, 200);
  assert.equal(history(soil, iso(monthStart), iso(monthEnd), 'calendar').status, 200);
  assert.equal(history(environment, iso(monthStart), iso(monthEnd), 'calendar').status, 200);
});

test('every allowed write shape rejects unknown keys without storing payloads', () => {
  const {adapter, traffic, log} = buildAdapter(4);
  const id = '00000000-0000-4000-8000-000000000001';
  const calls = [
    ['PUT', ZONE_PATH + '/name'], ['PUT', device + '/name'], ['POST', disable],
    ['POST', VALVE_PATH], ['POST', VALVE_PATH + '/cancel'], ['PUT', PLANS_PATH + '/settings'],
    ['POST', schedules], ['PUT', schedules + '/' + id], ['DELETE', schedules + '/' + id],
    ['POST', PLANS_PATH + '/plan/resend'], ['POST', PLANS_PATH + '/scheduler-status'], ['PUT', ZONE_PATH + '/schedule'],
  ];
  const before = hash(adapter.simulatorSnapshot());
  for (const [method, path] of calls) assert.equal(adapter.request(method, path, secret).status, 403, path);
  assert.equal(hash(adapter.simulatorSnapshot()), before);
  assert.equal(log.length, 0);
  assert.ok(traffic.every(event => !('body' in event)));
});

test('unnamed weekly and one-time plans round-trip with UTC one-time instants', () => {
  const {adapter, log} = buildAdapter(3);
  const weekly = {kind: 'WEEKLY', label: null, weekdays_mask: 127, start_time: '07:00', duration_minutes: 10};
  const once = {kind: 'ONCE', label: null, fire_at: '2027-01-11T10:00:00+03:00', duration_minutes: 10};
  for (const body of [weekly, once]) {
    const {schedule} = write(adapter, 'post', schedules, body) as {schedule: {schedule_uuid: string; label: string | null}};
    assert.equal(schedule.label, null);
    write(adapter, 'PUT', schedules + '/' + schedule.schedule_uuid, {label: null, duration_minutes: 11});
  }
  assert.deepEqual(log[2].body, {...once, fire_at: '2027-01-11T07:00:00.000Z'});
  assert.deepEqual(adapter.simulatorSnapshot().schedules[0][1].map(plan => [plan.label, plan.duration_minutes]),
    [[null, 11], [null, 11]]);
  const before = hash(adapter.simulatorSnapshot());
  assert.equal(adapter.request('POST', schedules, {...once, fire_at: '2027-01-11T10:00:00'}).status, 422);
  assert.equal(hash(adapter.simulatorSnapshot()), before);
});

test('disable-all is a no-op from T1 through T3 and T4 disables the trigger', () => {
  for (const tier of [1, 2, 3, 4] as const) {
    const {adapter} = buildAdapter(tier);
    const before = hash(adapter.simulatorSnapshot());
    assert.deepEqual(write(adapter, 'POST', disable), {disabledSchedules: tier === 4 ? 1 : 0});
    if (tier < 4) assert.equal(hash(adapter.simulatorSnapshot()), before);
    else assert.equal(adapter.simulatorSnapshot().zones[0].schedule?.enabled, false);
  }
});

test('recognized writes above the farm tier return the tier refusal', () => {
  const {adapter, traffic} = buildAdapter(1);
  for (const [method, path] of [['POST', VALVE_PATH], ['PUT', device + '/name'], ['PUT', ZONE_PATH + '/schedule']]) {
    const response = adapter.request(method, path, secret);
    assert.equal(response.status, 403);
    assert.equal((response.data as {error: string}).error, 'game_tier');
  }
  assert.equal(traffic.length, 3);
});

test('cancel passes the simulator answers through without a game refusal', () => {
  const {adapter, traffic} = buildAdapter(3);
  const cancel = () => adapter.request('POST', VALVE_PATH + '/cancel', {reason: 'operator_cancel'});
  const code = (data: unknown) => (data as {error: string}).error;
  assert.equal(cancel().status, 404);
  assert.equal(code(cancel().data), 'no_active_actuation');
  write(adapter, 'POST', VALVE_PATH, open);
  assert.equal(cancel().status, 200);
  write(adapter, 'POST', VALVE_PATH, open);
  adapter.advance(START + 2_000);
  const afterAck = cancel();
  assert.equal(afterAck.status, 409);
  assert.equal(code(afterAck.data), 'actuation_handed_off');
  assert.deepEqual(traffic, []);
});

test('phone returns detached cached responses and freezes its clock while closed', () => {
  const {adapter, traffic, queued} = buildAdapter(3);
  const settings = '/api/system/settings';
  const first = write(adapter, 'GET', settings) as {gatewayTimezone: string};
  const value = first.gatewayTimezone;
  first.gatewayTimezone = 'changed on the phone';
  assert.equal((write(adapter, 'GET', settings) as typeof first).gatewayTimezone, value);
  adapter.setPhoneOpen(false);
  adapter.advance(atHour(1, 7));
  assert.equal(adapter.phoneNow(), START);
  assert.equal((write(adapter, 'GET', settings) as typeof first).gatewayTimezone, value);
  assert.equal(adapter.request('GET', '/api/devices').status, 503);
  assert.equal(adapter.request('POST', VALVE_PATH, open).status, 503);
  assert.equal(traffic.filter(event => event.type === 'api_read').length, 2);
  queued.push(() => { adapter.setPhoneOpen(true); adapter.drainNow(); });
  write(adapter, 'POST', schedules, {kind: 'ONCE', fire_at: iso(atHour(1, 8)), duration_minutes: 10});
  assert.equal(adapter.phoneNow(), atHour(1, 7));
});

test('same-instant GET memo clears after a write and path matching uses normalized routes', () => {
  const {adapter, log} = buildAdapter(1);
  const zones = '/api/irrigation-zones';
  const name = () => (write(adapter, 'GET', zones) as {name: string}[])[0].name;
  assert.equal(name(), 'Tomato bed');
  write(adapter, 'put', zones + '/2/../1/name?ignored=1', {name: 'New bed name'});
  assert.equal(name(), 'New bed name');
  assert.equal(log[0].path, ZONE_PATH + '/name');
});

test('phone realm bodies are copied and replay writes still pass the allow-list', () => {
  const {adapter, log} = buildAdapter(1);
  const body: unknown = runInNewContext("({name: 'Another bed'})");
  write(adapter, 'PUT', ZONE_PATH + '/name', body);
  assert.deepEqual(log[0].body, {name: 'Another bed'});
  assert.notEqual(log[0].body, body);
  const before = hash(adapter.simulatorSnapshot());
  assert.throws(() => adapter.executePhoneWrite({...log[0], method: 'POST', path: '/api/account-link', body: secret}),
    /Invalid dispatched phone write/);
  assert.equal(hash(adapter.simulatorSnapshot()), before);
});

test('allowed valve and trigger settings retain plan management responses', () => {
  const {adapter} = buildAdapter(4);
  const config = {trigger_metric: 'SWT_AVG', threshold_kpa: 35, enabled: true, duration_minutes: 33};
  write(adapter, 'PUT', ZONE_PATH + '/schedule', config);
  const schedule = adapter.simulatorSnapshot().zones[0].schedule;
  for (const [key, value] of Object.entries(config)) assert.equal((schedule as unknown as Record<string, unknown>)[key], value);
  const changed = write(adapter, 'PUT', PLANS_PATH + '/settings', {default_open_minutes: 12}) as {
    settings: {default_open_minutes: number; flow_rate_lpm: number};
  };
  assert.deepEqual([changed.settings.default_open_minutes, changed.settings.flow_rate_lpm], [12, 8]);
  const body = {kind: 'WEEKLY', weekdays_mask: 127, start_time: '07:00', duration_minutes: 20};
  const created = write(adapter, 'POST', schedules, body) as {schedule: {schedule_uuid: string}};
  const conflict = adapter.request('POST', schedules, body);
  assert.equal(conflict.status, 422);
  assert.equal((conflict.data as {error: string}).error, 'plan_conflict');
  write(adapter, 'POST', PLANS_PATH + '/plan/resend');
  assert.deepEqual(write(adapter, 'POST', PLANS_PATH + '/scheduler-status', {status: 'SKIP_TODAY'}),
    {ok: true, status: 'SKIP_TODAY'});
  write(adapter, 'DELETE', schedules + '/' + created.schedule.schedule_uuid);
  assert.deepEqual(adapter.simulatorSnapshot().schedules[0][1], []);
});
