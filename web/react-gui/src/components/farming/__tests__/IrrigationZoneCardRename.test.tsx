import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrrigationZoneCard } from '../IrrigationZoneCard';
import type { IrrigationZone } from '../../../types/farming';
import { irrigationZonesAPI } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: { getZoneRecommendations: vi.fn().mockResolvedValue([]) },
  environmentAPI: { getSummary: vi.fn().mockResolvedValue(null) },
  irrigationZonesAPI: {
    delete: vi.fn().mockResolvedValue(undefined),
    removeDevice: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue({
      id: 12, zone_uuid: 'u', name: 'Zone C', sync_version: 4, changed: true,
    }),
  },
  devicesAPI: { remove: vi.fn(), rename: vi.fn() },
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

vi.mock('../ScheduleSection', () => ({
  ScheduleSection: () => <div />,
  normalizeTriggerMetric: (value: string) => value,
}));
vi.mock('../environment/EnvironmentCard', () => ({ EnvironmentCard: () => <div /> }));
vi.mock('../dendrometer/DendrometerSection', () => ({ DendrometerSection: () => <div /> }));
vi.mock('../../../utils/isDesktopBrowser', () => ({ isDesktopBrowser: vi.fn(() => false) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const zone = {
  id: 12,
  name: 'Zone B',
  device_count: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  schedule: null,
} as IrrigationZone;

function renderZone(canWrite: boolean, onUpdate = vi.fn()) {
  render(
    <MemoryRouter>
      <IrrigationZoneCard
        zone={zone}
        devices={[]}
        unassignedDevices={[]}
        onUpdate={onUpdate}
        canWrite={canWrite}
      />
    </MemoryRouter>,
  );
  return { onUpdate };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('IrrigationZoneCard rename', () => {
  it('renames through the zone route and refreshes the dashboard', async () => {
    const { onUpdate } = renderZone(true);
    fireEvent.click(screen.getByRole('button', { name: 'rename.zone' }));
    const input = screen.getByLabelText('rename.zoneInputLabel');
    fireEvent.change(input, { target: { value: 'Zone C' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(irrigationZonesAPI.rename).toHaveBeenCalledWith(12, 'Zone C'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it('hides the pencil from a role that cannot mutate', () => {
    renderZone(false);
    expect(screen.getByRole('heading', { name: 'Zone B' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'rename.zone' })).not.toBeInTheDocument();
  });

  it('keeps the collapse toggle reachable beside the heading', () => {
    renderZone(true);
    const toggle = screen.getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { expanded: true })).toBe(toggle);
  });

  it('names the collapse toggle by its own zone, so two cards are not ambiguous', () => {
    // T13-M2: the heading moved out of this button, so its own visible content (the
    // chevron plus the device-count text) no longer distinguishes one zone card's
    // toggle from another's. Two cards with different names prove the fix: querying
    // by the second zone's name must resolve to exactly its own toggle.
    const zoneA = { ...zone, id: 12, name: 'Zone B', device_count: 0 };
    const zoneB = { ...zone, id: 13, name: 'Zone C', device_count: 2 };
    render(
      <MemoryRouter>
        <IrrigationZoneCard zone={zoneA} devices={[]} unassignedDevices={[]} onUpdate={vi.fn()} canWrite />
        <IrrigationZoneCard zone={zoneB} devices={[]} unassignedDevices={[]} onUpdate={vi.fn()} canWrite />
      </MemoryRouter>,
    );

    const toggleB = screen.getByRole('button', { name: /Zone C/ });
    expect(toggleB).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggleB);
    expect(toggleB).toHaveAttribute('aria-expanded', 'true');
    // The other card's toggle is untouched.
    expect(screen.getByRole('button', { name: /Zone B/ })).toHaveAttribute('aria-expanded', 'false');
  });
});
