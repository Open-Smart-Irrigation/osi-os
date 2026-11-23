import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ValveCancelButton from '../ValveCancelButton';
import api from '../../../services/api';
import type { Device } from '../../../types/farming';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

const EUI = 'A840410000000001';
const device = {
  id: 1,
  deveui: EUI,
  name: 'North Valve',
  type_id: 'STREGA_VALVE',
  current_state: 'OPEN',
  latest_data: {},
  activeValveActuation: { expectationId: 'vae-close-b', expectation_id: 'vae-close-b', reconciliationState: 'PENDING_OBSERVATION' },
} as unknown as Device;
const cancelled = { data: { status: 'cancelled', outcome: 'cancelled', collateral: [] } };

// V9 (v0.8.2): the device card's cancel goes out unnamed at once, as on 14720cc8, whatever the
// device list reports. Only a 409 ambiguous_actuation leads to one fresh GET /api/valves and one
// retry naming that read's run (the gateway's cancellable-only pass).
describe("device card's cancel (V9)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('posts the unnamed { reason } at once, with no read before it', async () => {
    const get = vi.spyOn(api, 'get');
    const post = vi.spyOn(api, 'post').mockResolvedValue(cancelled);
    render(<ValveCancelButton device={device} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued open' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(`/api/valve/${EUI}/cancel`, { reason: 'operator_cancel' });
    expect(get).not.toHaveBeenCalled();
  });

  it("after a 409 ambiguous_actuation reads the valve list fresh and retries once, naming this valve's run", async () => {
    const post = vi.spyOn(api, 'post')
      .mockRejectedValueOnce({ response: { status: 409, data: { error: 'ambiguous_actuation', ambiguity: 'several_queued', message: 'More than one actuation is active' } } })
      .mockResolvedValueOnce(cancelled);
    const get = vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        valves: [
          { device_eui: '0016C001F1000001', active_actuation: { expectation_id: 'vae-other', reconciliation_state: 'PENDING_OBSERVATION', commanded_at: '2026-11-15T08:00:00Z', expected_close_at: '2026-11-15T08:10:00Z' } },
          { device_eui: EUI.toLowerCase(), active_actuation: { expectation_id: 'vae-open-a', reconciliation_state: 'PENDING_OBSERVATION', commanded_at: '2026-11-15T08:00:00Z', expected_close_at: '2026-11-15T08:10:00Z' } },
        ],
      },
    });
    const onUpdate = vi.fn();
    render(<ValveCancelButton device={device} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued open' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(post.mock.calls).toEqual([
      [`/api/valve/${EUI}/cancel`, { reason: 'operator_cancel' }],
      [`/api/valve/${EUI}/cancel`, { reason: 'operator_cancel', expectation_id: 'vae-open-a' }],
    ]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/valves');
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
  });
});
