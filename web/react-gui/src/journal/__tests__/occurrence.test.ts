import { describe, expect, it } from 'vitest';

import {
  isValidApiInstant,
  OccurrenceResolutionError,
  resolveOccurrence,
} from '../occurrence';

function expectOccurrenceError(
  action: () => unknown,
  code: string,
  availableOffsets: number[] = [],
) {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(OccurrenceResolutionError);
    expect(error).toMatchObject({ code, availableOffsets });
  }
}

describe('resolveOccurrence', () => {
  it.each([
    '1',
    '2026-07-16T08:30:00',
    '2026-02-30T08:30:00Z',
  ])('rejects malformed API instant %s', (instant) => {
    expect(isValidApiInstant(instant)).toBe(false);
  });

  it.each([
    '2026-07-16T08:30:00.000Z',
    '2026-07-16T10:30:00+02:00',
  ])('accepts strict API instant %s', (instant) => {
    expect(isValidApiInstant(instant)).toBe(true);
  });

  it('resolves a valid Zurich wall time to its UTC instant and offset', () => {
    expect(resolveOccurrence('2026-07-16T08:30', 'Europe/Zurich')).toEqual({
      instant: '2026-07-16T06:30:00.000Z',
      offsetMinutes: 120,
      localDate: '2026-07-16',
    });
  });

  it('rejects the Zurich spring-forward gap', () => {
    expectOccurrenceError(
      () => resolveOccurrence('2026-03-29T02:30', 'Europe/Zurich'),
      'nonexistent_local_time',
    );
  });

  it('returns both Zurich fall-back offsets without choosing one', () => {
    expectOccurrenceError(
      () => resolveOccurrence('2026-10-25T02:30', 'Europe/Zurich'),
      'ambiguous_local_time',
      [120, 60],
    );
  });

  it.each([
    [120, '2026-10-25T00:30:00.000Z'],
    [60, '2026-10-25T01:30:00.000Z'],
  ])('uses the explicit %i minute offset for a Zurich fold', (offsetMinutes, instant) => {
    expect(resolveOccurrence('2026-10-25T02:30', 'Europe/Zurich', offsetMinutes)).toEqual({
      instant,
      offsetMinutes,
      localDate: '2026-10-25',
    });
  });

  it('rejects an offset that does not match the wall time and timezone', () => {
    expectOccurrenceError(
      () => resolveOccurrence('2026-07-16T08:30', 'Europe/Zurich', 60),
      'invalid_utc_offset',
      [120],
    );
  });

  it.each([
    ['2026-02-29T08:30', 'Europe/Zurich', 'invalid_local_time'],
    ['2026-07-16 08:30', 'Europe/Zurich', 'invalid_local_time'],
    ['2026-07-16T08:30', 'Mars/Olympus_Mons', 'invalid_timezone'],
  ])('rejects invalid occurrence input %s', (local, timezone, code) => {
    expectOccurrenceError(() => resolveOccurrence(local, timezone), code);
  });
});
