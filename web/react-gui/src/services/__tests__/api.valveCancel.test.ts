import { afterEach, describe, expect, it, vi } from 'vitest';

import api, { devicesAPI } from '../api';

// V9: with several opens active the gateway refuses an unnamed cancel as ambiguous_actuation, so
// the GUI names the reported active run as expectation_id. Without one the body stays { reason }.
describe('devicesAPI.cancelIrrigation request body', () => {
  const eui = '0016C001F1000001';
  afterEach(() => { vi.restoreAllMocks(); });

  it('posts the named run as expectation_id', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { status: 'cancelled', outcome: 'cancelled', collateral: [] } });
    await devicesAPI.cancelIrrigation(eui, { expectationId: 'vae-2' });
    expect(post).toHaveBeenCalledWith(`/api/valve/${eui}/cancel`, { reason: 'operator_cancel', expectation_id: 'vae-2' });
  });

  it('posts only the reason when no run is named', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { status: 'cancelled' } });
    await devicesAPI.cancelIrrigation(eui);
    await devicesAPI.cancelIrrigation(eui, { expectationId: null });
    await devicesAPI.cancelIrrigation(eui, { expectationId: '' });
    expect(post.mock.calls.map(([, body]) => body)).toEqual([
      { reason: 'operator_cancel' },
      { reason: 'operator_cancel' },
      { reason: 'operator_cancel' },
    ]);
  });
});
