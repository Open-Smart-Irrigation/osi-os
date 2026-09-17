import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScheduleSection } from '../ScheduleSection';

/**
 * The trigger form is the only screen where a farmer sets the number that
 * opens a valve. `SwtForm` and `DendroForm` are separate function components
 * that never called `useTranslation`, so every label, option and helper line
 * inside them rendered in English on a French or German screen — and each
 * `<select>` was labelled by a sibling element a screen reader never reads.
 */

const apiMocks = vi.hoisted(() => ({ getAll: vi.fn() }));

vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: { getAll: apiMocks.getAll, updateSchedule: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: unknown) => {
      if (typeof options === 'string') return options;
      const values = (options ?? {}) as Record<string, unknown>;
      const template = typeof values.defaultValue === 'string' ? values.defaultValue : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ''));
    },
  }),
}));

async function openSection(schedule: Record<string, unknown> | null) {
  apiMocks.getAll.mockResolvedValue([{ id: 4, name: 'Zone A', schedule }]);
  render(<ScheduleSection zoneId={4} zoneName="Zone A" onAdvancedOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /Trigger-based irrigation|schedule.irrigationSchedule/ }));
  await waitFor(() => expect(apiMocks.getAll).toHaveBeenCalled());
}

beforeEach(() => {
  apiMocks.getAll.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('trigger form localization and labelling', () => {
  it('labels every soil-tension control and routes its copy through t()', async () => {
    await openSection({ trigger_metric: 'SWT_1', threshold_kpa: 30, duration_minutes: 20, enabled: true });

    expect(await screen.findByLabelText('Sensor')).toHaveValue('SWT_1');
    expect(screen.getByLabelText('Threshold (kPa)')).toHaveValue(30);
    expect(screen.getByLabelText('Duration (min)')).toHaveValue(20);
    expect(screen.getByText('Irrigate when Sensor 1 exceeds 30 kPa')).toBeInTheDocument();
    expect(screen.getByText('Trigger method')).toBeInTheDocument();
  });

  it('labels every dendrometer control and routes its copy through t()', async () => {
    await openSection({ trigger_metric: 'DENDRO', threshold_kpa: 2, duration_minutes: 20, enabled: true });

    expect(await screen.findByLabelText('Trigger sensitivity')).toBeInTheDocument();
    expect(screen.getByLabelText('Base duration (min)')).toHaveValue(20);
    expect(screen.getByLabelText('Response mode')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Fixed — always irrigate for base duration' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Medium sensitivity — irrigate at moderate stress (recommended)' })).toBeInTheDocument();
  });
});
