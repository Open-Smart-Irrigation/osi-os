import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AdvancedScheduleDrawer } from '../AdvancedScheduleDrawer';
import type { IrrigationZone } from '../../../types/farming';

vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: {
    getZoneRecommendations: vi.fn().mockResolvedValue([]),
  },
  irrigationZonesAPI: {
    updateConfig: vi.fn().mockResolvedValue({}),
    updateSchedule: vi.fn().mockResolvedValue({}),
  },
}));

const zone = {
  id: 42,
  name: 'North Block',
  device_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  schedule: null,
  timezone: 'Europe/Zurich',
} satisfies IrrigationZone;

describe('AdvancedScheduleDrawer', () => {
  it('keeps advanced analysis timezone controls compact', () => {
    render(
      <AdvancedScheduleDrawer
        isOpen
        zone={zone}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Advanced Analysis' }));

    expect(screen.getByText('Timezone')).toBeInTheDocument();
    expect(screen.queryByText('IANA timezone (e.g. Europe/Rome). Used to align nightly min/max extraction windows.')).not.toBeInTheDocument();
  });
});
