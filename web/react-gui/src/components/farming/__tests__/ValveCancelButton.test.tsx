import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ValveCancelButton from '../ValveCancelButton';
import { devicesAPI } from '../../../services/api';
import type { Device, ValveActiveActuation, ValveSummary } from '../../../types/farming';

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

// The valve-list row (GET /api/valves). Its activeActuation is the gateway's cancellable-only
// pass (listValvesForUser), unlike the device list's newest active record.
function makeValve(activeActuation: ValveActiveActuation | null): ValveSummary {
  return { deviceEui: 'A840410000000001', name: 'North Valve', activeActuation } as ValveSummary;
}

function run(expectationId: string): ValveActiveActuation {
  return {
    expectationId,
    reconciliationState: 'PENDING_OBSERVATION',
    commandedAt: '2026-11-15T08:00:00Z',
    expectedCloseAt: '2026-11-15T08:10:00Z',
    durationSeconds: 600,
    trigger: 'manual',
  };
}

// The device list's newest active record: here a newer CLOSE owner (duration 0) that the
// gateway's cancel does not treat as a cancellable open.
const newerCloseOwner = { expectationId: 'vae-close-b', reconciliationState: 'PENDING_OBSERVATION' };

const clickCancel = () => fireEvent.click(screen.getByRole('button', { name: 'Cancel queued open' }));

async function sentOptions() {
  await waitFor(() => expect(devicesAPI.cancelIrrigation).toHaveBeenCalledTimes(1));
  const [eui, options] = vi.mocked(devicesAPI.cancelIrrigation).mock.calls[0];
  expect(eui).toBe('A840410000000001');
  return options;
}

// V9 (v0.8.2): with several opens queued the gateway refuses an unnamed cancel as
// ambiguous_actuation, so the card's cancel names the run the valve list reports. Review B1: never
// the device list's record, which the gateway's cancel may not accept (409 actuation_not_active).
describe('ValveCancelButton (V9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(devicesAPI.cancelIrrigation).mockResolvedValue({ outcome: 'cancelled', collateral: [] });
  });

  it("names the valve list's cancellable open, not the device list's newer CLOSE owner", async () => {
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: newerCloseOwner })} valve={makeValve(run('vae-open-a'))} />);
    clickCancel();
    expect(await sentOptions()).toEqual({ expectationId: 'vae-open-a' });
  });

  it('names the newest queued open the valve list reports when several are queued', async () => {
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: { expectationId: 'vae-3', reconciliationState: 'PENDING_OBSERVATION' } })} valve={makeValve(run('vae-3'))} />);
    clickCancel();
    expect(await sentOptions()).toEqual({ expectationId: 'vae-3' });
  });

  it('sends an unnamed cancel when the valve row is absent, whatever the device list reports', async () => {
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: newerCloseOwner, active_valve_actuation: { expectation_id: 'vae-close-b' } })} />);
    clickCancel();
    expect((await sentOptions())?.expectationId ?? null).toBeNull();
  });

  it('sends an unnamed cancel when the valve row reports no active run', async () => {
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: newerCloseOwner })} valve={makeValve(null)} />);
    clickCancel();
    expect((await sentOptions())?.expectationId ?? null).toBeNull();
  });

  it("shows the gateway's message for a refused (409) cancel", async () => {
    const message = 'More than one actuation is active; name the one to cancel (expectation_id)';
    vi.mocked(devicesAPI.cancelIrrigation).mockRejectedValueOnce({
      response: { status: 409, data: { error: 'ambiguous_actuation', ambiguity: 'several_queued', message } },
    });
    const onError = vi.fn();
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: newerCloseOwner })} valve={makeValve(run('vae-open-a'))} onError={onError} />);
    clickCancel();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onError).toHaveBeenCalledWith(message);
  });
});
