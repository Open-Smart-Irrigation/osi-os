import { describe, expect, it } from 'vitest';

import type { EntryStatus } from '../../../types/journal';
import { statusBadgeClass } from '../statusBadgeClass';

describe('statusBadgeClass', () => {
  it.each([
    ['final', 'bg-[var(--success-bg)] text-[var(--success-text)]'],
    ['draft', 'bg-[var(--warn-bg)] text-[var(--warn-text)]'],
    ['voided', 'bg-red-100 text-red-800'],
  ] satisfies Array<[EntryStatus, string]>)(
    'maps %s to its badge classes',
    (status, expected) => {
      expect(statusBadgeClass(status)).toBe(expected);
    },
  );
});
