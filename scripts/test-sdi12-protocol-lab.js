'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectExchange, calculateCapacity } = require('./lib/sdi12-protocol-lab');

function unqualified(report) {
  assert.equal(report.hardware_verified, false);
  assert.equal(report.acquisition_available, false);
  assert.equal(report.eligible, false);
}

function crc16(text) {
  let crc = 0;
  for (const character of text) {
    crc ^= character.charCodeAt(0);
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
  }
  return crc & 0xffff;
}

function crcReply(address, body) {
  const crc = crc16(address + body);
  return address + body + String.fromCharCode(0x40 | (crc >>> 12), 0x40 | ((crc >>> 6) & 63), 0x40 | (crc & 63)) + '\r\n';
}

function exchange({ command = '0M!', response = '00002\r\n', blocks = [] } = {}) {
  return { command, response, blocks };
}

function block(index, response, address = '0') {
  return { command: `${address}D${index}!`, response };
}

test('inspects a standard one-block M exchange without qualifying a sensor', () => {
  const input = exchange({ response: '00003\r\n', blocks: [block(0, '0+10-2.5+.3\r\n')] });
  const result = inspectExchange(input);
  assert.deepEqual(result.values, [10, -2.5, 0.3]);
  assert.deepEqual(result.tokens, ['+10', '-2.5', '+.3']);
  assert.equal(result.disposition, 'complete');
  assert.equal(result.blocks[0].value_characters, 10);
  assert.equal(result.blocks[0].wire_bytes, 13);
  assert.deepEqual(input.blocks[0], block(0, '0+10-2.5+.3\r\n'));
  unqualified(result);
});

test('accepts sparse M blocks in command order only', () => {
  const result = inspectExchange(exchange({
    response: '00004\r\n',
    blocks: [block(0, '0+1\r\n'), block(1, '0+2+3\r\n'), block(2, '0+4\r\n')],
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.tokens, ['+1', '+2', '+3', '+4']);
  assert.deepEqual(result.blocks.map(item => item.command), ['0D0!', '0D1!', '0D2!']);
  unqualified(result);
});

test('keeps incomplete measurements separate and supplies the next D command', () => {
  const result = inspectExchange(exchange({ response: '00003\r\n', blocks: [block(0, '0+1+2\r\n')] }));
  assert.equal(result.ok, false);
  assert.equal(result.disposition, 'incomplete');
  assert.equal(result.code, 'incomplete_data');
  assert.deepEqual(result.values, [1, 2]);
  assert.equal(result.next_command, '0D1!');
  unqualified(result);
});

test('rejects overcount and blocks after completion instead of trimming values', () => {
  const overcount = inspectExchange(exchange({ response: '00001\r\n', blocks: [block(0, '0+1+2\r\n')] }));
  const extra = inspectExchange(exchange({ response: '00001\r\n', blocks: [block(0, '0+1\r\n'), block(1, '0+2\r\n')] }));
  assert.deepEqual([overcount.code, extra.code], ['announced_count_exceeded', 'extra_block_after_completion']);
  assert.equal(overcount.disposition, 'invalid');
  unqualified(overcount);
  unqualified(extra);
});

test('treats a valid empty D response as terminal abortion and rejects following blocks', () => {
  const aborted = inspectExchange(exchange({ response: '00003\r\n', blocks: [block(0, '0+1\r\n'), block(1, '0\r\n')] }));
  const extra = inspectExchange(exchange({ response: '00003\r\n', blocks: [block(0, '0\r\n'), block(1, '0+1\r\n')] }));
  assert.equal(aborted.disposition, 'aborted');
  assert.equal(aborted.code, 'measurement_aborted');
  assert.equal('values' in aborted, false);
  assert.equal(aborted.blocks.length, 2);
  assert.equal(extra.code, 'extra_block_after_abortion');
  unqualified(aborted);
  unqualified(extra);
});

test('reports D9 exhaustion for an incomplete C transcript without a next command', () => {
  const c = inspectExchange(exchange({ command: '0C!', response: '000099\r\n', blocks: Array.from({ length: 10 }, (_, i) => block(i, '0+1\r\n')) }));
  assert.equal(c.disposition, 'incomplete');
  assert.equal(c.code, 'data_blocks_exhausted');
  assert.equal('next_command' in c, false);
  unqualified(c);
});

test('enforces sequential D commands and case-sensitive addresses', () => {
  const duplicate = inspectExchange(exchange({ response: '00002\r\n', blocks: [block(0, '0+1\r\n'), block(0, '0+2\r\n')] }));
  const reordered = inspectExchange(exchange({ response: '00002\r\n', blocks: [block(1, '0+1\r\n')] }));
  const wrongCase = inspectExchange(exchange({ command: 'aM!', response: 'A0011\r\n', blocks: [block(0, 'a+1\r\n', 'A')] }));
  assert.deepEqual([duplicate.code, reordered.code], ['unexpected_data_command', 'unexpected_data_command']);
  assert.equal(wrongCase.disposition, 'invalid');
});

test('requires exact input keys, announcement framing, and strict block shapes', () => {
  const unknown = inspectExchange({ ...exchange(), extra: true });
  const framing = inspectExchange(exchange({ response: '00001\n', blocks: [block(0, '0+1\r\n')] }));
  const malformedBlock = inspectExchange(exchange({ blocks: [{ command: '0D0!', response: '0+1\r\n', extra: true }] }));
  const hole = inspectExchange(exchange({ blocks: [, block(1, '0+1\r\n')] }));
  for (const result of [unknown, framing, malformedBlock, hole]) {
    assert.equal(result.ok, false);
    assert.equal(result.disposition, 'invalid');
    assert.equal('values' in result, false);
    unqualified(result);
  }
});

test('rejects unsupported command forms and a single body beyond the M limit', () => {
  for (const command of ['0M0!', '0C0!', '*M!', '0A!', '0X!', '0M123!']) {
    const result = inspectExchange(exchange({ command }));
    assert.equal(result.code, 'invalid_command');
  }
  const overlong = inspectExchange(exchange({ response: '00001\r\n', blocks: [block(0, `0${'+1'.repeat(18)}\r\n`)] }));
  assert.equal(overlong.code, 'data_body_too_long');
});

test('accepts seven digits and rejects eight digits, exponents, whitespace, and missing signs', () => {
  const valid = inspectExchange(exchange({ response: '00001\r\n', blocks: [block(0, '0-1234567\r\n')] }));
  assert.equal(valid.values[0], -1234567);
  for (const body of ['+12345678', '+1e2', '+ 1', '1']) {
    const result = inspectExchange(exchange({ response: '00001\r\n', blocks: [block(0, `0${body}\r\n`)] }));
    assert.equal(result.code, 'invalid_numeric_body');
    unqualified(result);
  }
  const nonfinite = inspectExchange(exchange({ command: Number.NaN }));
  assert.equal(nonfinite.code, 'invalid_command');
});

test('handles zero count only as the conservative no-values outcome', () => {
  const noValues = inspectExchange(exchange({ response: '00000\r\n' }));
  const wait = inspectExchange(exchange({ response: '00100\r\n' }));
  const blocks = inspectExchange(exchange({ response: '00000\r\n', blocks: [block(0, '0\r\n')] }));
  assert.equal(noValues.disposition, 'no_values');
  assert.deepEqual(noValues.values, []);
  assert.equal('next_command' in noValues, false);
  assert.deepEqual([wait.code, blocks.code], ['invalid_zero_count', 'invalid_zero_count']);
  unqualified(noValues);
});

test('accepts C count 99 and rejects a three-digit C announcement count', () => {
  const tokens = Array.from({ length: 99 }, () => '+0');
  const blocks = [
    block(0, `0${tokens.slice(0, 37).join('')}\r\n`),
    block(1, `0${tokens.slice(37, 74).join('')}\r\n`),
    block(2, `0${tokens.slice(74).join('')}\r\n`),
  ];
  const valid = inspectExchange(exchange({ command: '0C!', response: '000099\r\n', blocks }));
  const waitNine = inspectExchange(exchange({ command: '0C!', response: '000999\r\n' }));
  const invalid = inspectExchange(exchange({ command: '0C!', response: '0000999\r\n' }));
  assert.equal(valid.ok, true);
  assert.equal(valid.announced_count, 99);
  assert.equal(waitNine.disposition, 'incomplete');
  assert.equal(waitNine.announced_count, 99);
  assert.equal(waitNine.wait_seconds, 9);
  assert.equal(invalid.disposition, 'invalid');
  assert.equal(invalid.code, 'invalid_announcement');
  unqualified(valid);
  unqualified(waitNine);
  unqualified(invalid);
});

test('verifies published CRC forms and rejects bad, absent, or superfluous CRC', () => {
  const first = inspectExchange(exchange({ command: '0MC!', response: '00001\r\n', blocks: [block(0, '0+3.14OqZ\r\n')] }));
  const second = inspectExchange(exchange({ command: '0MC!', response: '00003\r\n', blocks: [block(0, '0+3.14+2.718+1.414Ipz\r\n')] }));
  const wrong = inspectExchange(exchange({ command: '0MC!', response: '00001\r\n', blocks: [block(0, '0+3.14OqY\r\n')] }));
  const absent = inspectExchange(exchange({ command: '0MC!', response: '00001\r\n', blocks: [block(0, '0+3.14\r\n')] }));
  const extra = inspectExchange(exchange({ response: '00001\r\n', blocks: [block(0, '0+3.14OqZ\r\n')] }));
  assert.deepEqual([first.ok, second.ok], [true, true]);
  assert.deepEqual([wrong.code, absent.code, extra.code], ['invalid_crc', 'invalid_crc', 'invalid_numeric_body']);
});

test('uses C framing and capacity rules for CC commands', () => {
  const result = inspectExchange(exchange({ command: '0CC!', response: '000001\r\n', blocks: [block(0, crcReply('0', '+1'))] }));
  assert.equal(result.ok, true);
  assert.equal(result.family, 'C');
  assert.equal(result.crc_requested, true);
  assert.equal(result.wait_seconds, 0);
});

test('accepts CRC DEL bytes and verifies CRC before accepting an empty response', () => {
  let body = null;
  for (let value = 0; value < 10000 && body === null; value += 1) {
    const candidate = `+${value}`;
    const encoded = crcReply('0', candidate).slice(-5, -2);
    if (encoded.charCodeAt(1) === 0x7f || encoded.charCodeAt(2) === 0x7f) body = candidate;
  }
  assert.notEqual(body, null);
  const del = inspectExchange(exchange({ command: '0MC!', response: '00001\r\n', blocks: [block(0, crcReply('0', body))] }));
  const empty = inspectExchange(exchange({ command: '0MC!', response: '00001\r\n', blocks: [block(0, crcReply('0', ''))] }));
  const badEmpty = inspectExchange(exchange({ command: '0MC!', response: '00001\r\n', blocks: [block(0, '0@@@\r\n')] }));
  assert.equal(del.ok, true);
  assert.equal(empty.disposition, 'aborted');
  assert.equal(badEmpty.code, 'invalid_crc');
});

test('calculates bounded packed estimates without treating them as actual block counts', () => {
  const fourNine = calculateCapacity({ family: 'M', value_count: 4, value_width: 9, crc: false });
  const sixSix = calculateCapacity({ family: 'M', value_count: 6, value_width: 6, crc: true });
  const c = calculateCapacity({ family: 'C', value_count: 99, value_width: 2, crc: false });
  assert.deepEqual(fourNine, {
    ok: true, disposition: 'capacity', family: 'M', value_count: 4, value_width: 9, crc: false,
    value_characters_per_block: 35, values_per_packed_block: 3, packed_blocks: 2, packed_wire_bytes: 42,
    fits_ten_blocks: true, packing_assumption: 'equal_width_tightly_packed', actual_block_count_known: false,
    hardware_verified: false, acquisition_available: false, eligible: false,
  });
  assert.equal(sixSix.packed_blocks, 2);
  assert.equal(sixSix.packed_wire_bytes, 48);
  assert.deepEqual([c.value_characters_per_block, c.values_per_packed_block, c.packed_blocks, c.packed_wire_bytes], [75, 37, 3, 207]);
  unqualified(sixSix);
  unqualified(c);
});

test('rejects malformed capacity input with the shared invalid envelope', () => {
  for (const input of [null, { family: 'M', value_count: 0, value_width: 2, crc: false },
    { family: 'M', value_count: 1, value_width: 10, crc: false },
    { family: 'C', value_count: 100, value_width: 2, crc: false },
    { family: 'M', value_count: 1, value_width: 2, crc: 0 },
    { family: 'M', value_count: 1, value_width: 2, crc: false, extra: true }]) {
    const result = calculateCapacity(input);
    assert.equal(result.disposition, 'invalid');
    assert.equal(typeof result.code, 'string');
    unqualified(result);
  }
});
