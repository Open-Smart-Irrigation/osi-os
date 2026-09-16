import { describe, expect, it } from 'vitest';

import {
  createDateFormatter,
  formatDate,
  formatDateTime,
  formatRelativeToNow,
  formatTime,
  formatWeekday,
  resolveDateLocale,
  toDate,
} from '../datetime';

const ISO = '2026-07-08T09:41:00.000Z';

describe('resolveDateLocale', () => {
  it('keeps a tag the runtime can format with', () => {
    expect(resolveDateLocale('fr')).toBe('fr');
    expect(resolveDateLocale('de-CH')).toBe('de-CH');
  });

  it('falls back to English rather than the host locale when nothing is given', () => {
    expect(resolveDateLocale('')).toBe('en');
    expect(resolveDateLocale('   ')).toBe('en');
    expect(resolveDateLocale(null)).toBe('en');
    expect(resolveDateLocale(undefined)).toBe('en');
  });

  it('falls back to English on a malformed tag instead of throwing', () => {
    expect(resolveDateLocale('not a tag')).toBe('en');
    expect(resolveDateLocale('zz_ZZ_ZZ')).toBe('en');
  });
});

describe('toDate', () => {
  it('rejects missing and unparseable values', () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate('')).toBeNull();
    expect(toDate('not a date')).toBeNull();
  });

  it('accepts ISO strings, epoch millis and Date instances', () => {
    expect(toDate(ISO)?.toISOString()).toBe(ISO);
    expect(toDate(Date.parse(ISO))?.toISOString()).toBe(ISO);
    expect(toDate(new Date(ISO))?.toISOString()).toBe(ISO);
  });
});

describe('formatting keyed to the app language', () => {
  it('formats the clock with the requested locale, not the host locale', () => {
    expect(formatTime(ISO, 'fr')).toBe(
      new Intl.DateTimeFormat('fr', { hour: '2-digit', minute: '2-digit' }).format(new Date(ISO)),
    );
    // en-US puts the meridiem in; fr does not. If the language were ignored
    // these two would be identical, which is the bug this replaces.
    expect(formatTime(ISO, 'fr')).not.toBe(formatTime(ISO, 'en'));
  });

  it('formats dates and weekdays with the requested locale', () => {
    expect(formatDate(ISO, 'fr')).not.toBe(formatDate(ISO, 'en'));
    expect(formatDate(ISO, 'fr')).toBe(
      new Intl.DateTimeFormat('fr', { month: 'short', day: 'numeric' }).format(new Date(ISO)),
    );
    expect(formatWeekday(ISO, 'de-CH')).toBe(
      new Intl.DateTimeFormat('de-CH', { weekday: 'short' }).format(new Date(ISO)),
    );
    expect(formatDateTime(ISO, 'it')).toBe(
      new Intl.DateTimeFormat('it', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ISO)),
    );
  });

  it('returns null for missing input instead of a placeholder date', () => {
    for (const format of [formatTime, formatDate, formatDateTime, formatWeekday]) {
      expect(format(null, 'fr')).toBeNull();
      expect(format('', 'fr')).toBeNull();
      expect(format('not a date', 'fr')).toBeNull();
    }
  });

  it('accepts per-call option overrides', () => {
    expect(formatTime(ISO, 'fr', { second: '2-digit' })).toBe(
      new Intl.DateTimeFormat('fr', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ISO)),
    );
  });
});

describe('formatRelativeToNow', () => {
  const now = Date.parse('2026-07-08T13:41:00.000Z');

  it('picks the largest unit that fits the gap', () => {
    expect(formatRelativeToNow(ISO, 'en', now)).toBe('4 hours ago');
    expect(formatRelativeToNow('2026-07-08T13:36:00.000Z', 'en', now)).toBe('5 minutes ago');
    expect(formatRelativeToNow('2026-07-08T13:40:30.000Z', 'en', now)).toBe('30 seconds ago');
    expect(formatRelativeToNow('2026-07-05T13:41:00.000Z', 'en', now)).toBe('3 days ago');
  });

  it('uses the requested language', () => {
    expect(formatRelativeToNow(ISO, 'fr', now)).toBe(
      new Intl.RelativeTimeFormat('fr', { numeric: 'auto' }).format(-4, 'hour'),
    );
  });

  it('returns null when there is no timestamp to compare', () => {
    expect(formatRelativeToNow(null, 'en', now)).toBeNull();
    expect(formatRelativeToNow('not a date', 'en', now)).toBeNull();
  });
});

describe('createDateFormatter', () => {
  it('binds one language across every method', () => {
    const fmt = createDateFormatter('fr');
    expect(fmt.locale).toBe('fr');
    expect(fmt.time(ISO)).toBe(formatTime(ISO, 'fr'));
    expect(fmt.date(ISO)).toBe(formatDate(ISO, 'fr'));
    expect(fmt.dateTime(ISO)).toBe(formatDateTime(ISO, 'fr'));
    expect(fmt.weekday(ISO)).toBe(formatWeekday(ISO, 'fr'));
    expect(fmt.relativeToNow(ISO, Date.parse('2026-07-08T13:41:00.000Z')))
      .toBe(formatRelativeToNow(ISO, 'fr', Date.parse('2026-07-08T13:41:00.000Z')));
  });

  it('falls back to English when i18next has not resolved a language yet', () => {
    expect(createDateFormatter(undefined).locale).toBe('en');
  });
});
