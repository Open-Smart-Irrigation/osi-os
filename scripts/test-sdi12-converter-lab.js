'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectFrame, modelSingleUplink, inspectWrappedExchange } = require('./lib/sdi12-converter-lab');

const configuration = Object.freeze({
  dataup: 0, payver: 1, alldatamod: 1, datacut: 'none', dataconv: 'none', ext: [0, 0, 0],
});

function unqualified(result) {
  assert.equal(result.hardware_verified, false);
  assert.equal(result.acquisition_available, false);
  assert.equal(result.eligible, false);
  assert.equal(result.configuration_verified, false);
}

function frame(bytes, override) {
  return { fport: 2, bytes, configuration: { ...configuration, ...(override || {}) } };
}

function byteText(bytes) { return String.fromCharCode(...bytes); }

test('preserves the vendor-derived PDTA return byte-for-byte with original marker offset', () => {
  const bytes = [12, 132, 1, 241, 13, 48, 43, 49, 46, 48, 56, 43, 50, 52, 46, 54, 13, 10];
  const result = inspectFrame(frame(bytes));
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'wrapped');
  assert.deepEqual(result.raw_bytes, bytes);
  assert.deepEqual(result.header, { battery_mv: 3204, interrupt: false, payver: 1, dataup: 0 });
  assert.deepEqual(result.body_bytes, bytes.slice(3));
  assert.deepEqual(result.records, [{ slot: 1, offset: 3, length: 13,
    bytes: bytes.slice(5), text: '0+1.08+24.6\r\n' }]);
  unqualified(result);
});

test('detaches retained configuration, records and bindings from caller and result mutation', () => {
  const supplied = { ...configuration, ext: [0, 0, 0] };
  const bytes = [0, 0, 1, 0xf1, 0];
  const inspected = inspectFrame({ fport: 2, bytes, configuration: supplied });
  supplied.ext[0] = 1; bytes[3] = 0;
  assert.deepEqual(inspected.configuration, configuration);
  assert.equal(inspected.records[0].slot, 1);
  inspected.configuration.ext[0] = 1; inspected.records[0].bytes.push(9);
  const second = inspectFrame(frame([0, 0, 1, 0xf1, 0]));
  assert.deepEqual(second.configuration, configuration);
  assert.deepEqual(second.records[0].bytes, []);

  const bindings = [{ slot: 1, response_command: '0M!' }];
  const bridged = inspectWrappedExchange({ frame: frame([0, 0, 1, 0xf1, 7, ...Buffer.from('00001\r\n', 'latin1')]), bindings });
  bindings[0].response_command = '0D0!';
  assert.deepEqual(bridged.bindings, [{ slot: 1, response_command: '0M!' }]);
});

test('parses length delimited records in wire order without treating embedded marker or DEL bytes as syntax', () => {
  const bytes = [0, 1, 1, 0xf2, 4, 0xf1, 0x7f, 0x00, 0x41, 0xff, 2, 0x0d, 0x0a];
  const result = inspectFrame(frame(bytes));
  assert.equal(result.ok, true);
  assert.deepEqual(result.records.map(record => [record.slot, record.offset, record.length, record.bytes, record.text]), [
    [2, 3, 4, [0xf1, 0x7f, 0, 0x41], byteText([0xf1, 0x7f, 0, 0x41])],
    [15, 9, 2, [13, 10], '\r\n'],
  ]);
  unqualified(result);
});

test('accepts zero length and a 255-byte structural frame while enforcing marker grammar', () => {
  const zero = inspectFrame(frame([0, 0, 1, 0xf1, 0]));
  const max = inspectFrame(frame([0, 0, 1, 0xff, 250, ...Array(250).fill(0)]));
  assert.equal(zero.ok, true);
  assert.equal(zero.records[0].length, 0);
  assert.equal(max.ok, true);
  assert.equal(max.raw_bytes.length, 255);
  for (const bytes of [[0, 0, 1, 0xf0], [0, 0, 1, 0xf0, 0], [0, 0, 1, 0xe1, 0], [0, 0, 1, 0xf1, 1]]) {
    const result = inspectFrame(frame(bytes));
    assert.equal(result.ok, false);
    assert.equal(result.disposition, 'invalid');
    assert.equal('records' in result, false);
    unqualified(result);
  }
});

test('rejects duplicate slots, truncated records and junk tail without dropping raw bytes', () => {
  const cases = [
    [0, 0, 1, 0xf1, 0, 0xf1, 0],
    [0, 0, 1, 0xf1],
    [0, 0, 1, 0xf1, 2, 1],
    [0, 0, 1, 0xf1, 0, 0],
  ];
  for (const bytes of cases) {
    const result = inspectFrame(frame(bytes));
    assert.equal(result.ok, false);
    assert.deepEqual(result.raw_bytes, bytes);
    assert.equal(result.disposition, 'invalid');
    unqualified(result);
  }
});

test('separates malformed configuration from valid unsupported settings and checks payver independently', () => {
  const sparseExt = [0, 0, 0]; delete sparseExt[1];
  const bad = [
    { ...configuration, dataconv: 'wat' }, { ...configuration, ext: [0, 0] },
    { ...configuration, ext: sparseExt }, { ...configuration, alldatamod: 2 }, { ...configuration, dataup: 2 },
  ];
  for (const value of bad) assert.equal(inspectFrame({ fport: 2, bytes: [0, 0, 1], configuration: value }).code, 'invalid_configuration');
  for (const value of [
    { ...configuration, dataconv: 'configured' }, { ...configuration, datacut: 'configured' },
    { ...configuration, alldatamod: 0 }, { ...configuration, ext: [1, 0, 0] },
  ]) {
    const result = inspectFrame({ fport: 2, bytes: [0, 0, 1], configuration: value });
    assert.equal(result.code, 'unsupported_configuration');
    assert.deepEqual(result.raw_bytes, [0, 0, 1]);
    unqualified(result);
  }
  const extFragment = inspectFrame({ fport: 2, bytes: [0, 0, 1, 2, 1], configuration: { ...configuration, dataup: 1, ext: [1, 0, 0] } });
  assert.equal('header' in extFragment, false);
  assert.equal('body_bytes' in extFragment, false);
  assert.equal(inspectFrame(frame([0, 0, 2])).code, 'payver_mismatch');
});

test('retains parsed body bytes on structural wrapper errors after a valid header', () => {
  const result = inspectFrame(frame([0, 0, 1, 0xf1, 2, 1]));
  assert.equal(result.code, 'truncated_body');
  assert.deepEqual(result.body_bytes, [0xf1, 2, 1]);
  unqualified(result);
});

test('rejects malformed envelope fields and arrays without holes or coercion', () => {
  const bad = [null, {}, { ...frame([0, 0, 1]), extra: true }, frame([0, 0]), frame([0, 0, 1.5]), frame([0, 0, NaN]), frame([0, 0, 256]), { ...frame([0, 0, 1]), fport: 3 }];
  const hole = [0, 0, 1]; delete hole[1]; bad.push(frame(hole));
  for (const value of bad) {
    const result = inspectFrame(value);
    assert.equal(result.ok, false);
    assert.equal(result.disposition, 'invalid');
    unqualified(result);
  }
});

test('retains bounded valid raw bytes when the envelope or port is refused', () => {
  for (const change of [{ fport: 3 }, { extra: true }, { configuration: undefined }]) {
    const bytes = [0, 0, 1, 0xf1, 0];
    const input = { ...frame(bytes), ...change };
    const result = inspectFrame(input);
    assert.equal(result.ok, false);
    assert.deepEqual(result.raw_bytes, bytes);
    assert.equal(result.records, undefined);
    assert.equal(result.header, undefined);
    result.raw_bytes[0] = 255;
    assert.equal(bytes[0], 0);
    unqualified(result);
  }
  for (const bytes of [[0, 0, NaN], Array(256).fill(0)]) {
    const result = inspectFrame({ ...frame(bytes), fport: 3 });
    assert.equal(result.ok, false);
    assert.equal(result.raw_bytes, undefined);
  }
});

test('diagnoses dataup fragments structurally and never parses a mid-record body', () => {
  const fragment = inspectFrame(frame([0x8c, 0x84, 5, 2, 1, 13, 48, 43, 49], { dataup: 1, payver: 5 }));
  assert.equal(fragment.ok, false);
  assert.equal(fragment.disposition, 'fragment');
  assert.equal(fragment.code, 'fragment_requires_reassembly');
  assert.deepEqual(fragment.header, { battery_mv: 3204, interrupt: true, payver: 5, dataup: 1, segment_count: 2, segment_index: 1 });
  assert.deepEqual(fragment.body_bytes, [13, 48, 43, 49]);
  assert.equal('records' in fragment, false);
  for (const bytes of [[0, 0, 1, 0], [0, 0, 1, 16, 0], [0, 0, 1, 2, 2]]) {
    const result = inspectFrame(frame(bytes, { dataup: 1 }));
    assert.equal(result.disposition, 'invalid');
    unqualified(result);
  }
});

test('models a literal all-data single payload and enforces per-return and total caller budgets', () => {
  const input = { battery_mv: 3204, interrupt: true, payver: 5, returns: [
    { slot: 1, bytes: [48, 13, 10] }, { slot: 15, bytes: [0x7f] },
  ], max_payload_bytes: 12 };
  const result = modelSingleUplink(input);
  assert.equal(result.ok, true);
  assert.equal(result.model, 'all_data_no_cut_single_v1');
  assert.equal(result.required_bytes, 11);
  assert.deepEqual(result.bytes, [0x8c, 0x84, 5, 0xf1, 3, 48, 13, 10, 0xff, 1, 0x7f]);
  assert.equal(result.max_payload_bytes, 12);
  assert.equal(result.configuration_verified, false);
  assert.equal(modelSingleUplink({ ...input, max_payload_bytes: 10 }).code, 'payload_budget_exceeded');
  assert.equal(modelSingleUplink({ ...input, returns: [{ slot: 1, bytes: Array(101).fill(0) }] }).code, 'invalid_model_input');
  assert.equal(modelSingleUplink({ ...input, returns: [{ slot: 1, bytes: Array(100).fill(0) }], max_payload_bytes: 105 }).ok, true);
  assert.equal(modelSingleUplink({ ...input, battery_mv: 32767, interrupt: false, returns: [{ slot: 1, bytes: [] }], max_payload_bytes: 5 }).bytes[0], 0x7f);
});

test('bridges only exact bindings and protocol framing, retaining wrapper evidence and wire order', () => {
  const raw = [0, 1, 1,
    0xf1, 7, ...Buffer.from('00001\r\n', 'latin1'),
    0xf2, 5, ...Buffer.from('0+1\r\n', 'latin1')];
  const result = inspectWrappedExchange({ frame: frame(raw), bindings: [
    { slot: 2, response_command: '0D0!' }, { slot: 1, response_command: '0M!' },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'complete');
  assert.deepEqual(result.exchange.values, [1]);
  assert.deepEqual(result.wrapper.records.map(record => record.slot), [1, 2]);
  assert.equal(result.bindings_verified, false);
  unqualified(result);
});

test('retains valid binding hypotheses when their slot set does not match', () => {
  const raw = frame([0, 0, 1, 0xf1, 0, 0xf2, 0]);
  for (const bindings of [
    [{ slot: 1, response_command: '0MC3!' }],
    [{ slot: 1, response_command: '0MC3!' }, { slot: 3, response_command: '0D0!' }],
  ]) {
    const result = inspectWrappedExchange({ frame: raw, bindings });
    assert.equal(result.code, 'bindings_do_not_match_records');
    assert.deepEqual(result.bindings, bindings);
    assert.equal(result.exchange, undefined);
    assert.equal(result.values, undefined);
    result.bindings[0].response_command = '0M!';
    assert.equal(bindings[0].response_command, '0MC3!');
    unqualified(result);
  }
});

test('bridge refuses binding gaps, duplicates, extra bindings and malformed exchange framing', () => {
  const wrapped = frame([0, 0, 1, 0xf1, 6, ...Buffer.from('00001\n', 'latin1')]);
  const cases = [
    { frame: wrapped, bindings: [] },
    { frame: wrapped, bindings: [{ slot: 2, response_command: '0M!' }] },
    { frame: wrapped, bindings: [{ slot: 1, response_command: '0M!' }, { slot: 2, response_command: '0D0!' }] },
    { frame: wrapped, bindings: [{ slot: 1, response_command: '0M!' }, { slot: 1, response_command: '0D0!' }] },
  ];
  for (const input of cases) {
    const result = inspectWrappedExchange(input);
    assert.equal(result.ok, false);
    assert.equal(result.disposition, 'invalid');
    assert.equal('exchange' in result, false);
    assert.equal(result.bindings_verified, false);
    unqualified(result);
  }
  const malformed = inspectWrappedExchange({ frame: wrapped, bindings: [{ slot: 1, response_command: '0M!' }] });
  assert.equal(malformed.wrapper.ok, true);
  assert.equal(malformed.exchange.code, 'invalid_announcement');
  assert.equal(malformed.disposition, 'invalid');
});
