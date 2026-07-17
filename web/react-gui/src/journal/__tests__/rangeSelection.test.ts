import { describe, expect, it } from 'vitest';

import { formatStationRange, parseStationRange } from '../rangeSelection';

const availableNumbers = new Set([2, 3, 4, 5, 6, 10, 11, 12]);
const RANGE_INPUT_LIMIT = 1024;

describe('parseStationRange', () => {
  it('expands comma-separated values and ranges in numeric order', () => {
    expect(parseStationRange('2, 5, 6, 10-12', availableNumbers)).toEqual({
      ok: true,
      values: [2, 5, 6, 10, 11, 12],
    });
  });

  it('normalizes whitespace around tokens and range endpoints', () => {
    expect(parseStationRange(' 2 , 5 - 6 , 10-12 ', availableNumbers)).toEqual({
      ok: true,
      values: [2, 5, 6, 10, 11, 12],
    });
  });

  it.each([
    ['', { ok: false, code: 'empty', token: '' }],
    ['2,,4', { ok: false, code: 'empty', token: '' }],
    ['2--4', { ok: false, code: 'malformed', token: '2--4' }],
    ['2-', { ok: false, code: 'malformed', token: '2-' }],
    ['a', { ok: false, code: 'malformed', token: 'a' }],
    ['2.5', { ok: false, code: 'non_integer', token: '2.5' }],
    ['1e3', { ok: false, code: 'non_integer', token: '1e3' }],
    ['1.5e2', { ok: false, code: 'non_integer', token: '1.5e2' }],
    ['.5e2', { ok: false, code: 'non_integer', token: '.5e2' }],
    ['5.e2', { ok: false, code: 'non_integer', token: '5.e2' }],
    ['0', { ok: false, code: 'non_positive', token: '0' }],
    ['-2', { ok: false, code: 'non_positive', token: '-2' }],
    ['2-0', { ok: false, code: 'non_positive', token: '2-0' }],
    ['12-10', { ok: false, code: 'reversed', token: '12-10' }],
    ['5,5', { ok: false, code: 'duplicate', token: '5' }],
    ['2-4,4-6', { ok: false, code: 'duplicate', token: '4-6' }],
    ['2,9', { ok: false, code: 'out_of_station', token: '9' }],
  ] as const)('returns the exact failure for %s', (input, expected) => {
    expect(parseStationRange(input, availableNumbers)).toEqual(expected);
  });

  it('reports a missing member of a range as the original range token', () => {
    expect(parseStationRange('10-12', new Set([10, 12]))).toEqual({
      ok: false,
      code: 'out_of_station',
      token: '10-12',
    });
  });

  it('rejects comma-rich over-limit input before splitting it', () => {
    const input = ','.repeat(RANGE_INPUT_LIMIT + 1);

    expect(parseStationRange(input, availableNumbers)).toEqual({
      ok: false,
      code: 'malformed',
      token: input,
    });
  });

  it('rejects one oversized numeric token before numeric classification', () => {
    const input = '1'.repeat(RANGE_INPUT_LIMIT + 1);

    expect(parseStationRange(input, availableNumbers)).toEqual({
      ok: false,
      code: 'malformed',
      token: input,
    });
  });

  it('classifies input exactly at the limit through the normal parser path', () => {
    const input = '1'.repeat(RANGE_INPUT_LIMIT);

    expect(parseStationRange(input, availableNumbers)).toEqual({
      ok: false,
      code: 'non_integer',
      token: input,
    });
  });
});

describe('formatStationRange', () => {
  it('sorts unique values and compresses consecutive runs deterministically', () => {
    expect(formatStationRange([12, 2, 6, 5, 10, 11, 12, 2])).toBe('2, 5-6, 10-12');
  });

  it('formats an empty selection as an empty string', () => {
    expect(formatStationRange([])).toBe('');
  });
});
