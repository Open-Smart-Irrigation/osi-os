import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';

import { ValveControlPanel } from '../ValveControlPanel';
import { devicesAPI, valvesAPI } from '../../../../services/api';
import { holdValveOpen, resetValveCommandHoldsForTest } from '../../../../services/valveCommandHold';
import type { ValveSummary } from '../../../../types/farming';

// An Open dialog that is already on screen when another surface's open times out must not
// send: the real panel, tile and dialog, with the hold started from outside the panel (as
// the zone card or the service dialog would).

const NO_ANSWER_OPEN = 'No answer yet; the command may have reached the valve.';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      open: 'Open',
      'openDialog.confirm': 'Confirm open',
      'commandNoAnswer.open': NO_ANSWER_OPEN,
    } as Record<string, string>)[key] ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../../services/api', () => ({
  devicesAPI: { controlValve: vi.fn(), cancelIrrigation: vi.fn(), rename: vi.fn() },
  valvesAPI: { list: vi.fn(), updateSettings: vi.fn(), setSchedulerStatus: vi.fn(), resendPlan: vi.fn() },
}));
vi.mock('../ValveScheduleDialog', () => ({ ValveScheduleDialog: () => null }));
vi.mock('../ValveSettingsDialog', () => ({ ValveSettingsDialog: () => null }));
vi.mock('../ValveServiceDialog', () => ({ ValveServiceDialog: () => null }));

const EUI = '0016C001F1000001';
const valve = {
  deviceEui: EUI, name: 'North Valve', zoneId: 1, zoneName: 'North Block', zoneUuid: 'uuid-1',
  timezone: 'Europe/Zurich', currentState: 'CLOSED', targetState: null, stregaGeneration: 'GEN1',
  flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null, schedulerStatus: 'ACTIVE',
  skipTodayDate: null, lastUplinkAt: null, activeActuation: null, recentStaleState: null, nextRun: null,
  scheduleCount: 0, pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
  lastClockSyncAckedAt: null, enclosureTemperatureC: null, enclosureHumidityPct: null, enclosureMeasuredAt: null,
} as ValveSummary;

describe('ValveOpenDialog already open when the hold begins', () => {
  beforeEach(() => {
    resetValveCommandHoldsForTest();
    vi.clearAllMocks();
    // The first reading shows the valve; later readings never answer, so nothing releases the hold.
    vi.mocked(valvesAPI.list).mockResolvedValueOnce([valve]).mockImplementation(() => new Promise(() => undefined));
    vi.mocked(devicesAPI.controlValve).mockResolvedValue(undefined);
  });

  it('disables the confirmation, says why, and sends nothing', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ValveControlPanel onUpdate={vi.fn()} canWrite />
      </SWRConfig>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    const confirm = screen.getByRole('button', { name: 'Confirm open' });
    expect(confirm).toBeEnabled();

    act(() => { holdValveOpen(EUI); });

    expect(confirm).toBeDisabled();
    expect(screen.getByRole('dialog')).toHaveTextContent(NO_ANSWER_OPEN);
    fireEvent.click(confirm);
    fireEvent.keyDown(confirm, { key: 'Enter' });
    expect(devicesAPI.controlValve).not.toHaveBeenCalled();
  });
});
