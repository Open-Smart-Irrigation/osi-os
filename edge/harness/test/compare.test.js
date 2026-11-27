'use strict';
// Negative controls for the T1 comparator: every mutation class must go red,
// and volatile values in the same form must stay green.
const test = require('node:test'), assert = require('node:assert');
const { compare } = require('../lib/compare');

const base = () => ({ steps: [{
  id: 's1', kind: 'http',
  response: { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, bomUtf8: false, text: null,
    json: { token: 'eyJ1c2VySWQiOjEsInVzZXJuYW1lIjoiZmFybWVyIn0.PFGN0J72EpB0y2kTrrcGya2hQLakX6RSeh2XbpCJd1M',
      user_uuid: 'e87625088364c35b96bd386abf1f09f3', zone_uuid: '0b8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c11', other: '0b8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c11',
      created_at: '2026-11-23T17:03:41.644Z', updated: '2026-11-23 17:03:41', n: 3, s: '3', z: null, at: 1795453421534,
      hash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', meta: '{"a":1}' } },
  db: { users: { added: [{ __rowid: 1, username: 'farmer', created_at: '2026-11-23T17:03:41.644Z' }], removed: [], changed: [] } },
  radio: [{ fn: 'enqueue', eui: 'A840410000000001', port: 2, hex: '0101', id: 'q1', expiresAt: null }],
  mqtt: [{ topic: 'devices/0016C001F1000001/status', payload: '{"state":"OPEN"}' }],
  cloud: [
    { direction: 'client', cmd: 'connect', protocolVersion: 5, cleanStart: false },
    { direction: 'broker', cmd: 'connack', reasonCode: 0, sessionPresent: false },
    { direction: 'client', cmd: 'publish', messageId: 42, qos: 1, retain: false, dup: false,
      payload: Buffer.from('{"state":"OPEN"}').toString('base64'), properties: { messageExpiryInterval: 10 } },
    { direction: 'broker', cmd: 'puback', messageId: 42, reasonCode: 0 },
  ],
}] });

test('identical and volatile-shifted cassettes compare green', () => {
  const a = base(), b = base();
  const j = b.steps[0].response.json;
  j.token = 'eyJ1c2VySWQiOjEsInVzZXJuYW1lIjoiZmFybWVyIiwieCI6MX0.QQGN0J72EpB0y2kTrrcGya2hQLakX6RSeh2XbpCJd1M';
  j.user_uuid = 'aaaa5088364c35b96bd386abf1f09f3a'; j.zone_uuid = '1b8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c11'; j.other = j.zone_uuid;
  j.created_at = '2027-01-01T00:00:00.001Z'; j.updated = '2027-01-01 00:00:00'; j.at = 1800000000000;
  j.hash = '$2a$10$ZZZdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
  b.steps[0].db.users.added[0].created_at = '2027-01-01T00:00:00.001Z';
  b.steps[0].radio[0].id = 'other-queue-id';
  b.steps[0].cloud[2].messageId = b.steps[0].cloud[3].messageId = 7;
  b.steps[0].cloud[2].properties.messageExpiryInterval = 9;
  assert.strictEqual(compare(a, b).pass, true, JSON.stringify(compare(a, b).results[0].failures));
});

const mutations = {
  status: (s) => { s.response.status = 201; },
  header: (s) => { s.response.headers['content-type'] = 'application/json'; },
  'field-removed': (s) => { delete s.response.json.n; },
  'null-to-absent': (s) => { delete s.response.json.z; },
  'number-to-string': (s) => { s.response.json.n = '3'; },
  'string-to-number': (s) => { s.response.json.s = 3; },
  'iso-to-sql-timestamp': (s) => { s.response.json.created_at = '2026-11-23 17:03:41'; },
  'iso-millis-dropped': (s) => { s.response.json.created_at = '2026-11-23T17:03:41Z'; },
  'uuid-identity-broken': (s) => { s.response.json.other = '9b8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c11'; },
  'uuid-case': (s) => { s.response.json.zone_uuid = s.response.json.zone_uuid.toUpperCase(); s.response.json.other = s.response.json.zone_uuid; },
  'bcrypt-cost': (s) => { s.response.json.hash = '$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'; },
  'bcrypt-variant': (s) => { s.response.json.hash = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'; },
  'json-text-value': (s) => { s.response.json.meta = '{"a":2}'; },
  'db-extra-row': (s) => { s.db.users.added.push({ __rowid: 2, username: 'x', created_at: null }); },
  'db-missing-table': (s) => { delete s.db.users; },
  'radio-bytes': (s) => { s.radio[0].hex = '0100'; },
  'radio-port': (s) => { s.radio[0].port = 3; },
  'radio-expiry-added': (s) => { s.radio[0].expiresAt = '2026-11-23T17:04:41.000Z'; },
  'mqtt-payload': (s) => { s.mqtt[0].payload = '{"state":"CLOSED"}'; },
  'mqtt-missing': (s) => { s.mqtt = []; },
  'cloud-qos': (s) => { s.cloud[2].qos = 0; },
  'cloud-protocol': (s) => { s.cloud[0].protocolVersion = 4; },
  'cloud-clean-start': (s) => { s.cloud[0].cleanStart = true; },
  'cloud-payload': (s) => { s.cloud[2].payload = Buffer.from('{"state":"CLOSED"}').toString('base64'); },
  'cloud-unmatched-puback': (s) => { s.cloud[3].messageId++; },
  'cloud-message-expiry-added': (s) => { delete s.cloud[2].properties.messageExpiryInterval; },
  'bom': (s) => { s.response.bomUtf8 = true; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test('mutation goes red: ' + name, () => {
    const a = base(), b = base();
    mutate(b.steps[0]);
    assert.strictEqual(compare(a, b).pass, false);
  });
}
test('a missing step goes red', () => {
  const b = base(); b.steps = [];
  assert.strictEqual(compare(base(), b).pass, false);
});
test('key order alone is a warning, not a failure', () => {
  const a = base(), b = base();
  const j = b.steps[0].response.json; const n = j.n; delete j.n; j.n = n;
  const c = compare(a, b);
  assert.strictEqual(c.pass, true);
  assert.deepStrictEqual(c.results[0].warnings, [{ area: 'body-key-order' }]);
});
test('uptime_ms is volatile only as an integer under that key', () => {
  const mk = (v, k = 'uptime_ms') => ({ steps: [{ id: 's', kind: 'sql', db: { t: { added: [{ x: JSON.stringify({ proof: { [k]: v } }) }], removed: [], changed: [] } } }] });
  assert.strictEqual(compare(mk(2140428760), mk(2140457840)).pass, true);
  assert.strictEqual(compare(mk(2140428760), mk('2140457840')).pass, false);
  assert.strictEqual(compare(mk(2140428760, 'other_ms'), mk(2140457840, 'other_ms')).pass, false);
});
test('a same-form timestamp rewrite is clock noise; a real value change is not', () => {
  const mk = (cols) => ({ steps: [{ id: 's', kind: 'sql', db: cols ? { t: { added: [], removed: [], changed: [{ __rowid: 1, cols }] } } : {} }] });
  assert.strictEqual(compare(mk({ updated_at: { from: '2026-11-23 06:00:00', to: '2026-11-23 06:00:01' } }), mk(null)).pass, true);
  assert.strictEqual(compare(mk({ state: { from: 'OPEN', to: 'CLOSED' } }), mk(null)).pass, false);
  assert.strictEqual(compare(mk({ updated_at: { from: '2026-11-23 06:00:00', to: '2026-11-23T06:00:01Z' } }), mk(null)).pass, false);
});
test('only the clock instant in a Gen1 clock push is volatile', () => {
  const makeClock = (digits, at, port = 12, radioDigits = digits) => {
    const hex = (s) => [...s].map((d) => '0' + d).join('');
    const eui = 'A840410000000001';
    return { steps: [{ id: 'tick', kind: 'timer',
      db: { valve_schedule_pushes: { added: [{ purpose: 'CLOCK_SYNC', fport: port, device_eui: eui,
        payload_hex: hex(digits), transport_json: JSON.stringify({ intent_at: at }) }], removed: [], changed: [] } },
      radio: [{ fn: 'enqueue', eui, port, hex: hex(radioDigits) }],
    }] };
  };
  const a = makeClock('17510001231126', '2026-11-23T17:51:00.123Z');
  const at = '2026-11-24T10:02:03.456Z';
  assert.strictEqual(compare(a, makeClock('10020302241126', at)).pass, true);
  assert.strictEqual(compare(a, makeClock('11020302241126', at)).pass, false);
  assert.strictEqual(compare(a, makeClock('10020301241126', at)).pass, false);
  assert.strictEqual(compare(a, makeClock('10020302241126', at, 2)).pass, false);
  assert.strictEqual(compare(a, makeClock('10020302241126', at, 12, '10020402241126')).pass, false);
});
test('one-time audit reasons retain the referenced schedule and timestamp form', () => {
  const uuid = '0b8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c11';
  const mk = (id, at) => ({ steps: [{ id: 's', kind: 'timer', db: { actuator_log: {
    added: [{ reason: 'one_time_open:' + id + ':' + at, schedule_uuid: uuid }], removed: [], changed: [],
  } } }] });
  const a = mk(uuid, '2026-11-23T17:51:00.123Z');
  assert.strictEqual(compare(a, mk(uuid, '2026-11-24T10:02:03.456Z')).pass, true);
  assert.strictEqual(compare(a, mk(uuid, '2026-11-24T10:02:03Z')).pass, false);
  assert.strictEqual(compare(a, mk('1' + uuid.slice(1), '2026-11-24T10:02:03.456Z')).pass, false);
});

// Anchor-relative day normalisation: each cassette side normalises date-only
// strings against its own anchor day (meta.anchorDay, else recordedAt's UTC
// date) inside a ±30-day window.
const dayCassette = (anchorDay, stage, stamp) => ({ meta: anchorDay ? { anchorDay } : {}, steps: [{
  id: 's', kind: 'sql',
  db: { irrigation_zones: { added: [{ __rowid: 1, stage_started_on: stage, last_triggered_at: stamp ?? null }], removed: [], changed: [] } },
}] });
test('the same relative day on different anchors stays green', () => {
  const a = dayCassette('2026-11-23', '2026-11-23');
  assert.strictEqual(compare(a, dayCassette('2026-11-24', '2026-11-24')).pass, true);
  assert.strictEqual(compare(a, dayCassette('2026-12-14', '2026-12-14')).pass, true);
});
test('a one-day shift goes red', () => {
  const a = dayCassette('2026-11-23', '2026-11-23');
  assert.strictEqual(compare(a, dayCassette('2026-11-23', '2026-11-24')).pass, false);
  assert.strictEqual(compare(dayCassette('2026-11-23', '2026-11-24'), dayCassette('2026-11-24', '2026-11-24')).pass, false);
});
test('an absolute date far from the anchor is not normalised', () => {
  assert.strictEqual(compare(dayCassette('2026-11-23', '2026-03-15'), dayCassette('2026-11-23', '2026-03-16')).pass, false);
  assert.strictEqual(compare(dayCassette('2026-11-23', '2026-03-15'), dayCassette('2026-11-24', '2026-03-15')).pass, true);
});
test('a date at the window edge normalises, one past it does not', () => {
  assert.strictEqual(compare(dayCassette('2026-11-23', '2026-12-23'), dayCassette('2026-11-24', '2026-12-24')).pass, true);
  assert.strictEqual(compare(dayCassette('2026-11-23', '2026-12-24'), dayCassette('2026-11-24', '2026-12-25')).pass, false);
});
test('legacy slash-date stamps normalise with their surrounding text', () => {
  const a = dayCassette('2026-11-23', null, '2026/11/23 00:00:00 GMT');
  assert.strictEqual(compare(a, dayCassette('2026-11-24', null, '2026/11/24 00:00:00 GMT')).pass, true);
  assert.strictEqual(compare(a, dayCassette('2026-11-23', null, '2026/11/24 00:00:00 GMT')).pass, false);
  assert.strictEqual(compare(a, dayCassette('2026-11-24', null, '2026/11/24 00:00:01 GMT')).pass, false);
});
test('the dash form of the legacy GMT stamp normalises as a whole value only', () => {
  const a = dayCassette('2026-11-24', null, '2026-11-24 00:00:00 GMT');
  assert.strictEqual(compare(a, dayCassette('2026-11-25', null, '2026-11-25 00:00:00 GMT')).pass, true);
  assert.strictEqual(compare(a, dayCassette('2026-11-24', null, '2026-11-25 00:00:00 GMT')).pass, false);
  assert.strictEqual(compare(a, dayCassette('2026-11-25', null, '2026-11-25 00:00:01 GMT')).pass, false);
  // Embedded in longer text a dash date stays absolute.
  const b = dayCassette('2026-11-24', null, 'x 2026-11-24 00:00:00 GMT');
  assert.strictEqual(compare(b, dayCassette('2026-11-25', null, 'x 2026-11-25 00:00:00 GMT')).pass, false);
});
test('without an anchor (no meta) date-only strings stay literal', () => {
  assert.strictEqual(compare(dayCassette(null, '2026-11-23'), dayCassette(null, '2026-11-24')).pass, false);
  assert.strictEqual(compare(dayCassette(null, '2026-11-23'), dayCassette(null, '2026-11-23')).pass, true);
});
test('recordedAt supplies the anchor when anchorDay is absent', () => {
  const mk = (recordedAt, stage) => ({ meta: { recordedAt }, steps: dayCassette(null, stage).steps });
  assert.strictEqual(compare(mk('2026-11-23T18:36:45.392Z', '2026-11-23'), mk('2026-11-24T09:00:00.000Z', '2026-11-24')).pass, true);
  assert.strictEqual(compare(mk('2026-11-23T18:36:45.392Z', '2026-11-23'), mk('2026-11-24T09:00:00.000Z', '2026-11-25')).pass, false);
});
test('anchorTimeZone: a zone-local "today" stays green at any hour of either run', () => {
  const zone = 'America/Argentina/Buenos_Aires';
  const mk = (anchorMs, stage, tz) => ({ meta: { anchorDay: new Date(anchorMs).toISOString().slice(0, 10), anchorMs },
    steps: dayCassette(null, stage).steps.map((s) => (tz ? { ...s, anchorTimeZone: tz } : s)) });
  // Recorded 19:00Z (local 16:00, same day); replayed 01:00Z two days later (local 22:00 the day before).
  const rec = mk(Date.parse('2026-11-23T19:00:00Z'), '2026-11-23', zone);
  const late = mk(Date.parse('2026-11-25T01:00:00Z'), '2026-11-24', zone);
  assert.strictEqual(compare(rec, late).pass, true);
  // Control: the same pair without the step's zone goes red (UTC days differ by one).
  assert.strictEqual(compare(mk(Date.parse('2026-11-23T19:00:00Z'), '2026-11-23'), mk(Date.parse('2026-11-25T01:00:00Z'), '2026-11-24')).pass, false);
  // A real one-day difference in local time still goes red.
  assert.strictEqual(compare(rec, mk(Date.parse('2026-11-25T01:00:00Z'), '2026-11-25', zone)).pass, false);
  // The zone applies only to that step's dates; other steps keep the UTC day.
  assert.strictEqual(compare(mk(Date.parse('2026-11-23T19:00:00Z'), '2026-11-23'), mk(Date.parse('2026-11-24T19:00:00Z'), '2026-11-24')).pass, true);
});

// A date-time stamp that opens with a dash date ("2026-11-24 00:00:00 GMT",
// the imported form of the scheduler's last_triggered_at) is the run's own
// day in a step marked anchorTimeZone. Anywhere else it may be an echoed
// scenario literal and stays absolute.
const stampCassette = (anchorMs, stamp, tz, secondStamp) => ({ meta: { anchorDay: new Date(anchorMs).toISOString().slice(0, 10), anchorMs },
  steps: [{ id: 's', kind: 'sql', ...(tz && { anchorTimeZone: tz }),
    db: { irrigation_schedules: { added: [], removed: [], changed: [{ __rowid: 1, cols: { last_triggered_at: { from: null, to: stamp } } }] } } },
  ...(secondStamp === undefined ? [] : [{ id: 'echo', kind: 'sql',
    db: { app_settings: { added: [{ __rowid: 1, value: JSON.stringify({ time: secondStamp }) }], removed: [], changed: [] } } }])] });
test('anchorTimeZone: an imported dash-date stamp is the run\'s own day', () => {
  const a = stampCassette(Date.parse('2026-11-24T01:11:45Z'), '2026-11-24 00:00:00 GMT', 'UTC');
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-25T11:40:57Z'), '2026-11-25 00:00:00 GMT', 'UTC')).pass, true);
  // Controls: a one-day shift, another time of day, or the ISO form of the same instant go red.
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-25T11:40:57Z'), '2026-11-24 00:00:00 GMT', 'UTC')).pass, false);
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-25T11:40:57Z'), '2026-11-25 00:00:01 GMT', 'UTC')).pass, false);
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-25T11:40:57Z'), '2026-11-25T00:00:00.000Z', 'UTC')).pass, false);
});
test('control: an unmarked step keeps a dash-date stamp absolute, also under a faked anchor', () => {
  // An uplink echoes the scenario's own literal on both sides (recorded 24 Nov, the same text replayed with any anchor).
  const a = stampCassette(Date.parse('2026-11-24T01:11:45Z'), '2026-11-20 00:00:00 UTC');
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-25T11:40:57Z'), '2026-11-20 00:00:00 UTC')).pass, true);
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-26T00:00:00Z'), '2026-11-20 00:00:00 UTC')).pass, true);
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-25T11:40:57Z'), '2026-11-21 00:00:00 UTC')).pass, false);
});
test('anchorTimeZone: a dash-date stamp far from the anchor stays absolute', () => {
  const a = stampCassette(Date.parse('2026-11-24T01:11:45Z'), '2026-01-01 00:00:00 GMT', 'UTC');
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-26T01:11:45Z'), '2026-01-01 00:00:00 GMT', 'UTC')).pass, true);
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-26T01:11:45Z'), '2026-01-02 00:00:00 GMT', 'UTC')).pass, false);
});
test('anchorTimeZone: the stamp rule ends with the marked step', () => {
  // The marked step's stamp follows the anchor; the next, unmarked step's echoed stamp does not.
  const a = stampCassette(Date.parse('2026-11-24T01:11:45Z'), '2026-11-24 00:00:00 GMT', 'UTC', '2026-11-20 00:00:00 UTC');
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-25T11:40:57Z'), '2026-11-25 00:00:00 GMT', 'UTC', '2026-11-20 00:00:00 UTC')).pass, true);
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-26T00:00:00Z'), '2026-11-26 00:00:00 GMT', 'UTC', '2026-11-20 00:00:00 UTC')).pass, true);
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-25T11:40:57Z'), '2026-11-25 00:00:00 GMT', 'UTC', '2026-11-21 00:00:00 UTC')).pass, false);
});
test('anchorTimeZone: a stamp is anchored on the zone\'s local day', () => {
  const zone = 'Europe/Zurich';
  // Recorded 23:30Z (00:30 the next day in the zone), replayed two days later at 22:30Z (23:30 local).
  const a = stampCassette(Date.parse('2026-11-23T23:30:00Z'), '2026-11-24 00:00:00 GMT', zone);
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-25T22:30:00Z'), '2026-11-25 00:00:00 GMT', zone)).pass, true);
  // Control: without the zone the UTC days of the two stamps differ by one, and by two from the anchors.
  assert.strictEqual(compare(stampCassette(Date.parse('2026-11-23T23:30:00Z'), '2026-11-24 00:00:00 GMT'),
    stampCassette(Date.parse('2026-11-25T22:30:00Z'), '2026-11-25 00:00:00 GMT')).pass, false);
  // A real one-day difference in the zone still goes red.
  assert.strictEqual(compare(a, stampCassette(Date.parse('2026-11-25T22:30:00Z'), '2026-11-26 00:00:00 GMT', zone)).pass, false);
});
