import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ValveOpenDialog } from '../ValveOpenDialog';
import type { ValveSummary } from '../../../../types/farming';

const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    'openDialog.title': 'Open {{name}}',
    'openDialog.duration': 'Duration (min)',
    'openDialog.durationHint': 'Enter 1–255 minutes.',
    'openDialog.custom': 'Custom',
    'openDialog.summary': 'closes ≈ {{time}}',
    'openDialog.liters': '≈ {{liters}} L',
    'openDialog.confirm': 'Open for {{minutes}} min',
    'openDialog.error': 'Could not send the open command.',
    cancel: 'Cancel',
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

describe('ValveOpenDialog', () => {
  it('initialises the duration input to the default 5 minutes when the valve has no saved default', () => {
    render(<ValveOpenDialog valve={makeValve()} open onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByLabelText('Duration (min)')).toHaveValue(5);
  });

  it('sets the duration when a quick chip is clicked', () => {
    render(<ValveOpenDialog valve={makeValve()} open onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole('button', { name: '30' }));
    expect(screen.getByLabelText('Duration (min)')).toHaveValue(30);
  });

  it('hides the litres estimate when the valve has no known flow rate', () => {
    render(<ValveOpenDialog valve={makeValve({ flowRateLpm: null })} open onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.queryByText(/≈ .* L/)).not.toBeInTheDocument();
  });

  it('shows the litres estimate for a known flow rate', () => {
    render(<ValveOpenDialog valve={makeValve({ flowRateLpm: 12.5 })} open onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole('button', { name: '30' }));
    expect(screen.getByText('≈ 380 L')).toBeInTheDocument();
  });

  it('submits the chosen minutes and closes on success', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ValveOpenDialog valve={makeValve({ defaultOpenMinutes: 5 })} open onClose={onClose} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: '30' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open for 30 min' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(30));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('disables the confirm button for an out-of-range duration and shows the range hint', () => {
    render(<ValveOpenDialog valve={makeValve()} open onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.change(screen.getByLabelText('Duration (min)'), { target: { value: '300' } });
    expect(screen.getByRole('button', { name: /Open for/ })).toBeDisabled();
    // Regression: the hint used to just repeat the field label ("Duration (min)").
    expect(screen.getByText('Enter 1–255 minutes.')).toBeInTheDocument();
  });

  it('gives every interactive control a >=44px effective touch target', () => {
    render(<ValveOpenDialog valve={makeValve()} open onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByRole('button', { name: '30' })).toHaveClass('min-h-[44px]');
    expect(screen.getByLabelText('Duration (min)')).toHaveClass('min-h-[44px]');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('min-h-[44px]');
    expect(screen.getByRole('button', { name: /Open for/ })).toHaveClass('min-h-[44px]');
  });
});
