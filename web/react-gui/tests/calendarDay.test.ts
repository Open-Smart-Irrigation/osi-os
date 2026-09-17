import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDate, parseCalendarDay, toDate } from '../src/utils/datetime.ts';

// F41 (overnight 2026-09-17). `YYYY-MM-DD` values from the edge API name a
// calendar day, but `new Date('2026-05-29')` is parsed as UTC midnight, so
// west of Greenwich the browser shows the day before. This suite runs under
// the node test runner rather than Vitest because it needs to change the
// process timezone between assertions, and Vitest's workers cache it.

const ZONES = [
  'Pacific/Kiritimati', // UTC+14, the largest positive offset in the tz database
  'Pacific/Auckland',
  'Europe/Zurich',
  'UTC',
  'America/New_York',
  'America/Anchorage',
  'Pacific/Midway', // UTC-11
];

function inZone<T>(zone: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('a bare calendar date keeps its own day in every timezone', () => {
  for (const zone of ZONES) {
    inZone(zone, () => {
      const parsed = parseCalendarDay('2026-05-29');
      assert.ok(parsed, `${zone}: parseCalendarDay returned null`);
      assert.equal(parsed.getFullYear(), 2026, `${zone}: year`);
      assert.equal(parsed.getMonth(), 4, `${zone}: month`);
      assert.equal(parsed.getDate(), 29, `${zone}: day of month`);
      assert.equal(formatDate(parsed, 'en'), 'May 29', `${zone}: rendered label`);
    });
  }
});

test('the unpadded parse this replaced really did shift the day', () => {
  // Pins the defect itself, so the fix cannot be quietly reverted into a
  // green suite: toDate() on the same string lands on the 28th in Anchorage.
  inZone('America/Anchorage', () => {
    assert.equal(toDate('2026-05-29')?.getDate(), 28);
    assert.equal(parseCalendarDay('2026-05-29')?.getDate(), 29);
  });
  inZone('Pacific/Kiritimati', () => {
    // East of Greenwich the unpadded parse happens to agree, which is why the
    // defect survived: it is invisible from Europe.
    assert.equal(toDate('2026-05-29')?.getDate(), 29);
    assert.equal(parseCalendarDay('2026-05-29')?.getDate(), 29);
  });
});
