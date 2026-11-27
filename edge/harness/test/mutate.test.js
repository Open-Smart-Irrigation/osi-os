'use strict';
// Unit tests for the tier-B mutation pass: operators, input sites, the sql
// literal locator and the direction of the effect comparison.
const test = require('node:test'), assert = require('node:assert');
const { loadOperators } = require('../lib/mutate-ops');
const { mutantsOf, sitesOf, parsePairs } = require('../lib/mutate-sites');
const { findWrittenLiterals, sqlLiteral } = require('../lib/mutate-sql');
const { effectsOf, minus, verdict } = require('../lib/mutate-effects');

const op = (name) => loadOperators([name])[0];

test('registry loads one operator per mutate-op file, names unique', () => {
  const names = loadOperators().map((o) => o.name);
  assert.deepStrictEqual([...names].sort(), ['array-wrap', 'blob-text', 'bracket-index', 'case-flip', 'legacy-date', 'malformed-valve-eui', 'nul-char', 'numeric-string', 'numeric-text', 'real-in-integer', 'tostring-object', 'unparseable-timestamp', 'whitespace-trim']);
  assert.throws(() => loadOperators(['nope']), /unknown operator/);
});

test('value operators', () => {
  assert.deepStrictEqual(op('tostring-object').value(2).map((v) => v.value), [{ toString: 0 }]);
  assert.deepStrictEqual(op('array-wrap').value('x').map((v) => v.value), [['x'], ['x', 'x']]);
  assert.deepStrictEqual(op('numeric-string').value(15).map((v) => v.value), ['15', '0x10', ' 15 ', '1e3']);
  assert.deepStrictEqual(op('numeric-string').value('15').map((v) => v.value), ['0x10', ' 15 ', '1e3']);
  assert.deepStrictEqual(op('numeric-string').value('OPEN'), []);
  assert.deepStrictEqual(op('legacy-date').value('2026-11-23T06:00:00.000Z').map((v) => v.value),
    ['2026/11/23 06:00:00 GMT', '2026-11-23Z', 'Sun, 22 Nov 2026 22:00:00 PST', '2026-11-23T06:00Z']);
  assert.strictEqual(op('legacy-date').value(1893456000000).length, 4);
  assert.deepStrictEqual(op('legacy-date').value('Valve 1'), []);
  assert.deepStrictEqual(op('real-in-integer').value(1, { container: 'sql', integerColumn: true }).map((v) => v.value), [126.5]);
  assert.deepStrictEqual(op('real-in-integer').value(1, { container: 'body' }), []);
  assert.deepStrictEqual(op('real-in-integer').value('1', { container: 'sql', integerColumn: true }), []);
});

test('pair operators spell arrays, objects and indexes the way qs reads them', () => {
  const p = parsePairs('duration_minutes%5B20%5D=15')[0];
  assert.deepStrictEqual(p, { piece: 'duration_minutes%5B20%5D=15', key: 'duration_minutes[20]', value: '15', base: 'duration_minutes' });
  assert.deepStrictEqual(op('bracket-index').pair(p).map((v) => v.pairs[0][0]), ['duration_minutes[0]', 'duration_minutes[21]', 'duration_minutes[a]']);
  assert.deepStrictEqual(op('array-wrap').pair(p).map((v) => v.pairs), [
    [['duration_minutes[]', '15']], [['duration_minutes', '15'], ['duration_minutes', '15']], [['duration_minutes', '15'], ['duration_minutes[]', '15']]]);
  assert.deepStrictEqual(op('tostring-object').pair(p)[0].pairs, [['duration_minutes[toString]', '0']]);
  // The array spelling identical to the input is not a mutant.
  const q = parsePairs('k%5B%5D=1')[0];
  assert.ok(!op('array-wrap').pair(q).some((v) => v.pairs.length === 1 && v.pairs[0][0] === 'k[]'));
});

test('query and form sites rebuild only the mutated parameter', () => {
  const step = { id: 's', http: { method: 'POST', path: '/api/valve/X?action=OPEN_FOR_DURATION&duration_minutes=15', auth: 'token' } };
  const ms = mutantsOf({ name: 'n', steps: [step] }, loadOperators(['bracket-index']));
  assert.ok(ms.some((m) => m.step.http.path === '/api/valve/X?action=OPEN_FOR_DURATION&duration_minutes%5B21%5D=15'));
  assert.ok(ms.some((m) => m.step.http.path === '/api/valve/X?action%5B0%5D=OPEN_FOR_DURATION&duration_minutes=15'));
  const form = { id: 'f', http: { method: 'POST', path: '/x', headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: 'a=1&b=2' } };
  const fm = mutantsOf({ name: 'n', steps: [form] }, loadOperators(['array-wrap']));
  assert.ok(fm.some((m) => m.step.http.rawBody === 'a=1&b%5B%5D=2'));
  assert.ok(fm.every((m) => m.step.http.path === '/x'));
});

test('body and uplink leaves, original step untouched', () => {
  const step = { id: 'b', http: { method: 'POST', path: '/x', body: { a: { b: 2 }, c: [1] } } };
  const ms = mutantsOf({ name: 'n', steps: [step] }, loadOperators(['tostring-object']));
  assert.deepStrictEqual(ms.map((m) => m.site), ['body.a.b', 'body.c[0]']);
  assert.deepStrictEqual(ms[0].step.http.body, { a: { b: { toString: 0 } }, c: [1] });
  assert.deepStrictEqual(step.http.body, { a: { b: 2 }, c: [1] });
  const up = { id: 'u', uplink: { topic: 't', payload: { object: { Valve: '1' } } } };
  const um = mutantsOf({ name: 'n', steps: [up] }, loadOperators(['array-wrap']));
  assert.deepStrictEqual(um[0].step.uplink.payload, { object: { Valve: ['1'] } });
});

test('sql: only whole literals that a statement writes into a column', () => {
  const sql = "INSERT INTO devices(deveui,name,user_id,created_at) VALUES ('A1','It''s',1,strftime('%Y','now')),('A2','B',-2,'2020-01-01');\n" +
    "INSERT INTO z(zone_uuid,summary_json) SELECT zone_uuid,'{\"a\":{\"b\":\"c\"}}' FROM irrigation_zones WHERE id=1;\n" +
    "UPDATE s SET duration_minutes=241, note = 'x' WHERE irrigation_zone_id=3;";
  const cols = (t) => (t === 'devices' ? [{ name: 'user_id', type: 'INTEGER' }] : []);
  const lits = findWrittenLiterals(sql, cols);
  assert.deepStrictEqual(lits.map((l) => [l.table + '.' + l.column, l.value, l.integerColumn]), [
    ['devices.deveui', 'A1', false], ['devices.name', "It's", false], ['devices.user_id', 1, true],
    ['devices.deveui', 'A2', false], ['devices.name', 'B', false], ['devices.user_id', -2, true], ['devices.created_at', '2020-01-01', false],
    ['z.summary_json', '{"a":{"b":"c"}}', false],
    ['s.duration_minutes', 241, false], ['s.note', 'x', false]]);
  assert.strictEqual(sqlLiteral({ toString: 0 }), '\'{"toString":0}\'');
  assert.strictEqual(sqlLiteral("a'b"), "'a''b'");
  const sites = sitesOf({ id: 'q', sql }, cols);
  const json = sites.find((s) => s.container === 'sql-json');
  assert.strictEqual(json.label, 'sql.z.summary_json#1$a.b');
  assert.ok(json.build({ toString: 0 }).sql.includes('\'{"a":{"b":{"toString":0}}}\''));
  const real = mutantsOf({ name: 'n', steps: [{ id: 'q', sql }] }, loadOperators(['real-in-integer']), { columnsOf: cols });
  assert.deepStrictEqual(real.map((m) => m.site), ['sql.devices.user_id#1', 'sql.devices.user_id#2']);
  assert.ok(real[0].step.sql.includes("('A1','It''s',126.5,"));
});

test('nul-char: three positions, carried into later steps that echo the value', () => {
  assert.deepStrictEqual(op('nul-char').value('farmer').map((v) => [v.label, v.value, v.carry]),
    [['nul-tail', 'farmer\u0000', true], ['nul-mid', 'far\u0000mer', true], ['nul-lead', '\u0000farmer', true]]);
  assert.deepStrictEqual(op('nul-char').value('').map((v) => v.value), ['\u0000']);
  assert.deepStrictEqual(op('nul-char').value(15), []);
  const p = parsePairs('timezone=UTC')[0];
  assert.deepStrictEqual(op('nul-char').pair(p).map((v) => v.pairs[0][1]), ['UTC\u0000', 'U\u0000TC', '\u0000UTC']);
  const scenario = { name: 'n', steps: [
    { id: 'register', http: { method: 'POST', path: '/auth/register', body: { username: 'farmer', password: 'p' } } },
    { id: 'login', http: { method: 'POST', path: '/auth/login', body: { username: 'farmer', password: 'p' } }, capture: { token: 'json.token' } },
    { id: 'zone', http: { method: 'POST', path: '/api/irrigation-zones', auth: 'token', body: { name: 'farmer' } } },
    { id: 'claim', http: { method: 'POST', path: '/api/devices', auth: 'token', body: { deveui: 'A840410000000001' } } },
  ] };
  const ms = mutantsOf(scenario, loadOperators(['nul-char']));
  const reg = ms.find((m) => m.id === 'n/register/body.username/nul-char/nul-tail');
  assert.deepStrictEqual(reg.step.http.body, { username: 'farmer\u0000', password: 'p' });
  // login echoes the username under the same key; the zone name "farmer" is a different key.
  assert.deepStrictEqual(reg.rest.map((s) => s.http.body), [{ username: 'farmer\u0000', password: 'p' }, { name: 'farmer' }, { deveui: 'A840410000000001' }]);
  assert.strictEqual(reg.rest[0].capture.token, 'json.token');
  assert.deepStrictEqual(scenario.steps[1].http.body, { username: 'farmer', password: 'p' });
  // No later echo: no rest, the runner's --continue rule applies.
  assert.ok(!ms.find((m) => m.id === 'n/claim/body.deveui/nul-char/nul-tail').rest);
  assert.strictEqual(ms.find((m) => m.id === 'n/register/body.password/nul-char/nul-tail').rest[0].http.body.password, 'p\u0000');
  // Other operators never carry.
  assert.ok(mutantsOf(scenario, loadOperators(['tostring-object'])).every((m) => !m.rest));
});

test('sql literal with a NUL stores it through char(0), never a raw NUL', () => {
  assert.strictEqual(sqlLiteral('a\u0000b'), "('a' || char(0) || 'b')");
  assert.strictEqual(sqlLiteral("o'k\u0000"), "('o''k' || char(0) || '')");
  const step = { id: 'q', sql: "INSERT INTO users(username) VALUES ('farmer');" };
  const ms = mutantsOf({ name: 'n', steps: [step] }, loadOperators(['nul-char']));
  assert.deepStrictEqual(ms.map((m) => m.step.sql), [
    "INSERT INTO users(username) VALUES (('farmer' || char(0) || ''));",
    "INSERT INTO users(username) VALUES (('far' || char(0) || 'mer'));",
    "INSERT INTO users(username) VALUES (('' || char(0) || 'farmer'));"]);
  assert.ok(ms.every((m) => !m.step.sql.includes('\u0000') && !m.rest));
});

// Effect comparison: run.js-shaped records.
const rec = (id, db, extra = {}) => ({ id, kind: 'http', response: { status: 200, headers: {}, json: { ok: true }, text: null, bomUtf8: false }, db, radio: [], mqtt: [], cloud: [], ...extra });
const add = (rows) => ({ actuator_log: { added: rows, removed: [], changed: [] } });
const side = (records, more = {}) => ({ records, files: [], errors: [], timeouts: [], unregistered: [], ...more });

test('a backend writing a subset of the oracle rows is never "more", whatever the ids', () => {
  const o = [rec('s', add([
    { __rowid: 7, id: 7, command_id: '11111111-1111-4111-8111-111111111111', action: 'OPEN' },
    { __rowid: 8, id: 8, command_id: '22222222-2222-4222-8222-222222222222', action: 'CLOSE' }]))];
  const g = [rec('s', add([{ __rowid: 7, id: 7, command_id: '33333333-3333-4333-8333-333333333333', action: 'CLOSE' }]))];
  const v = verdict(side(o), side(g));
  assert.strictEqual(v.verdict, 'LOGGED');
  assert.strictEqual(v.more.length, 0);
  assert.strictEqual(v.less.length, 1);
  assert.strictEqual(v.less[0].row.action, 'OPEN');
});

test('an extra row, radio call, MQTT command or token on the backend is TIER-B-FAIL', () => {
  const base = () => [rec('s', {})];
  const cases = [
    [rec('s', add([{ __rowid: 1, action: 'OPEN' }]))],
    [rec('s', {}, { radio: [{ id: 'q', fn: 'enqueue', eui: 'A840410000000001', port: 2, hex: '01' }] })],
    [rec('s', {}, { mqtt: [{ topic: 'application/x/device/y/command/down', payload: '{}' }] })],
    [{ ...rec('s', {}), response: { status: 200, headers: {}, json: { token: 'eyJ1c2VySWQiOjEsInVzZXJuYW1lIjoiZmFybWVyIn0.PFGN0J72EpB0y2kTrrcGya2hQLakX6RSeh2XbpCJd1M' }, text: null, bomUtf8: false } }],
  ];
  for (const g of cases) assert.strictEqual(verdict(side(base()), side(g)).verdict, 'TIER-B-FAIL');
  // The harness's own uplink publication is not a backend effect.
  const up = [rec('s', {}, { kind: 'uplink', mqtt: [{ topic: 'application/x/device/y/event/up', payload: '{}' }] })];
  assert.strictEqual(verdict(side(base()), side(up)).verdict, 'LOGGED');
});

test('status or body only is LOGGED; errors are ERROR; unported ticks are apart', () => {
  const g = [{ ...rec('s', {}), response: { status: 400, headers: {}, json: { message: 'no' }, text: null, bomUtf8: false } }];
  assert.strictEqual(verdict(side([rec('s', {})]), side(g)).verdict, 'LOGGED');
  assert.strictEqual(verdict(side([rec('s', {})]), side([rec('s', {})], { errors: ['boot'] })).verdict, 'ERROR');
  assert.strictEqual(verdict(side([rec('s', {})]), side([rec('s', {})])).verdict, 'OK');
  const tick = { ...rec('tick1:conditional-due-tick', add([{ __rowid: 1, action: 'x' }])), kind: 'timer', response: undefined };
  const v = verdict(side([rec('s', {}), tick]), side([rec('s', {})], { unregistered: ['conditional-due-tick'] }));
  assert.strictEqual(v.verdict, 'OK');
  assert.strictEqual(v.lessUnported.length, 1);
});

test('attribution: an extra the control also has belongs to the base', () => {
  const o = side([rec('s', {})]);
  const g = side([rec('s', add([{ __rowid: 1, action: 'OPEN' }]))]);
  const control = verdict(o, g);
  assert.strictEqual(verdict(o, g, control).attributable, false);
  const g2 = side([rec('s', add([{ __rowid: 1, action: 'OPEN' }, { __rowid: 2, action: 'CLOSE' }]))]);
  assert.strictEqual(verdict(o, g2, control).attributable, true);
  assert.deepStrictEqual(minus(effectsOf(g2.records), effectsOf(g.records)).map((x) => x.row.action), ['CLOSE']);
});

test('a changed row with fewer columns than the oracle is less, not more', () => {
  const chg = (cols) => ({ valve_settings: { added: [], removed: [], changed: [{ __rowid: 2, cols }] } });
  const both = { scheduler_status: { from: 'SKIP_TODAY', to: 'ACTIVE' }, skip_today_date: { from: '2020-01-01', to: null } };
  const o = side([{ ...rec('tick1:valve-clock-tick', chg({ ...both, sync_version: { from: 0, to: 1 } })), kind: 'timer', response: undefined }]);
  const g = side([{ ...rec('tick1:valve-clock-tick', chg(both)), kind: 'timer', response: undefined }]);
  const v = verdict(o, g);
  assert.strictEqual(v.verdict, 'LOGGED');
  assert.deepStrictEqual(v.less.map((x) => x.col), ['sync_version']);
  assert.strictEqual(verdict(g, o).verdict, 'TIER-B-FAIL');
});

test('malformed-valve-eui rewrites a stored 16-hex device key and carries it', () => {
  const steps = [
    { id: 'seed', sql: "INSERT INTO devices(deveui, name, type_id) VALUES ('A840410000000001', 'Valve', 'STREGA_VALVE'); "
      + "INSERT INTO valve_schedules(schedule_uuid, device_eui, kind) VALUES ('s1', 'A840410000000001', 'WEEKLY'); "
      + "INSERT INTO valve_settings(device_eui, strega_generation) VALUES ('A840410000000001', 'GEN1');" },
    { id: 'later-sql', sql: "UPDATE devices SET current_state='OPEN' WHERE deveui='A840410000000001';" },
    { id: 'open', http: { method: 'POST', path: '/api/valve/A840410000000001?x=A840410000000001', body: {} } },
    { id: 'other', http: { method: 'GET', path: '/api/valves' } },
  ];
  const mutants = mutantsOf({ name: 'dispatch', steps }, loadOperators(['malformed-valve-eui']));
  // Three sites name the key; the carried rewrite makes them one mutant per variant.
  assert.deepStrictEqual(mutants.map((m) => [m.site, m.variant]), [
    ['sql.devices.deveui#1', 'nonhex'], ['sql.devices.deveui#1', 'short'], ['sql.devices.deveui#1', 'lower'],
  ]);
  const [nonhex, short, lower] = mutants;
  assert.ok(!nonhex.step.sql.includes("'A840410000000001'"), nonhex.step.sql);
  assert.strictEqual(nonhex.step.sql.split("'X840410000000001'").length - 1, 3);
  assert.strictEqual(nonhex.rest[0].sql, "UPDATE devices SET current_state='OPEN' WHERE deveui='X840410000000001';");
  assert.strictEqual(nonhex.rest[1].http.path, '/api/valve/X840410000000001?x=A840410000000001', 'path segments only, not the query');
  assert.strictEqual(nonhex.rest[2], steps[3], 'steps that do not name the key are unchanged');
  assert.match(short.step.sql, /VALUES \('A84041000000000', 'Valve'/);
  assert.match(lower.step.sql, /VALUES \('a840410000000001', 'Valve'/);
});

test('malformed-valve-eui: no lower variant for an all-digit key, no site outside the key columns', () => {
  const step = { id: 'seed', sql: "INSERT INTO devices(deveui, name) VALUES ('0016000000000001', 'A840410000000001'); "
    + "INSERT INTO device_data(deveui, swt_1) VALUES ('A840410000000002', 1);" };
  const mutants = mutantsOf({ name: 'dispatch', steps: [step] }, loadOperators(['malformed-valve-eui']));
  assert.deepStrictEqual(mutants.map((m) => [m.site, m.variant]), [['sql.devices.deveui#1', 'nonhex'], ['sql.devices.deveui#1', 'short']]);
  assert.ok(!mutants[0].rest, 'no later step names the key');
  // The name column holds the same text as another key but is not rewritten: only the carried key is.
  assert.match(mutants[0].step.sql, /\('X016000000000001', 'A840410000000001'\)/);
});

test('unparseable-timestamp replaces a parseable _at literal with garbage', () => {
  const step = { id: 'seed', sql: "UPDATE valve_settings SET last_clock_sync_queued_at='2099-01-01T00:00:00Z', skip_today_date='2026-11-23';"
    + " INSERT INTO devices(deveui, created_at, updated_at) VALUES ('A840410000000001', 'not a date', datetime('now'));" };
  const mutants = mutantsOf({ name: 'dispatch', steps: [step] }, loadOperators(['unparseable-timestamp']));
  assert.deepStrictEqual(mutants.map((m) => [m.site, m.variant]), [['sql.valve_settings.last_clock_sync_queued_at#1', 'garbage']]);
  assert.match(mutants[0].step.sql, /last_clock_sync_queued_at='garbage'/);
});

test('a variant keeps every scenario date token verbatim, or it is dropped', () => {
  const { keepsDateTokens } = require('../lib/mutate-sites');
  assert.strictEqual(keepsDateTokens('{{datetime:-1h}}', '\t{{datetime:-1h}}\t'), true);
  assert.strictEqual(keepsDateTokens('{{datetime:-1h}}', '{{DATETIME:-1H}}'), false);
  assert.strictEqual(keepsDateTokens('{{datetime:-1h}}', '{{datet\u0000ime:-1h}}'), false);
  assert.strictEqual(keepsDateTokens('Zone A', 'zONE a'), true);
  const scenario = { name: 's', steps: [{ id: 'seed', sql: "INSERT INTO valve_actuation_expectations(expectation_id,device_eui,created_at) VALUES ('e1','A840410000000001','{{datetime:-1h}}')" }] };
  const ids = mutantsOf(scenario, loadOperators(['case-flip', 'whitespace-trim']), { columnsOf: () => [] }).map((m) => m.id);
  assert.ok(!ids.some((id) => /created_at.*case-flip/.test(id)), ids.join('\n'));
  assert.ok(ids.some((id) => /created_at.*whitespace-trim\/pad-tab/.test(id)), ids.join('\n'));
});
