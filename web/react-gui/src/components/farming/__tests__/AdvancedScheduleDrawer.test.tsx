import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AdvancedScheduleDrawer } from '../AdvancedScheduleDrawer';
import { irrigationZonesAPI } from '../../../services/api';
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
  it('loads a legacy stage as its FAO-56 stage, labels it by crop family, and saves a cleared stage as default', async () => {
    render(<AdvancedScheduleDrawer isOpen zone={{ ...zone, cropType: 'grapevine', phenologicalStage: 'veraison' }} onClose={vi.fn()} />);
    const stage = screen.getByDisplayValue('Mid-season (fruit growth, ripening)') as HTMLSelectElement;
    expect(stage.value).toBe('mid_season');
    expect([...stage.options].map((o) => o.value)).toEqual(['', 'initial', 'development', 'mid_season', 'late_season', 'dormancy']);
    fireEvent.change(stage, { target: { value: '' } });
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'default' }));
  });
  it('gives the stage select an accessible name and the stage HelpTip', () => {
    render(<AdvancedScheduleDrawer isOpen zone={{ ...zone, cropType: 'maize', phenologicalStage: 'late_season' }} onClose={vi.fn()} />);
    const stage = screen.getByRole('combobox', { name: 'Phenological stage' }) as HTMLSelectElement;
    expect(stage.value).toBe('late_season');
    fireEvent.click(screen.getByRole('button', { name: 'About growth stages' }));
    expect(screen.getByText(/FAO-56 growth stages set the crop coefficient Kc/)).toBeInTheDocument();
  });
});
