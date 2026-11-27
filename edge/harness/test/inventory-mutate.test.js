'use strict';
// Unit tests for the inventory mutation pass: the whitespace, case, BLOB and
// numeric-text operators, column steps, the effect direction for the values
// they produce, and the derivation of a check's sites.
const test = require('node:test'), assert = require('node:assert');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadOperators } = require('../lib/mutate-ops');
const { mutantsOf } = require('../lib/mutate-sites');
const { sqlLiteral, affinityOf } = require('../lib/mutate-sql');
const { verdict } = require('../lib/mutate-effects');
const { siteName, columnStep, columnMutants, planCheck, isQuick, QUICK, OPERATORS } = require('../lib/inventory-derive');

const op = (name) => loadOperators([name])[0];
const ROOT = path.resolve(__dirname, '../../..');

test('whitespace-trim: pads and blanks that JavaScript trim removes and SQLite trim keeps', () => {
  const vs = op('whitespace-trim').value('0016C001F1000001', { container: 'sql', column: 'sync_link_state.gateway_device_eui' });
  const by = Object.fromEntries(vs.map((v) => [v.label, v.value]));
  assert.strictEqual(by['pad-tab'], '\t0016C001F1000001\t');
  assert.strictEqual(by['only-feff'], '﻿');
  assert.strictEqual(by['only-nel'], '\u0085');
  for (const label of ['pad-tab', 'pad-nbsp', 'pad-feff', 'pad-lsep', 'pad-crlf']) assert.strictEqual(by[label].trim(), '0016C001F1000001', label);
  for (const label of ['only-tab', 'only-nbsp', 'only-feff', 'only-lsep', 'only-crlf']) assert.strictEqual(by[label].trim(), '', label);
  // NEL is the reverse case: Go's TrimSpace strips it, JavaScript keeps it.
  assert.strictEqual(by['only-nel'].trim(), '\u0085');
  assert.ok(vs.every((v) => v.carry === 'key'), 'a 16-hex key in a sql step carries');
  assert.ok(op('whitespace-trim').value('Zone A', { container: 'body' }).every((v) => v.carry === true), 'body values carry like nul-char');
  assert.ok(op('whitespace-trim').value('Zone A', { container: 'sql', column: 'irrigation_zones.name' }).every((v) => v.carry === undefined));
  assert.deepStrictEqual(op('whitespace-trim').value(5, { container: 'body' }), []);
  // Raw whitespace survives as a sql literal (only NUL needs char()).
  assert.strictEqual(sqlLiteral('\tA\t'), "'\tA\t'");
});

test('case-flip swaps ASCII letters, carries a key, and leaves the valve key columns to malformed-valve-eui', () => {
  const flip = op('case-flip');
  assert.deepStrictEqual(flip.value('Valve 1', { container: 'body' }).map((v) => v.value), ['vALVE 1']);
  assert.deepStrictEqual(flip.value('2026-11-23', { container: 'body' }), []);
  assert.deepStrictEqual(flip.value('A840410000000001', { container: 'sql', column: 'devices.deveui' }), []);
  const v = flip.value('0016C001F1000001', { container: 'sql', column: 'sync_link_state.gateway_device_eui' });
  assert.deepStrictEqual(v, [{ label: 'flip', value: '0016c001f1000001', carry: 'key' }]);
  assert.deepStrictEqual(flip.pair({ key: 'kind', value: 'WEEKLY' }).map((p) => p.pairs), [[['kind', 'weekly']]]);
});

test('blob-text stores the same bytes as a BLOB; sql sites only', () => {
  const blob = op('blob-text');
  const [v] = blob.value('OPEN', { container: 'sql' });
  assert.strictEqual(v.label, 'blob');
  assert.strictEqual(sqlLiteral(v.value), "X'4F50454E'");
  assert.deepStrictEqual(blob.value('OPEN', { container: 'body' }), []);
  assert.deepStrictEqual(blob.value(3, { container: 'sql' }), []);
  const ms = mutantsOf({ name: 'n', steps: [{ id: 's', sql: "UPDATE devices SET current_state='OPEN';" }] }, [blob]);
  assert.deepStrictEqual(ms.map((m) => m.step.sql), ["UPDATE devices SET current_state=X'4F50454E';"]);
  // SQLite stores it as a blob, not text.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(v TEXT)');
  db.exec('INSERT INTO t VALUES (' + sqlLiteral(v.value) + ')');
  assert.strictEqual(db.prepare('SELECT typeof(v) AS t FROM t').get().t, 'blob');
});

test('numeric-text keeps the value; in a numeric column only the forms SQLite keeps as text', () => {
  const nt = op('numeric-text');
  const body = Object.fromEntries(nt.value(15, { container: 'body' }).map((v) => [v.label, v.value]));
  assert.deepStrictEqual(body, { 'pad-space': ' 15 ', 'pad-tab': '\t15\n', nbsp: ' 15', plus: '+15', hex: '0xF', exp: '1.5e+1' });
  for (const s of Object.values(body)) assert.strictEqual(Number(s), 15, JSON.stringify(s));
  assert.deepStrictEqual(nt.value('-2.5', { container: 'body' }).map((v) => v.label), ['pad-space', 'pad-tab', 'nbsp', 'exp']);
  assert.deepStrictEqual(nt.value('OPEN', { container: 'body' }), []);
  assert.deepStrictEqual(nt.value(15, { container: 'sql', affinity: 'INTEGER' }).map((v) => v.label), ['nbsp', 'hex']);
  assert.strictEqual(nt.value(15, { container: 'sql', affinity: 'TEXT' }).length, 6);
  // The claim behind the filter: SQLite folds the other forms back to 15.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(v INTEGER)');
  for (const v of nt.value(15, { container: 'body' })) db.prepare('INSERT INTO t VALUES (?)').run(v.value);
  assert.deepStrictEqual(db.prepare('SELECT typeof(v) AS t, count(*) AS n FROM t GROUP BY 1 ORDER BY 1').all().map((r) => [r.t, r.n]), [['integer', 4], ['text', 2]]);
  assert.strictEqual(affinityOf('TEXT NOT NULL'), 'TEXT');
  assert.strictEqual(affinityOf('INTEGER'), 'INTEGER');
  assert.strictEqual(affinityOf(''), 'BLOB');
  assert.strictEqual(affinityOf('REAL'), 'REAL');
});

test('column step: a no-op control, mutants that rewrite the stored value in SQL', () => {
  const step = columnStep('tick', { table: 'devices', column: 'gateway_device_eui', affinity: 'TEXT' });
  assert.strictEqual(step.sql, 'UPDATE "devices" SET "gateway_device_eui" = "gateway_device_eui" WHERE 0;');
  const scenario = { name: 'n', steps: [{ id: 'seed', sql: "INSERT INTO devices(deveui) VALUES ('A840410000000001');" }, { id: 'tick', timer: 'valve-clock-tick' }] };
  const plan = columnMutants(scenario, 1, { table: 'devices', column: 'gateway_device_eui', affinity: 'TEXT' }, loadOperators(OPERATORS), (x) => x);
  const by = Object.fromEntries(plan.mutants.map((m) => [m.operator + '/' + m.variant, m.step.sql]));
  assert.strictEqual(by['whitespace-trim/pad-tab'], 'UPDATE "devices" SET "gateway_device_eui" = char(9) || "gateway_device_eui" || char(9) WHERE "gateway_device_eui" IS NOT NULL;');
  assert.strictEqual(by['whitespace-trim/only-tab'], 'UPDATE "devices" SET "gateway_device_eui" = char(9);', 'blank variants also fill NULL rows');
  assert.ok(by['blob-text/blob'].includes('CAST("gateway_device_eui" AS BLOB)'));
  assert.ok(by['nul-char/nul-tail'].includes('|| char(0)'));
  assert.ok(!Object.keys(by).some((k) => k.startsWith('numeric-text') || k.startsWith('unparseable')), Object.keys(by).join());
  assert.ok(plan.mutants.every((m) => m.container === 'sql-column' && m.site === 'column.devices.gateway_device_eui'));
  // The SQL runs and does what the label says.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE devices(deveui TEXT, gateway_device_eui TEXT, updated_at TEXT, n INTEGER)');
  db.exec("INSERT INTO devices VALUES ('A', '0016C001F1000001', '2026-11-23T06:00:00.000Z', 15), ('B', NULL, NULL, NULL)");
  db.exec(by['whitespace-trim/pad-tab']);
  assert.deepStrictEqual(db.prepare('SELECT gateway_device_eui AS g FROM devices ORDER BY deveui').all().map((r) => r.g), ['\t0016C001F1000001\t', null]);
  db.exec(by['whitespace-trim/only-feff']);
  assert.deepStrictEqual(db.prepare('SELECT gateway_device_eui AS g FROM devices').all().map((r) => r.g), ['﻿', '﻿']);
  const ts = columnMutants(scenario, 1, { table: 'devices', column: 'updated_at', affinity: 'TEXT' }, [op('unparseable-timestamp')], (x) => x).mutants[0];
  db.exec(ts.step.sql);
  assert.deepStrictEqual(db.prepare('SELECT updated_at AS u FROM devices ORDER BY deveui').all().map((r) => r.u), ['garbage', null]);
  const num = columnMutants(scenario, 1, { table: 'devices', column: 'n', affinity: 'INTEGER' }, [op('numeric-text')], (x) => x).mutants;
  db.exec(num.find((m) => m.variant === 'hex').step.sql);
  assert.deepStrictEqual({ ...db.prepare("SELECT n, typeof(n) AS t FROM devices WHERE deveui = 'A'").get() }, { n: '0xF', t: 'text' });
});

// Effect comparison on the values these operators produce: a padded, flipped
// or BLOB value the oracle never wrote is "more".
const rec = (db) => ({ id: 's', kind: 'http', response: { status: 200, headers: {}, json: { ok: true }, text: null, bomUtf8: false }, db, radio: [], mqtt: [], cloud: [] });
const side = (records) => ({ records, files: [], errors: [], timeouts: [], unregistered: [] });
const outbox = (gateway) => ({ sync_outbox: { added: [{ __rowid: 1, id: 1, op: 'VALVE_RUNTIME_CHANGED', gateway_device_eui: gateway }], removed: [], changed: [] } });

test('padding, case and BLOB storage of a written value are "more", never folded together', () => {
  const oracle = side([rec(outbox('0016C001F1000001'))]);
  for (const g of ['\t0016C001F1000001\t', '0016c001f1000001', { '<blob>': '30303136' }, '﻿']) {
    const v = verdict(oracle, side([rec(outbox(g))]));
    assert.strictEqual(v.verdict, 'TIER-B-FAIL', JSON.stringify(g));
  }
  // B2's first form: Node-RED skips the emit, Go writes the row.
  assert.strictEqual(verdict(side([rec({})]), side([rec(outbox('\t'))])).verdict, 'TIER-B-FAIL');
  assert.strictEqual(verdict(oracle, side([rec(outbox('0016C001F1000001'))])).verdict, 'OK');
});

test('site names: sql column, JSON key, query base, body leaf, column step', () => {
  assert.strictEqual(siteName({ site: 'sql.devices.gateway_device_eui#2' }), 'gateway_device_eui');
  assert.strictEqual(siteName({ site: 'sql.zone_recommendations.summary_json#1$water.action.reasoning' }), 'reasoning');
  assert.strictEqual(siteName({ site: 'query.duration_minutes[20]' }), 'duration_minutes');
  assert.strictEqual(siteName({ site: 'body.schedule[0].start_time' }), 'start_time');
  assert.strictEqual(siteName({ site: 'uplinks[3].payload.deviceInfo.devEui' }), 'deveui');
  assert.strictEqual(siteName({ site: 'column.devices.gateway_device_eui' }), 'gateway_device_eui');
});

test('quick variants exist in their operators', () => {
  const ops = loadOperators(OPERATORS);
  assert.deepStrictEqual(Object.keys(QUICK).sort(), [...OPERATORS].sort());
  assert.ok(isQuick({ operator: 'nul-char', variant: 'username=nul-tail' }));
  assert.ok(!isQuick({ operator: 'whitespace-trim', variant: 'pad-nel' }));
  const labels = new Set();
  for (const o of ops) {
    for (const v of (o.value ? o.value('0016C001F1000001', { container: 'sql', column: 'valve_settings.device_eui', affinity: 'TEXT' }) : [])) labels.add(o.name + '/' + v.label);
    for (const v of (o.value ? o.value('2026-11-23T06:00:00.000Z', { container: 'sql', column: 'x.queued_at' }) : [])) labels.add(o.name + '/' + v.label);
    for (const v of (o.value ? o.value(15, { container: 'body' }) : [])) labels.add(o.name + '/' + v.label);
  }
  for (const [name, qs] of Object.entries(QUICK)) for (const q of qs) assert.ok(labels.has(name + '/' + q), name + '/' + q);
});

test('row 41 derives the gateway columns from its own code lines', () => {
  const inventory = require('../../contracts/dispatch-inventory.json');
  const check = inventory.entries.find((e) => e.id === 'outbox-valve-runtime').checks.find((c) => c.id === 'linked-gateway');
  const db = new DatabaseSync(path.join(ROOT, 'database/farming.db'), { readOnly: true });
  const columnsOf = (t) => { try { return db.prepare('SELECT name, type FROM pragma_table_info(?)').all(t); } catch { return []; } };
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name.toLowerCase()));
  const p = planCheck(check, { root: ROOT, go: new Map(), depth: 0, columnsOf, tables, operators: loadOperators(OPERATORS), quick: true });
  assert.strictEqual(p.source, 'derived');
  const ids = [...p.mutants, ...p.columns.flatMap((c) => c.mutants)].map((m) => m.id);
  // Row 41's probe moved to r3-dispatch-runtime-gateway-ws in dispatch r3.
  assert.ok(ids.includes('r3-dispatch-runtime-gateway-ws/col-schedule-tab-sync_link_state.gateway_device_eui/column.sync_link_state.gateway_device_eui/whitespace-trim/only-feff'), ids.join('\n'));
  assert.ok(ids.includes('r3-dispatch-runtime-gateway-ws/setup/sql.devices.gateway_device_eui#1/whitespace-trim/pad-tab'), ids.join('\n'));
  // An explicit skip is reported, not derived.
  assert.strictEqual(planCheck({ ...check, mutation: { skip: 'why' } }, { root: ROOT, go: new Map(), depth: 0, columnsOf, tables, operators: [], quick: true }).source, 'skip');
  assert.strictEqual(planCheck({ ...check, probe: null }, { root: ROOT, go: new Map(), depth: 0, columnsOf, tables, operators: [], quick: true }).source, 'no-probe');
});

test('a Gen1 clock frame sent a few seconds apart is the same effect; any other frame stays literal', () => {
  const radio = (hex, port = 12) => rec({}) && { ...rec({}), radio: [{ fn: 'enqueue', eui: 'A8404100000000A1', port, hex }] };
  const o = side([radio('0008010900080002020401010206')]);
  assert.strictEqual(verdict(o, side([radio('0008010902000002020401010206')])).verdict, 'OK');
  assert.strictEqual(verdict(o, side([radio('0008010902000002020401010206', 13)])).verdict, 'TIER-B-FAIL');
  assert.strictEqual(verdict(side([rec({})]), side([radio('0008010902000002020401010206')])).verdict, 'TIER-B-FAIL', 'an extra clock frame is still more');
});

test('a column step with `where` rewrites only the rows it names', () => {
  const scenario = { name: 'n', steps: [{ id: 'tick', timer: 'daily-schedule-0600' }] };
  const col = { table: 'devices', column: 'deveui', affinity: 'TEXT', where: "type_id = 'STREGA_VALVE'" };
  const ms = columnMutants(scenario, 0, col, [op('whitespace-trim')], (x) => x).mutants;
  assert.strictEqual(ms.find((m) => m.variant === 'only-tab').step.sql, 'UPDATE "devices" SET "deveui" = char(9) WHERE (type_id = \'STREGA_VALVE\');');
  assert.ok(ms.find((m) => m.variant === 'pad-tab').step.sql.endsWith('WHERE (type_id = \'STREGA_VALVE\') AND "deveui" IS NOT NULL;'));
  assert.strictEqual(columnStep('tick', col).sql, 'UPDATE "devices" SET "deveui" = "deveui" WHERE 0;');
});

test('a wall-clock age read minutes apart is the same effect; null and other fields stay literal', () => {
  const event = (age, reason = 'stale_dendro_recommendation') => ({ id: 'dendro-10', kind: 'timer', db: { irrigation_events: { added: [{ id: 1, action: 'SKIP', reason,
    payload_json: JSON.stringify({ zone_id: 8, analytics_age_hours: age }) }], removed: [], changed: [] } } });
  const side = (rec) => ({ records: [rec], files: [], errors: [], timeouts: [], unregistered: [] });
  assert.strictEqual(verdict(side(event(48)), side(event(48.1)), null).verdict, 'OK');
  assert.strictEqual(verdict(side(event(null)), side(event(48.1)), null).verdict, 'TIER-B-FAIL');
  assert.strictEqual(verdict(side(event(48)), side(event(48.1, 'other')), null).verdict, 'TIER-B-FAIL');
});
