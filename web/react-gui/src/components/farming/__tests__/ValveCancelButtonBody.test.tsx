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

// The device card's cancel stays unnamed, as on 14720cc8: it posts { reason } even when the
// device list reports an active run. The device list's record is not the gateway's
// cancellable-only pass (review B1), and a fresh valve-list read before the POST delayed the
// cancel (review R3-L1); only the valve control panel names a run.
describe("device card's cancel request body", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('posts the unnamed { reason } even when an active run is reported', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { status: 'cancelled', outcome: 'cancelled', collateral: [] } });
    const device = {
      id: 1,
      deveui: 'A840410000000001',
      name: 'North Valve',
      type_id: 'STREGA_VALVE',
      current_state: 'OPEN',
      latest_data: {},
      activeValveActuation: { expectationId: 'vae-1', expectation_id: 'vae-1', reconciliationState: 'PENDING_OBSERVATION' },
    } as unknown as Device;
    render(<ValveCancelButton device={device} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued open' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/api/valve/A840410000000001/cancel', { reason: 'operator_cancel' });
  });
});
