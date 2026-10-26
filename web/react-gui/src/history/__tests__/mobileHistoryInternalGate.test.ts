import { describe, expect, it } from 'vitest';
import { mobileHistoryInternalEnabled } from '../mobileHistoryInternalGate';

describe('mobile history internal gate', () => {
  it('requires the exact string true', () => {
    expect(mobileHistoryInternalEnabled('true')).toBe(true);
    expect(mobileHistoryInternalEnabled('TRUE')).toBe(false);
    expect(mobileHistoryInternalEnabled(' true')).toBe(false);
    expect(mobileHistoryInternalEnabled(true)).toBe(false);
    expect(mobileHistoryInternalEnabled(undefined)).toBe(false);
  });
});
