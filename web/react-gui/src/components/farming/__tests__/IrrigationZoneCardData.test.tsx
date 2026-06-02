import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { IrrigationZoneCard } from '../IrrigationZoneCard';
import type { IrrigationZone } from '../../../types/farming';

vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: {
    getZoneRecommendations: vi.fn().mockResolvedValue([]),
  },
  environmentAPI: {
    getSummary: vi.fn().mockResolvedValue(null),
  },
  irrigationZonesAPI: {
    delete: vi.fn().mockResolvedValue(undefined),
    removeDevice: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      if (typeof options === 'string') return options;
      if (key === 'zone.deviceCount') return '2 devices';
      if (key === 'zone.assignDevice') return 'Assign Device';
      if (key === 'zone.deleteZone') return 'Delete Zone';
      return key;
    },
  }),
}));

const zone = {
  id: 12,
  name: 'Zone B',
  device_count: 2,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  schedule: null,
} as IrrigationZone;

describe('IrrigationZoneCard Data entry', () => {
  it('renders a Data link to the zone fullscreen history view', () => {
    render(
      <MemoryRouter>
        <IrrigationZoneCard
          zone={zone}
          devices={[]}
          unassignedDevices={[]}
          onUpdate={vi.fn()}
        />
      </MemoryRouter>,
    );

    const dataLink = screen.getByRole('link', { name: /data/i });
    expect(dataLink).toHaveAttribute('href', '/history/zones/12');
  });
});
