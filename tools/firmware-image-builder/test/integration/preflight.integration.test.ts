import { describe, expect, it } from 'vitest';

import { createReadOnlyPreflightDefaults } from '../../api/src/preflight.js';

describe('real preflight host probe', () => {
  it('returns typed systemd availability without mutating host state', async () => {
    const defaults = createReadOnlyPreflightDefaults();
    const result = await defaults.systemd.checkUserManager();
    expect(result).toEqual({ available: expect.any(Boolean), runnerActive: expect.any(Boolean) });
  });
});
