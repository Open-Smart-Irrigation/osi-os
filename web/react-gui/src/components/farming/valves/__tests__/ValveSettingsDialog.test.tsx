import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ValveSettingsDialog } from '../ValveSettingsDialog';
import { valvesAPI } from '../../../../services/api';
import type { ValveSummary } from '../../../../types/farming';

const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    'settingsDialog.title': 'Valve settings',
    'settingsDialog.generation': 'Valve generation',
    'settingsDialog.gen1': 'Gen-1',
    'settingsDialog.gen2': 'Gen-2',
    'settingsDialog.flowRate': 'Flow rate (L/min)',
    'settingsDialog.flowRateHint': 'Enter a rate above 0 L/min.',
    'settingsDialog.flowSource': 'Source',
    'settingsDialog.measured': 'Measured',
    'settingsDialog.estimated': 'Estimated',
    'settingsDialog.clear': 'Clear',
    'settingsDialog.save': 'Save',
    'settingsDialog.saveFailed': 'Could not save valve settings.',
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
});
