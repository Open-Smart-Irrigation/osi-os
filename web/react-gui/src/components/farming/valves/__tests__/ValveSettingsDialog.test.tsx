import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ValveSettingsDialog } from '../ValveSettingsDialog';
import { devicesAPI, valvesAPI } from '../../../../services/api';
import type { ValveSummary } from '../../../../types/farming';

const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    'settingsDialog.title': 'Settings for {{name}}',
    'settingsDialog.generation': 'Valve generation',
    'settingsDialog.gen1': 'Gen-1',
    'settingsDialog.gen2': 'Gen-2',
    'settingsDialog.flowRate': 'Flow rate (L/min)',
    'settingsDialog.flowRateHint': 'Enter a rate above 0 L/min.',
    'settingsDialog.flowFromZone': 'Using the zone calibration: {{rate}} L/min. Enter a rate to override it for this valve.',
    'settingsDialog.flowSource': 'Source',
    'settingsDialog.measured': 'Measured',
    'settingsDialog.estimated': 'Estimated',
    'settingsDialog.clear': 'Clear',
    'settingsDialog.save': 'Save',
    'settingsDialog.saveFailed': 'Could not save valve settings.',
    'settingsDialog.overrideTitle': 'Manual override',
    'settingsDialog.overrideHint': 'Use only if a valve is stuck open.',
    'settingsDialog.closeValve': 'Close valve now',
    'settingsDialog.closeConfirm': 'Yes, close it',
    'settingsDialog.closeSent': 'Close command sent.',
    'settingsDialog.closeFailed': 'Could not send the close command.',
    cancel: 'Cancel',
    close: 'Close',
  };
  return {
    translateForTest: (key: string, options?: Record<string, unknown>): string => {
      const template = table[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translateForTest, i18n: { language: 'en' } }),
}));

vi.mock('../../../../services/api', () => ({
  valvesAPI: {
    updateSettings: vi.fn().mockResolvedValue(undefined),
  },
  devicesAPI: {
    controlValve: vi.fn().mockResolvedValue(undefined),
  },
}));

function makeValve(overrides: Partial<ValveSummary> = {}): ValveSummary {
  return {
    deviceEui: '0016C001F1000001',
    name: 'North Valve',
    zoneId: 1,
    zoneName: 'North Block',
    zoneUuid: 'uuid-1',
    timezone: 'Europe/Zurich',
    currentState: 'CLOSED',
    targetState: null,
    stregaGeneration: 'GEN1',
    flowRateLpm: null,
    flowRateSource: null,
    defaultOpenMinutes: null,
    schedulerStatus: 'ACTIVE',
    skipTodayDate: null,
    lastUplinkAt: null,
    activeActuation: null,
    recentStaleState: null,
    nextRun: null,
    scheduleCount: 0,
    pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
    lastClockSyncAckedAt: null,
    enclosureTemperatureC: null,
    enclosureHumidityPct: null,
    enclosureMeasuredAt: null,
    ...overrides,
  };
}

describe('ValveSettingsDialog', () => {
  beforeEach(() => {
    vi.mocked(valvesAPI.updateSettings).mockClear();
    vi.mocked(devicesAPI.controlValve).mockClear();
  });

  async function savedPatch() {
    await waitFor(() => expect(valvesAPI.updateSettings).toHaveBeenCalledTimes(1));
    return vi.mocked(valvesAPI.updateSettings).mock.calls[0][1];
  }

  it('disables save and shows a rate-specific hint for an invalid flow rate, not the field label', () => {
    render(<ValveSettingsDialog valve={makeValve()} open onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Flow rate (L/min)'), { target: { value: '0' } });

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // Regression: the hint used to just repeat the field label ("Flow rate (L/min)").
    expect(screen.getByText('Enter a rate above 0 L/min.')).toBeInTheDocument();
    expect(screen.queryAllByText('Flow rate (L/min)')).toHaveLength(1);
  });

  it('allows an empty flow rate (clears it) without showing the hint', () => {
    render(<ValveSettingsDialog valve={makeValve({ flowRateLpm: 5 })} open onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Flow rate (L/min)'), { target: { value: '' } });

    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
    expect(screen.queryByText('Enter a rate above 0 L/min.')).not.toBeInTheDocument();
  });

  it('labels a save failure via the settingsDialog.saveFailed i18n key, not a hardcoded literal', async () => {
    vi.mocked(valvesAPI.updateSettings).mockRejectedValueOnce(new Error('network down'));
    render(<ValveSettingsDialog valve={makeValve()} open onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Could not save valve settings.')).toBeInTheDocument();
  });

  it('gives every interactive control a >=44px effective touch target', () => {
    render(<ValveSettingsDialog valve={makeValve({ flowRateLpm: 5 })} open onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByLabelText('Valve generation')).toHaveClass('min-h-[44px]');
    expect(screen.getByLabelText('Flow rate (L/min)')).toHaveClass('min-h-[44px]');
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveClass('min-h-[44px]');
    expect(screen.getByLabelText('Measured').closest('label')).toHaveClass('min-h-[44px]');
    expect(screen.getByLabelText('Estimated').closest('label')).toHaveClass('min-h-[44px]');
    // Cancel was removed by product decision: an X in the header is the single dismiss
    // affordance for settings dialogs. h-11/w-11 is exactly 44x44px.
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveClass('h-11');
    expect(close).toHaveClass('w-11');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('min-h-[44px]');
  });

  it('does not send CLOSE on a single tap -- the override is two-step', async () => {
    render(<ValveSettingsDialog valve={makeValve()} open onClose={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close valve now' }));

    // First tap only arms the confirm. A bare CLOSE actuates hardware, so it must not be one tap.
    expect(devicesAPI.controlValve).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Yes, close it' })).toBeInTheDocument();
  });

  it('sends a bare CLOSE once confirmed', async () => {
    const onChanged = vi.fn();
    render(<ValveSettingsDialog valve={makeValve()} open onClose={vi.fn()} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close valve now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, close it' }));

    await waitFor(() => expect(devicesAPI.controlValve).toHaveBeenCalled());
    // Deliberately a bare CLOSE (0x30 on FPort 1), not OPEN_FOR_DURATION: the valve is already
    // running its own timer and only an explicit close will shut it before that timer expires.
    expect(devicesAPI.controlValve).toHaveBeenCalledWith('0016C001F1000001', { action: 'CLOSE' });
    await waitFor(() => expect(screen.getByText('Close command sent.')).toBeInTheDocument());
    expect(onChanged).toHaveBeenCalled();
  });

  it('surfaces a failed close instead of claiming the valve shut', async () => {
    vi.mocked(devicesAPI.controlValve).mockRejectedValueOnce(new Error('offline'));
    render(<ValveSettingsDialog valve={makeValve()} open onClose={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close valve now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, close it' }));

    expect(await screen.findByText('Could not send the close command.')).toBeInTheDocument();
    expect(screen.queryByText('Close command sent.')).not.toBeInTheDocument();
  });

  const ZONE_LINE = 'Using the zone calibration: 12 L/min. Enter a rate to override it for this valve.';

  it('names the valve in the dialog title', () => {
    render(<ValveSettingsDialog valve={makeValve()} open onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Settings for North Valve' })).toBeInTheDocument();
  });

  it('starts a zone-sourced valve with an empty per-valve field and shows the zone rate', () => {
    render(
      <ValveSettingsDialog valve={makeValve({ flowRateLpm: 12, flowRateSource: 'zone' })} open onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    const input = screen.getByLabelText('Flow rate (L/min)');
    expect(input).toHaveValue(null);
    expect(screen.getByText(ZONE_LINE)).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription(ZONE_LINE);
    expect(screen.queryByLabelText('Estimated')).toBeNull();
  });

  it('does not turn a zone rate into a per-valve override when only the generation changes', async () => {
    render(
      <ValveSettingsDialog valve={makeValve({ flowRateLpm: 12, flowRateSource: 'zone' })} open onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Valve generation'), { target: { value: 'GEN2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const patch = await savedPatch();
    expect(patch).toHaveProperty('stregaGeneration', 'GEN2');
    expect(patch).not.toHaveProperty('flowRateLpm');
    expect(patch).not.toHaveProperty('flowRateSource');
  });

  it('does not re-send an unchanged per-valve rate', async () => {
    render(
      <ValveSettingsDialog valve={makeValve({ flowRateLpm: 5, flowRateSource: 'measured' })} open onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const patch = await savedPatch();
    expect(patch).toHaveProperty('stregaGeneration', 'GEN1');
    expect(patch).not.toHaveProperty('flowRateLpm');
    expect(patch).not.toHaveProperty('flowRateSource');
  });

  it('clearing a per-valve rate sends null so the valve falls back to the zone', async () => {
    render(
      <ValveSettingsDialog valve={makeValve({ flowRateLpm: 5, flowRateSource: 'estimated' })} open onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const patch = await savedPatch();
    expect(patch).toHaveProperty('flowRateLpm', null);
    expect(patch).not.toHaveProperty('flowRateSource');
  });

  it('changing only the source re-sends the rate with the new source', async () => {
    render(
      <ValveSettingsDialog valve={makeValve({ flowRateLpm: 5, flowRateSource: 'estimated' })} open onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByLabelText('Measured'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const patch = await savedPatch();
    expect(patch).toHaveProperty('flowRateLpm', 5);
    expect(patch).toHaveProperty('flowRateSource', 'measured');
  });

  it('typing a rate on a zone-sourced valve saves a per-valve override and hides the zone line', async () => {
    render(
      <ValveSettingsDialog valve={makeValve({ flowRateLpm: 12, flowRateSource: 'zone' })} open onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Flow rate (L/min)'), { target: { value: '8' } });
    expect(screen.queryByText(ZONE_LINE)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const patch = await savedPatch();
    expect(patch).toHaveProperty('flowRateLpm', 8);
    expect(patch).toHaveProperty('flowRateSource', 'estimated');
  });
});
