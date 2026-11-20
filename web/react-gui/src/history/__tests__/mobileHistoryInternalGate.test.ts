import { expect, it } from 'vitest';
import { MOBILE_HISTORY_INTERNAL_ENABLED } from '../mobileHistoryInternalGate';

it('keeps the experimental phone charts off in the standard GUI config', () => {
  expect(MOBILE_HISTORY_INTERNAL_ENABLED).toBe(false);
});
