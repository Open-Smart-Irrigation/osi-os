import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ValveCancelButton from '../ValveCancelButton';
import { devicesAPI } from '../../../services/api';
import type { Device } from '../../../types/farming';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../services/api', () => ({
  devicesAPI: { cancelIrrigation: vi.fn() },
}));

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 1,
    deveui: 'A840410000000001',
    name: 'North Valve',
    type_id: 'STREGA_VALVE',
    current_state: 'CLOSED',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-11-15T00:00:00Z',
    irrigation_zone_id: null,
    latest_data: {},
    ...overrides,
  } as Device;
}

const clickCancel = () => fireEvent.click(screen.getByRole('button', { name: 'Cancel queued open' }));

// V9 (v0.8.2): with several opens queued the gateway refuses an unnamed cancel as
// ambiguous_actuation, so the card's cancel names the active run the gateway reports.
describe('ValveCancelButton (V9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(devicesAPI.cancelIrrigation).mockResolvedValue({ outcome: 'cancelled', collateral: [] });
  });

  it('sends the expectation_id of the reported active run', async () => {
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: { expectationId: 'vae-1', reconciliationState: 'PENDING_OBSERVATION' } })} />);
    clickCancel();
    await waitFor(() => expect(devicesAPI.cancelIrrigation).toHaveBeenCalledTimes(1));
    expect(devicesAPI.cancelIrrigation).toHaveBeenCalledWith('A840410000000001', { expectationId: 'vae-1' });
  });

  it('reads the snake_case active run as well', async () => {
    render(<ValveCancelButton device={makeDevice({ active_valve_actuation: { expectation_id: 'vae-3' } })} />);
    clickCancel();
    await waitFor(() => expect(devicesAPI.cancelIrrigation).toHaveBeenCalledTimes(1));
    expect(devicesAPI.cancelIrrigation).toHaveBeenCalledWith('A840410000000001', { expectationId: 'vae-3' });
  });

  it('names no run when the gateway reports no active run', async () => {
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: null })} />);
    clickCancel();
    await waitFor(() => expect(devicesAPI.cancelIrrigation).toHaveBeenCalledTimes(1));
    const [eui, options] = vi.mocked(devicesAPI.cancelIrrigation).mock.calls[0];
    expect(eui).toBe('A840410000000001');
    expect(options?.expectationId ?? null).toBeNull();
  });

  it("shows the gateway's message for a refused (409) cancel", async () => {
    const message = 'More than one actuation is active; name the one to cancel (expectation_id)';
    vi.mocked(devicesAPI.cancelIrrigation).mockRejectedValueOnce({
      response: { status: 409, data: { error: 'ambiguous_actuation', ambiguity: 'several_queued', message } },
    });
    const onError = vi.fn();
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: { expectationId: 'vae-1' } })} onError={onError} />);
    clickCancel();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onError).toHaveBeenCalledWith(message);
  });
});
