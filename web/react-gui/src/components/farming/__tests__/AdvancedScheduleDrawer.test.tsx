import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AdvancedScheduleDrawer } from '../AdvancedScheduleDrawer';
import { irrigationZonesAPI } from '../../../services/api';
import type { IrrigationZone } from '../../../types/farming';
import simulatorI18n from '../../../../demo/i18n';

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
  it('shows the last simulated trigger decision and its illustrative DENDRO rule', () => {
    const schedule = {
      irrigation_zone_id: 42,
      trigger_metric: 'DENDRO',
      threshold_kpa: 3,
      enabled: true,
      duration_minutes: 20,
      response_mode: 'proportional',
      last_evaluation: {advisory: 'Selected local recommendation at 2026-10-10T03:00:00.000Z (0.0 hours old): increase_10. Stress significant; zone confidence 0.7; low-confidence trees 1; rain 15 mm; rain suppression inactive; recovery verification inactive. Shipped analytics advisory: maintain_rain_suppression — New rain: 15mm. Illustrative simulator rule: significant DENDRO stress met sensitivity 3; proportional response gives 24 minutes.'},
    } as IrrigationZone['schedule'];
    render(<AdvancedScheduleDrawer isOpen zone={{ ...zone, schedule }} onClose={vi.fn()} />);

    const advisory = screen.getByRole('status');
    expect(advisory).toHaveTextContent(/Selected local recommendation.*increase_10/);
    expect(advisory).toHaveTextContent(/zone confidence 0.7; low-confidence trees 1; rain 15 mm/);
    expect(advisory).toHaveTextContent(/Shipped analytics advisory: maintain_rain_suppression/);
    expect(advisory).toHaveTextContent(/Illustrative simulator rule: significant DENDRO stress met sensitivity 3/);
  });

  it('localizes public DENDRO labels and keeps source wording quoted as evidence', async () => {
    await simulatorI18n.changeLanguage('en');
    document.documentElement.dataset.publicSimulator = 'true';
    const schedule = {
      irrigation_zone_id: 42,
      trigger_metric: 'DENDRO',
      threshold_kpa: 3,
      enabled: true,
      duration_minutes: 20,
      response_mode: 'proportional',
      last_evaluation: {
        status: 'skipped', reason: 'below_dendro_sensitivity',
        advisory: 'legacy English simulator string that must not be presented publicly',
        dendroEvidence: {
          source: 'local', computedAt: '2026-10-10T03:00:00.000Z', ageMs: 3_600_000,
          action: 'maintain_rain_suppression', actionReason: 'New rain: 15mm.', stress: 'mild',
          rainfallMm: 15, waterDeliveredLiters: null, rainSuppressionActive: false,
          recoveryVerificationActive: null, lowConfidenceTreeCount: 1, zoneConfidenceScore: 0.7,
        },
      },
    } as IrrigationZone['schedule'];

    render(<AdvancedScheduleDrawer isOpen zone={{ ...zone, schedule }} onClose={vi.fn()} />);
    const advisory = screen.getByRole('status');
    expect(advisory).toHaveTextContent('dendrometer stress (DENDRO) simulator decision: irrigation skipped. Stress is below the saved sensitivity.');
    expect(advisory).toHaveTextContent('Observed value unknown; saved threshold unknown; simulated duration unknown.');
    expect(advisory).toHaveTextContent('rain 15 mm');
    expect(advisory).toHaveTextContent('water delivered unknown');
    expect(advisory).toHaveTextContent('Source recommendation (original wording): “maintain_rain_suppression — New rain: 15mm.”');
    expect(advisory).not.toHaveTextContent('legacy English simulator string');
    delete document.documentElement.dataset.publicSimulator;
  });

  it('localizes an SWT evaluation and its missing-valve reason in French', async () => {
    await act(async () => { await simulatorI18n.changeLanguage('fr'); });
    document.documentElement.dataset.publicSimulator = 'true';
    const schedule = {
      irrigation_zone_id: 42,
      trigger_metric: 'SWT_1',
      threshold_kpa: 40,
      enabled: true,
      last_evaluation: {status: 'skipped', reason: 'missing_valve', value: 46.5, threshold: 40, durationMinutes: null,
        advisory: 'legacy English simulator string that must not be presented publicly'},
    } as IrrigationZone['schedule'];
    render(<AdvancedScheduleDrawer isOpen zone={{ ...zone, schedule }} onClose={vi.fn()} />);

    const advisory = screen.getByRole('status');
    expect(advisory).toHaveTextContent('SWT_1');
    expect(advisory).toHaveTextContent('La condition simulée a été remplie, mais aucune vanne n’est affectée à cette zone.');
    expect(advisory).toHaveTextContent('46.5 kPa');
    expect(advisory).not.toHaveTextContent('legacy English simulator string');
    delete document.documentElement.dataset.publicSimulator;
    await act(async () => { await simulatorI18n.changeLanguage('en'); });
  });

  it('localizes a known DENDRO busy interlock reason in French and retains quoted evidence', async () => {
    await act(async () => { await simulatorI18n.changeLanguage('fr'); });
    document.documentElement.dataset.publicSimulator = 'true';
    const schedule = {
      irrigation_zone_id: 42,
      trigger_metric: 'DENDRO',
      threshold_kpa: 3,
      enabled: true,
      last_evaluation: {status: 'skipped', reason: 'busy', value: 'significant', threshold: 3, durationMinutes: null,
        dendroEvidence: {source: 'local', computedAt: '2026-10-10T03:00:00.000Z', ageMs: 0, action: 'increase_10',
          actionReason: 'Stress measured above the saved level.', stress: 'significant', rainfallMm: null}},
    } as IrrigationZone['schedule'];
    render(<AdvancedScheduleDrawer isOpen zone={{ ...zone, schedule }} onClose={vi.fn()} />);

    const advisory = screen.getByRole('status');
    expect(advisory).toHaveTextContent('La vanne a déjà une commande en cours.');
    expect(advisory).toHaveTextContent('increase_10 — Stress measured above the saved level.');
    delete document.documentElement.dataset.publicSimulator;
    await act(async () => { await simulatorI18n.changeLanguage('en'); });
  });
});
