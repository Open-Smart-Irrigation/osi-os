import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ValveCancelButton from '../ValveCancelButton';
import { devicesAPI, valvesAPI } from '../../../services/api';
import type { Device, ValveActiveActuation, ValveSummary } from '../../../types/farming';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../services/api', () => ({
  devicesAPI: { cancelIrrigation: vi.fn() },
  valvesAPI: { list: vi.fn() },
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

// A valve-list row (GET /api/valves). Its activeActuation is the gateway's cancellable-only pass
// (listValvesForUser), unlike the device list's newest active record.
function makeValve(activeActuation: ValveActiveActuation | null, deviceEui = 'A840410000000001'): ValveSummary {
  return { deviceEui, name: 'North Valve', activeActuation } as ValveSummary;
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
// ambiguous_actuation, so the card's cancel names a run. Review B1: never the device list's record,
// which the gateway's cancel may not accept (409 actuation_not_active). Review B2: the valve list is
// read fresh on the click, because its cached row can name a run that has already ended.
describe('ValveCancelButton (V9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(devicesAPI.cancelIrrigation).mockResolvedValue({ outcome: 'cancelled', collateral: [] });
    vi.mocked(valvesAPI.list).mockResolvedValue([]);
  });

  it("names the fresh valve list's cancellable open, not the device list's newer CLOSE owner", async () => {
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve(run('vae-other'), '0016C001F1000001'), makeValve(run('vae-open-a'))]);
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: newerCloseOwner })} />);
    clickCancel();
    expect(await sentOptions()).toEqual({ expectationId: 'vae-open-a' });
    expect(valvesAPI.list).toHaveBeenCalledTimes(1);
  });

  it('names the newest queued open the valve list reports when several are queued', async () => {
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve(run('vae-3'))]);
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: { expectationId: 'vae-3', reconciliationState: 'PENDING_OBSERVATION' } })} />);
    clickCancel();
    expect(await sentOptions()).toEqual({ expectationId: 'vae-3' });
  });

  it('sends an unnamed cancel when the valve list has no row for this valve, whatever the device list reports', async () => {
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve(run('vae-other'), '0016C001F1000001')]);
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: newerCloseOwner, active_valve_actuation: { expectation_id: 'vae-close-b' } })} />);
    clickCancel();
    expect((await sentOptions())?.expectationId ?? null).toBeNull();
  });

  it('sends an unnamed cancel when the valve row reports no active run', async () => {
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve(null)]);
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: newerCloseOwner })} />);
    clickCancel();
    expect((await sentOptions())?.expectationId ?? null).toBeNull();
  });

  it('sends an unnamed cancel when the fresh valve-list read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(valvesAPI.list).mockRejectedValue(new Error('timeout of 10000ms exceeded'));
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: newerCloseOwner })} />);
    clickCancel();
    expect((await sentOptions())?.expectationId ?? null).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("shows the gateway's message for a refused (409) cancel", async () => {
    const message = 'More than one actuation is active; name the one to cancel (expectation_id)';
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve(run('vae-open-a'))]);
    vi.mocked(devicesAPI.cancelIrrigation).mockRejectedValueOnce({
      response: { status: 409, data: { error: 'ambiguous_actuation', ambiguity: 'several_queued', message } },
    });
    const onError = vi.fn();
    render(<ValveCancelButton device={makeDevice({ activeValveActuation: newerCloseOwner })} onError={onError} />);
    clickCancel();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onError).toHaveBeenCalledWith(message);
  });
});
