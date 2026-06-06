import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatTimeTick,
  formatWindowCaption,
  timeTickTier,
} from '../src/components/history/visualizations/chartAxis.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DATE_RANGE_SEPARATOR = ' – ';

function formatExpected(ms: number, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(ms));
}

function formatPart(ms: number, type: Intl.DateTimeFormatPartTypes, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, options)
    .formatToParts(new Date(ms))
    .find((part) => part.type === type)?.value ?? '';
}

function expectedDayMonth(ms: number, includeYear = false): string {
  const day = formatPart(ms, 'day', { day: 'numeric', month: 'short' });
  const month = formatPart(ms, 'month', { day: 'numeric', month: 'short' });
  const year = includeYear ? formatPart(ms, 'year', { year: 'numeric' }) : '';
  return [day, month, year].filter(Boolean).join(' ');
}

function expectedMonthYear(ms: number): string {
  const month = formatPart(ms, 'month', { day: 'numeric', month: 'short' });
  const year = formatPart(ms, 'year', { year: '2-digit' });
  return [month, year].filter(Boolean).join(' ');
}

test('timeTickTier maps visible spans to compact label tiers', () => {
  assert.equal(timeTickTier(0), 'intraday');
  assert.equal(timeTickTier(Number.NaN), 'intraday');
  assert.equal(timeTickTier(Number.POSITIVE_INFINITY), 'months');
  assert.equal(timeTickTier(12 * HOUR_MS), 'intraday');
  assert.equal(timeTickTier(DAY_MS), 'days');
  assert.equal(timeTickTier(6 * DAY_MS), 'days');
  assert.equal(timeTickTier(7 * DAY_MS), 'weeks');
  assert.equal(timeTickTier(89 * DAY_MS), 'weeks');
  assert.equal(timeTickTier(90 * DAY_MS), 'months');
});

test('formatTimeTick uses zoom-adaptive compact labels', () => {
  const fridayMorning = Date.UTC(2026, 5, 5, 6, 0);

  assert.equal(formatTimeTick(fridayMorning, 12 * HOUR_MS), formatExpected(fridayMorning, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }));
  assert.equal(formatTimeTick(fridayMorning, 2 * DAY_MS), formatExpected(fridayMorning, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }));
  assert.equal(formatTimeTick(fridayMorning, 30 * DAY_MS), expectedDayMonth(fridayMorning));
  assert.equal(formatTimeTick(fridayMorning, 120 * DAY_MS), expectedMonthYear(fridayMorning));
  assert.equal(formatTimeTick(Number.NaN, 12 * HOUR_MS), '-');
});

test('formatWindowCaption summarizes the visible zoom window', () => {
  const jun5Morning = Date.UTC(2026, 5, 5, 6, 0);
  const jun5Afternoon = Date.UTC(2026, 5, 5, 18, 0);
  const jun8Morning = Date.UTC(2026, 5, 8, 6, 0);
  const jul10Morning = Date.UTC(2026, 6, 10, 6, 0);
  const feb1Morning = Date.UTC(2027, 1, 1, 6, 0);

  assert.equal(formatWindowCaption(jun5Morning, jun5Afternoon), expectedDayMonth(jun5Morning));
  assert.equal(
    formatWindowCaption(jun5Morning, jun8Morning),
    [expectedDayMonth(jun5Morning), expectedDayMonth(jun8Morning)].join(DATE_RANGE_SEPARATOR),
  );
  assert.equal(
    formatWindowCaption(jun5Morning, jul10Morning),
    [expectedDayMonth(jun5Morning), expectedDayMonth(jul10Morning)].join(DATE_RANGE_SEPARATOR),
  );
  assert.equal(
    formatWindowCaption(jun5Morning, feb1Morning),
    [expectedMonthYear(jun5Morning), expectedMonthYear(feb1Morning)].join(DATE_RANGE_SEPARATOR),
  );
  assert.equal(formatWindowCaption(Number.NaN, jun5Morning), '-');
  assert.equal(formatWindowCaption(jun8Morning, jun5Morning), '-');
});
